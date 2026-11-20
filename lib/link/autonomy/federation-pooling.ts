/**
 * UGOKI LINK v2 — Cross-Tenant Pooling & Consent-Based Federated Learning (§8.7, §9.7, §11.11)
 *
 * Implements:
 * 1. Strict Lane Separation (§11.11 opening):
 *    - Accepts ONLY `standard_telemetry` derived contributions.
 *    - Immediately rejects `custom_event` and `session_replay` lanes (`ProhibitedPoolingLaneError`).
 *    - Completely forbids raw row-level pooling (`RowLevelPoolingProhibitedError`).
 * 2. Unified Cross-Tenant Public Release Ledger (`CROSS_TENANT_LEDGER`, §8.7 & §9.7):
 *    - `experiment_stat_row`: >= 5 tenants, >= 50 units per arm, max single-tenant weight <= 1/3,
 *      differencing suppression.
 *    - `federated_learning_aggregate`: >= 10 tenants, each split >= 5 tenants & >= 50 units,
 *      max single-tenant weight <= 1/3; publishes ONLY starting priors & benchmark references
 *      (NEVER visitor-level CATE!).
 * 3. Consent & Governance (`D-23`):
 *    - Explicit opt-in only until `D-23` + legal sign-off are recorded; 1-tenant state ALWAYS returns
 *      `status: 'insufficient_data'`.
 *    - Tenant opt-out triggers mandatory retrain deadline within 14 days.
 * 4. Tabular Foundation Model Gate (§8.7):
 *    - Commercially licensed & verified, <= 10,000 rows, 200..5,000 positive examples.
 * 5. Direct connection to Bundle 4-E Japanese open embedding selection (`lib/link/search/jp-embeddings.ts`).
 */

import { requireDecisionEntitled } from '../../../packages/contract/ledgers';
import type { MeasureStatus } from '../../../packages/contract/response';
import {
  DEFAULT_JP_EMBEDDING_CANDIDATES,
  type JapaneseEmbeddingCandidateSpec,
  type SelectedEmbeddingArtifactRecord,
} from '../search/jp-embeddings';

// =========================================================================
// 1. Strict Lane & Row-Level Prohibitions (§8.7, §11.11)
// =========================================================================

export type DataOriginLane = 'standard_telemetry' | 'custom_event' | 'session_replay';

export class ProhibitedPoolingLaneError extends Error {
  public readonly rejectedLane: DataOriginLane;

  constructor(lane: DataOriginLane) {
    super(
      `§11.11 Lane Separation Violation: Cross-tenant pooling and federation accept ONLY "standard_telemetry" (rejected lane: "${lane}").`
    );
    this.name = 'ProhibitedPoolingLaneError';
    this.rejectedLane = lane;
  }
}

export class RowLevelPoolingProhibitedError extends Error {
  constructor() {
    super(
      '§8.7 Prohibition: Raw row-level cross-tenant pooling is strictly prohibited; only aggregate sufficient statistics or histogram sums may leave a tenant boundary.'
    );
    this.name = 'RowLevelPoolingProhibitedError';
  }
}

export function assertStandardTelemetryAggregateOnly(input: {
  readonly originLane: DataOriginLane;
  readonly containsRawRows?: boolean;
}): void {
  if (input.originLane !== 'standard_telemetry') {
    throw new ProhibitedPoolingLaneError(input.originLane);
  }
  if (input.containsRawRows === true) {
    throw new RowLevelPoolingProhibitedError();
  }
}

// =========================================================================
// 2. Unified Cross-Tenant Public Release Ledger Constants (§8.7 / §9.7)
// =========================================================================

export const CROSS_TENANT_POLICY = Object.freeze({
  EXPERIMENT_MIN_TENANTS: 5,
  EXPERIMENT_MIN_UNITS_PER_ARM: 50,
  FEDERATION_MIN_TENANTS: 10,
  FEDERATION_SPLIT_MIN_TENANTS: 5,
  FEDERATION_SPLIT_MIN_UNITS: 50,
  MAX_SINGLE_TENANT_WEIGHT: 1 / 3,
  OPT_OUT_RETRAIN_DEADLINE_DAYS: 14,
  TABULAR_FM_MAX_ROWS: 10_000,
  TABULAR_FM_MIN_POSITIVES: 200,
  TABULAR_FM_MAX_POSITIVES: 5_000,
} as const);

export type CrossTenantFlowKind = 'experiment_stat_row' | 'federated_learning_aggregate';

export interface CrossTenantLedgerRow {
  readonly releaseId: string;
  readonly flowKind: CrossTenantFlowKind;
  readonly evaluatedAtIso: string;
  readonly status: MeasureStatus;
  readonly tenantCount: number;
  readonly maxTenantWeight: number;
  readonly suppressedByDifferencing: boolean;
  readonly publishedArtifacts: readonly ('experiment_summary_row' | 'prior_starting_weights' | 'benchmark_reference')[];
  readonly visitorCatePublished: false;
  readonly reason: string;
}

// =========================================================================
// 3. Experiment Cross-Tenant Release & Federated Histogram Aggregation
// =========================================================================

export interface TenantExperimentContribution {
  readonly tenantId: string;
  readonly originLane: DataOriginLane;
  readonly containsRawRows?: boolean;
  readonly explicitOptIn: boolean;
  readonly controlUnits: number;
  readonly treatmentUnits: number;
  readonly effectEstimate: number;
  readonly standardError: number;
}

export interface CrossTenantExperimentReleaseResult {
  readonly status: MeasureStatus;
  readonly ledgerRow: CrossTenantLedgerRow;
  readonly pooledEffect: number | null;
  readonly pooledSe: number | null;
  readonly tenantCount: number;
  readonly maxSingleTenantWeight: number;
  readonly suppressedCells: readonly string[];
}

export interface TenantFederationSplitContribution {
  readonly tenantId: string;
  readonly originLane: DataOriginLane;
  readonly containsRawRows?: boolean;
  readonly explicitOptIn: boolean;
  readonly splitId: string;
  readonly units: number;
  /** Aggregate histogram / gradient sum vector (NEVER raw visitor rows). */
  readonly gradientSum: readonly number[];
  readonly baselineRate: number;
}

export interface FederatedAggregateReleaseResult {
  readonly status: MeasureStatus;
  readonly ledgerRow: CrossTenantLedgerRow;
  readonly publishedPriorStartingWeights: readonly number[] | null;
  readonly publishedBenchmarkRate: number | null;
  /** Guaranteed false: visitor-level CATE is NEVER published cross-tenant (§8.7). */
  readonly visitorCatePublished: false;
  readonly eligibleSplits: readonly string[];
  readonly suppressedSplits: readonly string[];
}

function checkD23Entitled(override?: {
  readonly decision23Approved?: boolean;
  readonly decision23LegalSignedOff?: boolean;
}): boolean {
  if (
    override?.decision23Approved !== undefined &&
    override?.decision23LegalSignedOff !== undefined
  ) {
    return override.decision23Approved && override.decision23LegalSignedOff;
  }
  return requireDecisionEntitled('D-23', { enforceLegalSignOff: true }).entitled;
}

/**
 * Shared ledger registry tracking all cross-tenant experiment & federated releases,
 * tenant explicit opt-ins, and mandatory 14-day opt-out retrain triggers.
 */
export class CrossTenantPoolingLedger {
  private readonly rows: CrossTenantLedgerRow[] = [];
  private readonly optOutRetrainQueue = new Map<
    string,
    {
      readonly tenantId: string;
      readonly optedOutAtIso: string;
      readonly retrainDeadlineIso: string;
      retrainedAtIso: string | null;
    }
  >();

  getLedgerRows(): readonly CrossTenantLedgerRow[] {
    return [...this.rows];
  }

  /**
   * Records a tenant opting out of federation/pooling and schedules mandatory retrain <= 14 days (§8.7).
   */
  recordTenantOptOut(
    tenantId: string,
    optedOutAtIso: string
  ): {
    readonly tenantId: string;
    readonly optedOutAtIso: string;
    readonly retrainDeadlineIso: string;
    readonly retrainRequired: true;
  } {
    const deadlineMs =
      Date.parse(optedOutAtIso) +
      CROSS_TENANT_POLICY.OPT_OUT_RETRAIN_DEADLINE_DAYS * 86_400_000;
    const retrainDeadlineIso = new Date(deadlineMs).toISOString();
    this.optOutRetrainQueue.set(tenantId, {
      tenantId,
      optedOutAtIso,
      retrainDeadlineIso,
      retrainedAtIso: null,
    });
    return {
      tenantId,
      optedOutAtIso,
      retrainDeadlineIso,
      retrainRequired: true,
    };
  }

  markOptOutRetrainCompleted(tenantId: string, completedAtIso: string): boolean {
    const rec = this.optOutRetrainQueue.get(tenantId);
    if (!rec) return false;
    rec.retrainedAtIso = completedAtIso;
    return true;
  }

  getOptOutRetrainStatus(
    tenantId: string,
    nowIso: string
  ): {
    readonly pending: boolean;
    readonly overdue: boolean;
    readonly retrainDeadlineIso: string | null;
  } {
    const rec = this.optOutRetrainQueue.get(tenantId);
    if (!rec || rec.retrainedAtIso !== null) {
      return { pending: false, overdue: false, retrainDeadlineIso: null };
    }
    const overdue = Date.parse(nowIso) > Date.parse(rec.retrainDeadlineIso);
    return { pending: true, overdue, retrainDeadlineIso: rec.retrainDeadlineIso };
  }

  /**
   * Evaluates and records a cross-tenant experiment release (1 statistical row per experiment, §9.7 / §8.7).
   */
  releaseExperimentSummaryRow(params: {
    readonly releaseId: string;
    readonly contributions: readonly TenantExperimentContribution[];
    readonly evaluatedAtIso: string;
    /** Optional prior release tenant IDs to detect differencing attacks (1-tenant diff). */
    readonly previousReleaseTenantIds?: readonly string[];
    readonly decision23Approved?: boolean;
    readonly decision23LegalSignedOff?: boolean;
  }): CrossTenantExperimentReleaseResult {
    // 1. Fail-fast on any non-standard lane or raw row inclusion!
    for (const c of params.contributions) {
      assertStandardTelemetryAggregateOnly({
        originLane: c.originLane,
        containsRawRows: c.containsRawRows,
      });
    }

    const active = params.contributions.filter(
      (c) => c.explicitOptIn && !this.optOutRetrainQueue.has(c.tenantId)
    );
    const uniqueTenants = new Set(active.map((c) => c.tenantId));
    const tenantCount = uniqueTenants.size;

    const recordAndReturn = (
      status: MeasureStatus,
      reason: string,
      opts?: {
        readonly pooledEffect?: number | null;
        readonly pooledSe?: number | null;
        readonly maxWeight?: number;
        readonly suppressedByDifferencing?: boolean;
        readonly suppressedCells?: readonly string[];
      }
    ): CrossTenantExperimentReleaseResult => {
      const row: CrossTenantLedgerRow = {
        releaseId: params.releaseId,
        flowKind: 'experiment_stat_row',
        evaluatedAtIso: params.evaluatedAtIso,
        status,
        tenantCount,
        maxTenantWeight: opts?.maxWeight ?? 0,
        suppressedByDifferencing: opts?.suppressedByDifferencing ?? false,
        publishedArtifacts: status === 'ok' ? ['experiment_summary_row'] : [],
        visitorCatePublished: false,
        reason,
      };
      this.rows.push(row);
      return {
        status,
        ledgerRow: row,
        pooledEffect: opts?.pooledEffect ?? null,
        pooledSe: opts?.pooledSe ?? null,
        tenantCount,
        maxSingleTenantWeight: opts?.maxWeight ?? 0,
        suppressedCells: opts?.suppressedCells ?? [],
      };
    };

    // §8.7: When only 1 tenant (or < 5), MUST return `insufficient_data`!
    if (tenantCount <= 1 || tenantCount < CROSS_TENANT_POLICY.EXPERIMENT_MIN_TENANTS) {
      return recordAndReturn(
        'insufficient_data',
        tenantCount <= 1
          ? 'single_tenant_insufficient_data_for_cross_tenant_release'
          : `tenant_count_below_5(observed=${tenantCount})`
      );
    }

    if (
      !checkD23Entitled({
        decision23Approved: params.decision23Approved,
        decision23LegalSignedOff: params.decision23LegalSignedOff,
      })
    ) {
      return recordAndReturn(
        'not_entitled',
        'decision_23_and_legal_signoff_required_for_cross_tenant_release'
      );
    }

    const totalControl = active.reduce((s, c) => s + c.controlUnits, 0);
    const totalTreatment = active.reduce((s, c) => s + c.treatmentUnits, 0);
    if (
      totalControl < CROSS_TENANT_POLICY.EXPERIMENT_MIN_UNITS_PER_ARM ||
      totalTreatment < CROSS_TENANT_POLICY.EXPERIMENT_MIN_UNITS_PER_ARM
    ) {
      return recordAndReturn(
        'insufficient_data',
        `arm_units_below_50(control=${totalControl},treatment=${totalTreatment})`
      );
    }

    // Differencing protection: if comparing against a previous release differs by 1..2 tenants, suppress
    if (params.previousReleaseTenantIds && params.previousReleaseTenantIds.length > 0) {
      const prevSet = new Set(params.previousReleaseTenantIds);
      let symDiff = 0;
      for (const t of uniqueTenants) if (!prevSet.has(t)) symDiff += 1;
      for (const t of prevSet) if (!uniqueTenants.has(t)) symDiff += 1;
      if (symDiff > 0 && symDiff < CROSS_TENANT_POLICY.EXPERIMENT_MIN_TENANTS) {
        return recordAndReturn('suppressed', 'differencing_attack_risk_suppressed', {
          suppressedByDifferencing: true,
          suppressedCells: ['experiment_summary_row'],
        });
      }
    }

    // Cap single-tenant weight to <= 1/3 (§8.7 / §9.7)
    const rawUnits = active.map((c) => Math.max(1, c.controlUnits + c.treatmentUnits));
    const cappedWeights = capWeightsToMaxShare(
      rawUnits,
      CROSS_TENANT_POLICY.MAX_SINGLE_TENANT_WEIGHT
    );
    const maxWeight = Math.max(...cappedWeights);

    let pooledEffect = 0;
    let pooledVar = 0;
    for (let i = 0; i < active.length; i++) {
      pooledEffect += cappedWeights[i] * active[i].effectEstimate;
      pooledVar +=
        cappedWeights[i] *
        cappedWeights[i] *
        active[i].standardError *
        active[i].standardError;
    }

    return recordAndReturn('ok', 'released_within_cross_tenant_ledger_thresholds', {
      pooledEffect: Number(pooledEffect.toFixed(6)),
      pooledSe: Number(Math.sqrt(pooledVar).toFixed(6)),
      maxWeight: Number(maxWeight.toFixed(6)),
    });
  }

  /**
   * Evaluates and records a consent-based federated learning histogram aggregate (§8.7).
   * - Requires >= 10 consenting tenants overall, and per split >= 5 tenants & >= 50 units
   * - Single-tenant weight capped at <= 1/3
   * - Publishes ONLY starting prior weights & benchmark reference (NEVER visitor CATE!)
   */
  releaseFederatedLearningAggregate(params: {
    readonly releaseId: string;
    readonly contributions: readonly TenantFederationSplitContribution[];
    readonly evaluatedAtIso: string;
    readonly decision23Approved?: boolean;
    readonly decision23LegalSignedOff?: boolean;
  }): FederatedAggregateReleaseResult {
    for (const c of params.contributions) {
      assertStandardTelemetryAggregateOnly({
        originLane: c.originLane,
        containsRawRows: c.containsRawRows,
      });
    }

    const active = params.contributions.filter(
      (c) => c.explicitOptIn && !this.optOutRetrainQueue.has(c.tenantId)
    );
    const allTenants = new Set(active.map((c) => c.tenantId));
    const tenantCount = allTenants.size;

    const recordAndReturn = (
      status: MeasureStatus,
      reason: string,
      opts?: {
        readonly weights?: readonly number[] | null;
        readonly benchmark?: number | null;
        readonly maxWeight?: number;
        readonly eligibleSplits?: readonly string[];
        readonly suppressedSplits?: readonly string[];
      }
    ): FederatedAggregateReleaseResult => {
      const row: CrossTenantLedgerRow = {
        releaseId: params.releaseId,
        flowKind: 'federated_learning_aggregate',
        evaluatedAtIso: params.evaluatedAtIso,
        status,
        tenantCount,
        maxTenantWeight: opts?.maxWeight ?? 0,
        suppressedByDifferencing: (opts?.suppressedSplits?.length ?? 0) > 0,
        publishedArtifacts:
          status === 'ok' ? ['prior_starting_weights', 'benchmark_reference'] : [],
        visitorCatePublished: false,
        reason,
      };
      this.rows.push(row);
      return {
        status,
        ledgerRow: row,
        publishedPriorStartingWeights: opts?.weights ?? null,
        publishedBenchmarkRate: opts?.benchmark ?? null,
        visitorCatePublished: false,
        eligibleSplits: opts?.eligibleSplits ?? [],
        suppressedSplits: opts?.suppressedSplits ?? [],
      };
    };

    if (tenantCount <= 1 || tenantCount < CROSS_TENANT_POLICY.FEDERATION_MIN_TENANTS) {
      return recordAndReturn(
        'insufficient_data',
        tenantCount <= 1
          ? 'single_tenant_insufficient_data_for_federation'
          : `federation_tenant_count_below_10(observed=${tenantCount})`
      );
    }

    if (
      !checkD23Entitled({
        decision23Approved: params.decision23Approved,
        decision23LegalSignedOff: params.decision23LegalSignedOff,
      })
    ) {
      return recordAndReturn(
        'not_entitled',
        'decision_23_and_legal_signoff_required_for_federation'
      );
    }

    // Group by split and enforce per-split >= 5 tenants & >= 50 units
    const bySplit = new Map<string, TenantFederationSplitContribution[]>();
    for (const c of active) {
      const arr = bySplit.get(c.splitId) ?? [];
      arr.push(c);
      bySplit.set(c.splitId, arr);
    }

    const eligibleSplits: string[] = [];
    const suppressedSplits: string[] = [];
    const acceptedContribs: TenantFederationSplitContribution[] = [];

    for (const [splitId, rows] of bySplit.entries()) {
      const splitTenants = new Set(rows.map((r) => r.tenantId)).size;
      const splitUnits = rows.reduce((s, r) => s + r.units, 0);
      if (
        splitTenants >= CROSS_TENANT_POLICY.FEDERATION_SPLIT_MIN_TENANTS &&
        splitUnits >= CROSS_TENANT_POLICY.FEDERATION_SPLIT_MIN_UNITS
      ) {
        eligibleSplits.push(splitId);
        acceptedContribs.push(...rows);
      } else {
        suppressedSplits.push(splitId);
      }
    }

    if (eligibleSplits.length === 0) {
      return recordAndReturn(
        'suppressed',
        'all_federation_splits_below_5_tenants_or_50_units',
        { eligibleSplits, suppressedSplits }
      );
    }

    // Aggregate per tenant so single-tenant weight is capped at <= 1/3
    const byTenant = new Map<
      string,
      { units: number; grad: number[]; rateWeighted: number }
    >();
    const dim = acceptedContribs[0].gradientSum.length;

    for (const c of acceptedContribs) {
      const cur = byTenant.get(c.tenantId) ?? {
        units: 0,
        grad: new Array<number>(dim).fill(0),
        rateWeighted: 0,
      };
      cur.units += c.units;
      cur.rateWeighted += c.baselineRate * c.units;
      for (let d = 0; d < dim; d++) {
        cur.grad[d] += c.gradientSum[d] ?? 0;
      }
      byTenant.set(c.tenantId, cur);
    }

    const tenantList = [...byTenant.values()];
    const cappedWeights = capWeightsToMaxShare(
      tenantList.map((t) => Math.max(1, t.units)),
      CROSS_TENANT_POLICY.MAX_SINGLE_TENANT_WEIGHT
    );
    const maxWeight = Math.max(...cappedWeights);

    const priorWeights = new Array<number>(dim).fill(0);
    let benchmarkRate = 0;
    tenantList.forEach((t, idx) => {
      const w = cappedWeights[idx];
      const tenantRate = t.units > 0 ? t.rateWeighted / t.units : 0;
      benchmarkRate += w * tenantRate;
      for (let d = 0; d < dim; d++) {
        priorWeights[d] += w * (t.grad[d] / Math.max(1, t.units));
      }
    });

    return recordAndReturn('ok', 'federated_priors_and_benchmark_released', {
      weights: priorWeights.map((v) => Number(v.toFixed(6))),
      benchmark: Number(benchmarkRate.toFixed(6)),
      maxWeight: Number(maxWeight.toFixed(6)),
      eligibleSplits,
      suppressedSplits,
    });
  }
}

/**
 * Water-filling weight projection ensuring every tenant weight <= `maxShare` (1/3)
 * and weights sum to 1.
 */
export function capWeightsToMaxShare(
  rawWeights: readonly number[],
  maxShare: number
): number[] {
  const n = rawWeights.length;
  if (n === 0) return [];
  if (n * maxShare < 1 - 1e-9) {
    // Cannot cap below 1/n; return uniform
    return rawWeights.map(() => 1 / n);
  }
  const sum = rawWeights.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const w = rawWeights.map((x) => Math.max(0, x) / sum);

  for (let iter = 0; iter < n + 2; iter++) {
    let excess = 0;
    let uncappedSum = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] > maxShare) {
        excess += w[i] - maxShare;
        w[i] = maxShare;
      } else {
        uncappedSum += w[i];
      }
    }
    if (excess <= 1e-12 || uncappedSum <= 1e-12) break;
    for (let i = 0; i < n; i++) {
      if (w[i] < maxShare) {
        w[i] += excess * (w[i] / uncappedSum);
      }
    }
  }
  return w;
}

// =========================================================================
// 4. Tabular Foundation Model Gate & 4-E Japanese Embeddings Connection (§8.7)
// =========================================================================

export interface TabularFoundationModelGateInput {
  readonly modelId: string;
  readonly licenseSpdx: string;
  readonly commercialLicenseVerified: boolean;
  readonly rowCount: number;
  readonly positiveCount: number;
}

export interface TabularFoundationModelGateResult {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * §8.7 Tabular Foundation Model Gate:
 * Requires verified commercial license, <= 10,000 rows, and 200..5,000 positive examples.
 */
export function evaluateTabularFoundationModelEligibility(
  input: TabularFoundationModelGateInput
): TabularFoundationModelGateResult {
  const reasons: string[] = [];
  if (!input.commercialLicenseVerified) {
    reasons.push('commercial_license_not_verified');
  }
  if (input.rowCount <= 0 || input.rowCount > CROSS_TENANT_POLICY.TABULAR_FM_MAX_ROWS) {
    reasons.push(
      `row_count_out_of_range(observed=${input.rowCount},max=${CROSS_TENANT_POLICY.TABULAR_FM_MAX_ROWS})`
    );
  }
  if (
    input.positiveCount < CROSS_TENANT_POLICY.TABULAR_FM_MIN_POSITIVES ||
    input.positiveCount > CROSS_TENANT_POLICY.TABULAR_FM_MAX_POSITIVES
  ) {
    reasons.push(
      `positive_count_out_of_range(observed=${input.positiveCount},allowed=200..5000)`
    );
  }
  return { eligible: reasons.length === 0, reasons };
}

export interface BoundJapaneseEmbeddingConfig {
  readonly bound: boolean;
  readonly artifactId: string;
  readonly modelId: string;
  readonly licenseSpdx: string;
  readonly contentSha256: string;
  readonly knownCatalogCandidate: JapaneseEmbeddingCandidateSpec | null;
  readonly reason: string;
}

/**
 * Binds a Bundle 4-E `SelectedEmbeddingArtifactRecord` (`lib/link/search/jp-embeddings.ts`)
 * as the transferable cross-site Japanese feature representation (§8.7).
 */
export function bindJapaneseEmbeddingArtifact(
  artifact: SelectedEmbeddingArtifactRecord
): BoundJapaneseEmbeddingConfig {
  const catalogMatch =
    DEFAULT_JP_EMBEDDING_CANDIDATES.find(
      (c) => c.model_id === artifact.selected_model_id
    ) ?? null;

  const winnerMetrics = artifact.candidates.find(
    (c) => c.model_id === artifact.selected_model_id
  );
  const eligible =
    Boolean(artifact.content_sha256) &&
    winnerMetrics?.eligible === true &&
    (catalogMatch ? catalogMatch.commercial_use_allowed && catalogMatch.license_verified : true);

  return {
    bound: eligible,
    artifactId: artifact.artifact_id,
    modelId: artifact.selected_model_id,
    licenseSpdx: artifact.selected_license_spdx,
    contentSha256: artifact.content_sha256,
    knownCatalogCandidate: catalogMatch,
    reason: eligible
      ? 'bound_verified_4e_japanese_embedding_artifact'
      : 'embedding_artifact_unverified_or_ineligible',
  };
}
