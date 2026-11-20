/**
 * UGOKI LINK v2 — Segment Compatibility Ingest, Customer-Defined Events & Lane Separation (Bundle 3-B)
 *
 * Implements §11.11 (Lane Separation Preamble, #2 Segment HTTP Compat, #3 Customer-Defined Events):
 * - Supports all 6 Segment calls (`identify`, `page`, `screen`, `track`, `group`, `alias`) + `batch`.
 * - Enforces strict **lane separation (`lane: 'standard' | 'custom_event'`)** across BOTH
 *   persisted storage records AND API response outputs (`buildLaneSeparatedResponse`), throwing
 *   `CrossLaneAggregationError` if any caller attempts to silently mix standard & custom lanes!
 * - `userId` is re-hashed with tenant-specific HMAC key before storage; unapproved `traits`
 *   (e.g. raw email/phone) are DROPPED BEFORE queue/R2/log/quarantine (only count & reason saved).
 * - Consent enforcement: `off` rejected (`403`); `identify`/`group`/`alias` REQUIRE `member_link`
 *   purpose and are blocked in `cookieless` & `stats_exempt`; server-side calls must declare
 *   `consent_mode`, `purposes`, and `consent_generation`.
 * - Customer-defined events enforce max 500 types/site, max 32 KiB/event, max 100 properties,
 *   PII blocking, strict quarantine vs loose mode (`sealed_rollup_eligible: false`), and wrap
 *   freeform string properties in `UntrustedValue` (`customer_event_string`) on API response output.
 */

import { hmacSha256Hex } from '../../lib/link/allocator';
import {
  wrapUntrusted,
  type UntrustedValue,
} from '../../packages/contract/response';
import {
  CONSENT_MODES,
  canonicalJsonStringify,
  sha256Hex,
  type ConsentMode,
  type ConsentPurpose,
} from '../../packages/contract/schema';
import { computeUrlKeyV2 } from '../../packages/contract/urlkey';
import { buildValidatedCustomEvent } from '../../packages/sdk-browser';
import { evaluateLabPipelineExclusion, verifyLabMarker } from './lab-marker';
import type {
  CustomEventPersistedRecord,
  LabMarkerToken,
  MeasurementLane,
  QueueLike,
  R2BucketLike,
  SiteKeyRegistration,
} from './types';

export const SEGMENT_CALL_TYPES = [
  'identify',
  'page',
  'screen',
  'track',
  'group',
  'alias',
] as const;
export type SegmentCallType = (typeof SEGMENT_CALL_TYPES)[number];

export interface SegmentIncomingCall {
  readonly type: SegmentCallType;
  readonly messageId?: string;
  readonly event?: string;
  readonly name?: string;
  readonly userId?: string;
  readonly previousId?: string;
  readonly groupId?: string;
  readonly anonymousId?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly traits?: Readonly<Record<string, unknown>>;
  readonly context?: {
    readonly page?: { readonly url?: string };
  };
  readonly timestamp?: string;
  readonly consent_mode?: ConsentMode;
  readonly purposes?: readonly ConsentPurpose[];
  readonly consent_generation?: string;
  readonly is_server_side?: boolean;
  readonly lab_marker?: LabMarkerToken | null;
}

export interface SegmentIngestDeps {
  readonly sitesByPublishableKey: ReadonlyMap<string, SiteKeyRegistration>;
  readonly labMarkerSecret: string;
  readonly customEventQueue: QueueLike<CustomEventPersistedRecord>;
  readonly r2QuarantineBucket: R2BucketLike;
  readonly r2SpillBucket: R2BucketLike;
  readonly nowMs?: () => number;
}

export interface SegmentIngestResult {
  readonly status: number;
  readonly accepted: boolean;
  readonly lane: 'custom_event';
  readonly error?: string;
  readonly record?: CustomEventPersistedRecord;
  readonly quarantined?: boolean;
  readonly spilled_to_r2?: boolean;
}

const VALID_CONSENT_MODE_SET = new Set<string>(CONSENT_MODES);

function isIdentityLinkingCall(type: SegmentCallType): boolean {
  return type === 'identify' || type === 'group' || type === 'alias';
}

export class CrossLaneAggregationError extends Error {
  public readonly lanes: readonly MeasurementLane[];

  constructor(lanes: readonly MeasurementLane[]) {
    super(
      `§11.11 Lane Separation Violation: cannot silently combine metrics across different lanes (${lanes.join(', ')})`
    );
    this.name = 'CrossLaneAggregationError';
    this.lanes = lanes;
  }
}

/**
 * Projects a persisted `custom_event` record into a safe API response shape where
 * EVERY freeform string property is wrapped in `UntrustedValue` (`customer_event_string`)
 * and `lane: 'custom_event'` provenance is preserved explicitly (§11.11 + §11.5 I7).
 */
export function serializeCustomEventForResponse(record: CustomEventPersistedRecord): {
  readonly lane: 'custom_event';
  readonly provenance: {
    readonly lane: 'custom_event';
    readonly source_trust: 'customer_declared';
    readonly eligible_for_cross_tenant_pool: false;
    readonly eligible_for_standard_pv_billing: false;
    readonly section_join_status: 'not_applicable';
  };
  readonly record_id: string;
  readonly event_name: string;
  readonly occurred_at: string;
  readonly sealed_rollup_eligible: boolean;
  readonly properties: Readonly<Record<string, number | boolean | string | UntrustedValue>>;
} {
  const untrustedSet = new Set(record.untrusted_string_keys);
  const safeProps: Record<string, number | boolean | string | UntrustedValue> = {};
  for (const [k, v] of Object.entries(record.properties)) {
    if (typeof v === 'string' && untrustedSet.has(k)) {
      safeProps[k] = wrapUntrusted(v, 'customer_event_string');
    } else {
      safeProps[k] = v;
    }
  }

  return {
    lane: 'custom_event',
    provenance: {
      lane: 'custom_event',
      source_trust: record.source_trust,
      eligible_for_cross_tenant_pool: false,
      eligible_for_standard_pv_billing: false,
      section_join_status: 'not_applicable',
    },
    record_id: record.record_id,
    event_name: record.event_name,
    occurred_at: record.occurred_at,
    sealed_rollup_eligible: record.sealed_rollup_eligible,
    properties: safeProps,
  };
}

/**
 * Guards downstream aggregation & response builders against silently summing
 * `standard` telemetry rows with `custom_event` / `screen_replay` rows (§11.11 Preamble).
 */
export function assertSingleMeasurementLane(
  records: ReadonlyArray<{ readonly lane: MeasurementLane }>
): MeasurementLane | null {
  if (records.length === 0) return null;
  const distinct = Array.from(new Set(records.map((r) => r.lane)));
  if (distinct.length > 1) {
    throw new CrossLaneAggregationError(distinct);
  }
  return distinct[0];
}

export class SegmentCompatIngestEngine {
  private readonly deps: SegmentIngestDeps;
  private readonly nowMs: () => number;

  constructor(deps: SegmentIngestDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  public async handleSingleCall(
    publishableKey: string,
    call: SegmentIncomingCall
  ): Promise<SegmentIngestResult> {
    const now = this.nowMs();
    const site = this.deps.sitesByPublishableKey.get(publishableKey);
    if (!site) {
      return { status: 401, accepted: false, lane: 'custom_event', error: 'unknown_publishable_key' };
    }

    if (!(SEGMENT_CALL_TYPES as readonly string[]).includes(call.type)) {
      return { status: 400, accepted: false, lane: 'custom_event', error: 'unsupported_segment_type' };
    }

    // 1. Lab marker check (`render` blocks ingest completely, §12.2)
    const labCheck = verifyLabMarker(
      call.lab_marker,
      site.siteId,
      this.deps.labMarkerSecret,
      now
    );
    if (labCheck.valid && labCheck.marker?.purpose === 'render') {
      return { status: 403, accepted: false, lane: 'custom_event', error: 'lab_render_ingest_blocked' };
    }
    const labExclusion = evaluateLabPipelineExclusion({
      verifiedMarker: labCheck.valid ? labCheck.marker : null,
      frameLabRunId: null,
    });

    // 2. Consent enforcement (§11.11 Preamble & #2)
    const consentMode = call.consent_mode;
    if (!consentMode || !VALID_CONSENT_MODE_SET.has(consentMode)) {
      return {
        status: 400,
        accepted: false,
        lane: 'custom_event',
        error: 'missing_or_invalid_consent_mode',
      };
    }
    if (consentMode === 'off') {
      return { status: 403, accepted: false, lane: 'custom_event', error: 'consent_off' };
    }

    const purposes: readonly ConsentPurpose[] = call.purposes ?? [];
    if (call.is_server_side && !call.consent_generation) {
      return {
        status: 400,
        accepted: false,
        lane: 'custom_event',
        error: 'server_call_requires_consent_generation',
      };
    }

    // `identify`, `group`, `alias` require `member_link` AND are disallowed in `stats_exempt` & `cookieless`
    if (isIdentityLinkingCall(call.type)) {
      if (
        consentMode === 'cookieless' ||
        consentMode === 'stats_exempt' ||
        !purposes.includes('member_link')
      ) {
        return {
          status: 403,
          accepted: false,
          lane: 'custom_event',
          error: 'identity_link_requires_member_link_purpose',
        };
      }
    }

    // 3. Required field checks per Segment call type
    if (call.type === 'track' && (!call.event || typeof call.event !== 'string')) {
      return { status: 400, accepted: false, lane: 'custom_event', error: 'track_requires_event_name' };
    }
    if (call.type === 'identify' && !call.userId) {
      return { status: 400, accepted: false, lane: 'custom_event', error: 'identify_requires_userId' };
    }
    if (call.type === 'group' && !call.groupId) {
      return { status: 400, accepted: false, lane: 'custom_event', error: 'group_requires_groupId' };
    }
    if (call.type === 'alias' && (!call.userId || !call.previousId)) {
      return {
        status: 400,
        accepted: false,
        lane: 'custom_event',
        error: 'alias_requires_userId_and_previousId',
      };
    }

    // 4. Filter `traits` BEFORE queue/R2/log/quarantine (§11.11 #2):
    // Unapproved traits (e.g. raw email, phone, address) are DROPPED with ZERO raw values retained!
    const allowedTraitSet = new Set(site.allowedTraitKeys ?? []);
    const allowedTraits: Record<string, string | number | boolean> = {};
    let droppedTraitsCount = 0;
    if (call.traits && typeof call.traits === 'object') {
      for (const [k, v] of Object.entries(call.traits)) {
        if (!allowedTraitSet.has(k)) {
          droppedTraitsCount += 1;
          continue;
        }
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          allowedTraits[k] = v;
        } else {
          droppedTraitsCount += 1;
        }
      }
    }

    // 5. Tenant-keyed HMAC re-hash on `userId` (NEVER stored raw!)
    const userIdTenantHash =
      call.userId && purposes.includes('member_link')
        ? hmacSha256Hex(site.tenantMemberHashKey, call.userId)
        : null;

    // 6. Optional page URL normalization via single authoritative `urlkey/2`
    let pageUrlKey: string | null = null;
    if (call.context?.page?.url) {
      try {
        pageUrlKey = computeUrlKeyV2(call.context.page.url, site.urlRules).url_key_v2;
      } catch {
        pageUrlKey = null;
      }
    }

    // 7. Validate properties against site custom event tracking plan (§11.11 #3)
    const eventName =
      call.type === 'track'
        ? call.event!
        : call.type === 'page'
          ? `segment.page:${call.name ?? 'unnamed'}`
          : call.type === 'screen'
            ? `segment.screen:${call.name ?? 'unnamed'}`
            : `segment.${call.type}`;

    const occurredAt = call.timestamp ?? new Date(now).toISOString();
    const rawProps = call.properties ?? {};

    let validatedPropsObj: Record<string, number | boolean | string> = {};
    let untrustedStringKeys: string[] = [];
    let mlFeatureKeys: string[] = [];
    let sealedRollupEligible = true;
    let mlTrainingEligible = true;
    let defVer = 1;

    if (site.customEventRegistry && call.type === 'track') {
      const check = buildValidatedCustomEvent({
        registry: site.customEventRegistry,
        eventName,
        properties: rawProps,
        consentMode,
        purposes,
        occurredAtIso: occurredAt,
        eventId: call.messageId,
        source: 'browser_segment_compat',
        segmentType: call.type,
        pageUrlKey,
        anonymousId: consentMode === 'cookieless' ? null : (call.anonymousId ?? null),
        userIdHash: userIdTenantHash,
      });

      if (!check.accepted || !check.envelope) {
        // Quarantine metadata ONLY — never persist dropped raw traits!
        await this.deps.r2QuarantineBucket.put(
          `quarantine-custom/${site.tenantId}/${site.siteId}/${now}_${sha256Hex(eventName).slice(0, 12)}.json`,
          JSON.stringify({
            lane: 'custom_event',
            event_name: eventName,
            reason: check.reason,
            errors: check.errors,
            dropped_traits_count: droppedTraitsCount,
          })
        );
        return {
          status: 422,
          accepted: false,
          quarantined: true,
          lane: 'custom_event',
          error: check.reason ?? 'custom_event_validation_failed',
        };
      }

      defVer = check.envelope.def_ver;
      sealedRollupEligible = check.envelope.sealed_rollup_eligible;
      mlTrainingEligible = check.envelope.ml_training_eligible;
      for (const prop of check.envelope.properties) {
        validatedPropsObj[prop.name] = prop.value;
        if (prop.untrusted) untrustedStringKeys.push(prop.name);
        if (prop.ml_feature_eligible) mlFeatureKeys.push(prop.name);
      }
    } else {
      // Standard Segment page/screen/identify/group/alias properties
      for (const [k, v] of Object.entries(rawProps)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          validatedPropsObj[k] = v;
          mlFeatureKeys.push(k);
        } else if (typeof v === 'boolean') {
          validatedPropsObj[k] = v;
          mlFeatureKeys.push(k);
        } else if (typeof v === 'string') {
          validatedPropsObj[k] = v;
          untrustedStringKeys.push(k);
        }
      }
    }

    const recordId =
      call.messageId ??
      sha256Hex(
        `${site.tenantId}:${site.siteId}:custom:${call.type}:${eventName}:${occurredAt}:${canonicalJsonStringify(validatedPropsObj)}`
      ).slice(0, 32);

    const persisted: CustomEventPersistedRecord = {
      record_id: recordId,
      lane: 'custom_event',
      tenant_id: site.tenantId,
      site_id: site.siteId,
      source_trust: 'customer_declared',
      segment_type: call.type,
      event_name: eventName,
      def_ver: defVer,
      occurred_at: occurredAt,
      received_at_ms: now,
      consent_mode: consentMode,
      purposes,
      consent_generation: call.consent_generation ?? 'browser_live',
      retention_days: 90,
      user_id_tenant_hash: userIdTenantHash,
      anonymous_id: consentMode === 'cookieless' ? null : (call.anonymousId ?? null),
      page_url_key: pageUrlKey,
      section_join_status: 'not_applicable',
      sealed_rollup_eligible: sealedRollupEligible && !labExclusion.exclude_human_rollups,
      ml_training_eligible: mlTrainingEligible && !labExclusion.exclude_ml_training,
      eligible_for_cross_tenant_pool: false,
      eligible_for_standard_pv_billing: false,
      lab_exclusion: labExclusion,
      properties: validatedPropsObj,
      untrusted_string_keys: untrustedStringKeys,
      ml_feature_keys: mlFeatureKeys,
      allowed_traits: allowedTraits,
      dropped_traits_count: droppedTraitsCount,
      dropped_traits_reason: droppedTraitsCount > 0 ? 'trait_not_in_tenant_allowlist' : null,
    };

    // Ack-after-Enqueue with R2 spill fallback (503 only if both fail)
    let spilled = false;
    try {
      await this.deps.customEventQueue.send(persisted);
    } catch {
      try {
        await this.deps.r2SpillBucket.put(
          `spill-custom/${site.tenantId}/${site.siteId}/${now}_${recordId}.json`,
          canonicalJsonStringify(persisted)
        );
        spilled = true;
      } catch {
        return {
          status: 503,
          accepted: false,
          lane: 'custom_event',
          error: 'custom_event_queue_and_spill_unavailable',
        };
      }
    }

    return {
      status: 200,
      accepted: true,
      lane: 'custom_event',
      record: persisted,
      spilled_to_r2: spilled,
    };
  }

  public async handleBatch(
    publishableKey: string,
    batch: readonly SegmentIncomingCall[]
  ): Promise<{
    readonly status: number;
    readonly lane: 'custom_event';
    readonly accepted_count: number;
    readonly rejected_count: number;
    readonly results: readonly SegmentIngestResult[];
  }> {
    const results: SegmentIngestResult[] = [];
    let accepted = 0;
    let rejected = 0;
    for (const item of batch) {
      const res = await this.handleSingleCall(publishableKey, item);
      results.push(res);
      if (res.accepted) accepted += 1;
      else rejected += 1;
    }
    return {
      status: accepted > 0 || batch.length === 0 ? 200 : 400,
      lane: 'custom_event',
      accepted_count: accepted,
      rejected_count: rejected,
      results,
    };
  }
}
