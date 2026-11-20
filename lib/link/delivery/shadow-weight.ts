/**
 * UGOKI LINK v2 — Bundle 5-A: A0 Shadow Delivery, Sealed Triggering,
 * Decision Record Completeness (`ev.G-3`), and SDK Weight Equivalence Testing (`tel.G16` / §4.8 / §10.5)
 */

import { CONSTANTS_LEDGER } from '@/packages/contract/ledgers';
import { sha256Hex } from '@/packages/contract/response';
import type { AllocatorDecisionRecord } from '@/lib/link/allocator';

// =========================================================================
// 1. A0 Shadow Delivery & Sealed Triggering (§9.2, §10.3)
// =========================================================================

export interface TriggerExposureEvent {
  readonly eventKind: 'trigger';
  readonly decisionId: string;
  readonly experimentId: string;
  readonly pvId: string;
  readonly unitId: string;
  readonly triggeredAtMs: number;
  readonly triggerDigest: string;
  /** Sealed triggering guarantees trigger log is identical before opening arm! */
  readonly sealedBeforeArmInspection: true;
  /** A0 shadow guarantees zero DOM mutations on the host page. */
  readonly domWritesPerformed: 0;
}

export interface SealedTriggerOutcome {
  readonly triggered: boolean;
  readonly exposureRecord: TriggerExposureEvent | null;
  readonly openedArmId: string | null;
  readonly renderMode: 'a0_shadow_no_write' | 'control_no_write' | 'holdout_no_write' | 'deliver_variant';
  readonly domWrites: 0;
}

/**
 * Evaluates a trigger predicate strictly BEFORE inspecting which arm or holdout
 * the visitor received ("Sealed Triggering", §9.2).
 * Produces byte-identical trigger records across control, holdout, and A0 shadow arms.
 */
export function evaluateSealedTrigger(params: {
  readonly decision: Pick<
    AllocatorDecisionRecord,
    'decision_id' | 'experiment_id' | 'pv_id' | 'unit_id' | 'arm_id' | 'holdout_bits'
  >;
  readonly expressionTier: 'A0' | 'A1' | 'A1c' | 'A2' | 'A3';
  /** Arm-blind pure predicate returning true iff trigger fires. */
  readonly evaluateTriggerArmBlind: () => boolean;
  readonly exposureQueue: TriggerExposureEvent[];
  readonly nowMs: number;
}): SealedTriggerOutcome {
  // Step 1: Evaluate trigger condition strictly WITHOUT reading `decision.arm_id` or `holdout_bits`
  const fired = params.evaluateTriggerArmBlind();
  if (!fired) {
    return {
      triggered: false,
      exposureRecord: null,
      openedArmId: null,
      renderMode: 'a0_shadow_no_write',
      domWrites: 0,
    };
  }

  // Step 2: Enqueue arm-agnostic `trigger` exposure record BEFORE opening arm
  const record: TriggerExposureEvent = {
    eventKind: 'trigger',
    decisionId: params.decision.decision_id,
    experimentId: params.decision.experiment_id,
    pvId: params.decision.pv_id,
    unitId: params.decision.unit_id,
    triggeredAtMs: params.nowMs,
    triggerDigest: sha256Hex(
      `${params.decision.decision_id}:${params.decision.experiment_id}:${params.decision.unit_id}`
    ),
    sealedBeforeArmInspection: true,
    domWritesPerformed: 0,
  };
  params.exposureQueue.push(record);

  // Step 3: Only AFTER logging exposure, open the assigned arm & holdout state
  if (params.decision.holdout_bits !== 0) {
    return {
      triggered: true,
      exposureRecord: record,
      openedArmId: params.decision.arm_id,
      renderMode: 'holdout_no_write',
      domWrites: 0,
    };
  }
  if (params.expressionTier === 'A0') {
    return {
      triggered: true,
      exposureRecord: record,
      openedArmId: params.decision.arm_id,
      renderMode: 'a0_shadow_no_write',
      domWrites: 0,
    };
  }
  if (params.decision.arm_id === 'control') {
    return {
      triggered: true,
      exposureRecord: record,
      openedArmId: 'control',
      renderMode: 'control_no_write',
      domWrites: 0,
    };
  }
  return {
    triggered: true,
    exposureRecord: record,
    openedArmId: params.decision.arm_id,
    renderMode: 'deliver_variant',
    domWrites: 0,
  };
}

// =========================================================================
// 2. Decision Record Completeness Gate (`ev.G-3`, §9.2)
// =========================================================================

export interface DecisionCompletenessInput {
  readonly totalDecisionsLogged: number;
  readonly matchedExposures: number;
  readonly recomputeCheckedRows: number;
  readonly recomputeExactMatches: number;
  /** Observed treatment share minus expected treatment share (e.g. 0.502 - 0.500 = +0.002). */
  readonly observedAllocationBias: number;
  /** Target MDE (absolute rate difference) used to bound acceptable bias at <= 1/4 * targetMde. */
  readonly targetAbsoluteMde: number;
}

export interface DecisionCompletenessReport {
  readonly gateId: 'ev.G-3';
  readonly exposureJoinRate: number;
  readonly recomputeParityRate: number;
  readonly allocationBiasAbs: number;
  readonly allocationBiasTolerance: number;
  readonly checks: {
    readonly exposureJoinGe98Pct: boolean;
    readonly recomputeParityGe99_5Pct: boolean;
    readonly biasWithinQuarterMde: boolean;
  };
  readonly passed: boolean;
}

export function evaluateDecisionCompleteness(
  input: DecisionCompletenessInput
): DecisionCompletenessReport {
  const exposureJoinRate =
    input.totalDecisionsLogged > 0 ? input.matchedExposures / input.totalDecisionsLogged : 0;
  const recomputeParityRate =
    input.recomputeCheckedRows > 0 ? input.recomputeExactMatches / input.recomputeCheckedRows : 0;
  const allocationBiasAbs = Math.abs(input.observedAllocationBias);
  // §9.2: Sample-size-independent estimate check — bias within 1/4 of target detectable effect
  const allocationBiasTolerance = Math.abs(input.targetAbsoluteMde) * 0.25;

  const checks = {
    exposureJoinGe98Pct: exposureJoinRate >= 0.98,
    recomputeParityGe99_5Pct: recomputeParityRate >= 0.995,
    biasWithinQuarterMde: allocationBiasAbs <= allocationBiasTolerance,
  };

  return {
    gateId: 'ev.G-3',
    exposureJoinRate,
    recomputeParityRate,
    allocationBiasAbs,
    allocationBiasTolerance,
    checks,
    passed:
      checks.exposureJoinGe98Pct &&
      checks.recomputeParityGe99_5Pct &&
      checks.biasWithinQuarterMde,
  };
}

// =========================================================================
// 3. SDK Weight TOST Equivalence Test & Resource Budgets (`tel.G16`, §4.8, §10.5)
// =========================================================================

export interface SdkArmTelemetryStats {
  readonly arm: 'stub' | 'lite' | 'full' | 'replay_arm';
  readonly inpBearingPvs: number;
  /** Share of PVs with INP > 200ms in [0, 1]. */
  readonly inpBadShare: number;
  /** LCP p75 in milliseconds and its standard error. */
  readonly lcpP75Ms: number;
  readonly lcpP75SeMs: number;
  /** CLS p95 score. */
  readonly clsP95: number;
  /** Bounce rate in [0, 1]. */
  readonly bounceRate: number;
  /** Business outbound click / conversion rate in [0, 1]. */
  readonly outboundClickRate: number;
}

export interface RuntimeBudgetMetrics {
  readonly snippetBytes: number;
  readonly deliveryCoreGzipBytes: number;
  readonly mainThreadP95Ms: number;
  readonly clsDeltaP95: number;
}

export interface SdkWeightEquivalenceReport {
  readonly gateId: 'tel.G16';
  readonly status: 'ok' | 'insufficient_data' | 'invalid';
  readonly requiredInpPvsPerArm: number;
  readonly minObservedInpPvsPerArm: number;
  readonly remainingInpPvsNeeded: number;
  readonly tostChecks: {
    readonly inpBadShareEquivalent: boolean;
    readonly lcpP75Equivalent: boolean;
    readonly clsWithin001: boolean;
    readonly bounceNonInferior: boolean;
    readonly outboundNonInferior: boolean;
  };
  readonly budgetChecks: {
    readonly snippetLe2Kb: boolean;
    readonly coreGzipLe14Kb: boolean;
    readonly mainThreadP95Le50Ms: boolean;
    readonly clsDeltaLe001: boolean;
  };
  readonly passed: boolean;
}

const Z_TOST_90_TWO_SIDED = 1.6448536269514722; // one-sided alpha = 0.05 for 90% TOST CI

function readConst(id: string, fallback: number): number {
  const found = CONSTANTS_LEDGER.find((c) => c.id === id);
  return found && typeof found.value === 'number' ? found.value : fallback;
}

/**
 * Evaluates SDK self-cost equivalence (TOST) comparing `full` (and optional `replay_arm`)
 * against `stub` baseline, plus hard §10.5 runtime budgets.
 */
export function evaluateSdkWeightEquivalence(params: {
  readonly stubArm: SdkArmTelemetryStats;
  readonly fullArm: SdkArmTelemetryStats;
  readonly liteArm?: SdkArmTelemetryStats;
  readonly replayArm?: SdkArmTelemetryStats;
  readonly budgets: RuntimeBudgetMetrics;
}): SdkWeightEquivalenceReport {
  const requiredN = readConst('tel.weight_test_inp_pvs_per_arm', 30000);
  const inpMargin = readConst('tel.inp_bad_share_margin_pt', 1.5) / 100; // 0.015
  const lcpMarginMs = readConst('tel.lcp_p75_margin_ms', 50);
  const clsMax = readConst('del.cls_p95_max', 0.01);

  const armsToCheck = [params.stubArm, params.fullArm];
  if (params.liteArm) armsToCheck.push(params.liteArm);
  if (params.replayArm) armsToCheck.push(params.replayArm);

  const minN = Math.min(...armsToCheck.map((a) => a.inpBearingPvs));
  const remaining = Math.max(0, requiredN - minN);

  const budgetChecks = {
    snippetLe2Kb: params.budgets.snippetBytes <= 2 * 1024,
    coreGzipLe14Kb: params.budgets.deliveryCoreGzipBytes <= 14 * 1024,
    mainThreadP95Le50Ms: params.budgets.mainThreadP95Ms <= 50,
    clsDeltaLe001: params.budgets.clsDeltaP95 <= clsMax,
  };

  if (minN < requiredN) {
    return {
      gateId: 'tel.G16',
      status: 'insufficient_data',
      requiredInpPvsPerArm: requiredN,
      minObservedInpPvsPerArm: minN,
      remainingInpPvsNeeded: remaining,
      tostChecks: {
        inpBadShareEquivalent: false,
        lcpP75Equivalent: false,
        clsWithin001: params.fullArm.clsP95 <= clsMax,
        bounceNonInferior: false,
        outboundNonInferior: false,
      },
      budgetChecks,
      passed: false,
    };
  }

  const checkPairAgainstStub = (treatment: SdkArmTelemetryStats) => {
    const stub = params.stubArm;
    // 1. INP > 200ms proportion difference 90% CI strictly inside [-inpMargin, +inpMargin]
    const diffInp = treatment.inpBadShare - stub.inpBadShare;
    const seInp = Math.sqrt(
      (treatment.inpBadShare * (1 - treatment.inpBadShare)) / treatment.inpBearingPvs +
        (stub.inpBadShare * (1 - stub.inpBadShare)) / stub.inpBearingPvs
    );
    const inpOk =
      diffInp - Z_TOST_90_TWO_SIDED * seInp >= -inpMargin &&
      diffInp + Z_TOST_90_TWO_SIDED * seInp <= inpMargin;

    // 2. LCP p75 difference 90% CI strictly inside [-50ms, +50ms]
    const diffLcp = treatment.lcpP75Ms - stub.lcpP75Ms;
    const seLcp = Math.sqrt(treatment.lcpP75SeMs ** 2 + stub.lcpP75SeMs ** 2);
    const lcpOk =
      diffLcp - Z_TOST_90_TWO_SIDED * seLcp >= -lcpMarginMs &&
      diffLcp + Z_TOST_90_TWO_SIDED * seLcp <= lcpMarginMs;

    // 3. CLS <= 0.01
    const clsOk = treatment.clsP95 <= clsMax;

    // 4. Bounce rate non-inferiority (+1.0 pt upper bound)
    const diffBounce = treatment.bounceRate - stub.bounceRate;
    const seBounce = Math.sqrt(
      (treatment.bounceRate * (1 - treatment.bounceRate)) / treatment.inpBearingPvs +
        (stub.bounceRate * (1 - stub.bounceRate)) / stub.inpBearingPvs
    );
    const bounceOk = diffBounce + Z_TOST_90_TWO_SIDED * seBounce <= 0.01;

    // 5. Business outbound click rate non-inferiority (not lower by > 0.5 pt relative/abs floor)
    const diffOut = treatment.outboundClickRate - stub.outboundClickRate;
    const seOut = Math.sqrt(
      (treatment.outboundClickRate * (1 - treatment.outboundClickRate)) / treatment.inpBearingPvs +
        (stub.outboundClickRate * (1 - stub.outboundClickRate)) / stub.inpBearingPvs
    );
    const outboundOk = diffOut - Z_TOST_90_TWO_SIDED * seOut >= -0.005;

    return { inpOk, lcpOk, clsOk, bounceOk, outboundOk };
  };

  const fullCheck = checkPairAgainstStub(params.fullArm);
  const replayCheck = params.replayArm ? checkPairAgainstStub(params.replayArm) : null;

  const tostChecks = {
    inpBadShareEquivalent: fullCheck.inpOk && (replayCheck ? replayCheck.inpOk : true),
    lcpP75Equivalent: fullCheck.lcpOk && (replayCheck ? replayCheck.lcpOk : true),
    clsWithin001: fullCheck.clsOk && (replayCheck ? replayCheck.clsOk : true),
    bounceNonInferior: fullCheck.bounceOk && (replayCheck ? replayCheck.bounceOk : true),
    outboundNonInferior: fullCheck.outboundOk && (replayCheck ? replayCheck.outboundOk : true),
  };

  const allTost = Object.values(tostChecks).every(Boolean);
  const allBudgets = Object.values(budgetChecks).every(Boolean);
  const passed = allTost && allBudgets;

  return {
    gateId: 'tel.G16',
    status: passed ? 'ok' : 'invalid',
    requiredInpPvsPerArm: requiredN,
    minObservedInpPvsPerArm: minN,
    remainingInpPvsNeeded: 0,
    tostChecks,
    budgetChecks,
    passed,
  };
}
