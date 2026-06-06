/**
 * Unit tests for 続 118 rolling session refresh + bounce reason 判定
 *
 * 背景: dogfood で「操作していたら突然 sign-in に飛ばされる」が数日間 未解決ループ。
 *   根本原因の最有力候補 = token 期限切れ (旧 4h) + 「なぜ飛ばされたか」不可視。
 *   middleware.ts に 2 段の防御を追加:
 *     A. shouldRefreshSession(): 残存期間が閾値を切ったら 30d 新 cookie を再発行
 *     B. bounceReasonFromError(): jose error から bounce 理由 (session_expired / invalid_token) を判定
 *
 * Strategy: middleware.ts は Next.js Edge runtime 依存のため直接 import せず、
 *           pure helper のロジックを本 test 内に等価実装する
 *           (middleware-agency-routing.test.mjs と同流儀)。
 *           完全 E2E は Playwright (将来 sign-in.spec.ts 拡張) で。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/session-rolling-refresh.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── middleware.ts の pure helper 等価実装 ──────────────────────────────

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // 30d
const SESSION_REFRESH_THRESHOLD_SECONDS = 25 * 24 * 60 * 60 // 25d

function bounceReasonFromError(err) {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ERR_JWT_EXPIRED'
  ) {
    return 'session_expired'
  }
  return 'invalid_token'
}

function shouldRefreshSession(
  expSec,
  nowSec,
  thresholdSec = SESSION_REFRESH_THRESHOLD_SECONDS,
) {
  if (typeof expSec !== 'number' || !Number.isFinite(expSec)) return false
  const remaining = expSec - nowSec
  return remaining > 0 && remaining < thresholdSec
}

const DAY = 24 * 60 * 60

// ── bounceReasonFromError ────────────────────────────────────────────

test('期限切れ error (ERR_JWT_EXPIRED) は session_expired', () => {
  // jose は JWTExpired を { code: 'ERR_JWT_EXPIRED' } として投げる
  const joseExpired = Object.assign(new Error('"exp" claim timestamp check failed'), {
    code: 'ERR_JWT_EXPIRED',
  })
  assert.equal(bounceReasonFromError(joseExpired), 'session_expired')
})

test('署名不一致など他の error は invalid_token', () => {
  const sigErr = Object.assign(new Error('signature verification failed'), {
    code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  })
  assert.equal(bounceReasonFromError(sigErr), 'invalid_token')
})

test('code を持たない素の Error は invalid_token', () => {
  assert.equal(bounceReasonFromError(new Error('boom')), 'invalid_token')
})

test('null / undefined / 文字列 などの非 object も invalid_token (防御)', () => {
  assert.equal(bounceReasonFromError(null), 'invalid_token')
  assert.equal(bounceReasonFromError(undefined), 'invalid_token')
  assert.equal(bounceReasonFromError('ERR_JWT_EXPIRED'), 'invalid_token')
  assert.equal(bounceReasonFromError(42), 'invalid_token')
})

// ── shouldRefreshSession ─────────────────────────────────────────────

test('残存 < 25d 閾値 (例: 残り 5d) は refresh する', () => {
  const now = 1_700_000_000
  const exp = now + 5 * DAY // 残り 5d < 25d
  assert.equal(shouldRefreshSession(exp, now), true)
})

test('残存 > 25d 閾値 (発行直後、残り ~30d) は refresh しない', () => {
  const now = 1_700_000_000
  const exp = now + SESSION_MAX_AGE_SECONDS // 残り 30d > 25d
  assert.equal(shouldRefreshSession(exp, now), false)
})

test('残存ちょうど 25d 境界は refresh しない (strictly less than)', () => {
  const now = 1_700_000_000
  const exp = now + SESSION_REFRESH_THRESHOLD_SECONDS // 残り == 25d
  assert.equal(shouldRefreshSession(exp, now), false)
})

test('残存 25d - 1s は refresh する (境界の内側)', () => {
  const now = 1_700_000_000
  const exp = now + SESSION_REFRESH_THRESHOLD_SECONDS - 1
  assert.equal(shouldRefreshSession(exp, now), true)
})

test('既に期限切れ (remaining <= 0) は refresh しない (verify が先に throw する想定の防御)', () => {
  const now = 1_700_000_000
  assert.equal(shouldRefreshSession(now - 1, now), false) // 1s 前に切れた
  assert.equal(shouldRefreshSession(now, now), false) // ちょうど今切れた
  assert.equal(shouldRefreshSession(now - 10 * DAY, now), false)
})

test('exp が undefined / NaN / Infinity は refresh しない (防御)', () => {
  const now = 1_700_000_000
  assert.equal(shouldRefreshSession(undefined, now), false)
  assert.equal(shouldRefreshSession(Number.NaN, now), false)
  assert.equal(shouldRefreshSession(Number.POSITIVE_INFINITY, now), false)
})

test('threshold を引数で上書きできる (テスト容易性)', () => {
  const now = 1_700_000_000
  const exp = now + 2 * DAY // 残り 2d
  // 閾値 1d なら refresh しない、3d なら refresh する
  assert.equal(shouldRefreshSession(exp, now, 1 * DAY), false)
  assert.equal(shouldRefreshSession(exp, now, 3 * DAY), true)
})

// ── 統合シナリオ: アクティブユーザーが飛ばされない流れ ────────────────

test('シナリオ: 30d 発行 → 6d 後にアクセス → refresh されてまた 30d に', () => {
  const issuedAt = 1_700_000_000
  const exp = issuedAt + SESSION_MAX_AGE_SECONDS
  const sixDaysLater = issuedAt + 6 * DAY
  // 6d 後: 残り 24d < 25d 閾値 → refresh
  assert.equal(shouldRefreshSession(exp, sixDaysLater), true)
})

test('シナリオ: 30d 発行 → 1d 後にアクセス → まだ refresh 不要 (cookie write 抑制)', () => {
  const issuedAt = 1_700_000_000
  const exp = issuedAt + SESSION_MAX_AGE_SECONDS
  const oneDayLater = issuedAt + 1 * DAY
  // 1d 後: 残り 29d > 25d → refresh しない (毎リクエスト cookie 再発行を避ける)
  assert.equal(shouldRefreshSession(exp, oneDayLater), false)
})
