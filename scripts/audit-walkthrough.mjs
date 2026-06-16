/**
 * 続131 総点検: ローカル実走査 (API 総当たり + Playwright 実画面スクショ採取)。
 * secret/cookie 値は一切 stdout に出さない。使用後削除。
 *
 * 前提: `npm run dev` が localhost:3000 で稼働中。
 * 出力: stdout (機械可読サマリ) + _tmp_audit/*.png (実画面)
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = 'http://localhost:3010'
function readEnvFile(name) {
  try {
    return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}
// .env.development.local (監査用の使い捨て secret) を優先、無ければ .env.local
const envDev = readEnvFile('.env.development.local')
const env = readEnvFile('.env.local')
const get = (k) =>
  envDev.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1].trim() ??
  env.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1].trim()
const SECRET = get('OWNER_LOGIN_SECRET')
const EMAIL = 'hiroki101313@gmail.com'
const SITE = 'CIP_EcwUTHEZdIOAUqum'
const PAGE_URL = 'https://bihadashop.jp/entry/tirtir-cushion-foundation'

if (!SECRET) {
  console.error('OWNER_LOGIN_SECRET が .env.local に無い — dev-login 不可')
  process.exit(1)
}

mkdirSync(new URL('../_tmp_audit/', import.meta.url), { recursive: true })

// ── 1) dev-login で session cookie 取得 (値は出力しない) ──
const loginRes = await fetch(`${BASE}/api/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret: SECRET }),
})
console.log(`LOGIN: HTTP ${loginRes.status}`)
if (!loginRes.ok) {
  console.error('login failed — 以降中止')
  process.exit(1)
}
const setCookie = loginRes.headers.get('set-cookie') ?? ''
const cookiePair = setCookie.split(';')[0] // name=value
const cookieName = cookiePair.split('=')[0]
const cookieValue = cookiePair.slice(cookieName.length + 1)

// ── 2) API 総当たり (tile 各レイヤー + elements) ──
async function api(label, path) {
  try {
    const t0 = Date.now()
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookiePair } })
    const ms = Date.now() - t0
    let body = null
    try { body = await res.json() } catch { /* non-json */ }
    return { label, status: res.status, ms, body }
  } catch (e) {
    return { label, status: 0, ms: -1, body: null, err: e.message?.split('\n')[0] }
  }
}

const qs = (layer) =>
  `/api/heatmap?site_id=${SITE}&page_url=${encodeURIComponent(PAGE_URL)}&heatmap_type=${layer}&device_type=`
console.log('\n== TILE API (全レイヤー / 全デバイス) ==')
for (const layer of ['click', 'read', 'scroll', 'exit']) {
  for (const dev of ['', 'desktop', 'mobile']) {
    const r = await api(`${layer}/${dev || 'all'}`, qs(layer) + dev)
    const tile = r.body?.data?.tiles?.[0]
    const meta = r.body?.meta
    console.log(
      `${r.label}: HTTP ${r.status} ${r.ms}ms src=${meta?.data_source ?? '?'} tiles=${r.body?.data?.tiles?.length ?? '?'} pts(first)=${tile?.points?.length ?? '?'} next=${r.body?.data?.next_cursor ? 'yes' : 'null'}${r.err ? ' ERR=' + r.err : ''}`,
    )
  }
}

console.log('\n== ELEMENTS API ==')
{
  const r = await api(
    'elements',
    `/api/heatmap/elements?site_id=${SITE}&page_url=${encodeURIComponent(PAGE_URL)}`,
  )
  const d = r.body?.data
  console.log(
    `elements: HTTP ${r.status} ${r.ms}ms page_sessions=${d?.page_sessions ?? '?'} elements=${d?.elements?.length ?? '?'} signals=${d?.signals?.map((s) => `${s.type}:${s.count}`).join(',') ?? '?'} images=${d?.images?.length ?? '?'} issues=${d?.issues?.length ?? '?'}`,
  )
}

// ── 3) Playwright 実画面走査 ──
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } })
await ctx.addCookies([
  { name: cookieName, value: cookieValue, url: BASE },
])
const page = await ctx.newPage()

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    consoleErrors.push(`[${m.type()}] ${m.text().slice(0, 180)}`)
  }
})
const badResponses = []
page.on('response', (res) => {
  if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url().replace(BASE, '')}`.slice(0, 160))
})
page.on('requestfailed', (req) =>
  badResponses.push(`FAILED ${req.url().replace(BASE, '')} ${req.failure()?.errorText ?? ''}`.slice(0, 160)),
)

async function shot(name) {
  await page.screenshot({ path: new URL(`../_tmp_audit/${name}.png`, import.meta.url).pathname.replace(/^\//, ''), fullPage: false })
  console.log(`shot: ${name}`)
}
async function dumpStage(tag) {
  const data = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="hm-page"]')
    if (!el) return null
    const d = { ...el.dataset }
    delete d.testid
    return d
  })
  console.log(`stage[${tag}]: ${JSON.stringify(data)}`)
}

console.log('\n== PLAYWRIGHT 実画面 ==')
await page.goto(`${BASE}/heatmap`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
// 初回 next dev コンパイル + データ到着待ち
await page.waitForTimeout(20_000)
await shot('01-initial-click-pc')
await dumpStage('initial')

// レイヤー切替
for (const [key, name] of [
  ['attention', '02-read'],
  ['scroll', '03-scroll'],
  ['exit', '04-exit'],
]) {
  const btn = page.locator(`[data-testid="layer-toggle-${key}"]`)
  if (await btn.count()) {
    await btn.click()
    await page.waitForTimeout(8_000)
    await shot(name)
  } else {
    console.log(`layer toggle not found: ${key}`)
  }
}

// click に戻して SP デバイス
await page.locator('[data-testid="layer-toggle-click"]').click().catch(() => {})
await page.waitForTimeout(3_000)
const spTab = page.getByRole('button', { name: 'SP', exact: true }).first()
if (await spTab.count()) {
  await spTab.click()
  await page.waitForTimeout(12_000)
  await shot('05-click-sp')
  await dumpStage('sp')
}

// セグメント: 熟読層
const seg = page.locator('[data-testid="segment-chip-segment-deep_read"]')
if (await seg.count()) {
  await seg.click()
  await page.waitForTimeout(10_000)
  await shot('06-segment-deepread')
} else {
  console.log('segment chip not found')
}

// 右パネル: ネガティブ / 構造
for (const [label, name] of [
  ['ネガティブ', '07-tab-negative'],
  ['構造', '08-tab-structure'],
]) {
  const tab = page.getByRole('button', { name: label }).first()
  if (await tab.count()) {
    await tab.click()
    await page.waitForTimeout(2_000)
    await shot(name)
  } else {
    console.log(`side tab not found: ${label}`)
  }
}

console.log('\n== CONSOLE ERRORS/WARNINGS (重複除去, 上位15) ==')
for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.log(e)
console.log('\n== HTTP>=400 / FAILED (重複除去, 上位15) ==')
for (const e of [...new Set(badResponses)].slice(0, 15)) console.log(e)

await browser.close()
console.log('\nDONE')
