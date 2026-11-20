/**
 * UGOKI LINK v2 — Unified Response Envelope Types (§1.3, §9.10, §11.5, D-14–D-16, SUR M5)
 */

import type { VerifiedMetricValue, VerifiedNumericLeaf } from './brand';

export const MEASURE_STATUSES = [
  'ok',
  'insufficient_data',
  'not_collected',
  'pending',
  'invalid',
  'not_applicable',
  'not_entitled',
  'suppressed',
] as const;

export type MeasureStatus = (typeof MEASURE_STATUSES)[number];

/** `partial` exists strictly at top-level request status when measures have mixed statuses (D-15). */
export type RequestStatus = MeasureStatus | 'partial';

export const EVIDENCE_LEVELS = [
  'planned',
  'inferred',
  'observed',
  'proven',
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const EVIDENCE_LEVEL_RANK: Readonly<Record<EvidenceLevel, 0 | 1 | 2 | 3>> = {
  planned: 0,
  inferred: 1,
  observed: 2,
  proven: 3,
};

export const EXACTNESS_VALUES = [
  'exact',
  'exact_as_of_build',
  'approx',
] as const;
export type Exactness = (typeof EXACTNESS_VALUES)[number];

export const PROVEN_PREDICATES = [
  'visitor_randomised',
  'page_randomised',
  'multi_site',
  'bandit_replay',
  'lab_randomised',
] as const;
export type ProvenPredicateId = (typeof PROVEN_PREDICATES)[number];

export interface ProvenPredicateResult {
  readonly predicate: ProvenPredicateId;
  readonly passed: boolean;
  readonly allocator_logged_before_outcomes: boolean;
  readonly prereg_locked: boolean;
  readonly integrity_status: 'pass' | 'unverified' | 'fail';
  readonly decision_rule_passed: boolean;
  readonly randomisation_audit_p: number;
  readonly alpha: number;
  readonly duration_days?: number;
  readonly platform_canary_passed?: boolean;
  readonly evaluated_at: string;
}

export type EvidenceRefKind =
  | 'query'
  | 'intervention'
  | 'model'
  | 'snapshot'
  | 'ledger'
  | 'preregistration';

export interface ActiveEvidenceRef {
  readonly ref_id: string;
  readonly kind: EvidenceRefKind;
  readonly params_hash: string;
  readonly watermarks: Readonly<Record<string, string>>;
  readonly result_digest: string;
  readonly issued_at: string;
  readonly valid_until: string;
  readonly kid: string;
  readonly tombstone?: undefined;
}

export interface TombstonedEvidenceRef {
  readonly ref_id: string;
  readonly kind: EvidenceRefKind;
  readonly tombstone: {
    readonly reason: 'expired' | 'erased';
    readonly tombstoned_at: string;
  };
}

export type EvidenceRef = ActiveEvidenceRef | TombstonedEvidenceRef;

export type EvidenceVerifyResult =
  | { readonly status: 'match' }
  | { readonly status: 'drift'; readonly reason: 'late_data' | 'merge' | 'ttl' | 'erasure' }
  | { readonly status: 'expired' };

export interface EvidenceBlock {
  readonly level: EvidenceLevel;
  readonly exactness: Exactness;
  readonly criteria: readonly ProvenPredicateResult[];
  readonly refs: readonly EvidenceRef[];
  readonly confidence?: number | null;
  readonly confidence_basis?: string | null;
  readonly validity?: 'valid' | 'expired';
  readonly valid_until?: string | null;
  readonly scope: string;
  readonly allocated?: boolean;
  readonly not_slot_metric?: boolean;
  readonly not_training_label?: boolean;
  readonly identity_assurance?: string;
  readonly as_of_state?: 'confirmed' | 'bracketed' | 'stale';
  readonly pooling_weight?: number;
}

export interface EtaRange {
  readonly min_days: number;
  readonly max_days: number;
}

export interface UnmetGate {
  readonly id: string;
  readonly required: number | string | null;
  readonly observed: number | string | null;
  readonly unlock: string;
  readonly reason?: string;
  readonly eta?: EtaRange | null;
}

export interface SampleBlock {
  readonly n: number;
  readonly unit_kind?: string;
  readonly effective_n?: number;
}

export interface IntervalBlock {
  readonly level: number;
  readonly lower: number;
  readonly upper: number;
  readonly method?: string;
}

export interface ProjectionCalibration {
  readonly gate_id: string;
  readonly gate_passed: boolean;
  readonly clopper_pearson_lower_95: number;
  readonly resolved_interventions: number;
  readonly sites: number;
  readonly scope: string;
}

export interface ProvenPointEstimateConditions {
  readonly skeptical_lower_bound: number;
  readonly planned_n_reached: boolean;
  readonly holdback_confirmed: boolean;
  readonly guardrails_verified: boolean;
}

export interface ProjectionInputBlock {
  readonly impact_band?: 'low' | 'mid' | 'high' | null;
  readonly presentation?: 'band_only' | 'interval';
  readonly predictive_interval?: {
    readonly level: number;
    readonly lower: number;
    readonly upper: number;
    readonly basis: string;
    readonly calibration: ProjectionCalibration;
  } | null;
  readonly point_estimate?: VerifiedMetricValue<number> | null;
  readonly point_estimate_conditions?: ProvenPointEstimateConditions | null;
}

export interface SerializedProjectionBlock {
  readonly impact_band?: 'low' | 'mid' | 'high' | null;
  readonly presentation?: 'band_only' | 'interval';
  readonly predictive_interval?: {
    readonly level: number;
    readonly lower: number;
    readonly upper: number;
    readonly basis: string;
    readonly calibration: ProjectionCalibration;
  } | null;
  readonly point_estimate?: number | null;
  readonly point_estimate_conditions?: ProvenPointEstimateConditions | null;
}

export interface FreshnessBlock {
  readonly data_through: string;
  readonly lag_s: number;
  readonly client_lag_s?: number;
  readonly pipeline_lag_s?: number;
  readonly sources: Readonly<Record<string, string>>;
  readonly stale: boolean;
}

export interface CoverageBlock {
  readonly ratio: number;
  readonly denominator_n: number;
  readonly sampling_rate?: number;
  readonly excluded_share?: number;
}

export interface WindowBlock {
  readonly start: string;
  readonly end: string;
  readonly timezone?: string;
}

export interface LineageBlock {
  readonly schema_version: string;
  readonly def_ver: number;
  readonly rollup_def_version?: string;
  readonly verdict_rev?: number;
  readonly collection_gen: 'v3' | 'legacy';
  readonly build_seq?: number;
}

/** §11.11 item 13: separate storage region and processing region in every response envelope. */
export interface ResidencyBlock {
  readonly storage_region: string;
  readonly processing_region: string;
}

export interface UsageBlock {
  readonly cost_units: number;
  readonly meter?: string;
  readonly remaining_quota?: number | null;
}

export interface MeasureModelRef {
  readonly id: string;
  readonly version: string;
  readonly trained_at: string;
  readonly status?: 'champion' | 'challenger' | 'rolled_back' | 'fallback';
}

// =========================================================================
// Domain Blocks (D-16 — one owner per block)
// =========================================================================

export interface QualityBlock {
  readonly source: 'edge_live' | 'store_live' | 'rt_minute' | 'sealed' | 'sealed+tail' | 'chunked_job' | 'legacy';
  readonly exactness: Exactness;
  readonly error_bound?: number | null;
  readonly seam?: string | null;
  readonly built_through?: string | null;
  readonly sealed_share?: number;
  readonly late_frames_pending?: number;
  readonly lag_s?: number;
  readonly late_after_freeze?: number;
  readonly misplaced_share?: number;
  readonly collection_gen: 'v3' | 'legacy';
  readonly rollup_def_version?: string;
  readonly grain?: 'built' | 'on_demand';
}

export interface MeasurementBlock {
  readonly terminal_unconfirmed?: readonly [number, number];
  readonly tail_bound_ms?: number;
  readonly post_ack_loss?: number;
  readonly state_incomplete?: number;
  readonly seq_gap?: number;
  readonly log_gap?: number;
  readonly quarantine?: number;
  readonly arm_mix?: Readonly<Record<string, number>>;
  readonly consent_mix?: Readonly<Record<string, number>>;
  readonly identity_quality_mix?: Readonly<Record<string, number>>;
  readonly trust_mix?: Readonly<Record<string, number>>;
}

export interface JoinQualityBlock {
  readonly key_ver: number;
  readonly profile_rev: number;
  readonly c_url?: number;
  readonly m_sec?: number;
  readonly geom_drift?: number;
  readonly n: number;
}

export interface ExperimentBlock {
  readonly verdict: 'superior' | 'non_inferior' | 'equivalent' | 'harmful' | 'inconclusive' | 'futile';
  readonly mde?: number;
  readonly monitoring_interval_s?: number;
  readonly srm_p_value?: number;
  readonly integrity?: 'pass' | 'fail' | 'unverified';
}

export interface CaptureBlock {
  readonly path: string;
  readonly coverage_factor: number;
  readonly lag_s: number;
}

export interface PolicyBlock {
  readonly version: string;
  readonly fallback_reason?: string | null;
}

export interface PreflightBlock {
  readonly status: 'pass' | 'fail' | 'inconclusive' | 'pending';
  readonly pages_tested: number;
  readonly scope_coverage: number;
  readonly viewport_profile: string;
  readonly limitations: readonly string[];
}

export interface MeasureInput<T extends VerifiedNumericLeaf = number> {
  readonly value: VerifiedMetricValue<T> | null;
  readonly unit: string;
  readonly status: MeasureStatus;
  readonly reason?: string;
  readonly is_lift_projection?: boolean;
  readonly evidence: EvidenceBlock;
  readonly sample: SampleBlock | null;
  readonly interval: IntervalBlock | null;
  readonly freshness?: FreshnessBlock;
  readonly coverage?: CoverageBlock;
  readonly projection?: ProjectionInputBlock;
  readonly model?: MeasureModelRef;
  readonly unmet_gates?: readonly UnmetGate[];
  readonly gates?: { readonly unmet: readonly UnmetGate[] };
}

export interface SerializedMeasureCell<T extends VerifiedNumericLeaf = VerifiedNumericLeaf> {
  readonly value: T | null;
  readonly unit: string;
  readonly status: MeasureStatus;
  readonly reason?: string;
  readonly evidence: EvidenceBlock;
  readonly sample: SampleBlock | null;
  readonly interval: IntervalBlock | null;
  readonly freshness: FreshnessBlock;
  readonly coverage: CoverageBlock;
  readonly projection?: SerializedProjectionBlock;
  readonly model?: MeasureModelRef;
  readonly unmet_gates: readonly UnmetGate[];
  readonly gates: { readonly unmet: readonly UnmetGate[] };
}

export interface ResponseEnvelopeInput {
  readonly window: WindowBlock;
  readonly freshness: FreshnessBlock;
  readonly coverage: CoverageBlock;
  readonly lineage: LineageBlock;
  readonly residency: ResidencyBlock;
  readonly usage?: UsageBlock;
  readonly warnings?: readonly string[];
  readonly next_cursor?: string | null;
  readonly default_empty_status?: MeasureStatus;
  readonly measures: Readonly<Record<string, MeasureInput<VerifiedNumericLeaf>>>;
  readonly data?: unknown;
  readonly quality?: QualityBlock;
  readonly measurement?: MeasurementBlock;
  readonly join_quality?: JoinQualityBlock;
  readonly experiment?: ExperimentBlock;
  readonly capture?: CaptureBlock;
  readonly policy?: PolicyBlock;
  readonly model?: MeasureModelRef;
  readonly preflight?: PreflightBlock;
}

export interface SerializedResponseEnvelope {
  readonly status: RequestStatus;
  readonly window: WindowBlock;
  readonly freshness: FreshnessBlock;
  readonly coverage: CoverageBlock;
  readonly lineage: LineageBlock;
  readonly residency: ResidencyBlock;
  readonly usage?: UsageBlock;
  readonly warnings: readonly string[];
  readonly next_cursor: string | null;
  readonly measures: Readonly<Record<string, SerializedMeasureCell>>;
  readonly data?: unknown;
  readonly quality?: QualityBlock;
  readonly measurement?: MeasurementBlock;
  readonly join_quality?: JoinQualityBlock;
  readonly experiment?: ExperimentBlock;
  readonly capture?: CaptureBlock;
  readonly policy?: PolicyBlock;
  readonly model?: MeasureModelRef;
  readonly preflight?: PreflightBlock;
}
