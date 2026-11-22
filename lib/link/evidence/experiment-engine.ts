/**
 * UGOKI LINK v2 — Experiment Engine: Pre-Registration Lock, Interim Alpha Spending,
 * CUPED Variance Reduction, 1,000-Run Placebo Test (`ev.G-6`), and Dual-Register LORD++ FDR (§9.3–§9.5, §9.11)
 */

import { CONSTANTS_LEDGER } from '@/packages/contract/ledgers';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import { drawUniformU } from '@/lib/link/allocator';

// =========================================================================
// 1. Pre-Registration Lock (Frozen Before First Allocation, §9.4 / §9.5 / §9.10)
// =========================================================================

export interface ExperimentPreregistrationInput {
  readonly experimentId: string;
  readonly siteId: string;
  readonly tenantId: string;
  readonly registerKind: 'human_approved' | 'autonomy_stream';
  readonly hypothesis: string;
  readonly primaryMetric: string;
  readonly secondaryMetrics: ReadonlyArray<string>;
  readonly guardrailMetrics: ReadonlyArray<string>;
  readonly plannedNPerArm: number;
  readonly alpha: number; // default 0.05
  readonly targetMdeRelative: number;
  readonly cupedTheta: number | null; // frozen BEFORE first allocation
  readonly cupedCovariateName: string | null;
  readonly firstAllocationAtIso: string | null;
}

export interface LockedPreregistration extends ExperimentPreregistrationInput {
  readonly locked: true;
  readonly lockedAtIso: string;
  readonly preregHash: string;
}

export function lockPreregistration(
  input: ExperimentPreregistrationInput,
  now: Date = new Date()
): LockedPreregistration {
  if (input.firstAllocationAtIso !== null && new Date(input.firstAllocationAtIso).getTime() <= now.getTime()) {
    throw new Error(
      `PREREG_LOCK_AFTER_ALLOCATION_FORBIDDEN: Experiment ${input.experimentId} already started allocation at ${input.firstAllocationAtIso}`
    );
  }
  if (!input.primaryMetric.trim()) {
    throw new Error('Exactly one primaryMetric is required for pre-registration (§9.11)');
  }
  if (input.plannedNPerArm <= 0) {
    throw new Error('plannedNPerArm must be positive');
  }

  const lockedAtIso = now.toISOString();
  const preregHash = sha256Hex(
    canonicalJson({
      experimentId: input.experimentId,
      siteId: input.siteId,
      tenantId: input.tenantId,
      registerKind: input.registerKind,
      hypothesis: input.hypothesis,
      primaryMetric: input.primaryMetric,
      secondaryMetrics: [...input.secondaryMetrics].sort(),
      guardrailMetrics: [...input.guardrailMetrics].sort(),
      plannedNPerArm: input.plannedNPerArm,
      alpha: input.alpha,
      targetMdeRelative: input.targetMdeRelative,
      cupedTheta: input.cupedTheta,
      cupedCovariateName: input.cupedCovariateName,
    })
  );

  return Object.freeze({
    ...input,
    locked: true as const,
    lockedAtIso,
    preregHash,
  });
}

// =========================================================================
// 2. Interim Alpha Spending Schedule (0.10 / 0.05 / 0.05 / 0.80 -> Sum === 1.0, §9.4)
// =========================================================================

export type InterimLookStage = 'always_valid' | 'info_50' | 'info_75' | 'final';

export const ALPHA_SPLIT_FRACTIONS: Readonly<Record<InterimLookStage, number>> = Object.freeze({
  always_valid: 0.1,
  info_50: 0.05,
  info_75: 0.05,
  final: 0.8,
});

export function getStageAlphaBudget(totalAlpha: number, stage: InterimLookStage): number {
  return totalAlpha * ALPHA_SPLIT_FRACTIONS[stage];
}

export function verifyAlphaSplitSumsToOne(): boolean {
  const sum =
    ALPHA_SPLIT_FRACTIONS.always_valid +
    ALPHA_SPLIT_FRACTIONS.info_50 +
    ALPHA_SPLIT_FRACTIONS.info_75 +
    ALPHA_SPLIT_FRACTIONS.final;
  return Math.abs(sum - 1.0) < 1e-12;
}

// Normal CDF / survival approximation (Abramowitz & Stegun 7.1.26, max error < 1.5e-7)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return sign * y;
}

export function twoSidedNormalPValue(z: number): number {
  return Math.max(0, Math.min(1, 1 - erf(Math.abs(z) / Math.SQRT2)));
}

export interface AlwaysValidMsprtInput {
  /** Point estimate of treatment effect $\hat{\theta}_t$. */
  readonly effectEstimate: number;
  /** Sampling variance $V_t = \widehat{\mathrm{SE}}_t^2 > 0$ of $\hat{\theta}_t$. */
  readonly sampleVariance: number;
  /** Normal mixture prior variance $\tau^2 > 0$ (Johari et al., 2017). */
  readonly mixingVarianceTauSq: number;
  /** Stage / test significance level $\alpha \in (0, 1)$. */
  readonly alpha: number;
  /** Running maximum $\max_{s < t} \Lambda_s$ across prior looks (optional). */
  readonly priorMaxLambda?: number;
}

export interface AlwaysValidMsprtResult {
  readonly lambdaT: number;
  readonly runningMaxLambda: number;
  readonly anytimePValue: number;
  readonly confidenceSequenceHalfWidth: number;
  readonly ciLower: number;
  readonly ciUpper: number;
  readonly crossesBoundary: boolean;
}

/**
 * Johari, Koomen, Pekelis & Walsh (2017) mixture Sequential Probability Ratio Test (mSPRT):
 *
 * $$\Lambda_t = \sqrt{\frac{V_t}{V_t + \tau^2}} \exp\!\left(\frac{\hat{\theta}_t^2 \tau^2}{2 V_t (V_t + \tau^2)}\right)$$
 *
 * Under $H_0: \theta = 0$, $\{\Lambda_t\}_{t \ge 1}$ is a non-negative martingale with $\mathbb{E}_0[\Lambda_1] = 1$,
 * so by Ville's maximal inequality $\mathbb{P}_0(\sup_{t \ge 1} \Lambda_t \ge 1/\alpha) \le \alpha$ under
 * arbitrary continuous peeking (`[H-06]`).
 */
export function evaluateAlwaysValidMsprt(input: AlwaysValidMsprtInput): AlwaysValidMsprtResult {
  const vT = Math.max(1e-12, input.sampleVariance);
  const tauSq = Math.max(1e-12, input.mixingVarianceTauSq);
  const alpha = Math.min(0.999999, Math.max(1e-12, input.alpha));
  const thetaHat = input.effectEstimate;

  const varianceRatio = vT / (vT + tauSq);
  const exponent = Math.min(
    700,
    (thetaHat * thetaHat * tauSq) / (2 * vT * (vT + tauSq))
  );
  const lambdaT = Math.sqrt(varianceRatio) * Math.exp(exponent);
  const runningMaxLambda = Math.max(input.priorMaxLambda ?? 0, lambdaT);
  const anytimePValue = Math.min(1, 1 / Math.max(1e-300, runningMaxLambda));

  const logTerm = Math.max(
    0,
    Math.log((1 / alpha) * Math.sqrt((vT + tauSq) / vT))
  );
  const halfWidth = Math.sqrt(((2 * vT * (vT + tauSq)) / tauSq) * logTerm);

  return {
    lambdaT,
    runningMaxLambda,
    anytimePValue,
    confidenceSequenceHalfWidth: halfWidth,
    ciLower: thetaHat - halfWidth,
    ciUpper: thetaHat + halfWidth,
    crossesBoundary: anytimePValue <= alpha,
  };
}

export function evaluateInterimLook(params: {
  readonly totalAlpha: number;
  readonly stage: InterimLookStage;
  readonly zStatistic: number;
  /** Optional explicit sampling variance $V_t = \mathrm{SE}_t^2$ for `always_valid` mSPRT (`[H-06]`). */
  readonly sampleVariance?: number;
  /** Optional explicit point estimate $\hat{\theta}_t$ (defaults to $z_t \sqrt{V_t}$). */
  readonly effectEstimate?: number;
  /** Optional mSPRT mixing variance $\tau^2$ (defaults to `0.04`). */
  readonly mixingVarianceTauSq?: number;
  /** Optional running $\max_{s < t} \Lambda_s$ for sequential `always_valid` monitoring. */
  readonly priorMaxLambda?: number;
}): {
  readonly stage: InterimLookStage;
  readonly stageAlpha: number;
  readonly twoSidedPValue: number;
  readonly crossesBoundary: boolean;
  readonly msprtLambda?: number;
  readonly confidenceSequenceHalfWidth?: number;
} {
  const stageAlpha = getStageAlphaBudget(params.totalAlpha, params.stage);

  // [H-06]: `always_valid` look MUST use Johari et al. (2017) mSPRT, never fixed-horizon normal z-test!
  if (params.stage === 'always_valid') {
    const vT = Math.max(1e-12, params.sampleVariance ?? 0.01);
    const tauSq = Math.max(1e-12, params.mixingVarianceTauSq ?? 0.04);
    const thetaHat =
      params.effectEstimate !== undefined
        ? params.effectEstimate
        : params.zStatistic * Math.sqrt(vT);
    const msprt = evaluateAlwaysValidMsprt({
      effectEstimate: thetaHat,
      sampleVariance: vT,
      mixingVarianceTauSq: tauSq,
      alpha: stageAlpha,
      priorMaxLambda: params.priorMaxLambda,
    });
    return {
      stage: params.stage,
      stageAlpha,
      twoSidedPValue: msprt.anytimePValue,
      crossesBoundary: msprt.crossesBoundary,
      msprtLambda: msprt.lambdaT,
      confidenceSequenceHalfWidth: msprt.confidenceSequenceHalfWidth,
    };
  }

  const p = twoSidedNormalPValue(params.zStatistic);
  return {
    stage: params.stage,
    stageAlpha,
    twoSidedPValue: p,
    crossesBoundary: p <= stageAlpha,
  };
}

// =========================================================================
// 3. CUPED Variance Reduction & Placebo Speedup Gate (> 1.05 Lower Bound, §9.5)
// =========================================================================

export interface CupedObservation {
  readonly preCovariate: number;
  readonly outcome: number;
  readonly stratumKey?: string; // e.g. `landingPage:device`
}

export interface CupedEvaluationResult {
  readonly theta: number;
  readonly rawVariance: number;
  readonly adjustedVariance: number;
  readonly sampleSizeSpeedupMultiplier: number;
  /** Conservative 95% lower bound on variance-reduction speedup. */
  readonly speedupLower95: number;
  /** Only incorporated into planner when `speedupLower95 > 1.05` (§9.5). */
  readonly eligibleForPlannerReduction: boolean;
}

export function evaluateCupedVarianceReduction(
  rows: ReadonlyArray<CupedObservation>
): CupedEvaluationResult {
  const n = rows.length;
  if (n < 30) {
    return {
      theta: 0,
      rawVariance: 0,
      adjustedVariance: 0,
      sampleSizeSpeedupMultiplier: 1,
      speedupLower95: 1,
      eligibleForPlannerReduction: false,
    };
  }

  const meanX = rows.reduce((a, r) => a + r.preCovariate, 0) / n;
  const meanY = rows.reduce((a, r) => a + r.outcome, 0) / n;

  let varX = 0;
  let varY = 0;
  let covXY = 0;
  for (const r of rows) {
    const dx = r.preCovariate - meanX;
    const dy = r.outcome - meanY;
    varX += dx * dx;
    varY += dy * dy;
    covXY += dx * dy;
  }
  varX /= n - 1;
  varY /= n - 1;
  covXY /= n - 1;

  if (varX <= 1e-12 || varY <= 1e-12) {
    return {
      theta: 0,
      rawVariance: varY,
      adjustedVariance: varY,
      sampleSizeSpeedupMultiplier: 1,
      speedupLower95: 1,
      eligibleForPlannerReduction: false,
    };
  }

  const theta = covXY / varX;
  const r = covXY / Math.sqrt(varX * varY);
  const r2 = Math.min(0.99, Math.max(0, r * r));
  const adjustedVariance = varY * (1 - r2);
  const speedup = 1 / Math.max(1e-6, 1 - r2);

  // Fisher-z 95% lower bound on |r| -> conservative lower bound on 1 / (1 - r^2)
  const absR = Math.min(0.9999, Math.abs(r));
  const zR = 0.5 * Math.log((1 + absR) / (1 - absR));
  const seZ = 1 / Math.sqrt(Math.max(1, n - 3));
  const zLow = Math.max(0, zR - 1.959963984540054 * seZ);
  const rLow = (Math.exp(2 * zLow) - 1) / (Math.exp(2 * zLow) + 1);
  const speedupLower95 = 1 / Math.max(1e-6, 1 - rLow * rLow);

  return {
    theta: Number(theta.toFixed(6)),
    rawVariance: varY,
    adjustedVariance,
    sampleSizeSpeedupMultiplier: Number(speedup.toFixed(4)),
    speedupLower95: Number(speedupLower95.toFixed(4)),
    eligibleForPlannerReduction: speedupLower95 > 1.05,
  };
}

// =========================================================================
// 4. `ev.G-6`: 1,000-Run Placebo Test (Rejection Rate in [0.037, 0.064] at α=0.05)
// =========================================================================

export interface PlaceboUnitOutcome {
  readonly unitId: string;
  readonly outcome: number;
}

export interface Placebo1000Report {
  readonly gateId: 'ev.G-6';
  readonly runs: number;
  readonly alpha: number;
  readonly significantRejections: number;
  readonly rejectionRate: number;
  readonly allowedBand: readonly [number, number];
  readonly passed: boolean;
}

/**
 * Re-hashes unit outcomes across 1,000 independent HMAC keys (placebo splits)
 * and verifies that nominal α=0.05 two-sided Welch t-test rejection rate falls inside `[0.037, 0.064]` (`ev.G-6`).
 */
export function runPlacebo1000Test(params: {
  readonly units: ReadonlyArray<PlaceboUnitOutcome>;
  readonly runs?: number;
  readonly alpha?: number;
  readonly baseSeed?: string;
}): Placebo1000Report {
  const runs = params.runs ?? 1000;
  const alpha = params.alpha ?? 0.05;
  const baseSeed = params.baseSeed ?? 'ugokilink_placebo_g6_v1';

  const bandEntry = CONSTANTS_LEDGER.find((c) => c.id === 'ev.placebo_reject_band');
  const allowedBand: readonly [number, number] =
    bandEntry && Array.isArray(bandEntry.value) && bandEntry.value.length === 2
      ? [Number(bandEntry.value[0]), Number(bandEntry.value[1])]
      : [0.037, 0.064];

  let significantRejections = 0;

  for (let r = 0; r < runs; r++) {
    const key = `${baseSeed}:run_${r}`;
    let n0 = 0;
    let sum0 = 0;
    let sq0 = 0;
    let n1 = 0;
    let sum1 = 0;
    let sq1 = 0;

    for (const u of params.units) {
      const draw = drawUniformU(key, u.unitId);
      if (draw < 0.5) {
        n0 += 1;
        sum0 += u.outcome;
        sq0 += u.outcome * u.outcome;
      } else {
        n1 += 1;
        sum1 += u.outcome;
        sq1 += u.outcome * u.outcome;
      }
    }

    if (n0 < 2 || n1 < 2) continue;
    const m0 = sum0 / n0;
    const m1 = sum1 / n1;
    const v0 = Math.max(0, (sq0 - n0 * m0 * m0) / (n0 - 1));
    const v1 = Math.max(0, (sq1 - n1 * m1 * m1) / (n1 - 1));
    const se = Math.sqrt(v0 / n0 + v1 / n1);
    if (se <= 1e-12) continue;

    const z = (m1 - m0) / se;
    const p = twoSidedNormalPValue(z);
    if (p <= alpha) {
      significantRejections += 1;
    }
  }

  const rejectionRate = runs > 0 ? significantRejections / runs : 0;
  return {
    gateId: 'ev.G-6',
    runs,
    alpha,
    significantRejections,
    rejectionRate,
    allowedBand,
    passed: rejectionRate >= allowedBand[0] && rejectionRate <= allowedBand[1],
  };
}

// =========================================================================
// 5. Dual-Register Multiple Testing Controller (Human vs Autonomy LORD++ FDR <= 10%)
// =========================================================================

export interface RegisterEntry {
  readonly experimentId: string;
  readonly registerKind: 'human_approved' | 'autonomy_stream';
  readonly pValue: number;
  readonly thresholdAlpha: number;
  readonly rejectedNull: boolean;
  readonly recordedAt: string;
}

/**
 * Separates human-approved experiments (Register H) from autonomy-envelope experiments
 * (Register S, controlled with online LORD++ FDR <= 0.10 per §9.11 / `ev.G-16`).
 */
export class DualExperimentLedger {
  private readonly humanRegister: RegisterEntry[] = [];
  private readonly autonomyRegister: RegisterEntry[] = [];
  private readonly targetFdr: number;
  private readonly initialWealth: number;
  /** Full history of discovery indices $\tau_1 < \tau_2 < \dots$ (`[H-05]`). */
  private readonly autonomyDiscoveryTimes: number[] = [];

  constructor(targetFdr = 0.1, initialWealth?: number) {
    this.targetFdr = Math.min(Math.max(0.01, targetFdr), 0.1);
    const defaultW0 = this.targetFdr * 0.5;
    this.initialWealth =
      initialWealth !== undefined && initialWealth > 0 && initialWealth < this.targetFdr
        ? initialWealth
        : defaultW0;
  }

  private gammaWeight(lag: number): number {
    // Summable decay sequence γ_m = 6 / (π^2 * m^2) summing strictly to 1 over m >= 1
    if (lag < 1) return 0;
    return 6 / (Math.PI * Math.PI * lag * lag);
  }

  public recordHumanExperiment(params: {
    readonly experimentId: string;
    readonly pValue: number;
    readonly alpha?: number;
    readonly now?: Date;
  }): RegisterEntry {
    const threshold = params.alpha ?? 0.05;
    const entry: RegisterEntry = {
      experimentId: params.experimentId,
      registerKind: 'human_approved',
      pValue: params.pValue,
      thresholdAlpha: threshold,
      rejectedNull: params.pValue <= threshold,
      recordedAt: (params.now ?? new Date()).toISOString(),
    };
    this.humanRegister.push(entry);
    return entry;
  }

  /**
   * Exact Javanmard & Montanari (2018) LORD++ step for autonomy-envelope stream (`[H-05]`):
   *
   * $$\alpha_t = \gamma_t W_0 + (\alpha - W_0)\gamma_{t - \tau_1} + \alpha \sum_{j \ge 2:\, \tau_j < t} \gamma_{t - \tau_j}$$
   *
   * where $\tau_1$ is the FIRST rejection time (earning $\alpha - W_0$, never $\alpha$) and ALL
   * subsequent rejection times $\tau_2, \tau_3, \dots$ are retained and summed at every step $t$,
   * guaranteeing $\sum_{s \le t} \alpha_s \le \max(1, R_t)\alpha$ and online $\mathrm{FDR} \le \alpha$.
   */
  public recordAutonomyExperiment(params: {
    readonly experimentId: string;
    readonly pValue: number;
    readonly now?: Date;
  }): RegisterEntry {
    const t = this.autonomyRegister.length + 1;

    let alphaT = this.gammaWeight(t) * this.initialWealth;
    if (this.autonomyDiscoveryTimes.length >= 1) {
      const tau1 = this.autonomyDiscoveryTimes[0];
      alphaT += (this.targetFdr - this.initialWealth) * this.gammaWeight(t - tau1);
      for (let j = 1; j < this.autonomyDiscoveryTimes.length; j += 1) {
        const tauJ = this.autonomyDiscoveryTimes[j];
        alphaT += this.targetFdr * this.gammaWeight(t - tauJ);
      }
    }

    const rejected = params.pValue <= alphaT;
    if (rejected) {
      this.autonomyDiscoveryTimes.push(t);
    }

    const entry: RegisterEntry = {
      experimentId: params.experimentId,
      registerKind: 'autonomy_stream',
      pValue: params.pValue,
      thresholdAlpha: alphaT,
      rejectedNull: rejected,
      recordedAt: (params.now ?? new Date()).toISOString(),
    };
    this.autonomyRegister.push(entry);
    return entry;
  }

  public getRegisters(): {
    readonly human: ReadonlyArray<RegisterEntry>;
    readonly autonomy: ReadonlyArray<RegisterEntry>;
    readonly autonomyTargetFdr: number;
    readonly autonomyInitialWealth: number;
    readonly autonomyDiscoveryTimes: ReadonlyArray<number>;
  } {
    return {
      human: [...this.humanRegister],
      autonomy: [...this.autonomyRegister],
      autonomyTargetFdr: this.targetFdr,
      autonomyInitialWealth: this.initialWealth,
      autonomyDiscoveryTimes: [...this.autonomyDiscoveryTimes],
    };
  }
}
