/**
 * Operator script (続127): 新規サイトのトラッキング発行 (provisioning)。
 *
 * やること (冪等):
 *   1. tracking_id (CIP_xxxx) を生成 — 既に同 URL の site 行があればその tracking_id を再利用
 *   2. ClickHouse `clickinsight.sites` に登録 (event-ingest Worker の resolveTenant がここを照合。
 *      未登録だとイベントが drop または __legacy__ 行きになる)
 *   3. Supabase `tenant_sites` に登録 (db モードの JWT site_ids はここから出る。
 *      未登録だと管理画面でサイトが見えない)
 *
 * 使い方:
 *   node scripts/operator-provision-site.mjs --url https://link-th.co.jp --name "LINKTH コーポレート"
 *
 * 終了時に貼り付け用スニペット (tracking + M-Agent banner) を出力する。
 */

import { readFileSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { createClient } from '@clickhouse/client'
import pg from 'pg'

const TENANT_ID = 'linkth_internal'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : null
}
const siteUrl = arg('url')
const siteName = arg('name')
if (!siteUrl || !siteName) {
  console.error('usage: node scripts/operator-provision-site.mjs --url https://example.com --name "サイト名"')
  process.exit(1)
}

/** CIP_ + 16 桁 [A-Za-z0-9] (既存 5 サイトと同形式) */
function generateTrackingId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(16)
  let s = ''
  for (let i = 0; i < 16; i++) s += alphabet[bytes[i] % alphabet.length]
  return `CIP_${s}`
}

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (k) => env.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1].trim()

const ch = createClient({
  url: get('CLICKHOUSE_URL'),
  username: get('CLICKHOUSE_USERNAME') || 'default',
  password: get('CLICKHOUSE_PASSWORD'),
  database: get('CLICKHOUSE_DB') || 'clickinsight',
  request_timeout: 30_000,
})

async function main() {
  // 1) 既存チェック (同 URL) — あれば再利用 (冪等)
  const existing = await (
    await ch.query({
      query: `SELECT tracking_id FROM sites WHERE url = {u:String} ORDER BY created_at DESC LIMIT 1`,
      query_params: { u: siteUrl },
      format: 'JSONEachRow',
    })
  ).json()

  let trackingId
  if (existing.length > 0) {
    trackingId = existing[0].tracking_id
    console.log(`既存登録を再利用: ${trackingId} (${siteUrl})`)
  } else {
    trackingId = generateTrackingId()
    await ch.insert({
      table: 'sites',
      values: [
        {
          id: randomUUID(),
          name: siteName,
          url: siteUrl,
          tracking_id: trackingId,
          status: 'active',
          tenant_id: TENANT_ID,
          user_id: null,
          org_id: null,
          ga4_property_id: null,
        },
      ],
      format: 'JSONEachRow',
    })
    console.log(`ClickHouse sites 登録完了: ${trackingId} (${siteUrl}, tenant=${TENANT_ID})`)
  }
  await ch.close()

  // 2) Supabase tenant_sites (db モードの JWT site_ids 供給源)
  const authUrl = get('AUTH_DATABASE_URL')
  const ca = readFileSync(new URL('../lib/db/supabase-ca.ts', import.meta.url), 'utf8').match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  )?.[0]
  const pgc = new pg.Client({
    connectionString: authUrl,
    ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false },
  })
  await pgc.connect()
  await pgc.query(
    `INSERT INTO tenant_sites (tenant_id, site_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, site_id) DO NOTHING`,
    [TENANT_ID, trackingId],
  )
  await pgc.end()
  console.log(`Supabase tenant_sites 登録完了: (${TENANT_ID}, ${trackingId})`)

  // 3) 貼り付け用スニペット出力
  const origin = 'https://ugokimap-saas.vercel.app'
  console.log(`
──────────────────────────────────────────────
■ tracking_id: ${trackingId}

■ ① 計測タグ (</head> 直前 or GTM カスタムHTML):

<!-- UGOKI MAP Tracking -->
<script>
  window.CLICKINSIGHT_SITE_ID = '${trackingId}';
  window.CLICKINSIGHT_TENANT_ID = '${TENANT_ID}';
  window.CLICKINSIGHT_DEBUG = false;
</script>
<script src="${origin}/v2/tracking.js" async></script>

■ ② M-Agent ターゲティングバナー (①の直後に追加):

<script src="${origin}/scenario-runtime.js"
        data-site-id="${trackingId}"
        data-tenant-id="${TENANT_ID}"
        data-runtime-url="${origin}/api/scenarios/runtime"
        defer></script>

■ 残作業:
  1. lib/auth/dogfood-users.ts / seed-auth-registry.mjs の SITE_IDS に追加 (コード整合)
  2. 管理画面に出すには再ログインが必要 (JWT の site_ids 再発行)
──────────────────────────────────────────────`)
}

main().catch((e) => {
  console.error('FAILED:', e.message?.split('\n')[0])
  process.exit(1)
})
