/**
 * UGOKI LINK v2 — Single Actor-Blind Allocator Types (`lib/link/allocator`)
 *
 * Spec refs: §4.8, §9.1–§9.4, §9.8, §12.1 #5, D-3, D-17, D-20, EV M1–M4.
 */

import type {
  ConsentMode,
  ConsentPurpose,
  ConsentTier,
  IdentityQuality,
  TrafficClass,
  UnitKind,
} from '../../../packages/contract/schema';

export const HOLDOUT_BITS = ['global', 'overlay', 'patch', 'recs'] as const;
export type HoldoutBitName = (typeof HOLDOUT_BITS)[number];

export interface HoldoutBitsConfig {
  readonly global: number;
  readonly overlay: number;
  readonly patch: number;
  readonly recs: number;
  readonly epochWeeks: number; // default 26 (ev.holdout_epoch_weeks)
  readonly epochOriginMs: number;
}

export interface HoldoutBitsEvaluation {
  readonly global: boolean;
  readonly overlay: boolean;
  readonly patch: boolean;
  readonly recs: boolean;
  readonly epoch_id: number;
  readonly any_held_out: boolean;
  readonly bitmask: number; // bit0=global, bit1=overlay, bit2=patch, bit3=recs
}

export type LayerMechanism = 'overlay' | 'patch' | 'recs' | 'measurement' | 'canary';

/**
 * Structurally actor-blind allocation input (§9.1 / EV M1 / D-12):
 * User-Agent, IP, actor_class, is_agent, and automation flags are forbidden
 * at BOTH compile time (`never`) and runtime (`assertActorBlindInput`).
 */
export interface AllocationInput {
  readonly tenant_id: string;
  readonly site_id: string;
  readonly pv_id: string;
  readonly available_units: {
    readonly visitor?: string;
    readonly session?: string;
    readonly page_view: string;
    readonly impression?: string;
    readonly page?: string;
    readonly page_cluster?: string;
    readonly lab_run?: string;
  };
  readonly identity_quality: IdentityQuality;
  readonly consent_mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly traffic_class: TrafficClass;
  readonly url_id: string;
  readonly page_id: string;
  readonly viewport_class: 'mobile' | 'tablet' | 'desktop';
  readonly pointer_type: 'coarse' | 'fine' | 'none';
  readonly now_ms: number;
  readonly over_quota_sampling_rate?: number; // < 1 moves excess units to stub (D-3)

  // Structural compile-time poison guards: passing any actor signal is a TypeScript error!
  readonly user_agent?: never;
  readonly ua?: never;
  readonly ip?: never;
  readonly client_ip?: never;
  readonly actor_class?: never;
  readonly is_agent?: never;
  readonly is_bot?: never;
  readonly automation_flags?: never;
}

export interface ArmWeight {
  readonly arm_id: string;
  readonly weight: number; // positive weight; normalized across arms in experiment
  readonly is_control?: boolean;
}

export interface AllocatorExperiment {
  readonly experiment_id: string;
  readonly policy_version: string;
  readonly alloc_epoch: number;
  readonly prereg_hash: string;
  readonly preferred_unit_kind: UnitKind;
  /**
   * §9.1: Copy/price/offer experiments require `visitor` unit and must NOT show
   * inconsistent arms across pages; set `allow_unit_fallback: false` so cookieless
   * PVs see the default control experience instead.
   */
  readonly allow_unit_fallback: boolean;
  readonly requires_personalise_purpose?: boolean;
  readonly stateless_policy: 'randomise' | 'default_only';
  /** Slot share inside the parent layer [0, 1]. Sum across active experiments in a layer <= 1. */
  readonly slot_share: number;
  readonly arms: readonly ArmWeight[];
  /** Optional deterministic actor-blind eligibility predicate (viewport, page_id, etc.). */
  readonly isEligible?: (input: AllocationInput) => boolean;
}

export interface AllocatorLayer {
  readonly layer_id: string; // e.g. 'overlay:modal', 'patch:sec_cta', 'recs:article_end'
  readonly mechanism: Exclude<LayerMechanism, 'measurement' | 'canary'>;
  readonly region: string;
  readonly salt: string;
  readonly experiments: readonly AllocatorExperiment[];
}

export type MeasurementStage = 'stage_a_dual_run' | 'stage_b_weight_test' | 'stage_c_steady';

/**
 * §4.8 / §14 判断 2: How to allocate the `full` arm during Stage B SDK weight testing.
 * - `all_verify_only`: 100% of `full` arm runs shadow-only (fastest ~6 wk, no delivery)
 * - `half_verify_half_deliver` (Recommended): 50% `full_verify_only` + 50% `full_deliver_eligible`
 *   (~12 wk weight test, enables first experiment in parallel on 1/6 of PVs)
 */
export type FullArmSplitMode = 'all_verify_only' | 'half_verify_half_deliver';

export interface MeasurementLayerConfig {
  readonly stage: MeasurementStage;
  readonly fullSplitMode: FullArmSplitMode;
  /** Stage C steady-state stub share (default 0.05 at 1x, 0.005 at 1000x). */
  readonly steadyStubShare?: number;
  /** Stage C 2-second heartbeat audit arm share (default ~0.13 at 1x). */
  readonly steadyAuditShare?: number;
}

export interface AllocatorConfig {
  readonly hmacSecret: string;
  readonly holdout: HoldoutBitsConfig;
  readonly measurement: MeasurementLayerConfig;
  readonly layers: readonly AllocatorLayer[];
}

export interface AllocatorDecisionRecord {
  readonly decision_id: string;
  readonly layer_id: string;
  readonly experiment_id: string;
  readonly arm_id: string;
  readonly unit_id: string;
  readonly unit_kind: UnitKind;
  readonly identity_quality: IdentityQuality;
  readonly consent_tier: ConsentTier;
  readonly consent_mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly holdout_bits: number;
  readonly propensity: number;
  readonly policy_version: string;
  readonly alloc_epoch: number;
  readonly prereg_hash: string;
  readonly traffic_class: TrafficClass;
  readonly pv_id: string;
  readonly decision_no: number;
  readonly eligible: boolean;
  readonly suppressed_reason?: string;
  readonly stateless_policy: 'randomise' | 'default_only';
}

export type MeasurementArmAssignment =
  | 'v2'
  | 'v3'
  | 'both'
  | 'stub'
  | 'lite'
  | 'full_verify_only'
  | 'full_deliver_eligible'
  | 'audit'
  | 'over_quota_stub';

export interface AllocationOutcome {
  readonly consent_tier: ConsentTier;
  readonly over_quota_sampled_out: boolean;
  readonly holdout: HoldoutBitsEvaluation;
  readonly canary_arm: 'aa_control_a' | 'aa_control_b' | 'none';
  readonly measurement_arm: MeasurementArmAssignment | 'off';
  readonly delivery_permitted: boolean;
  readonly decisions: readonly AllocatorDecisionRecord[];
}
