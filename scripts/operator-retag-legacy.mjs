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

/**
 * テーブルの未完了 mutation 数を返す。
 */
async function pendingMutations(table) {
  const m = await rows(
    `SELECT count() AS p FROM system.mutations
      WHERE database='clickinsight' AND table={table:String} AND is_done=0`,
    { table },
  )
  return Number(m[0]?.p ?? 0)
}

/**
 * mutation 完了をポーリング待ち (HTTP 長時間接続を持たない = timeout 無縁)。
 * 5 秒間隔で進捗ドット表示。上限 60 分 (超えても server 側では継続)。
 */
async function waitMutationDone(table, timeoutMs = 60 * 60 * 1000) {
  const t0 = Date.now()
  for (;;) {
    if ((await pendingMutations(table)) === 0) return
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('mutation 待ち時間超過 (server 側では継続中 — 後で dry-run で確認可)')
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 5000))
  }
}

/**
 * 1 テーブルの再タグ実行。
 *   1. 既存 mutation が進行中なら先に完了を待つ (前回 run の続き)
 *   2. 残行があれば ALTER UPDATE を **非同期 submit** (mutations_sync=0) → ポーリング待ち
 *   3. tenant_id が主キー列で UPDATE 不可 (code 420) のテーブルは
 *      INSERT ... SELECT * REPLACE (新tenant) + ALTER DELETE (旧行) 方式に自動フォールバック
 */
async function retagTable(table) {
  // 前回 run の mutation がまだ走っていれば待つ
  if ((await pendingMutations(table)) > 0) {
    process.stdout.write(' (前回の mutation 進行中 — 完了待ち)')
    await waitMutationDone(table)
  }
  // 残行再確認 (前回分で消えていれば何もしない)
  const cnt = await rows(
    `SELECT count() AS n FROM clickinsight.{table:Identifier}
      WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
    { table, from: FROM_TENANT, sites: SITE_IDS },
  )
  if (Number(cnt[0]?.n ?? 0) === 0) return

  const queryParams = { table, to: TO_TENANT, from: FROM_TENANT, sites: SITE_IDS }
  try {
    await client.command({
      query: `ALTER TABLE clickinsight.{table:Identifier}
                UPDATE tenant_id = {to:String}
                WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
      query_params: queryParams,
      clickhouse_settings: { mutations_sync: '0' },
    })
    await waitMutationDone(table)
  } catch (e) {
    if (!String(e?.message ?? '').includes('Cannot UPDATE key column')) throw e
    // 主キー列フォールバック: 新 tenant で複製 → 旧 tenant 行を削除 (DELETE は key 列でも可)
    process.stdout.write(' (key列 → INSERT+DELETE 方式)')
    await client.command({
      query: `INSERT INTO clickinsight.{table:Identifier}
                SELECT * REPLACE ({to:String} AS tenant_id)
                FROM clickinsight.{table:Identifier}
                WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
      query_params: queryParams,
    })
    await client.command({
      query: `ALTER TABLE clickinsight.{table:Identifier}
                DELETE WHERE tenant_id = {from:String} AND site_id IN ({sites:Array(String)})`,
      query_params: queryParams,
      clickhouse_settings: { mutations_sync: '0' },
    })
    await waitMutationDone(table)
  }
}

async function main() {
  console.log(`mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN (安全・変更なし)'}`)
  console.log(`retag: tenant_id '${FROM_TENANT}' -> '${TO_TENANT}' (site_id ${SITE_IDS.length} 件)\n`)

  // 1) tenant_id + site_id を両方持つ **実テーブル** を動的発見 (REQ-SEC-119 と同じ方式)。
  //    MaterializedView オブジェクトは mutation 不可のため除外する (集計 MV のデータは
  //    TO 先の実テーブル (events_daily_by_dim 等) 側で再タグされる。TO 無し MV の内部
  //    `.inner.%` は派生集計なので対象外 — 今後のデータは正しい tenant で再生成される)。
  const tables = await rows(`
    SELECT name AS table FROM system.tables
    WHERE database = 'clickinsight'
      AND engine NOT IN ('MaterializedView', 'View')
      AND name NOT LIKE '.%'
      AND name IN (SELECT table FROM system.columns WHERE database='clickinsight' AND name='tenant_id')
      AND name IN (SELECT table FROM system.columns WHERE database='clickinsight' AND name='site_id')
    ORDER BY name
  `)

  let totalAffected = 0
  const failures = []
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
    process.stdout.write(`  * ${table}: ${n.toLocaleString()} 行を再タグ中`)
    const t0 = Date.now()
    try {
      await retagTable(table)
      console.log(` 完了 (${Math.round((Date.now() - t0) / 1000)}s)`)
    } catch (e) {
      // テーブル単位で失敗しても続行 (部分完了 → 再実行で残りだけ対象になる = 冪等)
      console.log(` ✗ 失敗: ${e.message?.split('\n')[0]?.slice(0, 120)}`)
      failures.push(table)
    }
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
    if (failures.length > 0) {
      console.log(`  ! 失敗テーブル: ${failures.join(', ')} — 再実行 (--execute) で残りだけ再試行できます`)
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
