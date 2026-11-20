/**
 * UGOKI LINK v2 — Collector Worker Minimal Types (`workers/link-collector/types.ts`)
 *
 * Uses local Web-standard minimal interfaces (`QueueLike`, `R2BucketLike`) — NEVER imports
 * `@cloudflare/workers-types` so root `npx tsc --noEmit` stays 100% clean.
 */

import type {
  ConsentMode,
  ConsentPurpose,
  SanitizedQuarantineRecord,
  TelemetryFrame,
  TrustLevel,
} from '../../packages/contract/schema';
import type { UrlKeyV2Rules } from '../../packages/contract/urlkey';
import type {
  LabMarkerPurpose,
  LabMarkerToken,
  MeasurementLane,
  SiteCustomEventRegistry,
} from '../../packages/sdk-browser';

export type { LabMarkerPurpose, LabMarkerToken, MeasurementLane };

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
  readonly edgeHandoffMacKey?: string;
  readonly originAttestKey?: string;
  readonly tenantMemberHashKey: string;
  readonly urlRules?: UrlKeyV2Rules;
  /** 28-day same-hour baseline PVs/window for surge circuit breaker (§11.8). */
  readonly baseline28dHourVolume: number;
  /** Surge multiplier threshold (default 3.0x baseline). */
  readonly surgeMultiplier?: number;
  /** Daily unverified network-prefix billable PV cap (§4.4 / §11.8). */
  readonly prefixDailyCap?: number;
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

export interface PersistedCollectorRecord {
  readonly record_id: string;
  readonly lane: MeasurementLane;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly received_at_ms: number;
  readonly pv_id: string;
  readonly seq: number;
  readonly url_id: string;
  readonly url_key_idempotent: boolean;
  readonly trust_level: TrustLevel;
  readonly billing_mode: BillingMode;
  readonly billable: boolean;
  readonly held: boolean;
  readonly spilled_to_r2: boolean;
  readonly state_incomplete: boolean;
  readonly partial_accepted: boolean;
  readonly rej: readonly string[];
  readonly network_prefix_hash: string;
  readonly lab_exclusion: LabPipelineExclusionFlags;
  readonly eligible_for_cross_tenant_pool: boolean;
  readonly eligible_for_standard_pv_billing: boolean;
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

export interface CollectorDeps {
  readonly sitesByPublishableKey: ReadonlyMap<string, SiteKeyRegistration>;
  readonly continuityTokenSecret: string;
  readonly labMarkerSecret: string;
  readonly mainQueue: QueueLike<PersistedCollectorRecord>;
  readonly r2SpillBucket: R2BucketLike;
  readonly r2HoldBucket: R2BucketLike;
  readonly r2QuarantineBucket: R2BucketLike;
  /** Optional committed-store lookup for 10-minute post-ack loss verification (§4.1 / TEL M1). */
  readonly isFrameCommittedInStore?: (pvId: string, seq: number) => boolean;
  /** Optional external callback for sanitized quarantine records. */
  readonly onQuarantine?: (record: SanitizedQuarantineRecord, tenantId: string, siteId: string) => void;
  readonly nowMs?: () => number;
}

export interface CustomEventPersistedRecord {
  readonly record_id: string;
  readonly lane: 'custom_event';
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
