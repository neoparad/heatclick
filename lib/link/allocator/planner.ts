/**
 * UGOKI LINK v2 — Single Unified Planning Sheet (`lib/link/allocator/planner.ts`)
 *
 * Implements §4.8, §9.4, §12.1 #5, D-20, EV M4 / G-0:
 * - ONE planning sheet shared by EV and ML (eliminates double-counting of 3,900 units/day)
 * - Uses canonical constants from `packages/contract/ledgers` (`ev.planner_inflation_f = 1.068`,
 *   `ev.min_experiment_days = 14`, `ev.horizon_indexable_days = 56`, `ev.horizon_non_indexable_days = 182`,
 *   `tel.weight_test_inp_pvs_per_arm = 30000`)
 * - Computes required units, required days (whole weeks, >=14d), `days_remaining`（「あと何日」）,
 *   detectable MDE at horizon, and `traffic_multiple_to_unlock` (never bare refusal!)
 * - Prints BOTH schedules per D-20: `page_view` units (pre-`tel.G10` Japan sign-off) and
 *   `visitor` units (post-`tel.G10`).
 */

import { CONSTANTS_LEDGER } from '../../../packages/contract/ledgers';
import type { FullArmSplitMode, MeasurementStage } from './types';

function readNumericConstant(id: string, fallback: number): number {
  const entry = CONSTANTS_LEDGER.find((c) => c.id === id);
  return entry && typeof entry.value === 'number' ? entry.value : fallback;
}

export const PLANNER_CONSTANTS = {
  inflationF: readNumericConstant('ev.planner_inflation_f', 1.068),
  minExperimentDays: readNumericConstant('ev.min_experiment_days', 14),
  horizonIndexableDays: readNumericConstant('ev.horizon_indexable_days', 56),
  horizonNonIndexableDays: readNumericConstant('ev.horizon_non_indexable_days', 182),
  holdoutSharePerBit: readNumericConstant('ev.holdout_share_per_bit', 0.05),
  steadyStubShare: readNumericConstant('tel.steady_stub_share', 0.05),
  weightTestInpPvsPerArm: readNumericConstant('tel.weight_test_inp_pvs_per_arm', 30000),
} as const;

export type PlannerTestMode =
  | 'confirm'
  | 'confirm_one_sided'
  | 'non_inferiority'
  | 'decision';

export interface ExperimentPlanInput {
  readonly baseline_rate: number; // e.g. 0.02
  readonly mde_relative: number; // e.g. 0.20 (+20%)
  readonly arms: number; // >= 2
  readonly mode: PlannerTestMode;
  readonly is_indexable_variant: boolean;
  /** Daily eligible units (e.g. 780 for 1 site, 3900 for 5 sites). */
  readonly eligible_units_per_day: number;
  /** Ratio of page views per visitor unit (default 1.4 per EV G-0 A1) for dual schedule. */
  readonly pvs_per_visitor_unit?: number;
  /** Fraction of units surviving holdouts × analysable rate (default 0.90 per EV G-0). */
  readonly analysable_share_q?: number;
  /** Trigger variance saving S >= 1 (default 1.0). */
  readonly trigger_saving_s?: number;
  /** Current measurement stage & Stage B split mode (for traffic share accounting, §12.1 #5). */
  readonly measurement_stage?: MeasurementStage;
  readonly full_split_mode?: FullArmSplitMode;
  /** Units already accrued to calculate exact `days_remaining`（「あと何日」）. */
  readonly accrued_units?: number;
}

export interface ExperimentScheduleRow {
  readonly unit_kind: 'page_view' | 'visitor';
  readonly effective_units_per_day: number;
  readonly required_units_per_arm: number;
  readonly required_units_total: number;
  readonly raw_days_required: number;
  readonly planned_days_whole_weeks: number;
  readonly days_remaining: number;
  readonly horizon_days: number;
  readonly feasible_within_horizon: boolean;
  readonly mde_at_horizon_relative: number;
  readonly traffic_multiple_to_unlock: number;
  readonly status_recommendation: 'ok' | 'insufficient_data';
}

export interface ExperimentPlanOutput {
  readonly inflation_f: number;
  readonly stage_usable_share: number;
  readonly page_view_schedule: ExperimentScheduleRow;
  readonly visitor_schedule: ExperimentScheduleRow;
}

const Z_ALPHA_TWO_SIDED_005 = 1.959963984540054;
const Z_BETA_POWER_080 = 0.8416212335729143;

/**
 * Computes exact two-proportion sample size per arm (two-sided α=0.05, power=0.80).
 */
export function computeTwoProportionNPerArm(
  baselineRate: number,
  mdeRelative: number,
  mode: PlannerTestMode
): number {
  const p0 = Math.max(1e-6, Math.min(1 - 1e-6, baselineRate));
  const delta = p0 * Math.abs(mdeRelative);
  const p1 = Math.max(1e-6, Math.min(1 - 1e-6, p0 + delta));
  const pBar = (p0 + p1) / 2;

  const num =
    Z_ALPHA_TWO_SIDED_005 * Math.sqrt(2 * pBar * (1 - pBar)) +
    Z_BETA_POWER_080 * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1));
  const nTwoSided = (num * num) / (delta * delta);

  if (mode === 'confirm_one_sided' || mode === 'non_inferiority') {
    return Math.ceil(nTwoSided * 0.79); // EV M4 / §9.4 exact factor
  }
  if (mode === 'decision') {
    return Math.ceil(nTwoSided * 0.65);
  }
  return Math.ceil(nTwoSided);
}

/**
 * Computes the usable experiment traffic fraction under the active measurement stage (§12.1 #5 / 判断 2).
 */
export function getMeasurementStageUsableShare(
  stage: MeasurementStage = 'stage_c_steady',
  fullSplitMode: FullArmSplitMode = 'half_verify_half_deliver',
  steadyStubShare = PLANNER_CONSTANTS.steadyStubShare
): number {
  if (stage === 'stage_a_dual_run') {
    // 1/3 v2-only excluded; up to 2/3 runs v3 (v3 + both), typically 0 delivery until weight test passes
    return 0;
  }
  if (stage === 'stage_b_weight_test') {
    return fullSplitMode === 'half_verify_half_deliver' ? 1 / 6 : 0;
  }
  return Math.max(0, 1 - steadyStubShare);
}

function solveMdeAtUnits(
  baselineRate: number,
  availableUnitsTotal: number,
  arms: number,
  mode: PlannerTestMode,
  inflationF: number
): number {
  if (availableUnitsTotal <= 0) return Infinity;
  let lo = 0.005;
  let hi = 5.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const need = computeTwoProportionNPerArm(baselineRate, mid, mode) * arms * inflationF;
    if (need <= availableUnitsTotal) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return Number(hi.toFixed(4));
}

function buildScheduleRow(params: {
  readonly unitKind: 'page_view' | 'visitor';
  readonly effectiveUnitsPerDay: number;
  readonly baselineRate: number;
  readonly mdeRelative: number;
  readonly arms: number;
  readonly mode: PlannerTestMode;
  readonly horizonDays: number;
  readonly accruedUnits: number;
}): ExperimentScheduleRow {
  const f = PLANNER_CONSTANTS.inflationF;
  const nPerArm = computeTwoProportionNPerArm(
    params.baselineRate,
    params.mdeRelative,
    params.mode
  );
  const nTotalInflated = Math.ceil(nPerArm * params.arms * f);

  if (params.effectiveUnitsPerDay <= 0) {
    return {
      unit_kind: params.unitKind,
      effective_units_per_day: 0,
      required_units_per_arm: nPerArm,
      required_units_total: nTotalInflated,
      raw_days_required: Infinity,
      planned_days_whole_weeks: Infinity,
      days_remaining: Infinity,
      horizon_days: params.horizonDays,
      feasible_within_horizon: false,
      mde_at_horizon_relative: Infinity,
      traffic_multiple_to_unlock: Infinity,
      status_recommendation: 'insufficient_data',
    };
  }

  const rawDays = nTotalInflated / params.effectiveUnitsPerDay;
  const plannedWholeWeeks = Math.max(
    PLANNER_CONSTANTS.minExperimentDays,
    Math.ceil(rawDays / 7) * 7
  );
  const remainingUnits = Math.max(0, nTotalInflated - params.accruedUnits);
  const daysRemaining = Math.ceil(remainingUnits / params.effectiveUnitsPerDay);
  const feasible = rawDays <= params.horizonDays;
  const horizonUnits = params.effectiveUnitsPerDay * params.horizonDays;
  const mdeAtHorizon = solveMdeAtUnits(
    params.baselineRate,
    horizonUnits,
    params.arms,
    params.mode,
    f
  );
  const trafficMultiple = feasible
    ? 1
    : Number((nTotalInflated / Math.max(1, horizonUnits)).toFixed(2));

  return {
    unit_kind: params.unitKind,
    effective_units_per_day: Number(params.effectiveUnitsPerDay.toFixed(2)),
    required_units_per_arm: nPerArm,
    required_units_total: nTotalInflated,
    raw_days_required: Number(rawDays.toFixed(1)),
    planned_days_whole_weeks: plannedWholeWeeks,
    days_remaining: daysRemaining,
    horizon_days: params.horizonDays,
    feasible_within_horizon: feasible,
    mde_at_horizon_relative: mdeAtHorizon,
    traffic_multiple_to_unlock: trafficMultiple,
    status_recommendation: feasible ? 'ok' : 'insufficient_data',
  };
}

/**
 * Generates the unified single planning sheet with BOTH `page_view` (pre-`tel.G10`)
 * and `visitor` (post-`tel.G10`) schedules (D-20 / EV M4 / §9.4).
 */
export function planExperiment(input: ExperimentPlanInput): ExperimentPlanOutput {
  const q = input.analysable_share_q ?? 0.9;
  const s = Math.max(1, input.trigger_saving_s ?? 1);
  const pvsPerUnit = input.pvs_per_visitor_unit ?? 1.4;
  const horizonDays = input.is_indexable_variant
    ? PLANNER_CONSTANTS.horizonIndexableDays
    : PLANNER_CONSTANTS.horizonNonIndexableDays;

  const stageShare =
    input.measurement_stage !== undefined
      ? getMeasurementStageUsableShare(input.measurement_stage, input.full_split_mode)
      : 1;

  const effectiveVisitorPerDay = input.eligible_units_per_day * q * s * stageShare;
  const effectivePvPerDay = effectiveVisitorPerDay * pvsPerUnit;
  const accrued = input.accrued_units ?? 0;

  return {
    inflation_f: PLANNER_CONSTANTS.inflationF,
    stage_usable_share: stageShare,
    visitor_schedule: buildScheduleRow({
      unitKind: 'visitor',
      effectiveUnitsPerDay: effectiveVisitorPerDay,
      baselineRate: input.baseline_rate,
      mdeRelative: input.mde_relative,
      arms: Math.max(2, input.arms),
      mode: input.mode,
      horizonDays,
      accruedUnits: accrued,
    }),
    page_view_schedule: buildScheduleRow({
      unitKind: 'page_view',
      effectiveUnitsPerDay: effectivePvPerDay,
      baselineRate: input.baseline_rate,
      mdeRelative: input.mde_relative,
      arms: Math.max(2, input.arms),
      mode: input.mode,
      horizonDays,
      accruedUnits: accrued,
    }),
  };
}

export interface SdkWeightTestPlanInput {
  readonly daily_pvs: number; // e.g. 164000 / 30 = 5466.7 across 5 sites
  readonly inp_bearing_share?: number; // default 0.40 (§4.8)
  readonly full_split_mode: FullArmSplitMode;
  readonly accrued_inp_pvs_in_smallest_arm?: number;
}

export interface SdkWeightTestPlanOutput {
  readonly target_inp_pvs_per_arm: number;
  readonly smallest_verify_arm_share: number;
  readonly parallel_delivery_arm_share: number;
  readonly days_required: number;
  readonly days_remaining: number;
}

/**
 * Estimates duration & remaining days for the causal SDK weight equivalence test
 * (`tel.G16`, §4.8, 判断 2: 30,000 INP-bearing PVs per arm).
 */
export function planSdkWeightTest(input: SdkWeightTestPlanInput): SdkWeightTestPlanOutput {
  const target = PLANNER_CONSTANTS.weightTestInpPvsPerArm;
  const inpShare = input.inp_bearing_share ?? 0.4;
  const smallestVerifyArmShare =
    input.full_split_mode === 'half_verify_half_deliver' ? 1 / 6 : 1 / 3;
  const parallelDeliveryShare =
    input.full_split_mode === 'half_verify_half_deliver' ? 1 / 6 : 0;

  const dailyInpInSmallestArm = input.daily_pvs * inpShare * smallestVerifyArmShare;
  const accrued = input.accrued_inp_pvs_in_smallest_arm ?? 0;
  const remaining = Math.max(0, target - accrued);

  return {
    target_inp_pvs_per_arm: target,
    smallest_verify_arm_share: smallestVerifyArmShare,
    parallel_delivery_arm_share: parallelDeliveryShare,
    days_required: dailyInpInSmallestArm > 0 ? Math.ceil(target / dailyInpInSmallestArm) : Infinity,
    days_remaining:
      dailyInpInSmallestArm > 0 ? Math.ceil(remaining / dailyInpInSmallestArm) : Infinity,
  };
}
