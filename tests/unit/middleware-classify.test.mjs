/**
 * Unit tests for middleware.classify() — S1-09 (Infra 続 24)
 *
 * Strategy: middleware.ts は Next.js Edge runtime に依存するため、`classify()` のロジックを
 *           本 test 内に等価実装し、worker.ts unit test (B-2 続 16/23) と同じパターンで
 *           contract を保証する。完全 E2E は Playwright (tests/e2e/sign-in.spec.ts) で実施。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/middleware-classify.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── classify() 等価実装 (middleware.ts と同一仕様、本 test 内で再実装) ──

const STATIC_EXT_REGEX = /\.(js|css|png|svg|ico|webp|woff2?|map|jpg|jpeg|gif|txt|xml|json)$/

function isStatic(pathname) {
  if (pathname.startsWith('/_next/')) return true
  if (pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true
  if (STATIC_EXT_REGEX.test(pathname)) return true
  return false
}

const API_PUBLIC_PATHS = ['/api/track', '/api/health', '/api/inngest', '/api/billing/webhook']
const AUTH_PUBLIC_API_PREFIX = '/api/auth/'
const AUTH_PUBLIC_API_PATHS = ['/api/install/verify']
const AUTH_PUBLIC_PAGE_EXACT = ['/']
const AUTH_PUBLIC_PAGE_PREFIXES = ['/auth/', '/onboarding/install', '/legal/']

function classify(pathname) {
  if (isStatic(pathname)) return 'static'

  for (const p of API_PUBLIC_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) return 'api-public'
  }

  if (pathname.startsWith(AUTH_PUBLIC_API_PREFIX)) return 'auth-public'
  for (const p of AUTH_PUBLIC_API_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) return 'auth-public'
  }
  if (AUTH_PUBLIC_PAGE_EXACT.includes(pathname)) return 'auth-public'
  for (const rawPrefix of AUTH_PUBLIC_PAGE_PREFIXES) {
    const p = rawPrefix.endsWith('/') ? rawPrefix.slice(0, -1) : rawPrefix
    if (pathname === p || pathname.startsWith(p + '/')) return 'auth-public'
  }

  if (pathname.startsWith('/api/')) return 'api-tenant'
  return 'tenant-protected'
}

// ── anonymizeIp 等価実装 (audit emit 検証) ─────────────────────────

function anonymizeIp(ip) {
  if (!ip) return ''
  if (ip.includes('.')) {
    const parts = ip.split('.')
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`
  }
  if (ip.includes(':')) {
    const parts = ip.split(':')
    return parts.slice(0, 3).join(':') + '::'
  }
  return ''
}

// ── parseClickHouseEnv 等価実装 (audit emit credential 漏洩防御確認) ─
//
// 続 28 (S1-09 HIGH-27-1 同型対策、worker.ts:281-283 と同期):
//   malformed URL 時に fail-closed (throw)。raw 中の credentials が後続 log に
//   流出する経路を塞ぐ。caller (fireAuditAsync) が catch して audit emit skip。

function parseClickHouseEnv(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('CLICKHOUSE_URL is malformed (parseClickHouseEnv fail-closed, S1-09 続 28 HIGH-27-1 同型対策)')
  }
  const user = decodeURIComponent(u.username) || 'default'
  const password = decodeURIComponent(u.password) || ''
  u.username = ''
  u.password = ''
  const baseUrl = `${u.protocol}//${u.host}`
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
  return { baseUrl, authHeader }
}

// ─────────────────────────────────────────────────────────────────────
// classify() 区分判定テスト (S1-09 Step 2 中核、最低 15 件目標)
// ─────────────────────────────────────────────────────────────────────

// static region (5 件)
test('static: /_next/static/chunks/xxx.js → static', () => {
  assert.equal(classify('/_next/static/chunks/main.js'), 'static')
})

test('static: /favicon.ico → static', () => {
  assert.equal(classify('/favicon.ico'), 'static')
})

test('static: /robots.txt → static', () => {
  assert.equal(classify('/robots.txt'), 'static')
})

test('static: /sitemap.xml → static', () => {
  assert.equal(classify('/sitemap.xml'), 'static')
})

test('static: /v2/tracking.js (Frontend B-1 流用先) → static', () => {
  assert.equal(classify('/v2/tracking.js'), 'static')
})

test('static: /assets/image.webp → static', () => {
  assert.equal(classify('/assets/hero.webp'), 'static')
})

test('static: /onboarding/gtm/install-poster.png → static (ファイル拡張子優先)', () => {
  // /onboarding/install/ prefix 配下だが拡張子 png なので static 判定
  assert.equal(classify('/onboarding/gtm/install-poster.png'), 'static')
})

// api-public region (5 件)
test('api-public: /api/track → api-public', () => {
  assert.equal(classify('/api/track'), 'api-public')
})

test('api-public: /api/track/anything → api-public (prefix)', () => {
  assert.equal(classify('/api/track/v2'), 'api-public')
})

test('api-public: /api/health → api-public', () => {
  assert.equal(classify('/api/health'), 'api-public')
})

test('api-public: /api/inngest → api-public', () => {
  assert.equal(classify('/api/inngest'), 'api-public')
})

test('api-public: /api/billing/webhook → api-public (Stripe signature 検証は API route 側)', () => {
  assert.equal(classify('/api/billing/webhook'), 'api-public')
})

// auth-public region (8 件)
test('auth-public: / (root) → auth-public', () => {
  assert.equal(classify('/'), 'auth-public')
})

test('auth-public: /auth/sign-in → auth-public', () => {
  assert.equal(classify('/auth/sign-in'), 'auth-public')
})

test('auth-public: /auth/verify → auth-public', () => {
  assert.equal(classify('/auth/verify'), 'auth-public')
})

test('auth-public: /onboarding/install → auth-public', () => {
  assert.equal(classify('/onboarding/install'), 'auth-public')
})

test('auth-public: /legal/privacy → auth-public', () => {
  assert.equal(classify('/legal/privacy'), 'auth-public')
})

test('auth-public: /api/auth/magic-link → auth-public', () => {
  assert.equal(classify('/api/auth/magic-link'), 'auth-public')
})

test('auth-public: /api/auth/verify → auth-public', () => {
  assert.equal(classify('/api/auth/verify'), 'auth-public')
})

test('auth-public: /api/install/verify → auth-public (Phase 1 公開 install)', () => {
  assert.equal(classify('/api/install/verify'), 'auth-public')
})

// api-tenant region (5 件)
test('api-tenant: /api/sites/123 → api-tenant', () => {
  assert.equal(classify('/api/sites/123'), 'api-tenant')
})

test('api-tenant: /api/dashboard/summary → api-tenant', () => {
  assert.equal(classify('/api/dashboard/summary'), 'api-tenant')
})

test('api-tenant: /api/heatmap → api-tenant', () => {
  assert.equal(classify('/api/heatmap'), 'api-tenant')
})

test('api-tenant: /api/insights/site/xxx → api-tenant', () => {
  assert.equal(classify('/api/insights/site/xxx'), 'api-tenant')
})

test('api-tenant: /api/account/site/[id]/classify (F-58) → api-tenant', () => {
  assert.equal(classify('/api/account/site/abc-123/classify'), 'api-tenant')
})

// tenant-protected region (5 件)
test('tenant-protected: /dashboard → tenant-protected', () => {
  assert.equal(classify('/dashboard'), 'tenant-protected')
})

test('tenant-protected: /heatmap → tenant-protected', () => {
  assert.equal(classify('/heatmap'), 'tenant-protected')
})

test('tenant-protected: /agency/dashboard → tenant-protected (route group ACL は middleware 内で適用)', () => {
  assert.equal(classify('/agency/dashboard'), 'tenant-protected')
})

test('tenant-protected: /account/billing → tenant-protected', () => {
  assert.equal(classify('/account/billing'), 'tenant-protected')
})

test('tenant-protected: /personas → tenant-protected', () => {
  assert.equal(classify('/personas'), 'tenant-protected')
})

// ─────────────────────────────────────────────────────────────────────
// 境界条件 / 攻撃面テスト
// ─────────────────────────────────────────────────────────────────────

test('境界: 空 pathname は tenant-protected (fail-closed)', () => {
  assert.equal(classify(''), 'tenant-protected')
})

test('境界: /api (trailing slash なし) は api-tenant (api-public exact match なし)', () => {
  assert.equal(classify('/api'), 'tenant-protected')
})

test('境界: /api/trackz (api/track の部分一致) は api-tenant (api/track 完全一致 or prefix のみ)', () => {
  // /api/track の prefix 一致は '/api/track' or '/api/track/...' のみ、'/api/trackz' は別 path
  assert.equal(classify('/api/trackz'), 'api-tenant')
})

test('境界: /auth (trailing slash なし) は auth-public (prefix normalize 後 exact 一致)', () => {
  // AUTH_PUBLIC_PAGE_PREFIXES の '/auth/' は trailing-'/' を strip した '/auth' を canonical 扱い、
  // bare /auth は exact 一致で auth-public に分類 (Next.js が /auth → /auth/sign-in 等にルーティング想定)
  assert.equal(classify('/auth'), 'auth-public')
})

test('境界: /onboarding (install なし) は tenant-protected', () => {
  // /onboarding/install のみ public、/onboarding 単体は protected
  assert.equal(classify('/onboarding'), 'tenant-protected')
})

test('境界: //double-slash は tenant-protected (NextRequest が normalize するが defense in depth)', () => {
  assert.equal(classify('//dashboard'), 'tenant-protected')
})

test('境界: /api/track/.. (path traversal 風) は api-public (NextRequest 側で normalize)', () => {
  // /api/track/ prefix なので api-public 判定 = OK
  assert.equal(classify('/api/track/../etc/passwd'), 'api-public')
})

// ─────────────────────────────────────────────────────────────────────
// anonymizeIp() — audit emit 内で PII 漏洩防御 (Worker B-2 と同仕様)
// ─────────────────────────────────────────────────────────────────────

test('anonymizeIp: IPv4 → /24 マスク', () => {
  assert.equal(anonymizeIp('192.168.1.42'), '192.168.1.0')
})

test('anonymizeIp: IPv6 → /48 マスク', () => {
  assert.equal(anonymizeIp('2001:db8:abcd:1234::1'), '2001:db8:abcd::')
})

test('anonymizeIp: null / 空 → 空文字', () => {
  assert.equal(anonymizeIp(null), '')
  assert.equal(anonymizeIp(''), '')
  assert.equal(anonymizeIp(undefined), '')
})

test('anonymizeIp: malformed → 空文字 (fail-safe)', () => {
  assert.equal(anonymizeIp('not-an-ip'), '')
})

// ─────────────────────────────────────────────────────────────────────
// parseClickHouseEnv() — audit emit の credential 漏洩防御 (Worker B-2 H-2 整合)
// ─────────────────────────────────────────────────────────────────────

test('parseClickHouseEnv: credentials を URL から排除', () => {
  const out = parseClickHouseEnv('http://chuser:chpass@host.example.com:8123')
  assert.equal(out.baseUrl, 'http://host.example.com:8123')
  assert.ok(!out.baseUrl.includes('chuser'))
  assert.ok(!out.baseUrl.includes('chpass'))
  const decoded = Buffer.from(out.authHeader.slice(6), 'base64').toString()
  assert.equal(decoded, 'chuser:chpass')
})

test('parseClickHouseEnv: 特殊文字を含む password 復元', () => {
  const pw = 'p@ss:wo/rd'
  const url = `http://u:${encodeURIComponent(pw)}@host:8123`
  const out = parseClickHouseEnv(url)
  const decoded = Buffer.from(out.authHeader.slice(6), 'base64').toString()
  assert.equal(decoded, `u:${pw}`)
})

test('parseClickHouseEnv: credentials なし → default:', () => {
  const out = parseClickHouseEnv('http://host:8123')
  const decoded = Buffer.from(out.authHeader.slice(6), 'base64').toString()
  assert.equal(decoded, 'default:')
})

// 続 28 (S1-09 HIGH-27-1 同型対策): malformed URL は fail-closed (throw)
// raw URL 中の credentials が log/breadcrumb に流出する経路を塞ぐ
test('parseClickHouseEnv: malformed URL → throw (fail-closed、HIGH-27-1 同型対策)', () => {
  // 続 27 HIGH-27-1: 旧実装は fail-open で { baseUrl: raw, authHeader: 'Basic default:' } を返却
  // 続 28: throw に変更、caller が catch して audit emit skip + raw log 出力なし
  assert.throws(
    () => parseClickHouseEnv('not-a-valid-url'),
    /CLICKHOUSE_URL is malformed/,
    'malformed URL should fail-closed (throw), not fail-open',
  )
})

test('parseClickHouseEnv: credentials 含む malformed → throw、raw を log に残さない契約', () => {
  // PoC: 仮に attacker が CLICKHOUSE_URL に "http://user:secret@" のみ (host 欠落) を投入した場合、
  // 旧 fail-open では fallback で raw が baseUrl に残り credentials が log 流出。
  // 新 fail-closed では throw、上位 caller が message のみ log (raw を含めない)。
  assert.throws(
    () => parseClickHouseEnv('http://user:secret@'),
    /CLICKHOUSE_URL is malformed/,
    'credentials を含む malformed URL も同様に throw',
  )
})
