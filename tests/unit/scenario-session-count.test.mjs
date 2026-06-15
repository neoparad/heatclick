/**
 * Unit tests: scenario-runtime.js の session_count (訪問回数 = セッション数) 計数の等価実装
 *
 * scenario-runtime.js は browser only (vanilla JS) なので、_resolveSessionCount の挙動を
 * 等価 JS impl で固定する。実関数 (public/scenario-runtime.js) と lockstep で更新すること。
 *
 * 定義: 訪問者ごとに累計セッション数を localStorage で数え、30 分以上アクセスが空いたら新
 * セッションとして +1 (GA 風)。1 ページ表示につき最大 1 回評価 (実関数は memo)。localStorage
 * 不可なら 1 に degrade。「N 回目の訪問」condition (`session_count`) のソース。
 *
 * Usage: node --test tests/unit/scenario-session-count.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const SESSION_GAP_MS = 30 * 60 * 1000

// mirrors public/scenario-runtime.js _resolveSessionCount。memo は per-page (実関数のみ) なので
// ミラーは「store 状態 + now を入力に 1 回分の解決」を表現する。
function resolveSessionCount(store, nowMs) {
  const stored = parseInt(store.get('ugk_session_count') || '0', 10) || 0
  const lastActive = parseInt(store.get('ugk_last_active_ms') || '0', 10) || 0
  const isNewSession = !lastActive || nowMs - lastActive > SESSION_GAP_MS
  const count = isNewSession ? stored + 1 : stored > 0 ? stored : 1
  store.set('ugk_session_count', String(count))
  store.set('ugk_last_active_ms', String(nowMs))
  return count
}

function makeStore(init = {}) {
  const m = new Map(Object.entries(init))
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, String(v)),
  }
}

const T0 = Date.UTC(2026, 5, 15, 10, 0, 0)
const MIN = 60 * 1000
const HOUR = 60 * MIN

test('first ever visit → session_count = 1', () => {
  const s = makeStore()
  assert.equal(resolveSessionCount(s, T0), 1)
  assert.equal(s.get('ugk_session_count'), '1')
})

test('same session (within 30 min) → no increment', () => {
  const s = makeStore()
  assert.equal(resolveSessionCount(s, T0), 1)
  assert.equal(resolveSessionCount(s, T0 + 5 * MIN), 1)
  assert.equal(resolveSessionCount(s, T0 + 29 * MIN), 1)
})

test('gap > 30 min → new session increments to 2', () => {
  const s = makeStore()
  assert.equal(resolveSessionCount(s, T0), 1)
  assert.equal(resolveSessionCount(s, T0 + 31 * MIN), 2)
})

test('exactly 30 min gap = same session (uses >, not >=)', () => {
  const s = makeStore()
  assert.equal(resolveSessionCount(s, T0), 1)
  assert.equal(resolveSessionCount(s, T0 + SESSION_GAP_MS), 1)
})

test('three separate visits → 1, 2, 3 (matches "3回目の訪問" targeting)', () => {
  const s = makeStore()
  assert.equal(resolveSessionCount(s, T0), 1)
  assert.equal(resolveSessionCount(s, T0 + 1 * HOUR), 2)
  assert.equal(resolveSessionCount(s, T0 + 2 * HOUR), 3)
})

test('multiple page loads within one session stay flat, then a next-day visit increments', () => {
  const s = makeStore()
  assert.equal(resolveSessionCount(s, T0), 1)
  assert.equal(resolveSessionCount(s, T0 + 2 * MIN), 1)
  assert.equal(resolveSessionCount(s, T0 + 4 * MIN), 1)
  assert.equal(resolveSessionCount(s, T0 + 24 * HOUR), 2)
})

test('localStorage unavailable (reads null, writes noop) → degrades to 1 every time', () => {
  const deadStore = { get: () => null, set: () => {} }
  assert.equal(resolveSessionCount(deadStore, T0), 1)
  assert.equal(resolveSessionCount(deadStore, T0 + 1 * HOUR), 1)
})

test('GTE 3 condition: only matches from the 3rd visit onward', () => {
  const s = makeStore()
  const counts = [
    resolveSessionCount(s, T0),
    resolveSessionCount(s, T0 + 1 * HOUR),
    resolveSessionCount(s, T0 + 2 * HOUR),
    resolveSessionCount(s, T0 + 3 * HOUR),
  ]
  // session_count >= 3 が true になるのは 3 回目以降
  assert.deepEqual(
    counts.map((c) => c >= 3),
    [false, false, true, true],
  )
})
