#!/usr/bin/env node
/**
 * fusion-precheck.mjs — 行動×構造の突合 段階1 着手前の確認 (読み取り専用)
 *
 * 仕様: docs/proposals/2026-11-12-fusion-stage1-fix-priority-spec.md §6
 *
 * 何を確認するか:
 *   1. 構造データの5表が本番 ClickHouse にあるか / crawl_runs に行があるか  (§6 の 1)
 *   2. page_issues に実際に入っている課題の種類と件数、重複の有無          (§6 の 5)
 *   3. サイト別の CV 件数 (直近 N 日)                                      (§6 の 6)
 *   --review を付けると、基盤レビューのオーナー確認項目も見る
 *   (events の定義、読み取りユーザーの設定、座標の上限張り付き、画像位置の0、種別の内訳)。
 *
 * 安全性:
 *   - SELECT / SHOW だけを送る。書き込み・定義変更は一切しない。
 *   - 接続先のホストと認証情報は表示しない。
 *   - events への問い合わせは直近 N 日 (既定30) に限る。
 *
 * 実行場所: 本番 ClickHouse は接続元を制限している。許可された接続元で実行すること。
 *
 * 使い方:
 *   node scripts/fusion-precheck.mjs --env-file .env.local
 *   node scripts/fusion-precheck.mjs --env-file .env.local --review --json precheck.json
 *
 * 必要な設定 (環境変数、または --env-file):
 *   CLICKHOUSE_URL
 *   CLICKHOUSE_RO_PASSWORD   (無ければ旧名 CLICKHOUSE_ANALYTICS_PASSWORD を使う)
 *   CLICKHOUSE_RO_USERNAME   (省略時 analytics_reader)
 */

import { readFileSync, writeFileSync } from 'node:fs'

const DATABASE = 'clickinsight'
const FUSION_TABLES = [
  'crawl_runs',
  'page_content_sections',
  'page_performance',
  'page_issues',
  'section_behavior_summary',
]
const CONNECT_TIMEOUT_MS = 15_000
const QUERY_TIMEOUT_MS = 60_000
const SERVER_TIME_LIMIT_SEC = 50
const MAX_ERROR_CHARS = 400

function out(line = '') {
  process.stdout.write(`${line}\n`)
}

function parseArgs(argv) {
  const args = { envFile: null, review: false, json: null, days: 30 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env-file') args.envFile = argv[++i] ?? null
    else if (a === '--review') args.review = true
    else if (a === '--json') args.json = argv[++i] ?? null
    else if (a === '--days') args.days = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`不明な引数: ${a}`)
  }
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 90) {
    throw new Error('--days は 1〜90 の整数で指定してください')
  }
  return args
}

function loadEnvFile(path) {
  const env = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

function resolveConnection(env) {
  const rawUrl = env.CLICKHOUSE_URL
  if (!rawUrl) throw new Error('CLICKHOUSE_URL が設定されていません')

  let passwordSource = 'CLICKHOUSE_RO_PASSWORD'
  let password = env.CLICKHOUSE_RO_PASSWORD
  if (!password) {
    passwordSource = 'CLICKHOUSE_ANALYTICS_PASSWORD (旧名)'
    password = env.CLICKHOUSE_ANALYTICS_PASSWORD
  }
  if (!password) {
    throw new Error('読み取り専用ユーザーのパスワードが設定されていません (CLICKHOUSE_RO_PASSWORD)')
  }

  let endpoint
  try {
    endpoint = new URL(rawUrl)
  } catch {
    // 元の例外は URL の値を含みうるので、値を出さない文言に置き換える。
    throw new Error('CLICKHOUSE_URL を URL として解釈できません')
  }
  endpoint.username = ''
  endpoint.password = ''
  endpoint.pathname = '/'
  endpoint.search = ''

  const username = env.CLICKHOUSE_RO_USERNAME || 'analytics_reader'
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  return { endpoint, authorization, passwordSource }
}

/** ClickHouse のエラー本文から種類だけを取り出す (本文は長いので先頭だけ残す)。 */
function classifyError(status, body) {
  const text = String(body || '')
  let kind = 'error'
  if (/UNKNOWN_TABLE|Code:\s*60\b/.test(text)) kind = 'unknown_table'
  else if (/ACCESS_DENIED|Code:\s*497\b/.test(text)) kind = 'access_denied'
  else if (/READONLY|Code:\s*164\b/.test(text)) kind = 'readonly_setting'
  else if (/AUTHENTICATION_FAILED|Code:\s*516\b/.test(text) || status === 401 || status === 403) {
    kind = 'auth_failed'
  } else if (/MEMORY_LIMIT_EXCEEDED|Code:\s*241\b/.test(text)) kind = 'memory_limit'
  else if (/TIMEOUT_EXCEEDED|Code:\s*159\b/.test(text)) kind = 'timeout'
  return { kind, message: text.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS) }
}

function createRunner(connection) {
  // 読み取り専用ユーザーは問い合わせ内の SETTINGS を拒否する場合がある。
  // 最初の疎通で確かめ、拒否されたら以後は付けない。
  let useTimeLimit = true

  async function send(sql, timeoutMs) {
    // FORMAT → SETTINGS の順にする。SHOW 系はこの順でないと構文エラーになる。
    const limit = useTimeLimit ? `\nSETTINGS max_execution_time = ${SERVER_TIME_LIMIT_SEC}` : ''
    const body = `${sql.trim()}\nFORMAT JSONEachRow${limit}`
    try {
      const res = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { Authorization: connection.authorization, 'Content-Type': 'text/plain' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, ...classifyError(res.status, text) }
      const rows = text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l))
      return { ok: true, rows }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = e.cause && typeof e.cause === 'object' && 'code' in e.cause ? String(e.cause.code) : ''
      const timedOut = e.name === 'TimeoutError' || /TIMEOUT/.test(code)
      return {
        ok: false,
        kind: timedOut ? 'connect_timeout' : 'connect_failed',
        message: [e.name, code].filter(Boolean).join(' '),
      }
    }
  }

  return {
    async ping() {
      const sql = 'SELECT 1 AS ok, currentUser() AS user, version() AS version'
      let r = await send(sql, CONNECT_TIMEOUT_MS)
      if (!r.ok && r.kind === 'readonly_setting') {
        useTimeLimit = false
        r = await send(sql, CONNECT_TIMEOUT_MS)
      }
      return { ...r, serverTimeLimit: useTimeLimit }
    },
    query(sql) {
      return send(sql, QUERY_TIMEOUT_MS)
    },
  }
}

function printRows(rows, columns) {
  if (rows.length === 0) {
    out('  (0 行)')
    return
  }
  const cols = columns ?? Object.keys(rows[0])
  const cell = (v) => (v === null || v === undefined ? '' : String(v))
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  out(`  ${cols.map((c, i) => c.padEnd(widths[i])).join('  ')}`)
  out(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`)
  for (const r of rows) {
    out(`  ${cols.map((c, i) => cell(r[c]).padEnd(widths[i])).join('  ')}`)
  }
}

function describeFailure(result) {
  const labels = {
    unknown_table: '表が存在しません',
    access_denied: 'このユーザーに読み取り権限がありません',
    auth_failed: '認証に失敗しました',
    memory_limit: 'メモリ上限を超えました',
    timeout: 'サーバー側の時間制限を超えました',
    connect_timeout: '接続がタイムアウトしました (接続元の制限の可能性)',
    connect_failed: '接続できませんでした',
    readonly_setting: '読み取り専用のため設定を変更できません',
  }
  return `${labels[result.kind] ?? '失敗'} — ${result.message}`
}

async function section(report, runner, key, title, sql, columns) {
  out()
  out(`■ ${title}`)
  const result = await runner.query(sql)
  report[key] = result.ok ? { ok: true, rows: result.rows } : { ok: false, kind: result.kind, message: result.message }
  if (result.ok) printRows(result.rows, columns)
  else out(`  ${describeFailure(result)}`)
  return result
}

async function checkFusionTables(report, runner) {
  out()
  out('■ 1. 構造データの5表 (有無と行数)')
  const rows = []
  for (const table of FUSION_TABLES) {
    const r = await runner.query(`SELECT count() AS n FROM ${DATABASE}.${table}`)
    let status
    if (r.ok) status = `あり (${r.rows[0]?.n ?? 0} 行)`
    else if (r.kind === 'unknown_table') status = '未作成'
    else if (r.kind === 'access_denied') status = '権限なし (表の有無は不明)'
    else status = `確認失敗: ${r.kind}`
    rows.push({ table, status })
  }
  report.fusion_tables = { ok: true, rows }
  printRows(rows)
}

async function runStage1Checks(report, runner, days) {
  await checkFusionTables(report, runner)

  await section(
    report,
    runner,
    'crawl_runs',
    '1. crawl_runs (サイト別の取り込み状況)',
    `SELECT tenant_id, site_id, uniqExact(crawl_id) AS crawls, count() AS rows,
            max(crawled_at) AS last_crawled, max(ingested_at) AS last_ingested, max(page_count) AS max_pages
     FROM ${DATABASE}.crawl_runs
     GROUP BY tenant_id, site_id
     ORDER BY site_id
     LIMIT 100`,
  )

  await section(
    report,
    runner,
    'issue_totals',
    '5. page_issues (サイト別の件数と重複)',
    `SELECT site_id, count() AS rows,
            uniqExact(crawl_id, page_url, issue_type, selector, cityHash64(evidence)) AS distinct_rows,
            uniqExact(crawl_id) AS crawls, uniqExact(page_url) AS pages,
            min(detected_at) AS first_detected, max(detected_at) AS last_detected
     FROM ${DATABASE}.page_issues
     GROUP BY site_id
     ORDER BY rows DESC
     LIMIT 100`,
  )
  out('  ※ rows が distinct_rows より多ければ、同じ課題が重複して取り込まれている。')

  await section(
    report,
    runner,
    'issue_types',
    '5. page_issues (課題の種類の上位100)',
    `SELECT issue_type, issue_category, severity, count() AS rows, uniqExact(page_url) AS pages,
            uniqExact(site_id) AS sites, countIf(selector != '') AS with_selector
     FROM ${DATABASE}.page_issues
     GROUP BY issue_type, issue_category, severity
     ORDER BY rows DESC
     LIMIT 100`,
  )

  await section(
    report,
    runner,
    'cv_by_site',
    `6. CV 件数 (直近 ${days} 日、サイト別)`,
    `SELECT site_id,
            uniqIf(session_id, event_type = 'pageview') AS pv_sessions,
            countIf(event_type = 'pageview') AS pageviews,
            countIf(ifNull(conversion_type, '') != '') AS cv_events,
            uniqIf(session_id, ifNull(conversion_type, '') != '') AS cv_sessions
     FROM ${DATABASE}.events
     WHERE timestamp >= now() - INTERVAL ${days} DAY
     GROUP BY site_id
     ORDER BY pv_sessions DESC
     LIMIT 50`,
  )
  out('  ※ conversion_type が付いた行だけを数えている。管理画面のCV定義 (クリック条件など) による CV は含まない。')

  await section(
    report,
    runner,
    'cv_types',
    `6. CV の種類 (直近 ${days} 日)`,
    `SELECT site_id, ifNull(conversion_type, '') AS conversion_type, count() AS events, uniq(session_id) AS sessions
     FROM ${DATABASE}.events
     WHERE timestamp >= now() - INTERVAL ${days} DAY AND ifNull(conversion_type, '') != ''
     GROUP BY site_id, conversion_type
     ORDER BY events DESC
     LIMIT 60`,
  )
}

async function runReviewChecks(report, runner, days) {
  await section(
    report,
    runner,
    'events_table',
    'R1. events の並び順・区切り・行数',
    `SELECT name, engine, sorting_key, partition_key, total_rows, formatReadableSize(total_bytes) AS size
     FROM system.tables
     WHERE database = '${DATABASE}' AND name = 'events'`,
  )

  const created = await runner.query(`SHOW CREATE TABLE ${DATABASE}.events`)
  out()
  out('■ R1. events の定義 (SHOW CREATE TABLE)')
  if (created.ok) {
    const statement = String(created.rows[0]?.statement ?? '')
    report.events_ddl = { ok: true, statement }
    out(statement.replace(/\\n/g, '\n').split('\n').map((l) => `  ${l}`).join('\n'))
  } else {
    report.events_ddl = { ok: false, kind: created.kind, message: created.message }
    out(`  ${describeFailure(created)}`)
  }

  await section(
    report,
    runner,
    'user_settings',
    'R2. 読み取りユーザーの設定 (メモリ上限など)',
    `SELECT name, value, changed
     FROM system.settings
     WHERE name IN ('readonly', 'max_memory_usage', 'max_execution_time',
                    'max_bytes_before_external_group_by', 'max_bytes_before_external_sort', 'async_insert')
     ORDER BY name`,
  )

  await section(
    report,
    runner,
    'coordinate_caps',
    `R3. 座標の上限張り付き (直近 ${days} 日)`,
    `SELECT max(scroll_y) AS max_scroll_y, max(click_y) AS max_click_y,
            countIf(scroll_y = 65535) AS scroll_y_at_cap, countIf(click_y = 65535) AS click_y_at_cap
     FROM ${DATABASE}.events
     WHERE timestamp >= now() - INTERVAL ${days} DAY`,
  )
  out('  ※ 最大値が 65535 に張り付いていれば、長いページで座標が壊れている。')

  await section(
    report,
    runner,
    'image_y',
    'R4. 画像の縦位置が0の割合 (image_visibility)',
    `SELECT count() AS rows, countIf(element_y = 0) AS zero_y,
            round(countIf(element_y = 0) / greatest(count(), 1), 3) AS zero_ratio
     FROM ${DATABASE}.image_visibility`,
  )

  await section(
    report,
    runner,
    'event_mix',
    `R5. イベント種別の内訳 (直近 ${days} 日、上位20)`,
    `SELECT event_type, count() AS rows, uniq(session_id) AS sessions
     FROM ${DATABASE}.events
     WHERE timestamp >= now() - INTERVAL ${days} DAY
     GROUP BY event_type
     ORDER BY rows DESC
     LIMIT 20`,
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    out('使い方: node scripts/fusion-precheck.mjs [--env-file <path>] [--days 30] [--review] [--json <path>]')
    return 0
  }

  const env = { ...process.env, ...(args.envFile ? loadEnvFile(args.envFile) : {}) }
  const connection = resolveConnection(env)
  const runner = createRunner(connection)
  const report = { generated_at: new Date().toISOString(), days: args.days }

  out('行動×構造の突合 段階1 着手前の確認 (読み取り専用)')
  out(`パスワードの取得元: ${connection.passwordSource}`)

  out()
  out('■ 接続')
  const ping = await runner.ping()
  if (!ping.ok) {
    out(`  ${describeFailure(ping)}`)
    out('  許可された接続元で実行しているか確認してください。')
    return 1
  }
  report.connection = { user: ping.rows[0]?.user, version: ping.rows[0]?.version }
  out(`  接続できました (ユーザー: ${ping.rows[0]?.user}, バージョン: ${ping.rows[0]?.version})`)
  if (!ping.serverTimeLimit) out('  ※ サーバー側の時間制限は付けられませんでした (読み取り専用のため)。')

  await runStage1Checks(report, runner, args.days)
  if (args.review) await runReviewChecks(report, runner, args.days)

  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    out()
    out(`結果を保存しました: ${args.json}`)
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  })
