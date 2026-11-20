/**
 * UGOKI LINK v2 — ClickHouse SQL AST / Syntax Inspector (Isolation Layer A & Gate surf.G3)
 *
 * Enforces `store-final.md` M6/M7 and `surface-final.md` §8.3 (G3):
 *   - SELECT-only, single statement, no comments smuggling or DDL/DML/role/settings mutation
 *   - No `SELECT *` or `alias.*`
 *   - Mandatory typed bind `tenant_id = {tenant_id:String}` on every tenant-scoped table query
 *   - No inline string interpolation / quote-payload smuggling on tenant/site/entity filters
 *   - Mandatory bounded time-range filter
 *   - Raw base fact tables forbidden on the RIGHT side of any JOIN
 *   - `GROUP BY` on unindexed identity columns forbidden (prevents Code 241 OOM)
 */

export type SqlViolationCode =
  | 'EMPTY_SQL'
  | 'MULTI_STATEMENT'
  | 'NON_SELECT_STATEMENT'
  | 'FORBIDDEN_DDL_DML_OR_CONTROL'
  | 'FORBIDDEN_SETTINGS_OR_FILTER_OVERRIDE'
  | 'FORBIDDEN_SELECT_STAR'
  | 'MISSING_TENANT_BIND_PREDICATE'
  | 'INLINE_TENANT_OR_ID_LITERAL'
  | 'SUSPECT_SQL_INJECTION_PAYLOAD'
  | 'MISSING_TIME_BOUND_FILTER'
  | 'BASE_TABLE_ON_JOIN_RIGHT'
  | 'UNINDEXED_IDENTITY_GROUP_BY';

export interface SqlAstViolation {
  readonly code: SqlViolationCode;
  readonly message: string;
  readonly snippet?: string;
}

export interface SqlInspectionResult {
  readonly valid: boolean;
  readonly tables: ReadonlyArray<string>;
  readonly typedBinds: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly violations: ReadonlyArray<SqlAstViolation>;
}

export interface TenantTableSchemaMeta {
  readonly table: string;
  readonly isRawBaseTable: boolean;
  readonly timeColumns: ReadonlyArray<string>;
  /** Leading ORDER BY columns in ClickHouse MergeTree definition. */
  readonly orderingKey: ReadonlyArray<string>;
}

export const TENANT_TABLE_CATALOG: Readonly<Record<string, TenantTableSchemaMeta>> = {
  events: {
    table: 'events',
    isRawBaseTable: true,
    timeColumns: ['timestamp', 'pv_hour', 'occurred_at'],
    orderingKey: ['tenant_id', 'site_id', 'timestamp'],
  },
  events_v2: {
    table: 'events_v2',
    isRawBaseTable: true,
    timeColumns: ['timestamp', 'pv_hour'],
    orderingKey: ['tenant_id', 'site_id', 'timestamp'],
  },
  frame_log: {
    table: 'frame_log',
    isRawBaseTable: true,
    timeColumns: ['minute_recv', 'pv_hour'],
    orderingKey: ['tenant_id', 'site_id', 'minute_recv', 'pv_id'],
  },
  frame_payload: {
    table: 'frame_payload',
    isRawBaseTable: true,
    timeColumns: ['pv_hour'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'pv_id'],
  },
  page_view_state: {
    table: 'page_view_state',
    isRawBaseTable: true,
    timeColumns: ['pv_hour', 'day_local'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'page_id', 'pv_id'],
  },
  trajectories: {
    table: 'trajectories',
    isRawBaseTable: true,
    timeColumns: ['pv_hour', 'timestamp'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'pv_id'],
  },
  lab_events: {
    table: 'lab_events',
    isRawBaseTable: true,
    timeColumns: ['pv_hour', 'occurred_at'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'lab_run_id'],
  },
  access_obs: {
    table: 'access_obs',
    isRawBaseTable: true,
    timeColumns: ['minute', 'pv_hour', 'observed_at'],
    orderingKey: ['tenant_id', 'site_id', 'minute'],
  },
  decision_log: {
    table: 'decision_log',
    isRawBaseTable: true,
    timeColumns: ['decided_hour', 'occurred_at'],
    orderingKey: ['tenant_id', 'site_id', 'decided_hour', 'decision_id'],
  },
  exposure_log: {
    table: 'exposure_log',
    isRawBaseTable: true,
    timeColumns: ['exposed_hour', 'occurred_at'],
    orderingKey: ['tenant_id', 'site_id', 'exposed_hour', 'experiment_id'],
  },
  conversion_events: {
    table: 'conversion_events',
    isRawBaseTable: true,
    timeColumns: ['occurred_at', 'day_local'],
    orderingKey: ['tenant_id', 'site_id', 'occurred_at'],
  },
  rollup_page_hourly: {
    table: 'rollup_page_hourly',
    isRawBaseTable: false,
    timeColumns: ['pv_hour', 'bucket_start'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'page_id'],
  },
  rollup_section_hourly: {
    table: 'rollup_section_hourly',
    isRawBaseTable: false,
    timeColumns: ['pv_hour', 'bucket_start'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'page_id', 'sec_fp'],
  },
  rollup_element_hourly: {
    table: 'rollup_element_hourly',
    isRawBaseTable: false,
    timeColumns: ['pv_hour', 'bucket_start'],
    orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'page_id', 'el_fp'],
  },
  rollup_site_daily: {
    table: 'rollup_site_daily',
    isRawBaseTable: false,
    timeColumns: ['day_local'],
    orderingKey: ['tenant_id', 'site_id', 'day_local'],
  },
  dim_pages: {
    table: 'dim_pages',
    isRawBaseTable: false,
    timeColumns: ['observed_at', 'snapshot_ts'],
    orderingKey: ['tenant_id', 'site_id', 'page_id'],
  },
  dim_sections: {
    table: 'dim_sections',
    isRawBaseTable: false,
    timeColumns: ['observed_at', 'snapshot_ts'],
    orderingKey: ['tenant_id', 'site_id', 'page_id', 'sec_fp'],
  },
  fact_structure_asof: {
    table: 'fact_structure_asof',
    isRawBaseTable: false,
    timeColumns: ['observed_at', 'valid_from'],
    orderingKey: ['tenant_id', 'site_id', 'page_id', 'observed_at'],
  },
  snapshot_registry: {
    table: 'snapshot_registry',
    isRawBaseTable: false,
    timeColumns: ['created_at', 'observed_at'],
    orderingKey: ['tenant_id', 'site_id', 'snapshot_id'],
  },
  visitor_identity_index: {
    table: 'visitor_identity_index',
    isRawBaseTable: false,
    timeColumns: ['day_local', 'last_seen_at'],
    orderingKey: ['tenant_id', 'site_id', 'visitor_id', 'day_local'],
  },
};

export const RAW_BASE_TABLES: ReadonlySet<string> = new Set(
  Object.values(TENANT_TABLE_CATALOG)
    .filter((m) => m.isRawBaseTable)
    .map((m) => m.table)
);

const IDENTITY_COLUMNS: ReadonlySet<string> = new Set([
  'visitor_id',
  'user_id',
  'external_id',
  'ga_client_id',
  'session_id',
  'pv_id',
  'ip_hash',
]);

const RECOGNIZED_TIME_COLUMNS: ReadonlyArray<string> = [
  'pv_hour',
  'timestamp',
  'day_local',
  'bucket_start',
  'window_start',
  'occurred_at',
  'decided_hour',
  'exposed_hour',
  'minute_recv',
  'minute',
  'observed_at',
  'snapshot_ts',
  'valid_from',
  'created_at',
  'last_seen_at',
  'date',
];

const FORBIDDEN_TOP_LEVEL_KEYWORDS = [
  'INSERT',
  'ALTER',
  'DROP',
  'CREATE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'GRANT',
  'REVOKE',
  'SYSTEM',
  'OPTIMIZE',
  'RENAME',
  'EXCHANGE',
  'KILL',
  'DELETE',
  'UPDATE',
  'USE',
  'SHOW',
  'DESCRIBE',
  'EXPLAIN',
];

const SENSITIVE_FILTER_COLUMNS = [
  'tenant_id',
  'site_id',
  'page_id',
  'visitor_id',
  'user_id',
  'external_id',
  'session_id',
  'job_id',
  'snapshot_id',
  'grant_id',
];

const TYPED_BIND_REGEX = /\{([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z0-9_() ,]+)\}/g;

export interface InspectSqlOptions {
  /** Set true ONLY for non-tenant system/health checks; defaults to true (strict tenant mode). */
  readonly requireTenantFilter?: boolean;
  /** Set true to enforce bounded time-range filter (default true). */
  readonly requireTimeBound?: boolean;
}

/**
 * Strips SQL string literals and comments carefully for structural keyword scanning,
 * while simultaneously detecting comment/quote smuggling.
 */
function stripStringLiterals(sql: string): { readonly stripped: string; readonly hasUnbalancedQuotes: boolean } {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") {
        i++;
        continue;
      }
      if (inSingle && sql[i - 1] === '\\') {
        continue;
      }
      inSingle = !inSingle;
      out += "'";
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += '"';
      continue;
    }
    if (!inSingle && !inDouble) {
      out += ch;
    } else {
      out += ' ';
    }
  }
  return { stripped: out, hasUnbalancedQuotes: inSingle || inDouble };
}

function normalizeTableName(raw: string): string {
  const cleaned = raw.replace(/[`"]/g, '').trim().toLowerCase();
  const parts = cleaned.split('.');
  return parts[parts.length - 1];
}

export function inspectSqlAst(sql: string, options: InspectSqlOptions = {}): SqlInspectionResult {
  const requireTenantFilter = options.requireTenantFilter ?? true;
  const requireTimeBound = options.requireTimeBound ?? true;
  const violations: SqlAstViolation[] = [];

  const trimmed = sql.trim();
  if (!trimmed) {
    return {
      valid: false,
      tables: [],
      typedBinds: [],
      violations: [{ code: 'EMPTY_SQL', message: 'SQL query must not be empty' }],
    };
  }

  // Reject SQL comments outright to prevent comment-based AST bypass / smuggling
  if (/--|\/\*|\*\//.test(trimmed)) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'SQL comments (-- or /* */) are forbidden in sanctioned queries',
    });
  }

  // Reject NUL bytes
  if (trimmed.includes('\0')) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'NUL byte detected in SQL text',
    });
  }

  const { stripped, hasUnbalancedQuotes } = stripStringLiterals(trimmed);
  if (hasUnbalancedQuotes) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'Unbalanced quotes detected in SQL text',
    });
  }

  // Strip a single harmless trailing semicolon, then reject any remaining semicolon
  const noTrailingSemi = stripped.replace(/;\s*$/, '');
  if (noTrailingSemi.includes(';')) {
    violations.push({
      code: 'MULTI_STATEMENT',
      message: 'Multiple SQL statements separated by ";" are forbidden',
    });
  }

  // Must start with SELECT or WITH (CTE leading to SELECT)
  if (!/^(SELECT|WITH)\b/i.test(noTrailingSemi)) {
    violations.push({
      code: 'NON_SELECT_STATEMENT',
      message: 'Only read-only SELECT / WITH ... SELECT statements are permitted',
    });
  }

  // Reject any DDL / DML / control keywords anywhere outside string literals
  for (const kw of FORBIDDEN_TOP_LEVEL_KEYWORDS) {
    const kwRe = new RegExp(`\\b${kw}\\b`, 'i');
    if (kwRe.test(noTrailingSemi)) {
      violations.push({
        code: 'FORBIDDEN_DDL_DML_OR_CONTROL',
        message: `Forbidden SQL keyword "${kw}" detected`,
        snippet: kw,
      });
    }
  }

  // Reject SETTINGS / additional_table_filters / SET ROLE / ROW POLICY / FORMAT override tricks
  if (
    /\bSETTINGS\b/i.test(noTrailingSemi) ||
    /\badditional_table_filters\b/i.test(trimmed) ||
    /\bSET\s+ROLE\b/i.test(noTrailingSemi) ||
    /\bSET\s+DEFAULT\s+ROLE\b/i.test(noTrailingSemi) ||
    /\bROW\s+POLICY\b/i.test(noTrailingSemi)
  ) {
    violations.push({
      code: 'FORBIDDEN_SETTINGS_OR_FILTER_OVERRIDE',
      message: 'SETTINGS clauses, additional_table_filters, and role overrides are strictly forbidden in query SQL',
    });
  }

  // Reject JS template interpolation artifacts (`${...}`) or boolean tautology injection patterns
  if (
    /\$\{[^}]+\}/.test(trimmed) ||
    /\bOR\s+['"]?1['"]?\s*=\s*['"]?1['"]?/i.test(trimmed) ||
    /\bOR\s+TRUE\b/i.test(noTrailingSemi)
  ) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'Detected string interpolation or tautology predicate (OR 1=1 / OR TRUE)',
    });
  }

  // Reject SELECT * or alias.* (allow COUNT(*))
  const withoutCountStar = noTrailingSemi.replace(/\bCOUNT\s*\(\s*\*\s*\)/gi, 'COUNT(1)');
  if (/\bSELECT\b[\s\S]*?(?:^|[\s,])(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?\*(?:[\s,]|$)/i.test(withoutCountStar)) {
    violations.push({
      code: 'FORBIDDEN_SELECT_STAR',
      message: 'SELECT * and alias.* are forbidden; enumerate projected columns explicitly',
    });
  }

  // Extract typed ClickHouse binds `{name:Type}`
  const typedBinds: Array<{ name: string; type: string }> = [];
  let bindMatch: RegExpExecArray | null;
  const bindRe = new RegExp(TYPED_BIND_REGEX.source, 'g');
  while ((bindMatch = bindRe.exec(trimmed)) !== null) {
    typedBinds.push({ name: bindMatch[1], type: bindMatch[2].trim() });
  }

  // Extract FROM and JOIN tables
  const tables: string[] = [];
  const fromRe = /\bFROM\s+([`"]?[a-zA-Z_][a-zA-Z0-9_.]*[`"]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(noTrailingSemi)) !== null) {
    const tbl = normalizeTableName(m[1]);
    if (tbl && tbl !== 'select' && !tables.includes(tbl)) {
      tables.push(tbl);
    }
  }

  const joinRe = /\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|ANY|ALL|ASOF|GLOBAL)\s+)*JOIN\s+([`"]?[a-zA-Z_][a-zA-Z0-9_.]*[`"]?)/gi;
  while ((m = joinRe.exec(noTrailingSemi)) !== null) {
    const rightTbl = normalizeTableName(m[1]);
    if (rightTbl && !tables.includes(rightTbl)) {
      tables.push(rightTbl);
    }
    // Base fact tables MUST NOT appear on the RIGHT side of any JOIN (`store-final.md` M6)
    if (RAW_BASE_TABLES.has(rightTbl)) {
      violations.push({
        code: 'BASE_TABLE_ON_JOIN_RIGHT',
        message: `Raw base table "${rightTbl}" is forbidden on the RIGHT side of a JOIN (causes ClickHouse hash-table OOM)`,
        snippet: rightTbl,
      });
    }
  }

  // Reject inline string literals on sensitive filter columns (must use typed `{param:Type}` binds)
  for (const col of SENSITIVE_FILTER_COLUMNS) {
    const inlineLitRe = new RegExp(
      `\\b(?:[a-zA-Z_][a-zA-Z0-9_]*\\.)?${col}\\s*(?:=|!=|<>|IN\\s*\\()\\s*'`,
      'i'
    );
    if (inlineLitRe.test(trimmed)) {
      violations.push({
        code: 'INLINE_TENANT_OR_ID_LITERAL',
        message: `Column "${col}" must use a typed ClickHouse parameter bind ({${col}:String}), never an inline quoted literal`,
        snippet: col,
      });
    }
  }

  // Mandatory typed `tenant_id = {tenant_id:String}` predicate in WHERE
  if (requireTenantFilter) {
    const hasWhere = /\bWHERE\b/i.test(noTrailingSemi);
    const hasTenantBind =
      /\b(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?tenant_id\s*=\s*\{tenant_id\s*:\s*String\}/i.test(trimmed);
    if (!hasWhere || !hasTenantBind) {
      violations.push({
        code: 'MISSING_TENANT_BIND_PREDICATE',
        message: 'Every tenant query MUST include `tenant_id = {tenant_id:String}` in its WHERE clause',
      });
    }
  }

  // Mandatory bounded time-range filter
  if (requireTimeBound) {
    const whereIdx = noTrailingSemi.search(/\bWHERE\b/i);
    const whereClause = whereIdx >= 0 ? noTrailingSemi.slice(whereIdx) : '';
    const hasTimeBound = RECOGNIZED_TIME_COLUMNS.some((col) => {
      const boundRe = new RegExp(
        `\\b(?:[a-zA-Z_][a-zA-Z0-9_]*\\.)?${col}\\s*(?:>=|>|<=|<|=|BETWEEN\\b)`,
        'i'
      );
      return boundRe.test(whereClause);
    });
    if (!hasTimeBound) {
      violations.push({
        code: 'MISSING_TIME_BOUND_FILTER',
        message: 'Query must include a bounded time-range filter (e.g. pv_hour >= {start:DateTime} AND pv_hour < {end:DateTime})',
      });
    }
  }

  // Check GROUP BY on unindexed identity columns
  const groupByMatch = /\bGROUP\s+BY\s+([\s\S]+?)(?:\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|\bUNION\b|$)/i.exec(
    noTrailingSemi
  );
  if (groupByMatch) {
    const groupExprs = groupByMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^[a-zA-Z_][a-zA-Z0-9_]*\./, '').toLowerCase());
    const primaryTable = tables[0] ? TENANT_TABLE_CATALOG[tables[0]] : undefined;
    for (const expr of groupExprs) {
      if (IDENTITY_COLUMNS.has(expr)) {
        const indexed = primaryTable ? primaryTable.orderingKey.includes(expr) : false;
        if (!indexed) {
          violations.push({
            code: 'UNINDEXED_IDENTITY_GROUP_BY',
            message: `GROUP BY identity column "${expr}" is forbidden on table "${tables[0] ?? 'unknown'}" (not in ordering key; risks Code 241 OOM)`,
            snippet: expr,
          });
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    tables,
    typedBinds,
    violations,
  };
}
