/**
 * UGOKI LINK v2 — Legacy-vs-v3 Ratio ±5% Calibration Judge (§4.11 / tel.G17 / tel.G18)
 *
 * Evaluates paired `both`-arm observations per `(metric, deviceClass, browserFamily)`:
 * - Computes ratio `R = sum(v3) / sum(v2)` with 95% confidence interval via either
 *   paired delta-method normal CI or deterministic seeded bootstrap percentile CI
 * - Checks convergence gate `tel.G18`: relative 95% half-width <= 5% (`0.05`)
 * - When not yet converged, reports exact "observed vs required & remaining" counts
 *   into `UnmetGate` for the gate ledger
 * - Tags any calibrated historical legacy series strictly as `evidence: 'inferred'`
 *   and `cannotSumWithV3: true`
 */

import type { UnmetGate } from '../../../packages/contract/response';

export const DEFAULT_CALIBRATION_MAX_REL_HALF_WIDTH = 0.05; // ±5% relative (§4.11 / tel.G18)
export const DEFAULT_CALIBRATION_MIN_PAIRS = 30;

export interface PairedCalibrationSample {
  readonly pairId: string;
  readonly v2Value: number;
  readonly v3Value: number;
}

export interface CalibrationSliceSpec {
  readonly metric: string;
  readonly deviceClass: 'mobile' | 'desktop' | 'tablet';
  readonly browserFamily: string;
  readonly samples: readonly PairedCalibrationSample[];
  readonly method?: 'delta_normal' | 'bootstrap';
  readonly bootstrapIterations?: number;
  readonly maxRelHalfWidth?: number;
  readonly minPairs?: number;
  readonly dailyPairsRate?: number;
}

export interface CalibrationSliceEvaluation {
  readonly metric: string;
  readonly deviceClass: 'mobile' | 'desktop' | 'tablet';
  readonly browserFamily: string;
  readonly method: 'delta_normal' | 'bootstrap';
  readonly nPairs: number;
  readonly sumV2: number;
  readonly sumV3: number;
  readonly ratio: number | null;
  readonly ci95Lower: number | null;
  readonly ci95Upper: number | null;
  readonly relativeHalfWidth: number | null;
  readonly maxAllowedRelHalfWidth: number;
  readonly converged: boolean;
  readonly requiredPairsEstimate: number;
  readonly remainingPairsEstimate: number;
  readonly unmetGate: UnmetGate | null;
}

export interface FullCalibrationGateReport {
  readonly gateId: 'tel.G18';
  readonly allConverged: boolean;
  readonly convergedCount: number;
  readonly totalSlices: number;
  readonly slices: readonly CalibrationSliceEvaluation[];
  readonly unmetGates: readonly UnmetGate[];
}

export interface CalibratedLegacyPoint {
  readonly bucketIso: string;
  readonly rawLegacyValue: number;
  readonly calibratedValue: number;
  readonly ci95Lower: number;
  readonly ci95Upper: number;
  readonly appliedRatio: number;
  readonly evidenceLevel: 'inferred';
  readonly collectionGen: 'legacy';
  readonly cannotSumWithV3: true;
  readonly excludeFromFingerprintJoin: true;
  readonly excludeFromDefaultTraining: true;
}

export interface ConversionParityInput {
  readonly cvKey: string;
  readonly bothArmPvs: number;
  readonly v2Conversions: number;
  readonly v3Conversions: number;
}

export interface ConversionParityResult {
  readonly gateId: 'tel.G17';
  readonly cvKey: string;
  readonly v2Rate: number;
  readonly v3Rate: number;
  readonly diffV3MinusV2: number;
  readonly ci95LowerDiff: number;
  readonly passed: boolean;
  readonly reason: string;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeDeltaNormalRatioCi(
  samples: readonly PairedCalibrationSample[]
): {
  readonly ratio: number;
  readonly lower: number;
  readonly upper: number;
} | null {
  const n = samples.length;
  if (n < 2) return null;

  let sumX = 0; // v2
  let sumY = 0; // v3
  for (let i = 0; i < n; i += 1) {
    sumX += samples[i]!.v2Value;
    sumY += samples[i]!.v3Value;
  }
  if (sumX <= 0 || sumY < 0) return null;

  const meanX = sumX / n;
  const meanY = sumY / n;
  const ratio = meanY / meanX;

  // Delta-method variance of ratio R = meanY / meanX:
  // Var(R) ≈ (1 / (n * meanX^2)) * [ s_Y^2 - 2 R s_XY + R^2 s_X^2 ]
  let ssX = 0;
  let ssY = 0;
  let ssXY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = samples[i]!.v2Value - meanX;
    const dy = samples[i]!.v3Value - meanY;
    ssX += dx * dx;
    ssY += dy * dy;
    ssXY += dx * dy;
  }

  const varX = ssX / (n - 1);
  const varY = ssY / (n - 1);
  const covXY = ssXY / (n - 1);

  const numeratorVar = Math.max(0, varY - 2 * ratio * covXY + ratio * ratio * varX);
  const seRatio = Math.sqrt(numeratorVar / (n * meanX * meanX));
  const z = 1.959963984540054;
  const half = z * seRatio;

  return {
    ratio,
    lower: Math.max(0, ratio - half),
    upper: ratio + half,
  };
}

function computeBootstrapRatioCi(
  samples: readonly PairedCalibrationSample[],
  iterations = 1000,
  seed = 20261120
): {
  readonly ratio: number;
  readonly lower: number;
  readonly upper: number;
} | null {
  const n = samples.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += samples[i]!.v2Value;
    sumY += samples[i]!.v3Value;
  }
  if (sumX <= 0 || sumY < 0) return null;
  const ratio = sumY / sumX;

  const rng = createMulberry32(seed);
  const bootRatios: number[] = [];
  for (let b = 0; b < iterations; b += 1) {
    let bx = 0;
    let by = 0;
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(rng() * n);
      const s = samples[idx]!;
      bx += s.v2Value;
      by += s.v3Value;
    }
    if (bx > 0) {
      bootRatios.push(by / bx);
    }
  }

  if (bootRatios.length < 20) return null;
  bootRatios.sort((a, b) => a - b);
  const loIdx = Math.max(0, Math.floor(bootRatios.length * 0.025));
  const hiIdx = Math.min(bootRatios.length - 1, Math.ceil(bootRatios.length * 0.975) - 1);

  return {
    ratio,
    lower: Math.max(0, bootRatios[loIdx]!),
    upper: bootRatios[hiIdx]!,
  };
}

/**
 * Evaluates a single `(metric, deviceClass, browserFamily)` calibration slice
 * against the ±5% relative 95% half-width gate (`tel.G18`).
 */
export function evaluateCalibrationSlice(
  spec: CalibrationSliceSpec
): CalibrationSliceEvaluation {
  const method = spec.method ?? 'delta_normal';
  const maxRel = spec.maxRelHalfWidth ?? DEFAULT_CALIBRATION_MAX_REL_HALF_WIDTH;
  const minPairs = spec.minPairs ?? DEFAULT_CALIBRATION_MIN_PAIRS;
  const nPairs = spec.samples.length;

  let sumV2 = 0;
  let sumV3 = 0;
  for (const s of spec.samples) {
    sumV2 += s.v2Value;
    sumV3 += s.v3Value;
  }

  const ci =
    method === 'bootstrap'
      ? computeBootstrapRatioCi(spec.samples, spec.bootstrapIterations ?? 1000)
      : computeDeltaNormalRatioCi(spec.samples);

  if (!ci || ci.ratio <= 0 || nPairs < minPairs) {
    const remaining = Math.max(1, minPairs - nPairs);
    const etaDays =
      spec.dailyPairsRate && spec.dailyPairsRate > 0
        ? Math.ceil(remaining / spec.dailyPairsRate)
        : null;

    return {
      metric: spec.metric,
      deviceClass: spec.deviceClass,
      browserFamily: spec.browserFamily,
      method,
      nPairs,
      sumV2,
      sumV3,
      ratio: ci ? Number(ci.ratio.toFixed(6)) : null,
      ci95Lower: ci ? Number(ci.lower.toFixed(6)) : null,
      ci95Upper: ci ? Number(ci.upper.toFixed(6)) : null,
      relativeHalfWidth:
        ci && ci.ratio > 0
          ? Number(((ci.upper - ci.lower) / (2 * ci.ratio)).toFixed(6))
          : null,
      maxAllowedRelHalfWidth: maxRel,
      converged: false,
      requiredPairsEstimate: minPairs,
      remainingPairsEstimate: remaining,
      unmetGate: {
        id: 'tel.G18',
        required: `>= ${minPairs} pairs and rel_half_width <= ${(maxRel * 100).toFixed(1)}%`,
        observed: `${nPairs} pairs (${spec.metric}/${spec.deviceClass}/${spec.browserFamily})`,
        unlock: `Collect ${remaining} additional paired both-arm PVs for ${spec.metric}/${spec.deviceClass}/${spec.browserFamily}`,
        reason: 'insufficient_paired_samples_for_calibration',
        eta:
          etaDays !== null
            ? { min_days: etaDays, max_days: Math.ceil(etaDays * 1.5) }
            : null,
      },
    };
  }

  const relativeHalfWidth = (ci.upper - ci.lower) / (2 * ci.ratio);
  const converged = relativeHalfWidth <= maxRel;

  const requiredPairsEstimate = converged
    ? nPairs
    : Math.max(
        nPairs + 1,
        Math.ceil(nPairs * Math.pow(relativeHalfWidth / maxRel, 2))
      );
  const remainingPairsEstimate = Math.max(0, requiredPairsEstimate - nPairs);
  const etaDays =
    !converged && spec.dailyPairsRate && spec.dailyPairsRate > 0
      ? Math.ceil(remainingPairsEstimate / spec.dailyPairsRate)
      : null;

  const unmetGate: UnmetGate | null = converged
    ? null
    : {
        id: 'tel.G18',
        required: `rel_half_width <= ${(maxRel * 100).toFixed(1)}% (est. ${requiredPairsEstimate} pairs)`,
        observed: `rel_half_width = ${(relativeHalfWidth * 100).toFixed(2)}% at n=${nPairs}`,
        unlock: `Continue parallel run for ~${remainingPairsEstimate} more both-arm pairs on ${spec.metric}/${spec.deviceClass}/${spec.browserFamily}`,
        reason: 'calibration_half_width_exceeds_5pct',
        eta:
          etaDays !== null
            ? { min_days: etaDays, max_days: Math.ceil(etaDays * 1.5) }
            : null,
      };

  return {
    metric: spec.metric,
    deviceClass: spec.deviceClass,
    browserFamily: spec.browserFamily,
    method,
    nPairs,
    sumV2,
    sumV3,
    ratio: Number(ci.ratio.toFixed(6)),
    ci95Lower: Number(ci.lower.toFixed(6)),
    ci95Upper: Number(ci.upper.toFixed(6)),
    relativeHalfWidth: Number(relativeHalfWidth.toFixed(6)),
    maxAllowedRelHalfWidth: maxRel,
    converged,
    requiredPairsEstimate,
    remainingPairsEstimate,
    unmetGate,
  };
}

/**
 * Evaluates all `(metric × device × browserFamily)` slices for `tel.G18`.
 */
export function evaluateCalibrationGate(
  specs: readonly CalibrationSliceSpec[]
): FullCalibrationGateReport {
  const slices = specs.map((s) => evaluateCalibrationSlice(s));
  const unmetGates = slices
    .map((s) => s.unmetGate)
    .filter((g): g is UnmetGate => g !== null);
  const convergedCount = slices.filter((s) => s.converged).length;

  return {
    gateId: 'tel.G18',
    allConverged: slices.length > 0 && unmetGates.length === 0,
    convergedCount,
    totalSlices: slices.length,
    slices,
    unmetGates,
  };
}

/**
 * Applies a converged calibration slice to a historical legacy series, tagging
 * every output point strictly as `evidence: 'inferred'` and `cannotSumWithV3: true`.
 */
export function calibrateLegacySeries(
  slice: CalibrationSliceEvaluation,
  legacySeries: ReadonlyArray<{ readonly bucketIso: string; readonly rawLegacyValue: number }>
): readonly CalibratedLegacyPoint[] {
  if (!slice.converged || slice.ratio === null || slice.ci95Lower === null || slice.ci95Upper === null) {
    throw new Error(
      `Cannot calibrate legacy series before tel.G18 converges for ${slice.metric}/${slice.deviceClass}/${slice.browserFamily}`
    );
  }
  const ratio = slice.ratio;
  const lo = slice.ci95Lower;
  const hi = slice.ci95Upper;

  return legacySeries.map((pt) => ({
    bucketIso: pt.bucketIso,
    rawLegacyValue: pt.rawLegacyValue,
    calibratedValue: Number((pt.rawLegacyValue * ratio).toFixed(4)),
    ci95Lower: Number((pt.rawLegacyValue * lo).toFixed(4)),
    ci95Upper: Number((pt.rawLegacyValue * hi).toFixed(4)),
    appliedRatio: ratio,
    evidenceLevel: 'inferred',
    collectionGen: 'legacy',
    cannotSumWithV3: true,
    excludeFromFingerprintJoin: true,
    excludeFromDefaultTraining: true,
  }));
}

/**
 * `tel.G17` conversion non-inferiority / parity check on the `both` arm:
 * verifies v3 conversion rate is not statistically below v2 within 95% CI.
 */
export function evaluateConversionParityG17(
  input: ConversionParityInput
): ConversionParityResult {
  if (input.bothArmPvs <= 0) {
    return {
      gateId: 'tel.G17',
      cvKey: input.cvKey,
      v2Rate: 0,
      v3Rate: 0,
      diffV3MinusV2: 0,
      ci95LowerDiff: -1,
      passed: false,
      reason: 'zero_both_arm_pvs',
    };
  }

  const p2 = Math.min(1, Math.max(0, input.v2Conversions / input.bothArmPvs));
  const p3 = Math.min(1, Math.max(0, input.v3Conversions / input.bothArmPvs));
  const diff = p3 - p2;
  const se = Math.sqrt(
    (p2 * (1 - p2) + p3 * (1 - p3)) / input.bothArmPvs
  );
  const z = 1.959963984540054;
  // Pass when v3 >= v2 OR v2's upper difference stays within 95% CI (v3 not significantly lower)
  const ci95UpperDiff = diff + z * se;
  const ci95LowerDiff = diff - z * se;
  const passed = ci95UpperDiff >= 0;

  return {
    gateId: 'tel.G17',
    cvKey: input.cvKey,
    v2Rate: Number(p2.toFixed(6)),
    v3Rate: Number(p3.toFixed(6)),
    diffV3MinusV2: Number(diff.toFixed(6)),
    ci95LowerDiff: Number(ci95LowerDiff.toFixed(6)),
    passed,
    reason: passed
      ? 'v3_conversions_non_inferior_to_v2'
      : `v3 conversion rate (${(p3 * 100).toFixed(2)}%) significantly below v2 (${(p2 * 100).toFixed(2)}%)`,
  };
}
