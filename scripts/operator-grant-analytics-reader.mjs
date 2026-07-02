/**
 * Operator script: keep analytics_reader least-privilege.
 *
 * Dry run:
 *   node scripts/operator-grant-analytics-reader.mjs
 *
 * Apply:
 *   node scripts/operator-grant-analytics-reader.mjs --execute
 *
 * Policy:
 *   - analytics_reader must not have database-wide SELECT.
 *   - only tables read by app/lib analytics_reader paths are allowed.
 *   - write-only tables stay outside this role.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@clickhouse/client'

const EXECUTE = process.argv.includes('--execute')

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (k) => env.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1].trim()
const client = createClient({
  url: get('CLICKHOUSE_URL'),
  username: get('CLICKHOUSE_USERNAME') || 'default',
  password: get('CLICKHOUSE_PASSWORD'),
  database: get('CLICKHOUSE_DB') || 'clickinsight',
  request_timeout: 30_000,
})

/**
 * Tables read by production app/lib code through getClickHouseClient('analytics_reader').
 *
 * Keep this explicit rather than granting clickinsight.*. It intentionally excludes
 * chat_conversations and llm_audit_ledger, which are writer-role tables.
 */
const REQUIRED_TABLES = [
  'analysis_jobs',
  'behavior_signals',
  'crawl_runs',
  'daily_site_summaries',
  'element_visibility',
  'element_visibility_v2',
  'events',
  'events_daily_by_dim',
  'events_hourly_by_dim',
  'events_monthly_by_dim',
  'form_interactions',
  'gsc_data',
  'image_visibility',
  'page_content_sections',
  'page_issues',
  'proposal_tickets',
  'scenario_match',
  'section_behavior_summary',
  'sessions',
  'sites',
  'video_events',
  'web_vitals',
]

const REQUIRED = new Set(REQUIRED_TABLES)

async function rows(sql) {
  return (await client.query({ query: sql, format: 'JSONEachRow' })).json()
}

async function command(sql) {
  if (!EXECUTE) {
    console.log(`[dry-run] ${sql}`)
    return
  }
  await client.command({ query: sql })
  console.log(`[applied] ${sql}`)
}

async function tableExists(table) {
  const r = await rows(
    `SELECT count() AS c
     FROM system.tables
     WHERE database = 'clickinsight' AND name = '${table}'`,
  ).catch(() => [])
  return Number(r[0]?.c ?? 0) > 0
}

async function main() {
  console.log(`mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const existingTables = []
  const missingTables = []
  for (const table of REQUIRED_TABLES) {
    if (await tableExists(table)) existingTables.push(table)
    else missingTables.push(table)
  }

  if (missingTables.length > 0) {
    console.log(`missing tables skipped: ${missingTables.map((t) => `clickinsight.${t}`).join(', ')}`)
  }

  const grants = await rows(
    `SELECT access_type, database, table
     FROM system.grants
     WHERE user_name = 'analytics_reader'
       AND access_type = 'SELECT'
       AND database = 'clickinsight'
     ORDER BY database, table`,
  )

  const hasDbWide = grants.some((g) => g.table == null)
  const currentTables = new Set(grants.filter((g) => g.table != null).map((g) => String(g.table)))
  const extraTables = [...currentTables].filter((t) => !REQUIRED.has(t))
  const missingGrants = existingTables.filter((t) => !currentTables.has(t) || hasDbWide)

  console.log(`database-wide SELECT: ${hasDbWide ? 'present (will revoke)' : 'absent'}`)
  console.log(`current table grants: ${[...currentTables].sort().join(', ') || '(none)'}`)
  console.log(`required table grants: ${existingTables.join(', ')}`)
  console.log(`extra table grants: ${extraTables.join(', ') || '(none)'}`)
  console.log(`missing explicit grants: ${missingGrants.join(', ') || '(none)'}`)

  if (hasDbWide) {
    await command(`REVOKE SELECT ON clickinsight.* FROM analytics_reader`)
  }

  for (const table of extraTables) {
    await command(`REVOKE SELECT ON clickinsight.${table} FROM analytics_reader`)
  }

  for (const table of missingGrants) {
    await command(`GRANT SELECT ON clickinsight.${table} TO analytics_reader`)
  }

  await command(`ALTER USER analytics_reader SETTINGS max_memory_usage = 2000000000`)

  const finalGrants = await rows(
    `SELECT access_type, database, table
     FROM system.grants
     WHERE user_name = 'analytics_reader'
       AND access_type = 'SELECT'
       AND database = 'clickinsight'
     ORDER BY database, table`,
  )
  console.log('\nfinal SELECT grants:')
  for (const g of finalGrants) {
    console.log(`  ${g.database}.${g.table ?? '*'}`)
  }

  await client.close()
}

main().catch(async (e) => {
  console.error('FAILED:', e.message?.split('\n')[0])
  await client.close().catch(() => {})
  process.exit(1)
})
