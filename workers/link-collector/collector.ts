/**
 * UGOKI LINK v2 — Main Collector Engine (`workers/link-collector/collector.ts`)
 *
 * Implements §4.1, §4.4, §4.5, §6.4, §11.8, §12.1 #4, §12.2, TEL M1 / M4:
 * - Resolves `(tenant_id, site_id)` STRICTLY from `ugk_pub_*` publishable key (never body)
 * - Lab Marker gate: `render` blocks ingest; all 6 lab purposes excluded from human & billing pipelines
 * - Partial acceptance via `createIngestValidator(CANONICAL_SCHEMA)` (single bad field dropped/clamped,
 *   envelope error -> sanitized quarantine with `{type, length}` for string-in-int-slot)
 * - Collector URL-key idempotency check via `verifyUrlKeyIdempotency` (§6.4)
 * - Trust tier resolution (`edge_attested > origin_attested > continuity > none`) + `pv_token` issuance
 * - Surge circuit breaker (28-day same-hour baseline): verified (`edge_attested` / `origin_attested`)
 *   NEVER held; unverified overflow routed to replayable hold lane WITHOUT "saved" ACK (§11.8)
 * - Billing over-quota degradation: NEVER 402, NEVER drops/samples PVs; emits `over_quota_count_only`
 *   distinct from SDK weight-test stub arm (§11.8)
 * - Per-network-prefix daily cap preventing single-prefix billing inflation (§4.4 / §11.8)
 * - Strict Ack-after-Enqueue: awaits `queue.send` BEFORE returning 200 ACK; on Queue refusal spills
 *   to R2 first; returns 503 ONLY when both Queue and R2 fail (§4.1 / TEL M1)
 * - Post-ack loss detector tracking `ack_echo_seq` against committed store after 10 minutes (§4.1)
 */

import { hmacSha256Hex } from '../../lib/link/allocator';
import {
  CANONICAL_SCHEMA,
  canonicalJsonStringify,
  createIngestValidator,
  createSdkFrameCodec,
  sha256Hex,
  type TelemetryFrame,
  type TrustLevel,
} from '../../packages/contract/schema';
import { verifyUrlKeyIdempotency } from '../../packages/contract/urlkey';
import { evaluateLabPipelineExclusion, verifyLabMarker } from './lab-marker';
import type {
  BillingMode,
  CollectorAckResponse,
  CollectorDeps,
  LabMarkerToken,
  PersistedCollectorRecord,
  PostAckLossEntry,
  SiteKeyRegistration,
} from './types';

const POST_ACK_LOSS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (§4.1 / TEL M1)
const DEFAULT_SURGE_MULTIPLIER = 3.0;
const DEFAULT_UNVERIFIED_PREFIX_CAP = 500;
const DEFAULT_ORIGIN_ATTESTED_PREFIX_CAP = 5000;

export interface CollectFrameRequestInput {
  readonly publishableKey: string;
  /** Either raw `ugk-bin/1` bytes OR parsed JSON object. */
  readonly body: Uint8Array | Record<string, unknown>;
  readonly networkPrefix: string; // e.g. '/24' or '/48' prefix string (hashed with daily key)
  readonly handoffHeader?: string | null;
  readonly originAttestToken?: string | null;
  readonly labMarker?: LabMarkerToken | null;
  readonly pvStartServerMs?: number;
}

export interface CollectFrameResponse {
  readonly status: number;
  readonly ack: CollectorAckResponse | null;
  readonly error?: string;
  readonly persistedRecord?: PersistedCollectorRecord;
}

export class LinkCollectorEngine {
  private readonly deps: CollectorDeps;
  private readonly validator = createIngestValidator(CANONICAL_SCHEMA);
  private readonly codec = createSdkFrameCodec(CANONICAL_SCHEMA);
  private readonly nowMs: () => number;

  // In-memory sliding counters per Worker instance (site hourly window & prefix daily cap)
  private readonly siteHourCounts = new Map<string, number>();
  private readonly prefixDayBillableCounts = new Map<string, number>();
  // Track every acknowledged (pv_id, seq) -> ackedAtMs for post-ack loss verification (§4.1)
  private readonly ackedFrames = new Map<string, number>();
  public readonly postAckLosses: PostAckLossEntry[] = [];

  constructor(deps: CollectorDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  public issuePvContinuityToken(tenantId: string, siteId: string, pvId: string): string {
    const mac = hmacSha256Hex(
      this.deps.continuityTokenSecret,
      `pv_token/1|${tenantId}|${siteId}|${pvId}`
    ).slice(0, 32);
    return `pvt1.${mac}`;
  }

  public verifyPvContinuityToken(
    token: string | null | undefined,
    tenantId: string,
    siteId: string,
    pvId: string
  ): boolean {
    if (!token) return false;
    return token === this.issuePvContinuityToken(tenantId, siteId, pvId);
  }

  public verifyEdgeHandoffToken(
    handoffToken: string | null | undefined,
    site: SiteKeyRegistration
  ): boolean {
    if (!handoffToken || !site.edgeHandoffMacKey) return false;
    const parts = handoffToken.split('.');
    if (parts.length !== 2) return false;
    const [reqUid, macHex] = parts;
    if (!reqUid || !macHex) return false;
    const expected = hmacSha256Hex(site.edgeHandoffMacKey, reqUid).slice(0, macHex.length);
    return macHex === expected;
  }

  public verifyOriginAttestToken(
    token: string | null | undefined,
    site: SiteKeyRegistration,
    pvId: string
  ): boolean {
    if (!token || !site.originAttestKey) return false;
    const expected = hmacSha256Hex(site.originAttestKey, `origin_kit/1|${site.siteId}|${pvId}`).slice(
      0,
      32
    );
    return token === `ok1.${expected}`;
  }

  private resolveTrustLevel(
    site: SiteKeyRegistration,
    frame: TelemetryFrame,
    handoffHeader?: string | null,
    originAttestToken?: string | null
  ): TrustLevel {
    const handoffCandidate = handoffHeader ?? frame.handoff_token ?? null;
    if (this.verifyEdgeHandoffToken(handoffCandidate, site)) {
      return 'edge_attested';
    }
    if (this.verifyOriginAttestToken(originAttestToken, site, frame.pv_id)) {
      return 'origin_attested';
    }
    if (this.verifyPvContinuityToken(frame.pv_token, site.tenantId, site.siteId, frame.pv_id)) {
      return 'continuity';
    }
    return 'none';
  }

  private checkPostAckEcho(pvId: string, ackEchoSeq: number, now: number): void {
    if (ackEchoSeq <= 0 || !this.deps.isFrameCommittedInStore) return;
    const key = `${pvId}:${ackEchoSeq}`;
    const ackedAt = this.ackedFrames.get(key);
    if (ackedAt === undefined) return;
    const elapsed = now - ackedAt;
    if (elapsed >= POST_ACK_LOSS_WINDOW_MS) {
      const committed = this.deps.isFrameCommittedInStore(pvId, ackEchoSeq);
      if (!committed) {
        const alreadyLogged = this.postAckLosses.some(
          (e) => e.pv_id === pvId && e.echoed_seq === ackEchoSeq
        );
        if (!alreadyLogged) {
          this.postAckLosses.push({
            pv_id: pvId,
            echoed_seq: ackEchoSeq,
            acked_at_ms: ackedAt,
            detected_at_ms: now,
            elapsed_since_ack_ms: elapsed,
          });
        }
      }
    }
  }

  /**
   * Processes a standard telemetry frame (`POST /v1/collect/events`).
   */
  public async handleTelemetryFrame(req: CollectFrameRequestInput): Promise<CollectFrameResponse> {
    const now = this.nowMs();

    // 1. Resolve (tenant_id, site_id) STRICTLY from publishable key (§11.1)
    const site = this.deps.sitesByPublishableKey.get(req.publishableKey);
    if (!site) {
      return { status: 401, ack: null, error: 'unknown_publishable_key' };
    }

    // 2. Verify Lab Marker early: `render` blocks ingestion completely (§12.2)
    const labVerification = verifyLabMarker(
      req.labMarker,
      site.siteId,
      this.deps.labMarkerSecret,
      now
    );
    if (labVerification.valid && labVerification.marker?.purpose === 'render') {
      return { status: 403, ack: null, error: 'lab_render_ingest_blocked' };
    }

    // 3. Decode binary `ugk-bin/1` or accept JSON object
    let rawObj: unknown;
    if (req.body instanceof Uint8Array) {
      try {
        rawObj = this.codec.decodeFrame(req.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid_binary_frame';
        await this.deps.r2QuarantineBucket.put(
          `quarantine/${site.tenantId}/${site.siteId}/${now}_decode.json`,
          JSON.stringify({ reason: msg, byteLength: req.body.byteLength })
        );
        return { status: 400, ack: null, error: `decode_error:${msg}` };
      }
    } else {
      rawObj = req.body;
    }

    // 4. Contract ingest validation with Partial Acceptance (`packages/contract/schema`)
    const valRes = this.validator.validateIngestFrame(rawObj, {
      serverNowMs: now,
      pvStartServerMs: req.pvStartServerMs,
      walAllowanceMs: 5000,
    });

    if (!valRes.accepted || !valRes.sanitizedFrame) {
      if (valRes.quarantineRecord) {
        const qKey = `quarantine/${site.tenantId}/${site.siteId}/${now}_${valRes.quarantineRecord.payloadSha256.slice(0, 12)}.json`;
        await this.deps.r2QuarantineBucket.put(
          qKey,
          canonicalJsonStringify(valRes.quarantineRecord),
          { customMetadata: { reason: valRes.quarantineRecord.reason, retention_days: '7' } }
        );
        this.deps.onQuarantine?.(valRes.quarantineRecord, site.tenantId, site.siteId);
      }
      return {
        status: 400,
        ack: null,
        error: valRes.quarantineRecord?.reason ?? 'envelope_rejected',
      };
    }

    let frame: TelemetryFrame = valRes.sanitizedFrame;

    // 5. Evaluate Lab Marker exclusion flags (also fail-closed on frame.lab_run_id)
    const labExclusion = evaluateLabPipelineExclusion({
      verifiedMarker: labVerification.valid ? labVerification.marker : null,
      frameLabRunId: frame.lab_run_id,
    });

    // 6. Collector-side URL key idempotency check (§6.4 / D-6)
    const urlCheck = verifyUrlKeyIdempotency(frame.state.page_url_key, site.urlRules);
    const urlKeyIdempotent =
      urlCheck.idempotent && urlCheck.first.url_id === frame.url_id;
    const rejList: string[] = [...valRes.rej];
    if (!urlKeyIdempotent) {
      rejList.push('flag:url_key_idempotency_mismatch');
    }

    // 7. Re-hash member_hash with tenant-specific secret (§4.5: prevents cross-tenant collision)
    if (frame.member_hash && frame.purposes.includes('member_link')) {
      const tenantRehashed = hmacSha256Hex(site.tenantMemberHashKey, frame.member_hash);
      frame = {
        ...frame,
        member_hash: tenantRehashed,
      };
    }

    // 8. Check post-ack loss via echoed seq (§4.1 / TEL M1)
    this.checkPostAckEcho(frame.pv_id, frame.ack_echo_seq, now);

    // 9. Determine Trust Level & issue continuity token (§4.4)
    const trustLevel = this.resolveTrustLevel(
      site,
      frame,
      req.handoffHeader,
      req.originAttestToken
    );
    const issuedPvToken = this.issuePvContinuityToken(site.tenantId, site.siteId, frame.pv_id);

    // 10. Surge Circuit Breaker (§11.8): 28d same-hour baseline
    // Verified (`edge_attested` / `origin_attested`) traffic is NEVER held!
    const hourBucket = Math.floor(now / 3_600_000);
    const hourKey = `${site.siteId}:${hourBucket}`;
    const prevHourCount = this.siteHourCounts.get(hourKey) ?? 0;
    const nextHourCount = prevHourCount + 1;
    this.siteHourCounts.set(hourKey, nextHourCount);

    const surgeThreshold = Math.max(
      1,
      Math.floor(site.baseline28dHourVolume * (site.surgeMultiplier ?? DEFAULT_SURGE_MULTIPLIER))
    );
    const isVerifiedOriginOrEdge =
      trustLevel === 'edge_attested' || trustLevel === 'origin_attested';
    const isSurgeHold = !isVerifiedOriginOrEdge && nextHourCount > surgeThreshold;

    // 11. Daily scoped network-prefix hash & billing cap (§4.4 / §11.8)
    const dayBucket = Math.floor(now / 86_400_000);
    const prefixHash = hmacSha256Hex(
      `${this.deps.continuityTokenSecret}:prefix_cap:${dayBucket}`,
      `${site.siteId}:${req.networkPrefix}`
    ).slice(0, 24);
    const prefixDayKey = `${site.siteId}:${dayBucket}:${prefixHash}`;
    const prefixCount = this.prefixDayBillableCounts.get(prefixDayKey) ?? 0;

    // Billing mode: over quota NEVER returns 402 & NEVER drops PVs — shifts to `over_quota_count_only`!
    const billingMode: BillingMode = site.overBillingQuota ? 'over_quota_count_only' : 'normal';

    // Billable determination (§4.4 & §11.8):
    // - Never bill lab traffic, held frames, or trustLevel === 'none'
    // - Edge attested: uncapped billable; Origin attested: high prefix cap; Continuity: standard prefix cap
    let billable = false;
    if (!labExclusion.exclude_billing && !isSurgeHold && trustLevel !== 'none') {
      if (trustLevel === 'edge_attested') {
        billable = true;
      } else if (trustLevel === 'origin_attested') {
        const cap = site.originAttestedPrefixDailyCap ?? DEFAULT_ORIGIN_ATTESTED_PREFIX_CAP;
        if (prefixCount < cap) {
          billable = true;
          this.prefixDayBillableCounts.set(prefixDayKey, prefixCount + 1);
        }
      } else {
        // continuity
        const cap = site.prefixDailyCap ?? DEFAULT_UNVERIFIED_PREFIX_CAP;
        if (prefixCount < cap) {
          billable = true;
          this.prefixDayBillableCounts.set(prefixDayKey, prefixCount + 1);
        }
      }
    }

    const recordId = sha256Hex(`${site.tenantId}:${site.siteId}:${frame.pv_id}:${frame.seq}`).slice(
      0,
      32
    );

    const record: PersistedCollectorRecord = {
      record_id: recordId,
      lane: 'standard',
      tenant_id: site.tenantId,
      site_id: site.siteId,
      received_at_ms: now,
      pv_id: frame.pv_id,
      seq: frame.seq,
      url_id: urlCheck.first.url_id,
      url_key_idempotent: urlKeyIdempotent,
      trust_level: trustLevel,
      billing_mode: billingMode,
      billable,
      held: isSurgeHold,
      spilled_to_r2: false,
      state_incomplete: valRes.stateIncomplete,
      partial_accepted: valRes.partial,
      rej: rejList,
      network_prefix_hash: prefixHash,
      lab_exclusion: labExclusion,
      eligible_for_cross_tenant_pool: !labExclusion.is_lab_traffic,
      eligible_for_standard_pv_billing: billable,
      frame,
    };

    // 12. If surged & unverified -> route to replayable hold lane AND DO NOT return saved ACK (§11.8)!
    if (isSurgeHold) {
      const holdKey = `hold/${site.tenantId}/${site.siteId}/${hourBucket}/${recordId}.json`;
      await this.deps.r2HoldBucket.put(holdKey, canonicalJsonStringify(record), {
        customMetadata: { reason: 'surge_unverified_hold' },
      });
      return {
        status: 202,
        ack: {
          ok: true,
          accepted_saved: false, // §11.8: MUST NOT answer "saved" for held traffic!
          held: true,
          lane: 'standard',
          seq: frame.seq,
          i_hw: -1, // Do not acknowledge log items so SDK knows they are unconfirmed
          srv_t: now,
          pv_token: issuedPvToken,
          need: [],
          rej: [...rejList, 'hold:surge_circuit_breaker'],
          kill: 0,
          h: 15,
          billing_mode: billingMode,
          trust_level: trustLevel,
          spilled_to_r2: false,
          url_key_idempotent: urlKeyIdempotent,
          lab_excluded: labExclusion.is_lab_traffic,
        },
        persistedRecord: record,
      };
    }

    // 13. Ack-after-Enqueue -> R2 Spill fallback -> 503 only if BOTH fail (§4.1 / TEL M1)
    let spilledToR2 = false;
    try {
      await this.deps.mainQueue.send(record);
    } catch {
      // Queue refused/throttled: spill to R2 first!
      const spilledRecord: PersistedCollectorRecord = {
        ...record,
        spilled_to_r2: true,
      };
      try {
        const spillKey = `spill/${site.tenantId}/${site.siteId}/${now}_${recordId}.json`;
        await this.deps.r2SpillBucket.put(spillKey, canonicalJsonStringify(spilledRecord), {
          customMetadata: { reason: 'queue_refusal_spill' },
        });
        spilledToR2 = true;
      } catch {
        // ONLY when BOTH Queue and R2 fail -> 503 with NO ACK!
        return {
          status: 503,
          ack: null,
          error: 'queue_and_spill_unavailable',
        };
      }
    }

    // Record successful ACK timestamp for 10-minute post-ack loss verification
    this.ackedFrames.set(`${frame.pv_id}:${frame.seq}`, now);

    const finalRecord: PersistedCollectorRecord = spilledToR2
      ? { ...record, spilled_to_r2: true }
      : record;

    return {
      status: 200,
      ack: {
        ok: true,
        accepted_saved: true,
        held: false,
        lane: 'standard',
        seq: frame.seq,
        i_hw: valRes.ackHints.i_hw,
        srv_t: now,
        pv_token: issuedPvToken,
        need: [],
        rej: rejList,
        kill: 0,
        h: 10,
        billing_mode: billingMode,
        trust_level: trustLevel,
        spilled_to_r2: spilledToR2,
        url_key_idempotent: urlKeyIdempotent,
        lab_excluded: labExclusion.is_lab_traffic,
      },
      persistedRecord: finalRecord,
    };
  }
}
