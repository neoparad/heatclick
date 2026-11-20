#!/usr/bin/env node
/**
 * inspect-prod-baseline.mjs — UGOKI LINK v2 Step 0 (Wave 0-C) Production Baseline Inspector
 *
 * Purpose (Master Architecture v2 §13.2 Step 0 / consistency-sequence.md Q-0):
 *   Safely capture production ClickHouse truth before Wave 2/3 schema & telemetry rollout:
 *     1. Server version, timezone, memory limits & settings (origin of 4.54 GiB cap)
 *     2. Complete database & table inventory (`system.tables`)
 *     3. `SHOW CREATE TABLE` DDL for every table in the target database
 *     4. ClickHouse users, roles, settings profiles, and row policies
 *     5. Legacy data census (by site, by device, by event_type, monthly conversions &
 *        outbound clicks, `conversion_type` presence, page concentration, and
 *        `max(scroll_y)` / `max(click_y)` UInt16=65535 saturation check)
 *
 * Hard safety guarantees:
 *   - STRICTLY READ-ONLY: every query passes `assertReadOnlyQuery()` allowing ONLY
 *     single-statement `SELECT` or allow-listed `SHOW` queries.
 *   - NEVER reads `.env*` files. Reads standard runtime environment variables only
 *     (`CLICKHOUSE_URL`, `CLICKHOUSE_DB`, `CLICKHOUSE_RO_USERNAME`,
 *     `CLICKHOUSE_RO_PASSWORD`, with fallback to `CLICKHOUSE_ANALYTICS_PASSWORD` or
 *     `CLICKHOUSE_USERNAME` / `CLICKHOUSE_PASSWORD`).
 *   - NEVER outputs secrets, passwords, authorization headers, or raw hostnames/URLs
 *     in stdout, stderr, or JSON reports.
 *
 * Usage:
 *   node scripts/link/inspect-prod-baseline.mjs --dry-run
 *   CLICKHOUSE_URL=... CLICKHOUSE_RO_PASSWORD=... node scripts/link/inspect-prod-baseline.mjs --out baseline.json
 */

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const DEFAULT_DATABASE = 'clickinsight'
export const DEFAULT_DAYS = 30
export const DEFAULT_MONTHS = 12
const CONNECT_TIMEOUT_MS = 15_000
const QUERY_TIMEOUT_MS = 60_000
const SERVER_TIME_LIMIT_SEC = 50
const MAX_ERROR_CHARS = 400

/**
 * Legacy tables expected in production (used in `--dry-run` preview and as fallback
 * reference when `system.tables` is not readable). Live runs dynamically inspect all
 * tables returned by `system.tables`.
 */
export const EXPECTED_LEGACY_TABLES = Object.freeze([
  'events',
  'sites',
  'sessions',
  'behavior_signals',
  'image_visibility',
  'form_interactions',
  'video_events',
  'element_visibility',
  'element_visibility_v2',
  'scroll_timeline',
  'web_vitals',
  'audit_events',
  'events_hourly_by_dim',
  'events_daily_by_dim',
  'events_monthly_by_dim',
  'sessions_hourly',
  'crawl_runs',
  'page_content_sections',
  'page_performance',
  'page_issues',
  'section_behavior_summary',
  'scenario_match',
  'daily_site_summaries',
])

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'ALTER',
  'DROP',
  'DELETE',
  'TRUNCATE',
  'CREATE',
  'ATTACH',
  'DETACH',
  'RENAME',
  'OPTIMIZE',
  'GRANT',
  'REVOKE',
  'KILL',
  'SET',
  'EXCHANGE',
  'MOVE',
  'REPLACE',
  'UNDROP',
  'BACKUP',
  'RESTORE',
  'WATCH',
  'USE',
]

const FORBIDDEN_KEYWORD_REGEX = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i')
// Disallow SYSTEM command unless used as the read-only `system.<table_name>` database qualifier
const FORBIDDEN_SYSTEM_COMMAND_REGEX = /\bSYSTEM\b(?!\s*\.)/i
const FORBIDDEN_CLAUSE_REGEX = /\bINTO\s+OUTFILE\b/i

const ALLOWED_SHOW_PATTERNS = [
  /^SHOW\s+DATABASES$/i,
  /^SHOW\s+TABLES(?:\s+FROM\s+[A-Za-z_][A-Za-z0-9_]*)?$/i,
  /^SHOW\s+CREATE\s+TABLE\s+[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/i,
  /^SHOW\s+USERS$/i,
  /^SHOW\s+ROLES$/i,
  /^SHOW\s+SETTINGS\s+PROFILES$/i,
  /^SHOW\s+GRANTS(?:\s+FOR\s+[A-Za-z_][A-Za-z0-9_]*)?$/i,
]

/**
 * Validate a ClickHouse database or table identifier to prevent SQL injection.
 */
export function validateIdentifier(name, label = 'identifier') {
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Invalid ClickHouse ${label}: must match ${IDENTIFIER_PATTERN.source}`)
  }
  return name
}

/**
 * Strip SQL comments and mask single-quoted string literals so keyword inspection
 * evaluates SQL structure without false positives on literal string values.
 */
function stripCommentsAndStrings(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    // Single-line comment --
    if (ch === '-' && next === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i += 1
      out += ' '
      continue
    }
    // Block comment /* ... */
    if (ch === '/' && next === '*') {
      i += 2
      let closed = false
      while (i < n - 1) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2
          closed = true
          break
        }
        i += 1
      }
      if (!closed) {
        throw new Error('Rejected query: unterminated block comment')
      }
      out += ' '
      continue
    }
    // Single-quoted string literal
    if (ch === "'") {
      i += 1
      let closed = false
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) {
        throw new Error('Rejected query: unterminated string literal')
      }
      out += "''"
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Verify that `sql` is a strictly read-only single SELECT or allow-listed SHOW statement.
 * Throws an Error on any violation.
 */
export function assertReadOnlyQuery(sql) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Rejected query: SQL must be a non-empty string')
  }

  const normalized = stripCommentsAndStrings(sql).replace(/\s+/g, ' ').trim()

  if (normalized.length === 0) {
    throw new Error('Rejected query: SQL contains no executable statement')
  }

  // Disallow semicolons entirely to prevent multi-statement execution
  if (normalized.includes(';')) {
    throw new Error('Rejected query: semicolons / multi-statement SQL are forbidden')
  }

  if (FORBIDDEN_CLAUSE_REGEX.test(normalized)) {
    throw new Error('Rejected query: INTO OUTFILE is forbidden')
  }

  if (/^SELECT\b/i.test(normalized)) {
    const match = normalized.match(FORBIDDEN_KEYWORD_REGEX)
    if (match) {
      throw new Error(`Rejected SELECT query: forbidden keyword "${match[1].toUpperCase()}"`)
    }
    if (FORBIDDEN_SYSTEM_COMMAND_REGEX.test(normalized)) {
      throw new Error('Rejected SELECT query: forbidden keyword "SYSTEM"')
    }
    return { ok: true, statementType: 'SELECT' }
  }

  if (/^SHOW\b/i.test(normalized)) {
    const allowed = ALLOWED_SHOW_PATTERNS.some((pattern) => pattern.test(normalized))
    if (!allowed) {
      throw new Error(`Rejected SHOW query: not in read-only allow-list ("${normalized.slice(0, 64)}")`)
    }
    return { ok: true, statementType: 'SHOW' }
  }

  const firstToken = normalized.split(' ')[0]?.toUpperCase() ?? 'UNKNOWN'
  throw new Error(`Rejected query: only SELECT and SHOW are permitted (got "${firstToken}")`)
}

/**
 * Build a validated `SHOW CREATE TABLE <db>.<table>` query.
 */
export function buildShowCreateTableQuery(database, tableName) {
  const db = validateIdentifier(database, 'database')
  const tbl = validateIdentifier(tableName, 'table')
  const sql = `SHOW CREATE TABLE ${db}.${tbl}`
  assertReadOnlyQuery(sql)
  return sql
}

/**
 * Build the complete ordered list of read-only baseline inspection queries.
 */
export function buildBaselineQueries(options = {}) {
  const db = validateIdentifier(options.database ?? DEFAULT_DATABASE, 'database')
  const days = options.days ?? DEFAULT_DAYS
  const months = options.months ?? DEFAULT_MONTHS

  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('days must be an integer between 1 and 365')
  }
  if (!Number.isInteger(months) || months < 1 || months > 36) {
    throw new Error('months must be an integer between 1 and 36')
  }

  const queries = [
    {
      id: 'server_info',
      category: 'server',
      title: 'ClickHouse version, current user, timezone, and uptime',
      sql: 'SELECT version() AS version, currentUser() AS current_user, timezone() AS server_timezone, uptime() AS uptime_seconds',
    },
    {
      id: 'memory_settings',
      category: 'server',
      title: 'Active session settings (readonly, memory limits, execution limits)',
      sql: [
        'SELECT name, value, changed, description',
        'FROM system.settings',
        "WHERE name IN ('readonly', 'max_memory_usage', 'max_memory_usage_for_user', 'max_server_memory_usage', 'max_server_memory_usage_to_ram_ratio', 'max_execution_time', 'max_concurrent_queries', 'max_bytes_before_external_group_by', 'max_bytes_before_external_sort', 'async_insert')",
        'ORDER BY name',
      ].join('\n'),
    },
    {
      id: 'memory_metrics',
      category: 'server',
      title: 'Host/cgroup memory ceiling indicators (4.54 GiB origin check)',
      sql: [
        'SELECT metric, value',
        'FROM system.asynchronous_metrics',
        "WHERE metric IN ('OSMemoryTotal', 'OSMemoryAvailable', 'CGroupMemoryTotal', 'CGroupMemoryUsed', 'MemoryResident', 'MemoryVirtual')",
        'ORDER BY metric',
      ].join('\n'),
    },
    {
      id: 'databases',
      category: 'schema',
      title: 'All ClickHouse databases',
      sql: 'SHOW DATABASES',
    },
    {
      id: 'tables',
      category: 'schema',
      title: `Complete table inventory in database ${db}`,
      sql: [
        'SELECT database, name, engine, partition_key, sorting_key, primary_key, total_rows, total_bytes, formatReadableSize(total_bytes) AS readable_size',
        'FROM system.tables',
        `WHERE database = '${db}'`,
        'ORDER BY total_bytes DESC, name ASC',
      ].join('\n'),
    },
    {
      id: 'users',
      category: 'access',
      title: 'ClickHouse users inventory',
      sql: 'SELECT name, auth_type, host_ip, host_names, default_roles_all, default_roles_list FROM system.users ORDER BY name',
      fallbackSql: 'SHOW USERS',
    },
    {
      id: 'roles',
      category: 'access',
      title: 'ClickHouse roles inventory',
      sql: 'SELECT name FROM system.roles ORDER BY name',
      fallbackSql: 'SHOW ROLES',
    },
    {
      id: 'settings_profiles',
      category: 'access',
      title: 'ClickHouse settings profiles inventory',
      sql: 'SHOW SETTINGS PROFILES',
    },
    {
      id: 'row_policies',
      category: 'access',
      title: 'ClickHouse row policies inventory (isolation baseline)',
      sql: 'SELECT database, table, name, apply_to_all, apply_to_list FROM system.row_policies ORDER BY database, table, name',
    },
    {
      id: 'census_by_site',
      category: 'census',
      title: `Legacy census by site (last ${days} days)`,
      sql: [
        'SELECT site_id,',
        '       count() AS total_events,',
        "       countIf(event_type = 'pageview') AS pageviews,",
        '       uniq(session_id) AS sessions,',
        '       uniq(url) AS distinct_urls,',
        '       min(timestamp) AS first_ts,',
        '       max(timestamp) AS last_ts',
        `FROM ${db}.events`,
        `WHERE timestamp >= now() - INTERVAL ${days} DAY`,
        'GROUP BY site_id',
        'ORDER BY pageviews DESC',
        'LIMIT 100',
      ].join('\n'),
    },
    {
      id: 'census_by_site_device',
      category: 'census',
      title: `Legacy census by site and device_type (last ${days} days)`,
      sql: [
        'SELECT site_id,',
        "       coalesce(nullIf(device_type, ''), 'unknown') AS device_type,",
        '       count() AS total_events,',
        "       countIf(event_type = 'pageview') AS pageviews,",
        '       uniq(session_id) AS sessions',
        `FROM ${db}.events`,
        `WHERE timestamp >= now() - INTERVAL ${days} DAY`,
        'GROUP BY site_id, device_type',
        'ORDER BY site_id ASC, pageviews DESC',
        'LIMIT 500',
      ].join('\n'),
    },
    {
      id: 'census_by_event_type',
      category: 'census',
      title: `Legacy census by event_type (last ${days} days)`,
      sql: [
        'SELECT event_type,',
        '       count() AS rows,',
        '       uniq(session_id) AS sessions,',
        '       uniq(site_id) AS sites',
        `FROM ${db}.events`,
        `WHERE timestamp >= now() - INTERVAL ${days} DAY`,
        'GROUP BY event_type',
        'ORDER BY rows DESC',
        'LIMIT 100',
      ].join('\n'),
    },
    {
      id: 'census_monthly_conversions_outbound',
      category: 'census',
      title: `Monthly conversions and outbound clicks by site (last ${months} months)`,
      sql: [
        'SELECT toYYYYMM(timestamp) AS year_month,',
        '       site_id,',
        "       countIf(event_type = 'pageview') AS pageviews,",
        "       countIf(event_type = 'click') AS clicks,",
        "       countIf(event_type = 'click' AND ifNull(element_href, '') != '' AND domainWithoutWWW(element_href) != '' AND domainWithoutWWW(element_href) != domainWithoutWWW(url)) AS outbound_clicks,",
        "       countIf(ifNull(conversion_type, '') != '') AS conversion_rows,",
        "       countIf(event_type = 'click' AND ifNull(conversion_type, '') != '') AS clicks_with_conversion_type,",
        "       uniqIf(session_id, ifNull(conversion_type, '') != '') AS conversion_sessions",
        `FROM ${db}.events`,
        `WHERE timestamp >= now() - INTERVAL ${months} MONTH`,
        'GROUP BY year_month, site_id',
        'ORDER BY year_month DESC, pageviews DESC',
        'LIMIT 500',
      ].join('\n'),
    },
    {
      id: 'coordinate_saturation',
      category: 'census',
      title: `Coordinate UInt16 saturation check: max(scroll_y) & max(click_y) (last ${days} days)`,
      sql: [
        'SELECT site_id,',
        '       max(scroll_y) AS max_scroll_y,',
        '       max(click_y) AS max_click_y,',
        '       countIf(scroll_y >= 65535) AS scroll_y_at_uint16_cap,',
        '       countIf(click_y >= 65535) AS click_y_at_uint16_cap,',
        "       countIf(event_type = 'scroll') AS total_scroll_rows,",
        "       countIf(event_type = 'click') AS total_click_rows",
        `FROM ${db}.events`,
        `WHERE timestamp >= now() - INTERVAL ${days} DAY`,
        'GROUP BY site_id',
        'ORDER BY scroll_y_at_uint16_cap DESC, click_y_at_uint16_cap DESC',
        'LIMIT 100',
      ].join('\n'),
    },
    {
      id: 'census_page_concentration',
      category: 'census',
      title: `Page traffic shape & concentration by site (last ${days} days)`,
      sql: [
        'SELECT site_id,',
        '       count() AS distinct_pages,',
        '       sum(pvs) AS total_pvs,',
        '       max(pvs) AS top1_page_pvs,',
        '       countIf(pvs >= 100) AS pages_ge_100_pv',
        'FROM (',
        "  SELECT site_id, url, countIf(event_type = 'pageview') AS pvs",
        `  FROM ${db}.events`,
        `  WHERE timestamp >= now() - INTERVAL ${days} DAY`,
        '  GROUP BY site_id, url',
        ')',
        'GROUP BY site_id',
        'ORDER BY total_pvs DESC',
        'LIMIT 100',
      ].join('\n'),
    },
  ]

  for (const q of queries) {
    assertReadOnlyQuery(q.sql)
    if (q.fallbackSql) {
      assertReadOnlyQuery(q.fallbackSql)
    }
  }

  return queries
}

/**
 * Redact all known secret values (passwords, auth headers, raw URLs, hostnames) from text.
 */
export function redactSecrets(text, secretValues = []) {
  let result = String(text ?? '')
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 3) {
      result = result.split(secret).join('[REDACTED]')
    }
  }
  // Defense-in-depth: mask inline basic-auth URLs and Basic auth headers
  result = result.replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1[REDACTED]:[REDACTED]@')
  result = result.replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [REDACTED]')
  return result
}

/**
 * Resolve ClickHouse connection strictly from runtime environment variables (never reads `.env*`).
 */
export function resolveConnectionConfig(env = process.env, databaseOverride) {
  const rawUrl = env.CLICKHOUSE_URL
  if (!rawUrl || String(rawUrl).trim() === '') {
    throw new Error('CLICKHOUSE_URL environment variable is required (unless --dry-run is specified)')
  }

  let endpoint
  try {
    endpoint = new URL(rawUrl)
  } catch {
    throw new Error('CLICKHOUSE_URL could not be parsed as a valid URL')
  }

  const urlUser = endpoint.username ? decodeURIComponent(endpoint.username) : ''
  const urlPassword = endpoint.password ? decodeURIComponent(endpoint.password) : ''
  const hostForRedaction = endpoint.host
  const hostnameForRedaction = endpoint.hostname

  endpoint.username = ''
  endpoint.password = ''
  endpoint.pathname = '/'
  endpoint.search = ''
  endpoint.hash = ''

  let username = ''
  let usernameVar = 'default'
  if (env.CLICKHOUSE_RO_USERNAME) {
    username = env.CLICKHOUSE_RO_USERNAME
    usernameVar = 'CLICKHOUSE_RO_USERNAME'
  } else if (env.CLICKHOUSE_USERNAME && !env.CLICKHOUSE_RO_PASSWORD && !env.CLICKHOUSE_ANALYTICS_PASSWORD) {
    username = env.CLICKHOUSE_USERNAME
    usernameVar = 'CLICKHOUSE_USERNAME'
  } else if (urlUser) {
    username = urlUser
    usernameVar = 'CLICKHOUSE_URL(embedded)'
  } else {
    username = 'analytics_reader'
    usernameVar = 'default(analytics_reader)'
  }

  let password = ''
  let passwordVar = ''
  if (env.CLICKHOUSE_RO_PASSWORD) {
    password = env.CLICKHOUSE_RO_PASSWORD
    passwordVar = 'CLICKHOUSE_RO_PASSWORD'
  } else if (env.CLICKHOUSE_ANALYTICS_PASSWORD) {
    password = env.CLICKHOUSE_ANALYTICS_PASSWORD
    passwordVar = 'CLICKHOUSE_ANALYTICS_PASSWORD'
  } else if (env.CLICKHOUSE_PASSWORD) {
    password = env.CLICKHOUSE_PASSWORD
    passwordVar = 'CLICKHOUSE_PASSWORD'
  } else if (urlPassword) {
    password = urlPassword
    passwordVar = 'CLICKHOUSE_URL(embedded)'
  } else {
    throw new Error(
      'ClickHouse password environment variable is required (CLICKHOUSE_RO_PASSWORD, CLICKHOUSE_ANALYTICS_PASSWORD, or CLICKHOUSE_PASSWORD)',
    )
  }

  const database = validateIdentifier(databaseOverride ?? env.CLICKHOUSE_DB ?? DEFAULT_DATABASE, 'database')
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

  const secretsToRedact = [
    rawUrl,
    endpoint.href,
    hostForRedaction,
    hostnameForRedaction,
    password,
    urlPassword,
    authorization,
    Buffer.from(`${username}:${password}`).toString('base64'),
  ].filter((v) => typeof v === 'string' && v.length > 0)

  return {
    endpoint,
    database,
    authorization,
    credentialSources: {
      urlVar: 'CLICKHOUSE_URL',
      usernameVar,
      passwordVar,
    },
    secretsToRedact,
  }
}

/**
 * Parse CLI arguments. Deliberately does NOT support `--env-file` so `.env*` files are never read.
 */
export function parseCliArgs(argv) {
  const args = {
    dryRun: false,
    days: DEFAULT_DAYS,
    months: DEFAULT_MONTHS,
    database: undefined,
    out: null,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') {
      args.dryRun = true
    } else if (token === '--days') {
      args.days = Number(argv[++i])
    } else if (token === '--months') {
      args.months = Number(argv[++i])
    } else if (token === '--database') {
      args.database = argv[++i]
    } else if (token === '--out') {
      args.out = argv[++i] ?? null
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else if (token === '--env-file') {
      throw new Error('--env-file is intentionally unsupported: pass runtime environment variables instead of reading .env files')
    } else {
      throw new Error(`Unknown CLI argument: ${token}`)
    }
  }

  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) {
    throw new Error('--days must be an integer between 1 and 365')
  }
  if (!Number.isInteger(args.months) || args.months < 1 || args.months > 36) {
    throw new Error('--months must be an integer between 1 and 36')
  }
  if (args.database !== undefined) {
    validateIdentifier(args.database, 'database')
  }

  return args
}

function classifyClickHouseError(status, rawBody, secretsToRedact) {
  const sanitized = redactSecrets(String(rawBody ?? ''), secretsToRedact)
  let kind = 'error'
  if (/UNKNOWN_TABLE|Code:\s*60\b/.test(sanitized)) kind = 'unknown_table'
  else if (/ACCESS_DENIED|Code:\s*497\b/.test(sanitized)) kind = 'access_denied'
  else if (/READONLY|Code:\s*164\b/.test(sanitized)) kind = 'readonly_setting'
  else if (/AUTHENTICATION_FAILED|Code:\s*516\b/.test(sanitized) || status === 401 || status === 403) {
    kind = 'auth_failed'
  } else if (/MEMORY_LIMIT_EXCEEDED|Code:\s*241\b/.test(sanitized)) kind = 'memory_limit'
  else if (/TIMEOUT_EXCEEDED|Code:\s*159\b/.test(sanitized)) kind = 'timeout'

  return {
    kind,
    message: sanitized.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS),
  }
}

function createClickHouseRunner(connection, fetchImpl = fetch) {
  let useServerTimeLimit = true

  async function execute(sql, timeoutMs) {
    // Re-enforce read-only gate immediately before every network call
    assertReadOnlyQuery(sql)

    const limitClause = useServerTimeLimit ? `\nSETTINGS max_execution_time = ${SERVER_TIME_LIMIT_SEC}` : ''
    const body = `${sql.trim()}\nFORMAT JSONEachRow${limitClause}`

    try {
      const response = await fetchImpl(connection.endpoint.href, {
        method: 'POST',
        headers: {
          Authorization: connection.authorization,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        return { ok: false, ...classifyClickHouseError(response.status, text, connection.secretsToRedact) }
      }
      const rows = text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      return { ok: true, rows }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const safeMessage = redactSecrets(e.message, connection.secretsToRedact)
      const timedOut = e.name === 'TimeoutError' || /TIMEOUT/i.test(safeMessage)
      return {
        ok: false,
        kind: timedOut ? 'connect_timeout' : 'connect_failed',
        message: `${e.name}: ${safeMessage}`.slice(0, MAX_ERROR_CHARS),
      }
    }
  }

  return {
    async probe() {
      const sql = 'SELECT 1 AS ok, currentUser() AS current_user, version() AS version'
      let res = await execute(sql, CONNECT_TIMEOUT_MS)
      if (!res.ok && res.kind === 'readonly_setting') {
        useServerTimeLimit = false
        res = await execute(sql, CONNECT_TIMEOUT_MS)
      }
      return { ...res, serverTimeLimitApplied: useServerTimeLimit }
    },
    query(sql) {
      return execute(sql, QUERY_TIMEOUT_MS)
    },
  }
}

/**
 * Run either a `--dry-run` safety verification report or live production baseline capture.
 */
export async function runBaselineInspection(options = {}) {
  const dryRun = Boolean(options.dryRun)
  const days = options.days ?? DEFAULT_DAYS
  const months = options.months ?? DEFAULT_MONTHS
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch

  const database = validateIdentifier(
    options.database ?? env.CLICKHOUSE_DB ?? DEFAULT_DATABASE,
    'database',
  )
  const plannedQueries = buildBaselineQueries({ database, days, months })

  if (dryRun) {
    const plannedDdlQueries = EXPECTED_LEGACY_TABLES.map((table) => {
      const sql = buildShowCreateTableQuery(database, table)
      const check = assertReadOnlyQuery(sql)
      return {
        id: `ddl_${table}`,
        table,
        sql,
        statementType: check.statementType,
        readOnlyVerified: check.ok,
      }
    })

    return {
      schemaVersion: '1.0',
      mode: 'dry_run',
      generatedAt: new Date().toISOString(),
      database,
      parameters: { days, months },
      safety: {
        readOnlyEnforced: true,
        envFilesRead: false,
        allQueriesVerified: true,
        totalPlannedQueries: plannedQueries.length + plannedDdlQueries.length,
      },
      plannedQueries: plannedQueries.map((q) => {
        const primaryCheck = assertReadOnlyQuery(q.sql)
        const fallbackCheck = q.fallbackSql ? assertReadOnlyQuery(q.fallbackSql) : null
        return {
          id: q.id,
          category: q.category,
          title: q.title,
          sql: q.sql,
          statementType: primaryCheck.statementType,
          readOnlyVerified: primaryCheck.ok,
          ...(q.fallbackSql
            ? {
                fallbackSql: q.fallbackSql,
                fallbackStatementType: fallbackCheck?.statementType,
                fallbackReadOnlyVerified: fallbackCheck?.ok ?? false,
              }
            : {}),
        }
      }),
      plannedDdlTemplates: plannedDdlQueries,
    }
  }

  const connection = resolveConnectionConfig(env, database)
  const runner = createClickHouseRunner(connection, fetchImpl)

  const report = {
    schemaVersion: '1.0',
    mode: 'live',
    generatedAt: new Date().toISOString(),
    database: connection.database,
    parameters: { days, months },
    safety: {
      readOnlyEnforced: true,
      envFilesRead: false,
      credentialSources: connection.credentialSources,
    },
    connection: {
      ok: false,
      currentUser: null,
      version: null,
      serverTimeLimitApplied: null,
    },
    sections: {},
    tableDdls: {},
  }

  const probe = await runner.probe()
  if (!probe.ok) {
    report.connection = {
      ok: false,
      kind: probe.kind,
      message: probe.message,
      currentUser: null,
      version: null,
      serverTimeLimitApplied: probe.serverTimeLimitApplied,
    }
    return report
  }

  report.connection = {
    ok: true,
    currentUser: probe.rows[0]?.current_user ?? null,
    version: probe.rows[0]?.version ?? null,
    serverTimeLimitApplied: probe.serverTimeLimitApplied,
  }

  for (const q of plannedQueries) {
    let result = await runner.query(q.sql)
    let usedFallback = false
    if (!result.ok && q.fallbackSql && (result.kind === 'access_denied' || result.kind === 'unknown_table')) {
      result = await runner.query(q.fallbackSql)
      usedFallback = true
    }
    report.sections[q.id] = result.ok
      ? { ok: true, usedFallback, rowCount: result.rows.length, rows: result.rows }
      : { ok: false, usedFallback, kind: result.kind, message: result.message }
  }

  // Capture SHOW CREATE TABLE for every discovered table (or fallback to EXPECTED_LEGACY_TABLES if system.tables denied)
  const discoveredTables = report.sections.tables?.ok
    ? report.sections.tables.rows
        .map((row) => String(row.name ?? ''))
        .filter((name) => IDENTIFIER_PATTERN.test(name))
    : [...EXPECTED_LEGACY_TABLES]

  for (const table of discoveredTables) {
    const ddlSql = buildShowCreateTableQuery(connection.database, table)
    const ddlRes = await runner.query(ddlSql)
    if (ddlRes.ok) {
      report.tableDdls[table] = {
        ok: true,
        statement: String(ddlRes.rows[0]?.statement ?? ''),
      }
    } else {
      report.tableDdls[table] = {
        ok: false,
        kind: ddlRes.kind,
        message: ddlRes.message,
      }
    }
  }

  return report
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(
      [
        'UGOKI LINK v2 Step 0 Production Baseline Inspector (Read-Only)',
        '',
        'Usage:',
        '  node scripts/link/inspect-prod-baseline.mjs [--dry-run] [--days 30] [--months 12] [--database clickinsight] [--out report.json]',
        '',
        'Environment variables (required when not using --dry-run; .env* files are never read):',
        '  CLICKHOUSE_URL',
        '  CLICKHOUSE_RO_USERNAME (default: analytics_reader)',
        '  CLICKHOUSE_RO_PASSWORD (fallback: CLICKHOUSE_ANALYTICS_PASSWORD / CLICKHOUSE_PASSWORD)',
        '  CLICKHOUSE_DB          (default: clickinsight)',
        '',
      ].join('\n'),
    )
    return 0
  }

  const report = await runBaselineInspection({
    dryRun: args.dryRun,
    days: args.days,
    months: args.months,
    database: args.database,
  })

  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (args.out) {
    writeFileSync(args.out, serialized, 'utf8')
    process.stderr.write(`Baseline report written to ${args.out}\n`)
  } else {
    process.stdout.write(serialized)
  }

  if (report.mode === 'live' && !report.connection.ok) {
    return 1
  }
  return 0
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectExecution) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`${redactSecrets(msg, [process.env.CLICKHOUSE_URL, process.env.CLICKHOUSE_RO_PASSWORD, process.env.CLICKHOUSE_PASSWORD, process.env.CLICKHOUSE_ANALYTICS_PASSWORD].filter(Boolean))}\n`)
      process.exitCode = 2
    })
}
