/**
 * Unit tests for middleware agency / proof route ACL — 続 72 (Frontend B-1 fix)
 *
 * 背景: Owner 動作テスト (2026-05-23 22:50) で agency plan owner が
 *   `/heatmap` / `/personas` / `/chat` 等の (proof) route group にアクセスした際に
 *   `/agency/dashboard` へ強制 redirect される bug 発覚。
 *
 * 旧 (続 24 配備〜続 71):
 *   `if (isProofRoute(pathname) && isAgencyUser) → redirect('/agency/dashboard')`
 *   = agency owner が proof ページに永久到達不能
 *
 * 新 (続 72):
 *   agency / enterprise plan でも proof route アクセス可能。
 *   `/agency/*` への非 agency 試行のみ `/dashboard` redirect で保護維持。
 *
 * Strategy: middleware.ts は Next.js Edge runtime 依存のため、ACL ロジックを
 *           本 test 内に等価実装する (middleware-classify.test.mjs と同流儀)。
 *           完全 E2E は Playwright (将来 sign-in.spec.ts 拡張) で。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/middleware-agency-routing.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── middleware ACL ロジック等価実装 (続 72 fix 後) ──────────────────

const AGENCY_PREFIX = '/agency'
const AGENCY_PLANS = new Set(['agency', 'enterprise'])

/**
 * 続 72 fix 後の routing decision:
 *   非 agency が `/agency/*` → redirect('/dashboard')
 *   それ以外 → next (proof / agency 双方 OK)
 *
 * 返値: { kind: 'redirect', to } | { kind: 'next' }
 */
function decideRouting(pathname, plan) {
  const isAgencyUser = AGENCY_PLANS.has(plan)
  if (pathname.startsWith(AGENCY_PREFIX) && !isAgencyUser) {
    return { kind: 'redirect', to: '/dashboard' }
  }
  return { kind: 'next' }
}

// ── Test: 非 agency が agency 領域へ → /dashboard redirect (保護維持) ──

test('non-agency plan accessing /agency/* redirects to /dashboard', () => {
  for (const plan of ['free', 'starter', 'growth']) {
    for (const path of ['/agency/dashboard', '/agency/clients', '/agency/billing']) {
      const r = decideRouting(path, plan)
      assert.equal(r.kind, 'redirect', `${plan} accessing ${path} must redirect`)
      assert.equal(r.to, '/dashboard')
    }
  }
})

// ── Test: agency / enterprise が agency 領域 → pass (権限あり) ──

test('agency/enterprise plan accessing /agency/* passes', () => {
  for (const plan of ['agency', 'enterprise']) {
    for (const path of ['/agency/dashboard', '/agency/clients']) {
      const r = decideRouting(path, plan)
      assert.equal(r.kind, 'next', `${plan} accessing ${path} must pass`)
    }
  }
})

// ── Test (続 72 fix の中核): agency が proof ページ → pass (新規許容) ──

test('agency/enterprise plan accessing proof routes passes (続 72 B-1 fix)', () => {
  const proofPaths = [
    '/dashboard',
    '/heatmap',
    '/heatmap/CIP_EcwUTHEZdIOAUqum',
    '/personas',
    '/chat',
    '/cv-journey',
    '/performance',
    '/insights',
    '/pages',
  ]
  for (const plan of ['agency', 'enterprise']) {
    for (const path of proofPaths) {
      const r = decideRouting(path, plan)
      assert.equal(
        r.kind,
        'next',
        `${plan} accessing ${path} must pass (続 72 fix: no force redirect to /agency/dashboard)`,
      )
    }
  }
})

// ── Test: 非 agency が proof ページ → pass (元から OK) ──

test('non-agency plan accessing proof routes passes', () => {
  for (const plan of ['free', 'starter', 'growth']) {
    for (const path of ['/dashboard', '/heatmap', '/personas', '/chat']) {
      const r = decideRouting(path, plan)
      assert.equal(r.kind, 'next', `${plan} accessing ${path} must pass`)
    }
  }
})

// ── Test: edge cases ──

test('exact /agency root for agency user passes', () => {
  // /agency 自体 (trailing slash なし、folder 配下ではない)
  const r = decideRouting('/agency', 'agency')
  assert.equal(r.kind, 'next')
})

test('exact /agency root for non-agency user redirects', () => {
  const r = decideRouting('/agency', 'free')
  assert.equal(r.kind, 'redirect')
  assert.equal(r.to, '/dashboard')
})

test('unknown plan defaults to non-agency (redirect from /agency/*)', () => {
  const r = decideRouting('/agency/dashboard', 'unknown_plan')
  assert.equal(r.kind, 'redirect')
  assert.equal(r.to, '/dashboard')
})

// ── Regression: 続 71 までの bug 再現 (旧仕様だったら失敗するケース) ─

test('regression: agency owner reaching /heatmap is NOT redirected (続 72 fix)', () => {
  // Owner 2026-05-23 22:50 報告の症状: agency plan で /heatmap → /agency/dashboard
  // 続 72 fix 後はこの redirect が起きないことを assert
  const r = decideRouting('/heatmap', 'enterprise')
  assert.equal(r.kind, 'next', 'agency owner must reach /heatmap directly')
  if (r.kind === 'redirect') {
    assert.notEqual(r.to, '/agency/dashboard')
  }
})

test('regression: agency owner reaching /chat is NOT redirected (続 72 fix)', () => {
  const r = decideRouting('/chat', 'enterprise')
  assert.equal(r.kind, 'next', 'agency owner must reach /chat directly')
})
