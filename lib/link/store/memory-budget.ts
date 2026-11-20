/**
 * UGOKI LINK v2 — Dedicated 8 GiB ClickHouse Memory Budget Enforcer & Forbidden-Query Guard
 *
 * Enforces Master Architecture v2 §5.6 & `store-final.md` M6 / D-05:
 * - Dedicated 8 GiB ClickHouse node -> 7.2 GiB server limit -> <=85% (6.12 GiB) working cap
 * - Budget lines summing to 5.74 GiB:
 *   - background merges/mutations: 1.40 GiB
 *   - caches (mark/uncompressed/schema): 0.90 GiB
 *   - api_live: 6 × 160 MiB = 0.9375 GiB (~0.94 GiB)
 *   - api_heavy: 2 × 512 MiB = 1.00 GiB
 *   - maintenance (single lane): 1 × 768 MiB = 0.75 GiB (builder > deletion > rebuild > extract > backfill)
 *   - loader: 2 × 256 MiB = 0.50 GiB
 *   - reconciliation: 1 × 256 MiB = 0.25 GiB
 * - Rejects forbidden query shapes (missing tenant/site, unbounded time range,
 *   right-side base-table JOIN, grouping by identity outside table sort key,
 *   exact-distinct/array aggs in api_live) with 429 + Retry-After or routes to
 *   a 202 chunked async job — NEVER returning synthetic fallback data.
 */

import { getConstant } from '../../../packages/contract/ledgers';
import { CANONICAL_SCHEMA } from '../../../packages/contract/schema';

export type ClickHouseLaneName =
  | 'api_live'
  | 'api_heavy'
  | 'maintenance'
  | 'loader'
  | 'reconciliation';

export type MaintenanceTaskKind =
  | 'builder'
  | 'deletion'
  | 'rebuild'
  | 'extract'
  | 'backfill';

export const MAINTENANCE_PRIORITY_ORDER: readonly MaintenanceTaskKind[] = [
  'builder',
  'deletion',
  'rebuild',
  'extract',
  'backfill',
];

export interface LaneBudgetSpec {
  readonly lane: ClickHouseLaneName;
  readonly maxConcurrency: number;
  readonly perQueryLimitMib: number;
  readonly budgetGib: number;
}

export interface ClickHouseMemoryBudgetSheet {
  readonly hostRamGib: number;
  readonly serverLimitGib: number;
  readonly workingCapFraction: number;
  readonly workingCapGib: number;
  readonly backgroundMergesAndMutationsGib: number;
  readonly cachesGib: number;
  readonly lanes: Readonly<Record<ClickHouseLaneName, LaneBudgetSpec>>;
  readonly maintenancePriorityOrder: readonly MaintenanceTaskKind[];
}

export interface MemoryBudgetValidationResult {
  readonly valid: boolean;
  readonly totalBudgetedGib: number;
  readonly workingCapGib: number;
  readonly headroomGib: number;
  readonly violations: readonly string[];
}

const MIB_PER_GIB = 1024;

function mibToGib(mib: number): number {
  return mib / MIB_PER_GIB;
}

/**
 * Authoritative dedicated 8 GiB ClickHouse memory budget sheet (`store-final.md` M6 / D-05).
 */
export function createDefault8GiBMemoryBudget(): ClickHouseMemoryBudgetSheet {
  const ramEntry = getConstant('store.dedicated_node_ram_gib');
  const maintEntry = getConstant('store.maintenance_lane_mib');
  const hostRamGib = typeof ramEntry?.value === 'number' ? ramEntry.value : 8;
  const maintenanceMib =
    typeof maintEntry?.value === 'number' ? maintEntry.value : 768;

  const serverLimitGib = Number((hostRamGib * 0.9).toFixed(2)); // 7.20 GiB
  const workingCapFraction = 0.85;
  const workingCapGib = Number((serverLimitGib * workingCapFraction).toFixed(4)); // 6.12 GiB

  return {
    hostRamGib,
    serverLimitGib,
    workingCapFraction,
    workingCapGib,
    backgroundMergesAndMutationsGib: 1.4,
    cachesGib: 0.9,
    lanes: {
      api_live: {
        lane: 'api_live',
        maxConcurrency: 6,
        perQueryLimitMib: 160,
        budgetGib: mibToGib(6 * 160), // 0.9375 GiB (~0.94)
      },
      api_heavy: {
        lane: 'api_heavy',
        maxConcurrency: 2,
        perQueryLimitMib: 512,
        budgetGib: mibToGib(2 * 512), // 1.00 GiB
      },
      maintenance: {
        lane: 'maintenance',
        maxConcurrency: 1,
        perQueryLimitMib: maintenanceMib,
        budgetGib: mibToGib(1 * maintenanceMib), // 0.75 GiB
      },
      loader: {
        lane: 'loader',
        maxConcurrency: 2,
        perQueryLimitMib: 256,
        budgetGib: mibToGib(2 * 256), // 0.50 GiB
      },
      reconciliation: {
        lane: 'reconciliation',
        maxConcurrency: 1,
        perQueryLimitMib: 256,
        budgetGib: mibToGib(1 * 256), // 0.25 GiB
      },
    },
    maintenancePriorityOrder: [...MAINTENANCE_PRIORITY_ORDER],
  };
}

export const DEFAULT_8GIB_MEMORY_BUDGET: ClickHouseMemoryBudgetSheet =
  createDefault8GiBMemoryBudget();

export function validateMemoryBudgetSheet(
  sheet: ClickHouseMemoryBudgetSheet
): MemoryBudgetValidationResult {
  const violations: string[] = [];
  const expectedWorkingCap = sheet.serverLimitGib * sheet.workingCapFraction;

  let laneSumGib = 0;
  for (const laneSpec of Object.values(sheet.lanes)) {
    const computedGib = mibToGib(laneSpec.maxConcurrency * laneSpec.perQueryLimitMib);
    if (Math.abs(computedGib - laneSpec.budgetGib) > 0.005) {
      violations.push(
        `Lane "${laneSpec.lane}" budgetGib (${laneSpec.budgetGib}) mismatches concurrency*limit (${computedGib.toFixed(4)})`
      );
    }
    laneSumGib += laneSpec.budgetGib;
  }

  if (sheet.lanes.maintenance.maxConcurrency !== 1) {
    violations.push('maintenance lane MUST remain single-lane (maxConcurrency === 1)');
  }

  const maintLedger = getConstant('store.maintenance_lane_mib');
  const maxMaintMib = typeof maintLedger?.value === 'number' ? maintLedger.value : 768;
  if (sheet.lanes.maintenance.perQueryLimitMib > maxMaintMib) {
    violations.push(
      `maintenance lane limit (${sheet.lanes.maintenance.perQueryLimitMib} MiB) exceeds ledger ceiling (${maxMaintMib} MiB)`
    );
  }

  const totalBudgetedGib =
    sheet.backgroundMergesAndMutationsGib + sheet.cachesGib + laneSumGib;

  if (totalBudgetedGib > expectedWorkingCap + 1e-9) {
    violations.push(
      `Total budgeted memory (${totalBudgetedGib.toFixed(4)} GiB) exceeds 85% working cap (${expectedWorkingCap.toFixed(4)} GiB)`
    );
  }

  if (sheet.serverLimitGib > sheet.hostRamGib * 0.9 + 1e-9) {
    violations.push(
      `serverLimitGib (${sheet.serverLimitGib}) exceeds 90% of host RAM (${sheet.hostRamGib})`
    );
  }

  return {
    valid: violations.length === 0,
    totalBudgetedGib: Number(totalBudgetedGib.toFixed(4)),
    workingCapGib: Number(expectedWorkingCap.toFixed(4)),
    headroomGib: Number((expectedWorkingCap - totalBudgetedGib).toFixed(4)),
    violations,
  };
}

export interface LaneLease {
  readonly lane: ClickHouseLaneName;
  readonly leaseId: string;
  readonly estimatedMib: number;
  readonly maintenanceTask?: MaintenanceTaskKind;
  release(): void;
}

export type LaneAdmissionOutcome =
  | {
      readonly admitted: true;
      readonly httpStatus: 200;
      readonly lease: LaneLease;
    }
  | {
      readonly admitted: false;
      readonly httpStatus: 429 | 202;
      readonly action: 'reject_429' | 'route_chunked_job';
      readonly retryAfterSec: number;
      readonly reason: string;
    };

/**
 * In-process lane concurrency and memory semaphore enforcing the 8 GiB budget sheet.
 */
export class MemoryLaneAdmissionController {
  private readonly activeCounts: Record<ClickHouseLaneName, number> = {
    api_live: 0,
    api_heavy: 0,
    maintenance: 0,
    loader: 0,
    reconciliation: 0,
  };
  private activeMaintenanceTask: MaintenanceTaskKind | null = null;
  private leaseSeq = 0;

  public constructor(
    public readonly budget: ClickHouseMemoryBudgetSheet = DEFAULT_8GIB_MEMORY_BUDGET
  ) {
    const check = validateMemoryBudgetSheet(budget);
    if (!check.valid) {
      throw new Error(`Invalid ClickHouse memory budget sheet: ${check.violations.join('; ')}`);
    }
  }

  public getMaintenancePriorityRank(task: MaintenanceTaskKind): number {
    return this.budget.maintenancePriorityOrder.indexOf(task);
  }

  public getActiveCount(lane: ClickHouseLaneName): number {
    return this.activeCounts[lane];
  }

  public getActiveMaintenanceTask(): MaintenanceTaskKind | null {
    return this.activeMaintenanceTask;
  }

  public tryAcquire(args: {
    readonly lane: ClickHouseLaneName;
    readonly estimatedMib: number;
    readonly maintenanceTask?: MaintenanceTaskKind;
    readonly allowAsyncChunkedJob?: boolean;
  }): LaneAdmissionOutcome {
    const spec = this.budget.lanes[args.lane];

    if (args.estimatedMib > spec.perQueryLimitMib) {
      if (args.allowAsyncChunkedJob && (args.lane === 'api_live' || args.lane === 'api_heavy')) {
        return {
          admitted: false,
          httpStatus: 202,
          action: 'route_chunked_job',
          retryAfterSec: 5,
          reason: `Estimated memory (${args.estimatedMib} MiB) exceeds ${args.lane} per-query cap (${spec.perQueryLimitMib} MiB); routed to chunked async job`,
        };
      }
      return {
        admitted: false,
        httpStatus: 429,
        action: 'reject_429',
        retryAfterSec: 15,
        reason: `Estimated memory (${args.estimatedMib} MiB) exceeds ${args.lane} per-query cap (${spec.perQueryLimitMib} MiB)`,
      };
    }

    if (this.activeCounts[args.lane] >= spec.maxConcurrency) {
      if (args.allowAsyncChunkedJob && args.lane === 'api_heavy') {
        return {
          admitted: false,
          httpStatus: 202,
          action: 'route_chunked_job',
          retryAfterSec: 10,
          reason: `Lane "${args.lane}" saturated (${this.activeCounts[args.lane]}/${spec.maxConcurrency}); routed to chunked async job`,
        };
      }
      const retryAfterSec = args.lane === 'maintenance' ? 30 : 5;
      return {
        admitted: false,
        httpStatus: 429,
        action: 'reject_429',
        retryAfterSec,
        reason: `Lane "${args.lane}" saturated (${this.activeCounts[args.lane]}/${spec.maxConcurrency})`,
      };
    }

    this.activeCounts[args.lane] += 1;
    if (args.lane === 'maintenance') {
      this.activeMaintenanceTask = args.maintenanceTask ?? 'builder';
    }

    this.leaseSeq += 1;
    const leaseId = `${args.lane}-${this.leaseSeq}`;
    let released = false;

    const lease: LaneLease = {
      lane: args.lane,
      leaseId,
      estimatedMib: args.estimatedMib,
      maintenanceTask: args.maintenanceTask,
      release: () => {
        if (released) return;
        released = true;
        this.activeCounts[args.lane] = Math.max(0, this.activeCounts[args.lane] - 1);
        if (args.lane === 'maintenance' && this.activeCounts.maintenance === 0) {
          this.activeMaintenanceTask = null;
        }
      },
    };

    return {
      admitted: true,
      httpStatus: 200,
      lease,
    };
  }
}

export interface ClickHouseQueryDescriptor {
  readonly lane: ClickHouseLaneName;
  readonly targetTable: string;
  readonly tenantId?: string | null;
  readonly siteId?: string | null;
  readonly startTimeMs?: number | null;
  readonly endTimeMs?: number | null;
  readonly rightJoinTables?: readonly string[];
  readonly groupByColumns?: readonly string[];
  readonly usesExactDistinct?: boolean;
  readonly usesArrayAgg?: boolean;
  readonly rawSql?: string;
  readonly allowAsyncFallback?: boolean;
}

export interface QueryPolicyDecision {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 202 | 400 | 403 | 429;
  readonly action: 'execute' | 'route_chunked_job' | 'reject_429' | 'reject_scope';
  readonly retryAfterSec: number | null;
  readonly violations: readonly string[];
  readonly clickHouseMaxMemoryBytes: number;
}

const IDENTITY_COLUMNS = new Set<string>([
  'visitor_key',
  'visitor_id',
  'session_key',
  'session_id',
  'pv_id',
  'member_hmac',
  'member_hash',
  'unit_id',
  'req_uid',
]);

const BASE_CLICKHOUSE_TABLES = new Set<string>(
  CANONICAL_SCHEMA.tables
    .filter((t) => t.store === 'clickhouse')
    .map((t) => t.name)
);

const TABLE_METADATA_MAP = new Map(
  CANONICAL_SCHEMA.tables
    .filter((t) => t.store === 'clickhouse')
    .map((t) => [t.name, t])
);

const DAY_MS = 86_400_000;
const MAX_LIVE_WINDOW_DAYS = 90;
const MAX_HEAVY_WINDOW_DAYS = 400;

/**
 * Inspects a ClickHouse query shape BEFORE execution and enforces all §5.6 /
 * `store-final.md` M6 guardrails.
 */
export function inspectQueryPolicy(
  query: ClickHouseQueryDescriptor,
  budget: ClickHouseMemoryBudgetSheet = DEFAULT_8GIB_MEMORY_BUDGET
): QueryPolicyDecision {
  const laneSpec = budget.lanes[query.lane];
  const clickHouseMaxMemoryBytes = laneSpec.perQueryLimitMib * 1024 * 1024;
  const violations: string[] = [];

  // 0. Ban MV / Projection DDL in any runtime SQL
  if (query.rawSql) {
    if (/\bCREATE\s+MATERIALIZED\s+VIEW\b/i.test(query.rawSql)) {
      violations.push('forbidden_materialized_view: Materialized Views are banned on tenant tables ([ch 2, 4])');
    }
    if (/\bADD\s+PROJECTION\b|\bPROJECTION\s+\w+\s*\(/i.test(query.rawSql)) {
      violations.push('forbidden_projection: Projections are banned (ignored by FINAL, breaks lightweight DELETE [ch 13])');
    }
  }

  // 1. Tenant & site boundary predicates are mandatory (hard scope reject)
  const tableMeta = TABLE_METADATA_MAP.get(query.targetTable);
  const requiresSite = tableMeta ? tableMeta.siteScoped : true;

  if (!query.tenantId || query.tenantId.trim().length === 0) {
    violations.push('missing_tenant_scope: every query MUST bind tenant_id');
    return {
      allowed: false,
      httpStatus: 403,
      action: 'reject_scope',
      retryAfterSec: null,
      violations,
      clickHouseMaxMemoryBytes,
    };
  }

  if (requiresSite && (!query.siteId || query.siteId.trim().length === 0)) {
    violations.push(`missing_site_scope: table "${query.targetTable}" requires site_id predicate`);
    return {
      allowed: false,
      httpStatus: 400,
      action: 'reject_scope',
      retryAfterSec: null,
      violations,
      clickHouseMaxMemoryBytes,
    };
  }

  // 2. Bounded time range required
  let routeToChunkedJob = false;
  if (
    query.startTimeMs === undefined ||
    query.startTimeMs === null ||
    query.endTimeMs === undefined ||
    query.endTimeMs === null ||
    !Number.isFinite(query.startTimeMs) ||
    !Number.isFinite(query.endTimeMs) ||
    query.endTimeMs <= query.startTimeMs
  ) {
    violations.push('unbounded_time_range: explicit valid [startTimeMs, endTimeMs) range is mandatory');
  } else {
    const spanDays = (query.endTimeMs - query.startTimeMs) / DAY_MS;
    if (query.lane === 'api_live' && spanDays > MAX_LIVE_WINDOW_DAYS) {
      violations.push(
        `time_range_exceeds_live_lane: ${spanDays.toFixed(1)}d > ${MAX_LIVE_WINDOW_DAYS}d limit for api_live`
      );
      routeToChunkedJob = true;
    } else if (query.lane === 'api_heavy' && spanDays > MAX_HEAVY_WINDOW_DAYS) {
      violations.push(
        `time_range_exceeds_heavy_lane: ${spanDays.toFixed(1)}d > ${MAX_HEAVY_WINDOW_DAYS}d limit for api_heavy`
      );
      routeToChunkedJob = true;
    }
  }

  // 3. Base table on the right-hand side of JOIN is strictly forbidden (OOM amplification)
  if (query.rightJoinTables && query.rightJoinTables.length > 0) {
    for (const rightTable of query.rightJoinTables) {
      if (BASE_CLICKHOUSE_TABLES.has(rightTable)) {
        violations.push(
          `forbidden_right_side_base_join: base table "${rightTable}" cannot appear on the right side of a JOIN`
        );
      }
    }
  }

  // 4. Grouping by identity column not in the table's ORDER BY sort key
  if (query.groupByColumns && query.groupByColumns.length > 0 && tableMeta) {
    const orderBySet = new Set<string>(tableMeta.orderBy);
    for (const col of query.groupByColumns) {
      if (IDENTITY_COLUMNS.has(col) && !orderBySet.has(col)) {
        violations.push(
          `group_by_identity_not_in_sort_key: grouping by identity column "${col}" on "${query.targetTable}" (ORDER BY ${tableMeta.orderBy.join(', ')}) risks high-cardinality OOM`
        );
        routeToChunkedJob = true;
      }
    }
  }

  // 5. Exact-distinct / array aggregations forbidden in `api_live`
  const sqlUsesExactDistinct =
    query.usesExactDistinct ||
    (query.rawSql !== undefined &&
      /\b(uniqExact|COUNT\s*\(\s*DISTINCT)\b/i.test(query.rawSql));
  const sqlUsesArrayAgg =
    query.usesArrayAgg ||
    (query.rawSql !== undefined &&
      /\b(groupArray|groupUniqArray)\b/i.test(query.rawSql));

  if (query.lane === 'api_live' && (sqlUsesExactDistinct || sqlUsesArrayAgg)) {
    violations.push(
      'forbidden_live_exact_distinct_or_array_agg: exact-distinct and array aggregations are disallowed in api_live (160 MiB cap)'
    );
    routeToChunkedJob = true;
  }

  if (violations.length === 0) {
    return {
      allowed: true,
      httpStatus: 200,
      action: 'execute',
      retryAfterSec: null,
      violations: [],
      clickHouseMaxMemoryBytes,
    };
  }

  // Hard bans (right-side base join, MV/projection, unbounded time) ALWAYS reject 429
  const hasHardReject = violations.some(
    (v) =>
      v.startsWith('forbidden_right_side_base_join') ||
      v.startsWith('unbounded_time_range') ||
      v.startsWith('forbidden_materialized_view') ||
      v.startsWith('forbidden_projection')
  );

  if (!hasHardReject && routeToChunkedJob && query.allowAsyncFallback !== false) {
    return {
      allowed: false,
      httpStatus: 202,
      action: 'route_chunked_job',
      retryAfterSec: 10,
      violations,
      clickHouseMaxMemoryBytes,
    };
  }

  return {
    allowed: false,
    httpStatus: 429,
    action: 'reject_429',
    retryAfterSec: 30,
    violations,
    clickHouseMaxMemoryBytes,
  };
}
