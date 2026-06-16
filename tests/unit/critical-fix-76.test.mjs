/**
 * Unit tests for 続 76 critical fix (Task A/B/C/D/E)
 *
 * 検証対象 (source-level inspection、規約整合保証):
 *   Task A: app/api/auth/sign-out/route.ts が GET + POST + 包括 cookie 削除 + redirect to /auth/sign-in
 *   Task B: middleware.ts に AUDIT_DISABLED kill switch + throttled error logger
 *   Task C: lib/llm/orchestrator.ts buildErrorReply に actionableHint (4 root cause 分類)
 *   Task D: app/api/pages/route.ts upstream_error が code 付与 (ch_config / ch_schema / ch_network / ch_unknown)
 *   Task E: app/legal/{terms,privacy,contact}/page.tsx + layout 配備
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function readSrc(relPath) {
  return readFileSync(resolve(__dirname, '../..', relPath), 'utf8')
}

// ── Task A: /api/auth/sign-out endpoint ─────────────────────────────

test('Task A: /api/auth/sign-out exports GET + POST + clears multiple cookies + redirects', () => {
  const src = readSrc('app/api/auth/sign-out/route.ts')
  assert.match(src, /export\s+async\s+function\s+GET/, 'sign-out route must export GET handler')
  assert.match(src, /export\s+async\s+function\s+POST/, 'sign-out route must export POST handler')
  // 包括 cookie 削除 (ugokimap_saas_token + _vercel_jwt + __session)
  assert.match(src, /TOKEN_COOKIE_NAME/, 'must clear TOKEN_COOKIE_NAME (ugokimap_saas_token)')
  assert.match(src, /_vercel_jwt/, 'must clear _vercel_jwt (Vercel preview protection)')
  assert.match(src, /__session/, 'must clear __session (慣習的 session cookie)')
  assert.match(src, /\/auth\/sign-in/, 'must redirect to /auth/sign-in')
  assert.match(src, /maxAge:\s*0/, 'must set maxAge=0 for cookie deletion')
})

// ── Task B: middleware audit kill switch + throttle ─────────────────

test('Task B: middleware.ts adds AUDIT_DISABLED kill switch', () => {
  const src = readSrc('middleware.ts')
  assert.match(
    src,
    /AUDIT_DISABLED.*===.*['"]1['"]/,
    'middleware must check AUDIT_DISABLED=1 env to skip audit emit',
  )
})

test('Task B: middleware.ts adds throttled error logger (shouldEmitAuditError)', () => {
  const src = readSrc('middleware.ts')
  assert.match(src, /shouldEmitAuditError/, 'middleware must declare shouldEmitAuditError throttle')
  assert.match(
    src,
    /AUDIT_ERROR_WINDOW_MS/,
    'middleware must declare AUDIT_ERROR_WINDOW_MS for throttle window',
  )
  // throttle が both .then non-ok と .catch network error で使われている (順序保証)
  // 「shouldEmitAuditError(key)」が `INSERT non-ok` console.error の直前で呼ばれていることを確認。
  // lastIndexOf で comment block の occurrence を除外し、実 code 位置を取る。
  const nonOkIdx = src.lastIndexOf('INSERT non-ok')
  const networkIdx = src.lastIndexOf('INSERT network error')
  assert.ok(nonOkIdx > 0, 'INSERT non-ok console.error must exist')
  assert.ok(networkIdx > 0, 'INSERT network error console.error must exist')
  const nonOkContext = src.slice(Math.max(0, nonOkIdx - 300), nonOkIdx)
  const networkContext = src.slice(Math.max(0, networkIdx - 300), networkIdx)
  assert.ok(
    nonOkContext.includes('shouldEmitAuditError'),
    'INSERT non-ok log must be guarded by shouldEmitAuditError',
  )
  assert.ok(
    networkContext.includes('shouldEmitAuditError'),
    'INSERT network error log must be guarded by shouldEmitAuditError',
  )
})

// ── Task C: orchestrator actionable hint ────────────────────────────

test('Task C: orchestrator buildErrorReply emits actionable hint for 4 root causes', () => {
  const src = readSrc('lib/llm/orchestrator.ts')
  assert.match(src, /actionableHint/, 'orchestrator must declare actionableHint variable')
  // 4 root cause 分類
  for (const phrase of [
    'CLICKHOUSE_RO_PASSWORD',
    "doesn't exist",
    'IDOR',
    'ECONNREFUSED',
  ]) {
    assert.ok(
      src.includes(phrase.toLowerCase()) || src.includes(phrase),
      `buildErrorReply must classify '${phrase}' root cause`,
    )
  }
  // 推定原因の prefix で actionable と分かる
  assert.match(src, /推定原因/, 'actionableHint must use 推定原因 prefix (Owner readability)')
})

// ── Task D: /api/pages 502 code 付与 ────────────────────────────────

test('Task D: /api/pages 502 response includes diagnostic code', () => {
  const src = readSrc('app/api/pages/route.ts')
  // 4 code 分類
  for (const code of ["'ch_config'", "'ch_schema'", "'ch_network'", "'ch_unknown'"]) {
    assert.ok(src.includes(code), `/api/pages 502 must classify ${code}`)
  }
  // 502 response に code field を含める
  const upstreamBlock = src.match(/error:\s*'upstream_error'[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(
    upstreamBlock.includes('code'),
    '/api/pages 502 response must include `code` field for client diagnostics',
  )
})

// ── Task E: legal pages ─────────────────────────────────────────────

test('Task E: /legal/{terms,privacy,contact}/page.tsx + layout.tsx 配備', () => {
  for (const rel of [
    'app/legal/layout.tsx',
    'app/legal/terms/page.tsx',
    'app/legal/privacy/page.tsx',
    'app/legal/contact/page.tsx',
  ]) {
    const src = readSrc(rel)
    assert.ok(src.length > 50, `${rel} must exist and have non-trivial content`)
    assert.match(src, /export\s+default/, `${rel} must export default component`)
  }
  // terms / privacy / contact が h1 を持つ
  for (const rel of [
    'app/legal/terms/page.tsx',
    'app/legal/privacy/page.tsx',
    'app/legal/contact/page.tsx',
  ]) {
    const src = readSrc(rel)
    assert.match(src, /<h1\b/, `${rel} must render <h1>`)
  }
})

test('Task E: legal layout exposes nav links between all 3 pages', () => {
  const src = readSrc('app/legal/layout.tsx')
  for (const p of ['/legal/terms', '/legal/privacy', '/legal/contact']) {
    assert.ok(src.includes(p), `legal layout must link to ${p}`)
  }
})
