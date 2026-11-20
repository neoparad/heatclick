/**
 * UGOKI LINK v2 — Single Actor-Blind Allocator & SRM Integrity Evaluator
 *
 * Implements §4.8, §9.1–§9.2, §9.8, D-3, D-17, D-20, EV M1–M2 / G-1:
 * - Deterministic HMAC-SHA256 draws (`u = HMAC-SHA256(key, unit_id)[0..4] / 2^32`)
 * - Strict structural + runtime actor-blind guard (forbids UA/IP/actor_class/is_agent)
 * - Evaluation order:
 *   1. Actor-blind assertion
 *   2. Consent T0 (`off`) -> default, zero decision rows
 *   3. Over-quota unit sampling -> moves unit to `over_quota_stub` before assignment
 *   4. Permanent A/A Canary Layer (50/50)
 *   5. Measurement Comparison Layer (Stage A dual run / Stage B SDK weight test with
 *      fullSplitMode / Stage C steady state)
 *   6. 4 independent Holdout Bits (`global`, `overlay`, `patch`, `recs` — 26-week epoch)
 *   7. Per-layer exclusive slot experiment selection + arm draw (factorial overlap across layers)
 * - SRM & Integrity evaluator (`pass | fail | unverified` with Chi-Square p-value + ε_tol CI)
 */

import { consentModeToTier, type UnitKind } from '../../../packages/contract/schema';
import { deriveDecisionId, drawUniformU } from './hmac';
import type {
  AllocationInput,
  AllocationOutcome,
  AllocatorConfig,
  AllocatorDecisionRecord,
  AllocatorExperiment,
  HoldoutBitsConfig,
  HoldoutBitsEvaluation,
  MeasurementArmAssignment,
  MeasurementLayerConfig,
} from './types';

const FORBIDDEN_ACTOR_KEYS: ReadonlySet<string> = new Set([
  'user_agent',
  'userAgent',
  'ua',
  'ip',
  'client_ip',
  'clientIp',
  'remote_addr',
  'actor_class',
  'actorClass',
  'actor_kind',
  'actorKind',
  'is_agent',
  'isAgent',
  'is_bot',
  'isBot',
  'automation_flags',
  'automationFlags',
]);

export class ActorBlindViolationError extends Error {
  public readonly forbiddenKeys: readonly string[];

  constructor(forbiddenKeys: readonly string[]) {
    super(
      `Actor-blind Allocator violation (§9.1 / EV M1): forbidden actor/identity keys passed to allocation input: ${forbiddenKeys.join(', ')}`
    );
    this.name = 'ActorBlindViolationError';
    this.forbiddenKeys = forbiddenKeys;
  }
}

/**
 * Runtime guard enforcing §9.1 / EV M1: UA, IP, actor_class, and automation flags
 * MUST NEVER enter the Allocator (prevents search engine cloaking and bias).
 */
export function assertActorBlindInput(input: unknown): asserts input is AllocationInput {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('AllocationInput must be a non-null object');
  }
  const found: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_ACTOR_KEYS.has(k) && v !== undefined) {
      found.push(k);
    }
  }
  if (found.length > 0) {
    throw new ActorBlindViolationError(found);
  }
}

const MS_PER_WEEK = 7 * 86_400_000;

/**
 * Computes deterministic 26-week holdout rotation epoch index (§9.1 / §9.8).
 */
export function computeHoldoutEpoch(
  nowMs: number,
  epochOriginMs: number,
  epochWeeks = 26
): number {
  const epochDurationMs = epochWeeks * MS_PER_WEEK;
  if (nowMs <= epochOriginMs) return 0;
  return Math.floor((nowMs - epochOriginMs) / epochDurationMs);
}

/**
 * Evaluates the 4 independent holdout bits (`global`, `overlay`, `patch`, `recs`)
 * using distinct HMAC keys per bit and 26-week epoch (§9.1 / EV M1).
 */
export function evaluateHoldoutBits(
  secret: string,
  tenantId: string,
  siteId: string,
  unitId: string,
  nowMs: number,
  config: HoldoutBitsConfig
): HoldoutBitsEvaluation {
  const epochId = computeHoldoutEpoch(nowMs, config.epochOriginMs, config.epochWeeks);

  const drawBit = (bitName: 'global' | 'overlay' | 'patch' | 'recs', share: number): boolean => {
    if (share <= 0) return false;
    if (share >= 1) return true;
    const key = `${secret}:holdout:${tenantId}:${siteId}:${bitName}:ep${epochId}`;
    return drawUniformU(key, unitId) < share;
  };

  const global = drawBit('global', config.global);
  const overlay = drawBit('overlay', config.overlay);
  const patch = drawBit('patch', config.patch);
  const recs = drawBit('recs', config.recs);

  const bitmask =
    (global ? 1 : 0) | (overlay ? 2 : 0) | (patch ? 4 : 0) | (recs ? 8 : 0);

  return {
    global,
    overlay,
    patch,
    recs,
    epoch_id: epochId,
    any_held_out: bitmask !== 0,
    bitmask,
  };
}

function resolveUnitForConsent(
  input: AllocationInput,
  preferred: UnitKind,
  allowFallback: boolean
): { readonly unit_kind: UnitKind; readonly unit_id: string } | null {
  const tier = consentModeToTier(input.consent_mode);
  if (tier === 'T0') return null;

  const isAllowedInTier = (kind: UnitKind): boolean => {
    if (tier === 'T1') {
      // cookieless: NO visitor or session units (D-3 / §4.5)
      return kind !== 'visitor' && kind !== 'session';
    }
    // session mode allows session/page_view/etc., not persistent visitor unless stats_exempt/full
    if (input.consent_mode === 'session' && kind === 'visitor') {
      return false;
    }
    return true;
  };

  const getId = (kind: UnitKind): string | undefined => input.available_units[kind];

  if (isAllowedInTier(preferred)) {
    const id = getId(preferred);
    if (id) return { unit_kind: preferred, unit_id: id };
  }

  if (!allowFallback) {
    return null;
  }

  // Fallback ladder: visitor -> session -> page_view (EV M1 / D-3)
  const fallbackOrder: readonly UnitKind[] = ['visitor', 'session', 'page_view'];
  for (const candidate of fallbackOrder) {
    if (isAllowedInTier(candidate)) {
      const id = getId(candidate);
      if (id) return { unit_kind: candidate, unit_id: id };
    }
  }
  return null;
}

function drawMeasurementArm(
  secret: string,
  tenantId: string,
  siteId: string,
  pvId: string,
  cfg: MeasurementLayerConfig
): { readonly arm: MeasurementArmAssignment; readonly propensity: number; readonly deliveryPermitted: boolean } {
  const key = `${secret}:measurement:${tenantId}:${siteId}:${cfg.stage}`;
  const u = drawUniformU(key, pvId);

  if (cfg.stage === 'stage_a_dual_run') {
    if (u < 1 / 3) return { arm: 'v2', propensity: 1 / 3, deliveryPermitted: false };
    if (u < 2 / 3) return { arm: 'v3', propensity: 1 / 3, deliveryPermitted: false };
    return { arm: 'both', propensity: 1 / 3, deliveryPermitted: false };
  }

  if (cfg.stage === 'stage_b_weight_test') {
    if (u < 1 / 3) return { arm: 'stub', propensity: 1 / 3, deliveryPermitted: false };
    if (u < 2 / 3) return { arm: 'lite', propensity: 1 / 3, deliveryPermitted: false };
    if (cfg.fullSplitMode === 'all_verify_only') {
      return { arm: 'full_verify_only', propensity: 1 / 3, deliveryPermitted: false };
    }
    // 判断 2 (推奨): full arm split 50/50 -> 1/6 verify_only, 1/6 deliver_eligible
    if (u < 5 / 6) {
      return { arm: 'full_verify_only', propensity: 1 / 6, deliveryPermitted: false };
    }
    return { arm: 'full_deliver_eligible', propensity: 1 / 6, deliveryPermitted: true };
  }

  // Stage C steady state
  const stubShare = cfg.steadyStubShare ?? 0.05;
  const auditShare = cfg.steadyAuditShare ?? 0.13;
  if (u < stubShare) {
    return { arm: 'stub', propensity: stubShare, deliveryPermitted: false };
  }
  if (u < stubShare + auditShare) {
    return { arm: 'audit', propensity: auditShare, deliveryPermitted: true };
  }
  return {
    arm: 'full_deliver_eligible',
    propensity: Math.max(0, 1 - stubShare - auditShare),
    deliveryPermitted: true,
  };
}

function selectArmByWeight(
  exp: AllocatorExperiment,
  u: number
): { readonly arm_id: string; readonly propensity: number } {
  const totalWeight = exp.arms.reduce((acc, a) => acc + a.weight, 0);
  if (totalWeight <= 0 || exp.arms.length === 0) {
    return { arm_id: 'control', propensity: 1 };
  }
  let cum = 0;
  for (const arm of exp.arms) {
    const p = arm.weight / totalWeight;
    cum += p;
    if (u < cum) {
      return { arm_id: arm.arm_id, propensity: p };
    }
  }
  const last = exp.arms[exp.arms.length - 1];
  return { arm_id: last.arm_id, propensity: last.weight / totalWeight };
}

/**
 * The single authoritative Allocator function (§9.1 / EV M1 / D-3 / D-17 / D-20).
 */
export function allocateDecision(
  input: AllocationInput,
  config: AllocatorConfig
): AllocationOutcome {
  assertActorBlindInput(input);

  const consentTier = consentModeToTier(input.consent_mode);
  const emptyHoldout: HoldoutBitsEvaluation = {
    global: false,
    overlay: false,
    patch: false,
    recs: false,
    epoch_id: computeHoldoutEpoch(
      input.now_ms,
      config.holdout.epochOriginMs,
      config.holdout.epochWeeks
    ),
    any_held_out: false,
    bitmask: 0,
  };

  // Consent T0 (`off`): default experience, ZERO decision rows (D-13 / EV M1)
  if (consentTier === 'T0') {
    return {
      consent_tier: 'T0',
      over_quota_sampled_out: false,
      holdout: emptyHoldout,
      canary_arm: 'none',
      measurement_arm: 'off',
      delivery_permitted: false,
      decisions: [],
    };
  }

  // Resolve primary subject unit for holdouts & over-quota sampling (visitor -> session -> page_view)
  const primaryUnit =
    resolveUnitForConsent(input, 'visitor', true) ?? {
      unit_kind: 'page_view' as const,
      unit_id: input.available_units.page_view,
    };

  // Over-quota unit sampling precedes assignment (D-3 / §11.8)
  if (
    input.over_quota_sampling_rate !== undefined &&
    input.over_quota_sampling_rate < 1
  ) {
    const sampleU = drawUniformU(
      `${config.hmacSecret}:over_quota:${input.tenant_id}:${input.site_id}`,
      primaryUnit.unit_id
    );
    if (sampleU >= input.over_quota_sampling_rate) {
      return {
        consent_tier: consentTier,
        over_quota_sampled_out: true,
        holdout: emptyHoldout,
        canary_arm: 'none',
        measurement_arm: 'over_quota_stub',
        delivery_permitted: false,
        decisions: [],
      };
    }
  }

  const decisions: AllocatorDecisionRecord[] = [];
  let decisionNo = 0;

  // 1. Evaluate 4 independent holdout bits (26-week epoch)
  const holdout = evaluateHoldoutBits(
    config.hmacSecret,
    input.tenant_id,
    input.site_id,
    primaryUnit.unit_id,
    input.now_ms,
    config.holdout
  );

  // 2. Permanent A/A Canary Layer (always 50/50, EV M1 / G-1)
  const canaryU = drawUniformU(
    `${config.hmacSecret}:canary:aa_permanent:${input.tenant_id}:${input.site_id}`,
    primaryUnit.unit_id
  );
  const canaryArm: 'aa_control_a' | 'aa_control_b' = canaryU < 0.5 ? 'aa_control_a' : 'aa_control_b';
  decisionNo += 1;
  decisions.push({
    decision_id: deriveDecisionId(
      config.hmacSecret,
      input.tenant_id,
      input.site_id,
      input.pv_id,
      'canary:aa_permanent',
      decisionNo
    ),
    layer_id: 'canary:aa_permanent',
    experiment_id: 'aa_canary_permanent',
    arm_id: canaryArm,
    unit_id: primaryUnit.unit_id,
    unit_kind: primaryUnit.unit_kind,
    identity_quality: input.identity_quality,
    consent_tier: consentTier,
    consent_mode: input.consent_mode,
    purposes: input.purposes,
    holdout_bits: holdout.bitmask,
    propensity: 0.5,
    policy_version: 'canary_v1',
    alloc_epoch: holdout.epoch_id,
    prereg_hash: 'aa_canary_fixed_50_50',
    traffic_class: input.traffic_class,
    pv_id: input.pv_id,
    decision_no: decisionNo,
    eligible: true,
    stateless_policy: 'randomise',
  });

  // 3. Measurement comparison layer (Stage A / B / C, D-20)
  const measDraw = drawMeasurementArm(
    config.hmacSecret,
    input.tenant_id,
    input.site_id,
    input.pv_id,
    config.measurement
  );
  decisionNo += 1;
  decisions.push({
    decision_id: deriveDecisionId(
      config.hmacSecret,
      input.tenant_id,
      input.site_id,
      input.pv_id,
      `measurement:${config.measurement.stage}`,
      decisionNo
    ),
    layer_id: `measurement:${config.measurement.stage}`,
    experiment_id: `measurement_${config.measurement.stage}`,
    arm_id: measDraw.arm,
    unit_id: input.pv_id,
    unit_kind: 'page_view',
    identity_quality: input.identity_quality,
    consent_tier: consentTier,
    consent_mode: input.consent_mode,
    purposes: input.purposes,
    holdout_bits: holdout.bitmask,
    propensity: measDraw.propensity,
    policy_version: `meas_${config.measurement.fullSplitMode}`,
    alloc_epoch: 1,
    prereg_hash: `prereg_${config.measurement.stage}`,
    traffic_class: input.traffic_class,
    pv_id: input.pv_id,
    decision_no: decisionNo,
    eligible: true,
    stateless_policy: 'randomise',
  });

  // 4. Experiment layers (independent keys per layer -> factorial overlap; exclusive slots inside one layer)
  for (const layer of config.layers) {
    if (layer.experiments.length === 0) continue;

    // Exclusive slot draw inside this layer using layer's independent salt
    const layerSlotKey = `${config.hmacSecret}:layer_slot:${input.tenant_id}:${input.site_id}:${layer.layer_id}:${layer.salt}`;
    const slotU = drawUniformU(layerSlotKey, primaryUnit.unit_id);

    let slotCum = 0;
    let selectedExp: AllocatorExperiment | null = null;
    for (const exp of layer.experiments) {
      slotCum += exp.slot_share;
      if (slotU < slotCum) {
        selectedExp = exp;
        break;
      }
    }
    if (!selectedExp) continue;

    // Check consent & unit eligibility for the chosen experiment
    const unitResolved = resolveUnitForConsent(
      input,
      selectedExp.preferred_unit_kind,
      selectedExp.allow_unit_fallback
    );

    const missingPersonalise =
      selectedExp.requires_personalise_purpose === true &&
      !input.purposes.includes('personalise');

    const statelessDefaultOnly =
      selectedExp.stateless_policy === 'default_only' && input.identity_quality === 'C';

    const predicateEligible = selectedExp.isEligible ? selectedExp.isEligible(input) : true;

    decisionNo += 1;
    const decId = deriveDecisionId(
      config.hmacSecret,
      input.tenant_id,
      input.site_id,
      input.pv_id,
      layer.layer_id,
      decisionNo
    );

    // If unit/consent/personalise/stateless gate fails, serve default control and log reason
    if (!unitResolved || missingPersonalise || statelessDefaultOnly || !predicateEligible) {
      const reason = !unitResolved
        ? 'suppressed_consent_unit'
        : missingPersonalise
          ? 'suppressed_personalise_purpose'
          : statelessDefaultOnly
            ? 'suppressed_stateless_default_only'
            : 'ineligible_predicate';

      decisions.push({
        decision_id: decId,
        layer_id: layer.layer_id,
        experiment_id: selectedExp.experiment_id,
        arm_id: 'control',
        unit_id: unitResolved?.unit_id ?? input.available_units.page_view,
        unit_kind: unitResolved?.unit_kind ?? 'page_view',
        identity_quality: input.identity_quality,
        consent_tier: consentTier,
        consent_mode: input.consent_mode,
        purposes: input.purposes,
        holdout_bits: holdout.bitmask,
        propensity: 1,
        policy_version: selectedExp.policy_version,
        alloc_epoch: selectedExp.alloc_epoch,
        prereg_hash: selectedExp.prereg_hash,
        traffic_class: input.traffic_class,
        pv_id: input.pv_id,
        decision_no: decisionNo,
        eligible: false,
        suppressed_reason: reason,
        stateless_policy: selectedExp.stateless_policy,
      });
      continue;
    }

    // Holdout bit check: global OR mechanism-specific bit (`overlay` | `patch` | `recs`)
    const mechanismHeldOut = holdout.global || holdout[layer.mechanism];
    if (mechanismHeldOut) {
      const holdoutShare =
        1 - (1 - config.holdout.global) * (1 - config.holdout[layer.mechanism]);
      decisions.push({
        decision_id: decId,
        layer_id: layer.layer_id,
        experiment_id: selectedExp.experiment_id,
        arm_id: 'holdout',
        unit_id: unitResolved.unit_id,
        unit_kind: unitResolved.unit_kind,
        identity_quality: input.identity_quality,
        consent_tier: consentTier,
        consent_mode: input.consent_mode,
        purposes: input.purposes,
        holdout_bits: holdout.bitmask,
        propensity: holdoutShare,
        policy_version: selectedExp.policy_version,
        alloc_epoch: selectedExp.alloc_epoch,
        prereg_hash: selectedExp.prereg_hash,
        traffic_class: input.traffic_class,
        pv_id: input.pv_id,
        decision_no: decisionNo,
        eligible: true,
        suppressed_reason: 'holdout',
        stateless_policy: selectedExp.stateless_policy,
      });
      continue;
    }

    // Measurement arm check: during Stage A / Stage B non-delivery arms, log shadow only
    if (!measDraw.deliveryPermitted) {
      decisions.push({
        decision_id: decId,
        layer_id: layer.layer_id,
        experiment_id: selectedExp.experiment_id,
        arm_id: 'a0_shadow',
        unit_id: unitResolved.unit_id,
        unit_kind: unitResolved.unit_kind,
        identity_quality: input.identity_quality,
        consent_tier: consentTier,
        consent_mode: input.consent_mode,
        purposes: input.purposes,
        holdout_bits: holdout.bitmask,
        propensity: 1,
        policy_version: selectedExp.policy_version,
        alloc_epoch: selectedExp.alloc_epoch,
        prereg_hash: selectedExp.prereg_hash,
        traffic_class: input.traffic_class,
        pv_id: input.pv_id,
        decision_no: decisionNo,
        eligible: true,
        suppressed_reason: `measurement_arm_${measDraw.arm}`,
        stateless_policy: selectedExp.stateless_policy,
      });
      continue;
    }

    // Draw experiment arm using layer + experiment independent HMAC key
    const expKey = `${config.hmacSecret}:exp:${input.tenant_id}:${input.site_id}:${layer.layer_id}:${selectedExp.experiment_id}:${selectedExp.policy_version}:${selectedExp.alloc_epoch}`;
    const armU = drawUniformU(expKey, unitResolved.unit_id);
    const chosen = selectArmByWeight(selectedExp, armU);

    decisions.push({
      decision_id: decId,
      layer_id: layer.layer_id,
      experiment_id: selectedExp.experiment_id,
      arm_id: chosen.arm_id,
      unit_id: unitResolved.unit_id,
      unit_kind: unitResolved.unit_kind,
      identity_quality: input.identity_quality,
      consent_tier: consentTier,
      consent_mode: input.consent_mode,
      purposes: input.purposes,
      holdout_bits: holdout.bitmask,
      propensity: chosen.propensity,
      policy_version: selectedExp.policy_version,
      alloc_epoch: selectedExp.alloc_epoch,
      prereg_hash: selectedExp.prereg_hash,
      traffic_class: input.traffic_class,
      pv_id: input.pv_id,
      decision_no: decisionNo,
      eligible: true,
      stateless_policy: selectedExp.stateless_policy,
    });
  }

  return {
    consent_tier: consentTier,
    over_quota_sampled_out: false,
    holdout,
    canary_arm: canaryArm,
    measurement_arm: measDraw.arm,
    delivery_permitted: measDraw.deliveryPermitted,
    decisions,
  };
}

// =========================================================================
// SRM & Integrity Evaluator (EV M2 / G-1)
// =========================================================================

function logGamma(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zm = z - 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) {
    x += p[i] / (zm + i);
  }
  const t = zm + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zm + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Upper regularized incomplete gamma Q(a, x) for exact Chi-Square survival p-value. */
function upperIncompleteGammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {
    // Series representation for P(a, x), return 1 - P
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 200; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    const pVal = sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    return Math.max(0, Math.min(1, 1 - pVal));
  }
  // Lentz continued fraction for Q(a, x)
  let b = x + 1 - a;
  let c = 1 / 1e-30;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = b + an / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.max(0, Math.min(1, Math.exp(-x + a * Math.log(x) - logGamma(a)) * h));
}

export function chiSquareSurvivalPValue(chiSquare: number, df: number): number {
  if (df <= 0 || chiSquare <= 0) return 1;
  return upperIncompleteGammaQ(df / 2, chiSquare / 2);
}

export interface SrmIntegrityResult {
  readonly status: 'pass' | 'fail' | 'unverified';
  readonly total_n: number;
  readonly chi_square: number;
  readonly df: number;
  readonly p_value: number;
  readonly epsilon_tol: number;
  readonly max_abs_imbalance: number;
  readonly max_ci999_bound: number;
}

/**
 * Evaluates Sample Ratio Mismatch (SRM) using BOTH exact Chi-Square p-value AND
 * EV M2 / G-1 tolerance scale `ε_tol = (MDE / 4) / max(1, κ - 1)` with 99.9% CI.
 */
export function evaluateSrmIntegrity(
  observedCounts: Readonly<Record<string, number>>,
  expectedWeights: Readonly<Record<string, number>>,
  options?: {
    readonly mde?: number; // default 0.20
    readonly kappa?: number; // default 3 (EV G-1)
  }
): SrmIntegrityResult {
  const mde = options?.mde ?? 0.2;
  const kappa = options?.kappa ?? 3;
  const epsilonTol = (mde / 4) / Math.max(1, kappa - 1); // 0.025 at MDE=20%, κ=3

  const arms = Object.keys(expectedWeights);
  const weightSum = arms.reduce((s, a) => s + expectedWeights[a], 0);
  const totalN = arms.reduce((s, a) => s + (observedCounts[a] ?? 0), 0);

  if (arms.length < 2 || weightSum <= 0 || totalN === 0) {
    return {
      status: 'unverified',
      total_n: totalN,
      chi_square: 0,
      df: Math.max(0, arms.length - 1),
      p_value: 1,
      epsilon_tol: epsilonTol,
      max_abs_imbalance: 0,
      max_ci999_bound: 1,
    };
  }

  let chiSquare = 0;
  let maxAbsImbalance = 0;
  let maxCi999Bound = 0;
  let anyFail = false;
  let allInsideTol = true;

  const z999 = 3.290527;

  for (const arm of arms) {
    const w = expectedWeights[arm] / weightSum;
    const obs = observedCounts[arm] ?? 0;
    const exp = totalN * w;
    if (exp > 0) {
      chiSquare += ((obs - exp) * (obs - exp)) / exp;
    }

    const pHat = obs / totalN;
    const diff = pHat - w;
    const absDiff = Math.abs(diff);
    const se = Math.sqrt(Math.max(1e-12, (pHat * (1 - pHat)) / totalN));
    const ciLo = diff - z999 * se;
    const ciHi = diff + z999 * se;
    const worstBound = Math.max(Math.abs(ciLo), Math.abs(ciHi));

    if (absDiff > maxAbsImbalance) maxAbsImbalance = absDiff;
    if (worstBound > maxCi999Bound) maxCi999Bound = worstBound;

    const ciExcludesZero = ciLo > 0 || ciHi < 0;
    if (ciExcludesZero && absDiff > epsilonTol / 4) {
      anyFail = true;
    }
    if (worstBound > epsilonTol) {
      allInsideTol = false;
    }
  }

  const df = arms.length - 1;
  const pValue = chiSquareSurvivalPValue(chiSquare, df);

  const status: 'pass' | 'fail' | 'unverified' = anyFail
    ? 'fail'
    : allInsideTol
      ? 'pass'
      : 'unverified';

  return {
    status,
    total_n: totalN,
    chi_square: chiSquare,
    df,
    p_value: pValue,
    epsilon_tol: epsilonTol,
    max_abs_imbalance: maxAbsImbalance,
    max_ci999_bound: maxCi999Bound,
  };
}
