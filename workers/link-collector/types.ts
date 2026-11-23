/**
 * UGOKI LINK v2 — Collector Worker Minimal Types (`workers/link-collector/types.ts`)
 *
 * Uses local Web-standard minimal interfaces (`QueueLike`, `R2BucketLike`) — NEVER imports
 * `@cloudflare/workers-types` so root `npx tsc --noEmit` stays 100% clean.
 */

import type {
  CanonicalWalQueueEnvelope,
  CollectionLane,
  ConsentMode,
  ConsentPurpose,
  DataRegion,
  SanitizedQuarantineRecord,
  StorageTier,
  TelemetryFrame,
  TrustLevel,
} from '../../packages/contract/schema';
import type { UrlKeyV2Rules } from '../../packages/contract/urlkey';
import type {
  LabMarkerPurpose,
  LabMarkerToken,
  MeasurementLane,
  MeasurementLaneInput,
  SiteCustomEventRegistry,
} from '../../packages/sdk-browser';

export type {
  CollectionLane,
  DataRegion,
  LabMarkerPurpose,
  LabMarkerToken,
  MeasurementLane,
  MeasurementLaneInput,
  StorageTier,
};

export interface QueueLike<T = unknown> {
  send(message: T): Promise<void>;
}

export interface R2PutOptionsLike {
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface R2BucketLike {
  put(key: string, value: string | Uint8Array, options?: R2PutOptionsLike): Promise<void>;
  get?(key: string): Promise<string | Uint8Array | null>;
}

export type BillingMode = 'normal' | 'over_quota_count_only';

export interface SiteKeyRegistration {
  readonly publishableKey: string; // ugk_pub_*
  readonly tenantId: string;
  readonly siteId: string;
  readonly storageRegion?: DataRegion;
  readonly storageTier?: StorageTier;
  readonly retentionDays?: number;
  readonly edgeHandoffMacKey?: string;
  readonly originAttestKey?: string;
  readonly tenantMemberHashKey: string;
  /** Previous rotated tenant member-hash keys retained for non-destructive subject erasure lookup (Codex R2 #9). */
  readonly rotatedMemberHashKeys?: readonly string[];
  readonly urlRules?: UrlKeyV2Rules;
  /** 28-day same-hour baseline PVs/window for surge circuit breaker (§11.8). */
  readonly baseline28dHourVolume: number;
  /** Surge multiplier threshold (default 3.0x baseline). */
  readonly surgeMultiplier?: number;
  /** Daily unverified network-prefix billable PV cap (§4.4 / §11.8). */
  readonly prefixDailyCap?: number;
  /** Conservative daily cap when CF-Connecting-IP is absent (`unknown_ip`). */
  readonly unknownIpDailyCap?: number;
  /** Higher daily prefix cap for origin_attested PVs (§11.8). */
  readonly originAttestedPrefixDailyCap?: number;
  /** Whether tenant has exceeded its plan billing quota (degrades to count-only, never 402!). */
  readonly overBillingQuota?: boolean;
  /** Allowed Segment trait keys persisted into encrypted attribute store (all others dropped pre-queue!). */
  readonly allowedTraitKeys?: readonly string[];
  /** Customer-defined custom event tracking plan (§11.11 #3). */
  readonly customEventRegistry?: SiteCustomEventRegistry;
}

export interface LabPipelineExclusionFlags {
  readonly is_lab_traffic: boolean;
  readonly lab_run_id: string | null;
  readonly lab_purpose: LabMarkerPurpose | null;
  readonly block_ingest: boolean;
  readonly exclude_human_rollups: boolean;
  readonly exclude_quorums: boolean;
  readonly exclude_experiments: boolean;
  readonly exclude_ml_training: boolean;
  readonly exclude_loss_ledger: boolean;
  readonly exclude_billing: boolean;
}

export interface PersistedCollectorRecord extends CanonicalWalQueueEnvelope {
  readonly record_id: string;
  readonly lane: CollectionLane;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly storage_region: DataRegion;
  readonly shard_id: number;
  readonly received_at_ms: number;
  readonly pv_id: string;
  readonly seq: number;
  readonly url_id: string;
  readonly url_key_idempotent: boolean;
  readonly trust_level: TrustLevel;
  readonly billing_mode: BillingMode;
  readonly billable: boolean;
  readonly held: boolean;
  readonly edge_acked: boolean;
  readonly spilled_to_r2: boolean;
  readonly state_incomplete: boolean;
  readonly partial_accepted: boolean;
  readonly rej: readonly string[];
  readonly network_prefix_hash: string;
  readonly retention_days: number;
  readonly storage_tier: StorageTier;
  readonly lab_exclusion: LabPipelineExclusionFlags;
  readonly eligible_for_cross_tenant_pool: boolean;
  readonly eligible_for_standard_pv_billing: boolean;
  readonly raw_frame: TelemetryFrame;
  readonly frame: TelemetryFrame;
}

export interface CollectorAckResponse {
  readonly ok: boolean;
  readonly accepted_saved: boolean;
  readonly held: boolean;
  readonly lane: 'standard';
  readonly seq: number;
  readonly i_hw: number;
  readonly srv_t: number;
  readonly pv_token: string | null;
  readonly need: readonly string[];
  readonly rej: readonly string[];
  readonly kill: number;
  readonly h: number;
  readonly billing_mode: BillingMode;
  readonly trust_level: TrustLevel;
  readonly spilled_to_r2: boolean;
  readonly url_key_idempotent: boolean;
  readonly lab_excluded: boolean;
}

export interface PostAckLossEntry {
  readonly pv_id: string;
  readonly echoed_seq: number;
  readonly acked_at_ms: number;
  readonly detected_at_ms: number;
  readonly elapsed_since_ack_ms: number;
}

export interface AckLedgerStoreLike {
  recordAck(pvId: string, seq: number, ackedAtMs: number): void | Promise<void>;
  getAckedAt(pvId: string, seq: number, nowMs: number): number | undefined | Promise<number | undefined>;
  incrementSiteHour(hourKey: string, nowMs: number): number | Promise<number>;
  getPrefixDayCount(prefixDayKey: string, nowMs: number): number | Promise<number>;
  incrementPrefixDayCount(prefixDayKey: string, nowMs: number): number | Promise<number>;
  recordPostAckLoss?(entry: PostAckLossEntry, nowMs: number): void | Promise<void>;
  getPostAckLosses?(): readonly PostAckLossEntry[];
}

export interface LiveTailFrameEvent {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly receivedAtMs: number;
  readonly lane: CollectionLane;
  readonly labExcluded: boolean;
  readonly frame: TelemetryFrame;
}

export interface LiveTailSinkLike {
  publishLiveFrame(event: LiveTailFrameEvent): Promise<void>;
}

export interface SubjectDeletionRequest {
  readonly receiptId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly subjectKind: 'visitor_id' | 'member_hash' | 'external_id' | 'ga_client_id' | 'optout_cookie';
  readonly subjectHmac: string | null;
  /**
   * Versioned canonical + legacy HMAC lookup candidates computed across current and
   * rotated tenant keys at intake time so downstream deletion needs ZERO plaintext (Codex R2 #9).
   */
  readonly subject_hmac_candidates: readonly string[];
  /** CamelCase alias of `subject_hmac_candidates` for ergonomic TypeScript consumption. */
  readonly subjectHmacCandidates: readonly string[];
  readonly requestedAtMs: number;
  readonly slaDays: 14;
}

export interface SubjectDeletionSinkLike {
  enqueueSubjectDeletion(
    req: SubjectDeletionRequest
  ): Promise<{ readonly receiptId?: string } | void>;
}

export interface CollectorDeps {
  readonly sitesByPublishableKey: ReadonlyMap<string, SiteKeyRegistration>;
  readonly continuityTokenSecret: string;
  readonly labMarkerSecret: string;
  readonly mainQueue: QueueLike<PersistedCollectorRecord>;
  readonly r2SpillBucket: R2BucketLike;
  readonly r2HoldBucket: R2BucketLike;
  readonly r2QuarantineBucket: R2BucketLike;
  /** Optional shared bounded ACK/rate ledger across multi-instance Workers ([M-02]). */
  readonly ackLedgerStore?: AckLedgerStoreLike;
  /** Optional non-blocking `link-live` Durable Object fanout sink ([C-05]). */
  readonly liveTailSink?: LiveTailSinkLike;
  /** Optional downstream 14-day subject erasure queue sink for `/v1/optout` ([H-11]). */
  readonly deletionSink?: SubjectDeletionSinkLike;
  /** Optional committed-store lookup for 10-minute post-ack loss verification (§4.1 / TEL M1). */
  readonly isFrameCommittedInStore?: (pvId: string, seq: number) => boolean;
  /** Optional external callback for sanitized quarantine records. */
  readonly onQuarantine?: (record: SanitizedQuarantineRecord, tenantId: string, siteId: string) => void;
  readonly nowMs?: () => number;
}

export type CollectorDependencies = CollectorDeps;

export interface CustomEventPersistedRecord {
  readonly record_id: string;
  readonly lane: Extract<CollectionLane, 'customer_defined'>;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly source_trust: 'customer_declared';
  readonly segment_type: 'track' | 'page' | 'screen' | 'identify' | 'group' | 'alias' | 'custom';
  readonly event_name: string;
  readonly def_ver: number;
  readonly occurred_at: string;
  readonly received_at_ms: number;
  readonly consent_mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly consent_generation: string;
  readonly retention_days: number;
  readonly user_id_tenant_hash: string | null;
  readonly anonymous_id: string | null;
  readonly page_url_key: string | null;
  readonly section_join_status: 'not_applicable';
  readonly sealed_rollup_eligible: boolean;
  readonly ml_training_eligible: boolean;
  readonly eligible_for_cross_tenant_pool: false;
  readonly eligible_for_standard_pv_billing: false;
  readonly lab_exclusion: LabPipelineExclusionFlags;
  readonly properties: Readonly<Record<string, number | boolean | string>>;
  readonly untrusted_string_keys: readonly string[];
  readonly ml_feature_keys: readonly string[];
  readonly allowed_traits: Readonly<Record<string, string | number | boolean>>;
  readonly dropped_traits_count: number;
  readonly dropped_traits_reason: string | null;
}
