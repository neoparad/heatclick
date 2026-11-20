/**
 * UGOKI LINK v2 — External Tenant Readiness Gate (§11.9 / §5.11 / D-17)
 *
 * Mechanically verifies EVERY prerequisite before admitting even 1 external tenant:
 * 1. All 4 Isolation Gates (`surf.G1`–`surf.G4`) + full Operation×Credential×Foreign-ID 404 Matrix PASS
 * 2. Two-tenant canary isolation monitor: >= 30 consecutive days with 0 leaks & valid audit chain
 * 3. §5.11 Replica Condition ③ check: measured RTO must NOT exhaust published read-API availability
 *    budget in a single incident (unless a ClickHouse replica is already provisioned)
 * 4. Decision D-17 (external-tenant real-time personalisation legal sign-off): remains `not_entitled`
 *    until D-17 + legal sign-off are recorded
 */

import { requireDecisionEntitled } from '../../../packages/contract/ledgers';
import type { IsolationGatesSummary } from '../isolation';
import type { UnmetGate } from '../../../packages/contract/response';

export const EXTERNAL_TENANT_CANARY_REQUIRED_DAYS = 30;

export interface CanaryIsolationDayRecord {
  readonly dayUtc: string; // YYYY-MM-DD
  readonly canaryTenantA: string;
  readonly canaryTenantB: string;
  readonly matrixTotalCases: number;
  readonly leakedCases: number;
  readonly non404Cases: number;
  readonly auditChainValid: boolean;
}

export interface ExternalTenantAvailabilitySpec {
  /** Published monthly read-API availability target (e.g. 0.999 = 99.9%). */
  readonly publishedAvailabilityTarget: number;
  /** Budget window in days (default 30 days). */
  readonly budgetWindowDays?: number;
  /** Measured full-recovery RTO in seconds from the monthly restore drill. */
  readonly measuredRtoSec: number;
  /** Whether a warm ClickHouse replica is already provisioned. */
  readonly replicaProvisioned: boolean;
}

export interface ExternalTenantReadinessInput {
  readonly isolationGates: IsolationGatesSummary;
  readonly canaryHistory: readonly CanaryIsolationDayRecord[];
  readonly availability: ExternalTenantAvailabilitySpec;
  /** Optional test override for Decision D-17 + legal sign-off. */
  readonly decision17ApprovedOverride?: boolean;
  readonly decision17LegalSignedOffOverride?: boolean;
}

export interface ExternalTenantReadinessReport {
  readonly readyToAdmitExternalTenants: boolean;
  readonly isolation4GatesPassed: boolean;
  readonly canaryConsecutiveCleanDays: number;
  readonly canary30DayGatePassed: boolean;
  readonly availabilityErrorBudgetSec: number;
  readonly replicaCondition3Triggered: boolean;
  readonly replicaRequirementMet: boolean;
  readonly realtimePersonalisationStatus: 'ok' | 'not_entitled';
  readonly realtimePersonalisationReason: string;
  readonly unmetGates: readonly UnmetGate[];
}

function parseDayIndex(dayUtc: string): number {
  const ms = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.NaN;
}

/**
 * Counts the trailing streak of consecutive UTC calendar days where both
 * canary tenants passed with 0 leaks, 0 non-404 responses, and valid audit chain.
 */
export function countConsecutiveCleanCanaryDays(
  history: readonly CanaryIsolationDayRecord[]
): number {
  if (history.length === 0) return 0;

  const sorted = [...history].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));
  let streak = 0;
  let prevDayIdx: number | null = null;

  for (const rec of sorted) {
    const dayIdx = parseDayIndex(rec.dayUtc);
    const isClean =
      Number.isFinite(dayIdx) &&
      rec.canaryTenantA !== rec.canaryTenantB &&
      rec.matrixTotalCases > 0 &&
      rec.leakedCases === 0 &&
      rec.non404Cases === 0 &&
      rec.auditChainValid;

    if (!isClean) {
      streak = 0;
      prevDayIdx = Number.isFinite(dayIdx) ? dayIdx : null;
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx) {
      // Duplicate entry for same UTC day: keep streak unchanged
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx + 1) {
      streak += 1;
    } else {
      streak = 1;
    }
    prevDayIdx = dayIdx;
  }

  return streak;
}

/**
 * Computes single-incident availability error budget and evaluates §5.11
 * Replica Addition Condition ③.
 */
export function evaluateAvailabilityReplicaCondition3(
  spec: ExternalTenantAvailabilitySpec
): {
  readonly availabilityErrorBudgetSec: number;
  readonly replicaCondition3Triggered: boolean;
  readonly replicaRequirementMet: boolean;
} {
  const windowDays = spec.budgetWindowDays ?? 30;
  const clampedTarget = Math.min(0.999999, Math.max(0.5, spec.publishedAvailabilityTarget));
  const availabilityErrorBudgetSec = Math.round(
    (1 - clampedTarget) * windowDays * 86_400
  );
  const replicaCondition3Triggered =
    spec.measuredRtoSec >= availabilityErrorBudgetSec;
  const replicaRequirementMet =
    !replicaCondition3Triggered || spec.replicaProvisioned;

  return {
    availabilityErrorBudgetSec,
    replicaCondition3Triggered,
    replicaRequirementMet,
  };
}

/**
 * Evaluates full readiness before issuing even 1 external tenant key (§11.9 / §5.11).
 */
export function evaluateExternalTenantReadiness(
  input: ExternalTenantReadinessInput
): ExternalTenantReadinessReport {
  const unmetGates: UnmetGate[] = [];

  // 1. Isolation 4 gates (`surf.G1`–`surf.G4`) + 404 Matrix
  const isolation4GatesPassed = input.isolationGates.allPassed;
  if (!isolation4GatesPassed) {
    const failedGateIds: string[] = [];
    if (!input.isolationGates.g1.passed) failedGateIds.push('surf.G1');
    if (!input.isolationGates.g2.passed) failedGateIds.push('surf.G2');
    if (!input.isolationGates.g3.passed) failedGateIds.push('surf.G3');
    if (!input.isolationGates.g4.passed) failedGateIds.push('surf.G4');
    if (!input.isolationGates.matrix.allPassed) failedGateIds.push('surf.isolation_matrix');

    unmetGates.push({
      id: 'surf.isolation_4_gates',
      required: 'surf.G1..surf.G4 and 404 matrix 100% pass',
      observed: `failed: ${failedGateIds.join(', ')}`,
      unlock: 'Resolve all isolation gate failures before admitting external tenants (§11.9)',
      reason: 'isolation_gates_failed',
    });
  }

  // 2. 30-day continuous 2-tenant canary zero-leak run
  const canaryConsecutiveCleanDays = countConsecutiveCleanCanaryDays(
    input.canaryHistory
  );
  const canary30DayGatePassed =
    canaryConsecutiveCleanDays >= EXTERNAL_TENANT_CANARY_REQUIRED_DAYS;
  if (!canary30DayGatePassed) {
    const remaining = EXTERNAL_TENANT_CANARY_REQUIRED_DAYS - canaryConsecutiveCleanDays;
    unmetGates.push({
      id: 'surf.canary_30d_zero_leak',
      required: `${EXTERNAL_TENANT_CANARY_REQUIRED_DAYS} consecutive zero-leak days across 2 canary tenants`,
      observed: `${canaryConsecutiveCleanDays} consecutive clean days`,
      unlock: `Continue daily 2-tenant canary matrix checks for ${remaining} more consecutive clean day(s)`,
      reason: 'canary_30d_run_incomplete',
      eta: { min_days: remaining, max_days: remaining },
    });
  }

  // 3. §5.11 Replica Condition ③ (measured RTO vs published availability error budget)
  const {
    availabilityErrorBudgetSec,
    replicaCondition3Triggered,
    replicaRequirementMet,
  } = evaluateAvailabilityReplicaCondition3(input.availability);

  if (!replicaRequirementMet) {
    unmetGates.push({
      id: 'store.replica_condition_3',
      required: `measuredRtoSec (${input.availability.measuredRtoSec}s) < errorBudget (${availabilityErrorBudgetSec}s) OR replicaProvisioned=true`,
      observed: `RTO=${input.availability.measuredRtoSec}s >= budget=${availabilityErrorBudgetSec}s without replica`,
      unlock: 'Provision ClickHouse read replica or reduce verified restore RTO below error budget (§5.11 #3)',
      reason: 'single_incident_exhausts_availability_slo',
    });
  }

  // 4. Decision D-17 (external-tenant real-time personalisation legal sign-off)
  const ledgerD17 = requireDecisionEntitled('D-17', { enforceLegalSignOff: true });
  const d17Entitled =
    input.decision17ApprovedOverride !== undefined &&
    input.decision17LegalSignedOffOverride !== undefined
      ? input.decision17ApprovedOverride && input.decision17LegalSignedOffOverride
      : ledgerD17.entitled;

  const realtimePersonalisationStatus = d17Entitled ? 'ok' : 'not_entitled';
  const realtimePersonalisationReason = d17Entitled
    ? 'decision_17_and_legal_signoff_recorded'
    : 'decision_17_pending_external_personalisation_locked';

  return {
    readyToAdmitExternalTenants:
      isolation4GatesPassed && canary30DayGatePassed && replicaRequirementMet,
    isolation4GatesPassed,
    canaryConsecutiveCleanDays,
    canary30DayGatePassed,
    availabilityErrorBudgetSec,
    replicaCondition3Triggered,
    replicaRequirementMet,
    realtimePersonalisationStatus,
    realtimePersonalisationReason,
    unmetGates,
  };
}
