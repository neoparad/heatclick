/**
 * Operator script (続127緊急): ClickHouse サーバのディスク解放。
 *
 * 事象 (2026-06-10): system データベース (診断ログ) が 26.81 GiB に肥大し、ディスク残 972 KiB。
 * NOT_ENOUGH_SPACE が 361万回発生 = **新規イベントの書き込みが失敗中** (計測データ喪失) +
 * 再タグ mutation も空き待ちで停止。
 *
 * 対処 (ビジネスデータ clickinsight.* には一切触れない):
 *   1. system の肥大ログテーブル (query_log / trace_log / metric_log 等) を TRUNCATE
 *   2. 再発防止: 同テーブルに TTL 7日 を設定 (古いログを自動削除)
 *
 * 実行 (Owner のみ):
 *   node scripts/operator-free-disk.mjs              # dry-run (サイズ一覧のみ)
 *   node scripts/operator-free-disk.mjs --execute    # TRUNCATE + TTL 設定
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@clickhouse/client'

const EXECUTE = process.argv.includes('--execute')

/** 安全に消せる system 診断ログ (標準的な ClickHouse 運用)。clickinsight は対象外。 */
const SYSTEM_LOG_TABLES = [
  'query_log',
  'query_thread_log',
  'trace_log',
  'metric_log',
  'asynchronous_metric_log',
  'text_log',
  'part_log',
  'processors_profile_log',
  'opentelemetry_span_log',
  'session_log',
  'error_log',
  'query_views_log',
  'asynchronous_insert_log',
  'backup_log',
  'blob_storage_log',
]

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (k) => env.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1].trim()
const client = createClient({
  url: get('CLICKHOUSE_URL'),
  username: get('CLICKHOUSE_USERNAME') || 'default',
  password: get('CLICKHOUSE_PASSWORD'),
  database: 'system',
  request_timeout: 120_000,
})

async function rows(sql, params = {}) {
  const rs = await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })
  return rs.json()
}

async function main() {
  console.log(`mode: ${EXECUTE ? 'EXECUTE (TRUNCATE + TTL設定)' : 'DRY-RUN (一覧のみ・変更なし)'}\n`)

  const sizes = await rows(`
    SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(bytes_on_disk) AS bytes
    FROM system.parts
    WHERE database = 'system' AND active
    GROUP BY table ORDER BY bytes DESC
  `)

  let freeable = 0
  for (const r of sizes) {
    const target = SYSTEM_LOG_TABLES.includes(r.table)
    if (target) freeable += Number(r.bytes)
    console.log(`  ${target ? '*' : '-'} system.${r.table}: ${r.size}${target ? ' (削除対象)' : ' (対象外)'}`)
  }
  console.log(`\n解放見込み: ${(freeable / 1024 ** 3).toFixed(2)} GiB`)

  if (!EXECUTE) {
    console.log('\n実行するには: node scripts/operator-free-disk.mjs --execute')
    await client.close()
    return
  }

  const existing = new Set(sizes.map((r) => r.table))
  for (const table of SYSTEM_LOG_TABLES) {
    if (!existing.has(table)) continue
    process.stdout.write(`  TRUNCATE system.${table} ...`)
    try {
      await client.command({ query: `TRUNCATE TABLE system.{t:Identifier}`, query_params: { t: table } })
      console.log(' 完了')
    } catch (e) {
      console.log(` ✗ ${e.message?.split('\n')[0]?.slice(0, 100)}`)
    }
  }

  // 再発防止: 7日 TTL (event_date 列を持つ標準ログテーブルに適用)
  console.log('\n再発防止 TTL (7日) 設定:')
  for (const table of SYSTEM_LOG_TABLES) {
    if (!existing.has(table)) continue
    process.stdout.write(`  TTL system.${table} ...`)
    try {
      await client.command({
        query: `ALTER TABLE system.{t:Identifier} MODIFY TTL event_date + INTERVAL 7 DAY`,
        query_params: { t: table },
      })
      console.log(' 完了')
    } catch (e) {
      console.log(` ✗ ${e.message?.split('\n')[0]?.slice(0, 100)}`)
    }
  }

  const disk = await rows(`SELECT formatReadableSize(free_space) AS free FROM system.disks WHERE name='default'`)
  console.log(`\nディスク残量: ${disk[0]?.free ?? '(不明)'}`)
  console.log('→ 空きができると、待機中の再タグ mutation は自動再開します (別ターミナルのドットが進みます)')
  await client.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message?.split('\n')[0])
  process.exit(1)
})
