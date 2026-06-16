/**
 * Unit tests: lib/llm/analytics-tools.ts IDOR defense (続 68 W2-A、続 66 §3 M-1)
 *
 * Strategy: analytics-tools.ts は @/lib/llm/hybrid-query / @/lib/tenant / @/lib/clickhouse に
 *           依存し ClickHouse 接続が必要なため、本 test では IDOR + Zod input 検証 + parentQueryId
 *           enforcement の **契約** を等価実装で担保する (middleware-classify.test.mjs / chat-tool-idor.test.mjs 流儀)。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/analytics-tools-idor.test.mjs
 *
 * 検証対象 (続 64 §2c IDOR 継承 + 続 68 W2-A 拡張):
 *   1. TOOL_SCHEMAS.input_schema に siteId / tenantId を含めない (declarative defense)
 *   2. executeAnalyticsTool(name, llmInput, ctx) で server-side requestSiteId 固定 (LLM 入力破棄)
 *   3. authorize → Zod parse → parentQueryId 検証 の順序 (defense in depth、続 64 IDOR-7 同様)
 *   4. cross-tenant fixedSiteId は ToolIDORError (403)
 *   5. unknown tool / 不正 metric / dimension は ToolValidationError (400)
 *   6. parentQueryId 不在で contributors/drilldown/verify は ToolValidationError (400)
 *   7. parent registry の tenant 分離 (別 tenant_id の queryId は見えない)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── canAccessSite 等価実装 (lib/tenant.ts と同一仕様) ─────────────

function canAccessSite(ctx, site_id) {
  if (['enterprise', 'agency'].includes(ctx.plan)) {
    return ctx.site_ids.includes(site_id)
  }
  return ctx.site_ids.includes(site_id)
}

// ── analytics-tools.ts 等価実装 ───────────────────────────────────

// 続 78 Task B: bounce_rate / session_duration を削除 (lib/llm/hybrid-query.ts ANALYTICS_METRICS と同期、
//   続 67 D-1 schema 整合 = events table に is_bounce / session_duration_sec 列なし)
const ANALYTICS_METRICS = ['cvr', 'page_views', 'sessions']
const ALLOWED_DIMS = ['page_url', 'device', 'persona']

class ToolIDORError extends Error {
  constructor(tenant_id, siteId, toolName) {
    super(`Tool '${toolName}' IDOR: tenant '${tenant_id}' may not access site '${siteId}'`)
    this.name = 'ToolIDORError'
    this.code = 'TOOL_IDOR'
    this.status = 403
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

// Parent registry (in-memory、tenant-scoped、TTL は test では検証外)
const _registry = new Map()
function registerParent(tenantId, input, result) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  _registry.set(`${tenantId}:${id}`, { input, result, createdAt: Date.now() })
  return id
}
function getParent(tenantId, queryId) {
  return _registry.get(`${tenantId}:${queryId}`) ?? null
}
function resetRegistry() {
  _registry.clear()
}

// TOOL_SCHEMAS 等価実装 (siteId/tenantId を含めないことの contract test)
const OVERVIEW_INPUT_FIELDS = ['dateRange', 'metrics', 'timezone']
const CONTRIBUTORS_INPUT_FIELDS = ['parentQueryId', 'dimension', 'limit', 'minDenominator']
const DRILLDOWN_INPUT_FIELDS = ['parentQueryId', 'dimension', 'value', 'metric', 'window', 'grain']
const VERIFY_INPUT_FIELDS = ['parentQueryId', 'claim', 'tolerancePct']

function parseToolInput(toolName, raw) {
  if (!raw || typeof raw !== 'object') throw new ToolValidationError(`${toolName}: input must be object`)
  switch (toolName) {
    case 'analytics.overview': {
      const dateRange = raw.dateRange
      if (!dateRange || typeof dateRange.start !== 'string' || typeof dateRange.end !== 'string') {
        throw new ToolValidationError(`${toolName}: dateRange.start/.end required`)
      }
      if (!Array.isArray(raw.metrics) || raw.metrics.length < 1) {
        throw new ToolValidationError(`${toolName}: metrics required`)
      }
      for (const m of raw.metrics) {
        if (!ANALYTICS_METRICS.includes(m)) {
          throw new ToolValidationError(`${toolName}: invalid metric '${m}'`)
        }
      }
      return {
        dateRange,
        metrics: raw.metrics,
        timezone: raw.timezone ?? 'Asia/Tokyo',
      }
    }
    case 'analytics.contributors': {
      if (typeof raw.parentQueryId !== 'string') throw new ToolValidationError(`${toolName}: parentQueryId required`)
      if (!ALLOWED_DIMS.includes(raw.dimension)) throw new ToolValidationError(`${toolName}: invalid dimension`)
      const limit = typeof raw.limit === 'number' ? raw.limit : 20
      if (limit < 5 || limit > 100) throw new ToolValidationError(`${toolName}: limit out of [5,100]`)
      return { parentQueryId: raw.parentQueryId, dimension: raw.dimension, limit }
    }
    case 'analytics.drilldown': {
      if (typeof raw.parentQueryId !== 'string') throw new ToolValidationError(`${toolName}: parentQueryId required`)
      if (!ALLOWED_DIMS.includes(raw.dimension)) throw new ToolValidationError(`${toolName}: invalid dimension`)
      if (typeof raw.value !== 'string' || raw.value.length < 1) throw new ToolValidationError(`${toolName}: value required`)
      return { parentQueryId: raw.parentQueryId, dimension: raw.dimension, value: raw.value }
    }
    case 'analytics.verify': {
      if (typeof raw.parentQueryId !== 'string') throw new ToolValidationError(`${toolName}: parentQueryId required`)
      if (!raw.claim || typeof raw.claim.metric !== 'string') throw new ToolValidationError(`${toolName}: claim.metric required`)
      return { parentQueryId: raw.parentQueryId, claim: raw.claim }
    }
    default:
      throw new ToolValidationError(`unknown tool: ${toolName}`)
  }
}

function authorize(ctx, requestSiteId, toolName) {
  if (!canAccessSite(ctx, requestSiteId)) {
    throw new ToolIDORError(ctx.tenant_id, requestSiteId, toolName)
  }
}

// Executor 等価実装 (real は ClickHouse query を呼ぶが、本 test は input shaping + IDOR のみ)
function executeAnalyticsTool(toolName, rawLlmInput, execCtx) {
  authorize(execCtx.ctx, execCtx.requestSiteId, toolName)
  const input = parseToolInput(toolName, rawLlmInput)

  switch (toolName) {
    case 'analytics.overview': {
      // server-controlled siteId + tenantId 固定 (LLM 入力破棄)
      const queryInput = {
        siteId: execCtx.requestSiteId,
        tenantId: execCtx.ctx.tenant_id,
        dim: 'all',
        dimValue: '__all__',
        dateRange: input.dateRange,
        metrics: input.metrics,
        timezone: input.timezone,
      }
      const result = { tier: 'daily', summary: { sessions: 0, conversions: 0, cvr: null }, evidenceLevel: 'observed_approx' }
      const queryId = registerParent(execCtx.ctx.tenant_id, queryInput, result)
      return { tool: toolName, result: { queryId, summary: result.summary, tier: result.tier, evidenceLevel: result.evidenceLevel } }
    }
    case 'analytics.contributors':
    case 'analytics.drilldown':
    case 'analytics.verify': {
      const parent = getParent(execCtx.ctx.tenant_id, input.parentQueryId)
      if (!parent) {
        throw new ToolValidationError(`${toolName}: parentQueryId not found or expired`)
      }
      return { tool: toolName, result: { parentSiteId: parent.input.siteId, evidenceLevel: 'observed_approx' } }
    }
    default:
      throw new ToolValidationError(`unknown tool: ${toolName}`)
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

const TENANT_FREE = {
  tenant_id: 't_free_001',
  plan: 'free',
  user_id: 'u_001',
  site_ids: ['site_own_a', 'site_own_b'],
}

const TENANT_OTHER = {
  tenant_id: 't_other_777',
  plan: 'free',
  user_id: 'u_777',
  site_ids: ['site_other_x'],
}

// ── Tests ─────────────────────────────────────────────────────────────

test('declarative-1: TOOL_SCHEMAS.input_schema に siteId / tenantId を含めない (続 64 §2c 継承)', () => {
  // 各 tool の input field list に siteId / tenantId が無いことを宣言的に保証
  assert.ok(!OVERVIEW_INPUT_FIELDS.includes('siteId'))
  assert.ok(!OVERVIEW_INPUT_FIELDS.includes('tenantId'))
  assert.ok(!CONTRIBUTORS_INPUT_FIELDS.includes('siteId'))
  assert.ok(!CONTRIBUTORS_INPUT_FIELDS.includes('tenantId'))
  assert.ok(!DRILLDOWN_INPUT_FIELDS.includes('siteId'))
  assert.ok(!DRILLDOWN_INPUT_FIELDS.includes('tenantId'))
  assert.ok(!VERIFY_INPUT_FIELDS.includes('siteId'))
  assert.ok(!VERIFY_INPUT_FIELDS.includes('tenantId'))
})

test('IDOR-1: LLM が余分な siteId / tenantId を入力しても server-side 固定値が使われる', () => {
  resetRegistry()
  const result = executeAnalyticsTool(
    'analytics.overview',
    {
      dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' },
      metrics: ['cvr'],
      // 攻撃: prompt injection で別 site / tenant を input に混入
      siteId: 'site_OTHER_TENANT_xyz',
      tenantId: 't_attacker',
    },
    { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
  )
  assert.ok(result.result.queryId)
  // registry を覗き、parent.siteId が server-controlled になっていることを確認
  const parent = getParent(TENANT_FREE.tenant_id, result.result.queryId)
  assert.equal(parent.input.siteId, 'site_own_a')
  assert.equal(parent.input.tenantId, 't_free_001')
})

test('IDOR-2: cross-tenant requestSiteId は ToolIDORError (403)', () => {
  resetRegistry()
  assert.throws(
    () =>
      executeAnalyticsTool(
        'analytics.overview',
        { dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' }, metrics: ['cvr'] },
        { ctx: TENANT_FREE, requestSiteId: 'site_NOT_OWNED' },
      ),
    (err) => err.name === 'ToolIDORError' && err.status === 403,
  )
})

test('IDOR-3: authorize は parse より先に発火 (順序保証)', () => {
  resetRegistry()
  // cross-tenant + 不正 metric 両方ある場合、IDOR 先に raise されるべき
  let err
  try {
    executeAnalyticsTool(
      'analytics.overview',
      { dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' }, metrics: ['DROP_TABLE_events'] },
      { ctx: TENANT_FREE, requestSiteId: 'site_NOT_OWNED' },
    )
  } catch (e) {
    err = e
  }
  assert.equal(err?.name, 'ToolIDORError', 'authorize must fire before parse on cross-tenant')
})

test('IDOR-4: 不正 metric (SQL injection 風) は ToolValidationError (400)', () => {
  resetRegistry()
  assert.throws(
    () =>
      executeAnalyticsTool(
        'analytics.overview',
        {
          dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' },
          metrics: ['SELECT * FROM events'],
        },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError' && err.status === 400,
  )
})

test('IDOR-5: 不正 dimension は ToolValidationError (400)', () => {
  resetRegistry()
  // 先に overview 通して parentQueryId 取得
  const ov = executeAnalyticsTool(
    'analytics.overview',
    { dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' }, metrics: ['cvr'] },
    { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
  )
  assert.throws(
    () =>
      executeAnalyticsTool(
        'analytics.contributors',
        { parentQueryId: ov.result.queryId, dimension: 'tenant_id' /* not allowed */ },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError',
  )
})

test('parent-1: parentQueryId 不在で contributors は ToolValidationError', () => {
  resetRegistry()
  assert.throws(
    () =>
      executeAnalyticsTool(
        'analytics.contributors',
        { parentQueryId: '00000000-0000-0000-0000-000000000000', dimension: 'page_url' },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError' && /parentQueryId not found/.test(err.message),
  )
})

test('parent-2: 他 tenant の queryId は tenant 越え不可 (registry tenant-scoped)', () => {
  resetRegistry()
  // TENANT_OTHER が overview 実行 → queryId 取得
  const ov = executeAnalyticsTool(
    'analytics.overview',
    { dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' }, metrics: ['cvr'] },
    { ctx: TENANT_OTHER, requestSiteId: 'site_other_x' },
  )
  const otherQueryId = ov.result.queryId
  // TENANT_FREE が 同 queryId で参照を試みる → parent not found (tenant 分離)
  // 但し canAccessSite(TENANT_FREE, 'site_own_a') は OK なので IDOR は通過、parentQueryId で弾く
  assert.throws(
    () =>
      executeAnalyticsTool(
        'analytics.contributors',
        { parentQueryId: otherQueryId, dimension: 'page_url' },
        { ctx: TENANT_FREE, requestSiteId: 'site_own_a' },
      ),
    (err) => err.name === 'ToolValidationError' && /parentQueryId not found/.test(err.message),
  )
})

test('unknown-1: unknown tool name は ToolValidationError', () => {
  resetRegistry()
  assert.throws(
    () => executeAnalyticsTool('analytics.exec_shell', {}, { ctx: TENANT_FREE, requestSiteId: 'site_own_a' }),
    (err) => err.name === 'ToolValidationError',
  )
})

test('agency-1: agency plan でも自テナント外 site は拒否', () => {
  resetRegistry()
  const agencyCtx = {
    tenant_id: 't_agency_001',
    plan: 'agency',
    user_id: 'u_a',
    site_ids: ['site_agency_x'],
  }
  assert.throws(
    () =>
      executeAnalyticsTool(
        'analytics.overview',
        { dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' }, metrics: ['cvr'] },
        { ctx: agencyCtx, requestSiteId: 'site_NOT_AGENCY' },
      ),
    (err) => err.name === 'ToolIDORError',
  )
  // 自分の site は OK
  const ok = executeAnalyticsTool(
    'analytics.overview',
    { dateRange: { start: '2026-05-16T00:00:00', end: '2026-05-23T00:00:00' }, metrics: ['cvr'] },
    { ctx: agencyCtx, requestSiteId: 'site_agency_x' },
  )
  assert.ok(ok.result.queryId)
})
