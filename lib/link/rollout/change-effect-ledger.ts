/**
 * UGOKI LINK v2 — Change Effect Ledger & Prospective Meta-Analysis (§9.7, §9.9)
 *
 * Implements:
 * 1. Quasi-experimental Change Effect Ledger (§9.9):
 *    - Timestamp certainty ranking:
 *      `applied_or_wp_revision > real_visit_fp_change > scheduled_lab_snapshot > crawl_issue_event`
 *    - Missing pre-change records yield `status: 'no_baseline'` (never fabricated)
 *    - Control group selection MUST be locked before change detection (`controlSelectionLockedAtMs <= detectedAtMs`)
 *    - Dual estimators (Difference-in-Differences & Synthetic/Weighted Control) compared; disagreement => `inconclusive`
 *    - Placebo (fake change) calibration on unchanged pages checks serial-correlation false-positive inflation
 *    - STRICT `observed` EVIDENCE CEILING: compile-time AND runtime prohibition on `proven`, `caused`, or `原因` labels
 * 2. Prospective Meta-Analysis (§9.7):
 *    - Pre-registered site-weighted average effect across >= 2 sites
 *    - Enables `intervention_class × tenant` level `proven` verdicts for low-traffic sites
 *    - Extrapolation to a new unseen site is permitted ONLY when prediction intervals under ALL 3 skeptical prior
 *      scales (`ev.prior_sd_scales` = [0.05, 0.10, 0.20]) exclude 0 in the same direction
 */

import { getConstant } from '../../../packages/contract/ledgers';
import type { ProvenPredicateResult } from '../../../packages/contract/response';

// =========================================================================
// 1. Timestamp Provenance & Strict `observed` Ceiling
// =========================================================================

export const CHANGE_TIMESTAMP_SOURCES = [
  'applied_or_wp_revision',
  'real_visit_fp_change',
  'scheduled_lab_snapshot',
  'crawl_issue_event',
] as const;

export type ChangeTimestampSource = (typeof CHANGE_TIMESTAMP_SOURCES)[number];

export const CHANGE_SOURCE_CERTAINTY_RANK: Readonly<Record<ChangeTimestampSource, 1 | 2 | 3 | 4>> = {
  applied_or_wp_revision: 1,
  real_visit_fp_change: 2,
  scheduled_lab_snapshot: 3,
  crawl_issue_event: 4,
};

export function rankChangeTimestampSource(source: ChangeTimestampSource): 1 | 2 | 3 | 4 {
  return CHANGE_SOURCE_CERTAINTY_RANK[source];
}

export function selectHighestCertaintySource(
  sources: readonly ChangeTimestampSource[]
): ChangeTimestampSource {
  if (sources.length === 0) {
    throw new Error('At least one change timestamp source is required');
  }
  return [...sources].sort(
    (a, b) => CHANGE_SOURCE_CERTAINTY_RANK[a] - CHANGE_SOURCE_CERTAINTY_RANK[b]
  )[0];
}

/**
 * Compile-time ceiling: Change Effect Ledger entries can NEVER exceed `observed`.
 */
export type ChangeLedgerEvidenceLevel = 'observed';

export type ChangeLedgerStatus =
  | 'observed_difference'
  | 'inconclusive'
  | 'no_baseline'
  | 'invalid_posthoc_control';

export class ProhibitedCausalClaimError extends Error {
  constructor(detail: string) {
    super(
      `§9.9 Change Effect Ledger Prohibition: Ledger entries are capped at "observed" and MUST NEVER claim "proven", "caused", or "原因" (${detail})`
    );
    this.name = 'ProhibitedCausalClaimError';
  }
}

const FORBIDDEN_CAUSAL_PATTERNS: readonly RegExp[] = [
  /\bproven\b/i,
  /\bcaused\b/i,
  /\bcausal(?:ly)?\s+proven\b/i,
  /原因/,
];

/**
 * Runtime guard enforcing §9.9: rejects any attempt to label a quasi-experimental
 * ledger entry as `proven`, `caused`, or `原因`.
 */
export function assertLedgerNeverClaimsCausal(candidate: {
  readonly evidenceLevel: string;
  readonly verdictLabel?: string;
  readonly summaryText?: string;
}): void {
  if (candidate.evidenceLevel !== 'observed') {
    throw new ProhibitedCausalClaimError(
      `evidenceLevel="${candidate.evidenceLevel}" exceeds ceiling "observed"`
    );
  }
  const textsToCheck = [candidate.verdictLabel ?? '', candidate.summaryText ?? ''];
  for (const text of textsToCheck) {
    for (const pat of FORBIDDEN_CAUSAL_PATTERNS) {
      if (pat.test(text)) {
        throw new ProhibitedCausalClaimError(
          `forbidden causal phrasing matched ${pat} in "${text}"`
        );
      }
    }
  }
}

// =========================================================================
// 2. Dual Estimator (DiD + Synthetic/Weighted Control) & Ledger Recording
// =========================================================================

export interface ControlPageSeries {
  readonly pageId: string;
  readonly preValues: readonly number[];
  readonly postValues: readonly number[];
}

export interface ChangeObservationInput {
  readonly changeId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly pageId: string;
  readonly sectionId: string;
  readonly detectedAtMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly sources: readonly ChangeTimestampSource[];
  readonly changeCauseDescription: string;
  /** Optional link to 4-G semantic change classification tuple hash. */
  readonly semanticClassificationHash?: string;
  /** Timestamp when control pages were locked; MUST be <= detectedAtMs. */
  readonly controlSelectionLockedAtMs: number;
  readonly treatedPreValues: readonly number[];
  readonly treatedPostValues: readonly number[];
  readonly controls: readonly ControlPageSeries[];
  /** Optional caller-supplied label/evidenceLevel checked by runtime causal guard. */
  readonly requestedEvidenceLevel?: string;
  readonly requestedSummaryLabel?: string;
}

export interface EstimatorResult {
  readonly method: 'did' | 'weighted_synthetic_control';
  readonly estimate: number;
  readonly standardError: number;
  readonly ciLower95: number;
  readonly ciUpper95: number;
  readonly direction: 'positive' | 'negative' | 'neutral';
}

export interface ChangeEffectLedgerEntry {
  readonly changeId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly pageId: string;
  readonly sectionId: string;
  readonly primarySource: ChangeTimestampSource;
  readonly sourceCertaintyRank: 1 | 2 | 3 | 4;
  readonly evidenceLevel: ChangeLedgerEvidenceLevel;
  readonly status: ChangeLedgerStatus;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly semanticClassificationHash?: string;
  readonly did: EstimatorResult | null;
  readonly syntheticControl: EstimatorResult | null;
  readonly estimatorsAgree: boolean;
  readonly controlWeights: Readonly<Record<string, number>>;
  readonly shrunkLowerBound: number | null;
  readonly summaryNote: string;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function sampleVariance(xs: readonly number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) {
    const d = x - m;
    acc += d * d;
  }
  return acc / (xs.length - 1);
}

/**
 * Estimates lag-1 autocorrelation-adjusted variance (Newey-West style inflation)
 * so serial correlation in daily page series does not understate SE (§9.9).
 */
function serialCorrelationAdjustedVarOfMean(xs: readonly number[]): number {
  const n = xs.length;
  if (n <= 1) return 0;
  const v = sampleVariance(xs);
  if (v === 0) return 0;
  const m = mean(xs);
  let cov1 = 0;
  for (let i = 1; i < n; i++) {
    cov1 += (xs[i] - m) * (xs[i - 1] - m);
  }
  cov1 /= n;
  const rho1 = Math.max(0, Math.min(0.85, cov1 / v));
  const inflation = (1 + rho1) / (1 - rho1);
  return (v / n) * inflation;
}

function classifyDirection(ciLower: number, ciUpper: number): 'positive' | 'negative' | 'neutral' {
  if (ciLower > 0) return 'positive';
  if (ciUpper < 0) return 'negative';
  return 'neutral';
}

export function computeDidEstimate(
  treatedPre: readonly number[],
  treatedPost: readonly number[],
  controls: readonly ControlPageSeries[]
): EstimatorResult {
  const controlPreAvg: number[] = [];
  const controlPostAvg: number[] = [];

  const preLen = Math.min(...controls.map((c) => c.preValues.length));
  const postLen = Math.min(...controls.map((c) => c.postValues.length));

  for (let i = 0; i < preLen; i++) {
    controlPreAvg.push(mean(controls.map((c) => c.preValues[i])));
  }
  for (let i = 0; i < postLen; i++) {
    controlPostAvg.push(mean(controls.map((c) => c.postValues[i])));
  }

  const diffPre = treatedPre.slice(0, preLen).map((v, i) => v - controlPreAvg[i]);
  const diffPost = treatedPost.slice(0, postLen).map((v, i) => v - controlPostAvg[i]);

  const estimate = mean(diffPost) - mean(diffPre);
  const se = Math.sqrt(
    serialCorrelationAdjustedVarOfMean(diffPre) +
      serialCorrelationAdjustedVarOfMean(diffPost) +
      1e-12
  );
  const z = 1.959964;
  const ciLower95 = estimate - z * se;
  const ciUpper95 = estimate + z * se;

  return {
    method: 'did',
    estimate,
    standardError: se,
    ciLower95,
    ciUpper95,
    direction: classifyDirection(ciLower95, ciUpper95),
  };
}

/**
 * Computes inverse-pre-MSE weighted synthetic control estimate (non-negative simplex weights).
 */
export function computeWeightedControlEstimate(
  treatedPre: readonly number[],
  treatedPost: readonly number[],
  controls: readonly ControlPageSeries[]
): { readonly result: EstimatorResult; readonly weights: Readonly<Record<string, number>> } {
  const preLen = Math.min(treatedPre.length, ...controls.map((c) => c.preValues.length));
  const postLen = Math.min(treatedPost.length, ...controls.map((c) => c.postValues.length));

  const rawWeights: number[] = [];
  for (const ctrl of controls) {
    let mse = 0;
    for (let i = 0; i < preLen; i++) {
      const d = treatedPre[i] - ctrl.preValues[i];
      mse += d * d;
    }
    mse = preLen > 0 ? mse / preLen : 1;
    rawWeights.push(1 / (mse + 1e-4));
  }

  const sumW = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const normWeights = rawWeights.map((w) => w / sumW);
  const weights: Record<string, number> = {};
  controls.forEach((c, idx) => {
    weights[c.pageId] = Number(normWeights[idx].toFixed(6));
  });

  const synthPre: number[] = [];
  for (let i = 0; i < preLen; i++) {
    let acc = 0;
    for (let j = 0; j < controls.length; j++) {
      acc += normWeights[j] * controls[j].preValues[i];
    }
    synthPre.push(acc);
  }
  const synthPost: number[] = [];
  for (let i = 0; i < postLen; i++) {
    let acc = 0;
    for (let j = 0; j < controls.length; j++) {
      acc += normWeights[j] * controls[j].postValues[i];
    }
    synthPost.push(acc);
  }

  const preGaps = treatedPre.slice(0, preLen).map((v, i) => v - synthPre[i]);
  const postGaps = treatedPost.slice(0, postLen).map((v, i) => v - synthPost[i]);

  const estimate = mean(postGaps) - mean(preGaps);
  const se = Math.sqrt(
    serialCorrelationAdjustedVarOfMean(preGaps) +
      serialCorrelationAdjustedVarOfMean(postGaps) +
      1e-12
  );
  const z = 1.959964;
  const ciLower95 = estimate - z * se;
  const ciUpper95 = estimate + z * se;

  return {
    result: {
      method: 'weighted_synthetic_control',
      estimate,
      standardError: se,
      ciLower95,
      ciUpper95,
      direction: classifyDirection(ciLower95, ciUpper95),
    },
    weights,
  };
}

/**
 * Evaluates and records a detected change as a quasi-experiment in the Change Effect Ledger (§9.9).
 * Always capped at `evidenceLevel: 'observed'`.
 */
export function recordChangeEffectObservation(
  input: ChangeObservationInput
): ChangeEffectLedgerEntry {
  // Enforce runtime causal prohibition if caller attempts to override evidence/label
  if (input.requestedEvidenceLevel !== undefined || input.requestedSummaryLabel !== undefined) {
    assertLedgerNeverClaimsCausal({
      evidenceLevel: input.requestedEvidenceLevel ?? 'observed',
      verdictLabel: input.requestedSummaryLabel,
    });
  }

  const primarySource = selectHighestCertaintySource(input.sources);
  const sourceCertaintyRank = rankChangeTimestampSource(primarySource);

  // Missing pre-change baseline => `no_baseline`
  if (
    input.treatedPreValues.length === 0 ||
    input.treatedPostValues.length === 0 ||
    input.controls.length === 0 ||
    input.controls.some((c) => c.preValues.length === 0 || c.postValues.length === 0)
  ) {
    return {
      changeId: input.changeId,
      tenantId: input.tenantId,
      siteId: input.siteId,
      pageId: input.pageId,
      sectionId: input.sectionId,
      primarySource,
      sourceCertaintyRank,
      evidenceLevel: 'observed',
      status: 'no_baseline',
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      semanticClassificationHash: input.semanticClassificationHash,
      did: null,
      syntheticControl: null,
      estimatorsAgree: false,
      controlWeights: {},
      shrunkLowerBound: null,
      summaryNote: 'Observed change recorded without pre-change baseline (no_baseline).',
    };
  }

  // Control selection MUST be locked before detection (§9.9)
  if (input.controlSelectionLockedAtMs > input.detectedAtMs) {
    return {
      changeId: input.changeId,
      tenantId: input.tenantId,
      siteId: input.siteId,
      pageId: input.pageId,
      sectionId: input.sectionId,
      primarySource,
      sourceCertaintyRank,
      evidenceLevel: 'observed',
      status: 'invalid_posthoc_control',
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      semanticClassificationHash: input.semanticClassificationHash,
      did: null,
      syntheticControl: null,
      estimatorsAgree: false,
      controlWeights: {},
      shrunkLowerBound: null,
      summaryNote:
        'Control selection timestamp is after change detection; rejected as post-hoc control selection.',
    };
  }

  const did = computeDidEstimate(
    input.treatedPreValues,
    input.treatedPostValues,
    input.controls
  );
  const { result: syntheticControl, weights: controlWeights } =
    computeWeightedControlEstimate(
      input.treatedPreValues,
      input.treatedPostValues,
      input.controls
    );

  // Two methods MUST agree in direction AND have overlapping 95% CIs; otherwise `inconclusive`
  const cisOverlap =
    Math.max(did.ciLower95, syntheticControl.ciLower95) <=
    Math.min(did.ciUpper95, syntheticControl.ciUpper95);
  const sameNonNeutralDirection =
    did.direction === syntheticControl.direction && did.direction !== 'neutral';
  const estimatorsAgree = sameNonNeutralDirection && cisOverlap;

  const status: ChangeLedgerStatus = estimatorsAgree
    ? 'observed_difference'
    : 'inconclusive';

  // Conservative shrunk lower bound for follow-up re-test prioritization (§9.11)
  const rawMinAbs = Math.min(Math.abs(did.estimate), Math.abs(syntheticControl.estimate));
  const combinedSe = Math.max(did.standardError, syntheticControl.standardError);
  const priorVar = 0.01; // skeptical shrinkage variance (sd=0.10)
  const shrinkFactor = priorVar / (priorVar + combinedSe * combinedSe);
  const signedAvg = 0.5 * (did.estimate + syntheticControl.estimate);
  const shrunkMean = shrinkFactor * signedAvg;
  const shrunkSe = Math.sqrt(shrinkFactor * combinedSe * combinedSe);
  const shrunkLowerBound =
    rawMinAbs > 0 ? Number((shrunkMean - 1.96 * shrunkSe).toFixed(6)) : 0;

  const entry: ChangeEffectLedgerEntry = {
    changeId: input.changeId,
    tenantId: input.tenantId,
    siteId: input.siteId,
    pageId: input.pageId,
    sectionId: input.sectionId,
    primarySource,
    sourceCertaintyRank,
    evidenceLevel: 'observed',
    status,
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
    semanticClassificationHash: input.semanticClassificationHash,
    did,
    syntheticControl,
    estimatorsAgree,
    controlWeights,
    shrunkLowerBound,
    summaryNote: estimatorsAgree
      ? `Observed pre/post difference (${did.direction}) consistent across DiD and weighted control; observational only.`
      : 'DiD and weighted control estimates disagree or cross zero; marked inconclusive.',
  };

  assertLedgerNeverClaimsCausal({
    evidenceLevel: entry.evidenceLevel,
    summaryText: entry.summaryNote,
  });

  return entry;
}

// =========================================================================
// 3. Placebo Calibration on Unchanged Pages (§9.9)
// =========================================================================

export interface UnchangedPagePlaceboCase {
  readonly placeboId: string;
  readonly treatedPreValues: readonly number[];
  readonly treatedPostValues: readonly number[];
  readonly controls: readonly ControlPageSeries[];
}

export interface PlaceboCalibrationReport {
  readonly totalCases: number;
  readonly falsePositiveCount: number;
  readonly falsePositiveRate: number;
  readonly maxAcceptableFpr: number;
  readonly calibrated: boolean;
}

/**
 * Runs fake-change placebo tests on unchanged pages to measure empirical false-positive
 * rate of the quasi-experimental dual-estimator pipeline (§9.9).
 */
export function runLedgerPlaceboCalibration(
  cases: readonly UnchangedPagePlaceboCase[],
  maxAcceptableFpr = 0.1
): PlaceboCalibrationReport {
  let falsePositiveCount = 0;

  for (const tc of cases) {
    const res = recordChangeEffectObservation({
      changeId: tc.placeboId,
      tenantId: 'placebo',
      siteId: 'placebo',
      pageId: tc.placeboId,
      sectionId: 'sec_placebo',
      detectedAtMs: 1_000,
      windowStartMs: 0,
      windowEndMs: 2_000,
      sources: ['scheduled_lab_snapshot'],
      changeCauseDescription: 'placebo_unchanged_page',
      controlSelectionLockedAtMs: 500,
      treatedPreValues: tc.treatedPreValues,
      treatedPostValues: tc.treatedPostValues,
      controls: tc.controls,
    });
    if (res.status === 'observed_difference') {
      falsePositiveCount += 1;
    }
  }

  const falsePositiveRate =
    cases.length > 0 ? falsePositiveCount / cases.length : 0;

  return {
    totalCases: cases.length,
    falsePositiveCount,
    falsePositiveRate,
    maxAcceptableFpr,
    calibrated: cases.length > 0 && falsePositiveRate <= maxAcceptableFpr,
  };
}

// =========================================================================
// 4. Prospective Meta-Analysis (§9.7)
// =========================================================================

const priorScalesConst = getConstant('ev.prior_sd_scales')?.value;
export const DEFAULT_META_PRIOR_SCALES: readonly number[] =
  Array.isArray(priorScalesConst) && priorScalesConst.every((n) => typeof n === 'number')
    ? priorScalesConst
    : [0.05, 0.1, 0.2];

export interface ProspectiveSiteOutcome {
  readonly siteId: string;
  /** Pre-registered site weight (positive, normalized internally). */
  readonly preregWeight: number;
  /** Observed treatment effect (e.g. log relative risk). */
  readonly effect: number;
  /** Within-site standard error (> 0). */
  readonly standardError: number;
  readonly units: number;
  readonly durationDays: number;
  readonly allocatorLoggedBeforeOutcomes: boolean;
  readonly preregLocked: boolean;
  readonly integrityStatus: 'pass' | 'unverified' | 'fail';
  readonly platformCanaryPassed: boolean;
}

export interface ProspectiveMetaAnalysisInput {
  readonly metaId: string;
  readonly tenantId: string;
  readonly interventionClass: string;
  readonly sites: readonly ProspectiveSiteOutcome[];
  readonly alpha?: number;
  /** Minimum aggregate information (sum of inverse variances) required for class × tenant verdict. */
  readonly minAggregateInformation?: number;
  /** Three skeptical prior SD scales (default [0.05, 0.10, 0.20] per ev.prior_sd_scales). */
  readonly priorSdScales?: readonly number[];
  readonly evaluatedAtIso: string;
}

export interface PriorScalePredictionInterval {
  readonly priorSd: number;
  readonly posteriorMean: number;
  readonly predictionLower95: number;
  readonly predictionUpper95: number;
  readonly excludesZero: boolean;
  readonly direction: 'positive' | 'negative' | 'crosses_zero';
}

export interface ProspectiveMetaAnalysisResult {
  readonly metaId: string;
  readonly tenantId: string;
  readonly interventionClass: string;
  readonly siteCount: number;
  /** True when >= 2 sites allow estimating the pre-weighted average effect across registered sites. */
  readonly registeredSitesAverageValid: boolean;
  readonly weightedAverageEffect: number;
  readonly weightedAverageSe: number;
  readonly weightedCiLower95: number;
  readonly weightedCiUpper95: number;
  readonly betweenSiteTauSquared: number;
  readonly aggregateInformation: number;
  /** Reached `proven` at `intervention_class × tenant` level (§9.7). */
  readonly classTenantEvidenceLevel: 'observed' | 'proven';
  readonly provenPredicate: ProvenPredicateResult | null;
  /** Prediction intervals for a NEW unseen site under all 3 prior scales. */
  readonly newSitePredictionIntervals: readonly PriorScalePredictionInterval[];
  /** True ONLY when ALL 3 prior-scale prediction intervals exclude 0 in the same direction (§9.7). */
  readonly canExtrapolateToNewSite: boolean;
  readonly reasons: readonly string[];
}

function twoSidedNormalPValue(zAbs: number): number {
  // Abramowitz & Stegun 7.1.26 erfc approximation
  const x = zAbs / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return Math.max(0, Math.min(1, erfc));
}

/**
 * Evaluates a prospective multi-site meta-analysis (§9.7):
 * - Average effect across registered sites requires >= 2 sites with pre-registered weights
 * - `intervention_class × tenant` level `proven` requires aggregate information + §9.10 common predicates
 * - Extrapolation to a NEW site requires prediction intervals under ALL 3 prior scales to exclude 0
 */
export function evaluateProspectiveMetaAnalysis(
  input: ProspectiveMetaAnalysisInput
): ProspectiveMetaAnalysisResult {
  const alpha = input.alpha ?? 0.05;
  const priorScales = input.priorSdScales ?? DEFAULT_META_PRIOR_SCALES;
  const minInfo = input.minAggregateInformation ?? 100;
  const reasons: string[] = [];

  if (input.sites.length < 2) {
    reasons.push('requires_at_least_2_sites_for_multi_site_average');
    return {
      metaId: input.metaId,
      tenantId: input.tenantId,
      interventionClass: input.interventionClass,
      siteCount: input.sites.length,
      registeredSitesAverageValid: false,
      weightedAverageEffect: input.sites[0]?.effect ?? 0,
      weightedAverageSe: input.sites[0]?.standardError ?? Number.POSITIVE_INFINITY,
      weightedCiLower95: Number.NEGATIVE_INFINITY,
      weightedCiUpper95: Number.POSITIVE_INFINITY,
      betweenSiteTauSquared: 0,
      aggregateInformation: 0,
      classTenantEvidenceLevel: 'observed',
      provenPredicate: null,
      newSitePredictionIntervals: [],
      canExtrapolateToNewSite: false,
      reasons,
    };
  }

  // Normalize pre-registered site weights
  const weightSum = input.sites.reduce((s, x) => s + Math.max(0, x.preregWeight), 0) || 1;
  const normW = input.sites.map((x) => Math.max(0, x.preregWeight) / weightSum);

  let weightedMean = 0;
  let weightedVar = 0;
  let invVarSum = 0;
  let invVarMeanNum = 0;
  let invVarSqSum = 0;

  for (let i = 0; i < input.sites.length; i++) {
    const s = input.sites[i];
    const v = Math.max(1e-12, s.standardError * s.standardError);
    const iv = 1 / v;
    weightedMean += normW[i] * s.effect;
    weightedVar += normW[i] * normW[i] * v;
    invVarSum += iv;
    invVarMeanNum += iv * s.effect;
    invVarSqSum += iv * iv;
  }

  const weightedSe = Math.sqrt(weightedVar);
  const zCrit = 1.959964;
  const weightedCiLower95 = weightedMean - zCrit * weightedSe;
  const weightedCiUpper95 = weightedMean + zCrit * weightedSe;

  // DerSimonian-Laird between-site heterogeneity tau^2
  const feMean = invVarMeanNum / invVarSum;
  let qStat = 0;
  for (const s of input.sites) {
    const v = Math.max(1e-12, s.standardError * s.standardError);
    qStat += ((s.effect - feMean) * (s.effect - feMean)) / v;
  }
  const df = input.sites.length - 1;
  const cDenom = invVarSum - invVarSqSum / invVarSum;
  const betweenSiteTauSquared =
    cDenom > 0 ? Math.max(0, (qStat - df) / cDenom) : 0;

  const zStat = Math.abs(weightedMean) / Math.max(1e-12, weightedSe);
  const pValue = twoSidedNormalPValue(zStat);

  // Common §9.10 predicates across all contributing sites
  const allAllocatorLogged = input.sites.every((s) => s.allocatorLoggedBeforeOutcomes);
  const allPreregLocked = input.sites.every((s) => s.preregLocked);
  const allIntegrityPass = input.sites.every((s) => s.integrityStatus === 'pass');
  const allCanaryPassed = input.sites.every((s) => s.platformCanaryPassed);
  const minDurationDays = Math.min(...input.sites.map((s) => s.durationDays));
  const decisionRulePassed =
    invVarSum >= minInfo &&
    pValue <= alpha &&
    (weightedCiLower95 > 0 || weightedCiUpper95 < 0);

  if (!allAllocatorLogged) reasons.push('allocator_not_logged_before_outcomes');
  if (!allPreregLocked) reasons.push('prereg_not_locked');
  if (!allIntegrityPass) reasons.push('integrity_not_pass');
  if (!allCanaryPassed) reasons.push('platform_canary_failed');
  if (minDurationDays < 14) reasons.push('min_duration_lt_14d');
  if (!decisionRulePassed) reasons.push('aggregate_information_or_significance_unmet');

  const classTenantProven =
    allAllocatorLogged &&
    allPreregLocked &&
    allIntegrityPass &&
    allCanaryPassed &&
    minDurationDays >= 14 &&
    decisionRulePassed;

  const provenPredicate: ProvenPredicateResult | null = classTenantProven
    ? {
        predicate: 'multi_site',
        passed: true,
        allocator_logged_before_outcomes: true,
        prereg_locked: true,
        integrity_status: 'pass',
        decision_rule_passed: true,
        randomisation_audit_p: pValue,
        alpha,
        duration_days: minDurationDays,
        platform_canary_passed: true,
        evaluated_at: input.evaluatedAtIso,
      }
    : null;

  // Prediction interval for a NEW unseen site under ALL 3 skeptical prior scales (§9.7)
  // Posterior mean shrunk toward 0 under N(0, priorSd^2); prediction variance includes tau^2 + posteriorVar
  const newSitePredictionIntervals: PriorScalePredictionInterval[] = priorScales.map(
    (priorSd) => {
      const priorVar = priorSd * priorSd;
      const obsVar = weightedVar + betweenSiteTauSquared / input.sites.length;
      const postPrecision = 1 / priorVar + 1 / Math.max(1e-12, obsVar);
      const postVar = 1 / postPrecision;
      const postMean = postVar * (weightedMean / Math.max(1e-12, obsVar));

      // Predictive variance for a brand-new site = postVar + betweenSiteTauSquared
      // Small-sample t-like inflation factor for k sites (k - 1 df approximated)
      const tMultiplier =
        input.sites.length <= 2
          ? 4.303
          : input.sites.length <= 3
            ? 3.182
            : input.sites.length <= 5
              ? 2.571
              : 2.131;
      const predSd = Math.sqrt(postVar + betweenSiteTauSquared);
      const predictionLower95 = postMean - tMultiplier * predSd;
      const predictionUpper95 = postMean + tMultiplier * predSd;
      const direction: 'positive' | 'negative' | 'crosses_zero' =
        predictionLower95 > 0
          ? 'positive'
          : predictionUpper95 < 0
            ? 'negative'
            : 'crosses_zero';

      return {
        priorSd,
        posteriorMean: postMean,
        predictionLower95,
        predictionUpper95,
        excludesZero: direction !== 'crosses_zero',
        direction,
      };
    }
  );

  const firstDir = newSitePredictionIntervals[0]?.direction;
  const canExtrapolateToNewSite =
    classTenantProven &&
    newSitePredictionIntervals.length >= 3 &&
    firstDir !== undefined &&
    firstDir !== 'crosses_zero' &&
    newSitePredictionIntervals.every(
      (pi) => pi.excludesZero && pi.direction === firstDir
    );

  if (!canExtrapolateToNewSite) {
    reasons.push('new_site_prediction_interval_crosses_zero_under_skeptical_priors');
  }

  return {
    metaId: input.metaId,
    tenantId: input.tenantId,
    interventionClass: input.interventionClass,
    siteCount: input.sites.length,
    registeredSitesAverageValid: true,
    weightedAverageEffect: weightedMean,
    weightedAverageSe: weightedSe,
    weightedCiLower95,
    weightedCiUpper95,
    betweenSiteTauSquared,
    aggregateInformation: invVarSum,
    classTenantEvidenceLevel: classTenantProven ? 'proven' : 'observed',
    provenPredicate,
    newSitePredictionIntervals,
    canExtrapolateToNewSite,
    reasons,
  };
}
