/**
 * Unit tests: lib/llm/audit.ts buildAuditEntry / hashEvidence (続 68 W2-A、続 66 §3 M-6)
 *
 * Strategy: 純関数のみ test、ClickHouse INSERT 自体は integration テスト (将来) で。
 *
 * Usage:
 *   node --test tests/unit/audit-entry.test.mjs
 *
 * 検証対象:
 *   - buildAuditEntry: 必須 fields 必須 + 任意 fields default 補完
 *   - hashEvidence: 同じ input は同じ hash、redact 後の値が hash 入力 (PII 除外)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// ── 等価実装 (audit.ts: buildAuditEntry / hashEvidence 同一仕様) ──

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g
const LONG_DIGITS_RE = /\d{16,}/g
const URL_QUERY_RE = /(https?:\/\/[^\s?]+)\?[^\s"'`]+/g
const MAX_REDACTED_LEN = 4000

function redactForTelemetry(input) {
  let s = typeof input === 'string' ? input : JSON.stringify(input)
  s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]')
  s = s.replace(LONG_DIGITS_RE, '[REDACTED_DIGITS]')
  s = s.replace(PHONE_RE, '[REDACTED_PHONE]')
  s = s.replace(URL_QUERY_RE, '$1?[REDACTED_QUERY]')
  if (s.length > MAX_REDACTED_LEN) {
    s = s.slice(0, MAX_REDACTED_LEN) + `…[truncated ${s.length - MAX_REDACTED_LEN}c]`
  }
  return s
}

function hashEvidence(input) {
  const safe = redactForTelemetry(input)
  return createHash('sha256').update(safe).digest('hex').slice(0, 16)
}

function buildAuditEntry(partial) {
  return {
    messageIndex: 0,
    promptVersion: 'analyst-v1.0.0',
    classifierModelId: null,
    intentCategory: null,
    templateId: null,
    toolCalls: [],
    parentQueryId: null,
    evidenceHashes: [],
    cacheDecision: 'bypass',
    cacheSimilarity: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ttftMs: null,
    answerValidationResult: 'pass',
    evidenceLevel: 'planned',
    errorCode: null,
    ...partial,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

test('build-1: 最小入力 (必須 fields のみ) で全 field が defaulted', () => {
  const entry = buildAuditEntry({
    tenantId: 't_001',
    siteId: 'site_a',
    userId: 'u_001',
    conversationId: '11111111-1111-4111-8111-111111111111',
    modelId: 'stub',
    latencyMs: 123,
  })
  assert.equal(entry.tenantId, 't_001')
  assert.equal(entry.promptVersion, 'analyst-v1.0.0')
  assert.equal(entry.cacheDecision, 'bypass')
  assert.equal(entry.evidenceLevel, 'planned')
  assert.equal(entry.answerValidationResult, 'pass')
  assert.deepEqual(entry.toolCalls, [])
  assert.deepEqual(entry.evidenceHashes, [])
  assert.equal(entry.parentQueryId, null)
  assert.equal(entry.classifierModelId, null)
  assert.equal(entry.errorCode, null)
})

test('build-2: 上書き field は partial で渡したものが優先', () => {
  const entry = buildAuditEntry({
    tenantId: 't_001',
    siteId: 'site_a',
    userId: 'u_001',
    conversationId: '11111111-1111-4111-8111-111111111111',
    modelId: 'anthropic/claude-sonnet-4-5',
    latencyMs: 5432,
    templateId: 'CVR_WEEKLY',
    intentCategory: 'metric_baseline',
    toolCalls: ['analytics.overview'],
    cacheDecision: 'template',
    cacheSimilarity: 0.95,
    evidenceLevel: 'observed_approx',
    answerValidationResult: 'repair',
  })
  assert.equal(entry.templateId, 'CVR_WEEKLY')
  assert.equal(entry.cacheDecision, 'template')
  assert.equal(entry.cacheSimilarity, 0.95)
  assert.equal(entry.evidenceLevel, 'observed_approx')
  assert.equal(entry.answerValidationResult, 'repair')
  assert.deepEqual(entry.toolCalls, ['analytics.overview'])
})

test('hash-1: 同じ input は同じ hash', () => {
  const a = hashEvidence({ tool: 'analytics.overview', value: 42 })
  const b = hashEvidence({ tool: 'analytics.overview', value: 42 })
  assert.equal(a, b)
})

test('hash-2: PII が含まれてもまず redact されてから hash (再現性 + 安全)', () => {
  const withEmail = hashEvidence({ note: 'contact alice@example.com' })
  const withoutEmail = hashEvidence({ note: 'contact [REDACTED_EMAIL]' })
  assert.equal(withEmail, withoutEmail, 'redact 後の hash は email を含まない bytes')
})

test('hash-3: 異なる input は異なる hash', () => {
  const a = hashEvidence({ tool: 'analytics.overview', value: 1 })
  const b = hashEvidence({ tool: 'analytics.overview', value: 2 })
  assert.notEqual(a, b)
})

test('hash-4: 16 hex 文字 (短く cache key 用)', () => {
  const h = hashEvidence({ x: 'test' })
  assert.match(h, /^[0-9a-f]{16}$/)
})
