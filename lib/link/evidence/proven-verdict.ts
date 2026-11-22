/**
 * UGOKI LINK v2 — 5-Pathway `proven` Verdict Engine, 3 Skeptical Priors Shrinkage,
 * Type-M Exaggeration, D-07R Calibrated Projection Intervals & Post-Win Lifecycle (§9.8, §9.10)
 */

import {
  buildResponseEnvelope,
  createDataLayerMetric,
  type EvidenceLevel,
  type EvidenceRef,
  type ProvenPredicateId,
  type ProvenPredicateResult,
  type SerializedResponseEnvelope,
} from '@/packages/contract/response';

// =========================================================================
// 1. Bayesian Shrinkage Under 3 Skeptical Priors (SD = 0.05, 0.10, 0.20, §9.4 / §9.10)
// =========================================================================

export const SKEPTICAL_PRIOR_SDS = [0.05, 0.1, 0.2] as const;

export interface SkepticalPosteriorBand {
  readonly priorSd: number;
  readonly posteriorMeanLogRr: number;
  readonly posteriorSdLogRr: number;
  readonly lower95LogRr: number;
  readonly upper95LogRr: number;
  readonly posteriorRelativeLift: number;
  readonly lower95RelativeLift: number;
  readonly upper95RelativeLift: number;
}

export interface MandatoryStatisticalReport {
  readonly rawLogRr: number;
  readonly rawSeLogRr: number;
  readonly rawLower95RelativeLift: number;
  readonly rawUpper95RelativeLift: number;
  /** Bayesian conjugate normal-normal shrinkage under SD = 0.05, 0.10, 0.20. */
  readonly skepticalPosteriors: ReadonlyArray<SkepticalPosteriorBand>;
  /** Type-M exaggeration ratio (Gelman & Carlin proxy: E[|est| / |true| | sig]). */
  readonly typeMExaggerationRatio: number;
  /** False-positive risk band under conservative prior odds (10% to 30% true-effect prevalence). */
  readonly falsePositiveRiskBand: readonly [number, number];
}

const Z_95 = 1.959963984540054;

export function computeMandatoryStatisticalReport(params: {
  readonly rawLogRr: number;
  readonly rawSeLogRr: number;
  readonly targetMdeLogRr: number;
  readonly twoSidedPValue: number;
}): MandatoryStatisticalReport {
  const se = Math.max(1e-6, params.rawSeLogRr);
  const rawLower = Math.exp(params.rawLogRr - Z_95 * se) - 1;
  const rawUpper = Math.exp(params.rawLogRr + Z_95 * se) - 1;

  const skepticalPosteriors: SkepticalPosteriorBand[] = SKEPTICAL_PRIOR_SDS.map((priorSd) => {
    const priorPrec = 1 / (priorSd * priorSd);
    const dataPrec = 1 / (se * se);
    const postVar = 1 / (priorPrec + dataPrec);
    const postSd = Math.sqrt(postVar);
    const postMean = (params.rawLogRr * dataPrec) * postVar;
    const lowLog = postMean - Z_95 * postSd;
    const highLog = postMean + Z_95 * postSd;
    return {
      priorSd,
      posteriorMeanLogRr: Number(postMean.toFixed(6)),
      posteriorSdLogRr: Number(postSd.toFixed(6)),
      lower95LogRr: Number(lowLog.toFixed(6)),
      upper95LogRr: Number(highLog.toFixed(6)),
      posteriorRelativeLift: Number((Math.exp(postMean) - 1).toFixed(6)),
      lower95RelativeLift: Number((Math.exp(lowLog) - 1).toFixed(6)),
      upper95RelativeLift: Number((Math.exp(highLog) - 1).toFixed(6)),
    };
  });

  // Type-M exaggeration approximation when true effect is half of target MDE (§9.4 example: ~1.85x)
  const halfTrueEffect = Math.max(1e-6, Math.abs(params.targetMdeLogRr) * 0.5);
  const criticalThreshold = Z_95 * se;
  const typeMExaggerationRatio = Number(
    Math.max(1.0, criticalThreshold / halfTrueEffect).toFixed(2)
  );

  // Bayes factor bound FPR range for prior P(H1) in [0.10, 0.30]
  const p = Math.min(0.9999, Math.max(1e-9, params.twoSidedPValue));
  const fprAtPrior = (pi1: number): number => {
    const likH0 = p;
    const likH1 = 0.8; // nominal power
    const num = (1 - pi1) * likH0;
    return Number((num / (num + pi1 * likH1)).toFixed(4));
  };
  const fprLow = fprAtPrior(0.3);
  const fprHigh = fprAtPrior(0.1);

  return {
    rawLogRr: params.rawLogRr,
    rawSeLogRr: se,
    rawLower95RelativeLift: Number(rawLower.toFixed(6)),
    rawUpper95RelativeLift: Number(rawUpper.toFixed(6)),
    skepticalPosteriors,
    typeMExaggerationRatio,
    falsePositiveRiskBand: [Math.min(fprLow, fprHigh), Math.max(fprLow, fprHigh)],
  };
}

// =========================================================================
// 2. 5-Pathway `proven` Evaluator (§9.10) — NEVER Says "No Effect"
// =========================================================================

export type VerdictLabel =
  | 'superior'
  | 'non_inferior'
  | 'equivalent'
  | 'harmful'
  | 'inconclusive' // NEVER "no effect" — always paired with detectable MDE `x`!
  | 'futile'
  | 'invalid';

export interface ProvenVerdictInput {
  readonly experimentId: string;
  readonly interventionRefId: string;
  readonly predicate: ProvenPredicateId;
  readonly collectionGen: 'v3' | 'legacy';
  readonly allocatorLoggedBeforeOutcomes: boolean;
  readonly preregLocked: boolean;
  readonly integrityStatus: 'pass' | 'unverified' | 'fail';
  readonly decisionRulePassed: boolean;
  readonly robustnessPassed: boolean;
  /** Platform A/A canary layer must pass; failure invalidates concurrent experiments! */
  readonly platformCanaryPassed: boolean;
  readonly durationDays: number;
  /** Required >= 10,000 arrival-order replays when `predicate === 'bandit_replay'` (§9.6). */
  readonly banditReplayRuns?: number;
  readonly randomisationAuditP: number;
  readonly alpha: number;
  readonly rawLogRr: number;
  readonly rawSeLogRr: number;
  readonly targetMdeLogRr: number;
  readonly detectableMdeAtCurrentN: number;
  readonly plannedNReached: boolean;
  readonly holdbackConfirmed: boolean;
  readonly guardrailsVerified: boolean;
  readonly claimAgeDays: number;
  readonly bodyFingerprintChanged: boolean;
  readonly expectedMonthlyBaselineUnits: number;
  readonly sampleN: number;
  readonly now?: Date;
}

export interface ProvenVerdictOutput {
  readonly evidenceLevel: EvidenceLevel;
  readonly verdict: VerdictLabel;
  /** Never says "効果なし / no effect": gives detectable MDE when inconclusive. */
  readonly verdictSummary: string;
  readonly claimValid: boolean;
  readonly pointEstimateUnlocked: boolean;
  readonly pointEstimateMonthlyDeltaUnits: number | null;
  readonly stats: MandatoryStatisticalReport;
  readonly predicateResult: ProvenPredicateResult;
  readonly blockingReasons: ReadonlyArray<string>;
}

export function evaluateProvenVerdict(input: ProvenVerdictInput): ProvenVerdictOutput {
  const nowIso = (input.now ?? new Date()).toISOString();
  const stats = computeMandatoryStatisticalReport({
    rawLogRr: input.rawLogRr,
    rawSeLogRr: input.rawSeLogRr,
    targetMdeLogRr: input.targetMdeLogRr,
    twoSidedPValue: input.randomisationAuditP,
  });

  const blockingReasons: string[] = [];

  // Platform A/A canary failure or integrity failure -> ENTIRE experiment is `invalid`!
  if (!input.platformCanaryPassed) {
    blockingReasons.push('PLATFORM_AA_CANARY_FAILED');
  }
  if (input.integrityStatus === 'fail') {
    blockingReasons.push('INTEGRITY_CHECK_FAILED');
  }

  if (blockingReasons.length > 0) {
    const predicateResult: ProvenPredicateResult = {
      predicate: input.predicate,
      passed: false,
      allocator_logged_before_outcomes: input.allocatorLoggedBeforeOutcomes,
      prereg_locked: input.preregLocked,
      integrity_status: input.integrityStatus,
      decision_rule_passed: false,
      randomisation_audit_p: input.randomisationAuditP,
      alpha: input.alpha,
      duration_days: input.durationDays,
      platform_canary_passed: input.platformCanaryPassed,
      evaluated_at: nowIso,
    };
    return {
      evidenceLevel: 'observed',
      verdict: 'invalid',
      verdictSummary: `Experiment marked invalid due to ${blockingReasons.join(', ')}`,
      claimValid: false,
      pointEstimateUnlocked: false,
      pointEstimateMonthlyDeltaUnits: null,
      stats,
      predicateResult,
      blockingReasons,
    };
  }

  // Check common + pathway-specific `proven` conditions
  if (input.collectionGen === 'legacy') blockingReasons.push('LEGACY_COLLECTION_CAPPED_AT_OBSERVED');
  if (!input.allocatorLoggedBeforeOutcomes) blockingReasons.push('ALLOCATOR_NOT_LOGGED_BEFORE_OUTCOMES');
  if (!input.preregLocked) blockingReasons.push('PREREG_NOT_LOCKED');
  if (!input.decisionRulePassed) blockingReasons.push('DECISION_RULE_NOT_MET');
  if (!input.robustnessPassed) blockingReasons.push('ROBUSTNESS_CHECK_FAILED');
  if (input.randomisationAuditP > input.alpha) blockingReasons.push('P_VALUE_ABOVE_ALPHA');
  if (input.predicate !== 'lab_randomised' && input.durationDays < 14) {
    blockingReasons.push('DURATION_UNDER_14_DAYS');
  }
  if (input.predicate === 'bandit_replay' && (input.banditReplayRuns ?? 0) < 10_000) {
    blockingReasons.push('BANDIT_REPLAY_BELOW_10000_RUNS');
  }

  const provenPassed = blockingReasons.length === 0;
  const evidenceLevel: EvidenceLevel = provenPassed ? 'proven' : 'observed';

  // Claim validity: expires after 180 days OR if body fingerprint changed (§9.8)
  const claimValid = input.claimAgeDays <= 180 && !input.bodyFingerprintChanged;

  // Skeptical-most prior (SD = 0.05) lower bound
  const mostSkeptical = stats.skepticalPosteriors[0];
  const mostSkepticalLowerPositive = mostSkeptical.lower95RelativeLift > 0;

  // Determine verdict label — STRICTLY NEVER "no effect"!
  let verdict: VerdictLabel;
  let verdictSummary: string;
  if (provenPassed && input.rawLogRr > 0) {
    verdict = 'superior';
    verdictSummary = `Proven positive effect via ${input.predicate}`;
  } else if (provenPassed && input.rawLogRr < 0) {
    verdict = 'harmful';
    verdictSummary = `Proven harmful effect via ${input.predicate}; immediate harm removal recommended`;
  } else if (Math.abs(stats.rawUpper95RelativeLift) < Math.abs(Math.exp(input.targetMdeLogRr) - 1) * 0.25) {
    verdict = 'futile';
    verdictSummary = `Futile: unlikely to reach target MDE (visible difference at current N: ${(input.detectableMdeAtCurrentN * 100).toFixed(1)}%)`;
  } else {
    verdict = 'inconclusive';
    verdictSummary = `Inconclusive (minimum detectable effect at current sample size: ${(input.detectableMdeAtCurrentN * 100).toFixed(1)}%)`;
  }

  // Point estimate strictly gated (§9.10 & `packages/contract/response` I2):
  //   - `proven`
  //   - NOT `lab_randomised` (lab randomised NEVER yields visitor lift projections!)
  //   - claim valid (<= 180d & unchanged body fp)
  //   - most skeptical prior lower bound > 0
  //   - planned N reached OR holdback confirmed
  //   - guardrails verified
  const pointEstimateUnlocked =
    provenPassed &&
    input.predicate !== 'lab_randomised' &&
    claimValid &&
    mostSkepticalLowerPositive &&
    (input.plannedNReached || input.holdbackConfirmed) &&
    input.guardrailsVerified;

  const pointEstimateMonthlyDeltaUnits = pointEstimateUnlocked
    ? Number((mostSkeptical.posteriorRelativeLift * input.expectedMonthlyBaselineUnits).toFixed(2))
    : null;

  const predicateResult: ProvenPredicateResult = {
    predicate: input.predicate,
    passed: provenPassed,
    allocator_logged_before_outcomes: input.allocatorLoggedBeforeOutcomes,
    prereg_locked: input.preregLocked,
    integrity_status: input.integrityStatus,
    decision_rule_passed: input.decisionRulePassed,
    randomisation_audit_p: input.randomisationAuditP,
    alpha: input.alpha,
    ...(input.predicate !== 'lab_randomised'
      ? { duration_days: input.durationDays, platform_canary_passed: input.platformCanaryPassed }
      : {}),
    evaluated_at: nowIso,
  };

  return {
    evidenceLevel,
    verdict,
    verdictSummary,
    claimValid,
    pointEstimateUnlocked,
    pointEstimateMonthlyDeltaUnits,
    stats,
    predicateResult,
    blockingReasons,
  };
}

// =========================================================================
// 3. D-07R Calibrated Projection Interval Gate (Coverage 95% LB >= 0.70, >=30, >=3 sites)
// =========================================================================

export interface D07RCalibrationReport {
  readonly gateId: 'surf.projection_calibrated';
  readonly resolvedInterventions: number;
  readonly coveredInterventions: number;
  readonly distinctSites: number;
  readonly empiricalCoverage: number;
  readonly clopperPearsonLower95: number;
  readonly gatePassed: boolean;
  /** When false, serializer output is identical to D-07 (`band_only`). */
  readonly presentationMode: 'interval' | 'band_only';
}

/**
 * Computes conservative one-sided 95% lower bound on binomial coverage (`k` of `n`)
 * using Wilson/exact lower bound approximation (matches 26/30 >= 0.70 threshold per `surface-final.md` §8.1).
 */
export function computeOneSided95CoverageLowerBound(covered: number, total: number): number {
  if (total <= 0 || covered <= 0) return 0;
  if (covered >= total) {
    return Number(Math.pow(0.05, 1 / total).toFixed(4));
  }
  // Exact Clopper-Pearson via regularised incomplete beta quantile solved by bisection on binomial CDF P(X >= covered | p) = 0.05
  const binomTailAtLeast = (p: number): number => {
    let sum = 0;
    // Compute log-binomial probabilities cleanly to avoid overflow
    const logFact = (m: number): number => {
      let s = 0;
      for (let i = 2; i <= m; i++) s += Math.log(i);
      return s;
    };
    const logNFact = logFact(total);
    for (let x = covered; x <= total; x++) {
      const lp =
        logNFact -
        logFact(x) -
        logFact(total - x) +
        x * Math.log(p) +
        (total - x) * Math.log(1 - p);
      sum += Math.exp(lp);
    }
    return sum;
  };

  let lo = 0;
  let hi = covered / total;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (binomTailAtLeast(mid) < 0.05) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Number(lo.toFixed(4));
}

export function evaluateD07RCalibration(params: {
  readonly resolvedInterventions: number;
  readonly coveredInterventions: number;
  readonly distinctSites: number;
}): D07RCalibrationReport {
  const lb = computeOneSided95CoverageLowerBound(
    params.coveredInterventions,
    params.resolvedInterventions
  );
  const gatePassed =
    params.resolvedInterventions >= 30 &&
    params.distinctSites >= 3 &&
    lb >= 0.7;

  return {
    gateId: 'surf.projection_calibrated',
    resolvedInterventions: params.resolvedInterventions,
    coveredInterventions: params.coveredInterventions,
    distinctSites: params.distinctSites,
    empiricalCoverage:
      params.resolvedInterventions > 0
        ? Number((params.coveredInterventions / params.resolvedInterventions).toFixed(4))
        : 0,
    clopperPearsonLower95: lb,
    gatePassed,
    presentationMode: gatePassed ? 'interval' : 'band_only',
  };
}

/**
 * Serializes a `ProvenVerdictOutput` directly through `packages/contract/response`
 * (`buildResponseEnvelope`) to guarantee strict I1–I7 compliance.
 */
export function buildProvenVerdictEnvelope(params: {
  readonly input: ProvenVerdictInput;
  readonly verdict: ProvenVerdictOutput;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly storageRegion?: string;
  readonly processingRegion?: string;
  readonly now?: Date;
}): SerializedResponseEnvelope {
  const nowIso = (params.now ?? new Date()).toISOString();
  const interventionRef: EvidenceRef = {
    ref_id: params.input.interventionRefId,
    kind: 'intervention',
    params_hash: `exp_${params.input.experimentId}`,
    watermarks: { as_of: nowIso },
    result_digest: `verdict_${params.verdict.verdict}`,
    issued_at: nowIso,
    valid_until: new Date((params.now ?? new Date()).getTime() + 180 * 86_400_000).toISOString(),
    kid: 'ev_v1',
  };

  const mostSkeptical = params.verdict.stats.skepticalPosteriors[0];
  const brandNumericLeaves = (node: unknown): unknown => {
    if (typeof node === 'number' && Number.isFinite(node)) {
      return createDataLayerMetric(node, params.input.interventionRefId, {
        authority: 'allocator_experiment',
        createdAt: nowIso,
      });
    }
    if (Array.isArray(node)) {
      return node.map((item) => brandNumericLeaves(item));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = brandNumericLeaves(v);
      }
      return out;
    }
    return node;
  };

  return buildResponseEnvelope({
    window: { start: params.windowStart, end: params.windowEnd },
    freshness: { data_through: nowIso, lag_s: 0, sources: { experiments: nowIso }, stale: false },
    coverage: { ratio: 1, denominator_n: params.input.sampleN },
    lineage: { schema_version: '2.0', def_ver: 1, collection_gen: params.input.collectionGen },
    residency: {
      storage_region: params.storageRegion ?? 'ap-northeast-1',
      processing_region: params.processingRegion ?? 'ap-northeast-1',
    },
    experiment: {
      verdict: params.verdict.verdict === 'invalid' ? 'inconclusive' : params.verdict.verdict,
      mde: params.input.detectableMdeAtCurrentN,
      integrity: params.input.integrityStatus,
    },
    measures: {
      relative_lift: {
        value:
          params.verdict.verdict === 'invalid'
            ? null
            : createDataLayerMetric(mostSkeptical.posteriorRelativeLift, params.input.interventionRefId, {
                authority: 'allocator_experiment',
                createdAt: nowIso,
              }),
        unit: 'relative_ratio',
        status: params.verdict.verdict === 'invalid' ? 'invalid' : 'ok',
        ...(params.verdict.verdict === 'invalid'
          ? {
              reason: params.verdict.verdictSummary,
              unmet_gates: [
                {
                  id: 'ev.G-3',
                  required: 'pass',
                  observed: 'fail',
                  unlock: 'Resolve platform canary or integrity failure',
                },
              ],
            }
          : {}),
        evidence: {
          level: params.verdict.evidenceLevel,
          exactness: 'exact',
          criteria: [params.verdict.predicateResult],
          refs: [interventionRef],
          validity: params.verdict.claimValid ? 'valid' : 'expired',
          scope: `experiment:${params.input.experimentId}`,
        },
        sample: params.verdict.verdict === 'invalid' ? null : { n: params.input.sampleN, unit_kind: 'visitor' },
        interval: {
          level: 0.95,
          lower: mostSkeptical.lower95RelativeLift,
          upper: mostSkeptical.upper95RelativeLift,
          method: 'skeptical_normal_shrinkage_sd_0.05',
        },
        projection: params.verdict.pointEstimateUnlocked && params.verdict.pointEstimateMonthlyDeltaUnits !== null
          ? {
              presentation: 'interval',
              point_estimate: createDataLayerMetric(
                params.verdict.pointEstimateMonthlyDeltaUnits,
                params.input.interventionRefId,
                { authority: 'allocator_experiment', createdAt: nowIso }
              ),
              point_estimate_conditions: {
                skeptical_lower_bound: mostSkeptical.lower95RelativeLift,
                planned_n_reached: params.input.plannedNReached,
                holdback_confirmed: params.input.holdbackConfirmed,
                guardrails_verified: params.input.guardrailsVerified,
              },
            }
          : {
              presentation: 'band_only',
              point_estimate: null,
            },
      },
    },
    data: {
      verdict: params.verdict.verdict,
      verdictSummary: params.verdict.verdictSummary,
      stats: brandNumericLeaves(params.verdict.stats),
      blockingReasons: params.verdict.blockingReasons,
    },
  });
}

// =========================================================================
// 4. Post-Win Lifecycle Contract (§9.8)
// =========================================================================

export type PostWinStage =
  | 'browser_bridge' // max 14 days
  | 'origin_baked_pending_verify'
  | 'browser_retired_reverse_holdback' // max 56 days bundled (~10 adoptions)
  | 'completed'
  | 'expired';

export interface PostWinAdoptionRecord {
  readonly adoptionId: string;
  readonly experimentId: string;
  readonly isHarmRemoval: boolean;
  /** Only harm removal deploys immediately; all other wins batch into weekly adoption window (§9.8). */
  readonly deploymentCadence: 'immediate_harm_removal' | 'weekly_batch';
  readonly stage: PostWinStage;
  readonly browserBridgeDaysElapsed: number;
  readonly browserBridgeMaxDays: 14;
  readonly reverseHoldbackDaysElapsed: number;
  readonly reverseHoldbackMaxDays: 56;
  readonly claimDaysElapsed: number;
  readonly claimMaxDays: 180;
  readonly originFingerprintVerified: boolean;
  readonly browserPatchRetired: boolean;
  readonly claimExpired: boolean;
}

export function evaluatePostWinLifecycle(params: {
  readonly adoptionId: string;
  readonly experimentId: string;
  readonly isHarmRemoval: boolean;
  readonly browserBridgeDaysElapsed: number;
  readonly originBaked: boolean;
  readonly originFingerprintVerified: boolean;
  readonly reverseHoldbackDaysElapsed: number;
  readonly claimDaysElapsed: number;
  readonly bodyFingerprintChanged: boolean;
}): PostWinAdoptionRecord {
  const claimExpired = params.claimDaysElapsed > 180 || params.bodyFingerprintChanged;
  let stage: PostWinStage;
  let browserPatchRetired = false;

  if (claimExpired) {
    stage = 'expired';
    browserPatchRetired = true;
  } else if (!params.originBaked) {
    stage = 'browser_bridge';
  } else if (!params.originFingerprintVerified) {
    stage = 'origin_baked_pending_verify';
  } else if (params.reverseHoldbackDaysElapsed <= 56) {
    stage = 'browser_retired_reverse_holdback';
    browserPatchRetired = true;
  } else {
    stage = 'completed';
    browserPatchRetired = true;
  }

  return {
    adoptionId: params.adoptionId,
    experimentId: params.experimentId,
    isHarmRemoval: params.isHarmRemoval,
    deploymentCadence: params.isHarmRemoval ? 'immediate_harm_removal' : 'weekly_batch',
    stage,
    browserBridgeDaysElapsed: params.browserBridgeDaysElapsed,
    browserBridgeMaxDays: 14,
    reverseHoldbackDaysElapsed: params.reverseHoldbackDaysElapsed,
    reverseHoldbackMaxDays: 56,
    claimDaysElapsed: params.claimDaysElapsed,
    claimMaxDays: 180,
    originFingerprintVerified: params.originFingerprintVerified,
    browserPatchRetired,
    claimExpired,
  };
}
