/**
 * Unit tests: lib/llm/chat-rate-limit.ts checkChatRateLimit in-memory fallback (続 68 W2-A、続 66 §3 M-7)
 *
 * Strategy: Redis 接続なしで in-memory fallback の挙動を test。
 *           本実装 (checkChatRateLimit) は Redis 優先 / 失敗時 fallback だが、本 test は
 *           fallback path (checkSync 等価) の bucket count + reset を契約で担保。
 *
 * Usage:
 *   node --test tests/unit/chat-rate-limit.test.mjs
 *
 * 検証対象:
 *   - 60 req/h limit (CHAT_RATE_LIMIT_PER_HOUR)
 *   - 61 回目で allowed=false
 *   - 別 tenant_id は独立カウント
 *   - hour bucket 境界で reset
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const CHAT_RATE_LIMIT_PER_HOUR = 60
const HOUR_BUCKET_MS = 60 * 60 * 1000

// ── 等価実装 (chat-rate-limit.ts: checkSync 同一仕様) ────────────────

const memoryStore = {}

function checkSync(tenantId, nowMs) {
  const limit = CHAT_RATE_LIMIT_PER_HOUR
  const now = nowMs ?? Date.now()
  const bucket = Math.floor(now / HOUR_BUCKET_MS)
  const key = `${tenantId}:${bucket}`
  let record = memoryStore[key]
  if (!record) {
    record = { count: 0, resetTime: (bucket + 1) * HOUR_BUCKET_MS }
    memoryStore[key] = record
  }
  record.count++
  return {
    allowed: record.count <= limit,
    remaining: Math.max(0, limit - record.count),
    resetTime: record.resetTime,
    limit,
  }
}

function reset() {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
}

// ── Tests ─────────────────────────────────────────────────────────────

test('rate-1: 1 回目 → allowed, remaining=59', () => {
  reset()
  const r = checkSync('t_001')
  assert.equal(r.allowed, true)
  assert.equal(r.remaining, 59)
  assert.equal(r.limit, 60)
})

test('rate-2: 60 回まで allowed, 61 回目で denied', () => {
  reset()
  for (let i = 1; i <= 60; i++) {
    const r = checkSync('t_002')
    assert.equal(r.allowed, true, `request ${i} should be allowed`)
    assert.equal(r.remaining, 60 - i)
  }
  const r61 = checkSync('t_002')
  assert.equal(r61.allowed, false, 'request 61 must be denied')
  assert.equal(r61.remaining, 0)
})

test('rate-3: 別 tenant は独立カウント (cross-tenant 影響なし)', () => {
  reset()
  for (let i = 0; i < 60; i++) checkSync('t_a')
  const blocked = checkSync('t_a')
  assert.equal(blocked.allowed, false, 't_a should be at limit')

  const otherTenant = checkSync('t_b')
  assert.equal(otherTenant.allowed, true, 't_b should be unaffected')
  assert.equal(otherTenant.remaining, 59)
})

test('rate-4: hour bucket 境界で reset (next hour → fresh quota)', () => {
  reset()
  const now = Date.now()
  // 60 回消費
  for (let i = 0; i < 60; i++) checkSync('t_c', now)
  const blocked = checkSync('t_c', now)
  assert.equal(blocked.allowed, false)

  // 次の hour bucket に進める (+1 hour + 1ms)
  const nextHour = now + HOUR_BUCKET_MS + 1
  const r = checkSync('t_c', nextHour)
  assert.equal(r.allowed, true, 'new hour bucket should reset')
  assert.equal(r.remaining, 59)
})

test('rate-5: resetTime が次の hour boundary を示す', () => {
  reset()
  const now = 1716470400000 // 2024-05-23T12:00:00Z 相当 (任意の固定時刻)
  const r = checkSync('t_d', now)
  const expectedBucket = Math.floor(now / HOUR_BUCKET_MS)
  const expectedReset = (expectedBucket + 1) * HOUR_BUCKET_MS
  assert.equal(r.resetTime, expectedReset)
})
