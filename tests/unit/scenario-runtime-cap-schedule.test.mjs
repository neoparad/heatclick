/**
 * Unit tests: scenario-runtime.js の frequency cap / schedule ヘルパ等価実装 (Phase 2.1)
 *
 * scenario-runtime.js は browser only (vanilla JS) なので、本ファイルでは等価 JS impl を
 * 書いて挙動を固定する。scenario-runtime.js の実関数と lockstep で更新すること。
 *
 * Usage:
 *   node --test tests/unit/scenario-runtime-cap-schedule.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Equivalent JS impl (mirrors public/scenario-runtime.js Phase 2.1 helpers) ──

const SCHEDULE_SKEW_MS = 5 * 60 * 1000

function isScenarioInSchedule(sc, nowMs) {
  if (!sc || !sc.schedule) return true
  if (sc.schedule.start_at) {
    const t0 = Date.parse(sc.schedule.start_at)
    if (!Number.isFinite(t0)) return false
    if (nowMs + SCHEDULE_SKEW_MS < t0) return false
  }
  if (sc.schedule.end_at) {
    const t1 = Date.parse(sc.schedule.end_at)
    if (!Number.isFinite(t1)) return false
    if (nowMs - SCHEDULE_SKEW_MS >= t1) return false
  }
  return true
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
  return date.getUTCFullYear() + '-W' + (weekNum < 10 ? '0' : '') + weekNum
}

function periodBucket(period, nowMs) {
  const d = new Date(nowMs)
  if (period === 'day') {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
  }
  if (period === 'week') return isoWeekKey(d)
  return 'session'
}

// ── Tests ──

test('isScenarioInSchedule: no schedule → always true', () => {
  const now = Date.UTC(2026, 6, 15, 12, 0, 0)
  assert.equal(isScenarioInSchedule({}, now), true)
  assert.equal(isScenarioInSchedule({ schedule: null }, now), true)
})

test('isScenarioInSchedule: within window → true', () => {
  const now = Date.UTC(2026, 6, 15, 12, 0, 0)
  assert.equal(
    isScenarioInSchedule(
      { schedule: { start_at: '2026-07-01T00:00:00Z', end_at: '2026-07-31T23:59:59Z' } },
      now,
    ),
    true,
  )
})

test('isScenarioInSchedule: before start_at → false (outside skew)', () => {
  const now = Date.UTC(2026, 6, 1, 0, 0, 0)
  // start_at = now + 10min (skew 5min なので不可)
  assert.equal(
    isScenarioInSchedule(
      { schedule: { start_at: '2026-07-01T00:10:00Z', end_at: null } },
      now,
    ),
    false,
  )
})

test('isScenarioInSchedule: just within skew before start → true', () => {
  const now = Date.UTC(2026, 6, 1, 0, 0, 0)
  // start_at = now + 3min (skew 5min 内なので OK)
  assert.equal(
    isScenarioInSchedule(
      { schedule: { start_at: '2026-07-01T00:03:00Z', end_at: null } },
      now,
    ),
    true,
  )
})

test('isScenarioInSchedule: after end_at → false', () => {
  const now = Date.UTC(2026, 6, 31, 23, 0, 0) // 末日 23:00
  assert.equal(
    isScenarioInSchedule(
      { schedule: { start_at: null, end_at: '2026-07-15T00:00:00Z' } },
      now,
    ),
    false,
  )
})

test('isScenarioInSchedule: just within skew after end → true', () => {
  const now = Date.UTC(2026, 6, 31, 23, 59, 0)
  // end_at = now + 2min, skew 5min なので now - 5min < end → ok
  assert.equal(
    isScenarioInSchedule(
      { schedule: { start_at: null, end_at: '2026-07-31T23:58:00Z' } },
      now,
    ),
    true,
  )
})

test('isScenarioInSchedule: invalid ISO → fail-closed false', () => {
  const now = Date.UTC(2026, 6, 15, 12, 0, 0)
  assert.equal(
    isScenarioInSchedule({ schedule: { start_at: 'not-a-date', end_at: null } }, now),
    false,
  )
  assert.equal(
    isScenarioInSchedule({ schedule: { start_at: null, end_at: 'still-not' } }, now),
    false,
  )
})

test('periodBucket: day produces YYYY-MM-DD UTC', () => {
  const now = Date.UTC(2026, 5, 7, 23, 59, 0) // 2026-06-07 UTC
  assert.equal(periodBucket('day', now), '2026-06-07')
})

test('periodBucket: week produces ISO YYYY-Www', () => {
  // 2026-01-01 (Thu) は ISO week 01 of 2026
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  assert.equal(periodBucket('week', now), '2026-W01')
  // 2026-12-31 (Thu) は ISO week 53 of 2026
  const lateNow = Date.UTC(2026, 11, 31, 12, 0, 0)
  assert.equal(periodBucket('week', lateNow), '2026-W53')
})

test('periodBucket: session falls through to literal "session"', () => {
  assert.equal(periodBucket('session', Date.now()), 'session')
})

// ── frequency cap state machine (simulating localStorage/sessionStorage) ──

function makeStores() {
  const local = new Map()
  const session = new Map()
  return {
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
    },
  }
}

function isFrequencyCapExceeded(sc, nowMs, stores) {
  const cap = sc && sc.frequency_cap
  if (!cap) return false
  const period = cap.per_period
  const max = cap.max_impressions | 0
  if (max <= 0) return true
  if (period === 'session') {
    if (max >= 2) {
      const raw = stores.sessionStorage.getItem('ugk_cap_s:' + sc.id) || '0'
      const n = parseInt(raw, 10) || 0
      return n >= max
    }
    return false
  }
  const bucket = periodBucket(period, nowMs)
  const key = 'ugk_cap:' + sc.id + ':' + period + ':' + bucket
  const raw = stores.localStorage.getItem(key) || '0'
  const n = parseInt(raw, 10) || 0
  return n >= max
}

function bumpFrequencyCap(sc, nowMs, stores) {
  const cap = sc && sc.frequency_cap
  if (!cap) return
  const period = cap.per_period
  if (period === 'session') {
    const raw = stores.sessionStorage.getItem('ugk_cap_s:' + sc.id) || '0'
    const n = (parseInt(raw, 10) || 0) + 1
    stores.sessionStorage.setItem('ugk_cap_s:' + sc.id, String(n))
    return
  }
  const bucket = periodBucket(period, nowMs)
  const key = 'ugk_cap:' + sc.id + ':' + period + ':' + bucket
  const raw = stores.localStorage.getItem(key) || '0'
  const n = (parseInt(raw, 10) || 0) + 1
  stores.localStorage.setItem(key, String(n))
}

test('frequency_cap none → never exceeded', () => {
  const stores = makeStores()
  assert.equal(isFrequencyCapExceeded({ id: 'x', frequency_cap: null }, Date.now(), stores), false)
})

test('frequency_cap day max=3 → exceeded only after 3 bumps', () => {
  const stores = makeStores()
  const sc = { id: 's1', frequency_cap: { per_period: 'day', max_impressions: 3 } }
  const now = Date.UTC(2026, 5, 7, 10, 0, 0)
  for (let i = 0; i < 3; i++) {
    assert.equal(isFrequencyCapExceeded(sc, now, stores), false, `bump ${i + 1}`)
    bumpFrequencyCap(sc, now, stores)
  }
  assert.equal(isFrequencyCapExceeded(sc, now, stores), true)
})

test('frequency_cap day bucket resets across days', () => {
  const stores = makeStores()
  const sc = { id: 's1', frequency_cap: { per_period: 'day', max_impressions: 1 } }
  const day1 = Date.UTC(2026, 5, 7, 10, 0, 0)
  const day2 = Date.UTC(2026, 5, 8, 10, 0, 0)
  bumpFrequencyCap(sc, day1, stores)
  assert.equal(isFrequencyCapExceeded(sc, day1, stores), true, 'day1 cap exceeded')
  assert.equal(isFrequencyCapExceeded(sc, day2, stores), false, 'day2 fresh bucket')
})

test('frequency_cap session max=1 → per-session dedup handles it (return false here)', () => {
  const stores = makeStores()
  const sc = { id: 's1', frequency_cap: { per_period: 'session', max_impressions: 1 } }
  // max=1 のときは _wasMatchedInSession 側で弾く設計なので、本ヘルパは false を返す
  assert.equal(isFrequencyCapExceeded(sc, Date.now(), stores), false)
})

test('frequency_cap session max=2 → sessionStorage で 2 回まで', () => {
  const stores = makeStores()
  const sc = { id: 's1', frequency_cap: { per_period: 'session', max_impressions: 2 } }
  const now = Date.now()
  assert.equal(isFrequencyCapExceeded(sc, now, stores), false)
  bumpFrequencyCap(sc, now, stores)
  assert.equal(isFrequencyCapExceeded(sc, now, stores), false)
  bumpFrequencyCap(sc, now, stores)
  assert.equal(isFrequencyCapExceeded(sc, now, stores), true)
})

test('frequency_cap max=0 → always exceeded (fail-closed)', () => {
  const stores = makeStores()
  const sc = { id: 's1', frequency_cap: { per_period: 'day', max_impressions: 0 } }
  assert.equal(isFrequencyCapExceeded(sc, Date.now(), stores), true)
})

// ── evaluateAll guard-order simulation (Codex T2 review 指摘 G 反映) ──
// session max>=2 のとき per-session dedup を skip して期待回数 render するか検証する。
// 実 scenario-runtime.js の評価ループの最小等価実装で実行する。

function makeMatchedStore() {
  const map = new Map()
  return {
    wasMatchedInSession: (scId, sessionId) => map.has(scId + ':' + sessionId),
    markMatched: (scId, sessionId) => map.set(scId + ':' + sessionId, 1),
  }
}

function usesSessionDedup(sc) {
  const cap = sc && sc.frequency_cap
  if (!cap) return true
  if (cap.per_period !== 'session') return true
  return ((cap.max_impressions | 0) < 2)
}

function evaluateAllSimulated(scenarios, ctx, stores, matchedStore, nowMs) {
  let renderedCount = 0
  for (const sc of scenarios) {
    if (sc.status !== 'live') continue
    if (!isScenarioInSchedule(sc, nowMs)) continue
    if (usesSessionDedup(sc) && matchedStore.wasMatchedInSession(sc.id, ctx.session_id)) continue
    if (isFrequencyCapExceeded(sc, nowMs, stores)) continue
    // 仮の condition: 常に match (テスト用)
    const matched = true
    if (matched) {
      if (usesSessionDedup(sc)) matchedStore.markMatched(sc.id, ctx.session_id)
      bumpFrequencyCap(sc, nowMs, stores)
      renderedCount++
    }
  }
  return renderedCount
}

test('evaluateAll: session max=1 + per-session dedup → 2 回評価しても 1 回しか render しない', () => {
  const stores = makeStores()
  const matched = makeMatchedStore()
  const ctx = { session_id: 'sess-1' }
  const sc = { id: 's1', status: 'live', frequency_cap: { per_period: 'session', max_impressions: 1 } }
  const total =
    evaluateAllSimulated([sc], ctx, stores, matched, Date.now()) +
    evaluateAllSimulated([sc], ctx, stores, matched, Date.now())
  assert.equal(total, 1)
})

test('evaluateAll: session max=2 → 同 session 内で 2 回まで render される (旧挙動バグ修正)', () => {
  const stores = makeStores()
  const matched = makeMatchedStore()
  const ctx = { session_id: 'sess-1' }
  const sc = { id: 's2', status: 'live', frequency_cap: { per_period: 'session', max_impressions: 2 } }
  // 3 回呼ぶと 2 回 render される
  const total =
    evaluateAllSimulated([sc], ctx, stores, matched, Date.now()) +
    evaluateAllSimulated([sc], ctx, stores, matched, Date.now()) +
    evaluateAllSimulated([sc], ctx, stores, matched, Date.now())
  assert.equal(total, 2)
})

test('evaluateAll: day max=3 → 同日内 3 回 render、4 回目から block', () => {
  const stores = makeStores()
  const matched = makeMatchedStore()
  const ctx = { session_id: 'sess-1' }
  const sc = { id: 's3', status: 'live', frequency_cap: { per_period: 'day', max_impressions: 3 } }
  // day cap は per-session dedup と排他ではない (各 session 内で 1 回ずつ、ただし日次合計 3 回まで)
  const now = Date.UTC(2026, 5, 7, 12, 0, 0)
  let total = 0
  for (let i = 0; i < 5; i++) {
    // 各 i で別 session を装う (visitor が複数回訪問する想定)
    matched.markMatched.bind(matched) // no-op marker
    const matched2 = makeMatchedStore()
    total += evaluateAllSimulated([sc], { session_id: 'sess-' + i }, stores, matched2, now)
  }
  assert.equal(total, 3)
})

test('evaluateAll: schedule outside window → 0 render', () => {
  const stores = makeStores()
  const matched = makeMatchedStore()
  const ctx = { session_id: 'sess-1' }
  const sc = {
    id: 's4',
    status: 'live',
    schedule: { start_at: '2027-01-01T00:00:00Z', end_at: '2027-12-31T23:59:59Z' },
  }
  const now = Date.UTC(2026, 5, 7, 12, 0, 0)
  const renderedCount = evaluateAllSimulated([sc], ctx, stores, matched, now)
  assert.equal(renderedCount, 0)
})
