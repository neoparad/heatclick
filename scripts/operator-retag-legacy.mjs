/**
 * Operator script (続126): `__legacy__` テナント行を `linkth_internal` に再タグする。
 *
 * 背景: GTM の旧 tracking.js が tenant_id='__legacy__' でイベントを送っていた期間があり、
 * bihadashop 等 5 dogfood サイトの行動データの約 2/3 が現テナントから見えない
 * (heatmap / 画像視認率 / AI チャットの精度を直撃)。本スクリプトで site_id 基準に再タグする。
 *
 * 安全設計:
 *   - 既定は **dry-run**: 対象テーブルと件数を表示するだけ。何も変更しない。
 *   - `--execute` を付けたときだけ ALTER TABLE ... UPDATE (mutations_sync=2 で同期完了待ち)。
 *   - 対象は「tenant_id 列 + site_id 列を両方持つテーブル」を system.columns から動的に発見。
 *   - 逆方向 (`--rollback`) も用意 (linkth_internal → __legacy__、同条件)。
 *
 * 実行 (Owner のみ。AI は実行しない — destructive 系は Owner 実行が本プロジェクトのルール):
 *   node scripts/operator-retag-legacy.mjs              # dry-run (安全)
 *   node scripts/operator-retag-legacy.mjs --execute    # 実行
 *   node scripts/operator-retag-legacy.mjs --rollback   # 巻き戻し
 *
 * 注意: mutation 実行中はテーブルごとに数秒〜数分かかる。低トラフィック時間帯推奨。
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@clickhouse/client'

const FROM_TENANT = process.argv.includes('--rollback') ? 'linkth_internal' : '__legacy__'
const TO_TENANT = process.argv.includes('--rollback') ? '__legacy__' : 'linkth_internal'
const EXECUTE = process.argv.includes('--execute') || process.argv.includes('--rollback')

/** linkth_internal の 5 dogfood サイト (lib/auth/dogfood-users.ts と一致させること) */
const SITE_IDS = [
  'CIP_EcwUTHEZdIOAUqum', // bihadashop.jp
  'CIP_xginf3nVacnkn62o',
  'CIP_6r2WofQDSKrOwxmM',
  'CIP_8eN7xgfBtDAnzE26',
  'CIP_QWaPiks5krukJ6NM', // wakegai.jp (※将来 tnt_wakegai へ移行予定 — その際は除外すること)
]

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (k) => env.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1].trim()
const client = createClient({
  url: get('CLICKHOUSE_URL'),
  username: get('CLICKHOUSE_USERNAME') || 'default',
  password: get('CLICKHOUSE_PASSWORD'),
  database: get('CLICKHOUSE_DB') || 'clickinsight',
  request_timeout: 600_000,
  clickhouse_settings: { mutations_sync: '2' },
})

async function rows(sql, params = {}) {
  const rs = await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })
  return rs.json()
}

async function main() {
  console.log(`mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN (安全・変更なし)'}`)
  console.log(`retag: tenant_id '${FROM_TENANT}' -> '${TO_TENANT}' (site_id ${SITE_IDS.length} 件)\n`)

  // 1) tenant_id + site_id を両方持つテーブルを動的発見 (REQ-SEC-119 と同じ方式)
  const tables = await rows(`
    SELECT table FROM system.columns
    WHERE database = 'clickinsight' AND name = 'tenant_id'
      AND table IN (SELECT table FROM system.columns WHERE database='clickinsight' AND name='site_id')
      AND table NOT LIKE '.%'
    GROUP BY table ORDER BY table
  `)

  let totalAffected = 0
  for (const { table } of tables) {
    const cnt = await rows(
      `SELECT count() AS n FROM clickinsight.{table:Identifier}
        WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
      { table, from: FROM_TENANT, sites: SITE_IDS },
    )
    const n = Number(cnt[0]?.n ?? 0)
    if (n === 0) {
      console.log(`  - ${table}: 0 行 (skip)`)
      continue
    }
    totalAffected += n
    if (!EXECUTE) {
      console.log(`  * ${table}: ${n.toLocaleString()} 行が対象 (dry-run)`)
      continue
    }
    process.stdout.write(`  * ${table}: ${n.toLocaleString()} 行を再タグ中...`)
    const t0 = Date.now()
    await client.command({
      query: `ALTER TABLE clickinsight.{table:Identifier}
                UPDATE tenant_id = {to:String}
                WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
      query_params: { table, to: TO_TENANT, from: FROM_TENANT, sites: SITE_IDS },
      clickhouse_settings: { mutations_sync: '2' },
    })
    console.log(` 完了 (${Math.round((Date.now() - t0) / 1000)}s)`)
  }

  console.log(`\n合計対象: ${totalAffected.toLocaleString()} 行`)

  if (EXECUTE) {
    // 2) 検証: 残留ゼロ確認
    console.log('\n検証 (残留チェック):')
    let leftover = 0
    for (const { table } of tables) {
      const cnt = await rows(
        `SELECT count() AS n FROM clickinsight.{table:Identifier}
          WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
        { table, from: FROM_TENANT, sites: SITE_IDS },
      )
      const n = Number(cnt[0]?.n ?? 0)
      if (n > 0) {
        leftover += n
        console.log(`  ! ${table}: ${n} 行 残留`)
      }
    }
    console.log(leftover === 0 ? '  ✓ 全テーブル残留ゼロ — 再タグ完了' : `  ✗ 残留 ${leftover} 行 — mutation を確認してください`)
  } else {
    console.log('\n実行するには: node scripts/operator-retag-legacy.mjs --execute')
  }
  await client.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message?.split('\n')[0])
  process.exit(1)
})
