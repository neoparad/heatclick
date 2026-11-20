/**
 * UGOKI LINK v2 — ML Foundation: Label & Feature Contracts (`lib/link/ml/foundation/contracts.ts`)
 *
 * Implements §8.1, §8.2, ML M1 / M2:
 * - Re-exports and integrates the single versioned 3-tier vocabulary (`site_rule ⊂ label ⊂ metric`)
 *   from `lib/link/allocator/contracts`.
 * - Feature lifecycle state machine: `candidate -> recording -> eligible -> active -> retired`.
 * - "Log wide, serve narrow": records raw values of every feature in state >= `recording` at
 *   decision time so features defined later have full history from `ready_at`.
 * - Point-in-time leakage firewall: physically blocks any feature whose `known_at_ms` is strictly
 *   after `decision_time_ms` (`PointInTimeLeakageError`).
 * - Automatic feature admission (`14d coverage >= 0.95` + 2 consecutive time splits with
 *   multiple-testing adjusted improvement LCB > 0) and automatic retirement (3 consecutive cycles
 *   with zero/non-positive contribution).
 * - Visual feature family registration (above-the-fold layout, CTA computed styles, section
 *   screenshot hash, image embedding challenger).
 */

import {
  MAX_SITE_CONVERSION_RULES,
  CANONICAL_LABEL_KEYS,
  METRIC_LEVELS,
  computeMetricDefinitionHash,
  createLockedMetricDefinition,
  formatLabelRef,
  formatSiteRuleRef,
  validateMetricContractHierarchy,
  type CanonicalLabelKey,
  type LabelContract,
  type MetricContractValidationResult,
  type MetricDefinition,
  type MetricLevel,
  type SiteConversionRule,
} from '../../allocator/contracts';
import type { ConsentMode, PiiClass } from '../../../../packages/contract/schema';

export {
  MAX_SITE_CONVERSION_RULES,
  CANONICAL_LABEL_KEYS,
  METRIC_LEVELS,
  computeMetricDefinitionHash,
  createLockedMetricDefinition,
  formatLabelRef,
  formatSiteRuleRef,
  validateMetricContractHierarchy,
  type CanonicalLabelKey,
  type LabelContract,
  type MetricContractValidationResult,
  type MetricDefinition,
  type MetricLevel,
  type SiteConversionRule,
};

export const FEATURE_LIFECYCLE_STATES = [
  'candidate',
  'recording',
  'eligible',
  'active',
  'retired',
] as const;
export type FeatureLifecycleState = (typeof FEATURE_LIFECYCLE_STATES)[number];

export type FeatureKnownAtStage = 'context' | 'trigger' | 'batch';

export type FeatureFamily =
  | 'telemetry_behaviour'
  | 'telemetry_vitals'
  | 'crawl_structure'
  | 'crawl_audit'
  | 'visual_above_fold'
  | 'visual_cta_style'
  | 'visual_section_hash'
  | 'visual_image_embedding'
  | 'search_prior'
  | 'history_stratum';

export interface FeatureDefinition {
  readonly feature_id: string;
  readonly version: number;
  readonly family: FeatureFamily;
  readonly known_at: FeatureKnownAtStage;
  readonly encoding: 'int_bin' | 'fixed_point_i32' | 'enum_u16' | 'hash_u64' | 'int8_vector';
  readonly pii_class: PiiClass;
  readonly consent_min: ConsentMode;
  readonly state: FeatureLifecycleState;
  readonly is_challenger?: boolean;
  /** True only for features derived from standard measurement / CRAWL (never custom_event/replay). */
  readonly standard_lane_only: true;
}

export interface ObservedFeatureValue {
  readonly feature_id: string;
  readonly raw_value: number;
  readonly known_at_ms: number;
}

export interface DecisionFeatureSnapshot {
  readonly decision_id: string;
  readonly decision_time_ms: number;
  readonly feature_set_version: string;
  readonly batch_snapshot_id: string;
  readonly struct_fp: string;
  readonly logged_raw_features: Readonly<Record<string, number>>;
  readonly active_serving_features: Readonly<Record<string, number>>;
  readonly omitted_candidate_ids: readonly string[];
}

export class PointInTimeLeakageError extends Error {
  public readonly featureId: string;
  public readonly knownAtMs: number;
  public readonly decisionTimeMs: number;

  constructor(featureId: string, knownAtMs: number, decisionTimeMs: number) {
    super(
      `Point-in-time leakage blocked (§8.2): feature "${featureId}" became known at ${knownAtMs} > decision_time_ms ${decisionTimeMs}`
    );
    this.name = 'PointInTimeLeakageError';
    this.featureId = featureId;
    this.knownAtMs = knownAtMs;
    this.decisionTimeMs = decisionTimeMs;
  }
}

/**
 * Default visual feature family candidates (§8.2 "視覚の特徴").
 * All start as `candidate` / `recording` challengers and pass the same automatic admission gate.
 */
export const DEFAULT_VISUAL_FEATURE_FAMILY: readonly FeatureDefinition[] = [
  {
    feature_id: 'vis.above_fold_layout_v1',
    version: 1,
    family: 'visual_above_fold',
    known_at: 'batch',
    encoding: 'fixed_point_i32',
    pii_class: 'none',
    consent_min: 'cookieless',
    state: 'recording',
    standard_lane_only: true,
  },
  {
    feature_id: 'vis.cta_computed_style_v1',
    version: 1,
    family: 'visual_cta_style',
    known_at: 'batch',
    encoding: 'int_bin',
    pii_class: 'none',
    consent_min: 'cookieless',
    state: 'recording',
    standard_lane_only: true,
  },
  {
    feature_id: 'vis.section_screenshot_phash_v1',
    version: 1,
    family: 'visual_section_hash',
    known_at: 'batch',
    encoding: 'hash_u64',
    pii_class: 'none',
    consent_min: 'cookieless',
    state: 'recording',
    standard_lane_only: true,
  },
  {
    feature_id: 'vis.section_image_embedding_challenger_v1',
    version: 1,
    family: 'visual_image_embedding',
    known_at: 'batch',
    encoding: 'int8_vector',
    pii_class: 'none',
    consent_min: 'cookieless',
    state: 'candidate',
    is_challenger: true,
    standard_lane_only: true,
  },
] as const;

const STATE_RANK: Readonly<Record<FeatureLifecycleState, number>> = {
  candidate: 0,
  recording: 1,
  eligible: 2,
  active: 3,
  retired: -1,
};

/**
 * Builds a point-in-time verified "Log Wide, Serve Narrow" feature snapshot (§8.2):
 * - Physically rejects ANY observation with `known_at_ms > decision_time_ms` (zero post-outcome leakage!).
 * - Logs raw values of ALL features in state >= `recording` (even if not yet `active`).
 * - Exposes ONLY `active` features to live serving (`active_serving_features`).
 */
export function buildPointInTimeFeatureSnapshot(params: {
  readonly decisionId: string;
  readonly decisionTimeMs: number;
  readonly featureSetVersion: string;
  readonly batchSnapshotId: string;
  readonly structFp: string;
  readonly registry: readonly FeatureDefinition[];
  readonly observations: readonly ObservedFeatureValue[];
}): DecisionFeatureSnapshot {
  const defById = new Map(params.registry.map((f) => [f.feature_id, f]));
  const loggedRaw: Record<string, number> = {};
  const activeServing: Record<string, number> = {};
  const omittedCandidateIds: string[] = [];

  for (const obs of params.observations) {
    // Hard point-in-time guard: NEVER permit any feature known after the decision!
    if (obs.known_at_ms > params.decisionTimeMs) {
      throw new PointInTimeLeakageError(obs.feature_id, obs.known_at_ms, params.decisionTimeMs);
    }

    const def = defById.get(obs.feature_id);
    if (!def || def.state === 'retired') {
      continue;
    }

    if (STATE_RANK[def.state] < STATE_RANK.recording) {
      omittedCandidateIds.push(obs.feature_id);
      continue;
    }

    // Log wide: record raw value for every feature in `recording | eligible | active`
    loggedRaw[obs.feature_id] = obs.raw_value;

    // Serve narrow: expose ONLY `active` features to the online serving runtime
    if (def.state === 'active') {
      activeServing[obs.feature_id] = obs.raw_value;
    }
  }

  return {
    decision_id: params.decisionId,
    decision_time_ms: params.decisionTimeMs,
    feature_set_version: params.featureSetVersion,
    batch_snapshot_id: params.batchSnapshotId,
    struct_fp: params.structFp,
    logged_raw_features: loggedRaw,
    active_serving_features: activeServing,
    omitted_candidate_ids: omittedCandidateIds,
  };
}

export interface FeatureTimeSplitEvaluation {
  readonly split_id: string;
  /** Multiple-testing adjusted lower confidence bound of Δloss improvement (> 0 means improvement). */
  readonly adjusted_delta_lcb: number;
  /** Permutation importance upper bound (<= 0 means zero contribution). */
  readonly permutation_importance_ucb: number;
}

export interface FeatureAdmissionInput {
  readonly feature: FeatureDefinition;
  /** Coverage fill rate over the trailing 14 days (gate: >= 0.95). */
  readonly fill_rate_14d: number;
  readonly fill_days_observed: number;
  readonly sdk_canary_clean: boolean;
  /** Time-ordered consecutive split evaluations (oldest -> newest). */
  readonly split_evaluations: readonly FeatureTimeSplitEvaluation[];
}

export interface FeatureAdmissionDecision {
  readonly feature_id: string;
  readonly previous_state: FeatureLifecycleState;
  readonly next_state: FeatureLifecycleState;
  readonly reason: string;
  readonly passed_fill_rate_gate: boolean;
  readonly passed_two_split_gate: boolean;
  readonly triggered_retirement: boolean;
}

export const FEATURE_MIN_FILL_RATE_14D = 0.95 as const;
export const FEATURE_MIN_DAYS = 14 as const;
export const FEATURE_RETIRE_CONSECUTIVE_ZERO_CYCLES = 3 as const;

/**
 * Automatic feature admission & retirement evaluator (§8.2 / ML M2):
 * - Admission (`recording`/`eligible` -> `active`): 14d fill rate >= 0.95, SDK canary clean,
 *   and 2 consecutive time splits with multiple-testing adjusted improvement LCB > 0.
 * - Retirement (`active` -> `retired`): 3 consecutive cycles with zero contribution
 *   (`permutation_importance_ucb <= 0` or `adjusted_delta_lcb <= 0`).
 */
export function evaluateFeatureLifecycleTransition(
  input: FeatureAdmissionInput
): FeatureAdmissionDecision {
  const { feature, fill_rate_14d, fill_days_observed, sdk_canary_clean, split_evaluations } = input;

  const passedFillRate =
    fill_days_observed >= FEATURE_MIN_DAYS && fill_rate_14d >= FEATURE_MIN_FILL_RATE_14D;

  const lastTwo = split_evaluations.slice(-2);
  const passedTwoSplits =
    lastTwo.length === 2 && lastTwo.every((s) => s.adjusted_delta_lcb > 0);

  const lastThree = split_evaluations.slice(-FEATURE_RETIRE_CONSECUTIVE_ZERO_CYCLES);
  const threeZeroContribution =
    lastThree.length === FEATURE_RETIRE_CONSECUTIVE_ZERO_CYCLES &&
    lastThree.every((s) => s.permutation_importance_ucb <= 0);

  if (feature.state === 'active') {
    if (threeZeroContribution) {
      return {
        feature_id: feature.feature_id,
        previous_state: 'active',
        next_state: 'retired',
        reason: 'retired_three_consecutive_zero_contribution_cycles',
        passed_fill_rate_gate: passedFillRate,
        passed_two_split_gate: passedTwoSplits,
        triggered_retirement: true,
      };
    }
    return {
      feature_id: feature.feature_id,
      previous_state: 'active',
      next_state: 'active',
      reason: 'remains_active',
      passed_fill_rate_gate: passedFillRate,
      passed_two_split_gate: passedTwoSplits,
      triggered_retirement: false,
    };
  }

  if (feature.state === 'candidate') {
    return {
      feature_id: feature.feature_id,
      previous_state: 'candidate',
      next_state: sdk_canary_clean ? 'recording' : 'candidate',
      reason: sdk_canary_clean ? 'promoted_to_recording' : 'awaiting_sdk_canary',
      passed_fill_rate_gate: passedFillRate,
      passed_two_split_gate: passedTwoSplits,
      triggered_retirement: false,
    };
  }

  if (feature.state === 'recording' || feature.state === 'eligible') {
    if (passedFillRate && sdk_canary_clean && passedTwoSplits) {
      return {
        feature_id: feature.feature_id,
        previous_state: feature.state,
        next_state: 'active',
        reason: 'admitted_14d_coverage_and_two_split_lcb_positive',
        passed_fill_rate_gate: true,
        passed_two_split_gate: true,
        triggered_retirement: false,
      };
    }
    if (passedFillRate && sdk_canary_clean && feature.state === 'recording') {
      return {
        feature_id: feature.feature_id,
        previous_state: 'recording',
        next_state: 'eligible',
        reason: 'coverage_met_awaiting_two_positive_splits',
        passed_fill_rate_gate: true,
        passed_two_split_gate: false,
        triggered_retirement: false,
      };
    }
  }

  return {
    feature_id: feature.feature_id,
    previous_state: feature.state,
    next_state: feature.state,
    reason: 'criteria_not_yet_met',
    passed_fill_rate_gate: passedFillRate,
    passed_two_split_gate: passedTwoSplits,
    triggered_retirement: false,
  };
}
