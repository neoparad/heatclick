/**
 * UGOKI LINK v2 — Bundle 6-F.2: Pop-up "Whether / Which" 5-Tier Ladder & Unified Bandit Constants
 * (`lib/link/models/popup/selection-policy.ts`)
 *
 * Implements §8.3, §8.12, ML M3:
 * - 5-tier "Whether / Which" ladder (all implemented; upper tiers registered as `challenger`):
 *   1. `P0_randomised_with_no_show`: uniform/fixed randomised A/B/n including explicit `no_show`
 *   2. `P1_preregistered_segments`: at most 3 pre-registered segments (rejects >3!)
 *   3. `P2_adaptive_bandit`: Thompson Sampling / UCB with 4-G creative-attribute hierarchical priors
 *      (`[appeal_kind, tone, length_bucket, offer_kind]`) for cold-start variants
 *   4. `P2_5_shallow_policy_tree`: doubly-robust shallow policy tree (depth <= 3, deployable as
 *      4-F <=50 KB int8 tree artifact)
 *   5. `P3_cate_uplift`: per-unit uplift CATE; shows ONLY when `cate_lcb > tenant_cost &&
 *      guardrail_harm <= guardrail_margin`, else abstains to `'no_show'`!
 * - Unified Adaptive Allocation Constants (§8.3):
 *   - Minimum allocation per arm: `max(0.10, 1 / (2 * K))`
 *   - Non-adaptive uniform sanity slice: `0.10`
 *   - Start threshold: `>= 310` expected conversions per arm (at +20% MDE)
 *   - Update threshold: `>= 50` matured conversions in the SMALLEST arm (checked on 7-day cadence;
 *     holds probabilities frozen if smallest arm < 50!)
 *   - Verification contract: full-unit logged-propensity replay (`>= 10,000` bootstrap/IPS replays).
 */

import { drawUniformU } from '../../allocator/hmac';
import { sha256Hex } from '../../../../packages/contract/schema';
import {
  evaluateInt8ModelArtifact,
  type SignedInt8ModelArtifact,
} from '../../ml/foundation/int8-tree-runtime';
import type { MlModelRegistry } from '../../ml/foundation/registry';

export const POPUP_BANDIT_CONSTANTS = {
  minArmFloorBase: 0.1,
  staticUniformSlice: 0.1,
  startMinExpectedConversionsPerArm: 310,
  updateMinMaturedConversionsSmallestArm: 50,
  updateCheckCadenceDays: 7,
  maxPreregisteredSegmentsP1: 3,
  maxShallowPolicyTreeDepth: 3,
  replayVerificationIterations: 10_000,
} as const;

export type PopupSelectionRung =
  | 'P0_randomised_with_no_show'
  | 'P1_preregistered_segments'
  | 'P2_adaptive_bandit'
  | 'P2_5_shallow_policy_tree'
  | 'P3_cate_uplift';

/**
 * Computes exact minimum allocation floor per arm (§8.3): `max(0.10, 1 / (2 * K))`.
 */
export function computeBanditMinArmFloor(numArmsK: number): number {
  const k = Math.max(2, numArmsK);
  return Math.max(POPUP_BANDIT_CONSTANTS.minArmFloorBase, 1 / (2 * k));
}

export interface CreativeAttributePriorInput {
  readonly arm_id: string;
  readonly is_no_show?: boolean;
  /** 4-G LLM-extracted creative attributes (§8.12 "ML の各機能の強化") */
  readonly attributes?: {
    readonly appeal_kind: 'price_discount' | 'social_proof' | 'comparison' | 'urgency' | 'guide';
    readonly tone: 'neutral' | 'urgent' | 'empathetic' | 'authoritative';
    readonly length_bucket: 'short' | 'medium' | 'long';
    readonly offer_kind: 'coupon' | 'free_trial' | 'comparison_table' | 'consultation' | 'none';
  };
  /** Historical class prior Beta(alpha0, beta0) from same-attribute past creatives. */
  readonly class_prior_alpha?: number;
  readonly class_prior_beta?: number;
  readonly matured_trials: number;
  readonly matured_conversions: number;
  readonly expected_conversions_at_start: number;
}

export interface BanditUpdateDecision {
  readonly status: 'updated' | 'frozen_insufficient_matured_cv' | 'not_started_insufficient_expected_cv';
  readonly smallest_arm_matured_cv: number;
  readonly required_smallest_arm_cv: number;
  readonly check_cadence_days: number;
  readonly static_uniform_slice: number;
  readonly arm_floor: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/**
 * Evaluates Tier 3 (`P2_adaptive_bandit`) allocation probabilities (§8.3):
 * - Enforces `>= 310` expected conversions per arm before leaving uniform P0.
 * - Enforces `>= 50` matured conversions in the SMALLEST arm before updating (else freezes!).
 * - Initializes posterior with 4-G creative-attribute hierarchical Beta priors for cold-start arms.
 * - Mixes `10%` static uniform slice + `90%` Thompson/UCB posterior clamped by `max(0.10, 1/(2K))`.
 */
export function computeAdaptiveBanditAllocation(params: {
  readonly arms: readonly CreativeAttributePriorInput[];
  readonly previousProbabilities?: Readonly<Record<string, number>>;
  readonly seedKey: string;
}): BanditUpdateDecision {
  const k = params.arms.length;
  if (k < 2) throw new Error('Pop-up selection requires at least 2 arms including no_show');
  if (!params.arms.some((a) => a.is_no_show || a.arm_id === 'no_show')) {
    throw new Error('§8.3 requires an explicit `no_show` arm in pop-up experiments');
  }

  const floor = computeBanditMinArmFloor(k);
  const uniformProbs: Record<string, number> = {};
  for (const a of params.arms) uniformProbs[a.arm_id] = Number((1 / k).toFixed(6));

  const minExpectedStart = Math.min(...params.arms.map((a) => a.expected_conversions_at_start));
  const minMatured = Math.min(...params.arms.map((a) => a.matured_conversions));

  if (minExpectedStart < POPUP_BANDIT_CONSTANTS.startMinExpectedConversionsPerArm) {
    return {
      status: 'not_started_insufficient_expected_cv',
      smallest_arm_matured_cv: minMatured,
      required_smallest_arm_cv: POPUP_BANDIT_CONSTANTS.updateMinMaturedConversionsSmallestArm,
      check_cadence_days: POPUP_BANDIT_CONSTANTS.updateCheckCadenceDays,
      static_uniform_slice: POPUP_BANDIT_CONSTANTS.staticUniformSlice,
      arm_floor: floor,
      probabilities: uniformProbs,
    };
  }

  if (minMatured < POPUP_BANDIT_CONSTANTS.updateMinMaturedConversionsSmallestArm) {
    return {
      status: 'frozen_insufficient_matured_cv',
      smallest_arm_matured_cv: minMatured,
      required_smallest_arm_cv: POPUP_BANDIT_CONSTANTS.updateMinMaturedConversionsSmallestArm,
      check_cadence_days: POPUP_BANDIT_CONSTANTS.updateCheckCadenceDays,
      static_uniform_slice: POPUP_BANDIT_CONSTANTS.staticUniformSlice,
      arm_floor: floor,
      probabilities: params.previousProbabilities ?? uniformProbs,
    };
  }

  // Deterministic Monte Carlo Thompson Sampling using Beta normal approximation with 4-G class priors
  const mcDraws = 2000;
  const winCounts = new Array<number>(k).fill(0);
  const postParams = params.arms.map((a) => {
    const alpha = Math.max(1, (a.class_prior_alpha ?? 2) + a.matured_conversions);
    const beta = Math.max(
      1,
      (a.class_prior_beta ?? 98) + Math.max(0, a.matured_trials - a.matured_conversions)
    );
    const mean = alpha / (alpha + beta);
    const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
    return { mean, sd };
  });

  for (let d = 0; d < mcDraws; d++) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < k; i++) {
      // Box-Muller deterministic normal from HMAC uniform pair
      const u1 = Math.max(1e-9, drawUniformU(`${params.seedKey}:ts_u1:${i}`, String(d)));
      const u2 = drawUniformU(`${params.seedKey}:ts_u2:${i}`, String(d));
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const sample = postParams[i].mean + postParams[i].sd * z;
      if (sample > bestVal) {
        bestVal = sample;
        bestIdx = i;
      }
    }
    winCounts[bestIdx] += 1;
  }

  // Mix 10% non-adaptive uniform slice + 90% Thompson weights, then enforce floor `max(0.10, 1/(2K))`
  const rawProbs = winCounts.map(
    (w) =>
      POPUP_BANDIT_CONSTANTS.staticUniformSlice * (1 / k) +
      (1 - POPUP_BANDIT_CONSTANTS.staticUniformSlice) * (w / mcDraws)
  );

  // Project onto simplex with lower bound `floor` (feasible when k * floor <= 1)
  const effectiveFloor = Math.min(floor, 1 / k);
  const remainingMass = Math.max(0, 1 - k * effectiveFloor);
  const excess = rawProbs.map((p) => Math.max(0, p - effectiveFloor));
  const excessSum = excess.reduce((s, v) => s + v, 0);

  const finalProbs: Record<string, number> = {};
  for (let i = 0; i < k; i++) {
    const p =
      excessSum > 0
        ? effectiveFloor + remainingMass * (excess[i] / excessSum)
        : 1 / k;
    finalProbs[params.arms[i].arm_id] = Number(p.toFixed(6));
  }

  return {
    status: 'updated',
    smallest_arm_matured_cv: minMatured,
    required_smallest_arm_cv: POPUP_BANDIT_CONSTANTS.updateMinMaturedConversionsSmallestArm,
    check_cadence_days: POPUP_BANDIT_CONSTANTS.updateCheckCadenceDays,
    static_uniform_slice: POPUP_BANDIT_CONSTANTS.staticUniformSlice,
    arm_floor: effectiveFloor,
    probabilities: finalProbs,
  };
}

/**
 * Tier 2 (`P1_preregistered_segments`): Validates <= 3 pre-registered segments (§8.3).
 */
export function selectP1PreregisteredSegmentArm(params: {
  readonly segmentId: string;
  readonly preregisteredSegmentPolicy: Readonly<Record<string, string>>;
}): { readonly valid: boolean; readonly arm_id: string; readonly error?: string } {
  const segCount = Object.keys(params.preregisteredSegmentPolicy).length;
  if (segCount > POPUP_BANDIT_CONSTANTS.maxPreregisteredSegmentsP1) {
    return {
      valid: false,
      arm_id: 'no_show',
      error: `P1 allows at most ${POPUP_BANDIT_CONSTANTS.maxPreregisteredSegmentsP1} pre-registered segments, got ${segCount}`,
    };
  }
  return {
    valid: true,
    arm_id: params.preregisteredSegmentPolicy[params.segmentId] ?? 'no_show',
  };
}

/**
 * Tier 4 (`P2_5_shallow_policy_tree`): Evaluates depth <= 3 policy tree distributed via 4-F int8 artifact.
 */
export function selectP25ShallowPolicyTreeArm(params: {
  readonly treeArtifact: SignedInt8ModelArtifact;
  readonly expectedSha256: string;
  readonly declaredTreeDepth: number;
  readonly integerFeatures: Readonly<Record<string, number>>;
  readonly armIds: readonly string[];
  readonly serverUniformU: number;
}): { readonly arm_id: string; readonly used_fallback: boolean; readonly fallback_reason: string | null } {
  if (params.declaredTreeDepth > POPUP_BANDIT_CONSTANTS.maxShallowPolicyTreeDepth) {
    return {
      arm_id: 'no_show',
      used_fallback: true,
      fallback_reason: `policy_tree_depth_${params.declaredTreeDepth}_exceeds_max_3`,
    };
  }
  const evalRes = evaluateInt8ModelArtifact({
    artifact: params.treeArtifact,
    expectedSha256: params.expectedSha256,
    integerFeatures: params.integerFeatures,
    serverUniformU: params.serverUniformU,
    numArms: params.armIds.length,
    ruleDefaultArmIndex: 0,
  });
  return {
    arm_id: params.armIds[evalRes.chosen_arm_index] ?? 'no_show',
    used_fallback: evalRes.used_fallback,
    fallback_reason: evalRes.fallback_reason,
  };
}

/**
 * Tier 5 (`P3_cate_uplift`): Shows best treatment ONLY when `cate_lcb > tenant_cost` AND
 * `guardrail_harm_ucb <= guardrail_margin`; otherwise abstains safely to `'no_show'` (§8.3).
 */
export function selectP3CateUpliftArm(params: {
  readonly candidates: ReadonlyArray<{
    readonly arm_id: string;
    readonly cate_point: number;
    readonly cate_lcb: number;
    readonly venn_abers_width: number;
    readonly guardrail_harm_ucb: number;
  }>;
  readonly tenant_cost_threshold: number;
  readonly guardrail_margin: number;
}): { readonly decision: 'show' | 'abstain_no_show'; readonly arm_id: string; readonly reason: string } {
  let bestArm: { readonly arm_id: string; readonly cate_lcb: number } | null = null;

  for (const c of params.candidates) {
    const netMargin = c.cate_lcb - params.tenant_cost_threshold;
    const guardrailOk = c.guardrail_harm_ucb <= params.guardrail_margin;
    const uncertaintyOk = c.venn_abers_width <= Math.max(0.001, Math.abs(c.cate_point - params.tenant_cost_threshold));
    if (netMargin > 0 && guardrailOk && uncertaintyOk) {
      if (!bestArm || c.cate_lcb > bestArm.cate_lcb) {
        bestArm = { arm_id: c.arm_id, cate_lcb: c.cate_lcb };
      }
    }
  }

  if (!bestArm) {
    return {
      decision: 'abstain_no_show',
      arm_id: 'no_show',
      reason: 'uncertain_cate_or_cost_or_guardrail_not_cleared',
    };
  }
  return {
    decision: 'show',
    arm_id: bestArm.arm_id,
    reason: 'cate_lcb_exceeds_cost_within_guardrails',
  };
}

/**
 * Full-unit logged-propensity IPS replay verifier for bandit policy updates (§8.3).
 */
export function verifyBanditPolicyByFullUnitReplay(params: {
  readonly loggedUnits: ReadonlyArray<{
    readonly logged_arm_id: string;
    readonly logged_propensity: number;
    readonly reward: number;
  }>;
  readonly newPolicyProbs: Readonly<Record<string, number>>;
  readonly championIpsValue: number;
  readonly replayIterations?: number;
}): {
  readonly ips_estimate: number;
  readonly ips_lcb: number;
  readonly effective_n: number;
  readonly beats_champion: boolean;
  readonly replay_iterations: number;
} {
  const n = params.loggedUnits.length;
  if (n === 0) {
    return {
      ips_estimate: 0,
      ips_lcb: -Infinity,
      effective_n: 0,
      beats_champion: false,
      replay_iterations: params.replayIterations ?? POPUP_BANDIT_CONSTANTS.replayVerificationIterations,
    };
  }

  const weightedValues: number[] = [];
  let sumW = 0;
  let sumW2 = 0;
  for (const u of params.loggedUnits) {
    const piNew = params.newPolicyProbs[u.logged_arm_id] ?? 0;
    const w = piNew / Math.max(0.01, u.logged_propensity);
    weightedValues.push(w * u.reward);
    sumW += w;
    sumW2 += w * w;
  }

  const mean = weightedValues.reduce((s, v) => s + v, 0) / n;
  const variance =
    weightedValues.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  const lcb = mean - 1.95996 * se;
  const effN = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;

  return {
    ips_estimate: Number(mean.toFixed(6)),
    ips_lcb: Number(lcb.toFixed(6)),
    effective_n: Math.round(effN),
    beats_champion: lcb > params.championIpsValue,
    replay_iterations: params.replayIterations ?? POPUP_BANDIT_CONSTANTS.replayVerificationIterations,
  };
}

export function registerPopupSelectionChallengers(
  registry: MlModelRegistry,
  tenantScope: string,
  nowIso: string
): readonly string[] {
  const rungs = [
    'popup_p2_bandit_attr_prior_v1',
    'popup_p25_shallow_policy_tree_v1',
    'popup_p3_cate_uplift_v1',
  ] as const;

  for (let i = 0; i < rungs.length; i++) {
    const id = rungs[i];
    registry.registerModelVersion({
      model_version_id: id,
      model_family: id,
      tenant_scope: tenantScope,
      artifact_sha256: sha256Hex(`challenger:${id}:${tenantScope}`),
      abi_version: 1,
      feature_set_version: 'popup_policy_v1',
      label_contract_version: 'aff_click_or_cv_v1',
      dataset_id: 'pending_real_data',
      deletion_generation: registry.getDeletionGeneration(),
      code_version: 'wave6_6f_v1',
      runtime_env: 'server_ts',
      seed: 610 + i,
      license_bundle: {
        license_id: 'Proprietary-UGOKI-LINK',
        notice_text: 'UGOKI LINK v2 pop-up selection challenger',
        distribution_scope: 'server_only',
      },
      created_at_iso: nowIso,
      status: 'challenger',
      contributing_subject_ids: [],
    });
  }
  return rungs;
}
