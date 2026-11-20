/**
 * UGOKI LINK v2 — Randomized 3-Arm Parallel Run Controller (§4.11 / tel.G18 / N4)
 *
 * Implements:
 * - Deterministic per-PV randomized 3-way split (`v2_only` / `v3_only` / `both`)
 *   plus independent 2-second audit sub-arm (`audit_2s`) for tail-loss measurement
 * - Exact Pearson chi-square SRM detection (closed-form p-value for df = 2)
 * - Strict anti-double-counting guard preventing `collection_gen = 'legacy'` and
 *   `collection_gen = 'v3'` rows from ever being summed together
 */

import { sha256Hex } from '../../../packages/contract/schema';

export const PARALLEL_RUN_ARMS = ['v2_only', 'v3_only', 'both'] as const;
export type ParallelRunArm = (typeof PARALLEL_RUN_ARMS)[number];

/** Bitflags written into `TelemetryFrame.arm_bits` (tag 17). */
export const ARM_BIT_V2_ONLY = 1 << 0;
export const ARM_BIT_V3_ONLY = 1 << 1;
export const ARM_BIT_BOTH = 1 << 2;
export const ARM_BIT_AUDIT_2S = 1 << 3;

export interface ParallelRunConfig {
  readonly tenantId: string;
  readonly siteId: string;
  readonly salt: string;
  /** Target arm proportions [v2_only, v3_only, both]; defaults to equal thirds. */
  readonly armWeights?: readonly [number, number, number];
  /** Share of v3-active PVs assigned to the 2-second audit flush sub-arm (default 0.13 per §4.4). */
  readonly audit2sShare?: number;
  /** SRM alert threshold p-value (default 0.001). */
  readonly srmAlpha?: number;
}

export interface ParallelRunAssignment {
  readonly tenantId: string;
  readonly siteId: string;
  readonly unitId: string;
  readonly arm: ParallelRunArm;
  readonly audit2s: boolean;
  readonly armBits: number;
  readonly shouldLoadV2: boolean;
  readonly shouldLoadV3: boolean;
  readonly heartbeatFloorSec: number | null;
}

export interface ParallelRunArmCounts {
  readonly v2_only: number;
  readonly v3_only: number;
  readonly both: number;
}

export interface SrmCheckResult {
  readonly totalObserved: number;
  readonly expectedCounts: ParallelRunArmCounts;
  readonly observedCounts: ParallelRunArmCounts;
  readonly chiSquare: number;
  readonly degreesOfFreedom: 2;
  readonly pValue: number;
  readonly alpha: number;
  readonly srmDetected: boolean;
}

export interface DualArmObservation {
  readonly tenantId: string;
  readonly siteId: string;
  readonly arm: ParallelRunArm;
  readonly collectionGen: 'legacy' | 'v3';
  readonly unitKey: string;
  readonly v2SessionKey?: string;
  readonly v2PageLoadOrdinal?: number;
  readonly v3PvId?: string;
}

export class DoubleCountGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DoubleCountGuardError';
  }
}

function hashUnitToUniform01(input: string): number {
  const hex = sha256Hex(input).slice(0, 8);
  const u32 = Number.parseInt(hex, 16) >>> 0;
  return u32 / 4294967296;
}

function validateWeights(
  weights: readonly [number, number, number]
): readonly [number, number, number] {
  const [w0, w1, w2] = weights;
  const sum = w0 + w1 + w2;
  if (w0 <= 0 || w1 <= 0 || w2 <= 0 || Math.abs(sum - 1) > 1e-6) {
    throw new Error(
      `Invalid parallel run arm weights [${weights.join(', ')}]: each must be > 0 and sum to 1`
    );
  }
  return weights;
}

/**
 * Computes exact SRM chi-square test for 3 arms (df = 2).
 * For chi-square with df = 2, the exact upper-tail survival function is `exp(-chi2 / 2)`.
 */
export function detectParallelRunSrm(
  observedCounts: ParallelRunArmCounts,
  expectedWeights: readonly [number, number, number] = [1 / 3, 1 / 3, 1 / 3],
  alpha = 0.001
): SrmCheckResult {
  const [w0, w1, w2] = validateWeights(expectedWeights);
  const total =
    observedCounts.v2_only + observedCounts.v3_only + observedCounts.both;

  if (total === 0) {
    return {
      totalObserved: 0,
      expectedCounts: { v2_only: 0, v3_only: 0, both: 0 },
      observedCounts,
      chiSquare: 0,
      degreesOfFreedom: 2,
      pValue: 1,
      alpha,
      srmDetected: false,
    };
  }

  const e0 = total * w0;
  const e1 = total * w1;
  const e2 = total * w2;

  const chiSquare =
    ((observedCounts.v2_only - e0) ** 2) / e0 +
    ((observedCounts.v3_only - e1) ** 2) / e1 +
    ((observedCounts.both - e2) ** 2) / e2;

  const pValue = Math.exp(-chiSquare / 2);

  return {
    totalObserved: total,
    expectedCounts: { v2_only: e0, v3_only: e1, both: e2 },
    observedCounts,
    chiSquare: Number(chiSquare.toFixed(6)),
    degreesOfFreedom: 2,
    pValue,
    alpha,
    srmDetected: pValue < alpha,
  };
}

/**
 * Guard preventing silent summation of `legacy` (v2) and `v3` rows (§4.11 / `tel.M4`).
 */
export function assertNoLegacyV3Mix(
  rows: ReadonlyArray<{ readonly collectionGen: 'legacy' | 'v3' }>
): 'legacy' | 'v3' | 'empty' {
  let seenLegacy = false;
  let seenV3 = false;
  for (const r of rows) {
    if (r.collectionGen === 'legacy') seenLegacy = true;
    else seenV3 = true;
    if (seenLegacy && seenV3) {
      throw new DoubleCountGuardError(
        'Forbidden sum of collection_gen="legacy" and collection_gen="v3" rows (§4.11 / store.M11)'
      );
    }
  }
  if (seenLegacy) return 'legacy';
  if (seenV3) return 'v3';
  return 'empty';
}

export class ParallelRunController {
  public readonly tenantId: string;
  public readonly siteId: string;
  private readonly salt: string;
  private readonly weights: readonly [number, number, number];
  private readonly audit2sShare: number;
  private readonly srmAlpha: number;

  private readonly assignedCounts: { v2_only: number; v3_only: number; both: number } = {
    v2_only: 0,
    v3_only: 0,
    both: 0,
  };
  private readonly seenUnits = new Map<string, ParallelRunAssignment>();
  private readonly bothPairs = new Map<
    string,
    { legacySeen: boolean; v3Seen: boolean }
  >();

  public constructor(config: ParallelRunConfig) {
    this.tenantId = config.tenantId;
    this.siteId = config.siteId;
    this.salt = config.salt;
    this.weights = validateWeights(config.armWeights ?? [1 / 3, 1 / 3, 1 / 3]);
    this.audit2sShare = config.audit2sShare ?? 0.13;
    this.srmAlpha = config.srmAlpha ?? 0.001;
  }

  /**
   * Deterministically assigns a PV unit to `v2_only` | `v3_only` | `both`,
   * plus independent 2-second audit sub-arm on v3-active arms.
   * Re-assigning the same `unitId` returns the identical assignment without double-counting.
   */
  public assign(unitId: string): ParallelRunAssignment {
    const existing = this.seenUnits.get(unitId);
    if (existing) {
      return existing;
    }

    const uArm = hashUnitToUniform01(
      `arm:${this.salt}:${this.tenantId}:${this.siteId}:${unitId}`
    );
    const [w0, w1] = this.weights;
    let arm: ParallelRunArm;
    let armBits: number;
    if (uArm < w0) {
      arm = 'v2_only';
      armBits = ARM_BIT_V2_ONLY;
    } else if (uArm < w0 + w1) {
      arm = 'v3_only';
      armBits = ARM_BIT_V3_ONLY;
    } else {
      arm = 'both';
      armBits = ARM_BIT_BOTH;
    }

    const shouldLoadV2 = arm === 'v2_only' || arm === 'both';
    const shouldLoadV3 = arm === 'v3_only' || arm === 'both';

    // Independent draw for 2-second audit sub-arm (only meaningful when v3 runs)
    const uAudit = hashUnitToUniform01(
      `audit:${this.salt}:${this.tenantId}:${this.siteId}:${unitId}`
    );
    const audit2s = shouldLoadV3 && uAudit < this.audit2sShare;
    if (audit2s) {
      armBits |= ARM_BIT_AUDIT_2S;
    }

    const assignment: ParallelRunAssignment = {
      tenantId: this.tenantId,
      siteId: this.siteId,
      unitId,
      arm,
      audit2s,
      armBits,
      shouldLoadV2,
      shouldLoadV3,
      heartbeatFloorSec: audit2s ? 2 : null,
    };

    this.seenUnits.set(unitId, assignment);
    this.assignedCounts[arm] += 1;
    return assignment;
  }

  /**
   * Records an incoming parallel-run observation and enforces strict anti-double-counting:
   * - `v2_only` accepts ONLY `legacy` rows
   * - `v3_only` accepts ONLY `v3` rows
   * - `both` pairs the `legacy` and `v3` records under one `unitKey` so they are
   *   used for calibration pairing ONLY and counted as 1 unique PV (never 2!).
   */
  public recordObservation(obs: DualArmObservation): {
    readonly accepted: boolean;
    readonly countTowardCanonicalPv: boolean;
    readonly pairedComplete: boolean;
    readonly reason?: string;
  } {
    if (obs.tenantId !== this.tenantId || obs.siteId !== this.siteId) {
      return {
        accepted: false,
        countTowardCanonicalPv: false,
        pairedComplete: false,
        reason: 'scope_mismatch',
      };
    }

    if (obs.arm === 'v2_only' && obs.collectionGen !== 'legacy') {
      return {
        accepted: false,
        countTowardCanonicalPv: false,
        pairedComplete: false,
        reason: 'arm_contamination_v3_on_v2_only',
      };
    }
    if (obs.arm === 'v3_only' && obs.collectionGen !== 'v3') {
      return {
        accepted: false,
        countTowardCanonicalPv: false,
        pairedComplete: false,
        reason: 'arm_contamination_legacy_on_v3_only',
      };
    }

    if (obs.arm !== 'both') {
      return {
        accepted: true,
        countTowardCanonicalPv: true,
        pairedComplete: false,
      };
    }

    const existing = this.bothPairs.get(obs.unitKey) ?? {
      legacySeen: false,
      v3Seen: false,
    };
    const wasAlreadyCounted = existing.legacySeen || existing.v3Seen;
    if (obs.collectionGen === 'legacy') {
      existing.legacySeen = true;
    } else {
      existing.v3Seen = true;
    }
    this.bothPairs.set(obs.unitKey, existing);

    return {
      accepted: true,
      // On `both`, only the FIRST arrival for a given `unitKey` increments unique PV count!
      countTowardCanonicalPv: !wasAlreadyCounted,
      pairedComplete: existing.legacySeen && existing.v3Seen,
    };
  }

  public getArmCounts(): ParallelRunArmCounts {
    return { ...this.assignedCounts };
  }

  public checkSrm(): SrmCheckResult {
    return detectParallelRunSrm(
      this.assignedCounts,
      this.weights,
      this.srmAlpha
    );
  }
}
