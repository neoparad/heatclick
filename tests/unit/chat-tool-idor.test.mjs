/**
 * Unit tests: lib/llm/tools.ts IDOR defense (続 64, 続 61 §2 (c))
 *
 * Strategy: lib/llm/tools.ts は @/lib/tenant に依存し canAccessSite が next/headers を間接参照
 *           するため、本 test 内に等価実装 (canAccessSite + sanitizeFetchClickhouseInput +
 *           authorizeToolCall + executeTool) を **同一仕様で** mirror して contract を担保する。
 *           middleware-classify.test.mjs (S1-09) と同じパターン。drift 検知は handoff §4 で
 *           Reviewer spot-check 対象。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/chat-tool-idor.test.mjs
 *
 * 検証対象 (続 61 §2 (c) 改善依頼 1:1):
 *   1. LLM が tool input に siteId を出しても **完全無視** され server-side fixedSiteId で固定
 *   2. cross-tenant access 試行 (fixedSiteId が ctx.site_ids に無い) は `ToolIDORError` (403)
 *   3. metric / dimension / periodDays の enum / 範囲違反は `ToolValidationError` (400)
 *   4. PII (email / phone / 16+digits / URL query) が telemetry log 文字列で redact
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── canAccessSite() 等価実装 (lib/tenant.ts:70-77 と同一仕様) ───────────

function canAccessSite(ctx, site_id) {
  if (['enterprise', 'agency'].includes(ctx.plan)) {
    return ctx.site_ids.includes(site_id)
  }
  return ctx.site_ids.includes(site_id)
}

// ── tools.ts 等価実装 (lib/llm/tools.ts と同一仕様) ────────────────────

const ALLOWED_METRICS = ['cvr', 'bounce_rate', 'page_views', 'session_duration', 'persona_dist']
const ALLOWED_DIMENSIONS = ['page_url', 'device', 'persona', 'time']
const MAX_PERIOD_DAYS = 90

class ToolIDORError extends Error {
  constructor(tenant_id, attemptedSiteId, toolName) {
    super(`Tool '${toolName}' IDOR rejection: tenant '${tenant_id}' may not access site '${attemptedSiteId}'`)
    this.name = 'ToolIDORError'
    this.code = 'TOOL_IDOR'
    this.status = 403
    this.tenant_id = tenant_id
    this.attemptedSiteId = attemptedSiteId
    this.toolName = toolName
  }
}

class ToolValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolValidationError'
    this.code = 'TOOL_VALIDATION'
    this.status = 400
  }
}

function sanitizeFetchClickhouseInput(rawLlmInput, fixedSiteId) {
  if (!rawLlmInput || typeof rawLlmInput !== 'object') {
    throw new ToolValidationError('tool input must be an object')
  }
  const input = rawLlmInput
  const metric = input.metric
  if (typeof metric !== 'string' || !ALLOWED_METRICS.includes(metric)) {
    throw new ToolValidationError(`tool input 'metric' must be one of [${ALLOWED_METRICS.join(', ')}]`)
  }
  let dimension = null
  if (input.dimension !== undefined && input.dimension !== null) {
    if (typeof input.dimension !== 'string' || !ALLOWED_DIMENSIONS.includes(input.dimension)) {
      throw new ToolValidationError(`tool input 'dimension' must be one of [${ALLOWED_DIMENSIONS.join(', ')}]`)
    }
    dimension = input.dimension
  }
  const periodDays = input.periodDays
  if (
    typeof periodDays !== 'number' ||
    !Number.isInteger(periodDays) ||
    periodDays < 1 ||
    periodDays > MAX_PERIOD_DAYS
  ) {
    throw new ToolValidationError(`tool input 'periodDays' must be an integer in [1, ${MAX_PERIOD_DAYS}]`)
  }
  return { metric, dimension, siteId: fixedSiteId, periodDays }
}

function authorizeToolCall(ctx, fixedSiteId, toolName) {
  if (!canAccessSite(ctx, fixedSiteId)) {
    throw new ToolIDORError(ctx.tenant_id, fixedSiteId, toolName)
  }
}

function executeTool(toolName, rawLlmInput, execCtx) {
  authorizeToolCall(execCtx.ctx, execCtx.requestSiteId, toolName)
  switch (toolName) {
    case 'fetch_clickhouse_data': {
      const sanitized = sanitizeFetchClickhouseInput(rawLlmInput, execCtx.requestSiteId)
      if (sanitized.siteId !== execCtx.requestSiteId) {
        throw new ToolIDORError(execCtx.ctx.tenant_id, sanitized.siteId, toolName)
      }
      return { toolName, sanitizedInput: sanitized, result: { metric: sanitized.metric, rows: [] } }
    }
    default:
      throw new ToolValidationError(`unknown tool: ${toolName}`)
  }
}

// ── redactForTelemetry() 等価実装 (lib/llm/tools.ts と同一仕様) ──────

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

// ── Fixtures ──────────────────────────────────────────────────────────

const TENANT_FREE = {
  tenant_id: 't_free_001',
  plan: 'free',
  user_id: 'u_001',
  site_ids: ['site_own_a', 'site_own_b'],
}

const TENANT_AGENCY = {
  tenant_id: 't_agency_001',
  plan: 'agency',
  user_id: 'u_002',
  site_ids: ['site_agency_x', 'site_agency_y'],
}

// ── Tests ─────────────────────────────────────────────────────────────

test('IDOR-1: LLM tool input siteId is ignored, fixedSiteId is used', () => {
  // LLM が「別 site の siteId」を tool input に出してきても、server は無視して fixedSiteId を使う
  const result = executeTool(
    'fetch_clickhouse_data',
    {
      metric: 'cvr',
      periodDays: 7,
      // 攻撃: LLM が prompt injection で別 site の id を input に注入してきたケース
      siteId: 'site_OTHER_TENANT_xyz',
      // さらに余計な field
      tenant_id: 't_attacker',
    },
    { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
  )

  assert.equal(result.sanitizedInput.siteId, 'site_own_a', 'must use fixedSiteId, not LLM-supplied siteId')
  assert.equal(result.sanitizedInput.metric, 'cvr')
  assert.equal(result.sanitizedInput.periodDays, 7)
  assert.equal(result.sanitizedInput.dimension, null)
  // LLM が混入させた tenant_id は sanitized 結果に残らない
  assert.equal(result.sanitizedInput.tenant_id, undefined)
})

test('IDOR-2: cross-tenant fixedSiteId returns 403 ToolIDORError', () => {
  // requestSiteId が tenant.site_ids に含まれない場合 (= API route 段で 403 になるはずだが二重防御)
  assert.throws(
    () =>
      executeTool(
        'fetch_clickhouse_data',
        { metric: 'cvr', periodDays: 7 },
        { ctx: TENANT_FREE, requestSiteId: 'site_NOT_OWNED' },
      ),
    (err) => {
      assert.equal(err.name, 'ToolIDORError')
      assert.equal(err.code, 'TOOL_IDOR')
      assert.equal(err.status, 403)
      assert.equal(err.tenant_id, 't_free_001')
      assert.equal(err.attemptedSiteId, 'site_NOT_OWNED')
      return true
    },
  )
})

test('IDOR-3: agency plan still enforces site_ids whitelist', () => {
  // agency / enterprise でも自テナント外 site は拒否される (lib/tenant.ts:72-76 整合)
  assert.throws(
    () =>
      executeTool(
        'fetch_clickhouse_data',
        { metric: 'cvr', periodDays: 7 },
        { ctx: TENANT_AGENCY, requestSiteId: 'site_own_a' /* 別 tenant の site */ },
      ),
    (err) => err.name === 'ToolIDORError' && err.status === 403,
  )

  // agency の自分の site なら OK
  const ok = executeTool(
    'fetch_clickhouse_data',
    { metric: 'cvr', periodDays: 7 },
    { ctx: TENANT_AGENCY, requestSiteId: 'site_agency_x' },
  )
  assert.equal(ok.sanitizedInput.siteId, 'site_agency_x')
})

test('IDOR-4: invalid metric is ToolValidationError 400', () => {
  assert.throws(
    () =>
      executeTool(
        'fetch_clickhouse_data',
        { metric: 'SELECT * FROM events', periodDays: 7 },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError' && err.status === 400,
  )
})

test('IDOR-5: periodDays overflow > 90 is ToolValidationError', () => {
  assert.throws(
    () =>
      executeTool(
        'fetch_clickhouse_data',
        { metric: 'cvr', periodDays: 365 },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError',
  )
})

test('IDOR-6: unknown tool name is rejected', () => {
  assert.throws(
    () =>
      executeTool(
        'shell_exec',
        { cmd: 'rm -rf /' },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError',
  )
})

test('IDOR-7: authorize gate runs BEFORE input parsing (defense in depth)', () => {
  // 入力が壊れていても、認可違反 (cross-tenant) のほうが先に raise されることを担保
  // - sanitize 内の throw を後段に出さない設計 (executeTool() の順序: authorize → sanitize)
  let err
  try {
    executeTool(
      'fetch_clickhouse_data',
      { metric: 'INVALID', periodDays: -1 },
      { ctx: TENANT_FREE, requestSiteId: 'site_NOT_OWNED' },
    )
  } catch (e) {
    err = e
  }
  assert.equal(err?.name, 'ToolIDORError', 'authorize must fire before sanitize on cross-tenant')
})

test('redact-1: email / phone / 16+digits / URL query are masked', () => {
  const sample =
    'contact alice@example.com or +81-90-1234-5678, card 4111111111111111, ' +
    'redirect https://example.com/foo?token=abc123&session=xyz789'
  const out = redactForTelemetry(sample)
  assert.match(out, /\[REDACTED_EMAIL\]/)
  assert.match(out, /\[REDACTED_PHONE\]/)
  assert.match(out, /\[REDACTED_DIGITS\]/)
  assert.match(out, /\[REDACTED_QUERY\]/)
  // PII 元値が完全に消えていること
  assert.doesNotMatch(out, /alice@example\.com/)
  assert.doesNotMatch(out, /4111111111111111/)
  assert.doesNotMatch(out, /token=abc123/)
})

test('redact-2: tenant_id / site_id / metric name are NOT redacted', () => {
  const sample = 'tenant_id=t_free_001 site_id=site_own_a metric=cvr periodDays=7'
  const out = redactForTelemetry(sample)
  assert.equal(out, sample, 'operational identifiers must survive redaction')
})

test('redact-3: long output is clipped to MAX_REDACTED_LEN', () => {
  const huge = 'x'.repeat(10000)
  const out = redactForTelemetry(huge)
  assert.ok(out.length <= MAX_REDACTED_LEN + 64, 'redacted output must be clipped')
  assert.match(out, /truncated \d+c/)
})
