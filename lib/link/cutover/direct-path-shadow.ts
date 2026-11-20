/**
 * UGOKI LINK v2 — Direct R2 Path Shadow Evaluator, 1000x Queue Sharding & §5.11 Replica Evaluator
 *
 * Implements Master Architecture v2 §5.11 & `store.G-14`:
 * 1. Direct R2 shadow-write gate (`store.G-14`): requires >= 30 consecutive UTC calendar days
 *    with 100% frame completeness (`countDiff === 0`), exact content hash match, and
 *    `rollP95Sec <= 60` before cutting over from Cloudflare Queues to Direct R2 (`Pipelines`).
 * 2. 1000x × 10x burst queue sharding calculator & deterministic shard router:
 *    handles peak > 5,000 msg/s (e.g., 1000x scale × 10x burst = 5,050 msg/s) by partitioning
 *    traffic across N shards with deterministic `(tenantId, siteId)` routing.
 * 3. §5.11 Replica addition 3-condition trigger:
 *    - Condition ①: `measuredRtoSec > maxAutonomousWatchdogIntervalSec`
 *    - Condition ②: Maintenance lane utilization > 50% for >= 7 consecutive UTC days
 *    - Condition ③: `measuredRtoSec >= publishedApiAvailabilityErrorBudgetSec`
 */

import { createHash } from 'crypto';
import { getConstant } from '../../../packages/contract/ledgers';
import type { UnmetGate } from '../../../packages/contract/response';

const runInWindowConst = getConstant('ops.run_in_window_days')?.value;
export const DIRECT_PATH_SHADOW_REQUIRED_DAYS =
  typeof runInWindowConst === 'number' ? runInWindowConst : 30;

export const DIRECT_PATH_MAX_ROLL_P95_SEC = 60;
export const CLOUDFLARE_QUEUE_MAX_MSG_PER_SEC = 5_000;
export const DEFAULT_SHARD_SAFETY_UTILIZATION = 0.8;
export const MAINTENANCE_LANE_UTIL_THRESHOLD_PCT = 50;
export const MAINTENANCE_LANE_REQUIRED_CONSECUTIVE_DAYS = 7;

export type ScaleTier = '1x' | '100x' | '1000x';

export interface MonthlyTransportCostReference {
  readonly scaleTier: ScaleTier;
  readonly queueMonthlyUsd: number;
  readonly directR2MonthlyUsd: number;
  readonly monthlySavingsUsd: number;
}

/** §5.11 published monthly transport cost comparison (Queue vs Direct R2). */
export const MONTHLY_TRANSPORT_COSTS: Readonly<
  Record<ScaleTier, MonthlyTransportCostReference>
> = {
  '1x': {
    scaleTier: '1x',
    queueMonthlyUsd: 1,
    directR2MonthlyUsd: 0,
    monthlySavingsUsd: 1,
  },
  '100x': {
    scaleTier: '100x',
    queueMonthlyUsd: 157,
    directR2MonthlyUsd: 18,
    monthlySavingsUsd: 139,
  },
  '1000x': {
    scaleTier: '1000x',
    queueMonthlyUsd: 1575,
    directR2MonthlyUsd: 204,
    monthlySavingsUsd: 1371,
  },
};

export interface DirectPathShadowDayRecord {
  /** UTC calendar date in YYYY-MM-DD format. */
  readonly dayUtc: string;
  /** Frames acknowledged into the collector ledger on this UTC day. */
  readonly ledgeredFrames: number;
  /** Frames landed via the primary Cloudflare Queue path. */
  readonly queueIngestedFrames: number;
  /** Frames landed via the shadow Direct R2 (`Pipelines`) path. */
  readonly directR2IngestedFrames: number;
  /** True iff canonical sorted frame digest matches 100% between Queue and Direct R2. */
  readonly contentHashMatch: boolean;
  /** Measured p95 file-roll latency on the Direct R2 path in seconds (must be <= 60s). */
  readonly rollP95Sec: number;
}

export interface DirectPathShadowDayFailure {
  readonly dayUtc: string;
  readonly reasons: readonly string[];
}

export interface DirectPathShadowGateOptions {
  readonly requiredConsecutiveDays?: number;
  readonly maxRollP95Sec?: number;
}

export interface DirectPathShadowGateReport {
  readonly gateId: 'store.G-14';
  readonly canCutoverToDirectPath: boolean;
  readonly consecutivePassingDays: number;
  readonly requiredDays: number;
  readonly maxObservedRollP95Sec: number;
  readonly failedDays: readonly DirectPathShadowDayFailure[];
  readonly unmetGate?: UnmetGate;
}

function parseUtcDayIndex(dayUtc: string): number {
  const ms = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.NaN;
}

/**
 * Evaluates the `store.G-14` Direct R2 shadow-write gate (§5.11).
 * Fails closed unless the trailing consecutive UTC day streak reaches >= 30 days
 * with 100% frame completeness, exact content hash equality, and roll p95 <= 60s.
 */
export function evaluateDirectPathShadowGate(
  records: readonly DirectPathShadowDayRecord[],
  options: DirectPathShadowGateOptions = {}
): DirectPathShadowGateReport {
  const requiredDays =
    options.requiredConsecutiveDays ?? DIRECT_PATH_SHADOW_REQUIRED_DAYS;
  const maxRollP95Sec = options.maxRollP95Sec ?? DIRECT_PATH_MAX_ROLL_P95_SEC;

  if (records.length === 0) {
    return {
      gateId: 'store.G-14',
      canCutoverToDirectPath: false,
      consecutivePassingDays: 0,
      requiredDays,
      maxObservedRollP95Sec: 0,
      failedDays: [],
      unmetGate: {
        id: 'store.G-14',
        required: `${requiredDays} consecutive UTC days with 100% completeness, hash match, and rollP95 <= ${maxRollP95Sec}s`,
        observed: '0 shadow-write days recorded',
        unlock: `Run Direct R2 shadow path alongside Queue path for ${requiredDays} consecutive clean days`,
        reason: 'shadow_run_not_started',
        eta: { min_days: requiredDays, max_days: requiredDays },
      },
    };
  }

  const sorted = [...records].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));
  const failedDays: DirectPathShadowDayFailure[] = [];
  let streak = 0;
  let prevDayIdx: number | null = null;
  let maxObservedRollP95Sec = 0;

  for (const rec of sorted) {
    const dayIdx = parseUtcDayIndex(rec.dayUtc);
    const reasons: string[] = [];

    if (!Number.isFinite(dayIdx)) {
      reasons.push('invalid_day_utc');
    }
    if (rec.ledgeredFrames <= 0) {
      reasons.push('no_ledgered_frames');
    }
    if (rec.queueIngestedFrames !== rec.ledgeredFrames) {
      reasons.push(
        `queue_count_mismatch(queue=${rec.queueIngestedFrames},ledger=${rec.ledgeredFrames})`
      );
    }
    if (rec.directR2IngestedFrames !== rec.ledgeredFrames) {
      reasons.push(
        `direct_r2_count_mismatch(directR2=${rec.directR2IngestedFrames},ledger=${rec.ledgeredFrames})`
      );
    }
    if (!rec.contentHashMatch) {
      reasons.push('content_hash_mismatch');
    }
    if (!Number.isFinite(rec.rollP95Sec) || rec.rollP95Sec < 0) {
      reasons.push('invalid_roll_p95');
    } else {
      if (rec.rollP95Sec > maxObservedRollP95Sec) {
        maxObservedRollP95Sec = rec.rollP95Sec;
      }
      if (rec.rollP95Sec > maxRollP95Sec) {
        reasons.push(
          `roll_p95_exceeded(${rec.rollP95Sec}s>${maxRollP95Sec}s)`
        );
      }
    }

    if (reasons.length > 0) {
      failedDays.push({ dayUtc: rec.dayUtc, reasons });
      streak = 0;
      prevDayIdx = Number.isFinite(dayIdx) ? dayIdx : null;
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx) {
      // Duplicate clean record for the same UTC calendar day does not increment streak twice
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx + 1) {
      streak += 1;
    } else {
      streak = 1;
    }
    prevDayIdx = dayIdx;
  }

  const canCutoverToDirectPath = streak >= requiredDays;
  const remaining = Math.max(0, requiredDays - streak);

  return {
    gateId: 'store.G-14',
    canCutoverToDirectPath,
    consecutivePassingDays: streak,
    requiredDays,
    maxObservedRollP95Sec,
    failedDays,
    ...(canCutoverToDirectPath
      ? {}
      : {
          unmetGate: {
            id: 'store.G-14',
            required: `${requiredDays} consecutive UTC days with 100% completeness, hash match, and rollP95 <= ${maxRollP95Sec}s`,
            observed: `${streak}/${requiredDays} consecutive clean days (${failedDays.length} failed day(s), max rollP95=${maxObservedRollP95Sec}s)`,
            unlock: `Maintain clean Direct R2 shadow parity for ${remaining} more consecutive UTC day(s) before switching off Queue path`,
            reason:
              failedDays.length > 0
                ? 'shadow_parity_or_latency_failure'
                : 'shadow_window_incomplete',
            eta: { min_days: remaining, max_days: remaining },
          },
        }),
  };
}

export interface QueueShardSizingInput {
  /** Baseline steady traffic at 1x scale in messages/sec (default ~0.505 msg/s => 505 msg/s at 1000x, 5,050 msg/s at 1000x × 10x burst). */
  readonly baselineMsgPerSec?: number;
  /** Scale multiplier (e.g., 1, 100, 1000). */
  readonly scaleMultiplier: number;
  /** Peak burst multiplier on top of steady load (e.g., 10 for 10x spike). */
  readonly peakBurstMultiplier: number;
  /** Hard per-queue throughput limit in msg/s (default 5,000 msg/s per §5.11). */
  readonly perQueueMaxMsgPerSec?: number;
  /** Target max utilization per shard during peak burst (default 0.80 = 20% headroom). */
  readonly safetyUtilization?: number;
}

export interface QueueShardPlan {
  readonly steadyMsgPerSec: number;
  readonly peakMsgPerSec: number;
  readonly perQueueMaxMsgPerSec: number;
  readonly effectiveShardCeilingMsgPerSec: number;
  readonly exceedsSingleQueue: boolean;
  readonly recommendedShardCount: number;
  readonly shardNames: readonly string[];
  readonly monthlyCostReference: MonthlyTransportCostReference;
}

function selectNearestCostTier(scaleMultiplier: number): ScaleTier {
  if (scaleMultiplier >= 500) return '1000x';
  if (scaleMultiplier >= 10) return '100x';
  return '1x';
}

/**
 * Calculates required Cloudflare Queue shard count for burst peaks (§5.11).
 * At 1000x × 10x burst (~5,050 msg/s > 5,000 msg/s single-queue limit), requires >= 2 shards.
 */
export function calculateQueueShardPlan(
  input: QueueShardSizingInput
): QueueShardPlan {
  const baseline = input.baselineMsgPerSec ?? 0.505;
  const perQueueMax =
    input.perQueueMaxMsgPerSec ?? CLOUDFLARE_QUEUE_MAX_MSG_PER_SEC;
  const safetyUtil = Math.min(
    1,
    Math.max(0.1, input.safetyUtilization ?? DEFAULT_SHARD_SAFETY_UTILIZATION)
  );

  const steadyMsgPerSec = Number(
    (Math.max(0, baseline) * Math.max(0, input.scaleMultiplier)).toFixed(3)
  );
  const peakMsgPerSec = Number(
    (steadyMsgPerSec * Math.max(1, input.peakBurstMultiplier)).toFixed(3)
  );
  const effectiveShardCeilingMsgPerSec = Math.floor(perQueueMax * safetyUtil);
  const exceedsSingleQueue = peakMsgPerSec > perQueueMax;

  let recommendedShardCount = Math.max(
    1,
    Math.ceil(peakMsgPerSec / Math.max(1, effectiveShardCeilingMsgPerSec))
  );
  if (exceedsSingleQueue && recommendedShardCount < 2) {
    recommendedShardCount = 2;
  }

  const shardNames = Array.from(
    { length: recommendedShardCount },
    (_, idx) => `link-ingest-shard-${idx}`
  );

  return {
    steadyMsgPerSec,
    peakMsgPerSec,
    perQueueMaxMsgPerSec: perQueueMax,
    effectiveShardCeilingMsgPerSec,
    exceedsSingleQueue,
    recommendedShardCount,
    shardNames,
    monthlyCostReference:
      MONTHLY_TRANSPORT_COSTS[selectNearestCostTier(input.scaleMultiplier)],
  };
}

export interface QueueShardAssignment {
  readonly tenantId: string;
  readonly siteId: string;
  readonly shardCount: number;
  readonly shardIndex: number;
  readonly shardName: string;
}

/**
 * Deterministic shard assignment by `(tenantId, siteId)` using SHA-256.
 * Keeps single-site ordering stable and distributes multi-tenant burst load evenly.
 */
export function assignQueueShard(
  tenantId: string,
  siteId: string,
  shardCount: number
): QueueShardAssignment {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`Invalid shardCount: ${shardCount} (must be integer >= 1)`);
  }
  const digest = createHash('sha256')
    .update(`${tenantId}:${siteId}`)
    .digest('hex');
  const bucket = parseInt(digest.slice(0, 8), 16);
  const shardIndex = bucket % shardCount;
  return {
    tenantId,
    siteId,
    shardCount,
    shardIndex,
    shardName: `link-ingest-shard-${shardIndex}`,
  };
}

export interface MaintenanceLaneDayUtilization {
  /** UTC calendar date in YYYY-MM-DD format. */
  readonly dayUtc: string;
  /** Daily peak/average maintenance lane (builder + deletion) utilization percentage (0..100). */
  readonly utilizationPct: number;
}

export type ReplicaConditionId =
  | 'condition_1_rto_exceeds_watchdog'
  | 'condition_2_maintenance_over_50pct_7d'
  | 'condition_3_rto_exhausts_availability_budget';

export interface ReplicaAdditionInput {
  /** Measured restore drill RTO in seconds. */
  readonly measuredRtoSec: number;
  /** Maximum autonomous watchdog / circuit-breaker window in seconds (§5.11 ①). */
  readonly maxAutonomousWatchdogIntervalSec: number;
  /** Daily maintenance lane utilization history (§5.11 ②: >50% for >=7 consecutive days). */
  readonly maintenanceUtilizationHistory: readonly MaintenanceLaneDayUtilization[];
  /** Published read-API availability target (e.g., 0.999 = 99.9%) (§5.11 ③). */
  readonly publishedAvailabilityTarget: number;
  /** Availability error-budget window in days (default 30). */
  readonly budgetWindowDays?: number;
  /** Whether a ClickHouse read replica is already provisioned. */
  readonly replicaAlreadyProvisioned?: boolean;
}

export interface ReplicaAdditionReport {
  readonly replicaRequired: boolean;
  readonly replicaProvisioningSatisfied: boolean;
  readonly condition1Triggered: boolean;
  readonly condition2Triggered: boolean;
  readonly condition3Triggered: boolean;
  readonly triggeredConditions: readonly ReplicaConditionId[];
  readonly maxConsecutiveMaintenanceOver50Days: number;
  readonly availabilityErrorBudgetSec: number;
  readonly unmetGate?: UnmetGate;
}

function countMaxConsecutiveMaintenanceOverThreshold(
  history: readonly MaintenanceLaneDayUtilization[],
  thresholdPct: number
): number {
  if (history.length === 0) return 0;
  const sorted = [...history].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));

  let maxStreak = 0;
  let currentStreak = 0;
  let prevDayIdx: number | null = null;

  for (const rec of sorted) {
    const dayIdx = parseUtcDayIndex(rec.dayUtc);
    const overThreshold =
      Number.isFinite(dayIdx) &&
      Number.isFinite(rec.utilizationPct) &&
      rec.utilizationPct > thresholdPct;

    if (!overThreshold) {
      currentStreak = 0;
      prevDayIdx = Number.isFinite(dayIdx) ? dayIdx : null;
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx) {
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx + 1) {
      currentStreak += 1;
    } else {
      currentStreak = 1;
    }
    prevDayIdx = dayIdx;
    if (currentStreak > maxStreak) {
      maxStreak = currentStreak;
    }
  }

  return maxStreak;
}

/**
 * Evaluates all 3 §5.11 ClickHouse read-replica addition conditions.
 * Provisioning a replica is required as soon as ANY ONE of ①, ②, or ③ triggers.
 */
export function evaluateReplicaAdditionConditions(
  input: ReplicaAdditionInput
): ReplicaAdditionReport {
  // Condition ①: measured RTO exceeds maximum autonomous watchdog / auto-stop interval
  const condition1Triggered =
    input.measuredRtoSec > input.maxAutonomousWatchdogIntervalSec;

  // Condition ②: maintenance lane utilization > 50% for >= 7 consecutive UTC days
  const maxConsecutiveMaintenanceOver50Days =
    countMaxConsecutiveMaintenanceOverThreshold(
      input.maintenanceUtilizationHistory,
      MAINTENANCE_LANE_UTIL_THRESHOLD_PCT
    );
  const condition2Triggered =
    maxConsecutiveMaintenanceOver50Days >=
    MAINTENANCE_LANE_REQUIRED_CONSECUTIVE_DAYS;

  // Condition ③: single-incident RTO exhausts published read-API availability error budget
  const windowDays = input.budgetWindowDays ?? 30;
  const clampedTarget = Math.min(
    0.999999,
    Math.max(0.5, input.publishedAvailabilityTarget)
  );
  const availabilityErrorBudgetSec = Math.round(
    (1 - clampedTarget) * windowDays * 86_400
  );
  const condition3Triggered =
    input.measuredRtoSec >= availabilityErrorBudgetSec;

  const triggeredConditions: ReplicaConditionId[] = [];
  if (condition1Triggered) {
    triggeredConditions.push('condition_1_rto_exceeds_watchdog');
  }
  if (condition2Triggered) {
    triggeredConditions.push('condition_2_maintenance_over_50pct_7d');
  }
  if (condition3Triggered) {
    triggeredConditions.push('condition_3_rto_exhausts_availability_budget');
  }

  const replicaRequired = triggeredConditions.length > 0;
  const replicaProvisioningSatisfied =
    !replicaRequired || Boolean(input.replicaAlreadyProvisioned);

  return {
    replicaRequired,
    replicaProvisioningSatisfied,
    condition1Triggered,
    condition2Triggered,
    condition3Triggered,
    triggeredConditions,
    maxConsecutiveMaintenanceOver50Days,
    availabilityErrorBudgetSec,
    ...(replicaProvisioningSatisfied
      ? {}
      : {
          unmetGate: {
            id: 'store.replica_addition_required',
            required:
              'Provision ClickHouse read replica whenever any §5.11 condition (①, ②, or ③) triggers',
            observed: `triggered: ${triggeredConditions.join(', ')} (RTO=${input.measuredRtoSec}s, watchdog=${input.maxAutonomousWatchdogIntervalSec}s, maintStreak=${maxConsecutiveMaintenanceOver50Days}d, errorBudget=${availabilityErrorBudgetSec}s)`,
            unlock:
              'Provision warm ClickHouse read replica and verify failover before continuing scale-up or external tenant launch (§5.11)',
            reason: 'replica_condition_triggered_without_replica',
          },
        }),
  };
}
