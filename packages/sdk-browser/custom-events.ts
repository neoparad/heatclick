/**
 * UGOKI LINK v2 — Customer-Defined Custom Events & Segment Browser Compat Client (Bundle 3-B)
 *
 * Implements §11.11 (Lane Separation Preamble, #2 Segment Compat, #3 Customer-Defined Events):
 * - Strict lane separation: EVERY envelope emitted here carries `lane: 'custom_event'` and
 *   NEVER mixes into `lane: 'standard'` frames, standard PV billing, or cross-tenant pooling!
 * - Limits per §11.11 #3: max 500 event types per site, max 32 KiB per event, max 100 properties.
 * - Schema registry validation (strict tracking plan vs explicit loose mode excluded from
 *   sealed rollups & ML training).
 * - Automatic PII shape guard (emails, phones, credit cards, SSN/MyNumber-like patterns) blocked
 *   unless explicitly declared & consented.
 * - Freeform string properties tagged `untrusted: true` & `ml_feature_eligible: false`; ONLY
 *   `number | boolean | enum` properties are `ml_feature_eligible: true`.
 * - Thin Segment-compatible browser shim (`track`, `page`, `screen`, `identify`, `group`, `alias`):
 *   honors `off` (drop all), `cookieless` (never persists `anonymousId`), and `stats_exempt`
 *   (forbids cross-visit linking via `identify`/`group`/`alias`).
 */

import {
  canonicalJsonStringify,
  sha256Hex,
  utf8ToBytes,
  type ConsentMode,
  type ConsentPurpose,
} from '../contract/schema';
import type { MeasurementLane } from './types';

export const CUSTOM_EVENT_MAX_TYPES_PER_SITE = 500 as const;
export const CUSTOM_EVENT_MAX_BYTES = 32 * 1024; // 32 KiB
export const CUSTOM_EVENT_MAX_PROPERTIES = 100 as const;

export type CustomPropertyType = 'number' | 'boolean' | 'enum' | 'string';

export interface CustomPropertySchema {
  readonly name: string;
  readonly type: CustomPropertyType;
  readonly required?: boolean;
  readonly enumValues?: readonly string[];
  /** Explicit customer declaration that this property may carry PII under consent. */
  readonly allowsPii?: boolean;
}

export interface CustomEventDefinition {
  readonly event_name: string;
  readonly def_ver: number;
  readonly properties: readonly CustomPropertySchema[];
}

export interface SiteCustomEventRegistry {
  readonly site_id: string;
  readonly looseModeAllowed: boolean;
  readonly definitions: readonly CustomEventDefinition[];
}

export interface ValidatedCustomProperty {
  readonly name: string;
  readonly type: CustomPropertyType;
  readonly value: number | boolean | string;
  readonly ml_feature_eligible: boolean;
  readonly untrusted: boolean;
}

export interface CustomEventEnvelope {
  readonly lane: Extract<MeasurementLane, 'custom_event'>;
  readonly event_id: string;
  readonly site_id: string;
  readonly event_name: string;
  readonly def_ver: number;
  readonly occurred_at: string;
  readonly consent_mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly source: 'browser_custom_event' | 'browser_segment_compat';
  readonly segment_type?: 'track' | 'page' | 'screen' | 'identify' | 'group' | 'alias';
  readonly sealed_rollup_eligible: boolean;
  readonly ml_training_eligible: boolean;
  readonly eligible_for_cross_tenant_pool: false;
  readonly eligible_for_standard_pv_billing: false;
  readonly section_join_status: 'not_applicable';
  readonly properties: readonly ValidatedCustomProperty[];
  readonly dropped_pii_properties: readonly string[];
  readonly page_url_key?: string | null;
  readonly anonymous_id?: string | null;
  readonly user_id_hash?: string | null;
}

export interface CustomEventValidationResult {
  readonly accepted: boolean;
  readonly quarantined: boolean;
  readonly reason: string | null;
  readonly envelope: CustomEventEnvelope | null;
  readonly errors: readonly string[];
}

const PII_EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PII_PHONE_RE = /(?:\+?\d{1,3}[-\s]?)?(?:\(?\d{2,4}\)?[-\s]?)\d{3,4}[-\s]?\d{4}/;
const PII_CARD_RE = /\b(?:\d[ -]*?){13,19}\b/;

export function containsPiiShape(value: string): boolean {
  return PII_EMAIL_RE.test(value) || PII_CARD_RE.test(value) || PII_PHONE_RE.test(value);
}

/**
 * Validates and packages a customer-defined custom event with strict lane separation
 * (`lane: 'custom_event'`), schema checks, 32 KiB / 100-property / 500-type caps, and PII blocking.
 */
export function buildValidatedCustomEvent(params: {
  readonly registry: SiteCustomEventRegistry;
  readonly eventName: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consentMode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly occurredAtIso: string;
  readonly eventId?: string;
  readonly source?: 'browser_custom_event' | 'browser_segment_compat';
  readonly segmentType?: 'track' | 'page' | 'screen' | 'identify' | 'group' | 'alias';
  readonly pageUrlKey?: string | null;
  readonly anonymousId?: string | null;
  readonly userIdHash?: string | null;
}): CustomEventValidationResult {
  // 1. Consent `off` forbids all outbound events
  if (params.consentMode === 'off') {
    return {
      accepted: false,
      quarantined: false,
      reason: 'consent_off',
      envelope: null,
      errors: ['Consent mode "off" blocks custom events'],
    };
  }

  // 2. Registry capacity cap <= 500 types per site (§11.11 #3)
  if (params.registry.definitions.length > CUSTOM_EVENT_MAX_TYPES_PER_SITE) {
    return {
      accepted: false,
      quarantined: true,
      reason: 'registry_type_cap_exceeded',
      envelope: null,
      errors: [
        `Site registry has ${params.registry.definitions.length} types, exceeding cap ${CUSTOM_EVENT_MAX_TYPES_PER_SITE}`,
      ],
    };
  }

  // 3. Property count cap <= 100 & raw byte size cap <= 32 KiB (§11.11 #3)
  const rawPropKeys = Object.keys(params.properties);
  if (rawPropKeys.length > CUSTOM_EVENT_MAX_PROPERTIES) {
    return {
      accepted: false,
      quarantined: true,
      reason: 'property_count_exceeded',
      envelope: null,
      errors: [
        `Event "${params.eventName}" has ${rawPropKeys.length} properties, exceeding cap ${CUSTOM_EVENT_MAX_PROPERTIES}`,
      ],
    };
  }
  const approxBytes = utf8ToBytes(canonicalJsonStringify(params.properties)).length;
  if (approxBytes > CUSTOM_EVENT_MAX_BYTES) {
    return {
      accepted: false,
      quarantined: true,
      reason: 'event_size_exceeded',
      envelope: null,
      errors: [`Event "${params.eventName}" payload ${approxBytes}B exceeds 32 KiB cap`],
    };
  }

  const def = params.registry.definitions.find((d) => d.event_name === params.eventName);
  const errors: string[] = [];
  const droppedPii: string[] = [];
  const validatedProps: ValidatedCustomProperty[] = [];

  if (!def) {
    if (!params.registry.looseModeAllowed) {
      return {
        accepted: false,
        quarantined: true,
        reason: 'unregistered_event_name',
        envelope: null,
        errors: [`Event "${params.eventName}" is not registered in site tracking plan`],
      };
    }

    // Loose mode: strip PII-shaped values, exclude from sealed rollups & ML training (§11.11 #3)
    for (const key of rawPropKeys.sort()) {
      const val = params.properties[key];
      if (typeof val === 'number' && Number.isFinite(val)) {
        validatedProps.push({
          name: key,
          type: 'number',
          value: val,
          ml_feature_eligible: false,
          untrusted: false,
        });
      } else if (typeof val === 'boolean') {
        validatedProps.push({
          name: key,
          type: 'boolean',
          value: val,
          ml_feature_eligible: false,
          untrusted: false,
        });
      } else if (typeof val === 'string') {
        if (containsPiiShape(val)) {
          droppedPii.push(key);
          continue;
        }
        validatedProps.push({
          name: key,
          type: 'string',
          value: val,
          ml_feature_eligible: false,
          untrusted: true,
        });
      }
    }

    const eventId =
      params.eventId ??
      sha256Hex(`${params.registry.site_id}:${params.eventName}:${params.occurredAtIso}:${canonicalJsonStringify(validatedProps)}`).slice(
        0,
        32
      );

    return {
      accepted: true,
      quarantined: false,
      reason: 'loose_unregistered_event',
      envelope: {
        lane: 'custom_event',
        event_id: eventId,
        site_id: params.registry.site_id,
        event_name: params.eventName,
        def_ver: 0,
        occurred_at: params.occurredAtIso,
        consent_mode: params.consentMode,
        purposes: params.purposes,
        source: params.source ?? 'browser_custom_event',
        ...(params.segmentType ? { segment_type: params.segmentType } : {}),
        sealed_rollup_eligible: false,
        ml_training_eligible: false,
        eligible_for_cross_tenant_pool: false,
        eligible_for_standard_pv_billing: false,
        section_join_status: 'not_applicable',
        properties: validatedProps,
        dropped_pii_properties: droppedPii,
        page_url_key: params.pageUrlKey ?? null,
        anonymous_id: params.consentMode === 'cookieless' ? null : (params.anonymousId ?? null),
        user_id_hash: params.purposes.includes('member_link') ? (params.userIdHash ?? null) : null,
      },
      errors: [],
    };
  }

  // Strict schema validation against registered CustomEventDefinition
  const propSpecMap = new Map(def.properties.map((p) => [p.name, p]));
  for (const spec of def.properties) {
    if (spec.required && !(spec.name in params.properties)) {
      errors.push(`Missing required property "${spec.name}"`);
    }
  }

  for (const key of rawPropKeys.sort()) {
    const spec = propSpecMap.get(key);
    if (!spec) {
      errors.push(`Unregistered property "${key}" on event "${params.eventName}"`);
      continue;
    }
    const val = params.properties[key];
    if (spec.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        errors.push(`Property "${key}" expects finite number`);
        continue;
      }
      validatedProps.push({
        name: key,
        type: 'number',
        value: val,
        ml_feature_eligible: true,
        untrusted: false,
      });
    } else if (spec.type === 'boolean') {
      if (typeof val !== 'boolean') {
        errors.push(`Property "${key}" expects boolean`);
        continue;
      }
      validatedProps.push({
        name: key,
        type: 'boolean',
        value: val,
        ml_feature_eligible: true,
        untrusted: false,
      });
    } else if (spec.type === 'enum') {
      if (typeof val !== 'string' || !spec.enumValues?.includes(val)) {
        errors.push(`Property "${key}" value "${String(val)}" not in registered enum`);
        continue;
      }
      validatedProps.push({
        name: key,
        type: 'enum',
        value: val,
        ml_feature_eligible: true,
        untrusted: false,
      });
    } else {
      // string
      if (typeof val !== 'string') {
        errors.push(`Property "${key}" expects string`);
        continue;
      }
      if (!spec.allowsPii && containsPiiShape(val)) {
        droppedPii.push(key);
        errors.push(`Property "${key}" rejected: PII shape detected without allowsPii declaration`);
        continue;
      }
      // Freeform string: ALWAYS untrusted & NEVER ML feature eligible (§11.11 #3)
      validatedProps.push({
        name: key,
        type: 'string',
        value: val,
        ml_feature_eligible: false,
        untrusted: true,
      });
    }
  }

  if (errors.length > 0) {
    return {
      accepted: false,
      quarantined: true,
      reason: 'schema_validation_failed',
      envelope: null,
      errors,
    };
  }

  const eventId =
    params.eventId ??
    sha256Hex(`${params.registry.site_id}:${def.event_name}@${def.def_ver}:${params.occurredAtIso}:${canonicalJsonStringify(validatedProps)}`).slice(
      0,
      32
    );

  return {
    accepted: true,
    quarantined: false,
    reason: null,
    envelope: {
      lane: 'custom_event',
      event_id: eventId,
      site_id: params.registry.site_id,
      event_name: def.event_name,
      def_ver: def.def_ver,
      occurred_at: params.occurredAtIso,
      consent_mode: params.consentMode,
      purposes: params.purposes,
      source: params.source ?? 'browser_custom_event',
      ...(params.segmentType ? { segment_type: params.segmentType } : {}),
      sealed_rollup_eligible: true,
      ml_training_eligible: true,
      eligible_for_cross_tenant_pool: false,
      eligible_for_standard_pv_billing: false,
      section_join_status: 'not_applicable',
      properties: validatedProps,
      dropped_pii_properties: droppedPii,
      page_url_key: params.pageUrlKey ?? null,
      anonymous_id: params.consentMode === 'cookieless' ? null : (params.anonymousId ?? null),
      user_id_hash: params.purposes.includes('member_link') ? (params.userIdHash ?? null) : null,
    },
    errors: [],
  };
}

export interface BrowserSegmentCompatOptions {
  readonly getConsentMode: () => ConsentMode;
  readonly getPurposes: () => readonly ConsentPurpose[];
  readonly endpointBase: string;
  readonly dispatch: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  readonly nowIso?: () => string;
}

/**
 * Thin Segment-compatible browser shim (`analytics.track/page/screen/identify/group/alias`, §11.11 #2).
 * Enforces `lane: 'custom_event'`, never persists `anonymousId` in `cookieless`, and blocks
 * `identify`/`group`/`alias` when `member_link` purpose is absent or mode is `stats_exempt`.
 */
export function createBrowserSegmentCompatClient(options: BrowserSegmentCompatOptions) {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  const canLinkIdentity = (): boolean => {
    const mode = options.getConsentMode();
    if (mode === 'off' || mode === 'cookieless' || mode === 'stats_exempt') return false;
    return options.getPurposes().includes('member_link');
  };

  const emit = async (
    type: 'track' | 'page' | 'screen' | 'identify' | 'group' | 'alias',
    payload: Record<string, unknown>
  ): Promise<{ readonly sent: boolean; readonly reason?: string }> => {
    const mode = options.getConsentMode();
    const purposes = options.getPurposes();
    if (mode === 'off') {
      return { sent: false, reason: 'consent_off' };
    }
    if ((type === 'identify' || type === 'group' || type === 'alias') && !canLinkIdentity()) {
      return { sent: false, reason: 'identity_link_requires_member_link_purpose' };
    }

    const sanitizedPayload: Record<string, unknown> = {
      ...payload,
      type,
      lane: 'custom_event',
      consent_mode: mode,
      purposes,
      timestamp: nowIso(),
    };
    // In cookieless mode, never transmit a persistent anonymousId
    if (mode === 'cookieless') {
      delete sanitizedPayload.anonymousId;
    }

    const ok = await options.dispatch(`${options.endpointBase}/v1/compat/${type}`, sanitizedPayload);
    return { sent: ok, ...(ok ? {} : { reason: 'dispatch_failed' }) };
  };

  return {
    track: (event: string, properties: Record<string, unknown> = {}) =>
      emit('track', { event, properties }),
    page: (name?: string, properties: Record<string, unknown> = {}) =>
      emit('page', { name: name ?? '', properties }),
    screen: (name: string, properties: Record<string, unknown> = {}) =>
      emit('screen', { name, properties }),
    identify: (userId: string, traits: Record<string, unknown> = {}) =>
      emit('identify', { userId, traits }),
    group: (groupId: string, traits: Record<string, unknown> = {}) =>
      emit('group', { groupId, traits }),
    alias: (userId: string, previousId: string) =>
      emit('alias', { userId, previousId }),
  };
}
