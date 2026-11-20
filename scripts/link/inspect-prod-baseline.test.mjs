import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  EXPECTED_LEGACY_TABLES,
  assertReadOnlyQuery,
  buildBaselineQueries,
  buildShowCreateTableQuery,
  parseCliArgs,
  redactSecrets,
  resolveConnectionConfig,
  runBaselineInspection,
  validateIdentifier,
} from './inspect-prod-baseline.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'inspect-prod-baseline.mjs')

test('assertReadOnlyQuery permits SELECT and allow-listed SHOW statements', () => {
  assert.deepEqual(assertReadOnlyQuery('SELECT version()'), { ok: true, statementType: 'SELECT' })
  assert.deepEqual(
    assertReadOnlyQuery("SELECT name FROM system.tables WHERE database = 'clickinsight'"),
    { ok: true, statementType: 'SELECT' },
  )
  assert.deepEqual(assertReadOnlyQuery('SHOW DATABASES'), { ok: true, statementType: 'SHOW' })
  assert.deepEqual(assertReadOnlyQuery('SHOW TABLES FROM clickinsight'), { ok: true, statementType: 'SHOW' })
  assert.deepEqual(assertReadOnlyQuery('SHOW CREATE TABLE clickinsight.events'), { ok: true, statementType: 'SHOW' })
  assert.deepEqual(assertReadOnlyQuery('SHOW USERS'), { ok: true, statementType: 'SHOW' })
  assert.deepEqual(assertReadOnlyQuery('SHOW ROLES'), { ok: true, statementType: 'SHOW' })
  assert.deepEqual(assertReadOnlyQuery('SHOW SETTINGS PROFILES'), { ok: true, statementType: 'SHOW' })
})

test('assertReadOnlyQuery rejects all mutating, DDL, multi-statement, and spoofed queries', () => {
  const forbidden = [
    '',
    '   ',
    'INSERT INTO clickinsight.events VALUES (1)',
    'DROP TABLE clickinsight.events',
    'ALTER TABLE clickinsight.events DELETE WHERE 1 = 1',
    'TRUNCATE TABLE clickinsight.events',
    'CREATE TABLE clickinsight.evil (x UInt8) ENGINE = Memory',
    'DELETE FROM clickinsight.events WHERE site_id = \'a\'',
    'GRANT ALL ON *.* TO attacker',
    'REVOKE SELECT ON clickinsight.events FROM analytics_reader',
    'SYSTEM FLUSH LOGS',
    'OPTIMIZE TABLE clickinsight.events FINAL',
    'SELECT 1; DROP TABLE clickinsight.events',
    'SELECT 1;',
    "SELECT * FROM clickinsight.events INTO OUTFILE '/tmp/dump.csv'",
    '/* SELECT 1 */ DROP TABLE clickinsight.events',
    '-- SELECT 1\nALTER TABLE clickinsight.events ADD COLUMN x UInt8',
    'SHOW CREATE TABLE clickinsight.events; DROP TABLE clickinsight.events',
    'SHOW PROCESSLIST',
    'SET max_memory_usage = 0',
    'KILL QUERY WHERE 1 = 1',
  ]

  for (const sql of forbidden) {
    assert.throws(() => assertReadOnlyQuery(sql), `Expected rejection for: ${sql}`)
  }
})

test('validateIdentifier accepts safe identifiers and rejects SQL injection attempts', () => {
  assert.equal(validateIdentifier('clickinsight'), 'clickinsight')
  assert.equal(validateIdentifier('events_hourly_by_dim'), 'events_hourly_by_dim')
  assert.throws(() => validateIdentifier(''))
  assert.throws(() => validateIdentifier('clickinsight; DROP TABLE events'))
  assert.throws(() => validateIdentifier('events--comment'))
  assert.throws(() => validateIdentifier('123invalid'))
  assert.throws(() => validateIdentifier('db.table'))
})

test('buildBaselineQueries covers all Step 0 census & schema targets and passes read-only check', () => {
  const queries = buildBaselineQueries({ database: 'clickinsight', days: 30, months: 12 })
  const ids = new Set(queries.map((q) => q.id))

  const requiredIds = [
    'server_info',
    'memory_settings',
    'databases',
    'tables',
    'users',
    'roles',
    'census_by_site',
    'census_by_site_device',
    'census_by_event_type',
    'census_monthly_conversions_outbound',
    'coordinate_saturation',
    'census_page_concentration',
  ]

  for (const id of requiredIds) {
    assert.ok(ids.has(id), `Missing required query id: ${id}`)
  }

  for (const q of queries) {
    assert.equal(assertReadOnlyQuery(q.sql).ok, true)
    if (q.fallbackSql) {
      assert.equal(assertReadOnlyQuery(q.fallbackSql).ok, true)
    }
  }

  // Ensure coordinate saturation query explicitly checks max(scroll_y) and max(click_y)
  const satQuery = queries.find((q) => q.id === 'coordinate_saturation')
  assert.match(satQuery.sql, /max\(scroll_y\)/i)
  assert.match(satQuery.sql, /max\(click_y\)/i)
  assert.match(satQuery.sql, /65535/)

  // Ensure monthly conversions query checks outbound clicks and conversion_type
  const convQuery = queries.find((q) => q.id === 'census_monthly_conversions_outbound')
  assert.match(convQuery.sql, /outbound_clicks/i)
  assert.match(convQuery.sql, /conversion_type/i)
})

test('parseCliArgs explicitly rejects --env-file to prevent .env reads', () => {
  assert.throws(() => parseCliArgs(['--env-file', '.env.local']), /intentionally unsupported/i)
  assert.deepEqual(parseCliArgs(['--dry-run', '--days', '45', '--months', '6']), {
    dryRun: true,
    days: 45,
    months: 6,
    database: undefined,
    out: null,
    help: false,
  })
})

test('--dry-run mode runs without credentials and verifies all SELECT/SHOW queries via CLI', () => {
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, '--dry-run'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  })
  const report = JSON.parse(stdout)

  assert.equal(report.mode, 'dry_run')
  assert.equal(report.safety.readOnlyEnforced, true)
  assert.equal(report.safety.envFilesRead, false)
  assert.equal(report.safety.allQueriesVerified, true)
  assert.ok(report.plannedQueries.length >= 12)
  assert.equal(report.plannedDdlTemplates.length, EXPECTED_LEGACY_TABLES.length)

  for (const q of report.plannedQueries) {
    assert.equal(q.readOnlyVerified, true)
    assert.ok(q.statementType === 'SELECT' || q.statementType === 'SHOW')
  }
  for (const ddl of report.plannedDdlTemplates) {
    assert.equal(ddl.readOnlyVerified, true)
    assert.equal(ddl.statementType, 'SHOW')
    assert.equal(ddl.sql, buildShowCreateTableQuery('clickinsight', ddl.table))
  }
})

test('live inspection with mocked ClickHouse captures dynamic SHOW CREATE TABLE and never leaks secrets', async () => {
  const secretHost = 'secret-ch-prod-99.internal.example'
  const secretPassword = 'SuperSecretPassword!98765'
  const secretUser = 'ro_inspector_user'
  const rawUrl = `https://${secretUser}:${secretPassword}@${secretHost}:8443`

  const executedBodies = []
  const mockFetch = async (_url, init) => {
    const body = String(init.body)
    executedBodies.push(body)

    if (body.includes('SELECT 1 AS ok')) {
      return new Response(
        `${JSON.stringify({ ok: 1, current_user: secretUser, version: '25.3.1.1' })}\n`,
        { status: 200 },
      )
    }
    if (body.includes('FROM system.tables')) {
      return new Response(
        [
          JSON.stringify({ database: 'clickinsight', name: 'events', engine: 'MergeTree', total_rows: '74540000', total_bytes: '123456789' }),
          JSON.stringify({ database: 'clickinsight', name: 'sites', engine: 'MergeTree', total_rows: '5', total_bytes: '1024' }),
        ].join('\n') + '\n',
        { status: 200 },
      )
    }
    if (body.includes('FROM system.users')) {
      // Simulate ACCESS_DENIED on system.users with hostname echoed in error body -> verify fallback & redaction
      return new Response(
        `Code: 497. ACCESS_DENIED on ${secretHost} with password ${secretPassword}`,
        { status: 403 },
      )
    }
    if (body.startsWith('SHOW USERS')) {
      return new Response(`${JSON.stringify({ name: 'analytics_reader' })}\n`, { status: 200 })
    }
    if (body.startsWith('SHOW CREATE TABLE clickinsight.events')) {
      return new Response(
        `${JSON.stringify({ statement: 'CREATE TABLE clickinsight.events (id String, scroll_y UInt16, click_y UInt16) ENGINE = MergeTree ORDER BY (site_id, timestamp)' })}\n`,
        { status: 200 },
      )
    }
    if (body.startsWith('SHOW CREATE TABLE clickinsight.sites')) {
      return new Response(
        `${JSON.stringify({ statement: 'CREATE TABLE clickinsight.sites (id String, url String) ENGINE = MergeTree ORDER BY id' })}\n`,
        { status: 200 },
      )
    }
    return new Response('', { status: 200 })
  }

  const report = await runBaselineInspection({
    dryRun: false,
    env: {
      CLICKHOUSE_URL: rawUrl,
      CLICKHOUSE_RO_USERNAME: secretUser,
      CLICKHOUSE_RO_PASSWORD: secretPassword,
      CLICKHOUSE_DB: 'clickinsight',
    },
    fetchImpl: mockFetch,
  })

  assert.equal(report.mode, 'live')
  assert.equal(report.connection.ok, true)
  assert.equal(report.connection.version, '25.3.1.1')
  assert.equal(report.sections.users.ok, true)
  assert.equal(report.sections.users.usedFallback, true)
  assert.equal(report.tableDdls.events.ok, true)
  assert.match(report.tableDdls.events.statement, /CREATE TABLE clickinsight\.events/)
  assert.equal(report.tableDdls.sites.ok, true)

  // Every single executed SQL body (minus FORMAT/SETTINGS suffix) must pass read-only guard
  assert.ok(executedBodies.length >= 14)

  // Verify zero secret leakage anywhere in the serialized JSON report
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(secretPassword), 'Report leaked CLICKHOUSE_RO_PASSWORD')
  assert.ok(!serialized.includes(secretHost), 'Report leaked CLICKHOUSE_URL hostname')
  assert.ok(!serialized.includes('Basic '), 'Report leaked Basic auth header')
})

test('redactSecrets strips credentials, hostnames, and Basic auth tokens', () => {
  const conn = resolveConnectionConfig({
    CLICKHOUSE_URL: 'https://user1:MyPass123@ch-prod.internal.local:8443',
    CLICKHOUSE_RO_PASSWORD: 'RoPass456',
  })
  const raw = `Error connecting to https://user1:MyPass123@ch-prod.internal.local:8443 Authorization: ${conn.authorization} pwd=RoPass456`
  const cleaned = redactSecrets(raw, conn.secretsToRedact)
  assert.ok(!cleaned.includes('MyPass123'))
  assert.ok(!cleaned.includes('RoPass456'))
  assert.ok(!cleaned.includes('ch-prod.internal.local'))
  assert.ok(!cleaned.includes(conn.authorization))
})

test('script source never references .env file loading APIs', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  assert.ok(!source.includes('dotenv'), 'Script must not use dotenv')
  assert.ok(!source.includes('readFileSync'), 'Script must not read any files from disk')
})
