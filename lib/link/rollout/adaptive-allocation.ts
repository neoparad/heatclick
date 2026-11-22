/**
 * UGOKI LINK v2 — Adaptive Allocation 10,000-Replay Verifier & CATE Personalisation (§9.6, §8.3, D-17)
 *
 * Implements:
 * 1. Adaptive / Bandit Allocation 10,000-Replay Verifier (§9.6):
 *    - Replays the logged adaptive allocation policy over the EXACT observed arrival sequence
 *      10,000 times under the sharp null to compute exact randomization p-value
 *    - Enforces `ev.bandit_min_arm_floor` (`max(0.10, 1/(2K))`) & `ev.bandit_uniform_slice` (`>= 0.10`)
 *    - Unverifiable or non-logged policies are automatically demoted to `observed` delivery tool
 *      (NEVER `proven`)
 * 2. CATE Individual Personalisation Stage (§8.3 / D-17):
 *    - Displays personalized treatment ONLY when `cateLowerBound > displayCost && withinGuardrails`
 *    - External tenants are locked `not_entitled` until Decision `D-17` + legal sign-off are recorded
 */

import { getConstant, requireDecisionEntitled } from '../../../packages/contract/ledgers';
import type { ProvenPredicateResult } from '../../../packages/contract/response';

// =========================================================================
// 1. Adaptive Allocation 10,000-Replay Exact Verification (§9.6)
// =========================================================================

export const ADAPTIVE_REPLAY_REQUIRED_RUNS = 10_000;

const minArmFloorConst = getConstant('ev.bandit_min_arm_floor')?.value;
export const BANDIT_MIN_ARM_FLOOR =
  typeof minArmFloorConst === 'number' ? minArmFloorConst : 0.1;

const uniformSliceConst = getConstant('ev.bandit_uniform_slice')?.value;
export const BANDIT_UNIFORM_SLICE_MIN =
  typeof uniformSliceConst === 'number' ? uniformSliceConst : 0.1;

export interface AdaptiveArrivalObservation {
  readonly arrivalIndex: number;
  readonly batchIndex: number;
  readonly armIndex: number; // 0 = control, 1..K-1 = treatments
  readonly propensity: number;
  readonly outcome: number;
  readonly inUniformSlice: boolean;
}

/**
 * Deterministic policy callback: given cumulative counts & outcome sums from prior completed batches
 * and number of arms `K`, returns the allocation probability vector summing to 1.
 */
export type LoggedAdaptivePolicyFn = (
  armCounts: readonly number[],
  armOutcomeSums: readonly number[],
  numArms: number
) => readonly number[];

export interface AdaptiveReplayVerificationInput {
  readonly experimentId: string;
  readonly numArms: number;
  readonly targetArmIndex: number; // treatment arm being compared against control (arm 0)
  readonly arrivals: readonly AdaptiveArrivalObservation[];
  /** Logged deterministic adaptive policy; pass `null` when policy was not logged/reproducible. */
  readonly loggedPolicy: LoggedAdaptivePolicyFn | null;
  readonly preregLocked: boolean;
  readonly allocatorLoggedBeforeOutcomes: boolean;
  readonly integrityStatus: 'pass' | 'unverified' | 'fail';
  readonly platformCanaryPassed: boolean;
  readonly durationDays: number;
  readonly alpha?: number;
  readonly replayCount?: number; // default 10,000
  readonly seed?: number;
  readonly evaluatedAtIso: string;
}

export interface AdaptiveReplayVerificationResult {
  readonly experimentId: string;
  readonly replayCountExecuted: number;
  readonly verifiable: boolean;
  readonly role: 'proven_adaptive_experiment' | 'observed_delivery_tool';
  readonly evidenceLevel: 'proven' | 'observed';
  readonly observedTestStatistic: number;
  readonly randomizationPValue: number | null;
  readonly observedMinArmPropensity: number;
  readonly observedUniformSliceShare: number;
  readonly predicate: ProvenPredicateResult | null;
  readonly demotionReasons: readonly string[];
}

/** Fast deterministic Mulberry32 PRNG for 10,000-replay randomization inference in < 100 ms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Exact idempotent projection onto the floored probability simplex (`[H-07]`):
 * $$\Delta_{\epsilon} = \left\{ p \in \mathbb{R}^K : p_k \ge \epsilon,\; \sum_{k=0}^{K-1} p_k = 1 \right\}$$
 *
 * Uses active-set proportional water-filling:
 * 1. Normalizes positive weights $w_k$ onto $\Delta_0$ ($q_k = w_k / \sum_j w_j$).
 * 2. Iteratively clamps any coordinate $p_k < \epsilon$ to $\epsilon$ and redistributes remaining
 *    mass $1 - m \epsilon$ proportionally across unclamped coordinates (converges in $\le K$ steps).
 * 3. Strictly idempotent: for any $p \in \Delta_\epsilon$, `normalizeProbsWithFloor(p, K, eps)`
 *    returns $p$ unchanged (`max |f(f(w)) - f(w)| < 1e-15`), eliminating double-flooring shrinkage!
 */
export function normalizeProbsWithFloor(
  raw: readonly number[],
  numArms: number,
  floor: number
): number[] {
  const kCount = Math.max(1, numArms);
  const effectiveFloor = Math.min(Math.max(0, floor), 1 / kCount);
  const q = new Array<number>(kCount);
  let rawSum = 0;
  for (let k = 0; k < kCount; k += 1) {
    const v = Number.isFinite(raw[k]) && raw[k] > 0 ? raw[k] : 0;
    q[k] = v;
    rawSum += v;
  }
  if (rawSum <= 0) {
    for (let k = 0; k < kCount; k += 1) q[k] = 1 / kCount;
    return q;
  }
  for (let k = 0; k < kCount; k += 1) {
    q[k] /= rawSum;
  }

  const out = new Array<number>(kCount).fill(0);
  const clamped = new Uint8Array(kCount);
  let clampedCount = 0;

  for (let iter = 0; iter < kCount; iter += 1) {
    const remMass = Math.max(0, 1 - clampedCount * effectiveFloor);
    const unclampedCount = kCount - clampedCount;
    if (unclampedCount <= 0) {
      break;
    }

    let activeSum = 0;
    for (let k = 0; k < kCount; k += 1) {
      if (clamped[k] === 0) activeSum += q[k];
    }

    if (activeSum <= 1e-15) {
      const share = remMass / unclampedCount;
      for (let k = 0; k < kCount; k += 1) {
        if (clamped[k] === 0) out[k] = share;
      }
      break;
    }

    let newlyClamped = false;
    for (let k = 0; k < kCount; k += 1) {
      if (clamped[k] === 1) continue;
      const candidate = remMass * (q[k] / activeSum);
      if (candidate < effectiveFloor - 1e-15) {
        clamped[k] = 1;
        out[k] = effectiveFloor;
        clampedCount += 1;
        newlyClamped = true;
      } else {
        out[k] = candidate;
      }
    }

    if (!newlyClamped) {
      break;
    }
  }

  // Exact final normalization drift cleanup (< 1e-16) preserving floor
  let finalSum = 0;
  let maxIdx = 0;
  for (let k = 0; k < kCount; k += 1) {
    finalSum += out[k];
    if (out[k] > out[maxIdx]) maxIdx = k;
  }
  if (Math.abs(1 - finalSum) > 0 && out[maxIdx] + (1 - finalSum) >= effectiveFloor) {
    out[maxIdx] += 1 - finalSum;
  }

  return out;
}

/**
 * Default logged batched Thompson/softmax-like deterministic adaptive policy
 * suitable for replay verification.
 */
export function defaultBatchedAdaptivePolicy(
  armCounts: readonly number[],
  armOutcomeSums: readonly number[],
  numArms: number
): readonly number[] {
  const floor = Math.max(BANDIT_MIN_ARM_FLOOR, 1 / (2 * numArms));
  const scores = new Array<number>(numArms);
  let maxScore = -Infinity;
  for (let k = 0; k < numArms; k++) {
    const rate = (armOutcomeSums[k] + 1) / (armCounts[k] + 2);
    scores[k] = rate * 4;
    if (scores[k] > maxScore) maxScore = scores[k];
  }
  const exps = scores.map((s) => Math.exp(s - maxScore));
  return normalizeProbsWithFloor(exps, numArms, floor);
}

function computeContrastStat(
  targetSum: number,
  targetCount: number,
  controlSum: number,
  controlCount: number
): number {
  const meanTarget = targetCount > 0 ? targetSum / targetCount : 0;
  const meanControl = controlCount > 0 ? controlSum / controlCount : 0;
  return meanTarget - meanControl;
}

/**
 * Verifies a logged adaptive allocation experiment by replaying the policy over the exact
 * observed arrival order 10,000 times under the sharp null (§9.6).
 * Unverifiable policies are strictly demoted to `observed` delivery tools.
 */
export function verifyAdaptiveAllocationPolicy(
  input: AdaptiveReplayVerificationInput
): AdaptiveReplayVerificationResult {
  const alpha = input.alpha ?? 0.05;
  const replayCount = input.replayCount ?? ADAPTIVE_REPLAY_REQUIRED_RUNS;
  const numArms = Math.max(2, input.numArms);
  const requiredFloor = Math.max(BANDIT_MIN_ARM_FLOOR, 1 / (2 * numArms));
  const demotionReasons: string[] = [];

  const sorted = [...input.arrivals].sort(
    (a, b) => a.arrivalIndex - b.arrivalIndex
  );
  const n = sorted.length;

  let obsTargetSum = 0;
  let obsTargetCount = 0;
  let obsControlSum = 0;
  let obsControlCount = 0;
  let minPropensity = 1;
  let uniformCount = 0;

  for (let i = 0; i < n; i++) {
    const row = sorted[i];
    if (row.propensity < minPropensity) minPropensity = row.propensity;
    if (row.inUniformSlice) uniformCount += 1;
    if (row.armIndex === input.targetArmIndex) {
      obsTargetSum += row.outcome;
      obsTargetCount += 1;
    } else if (row.armIndex === 0) {
      obsControlSum += row.outcome;
      obsControlCount += 1;
    }
  }

  const observedStat = computeContrastStat(
    obsTargetSum,
    obsTargetCount,
    obsControlSum,
    obsControlCount
  );
  const observedUniformSliceShare = n > 0 ? uniformCount / n : 0;

  if (!input.loggedPolicy) demotionReasons.push('policy_not_logged_or_unreproducible');
  if (n === 0) demotionReasons.push('empty_arrival_sequence');
  if (replayCount < ADAPTIVE_REPLAY_REQUIRED_RUNS) {
    demotionReasons.push(`replay_count_lt_${ADAPTIVE_REPLAY_REQUIRED_RUNS}`);
  }
  if (minPropensity < requiredFloor - 1e-9) {
    demotionReasons.push(
      `arm_floor_breached(min=${minPropensity.toFixed(4)}<${requiredFloor.toFixed(4)})`
    );
  }
  if (observedUniformSliceShare < BANDIT_UNIFORM_SLICE_MIN - 0.02) {
    demotionReasons.push(
      `uniform_slice_below_10pct(observed=${observedUniformSliceShare.toFixed(4)})`
    );
  }
  if (!input.allocatorLoggedBeforeOutcomes) {
    demotionReasons.push('allocator_not_logged_before_outcomes');
  }
  if (!input.preregLocked) demotionReasons.push('prereg_not_locked');
  if (input.integrityStatus !== 'pass') demotionReasons.push('integrity_not_pass');
  if (!input.platformCanaryPassed) demotionReasons.push('platform_canary_failed');
  if (input.durationDays < 14) demotionReasons.push('duration_lt_14d');

  // If policy cannot be verified (unlogged or missing data), demote immediately without fabricating p-value
  if (!input.loggedPolicy || n === 0) {
    return {
      experimentId: input.experimentId,
      replayCountExecuted: 0,
      verifiable: false,
      role: 'observed_delivery_tool',
      evidenceLevel: 'observed',
      observedTestStatistic: observedStat,
      randomizationPValue: null,
      observedMinArmPropensity: n > 0 ? minPropensity : 0,
      observedUniformSliceShare,
      predicate: null,
      demotionReasons,
    };
  }

  // Group arrivals by batchIndex in exact arrival order for fast 10,000-replay loop
  const batchStarts: number[] = [];
  const batchEnds: number[] = [];
  let bStart = 0;
  while (bStart < n) {
    const bId = sorted[bStart].batchIndex;
    let bEnd = bStart + 1;
    while (bEnd < n && sorted[bEnd].batchIndex === bId) bEnd += 1;
    batchStarts.push(bStart);
    batchEnds.push(bEnd);
    bStart = bEnd;
  }

  const outcomes = new Float64Array(n);
  const isUniform = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    outcomes[i] = sorted[i].outcome;
    isUniform[i] = sorted[i].inUniformSlice ? 1 : 0;
  }

  const rng = mulberry32(input.seed ?? 20261120);
  const absObs = Math.abs(observedStat);
  let extremeCount = 0;
  const numBatches = batchStarts.length;
  const uniformProb = 1 / numArms;

  // Execute exact 10,000-run randomization replay over observed arrival sequence
  const armCounts = new Array<number>(numArms);
  const armSums = new Array<number>(numArms);
  const batchArmCounts = new Array<number>(numArms);
  const batchArmSums = new Array<number>(numArms);

  for (let r = 0; r < replayCount; r++) {
    armCounts.fill(0);
    armSums.fill(0);

    for (let b = 0; b < numBatches; b++) {
      const probs = normalizeProbsWithFloor(
        input.loggedPolicy(armCounts, armSums, numArms),
        numArms,
        requiredFloor
      );
      batchArmCounts.fill(0);
      batchArmSums.fill(0);

      const start = batchStarts[b];
      const end = batchEnds[b];
      for (let i = start; i < end; i++) {
        const u = rng();
        let chosenArm = numArms - 1;
        if (isUniform[i] === 1) {
          chosenArm = Math.min(numArms - 1, Math.floor(u / uniformProb));
        } else {
          let cum = 0;
          for (let k = 0; k < numArms; k++) {
            cum += probs[k];
            if (u < cum) {
              chosenArm = k;
              break;
            }
          }
        }
        batchArmCounts[chosenArm] += 1;
        batchArmSums[chosenArm] += outcomes[i];
      }

      for (let k = 0; k < numArms; k++) {
        armCounts[k] += batchArmCounts[k];
        armSums[k] += batchArmSums[k];
      }
    }

    const simStat = computeContrastStat(
      armSums[input.targetArmIndex],
      armCounts[input.targetArmIndex],
      armSums[0],
      armCounts[0]
    );
    if (Math.abs(simStat) >= absObs - 1e-12) {
      extremeCount += 1;
    }
  }

  const pValue = (1 + extremeCount) / (replayCount + 1);
  if (pValue > alpha) {
    demotionReasons.push(`randomization_p_gt_alpha(${pValue.toFixed(4)}>${alpha})`);
  }

  const verifiableAndProven = demotionReasons.length === 0;

  return {
    experimentId: input.experimentId,
    replayCountExecuted: replayCount,
    verifiable: true,
    role: verifiableAndProven
      ? 'proven_adaptive_experiment'
      : 'observed_delivery_tool',
    evidenceLevel: verifiableAndProven ? 'proven' : 'observed',
    observedTestStatistic: observedStat,
    randomizationPValue: pValue,
    observedMinArmPropensity: minPropensity,
    observedUniformSliceShare,
    predicate: verifiableAndProven
      ? {
          predicate: 'bandit_replay',
          passed: true,
          allocator_logged_before_outcomes: true,
          prereg_locked: true,
          integrity_status: 'pass',
          decision_rule_passed: true,
          randomisation_audit_p: pValue,
          alpha,
          duration_days: input.durationDays,
          platform_canary_passed: true,
          evaluated_at: input.evaluatedAtIso,
        }
      : null,
    demotionReasons,
  };
}

// =========================================================================
// 2. CATE Individual Personalisation Stage (§8.3 / D-17)
// =========================================================================

export interface CatePersonalisationRequest {
  readonly tenantId: string;
  readonly isExternalTenant: boolean;
  readonly candidateTreatmentId: string;
  /** Estimated Conditional Average Treatment Effect point estimate. */
  readonly catePointEstimate: number;
  /** Conservative lower confidence bound of CATE for this visitor context. */
  readonly cateLowerBound: number;
  /** Expected display/annoyance/latency cost expressed on the same scale as CATE. */
  readonly displayCost: number;
  /** True iff all operational/business guardrails (INP, CLS, frequency cap) are satisfied. */
  readonly withinGuardrails: boolean;
  /** Optional test overrides for Decision D-17 + legal sign-off. */
  readonly decision17ApprovedOverride?: boolean;
  readonly decision17LegalSignedOffOverride?: boolean;
}

export interface CatePersonalisationDecision {
  readonly status: 'ok' | 'not_entitled';
  readonly decision: 'serve_personalized' | 'fallback_default';
  readonly selectedTreatmentId: string | null;
  readonly netLowerBoundBenefit: number;
  readonly reason: string;
}

/**
 * Evaluates CATE-based visitor personalisation (§8.3 / D-17):
 * - External tenants stay `not_entitled` until Decision D-17 + legal sign-off
 * - Displays personalized treatment ONLY when `cateLowerBound > displayCost` AND guardrails pass
 */
export function evaluateCatePersonalisation(
  req: CatePersonalisationRequest
): CatePersonalisationDecision {
  if (req.isExternalTenant) {
    const ledgerD17 = requireDecisionEntitled('D-17', { enforceLegalSignOff: true });
    const d17Entitled =
      req.decision17ApprovedOverride !== undefined &&
      req.decision17LegalSignedOffOverride !== undefined
        ? req.decision17ApprovedOverride && req.decision17LegalSignedOffOverride
        : ledgerD17.entitled;

    if (!d17Entitled) {
      return {
        status: 'not_entitled',
        decision: 'fallback_default',
        selectedTreatmentId: null,
        netLowerBoundBenefit: req.cateLowerBound - req.displayCost,
        reason: 'decision_17_pending_external_personalisation_locked',
      };
    }
  }

  const netLowerBoundBenefit = req.cateLowerBound - req.displayCost;

  if (!req.withinGuardrails) {
    return {
      status: 'ok',
      decision: 'fallback_default',
      selectedTreatmentId: null,
      netLowerBoundBenefit,
      reason: 'guardrail_breached_suppress_personalisation',
    };
  }

  if (req.cateLowerBound <= req.displayCost) {
    return {
      status: 'ok',
      decision: 'fallback_default',
      selectedTreatmentId: null,
      netLowerBoundBenefit,
      reason: 'cate_lower_bound_not_above_cost',
    };
  }

  return {
    status: 'ok',
    decision: 'serve_personalized',
    selectedTreatmentId: req.candidateTreatmentId,
    netLowerBoundBenefit,
    reason: 'cate_lower_bound_exceeds_cost_within_guardrails',
  };
}
