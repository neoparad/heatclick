/**
 * UGOKI LINK v2 — ML Foundation: §8.8 Evaluation, 2-Entry Promotion & Auto Rollback
 *
 * Implements §8.8, ML M8:
 * - Two separate entry tracks declared upfront:
 *   1. `superior`: offline Δ LCB > 0 -> 14d shadow -> full-unit OPE replay (static slice check)
 *      -> policy test (`proven` only when stored EV predicate passes).
 *   2. `non_inferior`: pre-registered tolerable degradation margin (`-margin`) AND explicit
 *      adoption gain criterion (latency/cost improvement); offline LCB > -margin -> 14d shadow
 *      -> OPE LCB > -margin -> policy test (`observed` or `proven` "not worse than -margin",
 *      NEVER unlocks projected lift numbers!).
 * - Automatic alias rollback when guardrails, calibration slope, verification rate (<99%),
 *   or null-rate spike breach thresholds, targeting only a safe previous version (or base/rule).
 */

import type { EvidenceLevel } from '../../../../packages/contract/response';

export type PromotionEntryTrack = 'superior' | 'non_inferior';

export type PromotionScope = 'delivery_policy' | 'analytics_only';

export interface NonInferioritySpec {
  /** Positive magnitude `m` representing max tolerable degradation `-m`. */
  readonly max_degradation_margin: number;
  /** Explicit gain justification (e.g. latency or cost reduction) required for non-inferior adoption. */
  readonly adoption_gain_met: boolean;
  readonly adoption_gain_basis: string;
}

export interface PromotionEvaluationInput {
  readonly challenger_version_id: string;
  readonly champion_version_id: string;
  readonly track: PromotionEntryTrack;
  readonly scope: PromotionScope;
  /** Offline paired-difference lower confidence bound (challenger - champion). */
  readonly offline_delta_lcb: number;
  /** Shadow operation days completed (gate: >= 14 days). */
  readonly shadow_days_completed: number;
  /** True if shadow run logged zero critical faults / parity mismatches. */
  readonly shadow_clean: boolean;
  /** Full-unit logged-propensity OPE delta LCB (required for `delivery_policy`). */
  readonly ope_delta_lcb?: number;
  /** Static uniform-slice sanity check passed (required for `delivery_policy`). */
  readonly static_slice_consistent?: boolean;
  /** Online policy test passed (required for `delivery_policy`). */
  readonly policy_test_passed?: boolean;
  /** Stored EV M10 / §9.10 predicate passed (determines `proven` vs `observed`). */
  readonly ev_proven_predicate_passed?: boolean;
  /** Platform A/A canary passed (§8.8: canary fail invalidates prior experiments). */
  readonly platform_canary_passed: boolean;
  /** Required when `track === 'non_inferior'`. */
  readonly non_inferiority?: NonInferioritySpec;
}

export interface PromotionDecision {
  readonly promoted: boolean;
  readonly track: PromotionEntryTrack;
  readonly evidence_level: EvidenceLevel | 'invalid';
  readonly projected_lift_allowed: false;
  readonly unmet_gates: readonly string[];
  readonly summary: string;
}

export const MIN_SHADOW_DAYS = 14 as const;

/**
 * Evaluates a challenger model against §8.8 promotion rules (superior & non_inferior entries).
 */
export function evaluateModelPromotion(input: PromotionEvaluationInput): PromotionDecision {
  const unmet: string[] = [];

  if (!input.platform_canary_passed) {
    return {
      promoted: false,
      track: input.track,
      evidence_level: 'invalid',
      projected_lift_allowed: false,
      unmet_gates: ['ev.platform_canary'],
      summary: 'Platform A/A canary failed; promotion blocked and verdict marked invalid (§8.8).',
    };
  }

  // 1. Offline gate by declared entry track
  if (input.track === 'superior') {
    if (input.offline_delta_lcb <= 0) {
      unmet.push('ml.offline_superior_lcb_gt_0');
    }
  } else {
    const ni = input.non_inferiority;
    if (!ni || ni.max_degradation_margin < 0) {
      unmet.push('ml.non_inferior_margin_preregistered');
    } else {
      if (input.offline_delta_lcb < -ni.max_degradation_margin) {
        unmet.push('ml.offline_non_inferior_lcb_within_margin');
      }
      if (!ni.adoption_gain_met) {
        unmet.push('ml.non_inferior_adoption_gain_criterion');
      }
    }
  }

  // 2. Shadow run >= 14 days
  if (input.shadow_days_completed < MIN_SHADOW_DAYS || !input.shadow_clean) {
    unmet.push('ml.shadow_14d_clean');
  }

  // 3. Delivery-impacting policies additionally require full-unit OPE + static-slice check + policy test
  if (input.scope === 'delivery_policy') {
    const opeMargin =
      input.track === 'non_inferior' ? -(input.non_inferiority?.max_degradation_margin ?? 0) : 0;
    if (input.ope_delta_lcb === undefined || input.ope_delta_lcb <= opeMargin) {
      unmet.push('ml.ope_full_unit_lcb');
    }
    if (input.static_slice_consistent !== true) {
      unmet.push('ml.ope_static_slice_integrity');
    }
    if (input.policy_test_passed !== true) {
      unmet.push('ml.policy_test_passed');
    }
  }

  const promoted = unmet.length === 0;
  const evidenceLevel: EvidenceLevel =
    promoted && input.ev_proven_predicate_passed === true ? 'proven' : 'observed';

  return {
    promoted,
    track: input.track,
    evidence_level: evidenceLevel,
    projected_lift_allowed: false,
    unmet_gates: unmet,
    summary: promoted
      ? input.track === 'superior'
        ? `Challenger ${input.challenger_version_id} promoted via superior track (${evidenceLevel}).`
        : `Challenger ${input.challenger_version_id} promoted via non_inferior track within -${input.non_inferiority?.max_degradation_margin ?? 0} margin (${evidenceLevel}; gain: ${input.non_inferiority?.adoption_gain_basis ?? 'n/a'}).`
      : `Promotion blocked; unmet gates: ${unmet.join(', ')}.`,
  };
}

export interface LiveRollbackHealthMetrics {
  readonly guardrail_breached: boolean;
  readonly calibration_slope: number; // healthy range [0.85, 1.15]
  readonly token_verification_rate: number; // healthy >= 0.99
  readonly null_feature_rate_spike: boolean;
}

export interface RollbackCandidate {
  readonly version_id: string;
  readonly passes_safety_checks: boolean;
  readonly passes_deletion_generation: boolean;
  readonly passes_quality_floor: boolean;
}

export interface RollbackDecision {
  readonly should_rollback: boolean;
  readonly reasons: readonly string[];
  readonly target_alias_version_id: string | 'base_model_or_rule_fallback' | null;
}

/**
 * Evaluates live production health metrics and selects a safe rollback target (§8.8 / §8.14).
 * Never rolls back to a version that violates deletion, safety, or quality gates!
 */
export function evaluateAutomaticRollback(
  health: LiveRollbackHealthMetrics,
  previousCandidatesNewestFirst: readonly RollbackCandidate[]
): RollbackDecision {
  const reasons: string[] = [];

  if (health.guardrail_breached) reasons.push('guardrail_breached');
  if (health.calibration_slope < 0.85 || health.calibration_slope > 1.15) {
    reasons.push(`calibration_slope_out_of_bounds:${health.calibration_slope.toFixed(3)}`);
  }
  if (health.token_verification_rate < 0.99) {
    reasons.push(`verification_rate_below_99pct:${health.token_verification_rate.toFixed(4)}`);
  }
  if (health.null_feature_rate_spike) reasons.push('null_feature_rate_spike');

  if (reasons.length === 0) {
    return {
      should_rollback: false,
      reasons: [],
      target_alias_version_id: null,
    };
  }

  const safeCandidate = previousCandidatesNewestFirst.find(
    (c) => c.passes_safety_checks && c.passes_deletion_generation && c.passes_quality_floor
  );

  return {
    should_rollback: true,
    reasons,
    target_alias_version_id: safeCandidate ? safeCandidate.version_id : 'base_model_or_rule_fallback',
  };
}
