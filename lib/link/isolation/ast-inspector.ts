/**
 * UGOKI LINK v2 — ClickHouse SQL Lexer & Recursive Scope AST Inspector (Isolation Layer A & Gate surf.G3)
 *
 * Enforces `store-final.md` M6/M7 and `surface-final.md` §8.3 (G3):
 *   - Character-by-character state-machine SQL tokenizer immune to even/odd backslash quote smuggling (C-10)
 *   - SELECT-only, single statement, zero comments, zero DDL/DML/role/settings/PREWHERE/UNION/FINAL/FORMAT overrides
 *   - No `SELECT *` or `alias.*`
 *   - Recursive scope inspection across CTEs, derived subqueries, and scalar/IN subqueries (C-11)
 *   - Full `FROM a, b` comma-join and `JOIN` extraction + forbidden ClickHouse table-function / `system.*` blocking (C-11)
 *   - Mandatory top-level `AND` conjunct `[alias.]tenant_id = {tenant_id:String}` with zero top-level `OR` bypass (C-11)
 *   - Synchronized table/view catalog derived directly from `CANONICAL_SCHEMA` + `PUBLIC_SQL_VIEWS` (C-14)
 */

import { CANONICAL_SCHEMA } from '@/packages/contract/schema';

export type SqlViolationCode =
  | 'EMPTY_SQL'
  | 'MULTI_STATEMENT'
  | 'NON_SELECT_STATEMENT'
  | 'FORBIDDEN_DDL_DML_OR_CONTROL'
  | 'FORBIDDEN_SETTINGS_OR_FILTER_OVERRIDE'
  | 'FORBIDDEN_SELECT_STAR'
  | 'MISSING_TENANT_BIND_PREDICATE'
  | 'MISSING_SITE_BIND_PREDICATE'
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

function inferTimeColumnsFromCanonical(
  cols: ReadonlyArray<{ readonly name: string; readonly clickhouseType?: string }>
): string[] {
  const out = new Set<string>();
  for (const c of cols) {
    const t = c.clickhouseType ?? '';
    if (
      /\b(Date|Date32|DateTime|DateTime64)\b/i.test(t) ||
      /(?:_hour|_day|_utc|_local|_at|_recv|_ts|date|timestamp|minute|week|month|period_start)$/i.test(c.name)
    ) {
      out.add(c.name);
    }
  }
  if (out.size === 0) {
    out.add('pv_hour');
  }
  return [...out];
}

function buildCanonicalTenantTableCatalog(): Record<string, TenantTableSchemaMeta> {
  const catalog: Record<string, TenantTableSchemaMeta> = {};

  for (const tbl of CANONICAL_SCHEMA.tables) {
    if (tbl.store !== 'clickhouse' || !tbl.tenantScoped) continue;
    const isAggregateOrDim =
      tbl.name.startsWith('rollup_') ||
      tbl.name.startsWith('dim_') ||
      tbl.deletionStrategy === 'not_applicable_aggregate' ||
      tbl.name === 'usage_day' ||
      tbl.name === 'access_bot_lt' ||
      tbl.name === 'stat_cell_lt';
    catalog[tbl.name] = {
      table: tbl.name,
      isRawBaseTable: !isAggregateOrDim,
      timeColumns: inferTimeColumnsFromCanonical(tbl.columns),
      orderingKey: [...tbl.orderBy],
    };
  }

  // Public SQL views emitted by `ddl-generator.ts` (`PUBLIC_SQL_VIEWS` in `sql-interface.ts`)
  const publicViews: ReadonlyArray<TenantTableSchemaMeta> = [
    {
      table: 'v_site_hourly',
      isRawBaseTable: false,
      timeColumns: ['pv_hour'],
      orderingKey: ['tenant_id', 'site_id', 'pv_hour'],
    },
    {
      table: 'v_page_hourly',
      isRawBaseTable: false,
      timeColumns: ['pv_hour', 'bucket_start'],
      orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'page_id'],
    },
    {
      table: 'v_conversion_daily',
      isRawBaseTable: false,
      timeColumns: ['day_local'],
      orderingKey: ['tenant_id', 'site_id', 'day_local'],
    },
    {
      table: 'v_loss_ledger_daily',
      isRawBaseTable: false,
      timeColumns: ['day_local'],
      orderingKey: ['tenant_id', 'site_id', 'day_local'],
    },
    {
      table: 'v_actor_daily',
      isRawBaseTable: false,
      timeColumns: ['day_local', 'month_utc'],
      orderingKey: ['tenant_id', 'site_id', 'day_local', 'verified_actor_id'],
    },
  ];
  for (const v of publicViews) {
    catalog[v.table] = v;
  }

  // Legacy / transitional aliases preserved for existing sanctioned queries
  const legacyAliases: ReadonlyArray<TenantTableSchemaMeta> = [
    {
      table: 'events',
      isRawBaseTable: true,
      timeColumns: ['timestamp', 'pv_hour', 'occurred_at'],
      orderingKey: ['tenant_id', 'site_id', 'timestamp'],
    },
    {
      table: 'lab_events',
      isRawBaseTable: true,
      timeColumns: ['pv_hour', 'occurred_at'],
      orderingKey: ['tenant_id', 'site_id', 'pv_hour', 'lab_run_id'],
    },
    {
      table: 'conversion_events',
      isRawBaseTable: true,
      timeColumns: ['occurred_at', 'day_local'],
      orderingKey: ['tenant_id', 'site_id', 'occurred_at'],
    },
    {
      table: 'fact_structure_asof',
      isRawBaseTable: false,
      timeColumns: ['observed_at', 'valid_from'],
      orderingKey: ['tenant_id', 'site_id', 'page_id', 'observed_at'],
    },
    {
      table: 'snapshot_registry',
      isRawBaseTable: false,
      timeColumns: ['created_at', 'observed_at'],
      orderingKey: ['tenant_id', 'site_id', 'snapshot_id'],
    },
    {
      table: 'visitor_identity_index',
      isRawBaseTable: false,
      timeColumns: ['day_local', 'last_seen_at'],
      orderingKey: ['tenant_id', 'site_id', 'visitor_id', 'day_local'],
    },
  ];
  for (const leg of legacyAliases) {
    if (!catalog[leg.table]) {
      catalog[leg.table] = leg;
    }
  }

  // Ensure access_obs also recognizes legacy minute/observed_at aliases alongside canonical day_edge
  if (catalog.access_obs) {
    catalog.access_obs = {
      ...catalog.access_obs,
      timeColumns: Array.from(
        new Set([...catalog.access_obs.timeColumns, 'minute', 'pv_hour', 'observed_at'])
      ),
    };
  }
  if (catalog.events_v2) {
    catalog.events_v2 = {
      ...catalog.events_v2,
      timeColumns: Array.from(new Set([...catalog.events_v2.timeColumns, 'timestamp', 'pv_hour'])),
    };
  }
  if (catalog.page_view_state) {
    catalog.page_view_state = {
      ...catalog.page_view_state,
      timeColumns: Array.from(new Set([...catalog.page_view_state.timeColumns, 'pv_hour', 'day_local'])),
    };
  }
  if (catalog.trajectories) {
    catalog.trajectories = {
      ...catalog.trajectories,
      timeColumns: Array.from(new Set([...catalog.trajectories.timeColumns, 'pv_hour', 'timestamp'])),
    };
  }
  if (catalog.decision_log) {
    catalog.decision_log = {
      ...catalog.decision_log,
      timeColumns: Array.from(
        new Set([...catalog.decision_log.timeColumns, 'decided_hour', 'occurred_at'])
      ),
    };
  }
  if (catalog.exposure_log) {
    catalog.exposure_log = {
      ...catalog.exposure_log,
      timeColumns: Array.from(
        new Set([...catalog.exposure_log.timeColumns, 'exposed_hour', 'occurred_at'])
      ),
    };
  }

  return catalog;
}

export const TENANT_TABLE_CATALOG: Readonly<Record<string, TenantTableSchemaMeta>> =
  buildCanonicalTenantTableCatalog();

export const RAW_BASE_TABLES: ReadonlySet<string> = new Set(
  Object.values(TENANT_TABLE_CATALOG)
    .filter((m) => m.isRawBaseTable)
    .map((m) => m.table)
);

const IDENTITY_COLUMNS: ReadonlySet<string> = new Set([
  'visitor_id',
  'visitor_key',
  'user_id',
  'external_id',
  'ga_client_id',
  'session_id',
  'session_key',
  'pv_id',
  'member_hmac',
  'ip_hash',
]);

const RECOGNIZED_TIME_COLUMNS: ReadonlySet<string> = new Set([
  'pv_hour',
  'timestamp',
  'day_local',
  'day_utc',
  'day_edge',
  'received_day',
  'month_utc',
  'period_start',
  'exp_week',
  'bucket_start',
  'window_start',
  'occurred_at',
  'decided_hour',
  'exposed_hour',
  'decision_ts',
  'exposure_ts',
  'cv_ts',
  'link_ts',
  'first_hour',
  'minute_recv',
  'minute',
  'observed_at',
  'snapshot_ts',
  'valid_from',
  'created_at',
  'last_seen_at',
  'date',
]);

const FORBIDDEN_DDL_DML_KEYWORDS: ReadonlySet<string> = new Set([
  'insert',
  'alter',
  'drop',
  'create',
  'truncate',
  'attach',
  'detach',
  'grant',
  'revoke',
  'system',
  'optimize',
  'rename',
  'exchange',
  'kill',
  'delete',
  'update',
  'use',
  'show',
  'describe',
  'explain',
  'watch',
  'union',
  'intersect',
  'except',
  'into',
  'final',
  'sample',
]);

const FORBIDDEN_SETTINGS_OVERRIDE_KEYWORDS: ReadonlySet<string> = new Set([
  'settings',
  'prewhere',
  'format',
]);

const FORBIDDEN_SCHEMAS: ReadonlySet<string> = new Set([
  'system',
  'information_schema',
  'pg_catalog',
]);

const FORBIDDEN_TABLE_OR_EXT_FUNCTIONS: ReadonlySet<string> = new Set([
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
  'cluster',
  'clusterallreplicas',
  'dictionaryget',
  'dictget',
  'currentuser',
  'getsetting',
  'sleep',
  'sleepeachrow',
  'numbers',
  'numbers_mt',
  'zeros',
  'zeros_mt',
  'generaterandom',
  'executable',
  'executablepool',
  'sqlite',
  'deltalake',
  'iceberg',
  'hudi',
]);

const SENSITIVE_FILTER_COLUMNS: ReadonlySet<string> = new Set([
  'tenant_id',
  'site_id',
  'page_id',
  'visitor_id',
  'visitor_key',
  'user_id',
  'external_id',
  'session_id',
  'session_key',
  'member_hmac',
  'job_id',
  'snapshot_id',
  'grant_id',
]);

export type SqlTokenKind = 'IDENT' | 'STRING' | 'NUMBER' | 'BIND' | 'OP' | 'PUNCT';

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly value: string;
  readonly lower: string;
  readonly quoted?: boolean;
  readonly bindName?: string;
  readonly bindType?: string;
}

export interface SqlLexResult {
  readonly tokens: ReadonlyArray<SqlToken>;
  readonly hasUnbalancedQuotes: boolean;
  readonly hasComments: boolean;
  readonly hasTemplateInterpolation: boolean;
  readonly hasMalformedBind: boolean;
}

/**
 * Character-by-character state-machine SQL lexer (C-10).
 * Forward-consumes `\x` escape pairs and doubled quotes (`''`, `""`, `` `` ``) inside
 * string/identifier literals so even-backslash sequences like `'\\'` NEVER desynchronize
 * quote tracking.
 */
export function tokenizeSql(sql: string): SqlLexResult {
  const tokens: SqlToken[] = [];
  let hasUnbalancedQuotes = false;
  let hasComments = false;
  let hasTemplateInterpolation = false;
  let hasMalformedBind = false;

  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
      i += 1;
      continue;
    }

    // Line comment `--`
    if (ch === '-' && sql[i + 1] === '-') {
      hasComments = true;
      i += 2;
      while (i < n && sql[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    // Block comment `/* ... */` or stray `*/`
    if (ch === '/' && sql[i + 1] === '*') {
      hasComments = true;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      if (i < n) {
        i += 2;
      } else {
        hasUnbalancedQuotes = true;
      }
      continue;
    }
    if (ch === '*' && sql[i + 1] === '/') {
      hasComments = true;
      i += 2;
      continue;
    }

    // JS template literal interpolation `${...}`
    if (ch === '$' && sql[i + 1] === '{') {
      hasTemplateInterpolation = true;
      i += 2;
      while (i < n && sql[i] !== '}') {
        i += 1;
      }
      if (i < n) i += 1;
      continue;
    }

    // Single-quoted string literal `'...'`
    if (ch === "'") {
      let raw = "'";
      i += 1;
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (c === '\\') {
          if (i + 1 >= n) {
            break;
          }
          raw += c + sql[i + 1]!;
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            raw += "''";
            i += 2;
            continue;
          }
          raw += "'";
          i += 1;
          closed = true;
          break;
        }
        raw += c;
        i += 1;
      }
      if (!closed) {
        hasUnbalancedQuotes = true;
      }
      tokens.push({ kind: 'STRING', value: raw, lower: raw.toLowerCase() });
      continue;
    }

    // Double-quoted or backtick-quoted identifier
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let inner = '';
      i += 1;
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (c === '\\') {
          if (i + 1 >= n) {
            break;
          }
          inner += sql[i + 1]!;
          i += 2;
          continue;
        }
        if (c === quote) {
          if (sql[i + 1] === quote) {
            inner += quote;
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        inner += c;
        i += 1;
      }
      if (!closed) {
        hasUnbalancedQuotes = true;
      }
      tokens.push({
        kind: 'IDENT',
        value: inner,
        lower: inner.toLowerCase(),
        quoted: true,
      });
      continue;
    }

    // ClickHouse typed parameter bind `{name:Type}`
    if (ch === '{') {
      const closeIdx = sql.indexOf('}', i + 1);
      if (closeIdx < 0) {
        hasMalformedBind = true;
        i = n;
        continue;
      }
      const content = sql.slice(i + 1, closeIdx);
      const bindMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z0-9_() ,]+?)\s*$/.exec(content);
      if (!bindMatch) {
        hasMalformedBind = true;
      } else {
        tokens.push({
          kind: 'BIND',
          value: sql.slice(i, closeIdx + 1),
          lower: sql.slice(i, closeIdx + 1).toLowerCase(),
          bindName: bindMatch[1]!,
          bindType: bindMatch[2]!.trim(),
        });
      }
      i = closeIdx + 1;
      continue;
    }

    // Numbers
    if (ch >= '0' && ch <= '9') {
      let num = ch;
      i += 1;
      while (i < n && /[0-9a-fA-FxX._]/.test(sql[i]!)) {
        num += sql[i]!;
        i += 1;
      }
      tokens.push({ kind: 'NUMBER', value: num, lower: num.toLowerCase() });
      continue;
    }

    // Identifiers & keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = ch;
      i += 1;
      while (i < n && /[a-zA-Z0-9_]/.test(sql[i]!)) {
        ident += sql[i]!;
        i += 1;
      }
      tokens.push({ kind: 'IDENT', value: ident, lower: ident.toLowerCase(), quoted: false });
      continue;
    }

    // Two-character operators
    const two = sql.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '!=' || two === '<>' || two === '==' || two === '||') {
      tokens.push({ kind: 'OP', value: two, lower: two });
      i += 2;
      continue;
    }

    // Punctuation
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.') {
      tokens.push({ kind: 'PUNCT', value: ch, lower: ch });
      i += 1;
      continue;
    }

    // Single-character operators (including `*`, `=`, `<`, `>`, `+`, `-`, `/`, `%`)
    tokens.push({ kind: 'OP', value: ch, lower: ch });
    i += 1;
  }

  return {
    tokens,
    hasUnbalancedQuotes,
    hasComments,
    hasTemplateInterpolation,
    hasMalformedBind,
  };
}

const SQL_CLAUSE_NON_FUNCTIONS: ReadonlySet<string> = new Set([
  'select',
  'from',
  'where',
  'in',
  'not',
  'and',
  'or',
  'as',
  'on',
  'using',
  'having',
  'exists',
  'case',
  'when',
  'over',
  'partition',
  'values',
  'tuple',
  'with',
]);

/**
 * Extracts all SQL function calls from the tokenized stream (ignoring string literals and comments).
 */
export function extractSqlFunctionCalls(sql: string): string[] {
  const lex = tokenizeSql(sql);
  const found = new Set<string>();
  for (let i = 0; i < lex.tokens.length - 1; i += 1) {
    const tok = lex.tokens[i]!;
    const next = lex.tokens[i + 1]!;
    if (tok.kind === 'IDENT' && next.kind === 'PUNCT' && next.value === '(') {
      if (!SQL_CLAUSE_NON_FUNCTIONS.has(tok.lower)) {
        found.add(tok.lower);
      }
    }
  }
  return Array.from(found).sort();
}

export interface InspectSqlOptions {
  /** Set true ONLY for non-tenant system/health checks; defaults to true (strict tenant mode). */
  readonly requireTenantFilter?: boolean;
  /** Set true when credential is restricted to specific site IDs (`allowedSiteIds` non-null, non-wildcard). */
  readonly requireSiteFilter?: boolean;
  /** Set true to enforce bounded time-range filter (default true). */
  readonly requireTimeBound?: boolean;
}

const CLAUSE_BOUNDARY_KEYWORDS: ReadonlySet<string> = new Set([
  'where',
  'prewhere',
  'group',
  'having',
  'order',
  'limit',
  'offset',
  'settings',
  'format',
  'window',
  'qualify',
  'union',
  'intersect',
  'except',
]);

const JOIN_MODIFIER_KEYWORDS: ReadonlySet<string> = new Set([
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'cross',
  'any',
  'all',
  'asof',
  'global',
  'semi',
  'anti',
]);

interface SelectScope {
  readonly selectIndex: number;
  readonly endIndex: number;
  readonly baseDepth: number;
  readonly ownTokens: ReadonlyArray<{ readonly token: SqlToken; readonly depth: number; readonly index: number }>;
}

function extractSelectScopes(tokens: ReadonlyArray<SqlToken>): SelectScope[] {
  const depths: number[] = [];
  let d = 0;
  for (const tok of tokens) {
    if (tok.kind === 'PUNCT' && tok.value === '(') {
      depths.push(d);
      d += 1;
    } else if (tok.kind === 'PUNCT' && tok.value === ')') {
      d = Math.max(0, d - 1);
      depths.push(d);
    } else {
      depths.push(d);
    }
  }

  const scopes: SelectScope[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'IDENT' || tok.quoted || tok.lower !== 'select') continue;

    const baseDepth = depths[i]!;
    let endIdx = tokens.length;
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (depths[j]! < baseDepth) {
        // Reached the closing `)` of the enclosing subquery
        endIdx = j;
        break;
      }
      if (
        depths[j]! === baseDepth &&
        tokens[j]!.kind === 'IDENT' &&
        !tokens[j]!.quoted &&
        (tokens[j]!.lower === 'union' ||
          tokens[j]!.lower === 'intersect' ||
          tokens[j]!.lower === 'except')
      ) {
        endIdx = j;
        break;
      }
    }

    // Collect tokens belonging to THIS SELECT scope (skipping nested `(SELECT ...)` subtrees)
    const ownTokens: Array<{ token: SqlToken; depth: number; index: number }> = [];
    let j = i;
    while (j < endIdx) {
      if (
        j > i &&
        tokens[j]!.kind === 'PUNCT' &&
        tokens[j]!.value === '(' &&
        tokens[j + 1]?.kind === 'IDENT' &&
        !tokens[j + 1]?.quoted &&
        (tokens[j + 1]?.lower === 'select' || tokens[j + 1]?.lower === 'with')
      ) {
        // Skip entire nested subquery `(...)` so its tokens are inspected in its own SelectScope
        const subOpenDepth = depths[j]!;
        j += 1;
        while (j < endIdx && depths[j]! > subOpenDepth) {
          j += 1;
        }
        if (j < endIdx && tokens[j]!.kind === 'PUNCT' && tokens[j]!.value === ')') {
          j += 1;
        }
        continue;
      }
      ownTokens.push({ token: tokens[j]!, depth: depths[j]!, index: j });
      j += 1;
    }

    scopes.push({
      selectIndex: i,
      endIndex: endIdx,
      baseDepth,
      ownTokens,
    });
  }

  return scopes;
}

function extractCteNames(tokens: ReadonlyArray<SqlToken>): Set<string> {
  const ctes = new Set<string>();
  let d = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'PUNCT' && tok.value === '(') {
      d += 1;
      continue;
    }
    if (tok.kind === 'PUNCT' && tok.value === ')') {
      d = Math.max(0, d - 1);
      continue;
    }
    if (tok.kind === 'IDENT' && !tok.quoted && tok.lower === 'with') {
      const withDepth = d;
      let j = i + 1;
      let innerDepth = withDepth;
      while (j < tokens.length) {
        const t = tokens[j]!;
        if (t.kind === 'PUNCT' && t.value === '(') {
          innerDepth += 1;
          j += 1;
          continue;
        }
        if (t.kind === 'PUNCT' && t.value === ')') {
          innerDepth = Math.max(0, innerDepth - 1);
          j += 1;
          continue;
        }
        if (innerDepth === withDepth && t.kind === 'IDENT' && !t.quoted && t.lower === 'select') {
          break;
        }
        if (
          innerDepth === withDepth &&
          t.kind === 'IDENT' &&
          tokens[j + 1]?.kind === 'IDENT' &&
          !tokens[j + 1]?.quoted &&
          tokens[j + 1]?.lower === 'as' &&
          tokens[j + 2]?.kind === 'PUNCT' &&
          tokens[j + 2]?.value === '('
        ) {
          ctes.add(t.lower);
        }
        j += 1;
      }
    }
  }
  return ctes;
}

function isExactTenantBindConjunct(conjunct: ReadonlyArray<SqlToken>): boolean {
  let slice = conjunct;
  // Unwrap pure outer parens ONLY if balanced across the entire conjunct and containing no OR/NOT
  while (
    slice.length >= 2 &&
    slice[0]!.kind === 'PUNCT' &&
    slice[0]!.value === '(' &&
    slice[slice.length - 1]!.kind === 'PUNCT' &&
    slice[slice.length - 1]!.value === ')'
  ) {
    let depth = 0;
    let wrapsEntire = true;
    for (let i = 0; i < slice.length - 1; i += 1) {
      if (slice[i]!.kind === 'PUNCT' && slice[i]!.value === '(') depth += 1;
      else if (slice[i]!.kind === 'PUNCT' && slice[i]!.value === ')') depth -= 1;
      if (depth === 0) {
        wrapsEntire = false;
        break;
      }
    }
    if (!wrapsEntire) break;
    slice = slice.slice(1, -1);
  }

  // Case 1: `tenant_id = {tenant_id:String}`
  if (
    slice.length === 3 &&
    slice[0]!.kind === 'IDENT' &&
    slice[0]!.lower === 'tenant_id' &&
    slice[1]!.kind === 'OP' &&
    slice[1]!.value === '=' &&
    slice[2]!.kind === 'BIND' &&
    slice[2]!.bindName === 'tenant_id' &&
    slice[2]!.bindType === 'String'
  ) {
    return true;
  }

  // Case 2: `alias.tenant_id = {tenant_id:String}`
  if (
    slice.length === 5 &&
    slice[0]!.kind === 'IDENT' &&
    slice[1]!.kind === 'PUNCT' &&
    slice[1]!.value === '.' &&
    slice[2]!.kind === 'IDENT' &&
    slice[2]!.lower === 'tenant_id' &&
    slice[3]!.kind === 'OP' &&
    slice[3]!.value === '=' &&
    slice[4]!.kind === 'BIND' &&
    slice[4]!.bindName === 'tenant_id' &&
    slice[4]!.bindType === 'String'
  ) {
    return true;
  }

  return false;
}

function unwrapOuterParens(conjunct: ReadonlyArray<SqlToken>): ReadonlyArray<SqlToken> {
  let slice = conjunct;
  while (
    slice.length >= 2 &&
    slice[0]!.kind === 'PUNCT' &&
    slice[0]!.value === '(' &&
    slice[slice.length - 1]!.kind === 'PUNCT' &&
    slice[slice.length - 1]!.value === ')'
  ) {
    let depth = 0;
    let wrapsEntire = true;
    for (let i = 0; i < slice.length - 1; i += 1) {
      if (slice[i]!.kind === 'PUNCT' && slice[i]!.value === '(') depth += 1;
      else if (slice[i]!.kind === 'PUNCT' && slice[i]!.value === ')') depth -= 1;
      if (depth === 0) {
        wrapsEntire = false;
        break;
      }
    }
    if (!wrapsEntire) break;
    slice = slice.slice(1, -1);
  }
  return slice;
}

function isExactSiteBindConjunct(conjunct: ReadonlyArray<SqlToken>): boolean {
  const slice = unwrapOuterParens(conjunct);

  // Strip optional `alias.` prefix
  let offset = 0;
  if (
    slice.length >= 3 &&
    slice[0]!.kind === 'IDENT' &&
    slice[1]!.kind === 'PUNCT' &&
    slice[1]!.value === '.'
  ) {
    offset = 2;
  }

  const rem = slice.slice(offset);
  if (rem.length < 3 || rem[0]!.kind !== 'IDENT' || rem[0]!.lower !== 'site_id') {
    return false;
  }

  // Case 1: `[alias.]site_id = {site_id:String}`
  if (
    rem.length === 3 &&
    rem[1]!.kind === 'OP' &&
    rem[1]!.value === '=' &&
    rem[2]!.kind === 'BIND' &&
    rem[2]!.bindName === 'site_id' &&
    rem[2]!.bindType === 'String'
  ) {
    return true;
  }

  // Case 2a: `[alias.]site_id IN ({allowed_site_ids:Array(String)})`
  if (
    rem.length === 5 &&
    rem[1]!.kind === 'IDENT' &&
    !rem[1]!.quoted &&
    rem[1]!.lower === 'in' &&
    rem[2]!.kind === 'PUNCT' &&
    rem[2]!.value === '(' &&
    rem[3]!.kind === 'BIND' &&
    rem[3]!.bindName === 'allowed_site_ids' &&
    rem[3]!.bindType?.replace(/\s+/g, '') === 'Array(String)' &&
    rem[4]!.kind === 'PUNCT' &&
    rem[4]!.value === ')'
  ) {
    return true;
  }

  // Case 2b: `[alias.]site_id IN {allowed_site_ids:Array(String)}`
  if (
    rem.length === 3 &&
    rem[1]!.kind === 'IDENT' &&
    !rem[1]!.quoted &&
    rem[1]!.lower === 'in' &&
    rem[2]!.kind === 'BIND' &&
    rem[2]!.bindName === 'allowed_site_ids' &&
    rem[2]!.bindType?.replace(/\s+/g, '') === 'Array(String)'
  ) {
    return true;
  }

  return false;
}

function hasTimeComparisonInConjunct(conjunct: ReadonlyArray<SqlToken>): boolean {
  for (let i = 0; i < conjunct.length; i += 1) {
    const tok = conjunct[i]!;
    if (tok.kind === 'IDENT' && RECOGNIZED_TIME_COLUMNS.has(tok.lower)) {
      const next = conjunct[i + 1];
      if (!next) continue;
      if (
        next.kind === 'OP' &&
        (next.value === '>=' ||
          next.value === '>' ||
          next.value === '<=' ||
          next.value === '<' ||
          next.value === '=')
      ) {
        return true;
      }
      if (next.kind === 'IDENT' && !next.quoted && next.lower === 'between') {
        return true;
      }
    }
  }
  return false;
}

export function inspectSqlAst(sql: string, options: InspectSqlOptions = {}): SqlInspectionResult {
  const requireTenantFilter = options.requireTenantFilter ?? true;
  const requireSiteFilter = options.requireSiteFilter ?? false;
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

  if (trimmed.includes('\0')) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'NUL byte detected in SQL text',
    });
  }

  const lex = tokenizeSql(trimmed);

  if (lex.hasComments) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'SQL comments (-- or /* */) are forbidden in sanctioned queries',
    });
  }
  if (lex.hasUnbalancedQuotes) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'Unbalanced quotes detected in SQL text',
    });
  }
  if (lex.hasTemplateInterpolation) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'Detected JS template string interpolation (${...}) in SQL text',
    });
  }
  if (lex.hasMalformedBind) {
    violations.push({
      code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
      message: 'Malformed ClickHouse parameter bind syntax {...} detected',
    });
  }

  // Strip a single harmless trailing semicolon token
  const tokens =
    lex.tokens.length > 0 &&
    lex.tokens[lex.tokens.length - 1]!.kind === 'PUNCT' &&
    lex.tokens[lex.tokens.length - 1]!.value === ';'
      ? lex.tokens.slice(0, -1)
      : lex.tokens;

  if (tokens.length === 0) {
    violations.push({ code: 'EMPTY_SQL', message: 'SQL query must contain a statement' });
    return { valid: false, tables: [], typedBinds: [], violations };
  }

  // Reject any remaining `;` anywhere outside string literals
  if (tokens.some((t) => t.kind === 'PUNCT' && t.value === ';')) {
    violations.push({
      code: 'MULTI_STATEMENT',
      message: 'Multiple SQL statements separated by ";" are forbidden',
    });
  }

  // Must start with SELECT or WITH
  const first = tokens[0]!;
  if (first.kind !== 'IDENT' || first.quoted || (first.lower !== 'select' && first.lower !== 'with')) {
    violations.push({
      code: 'NON_SELECT_STATEMENT',
      message: 'Only read-only SELECT / WITH ... SELECT statements are permitted',
    });
  }

  // Extract typed ClickHouse binds `{name:Type}` from real BIND tokens ONLY (never from strings!)
  const typedBinds: Array<{ name: string; type: string }> = [];
  for (const tok of tokens) {
    if (tok.kind === 'BIND' && tok.bindName && tok.bindType) {
      typedBinds.push({ name: tok.bindName, type: tok.bindType });
    }
  }

  // Token-level global forbidden keyword / schema / function / inline literal checks
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;

    if (tok.kind === 'IDENT' && !tok.quoted) {
      // Forbidden DDL/DML/UNION/INTO/FINAL/SAMPLE keywords
      if (FORBIDDEN_DDL_DML_KEYWORDS.has(tok.lower)) {
        violations.push({
          code: 'FORBIDDEN_DDL_DML_OR_CONTROL',
          message: `Forbidden SQL keyword "${tok.value.toUpperCase()}" detected`,
          snippet: tok.value,
        });
      }

      // SETTINGS / PREWHERE / FORMAT / additional_table_filters / SET ROLE / ROW POLICY
      if (
        FORBIDDEN_SETTINGS_OVERRIDE_KEYWORDS.has(tok.lower) ||
        tok.lower === 'additional_table_filters' ||
        (tok.lower === 'set' &&
          tokens[i + 1]?.kind === 'IDENT' &&
          (tokens[i + 1]?.lower === 'role' || tokens[i + 1]?.lower === 'default')) ||
        (tok.lower === 'row' && tokens[i + 1]?.kind === 'IDENT' && tokens[i + 1]?.lower === 'policy')
      ) {
        violations.push({
          code: 'FORBIDDEN_SETTINGS_OR_FILTER_OVERRIDE',
          message: `Forbidden clause or filter override "${tok.value}" detected in query SQL`,
          snippet: tok.value,
        });
      }
    }

    // Forbidden schema references (`system.*`, `information_schema.*`, `pg_catalog.*`)
    if (
      tok.kind === 'IDENT' &&
      FORBIDDEN_SCHEMAS.has(tok.lower) &&
      tokens[i + 1]?.kind === 'PUNCT' &&
      tokens[i + 1]?.value === '.'
    ) {
      violations.push({
        code: 'FORBIDDEN_DDL_DML_OR_CONTROL',
        message: `Access to internal schema "${tok.lower}.*" is strictly forbidden`,
        snippet: tok.lower,
      });
    }

    // Forbidden external / table functions (`url(...)`, `remote(...)`, `s3(...)`, `file(...)`, etc.)
    if (
      tok.kind === 'IDENT' &&
      FORBIDDEN_TABLE_OR_EXT_FUNCTIONS.has(tok.lower) &&
      tokens[i + 1]?.kind === 'PUNCT' &&
      tokens[i + 1]?.value === '('
    ) {
      violations.push({
        code: 'FORBIDDEN_DDL_DML_OR_CONTROL',
        message: `Forbidden external or table function "${tok.value}()" detected`,
        snippet: tok.value,
      });
    }

    // Sensitive filter columns compared against inline string literals
    if (tok.kind === 'IDENT' && SENSITIVE_FILTER_COLUMNS.has(tok.lower)) {
      const op = tokens[i + 1];
      const rhs = tokens[i + 2];
      if (
        op?.kind === 'OP' &&
        (op.value === '=' || op.value === '!=' || op.value === '<>' || op.value === '==') &&
        rhs?.kind === 'STRING'
      ) {
        violations.push({
          code: 'INLINE_TENANT_OR_ID_LITERAL',
          message: `Column "${tok.lower}" must use a typed ClickHouse parameter bind ({${tok.lower}:String}), never an inline quoted literal`,
          snippet: tok.lower,
        });
      }
      if (
        op?.kind === 'IDENT' &&
        !op.quoted &&
        op.lower === 'in' &&
        rhs?.kind === 'PUNCT' &&
        rhs.value === '(' &&
        tokens[i + 3]?.kind === 'STRING'
      ) {
        violations.push({
          code: 'INLINE_TENANT_OR_ID_LITERAL',
          message: `Column "${tok.lower}" IN (...) must use a typed ClickHouse parameter bind, never inline string literals`,
          snippet: tok.lower,
        });
      }
    }

    // Boolean tautologies (`OR 1=1`, `OR '1'='1'`, `OR 2=2`, `OR TRUE`) anywhere
    if (tok.kind === 'IDENT' && !tok.quoted && tok.lower === 'or') {
      const a = tokens[i + 1];
      const op = tokens[i + 2];
      const b = tokens[i + 3];
      if (a?.kind === 'IDENT' && !a.quoted && a.lower === 'true') {
        violations.push({
          code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
          message: 'Detected boolean tautology predicate (OR TRUE)',
        });
      } else if (
        a &&
        b &&
        op?.kind === 'OP' &&
        (op.value === '=' || op.value === '==') &&
        (a.kind === 'NUMBER' || a.kind === 'STRING') &&
        a.kind === b.kind &&
        a.value === b.value
      ) {
        violations.push({
          code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
          message: `Detected boolean tautology predicate (OR ${a.value}=${b.value})`,
        });
      }
    }
  }

  const cteNames = extractCteNames(tokens);
  const scopes = extractSelectScopes(tokens);
  if (scopes.length === 0) {
    violations.push({
      code: 'NON_SELECT_STATEMENT',
      message: 'Query must contain at least one SELECT clause',
    });
    return { valid: false, tables: [], typedBinds, violations };
  }

  const allTables: string[] = [];

  for (const scope of scopes) {
    const d = scope.baseDepth;
    const own = scope.ownTokens;

    // 1. Locate top-level clause positions within this SELECT scope
    let fromIdx = -1;
    let whereIdx = -1;
    let postWhereIdx = own.length;
    let groupByIdx = -1;
    let postGroupByIdx = own.length;

    for (let k = 1; k < own.length; k += 1) {
      const entry = own[k]!;
      if (entry.depth !== d) continue;
      if (entry.token.kind !== 'IDENT' || entry.token.quoted) continue;
      const kw = entry.token.lower;
      if (kw === 'from' && fromIdx < 0) {
        fromIdx = k;
      } else if (kw === 'where' && whereIdx < 0) {
        whereIdx = k;
      } else if (
        whereIdx >= 0 &&
        postWhereIdx === own.length &&
        (kw === 'group' ||
          kw === 'having' ||
          kw === 'order' ||
          kw === 'limit' ||
          kw === 'offset' ||
          kw === 'settings' ||
          kw === 'format' ||
          kw === 'window' ||
          kw === 'qualify')
      ) {
        postWhereIdx = k;
      }

      if (
        kw === 'group' &&
        own[k + 1]?.depth === d &&
        own[k + 1]?.token.kind === 'IDENT' &&
        own[k + 1]?.token.lower === 'by' &&
        groupByIdx < 0
      ) {
        groupByIdx = k + 2;
      } else if (
        groupByIdx >= 0 &&
        postGroupByIdx === own.length &&
        (kw === 'having' || kw === 'order' || kw === 'limit' || kw === 'offset' || kw === 'window')
      ) {
        postGroupByIdx = k;
      }
    }

    // 2. Check SELECT projection list for `*` or `alias.*` (allowing `COUNT(*)`)
    const projEnd = fromIdx >= 0 ? fromIdx : whereIdx >= 0 ? whereIdx : own.length;
    for (let k = 1; k < projEnd; k += 1) {
      const entry = own[k]!;
      if (entry.token.kind === 'OP' && entry.token.value === '*') {
        // Check if this `*` is `COUNT(*)`
        const prev1 = own[k - 1];
        const prev2 = own[k - 2];
        const next1 = own[k + 1];
        const isCountStar =
          prev1?.token.kind === 'PUNCT' &&
          prev1.token.value === '(' &&
          prev2?.token.kind === 'IDENT' &&
          prev2.token.lower === 'count' &&
          next1?.token.kind === 'PUNCT' &&
          next1.token.value === ')';
        // Check if `*` is a multiplication operator `expr * expr` (preceded by IDENT/NUMBER/BIND/`)`)
        const isMultiply =
          prev1 &&
          (prev1.token.kind === 'NUMBER' ||
            prev1.token.kind === 'BIND' ||
            (prev1.token.kind === 'PUNCT' && prev1.token.value === ')') ||
            (prev1.token.kind === 'IDENT' &&
              prev1.token.lower !== 'select' &&
              prev1.token.lower !== 'distinct')) &&
          !(prev1.token.kind === 'PUNCT' && prev1.token.value === '.');

        if (!isCountStar && !isMultiply) {
          violations.push({
            code: 'FORBIDDEN_SELECT_STAR',
            message: 'SELECT * and alias.* are forbidden; enumerate projected columns explicitly',
          });
          break;
        }
      }
    }

    // 3. Extract FROM tables (including comma-joins `FROM a, b`) and JOIN right-hand tables
    const scopeRealTables: string[] = [];
    const recordTableRef = (
      startPos: number,
      isRightJoinOrCommaJoin: boolean
    ): number => {
      const t0 = own[startPos];
      if (!t0 || t0.depth !== d) return startPos + 1;

      // Subquery `FROM (SELECT ...)` — inner SelectScope handles its own tables
      if (t0.token.kind === 'PUNCT' && t0.token.value === '(') {
        let p = startPos + 1;
        while (p < own.length && own[p]!.depth > d) p += 1;
        if (p < own.length && own[p]!.token.kind === 'PUNCT' && own[p]!.token.value === ')') {
          p += 1;
        }
        return p;
      }

      if (t0.token.kind !== 'IDENT') {
        return startPos + 1;
      }

      let schemaName: string | null = null;
      let tableName = t0.token.lower;
      let nextPos = startPos + 1;

      if (
        own[nextPos]?.depth === d &&
        own[nextPos]?.token.kind === 'PUNCT' &&
        own[nextPos]?.token.value === '.' &&
        own[nextPos + 1]?.depth === d &&
        own[nextPos + 1]?.token.kind === 'IDENT'
      ) {
        schemaName = tableName;
        tableName = own[nextPos + 1]!.token.lower;
        nextPos += 2;
      }

      // Reject any table-valued function in FROM / JOIN (`FROM url(...)`, `FROM numbers(10)`, etc.)
      if (
        own[nextPos]?.depth === d &&
        own[nextPos]?.token.kind === 'PUNCT' &&
        own[nextPos]?.token.value === '('
      ) {
        violations.push({
          code: 'FORBIDDEN_DDL_DML_OR_CONTROL',
          message: `Table function "${tableName}()" is forbidden in FROM/JOIN clauses`,
          snippet: tableName,
        });
        while (nextPos < own.length && own[nextPos]!.depth > d) nextPos += 1;
        return nextPos + 1;
      }

      if (schemaName && FORBIDDEN_SCHEMAS.has(schemaName)) {
        violations.push({
          code: 'FORBIDDEN_DDL_DML_OR_CONTROL',
          message: `Access to internal schema "${schemaName}.${tableName}" is strictly forbidden`,
          snippet: `${schemaName}.${tableName}`,
        });
      }

      if (!cteNames.has(tableName)) {
        if (!allTables.includes(tableName)) {
          allTables.push(tableName);
        }
        if (!scopeRealTables.includes(tableName)) {
          scopeRealTables.push(tableName);
        }
        if (isRightJoinOrCommaJoin && RAW_BASE_TABLES.has(tableName)) {
          violations.push({
            code: 'BASE_TABLE_ON_JOIN_RIGHT',
            message: `Raw base table "${tableName}" is forbidden on the RIGHT side of a JOIN or comma-join (causes ClickHouse hash-table OOM)`,
            snippet: tableName,
          });
        }
      }

      // Skip optional `[AS] alias`
      if (
        own[nextPos]?.depth === d &&
        own[nextPos]?.token.kind === 'IDENT' &&
        !own[nextPos]?.token.quoted &&
        own[nextPos]?.token.lower === 'as'
      ) {
        nextPos += 2;
      } else if (
        own[nextPos]?.depth === d &&
        own[nextPos]?.token.kind === 'IDENT' &&
        !CLAUSE_BOUNDARY_KEYWORDS.has(own[nextPos]!.token.lower) &&
        !JOIN_MODIFIER_KEYWORDS.has(own[nextPos]!.token.lower) &&
        own[nextPos]!.token.lower !== 'join' &&
        own[nextPos]!.token.lower !== 'on' &&
        own[nextPos]!.token.lower !== 'using'
      ) {
        nextPos += 1;
      }

      return nextPos;
    };

    if (fromIdx >= 0) {
      const fromSectionEnd = whereIdx >= 0 ? whereIdx : postWhereIdx;
      let pos = recordTableRef(fromIdx + 1, false);

      while (pos < fromSectionEnd) {
        const cur = own[pos]!;
        if (cur.depth !== d) {
          pos += 1;
          continue;
        }
        if (
          cur.token.kind === 'IDENT' &&
          !cur.token.quoted &&
          CLAUSE_BOUNDARY_KEYWORDS.has(cur.token.lower)
        ) {
          break;
        }
        // Comma-join `FROM t1, t2`
        if (cur.token.kind === 'PUNCT' && cur.token.value === ',') {
          pos = recordTableRef(pos + 1, true);
          continue;
        }
        // Explicit `JOIN t2`
        if (cur.token.kind === 'IDENT' && !cur.token.quoted && cur.token.lower === 'join') {
          pos = recordTableRef(pos + 1, true);
          continue;
        }
        pos += 1;
      }
    }

    // 4. Enforce tenant_id bind, optional site_id bind, & time-range bound per SELECT scope referencing real tables
    const scopeRequiresChecks = scopeRealTables.length > 0 || (scopes.length === 1 && fromIdx < 0);

    if (scopeRequiresChecks && (requireTenantFilter || requireSiteFilter || requireTimeBound)) {
      if (whereIdx < 0) {
        if (requireTenantFilter) {
          violations.push({
            code: 'MISSING_TENANT_BIND_PREDICATE',
            message: 'Every tenant SELECT scope MUST include a WHERE clause with `tenant_id = {tenant_id:String}`',
          });
        }
        if (requireSiteFilter && scopeRealTables.length > 0) {
          violations.push({
            code: 'MISSING_SITE_BIND_PREDICATE',
            message:
              'Site-scoped credentials MUST include a WHERE clause with `site_id = {site_id:String}` or `site_id IN ({allowed_site_ids:Array(String)})` in every tenant SELECT scope',
          });
        }
        if (requireTimeBound && scopeRealTables.length > 0) {
          violations.push({
            code: 'MISSING_TIME_BOUND_FILTER',
            message: 'Query must include a bounded time-range filter in its WHERE clause',
          });
        }
      } else {
        const whereSlice = own.slice(whereIdx + 1, postWhereIdx);

        // Split WHERE clause by top-level `AND`, rejecting any top-level `OR` / `XOR`
        let hasTopLevelOr = false;
        const conjuncts: SqlToken[][] = [];
        let currentConjunct: SqlToken[] = [];

        for (const entry of whereSlice) {
          if (
            entry.depth === d &&
            entry.token.kind === 'IDENT' &&
            !entry.token.quoted &&
            (entry.token.lower === 'or' || entry.token.lower === 'xor')
          ) {
            hasTopLevelOr = true;
          }
          if (
            entry.depth === d &&
            entry.token.kind === 'IDENT' &&
            !entry.token.quoted &&
            entry.token.lower === 'and'
          ) {
            if (currentConjunct.length > 0) {
              conjuncts.push(currentConjunct);
              currentConjunct = [];
            }
          } else {
            currentConjunct.push(entry.token);
          }
        }
        if (currentConjunct.length > 0) {
          conjuncts.push(currentConjunct);
        }

        if (hasTopLevelOr) {
          violations.push({
            code: 'SUSPECT_SQL_INJECTION_PAYLOAD',
            message:
              'Top-level OR in WHERE clause is forbidden because it can short-circuit `tenant_id = {tenant_id:String}`; parenthesize non-tenant disjunctions inside `AND (...)`',
          });
          if (requireTenantFilter) {
            violations.push({
              code: 'MISSING_TENANT_BIND_PREDICATE',
              message:
                'Top-level `tenant_id = {tenant_id:String}` conjunction is invalidated by top-level OR',
            });
          }
          if (requireSiteFilter && scopeRealTables.length > 0) {
            violations.push({
              code: 'MISSING_SITE_BIND_PREDICATE',
              message:
                'Top-level `site_id` conjunction is invalidated by top-level OR',
            });
          }
        } else {
          if (requireTenantFilter) {
            const hasValidTenantConjunct = conjuncts.some((c) => isExactTenantBindConjunct(c));
            if (!hasValidTenantConjunct) {
              violations.push({
                code: 'MISSING_TENANT_BIND_PREDICATE',
                message:
                  'Every tenant SELECT scope MUST include a top-level `tenant_id = {tenant_id:String}` conjunct in its WHERE clause',
              });
            }
          }
          if (requireSiteFilter && scopeRealTables.length > 0) {
            const hasValidSiteConjunct = conjuncts.some((c) => isExactSiteBindConjunct(c));
            if (!hasValidSiteConjunct) {
              violations.push({
                code: 'MISSING_SITE_BIND_PREDICATE',
                message:
                  'Site-scoped credentials MUST include a top-level `site_id = {site_id:String}` or `site_id IN ({allowed_site_ids:Array(String)})` conjunct in every tenant SELECT scope',
              });
            }
          }
        }

        if (requireTimeBound && scopeRealTables.length > 0) {
          const hasTime =
            !hasTopLevelOr && conjuncts.some((c) => hasTimeComparisonInConjunct(c));
          if (!hasTime) {
            violations.push({
              code: 'MISSING_TIME_BOUND_FILTER',
              message:
                'Query must include a bounded time-range filter (e.g. pv_hour >= {start:DateTime} AND pv_hour < {end:DateTime})',
            });
          }
        }
      }
    }

    // 5. Check GROUP BY on unindexed identity columns within this scope
    if (groupByIdx >= 0) {
      const groupSlice = own.slice(groupByIdx, postGroupByIdx);
      const primaryTable = scopeRealTables[0]
        ? TENANT_TABLE_CATALOG[scopeRealTables[0]]
        : undefined;
      for (let g = 0; g < groupSlice.length; g += 1) {
        const tok = groupSlice[g]!.token;
        if (tok.kind === 'IDENT' && IDENTITY_COLUMNS.has(tok.lower)) {
          // Ensure it's not a table alias before `.`
          if (groupSlice[g + 1]?.token.kind === 'PUNCT' && groupSlice[g + 1]?.token.value === '.') {
            continue;
          }
          const indexed = primaryTable ? primaryTable.orderingKey.includes(tok.lower) : false;
          if (!indexed) {
            violations.push({
              code: 'UNINDEXED_IDENTITY_GROUP_BY',
              message: `GROUP BY identity column "${tok.lower}" is forbidden on table "${scopeRealTables[0] ?? 'unknown'}" (not in ordering key; risks Code 241 OOM)`,
              snippet: tok.lower,
            });
          }
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    tables: allTables,
    typedBinds,
    violations,
  };
}
