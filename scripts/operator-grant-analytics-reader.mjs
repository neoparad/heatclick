/**
 * Operator script (続130): analytics_reader の不足 grant + user-level メモリ防御。
 *
 * 背景 (2026-06-12 query_log 実証):
 *   1. analytics_reader に clickinsight.image_visibility の SELECT grant が無く、
 *      /api/heatmap/elements が 497 → 502 で全滅 (画像ホバー/要素カード/構造タブ巻き添え)。
 *      ※ コード側は 続130 で「個別 degrade」に直したが、画像ホバー機能の解放には grant が必要。
 *   2. analytics_reader は readonly=1 のため per-query max_memory_usage が HTTP 層で拒否される。
 *      メモリ防御は user-level (ALTER USER ... SETTINGS) で行うのが正解 (ここで適用)。
 *
 * 実行 (Owner のみ。GRANT/ALTER USER は権限変更 = Owner 実行が本プロジェクトのルール):
 *   node scripts/operator-grant-analytics-reader.mjs              # dry-run (現状表示のみ)
 *   node scripts/operator-grant-analytics-reader.mjs --execute    # GRANT + ALTER USER 適用
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

/** analytics_reader が SELECT を持つべきテーブル (heatmap/AIチャットの参照面) */
const REQUIRED_TABLES = [
  'image_visibility', // 続126 画像ホバー (今回の欠落)
  'element_visibility_v2',
  'scroll_timeline',
  'form_interactions',
  'web_vitals',
  'video_events',
  'behavior_signals',
]

async function rows(sql) {
  return (await client.query({ query: sql, format: 'JSONEachRow' })).json()
}

async function main() {
  console.log(`mode: ${EXECUTE ? 'EXECUTE (GRANT + ALTER USER)' : 'DRY-RUN (現状表示のみ)'}\n`)

  // 現状 grant の確認
  const grants = await rows(
    `SELECT access_type, table FROM system.grants WHERE user_name = 'analytics_reader' AND database = 'clickinsight'`,
  )
  const granted = new Set(grants.filter((g) => g.access_type === 'SELECT').map((g) => g.table))
  // table=null は database 全体 grant
  const hasDbWide = grants.some((g) => g.access_type === 'SELECT' && g.table === null)
  console.log(`現状: SELECT grant ${hasDbWide ? '(database 全体)' : `対象 ${granted.size} テーブル`}`)

  const missing = hasDbWide ? [] : REQUIRED_TABLES.filter((t) => !granted.has(t))
  for (const t of REQUIRED_TABLES) {
    const ok = hasDbWide || granted.has(t)
    console.log(`  ${ok ? '✓' : '✗'} clickinsight.${t}${ok ? '' : ' ← GRANT 必要'}`)
  }

  // user-level メモリ設定の現状
  const settings = await rows(
    `SELECT setting_name, value FROM system.settings_profile_elements WHERE user_name = 'analytics_reader' AND setting_name = 'max_memory_usage'`,
  )
  const hasMemCap = settings.length > 0
  console.log(`\nuser-level max_memory_usage: ${hasMemCap ? settings[0].value : '未設定 ← 適用推奨 (2GB)'}`)

  if (!EXECUTE) {
    console.log('\n適用するには: node scripts/operator-grant-analytics-reader.mjs --execute')
    await client.close()
    return
  }

  for (const t of missing) {
    process.stdout.write(`GRANT SELECT ON clickinsight.${t} TO analytics_reader ...`)
    try {
      await client.command({ query: `GRANT SELECT ON clickinsight.${t} TO analytics_reader` })
      console.log(' 完了')
    } catch (e) {
      console.log(` ✗ ${e.message?.split('\n')[0]?.slice(0, 120)}`)
    }
  }

  if (!hasMemCap) {
    process.stdout.write(`ALTER USER analytics_reader SETTINGS max_memory_usage = 2000000000 ...`)
    try {
      // 既存 user-level settings (readonly=1 等) を保持したまま追記する形:
      // ClickHouse の ALTER USER ... SETTINGS は指定 setting を追加/更新する (他は維持)。
      await client.command({
        query: `ALTER USER analytics_reader SETTINGS max_memory_usage = 2000000000`,
      })
      console.log(' 完了 (heatmap/チャットの1クエリがサーバ全体を巻き込めなくなる)')
    } catch (e) {
      console.log(` ✗ ${e.message?.split('\n')[0]?.slice(0, 120)}`)
    }
  }

  console.log('\n✓ 完了。アプリ側の再デプロイは不要 (権限は即時反映)。ヒートマップをリロードして確認。')
  await client.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message?.split('\n')[0])
  process.exit(1)
})
