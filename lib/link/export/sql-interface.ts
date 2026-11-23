/**
 * UGOKI LINK v2 — Tenant-Scoped Read-Only SQL Interface (§11.11 #7)
 *
 * Enforces every SQL boundary rule from §11.11 #7 & §5.6:
 * - Per-tenant read-only ClickHouse identity (`ugk_ro_<tenantId>`, `readonly = 1`,
 *   `users_without_row_policies_can_read_rows = 0`) via `TenantScopedQueryBuilder`
 * - Strict `inspectSqlAst` pass (SELECT-only, single statement, tenant bind, time bound,
 *   no right-side base-table JOIN, no unindexed identity GROUP BY, no SETTINGS override)
 * - Public Views Whitelist ONLY (rejects `system.*`, internal tables, and non-public views)
 * - Allowed Functions Whitelist ONLY (rejects `url`, `s3`, `remote`, `mysql`, `postgresql`,
 *   `odbc`, `jdbc`, `file`, `hdfs`, `input`, `cluster`, `dictionaryGet`, etc.)
 * - Cost-unit & memory ceiling enforcement
 * - Serializes results through `packages/contract/response` (`buildResponseEnvelope`)
 *   and stamps `ad_hoc_sql_not_authoritative = true` (確定値扱い禁止印) whenever free-form
 *   SQL cannot mechanically attach verified evidence/sample/missingness provenance!
 */

import type { VerifiedPrincipal } from '../auth';
import {
  extractSqlFunctionCalls,
  inspectSqlAst,
  perTenantRoUsername,
  TenantScopedQueryBuilder,
  tokenizeSql,
  type SanctionedClickHouseQuery,
} from '../isolation';
import {
  buildResponseEnvelope,
  createDataLayerMetric,
  sha256Hex,
  type ActiveEvidenceRef,
  type SerializedResponseEnvelope,
} from '../../../packages/contract/response';
import { CANONICAL_SCHEMA } from '../../../packages/contract/schema';
import type { DataRegion } from '../../../workers/link-wal';

/**
 * Closed whitelist of tenant-facing public SQL views (§11.11 #7).
 */
export const PUBLIC_SQL_VIEWS: ReadonlySet<string> = new Set([
  'rollup_page_hourly',
  'rollup_section_hourly',
  'rollup_element_hourly',
  'rollup_site_daily',
  'dim_pages',
  'dim_sections',
  'v_site_hourly',
  'v_page_hourly',
  'v_conversion_daily',
  'v_loss_ledger_daily',
  'v_actor_daily',
]);

/**
 * Closed whitelist of safe read-only SQL functions allowed inside ad-hoc queries.
 */
export const ALLOWED_SQL_FUNCTIONS: ReadonlySet<string> = new Set([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'round',
  'floor',
  'ceil',
  'abs',
  'coalesce',
  'nullif',
  'if',
  'multiif',
  'countif',
  'sumif',
  'avgif',
  'quantile',
  'quantiles',
  'tostartofhour',
  'tostartofday',
  'tostartofweek',
  'tostartofmonth',
  'todate',
  'todatetime',
  'lower',
  'upper',
  'length',
  'substring',
  'cast',
  'greatest',
  'least',
]);

/**
 * Explicitly forbidden external-connection / table / system functions.
 */
export const FORBIDDEN_SQL_FUNCTIONS: ReadonlySet<string> = new Set([
  'url',
  'remote',
  'remotesecure',
  's3',
  's3cluster',
  'gcs',
  'hdfs',
  'file',
  'mysql',
  'postgresql',
  'odbc',
  'jdbc',
  'mongodb',
  'redis',
  'input',
  'format',
  'cluster',
  'clusterallreplicas',
  'dictionaryget',
  'dictget',
  'currentuser',
  'getsetting',
  'sleep',
  'sleepeachrow',
]);

export const DEFAULT_SQL_MAX_MEMORY_BYTES = 160 * 1024 * 1024; // 160 MiB (api_live cap)
export const DEFAULT_SQL_MAX_COST_UNITS = 100;

export interface SqlExecutionPort {
  execute(
    query: SanctionedClickHouseQuery,
    limits: { readonly maxMemoryBytes: number; readonly maxRows: number }
  ): Promise<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly scannedRows: number;
    readonly costUnitsUsed: number;
    readonly durationMs: number;
  }>;
}

export interface AdHocSqlRequest {
  readonly principal: VerifiedPrincipal;
  readonly siteId: string;
  readonly sql: string;
  readonly params?: Readonly<
    Record<string, string | number | boolean | ReadonlyArray<string | number>>
  >;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly storageRegion: DataRegion;
  readonly processingRegion?: string;
  readonly estimatedCostUnits?: number;
  readonly estimatedMemoryBytes?: number;
  readonly maxRows?: number;
  /** True only for pre-registered catalog queries that carry verified sample/missingness metadata. */
  readonly isRegisteredCatalogQuery?: boolean;
  readonly nowMs?: number;
}

export interface AdHocSqlValidationResult {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 400 | 403 | 429;
  readonly sanitizedQuery: SanctionedClickHouseQuery | null;
  readonly violations: readonly string[];
}

export interface AdHocSqlResponse {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 400 | 403 | 429;
  readonly clickhouseUser: string;
  readonly authoritativeTruthProhibited: boolean;
  readonly violations: readonly string[];
  readonly envelope: SerializedResponseEnvelope | null;
}

function brandDataNumbers(
  value: unknown,
  refId: string,
  createdAt: string
): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return createDataLayerMetric(value, refId, { createdAt });
  }
  if (Array.isArray(value)) {
    return value.map((item) => brandDataNumbers(item, refId, createdAt));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = brandDataNumbers(v, refId, createdAt);
    }
    return out;
  }
  return value;
}

function extractCalledFunctions(sql: string): string[] {
  return extractSqlFunctionCalls(sql);
}

function hasForbiddenSchemaToken(sql: string): boolean {
  const lex = tokenizeSql(sql);
  for (let i = 0; i < lex.tokens.length - 1; i += 1) {
    const t = lex.tokens[i]!;
    const next = lex.tokens[i + 1]!;
    if (
      t.kind === 'IDENT' &&
      (t.lower === 'system' || t.lower === 'information_schema' || t.lower === 'pg_catalog') &&
      next.kind === 'PUNCT' &&
      next.value === '.'
    ) {
      return true;
    }
  }
  return false;
}

export class TenantSqlInterface {
  private readonly queryBuilder: TenantScopedQueryBuilder;
  private readonly maxMemoryBytes: number;
  private readonly maxCostUnits: number;

  public constructor(
    private readonly executor: SqlExecutionPort,
    options?: {
      readonly queryBuilder?: TenantScopedQueryBuilder;
      readonly maxMemoryBytes?: number;
      readonly maxCostUnits?: number;
    }
  ) {
    this.queryBuilder = options?.queryBuilder ?? new TenantScopedQueryBuilder();
    this.maxMemoryBytes = options?.maxMemoryBytes ?? DEFAULT_SQL_MAX_MEMORY_BYTES;
    this.maxCostUnits = options?.maxCostUnits ?? DEFAULT_SQL_MAX_COST_UNITS;
  }

  /**
   * Validates SQL against `lib/link/isolation` AST inspector, public views
   * whitelist, allowed SQL functions whitelist, and cost/memory ceilings.
   */
  public validateQuery(req: AdHocSqlRequest): AdHocSqlValidationResult {
    const violations: string[] = [];

    if (!req.principal.effectiveScopes.has('analytics:read')) {
      return {
        allowed: false,
        httpStatus: 403,
        sanitizedQuery: null,
        violations: ['missing_scope: analytics:read required for SQL interface'],
      };
    }

    // 1. Block `system.*`, `information_schema.*`, and `pg_catalog.*` via state-machine lexer
    if (hasForbiddenSchemaToken(req.sql)) {
      violations.push(
        'forbidden_system_table: queries against system.*, information_schema.*, or pg_catalog.* are strictly forbidden'
      );
    }

    // 2. Function whitelist & forbidden external-connection functions
    const calledFns = extractCalledFunctions(req.sql);
    for (const fn of calledFns) {
      if (FORBIDDEN_SQL_FUNCTIONS.has(fn)) {
        violations.push(`forbidden_external_or_system_function: "${fn}()" is forbidden`);
      } else if (!ALLOWED_SQL_FUNCTIONS.has(fn)) {
        violations.push(`unlisted_sql_function: "${fn}()" is not in the SQL function allowlist`);
      }
    }

    // 3. Run `lib/link/isolation` AST inspector (enforcing site_id predicate when credential is site-scoped)
    const siteRestricted =
      req.principal.allowedSiteIds !== null && !req.principal.allowedSiteIds.includes('*');
    const ast = inspectSqlAst(req.sql, {
      requireTenantFilter: true,
      requireSiteFilter: siteRestricted,
      requireTimeBound: true,
    });
    for (const v of ast.violations) {
      violations.push(`[${v.code}] ${v.message}`);
    }

    // 4. Enforce Public Views Whitelist ONLY
    if (ast.tables.length === 0) {
      violations.push('missing_table_reference: query must reference at least one whitelisted public view');
    }
    for (const tbl of ast.tables) {
      if (!PUBLIC_SQL_VIEWS.has(tbl)) {
        violations.push(
          `table_not_in_public_view_whitelist: "${tbl}" is not a whitelisted public SQL view`
        );
      }
    }

    // 5. Enforce memory & cost-unit ceilings
    if (
      req.estimatedMemoryBytes !== undefined &&
      req.estimatedMemoryBytes > this.maxMemoryBytes
    ) {
      return {
        allowed: false,
        httpStatus: 429,
        sanitizedQuery: null,
        violations: [
          ...violations,
          `memory_budget_exceeded: estimated ${req.estimatedMemoryBytes} B > cap ${this.maxMemoryBytes} B`,
        ],
      };
    }

    if (
      req.estimatedCostUnits !== undefined &&
      req.estimatedCostUnits > this.maxCostUnits
    ) {
      return {
        allowed: false,
        httpStatus: 429,
        sanitizedQuery: null,
        violations: [
          ...violations,
          `cost_unit_budget_exceeded: estimated ${req.estimatedCostUnits} > cap ${this.maxCostUnits}`,
        ],
      };
    }

    if (violations.length > 0) {
      const hasSiteScopeViolation = violations.some((v) =>
        v.includes('[MISSING_SITE_BIND_PREDICATE]')
      );
      return {
        allowed: false,
        httpStatus: hasSiteScopeViolation ? 403 : 400,
        sanitizedQuery: null,
        violations,
      };
    }

    // 6. Build sanctioned tenant-bound query through `TenantScopedQueryBuilder`
    try {
      const sanitized = this.queryBuilder.build(req.principal, {
        sql: req.sql,
        siteId: req.siteId,
        params: req.params,
      });
      return {
        allowed: true,
        httpStatus: 200,
        sanitizedQuery: sanitized,
        violations: [],
      };
    } catch (err) {
      return {
        allowed: false,
        httpStatus: 403,
        sanitizedQuery: null,
        violations: [err instanceof Error ? err.message : 'tenant_query_builder_rejected'],
      };
    }
  }

  /**
   * Validates and executes a tenant-scoped read-only SQL query, wrapping the
   * output in `packages/contract/response` (`buildResponseEnvelope`).
   *
   * Any free-form (non-catalog) SQL result carries `authoritativeTruthProhibited = true`
   * (確定値扱い禁止印) and `warnings` because arbitrary SQL cannot mechanically
   * attach verified sample size, missingness, and causal evidence guarantees (§11.11 #7).
   */
  public async executeQuery(req: AdHocSqlRequest): Promise<AdHocSqlResponse> {
    const roUser = perTenantRoUsername(req.principal.tenantId);
    const validation = this.validateQuery(req);

    if (!validation.allowed || !validation.sanitizedQuery) {
      return {
        allowed: false,
        httpStatus: validation.httpStatus,
        clickhouseUser: roUser,
        authoritativeTruthProhibited: true,
        violations: validation.violations,
        envelope: null,
      };
    }

    // Defense-in-depth execution guard for site-scoped credentials
    const siteRestricted =
      req.principal.allowedSiteIds !== null && !req.principal.allowedSiteIds.includes('*');
    if (siteRestricted) {
      const execAst = inspectSqlAst(validation.sanitizedQuery.sql, {
        requireTenantFilter: true,
        requireSiteFilter: true,
        requireTimeBound: true,
      });
      if (!execAst.valid) {
        return {
          allowed: false,
          httpStatus: 403,
          clickhouseUser: roUser,
          authoritativeTruthProhibited: true,
          violations: execAst.violations.map((v) => `[${v.code}] ${v.message}`),
          envelope: null,
        };
      }
    }

    const nowMs = req.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const execResult = await this.executor.execute(validation.sanitizedQuery, {
      maxMemoryBytes: this.maxMemoryBytes,
      maxRows: Math.min(10_000, Math.max(1, req.maxRows ?? 1000)),
    });

    if (execResult.costUnitsUsed > this.maxCostUnits) {
      return {
        allowed: false,
        httpStatus: 429,
        clickhouseUser: roUser,
        authoritativeTruthProhibited: true,
        violations: [
          `cost_unit_budget_exceeded: used ${execResult.costUnitsUsed} > cap ${this.maxCostUnits}`,
        ],
        envelope: null,
      };
    }

    const isAdHoc = req.isRegisteredCatalogQuery !== true;
    const ref: ActiveEvidenceRef = {
      ref_id: `sql:${req.principal.tenantId}:${req.siteId}:${sha256Hex(validation.sanitizedQuery.sql).slice(0, 12)}`,
      kind: 'query',
      params_hash: sha256Hex(JSON.stringify(validation.sanitizedQuery.query_params)),
      watermarks: { executed_at: nowIso },
      result_digest: sha256Hex(JSON.stringify(execResult.rows)),
      issued_at: nowIso,
      valid_until: new Date(nowMs + 3_600_000).toISOString(),
      kid: `sql_ro_${req.storageRegion}`,
    };

    const envelope = buildResponseEnvelope({
      window: {
        start: req.windowStartIso,
        end: req.windowEndIso,
        timezone: 'UTC',
      },
      freshness: {
        data_through: nowIso,
        lag_s: 0,
        sources: { clickhouse_ro: nowIso },
        stale: false,
      },
      coverage: {
        ratio: 1,
        denominator_n: execResult.scannedRows,
      },
      lineage: {
        schema_version: CANONICAL_SCHEMA.meta.schemaVersion,
        def_ver: 1,
        collection_gen: 'v3',
      },
      residency: {
        storage_region: req.storageRegion,
        processing_region: req.processingRegion ?? req.storageRegion,
      },
      usage: {
        cost_units: execResult.costUnitsUsed,
        meter: 'sql_interface',
        remaining_quota: Math.max(0, this.maxCostUnits - execResult.costUnitsUsed),
      },
      warnings: isAdHoc
        ? [
            'ad_hoc_sql_cannot_serve_as_authoritative_truth: arbitrary SQL results lack mechanically verified coverage/missingness guarantees and MUST NOT be treated as authoritative figures (§11.11 #7)',
          ]
        : [],
      quality: {
        source: 'sealed',
        exactness: isAdHoc ? 'approx' : 'exact_as_of_build',
        collection_gen: 'v3',
      },
      measures: {
        sql_row_count: {
          value: createDataLayerMetric(execResult.rows.length, ref.ref_id, {
            createdAt: nowIso,
          }),
          unit: 'rows',
          status: 'ok',
          evidence: {
            level: isAdHoc ? 'inferred' : 'observed',
            exactness: isAdHoc ? 'approx' : 'exact_as_of_build',
            criteria: [],
            refs: [ref],
            scope: `sql_ro:${req.siteId}`,
          },
          sample: { n: execResult.scannedRows, unit_kind: 'row' },
          interval: null,
        },
      },
      data: brandDataNumbers(
        {
          clickhouse_user: validation.sanitizedQuery.clickhouseUser,
          tables: validation.sanitizedQuery.tables,
          authoritative_truth_prohibited: isAdHoc,
          ad_hoc_sql_not_authoritative: isAdHoc,
          rows: execResult.rows,
          duration_ms: execResult.durationMs,
        },
        ref.ref_id,
        nowIso
      ),
    });

    return {
      allowed: true,
      httpStatus: 200,
      clickhouseUser: validation.sanitizedQuery.clickhouseUser,
      authoritativeTruthProhibited: isAdHoc,
      violations: [],
      envelope,
    };
  }
}
