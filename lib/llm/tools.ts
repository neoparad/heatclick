/**
 * lib/llm/tools.ts — LLM tool calling (IDOR 防御 + telemetry PII 排除) (続 64)
 *
 * 親 SSOT §3.8.1 tenant isolation / CLAUDE.md "Tenant Isolation"
 * 配備根拠: 続 61 §2 (c) Reviewer Codex GREEN 条件付き、W2 着工前完了条件
 *
 * 目的 (Codex 改善依頼 (c) 1:1 対応):
 *   1. tool input の `siteId` を **LLM 出力から採用しない**
 *      → request body の検証済 `siteId` を server-side で **固定** (override)
 *   2. 各 tool execute で `canAccessSite(ctx, siteId)` を再認可必須
 *   3. AI SDK telemetry に prompt/toolCalls を記録する際の PII 排除
 *   4. IDOR 防御の単体テスト (`tests/unit/chat-tool-idor.test.mjs`) で
 *      cross-tenant access が 403 に倒れることを保証
 *
 * 脅威モデル:
 *   - 攻撃面: prompt injection で LLM が `siteId: 'site_OTHER_TENANT_xyz'` を tool input に出す
 *   - 対策 1: input schema に `siteId` を入れない (declarative defense)
 *   - 対策 2: 仮に入っても `executeTool()` が **request-body siteId で上書き**
 *   - 対策 3: `canAccessSite(ctx, fixedSiteId)` で多層認可 (token site_ids との照合)
 *
 * Sprint 3 W2 (続 65+) で `runChatCompletion()` から呼ぶ流れ:
 *   1. LLM が tool call 要求 (e.g., `fetch_clickhouse_data({metric:"cvr"})`)
 *   2. `executeTool(name, llmInput, ctx, requestSiteId)` を呼ぶ
 *      ※ `requestSiteId` は **必ず request body の検証済値** を渡す
 *   3. tool 内で再認可 → ClickHouse query 実行 → 結果サニタイズ → 返却
 */

import { canAccessSite, type TenantContext } from '@/lib/tenant'

// ── Tool registry ────────────────────────────────────────────────────

/**
 * 想定 metric / dimension。LLM が任意文字列を出さないよう enum 化 (続 61 §1 観点 4 / 続 60)。
 * ClickHouse query 側は `buildTenantQuery()` + parameter binding で SQL injection 経路ゼロ。
 */
export const ALLOWED_METRICS = [
  'cvr',
  'bounce_rate',
  'page_views',
  'session_duration',
  'persona_dist',
] as const
export type AllowedMetric = (typeof ALLOWED_METRICS)[number]

export const ALLOWED_DIMENSIONS = ['page_url', 'device', 'persona', 'time'] as const
export type AllowedDimension = (typeof ALLOWED_DIMENSIONS)[number]

/** periodDays 上限 (続 61 §1 観点 4) */
export const MAX_PERIOD_DAYS = 90

/**
 * Tool 公開 schema (Anthropic / AI SDK 両対応の input_schema 形式)。
 *
 * **重要**: `siteId` を properties に含めない。
 * - LLM tool input から `siteId` を採用しない宣言的防御 (declarative defense)
 * - 仮に LLM が余分な `siteId` を吐いても `executeTool()` で上書きされる
 */
export const TOOL_SCHEMAS = [
  {
    name: 'fetch_clickhouse_data',
    description:
      'Query ClickHouse for aggregated events / sessions / conversions for the active site. ' +
      'siteId is server-controlled (do NOT include in tool input).',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: [...ALLOWED_METRICS] },
        dimension: { type: 'string', enum: [...ALLOWED_DIMENSIONS] },
        periodDays: { type: 'number', minimum: 1, maximum: MAX_PERIOD_DAYS },
      },
      required: ['metric', 'periodDays'],
      additionalProperties: false,
    },
  },
] as const

// ── Errors ───────────────────────────────────────────────────────────

export class ToolIDORError extends Error {
  public readonly code = 'TOOL_IDOR'
  public readonly status = 403

  constructor(
    public readonly tenant_id: string,
    public readonly attemptedSiteId: string,
    public readonly toolName: string,
  ) {
    super(
      `Tool '${toolName}' IDOR rejection: tenant '${tenant_id}' may not access site '${attemptedSiteId}'`,
    )
    this.name = 'ToolIDORError'
  }
}

export class ToolValidationError extends Error {
  public readonly code = 'TOOL_VALIDATION'
  public readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = 'ToolValidationError'
  }
}

// ── Sanitized tool input (LLM input → server-controlled normalized input) ──

export interface SanitizedFetchClickhouseInput {
  metric: AllowedMetric
  dimension: AllowedDimension | null
  /** server-side で固定された siteId (LLM 出力からは採用しない) */
  siteId: string
  periodDays: number
}

/**
 * LLM tool input を **server-controlled siteId で上書き** しつつ正規化する。
 *
 * 入力ルール:
 *   - `metric` は ALLOWED_METRICS のみ
 *   - `dimension` は ALLOWED_DIMENSIONS or 省略
 *   - `periodDays` は 1..MAX_PERIOD_DAYS
 *   - LLM が `siteId` を含んでいても **破棄** (server-side `fixedSiteId` で上書き)
 *
 * @throws ToolValidationError 不正 metric/dimension/periodDays のとき
 */
export function sanitizeFetchClickhouseInput(
  rawLlmInput: unknown,
  fixedSiteId: string,
): SanitizedFetchClickhouseInput {
  if (!rawLlmInput || typeof rawLlmInput !== 'object') {
    throw new ToolValidationError('tool input must be an object')
  }
  const input = rawLlmInput as Record<string, unknown>

  const metric = input.metric
  if (typeof metric !== 'string' || !(ALLOWED_METRICS as readonly string[]).includes(metric)) {
    throw new ToolValidationError(
      `tool input 'metric' must be one of [${ALLOWED_METRICS.join(', ')}]`,
    )
  }

  const dimensionRaw = input.dimension
  let dimension: AllowedDimension | null = null
  if (dimensionRaw !== undefined && dimensionRaw !== null) {
    if (
      typeof dimensionRaw !== 'string' ||
      !(ALLOWED_DIMENSIONS as readonly string[]).includes(dimensionRaw)
    ) {
      throw new ToolValidationError(
        `tool input 'dimension' must be one of [${ALLOWED_DIMENSIONS.join(', ')}]`,
      )
    }
    dimension = dimensionRaw as AllowedDimension
  }

  const periodDaysRaw = input.periodDays
  if (
    typeof periodDaysRaw !== 'number' ||
    !Number.isInteger(periodDaysRaw) ||
    periodDaysRaw < 1 ||
    periodDaysRaw > MAX_PERIOD_DAYS
  ) {
    throw new ToolValidationError(
      `tool input 'periodDays' must be an integer in [1, ${MAX_PERIOD_DAYS}]`,
    )
  }

  // siteId は LLM 出力を **完全無視**、server-controlled 値で固定
  return {
    metric: metric as AllowedMetric,
    dimension,
    siteId: fixedSiteId,
    periodDays: periodDaysRaw,
  }
}

// ── Authorization gate (IDOR 防御の中核) ──────────────────────────────

/**
 * tool execute 前に必ず呼ぶ authorization gate。
 * - `fixedSiteId` (server-side) が tenant の site_ids に含まれることを再確認
 * - 違反時は `ToolIDORError` (status 403) を throw
 *
 * 注意: `fixedSiteId` は **必ず request body から取得した検証済値** であること。
 *      LLM tool input の siteId を渡してはいけない (型の上では string なので
 *      呼び出し規約として `executeTool()` 経由のみ許可)。
 */
export function authorizeToolCall(
  ctx: TenantContext,
  fixedSiteId: string,
  toolName: string,
): void {
  if (!canAccessSite(ctx, fixedSiteId)) {
    throw new ToolIDORError(ctx.tenant_id, fixedSiteId, toolName)
  }
}

// ── Telemetry redaction (PII 排除) ────────────────────────────────────

/**
 * AI SDK telemetry / Sentry / pino に prompt / tool input / tool output を記録する際の PII 排除。
 *
 * 排除対象:
 *   - email (RFC 5322 簡易)
 *   - 電話番号 (日本 + 国際フォーマット)
 *   - 16 桁以上の連続数字 (クレジットカード / 個人番号)
 *   - URL の query string (UTM 以外の任意 token / session token が含まれ得る)
 *
 * 維持対象:
 *   - tenant_id / site_id / metric 名 (運用観測に必要、PII ではない)
 *   - SQL parameter 名 (`{tenant_id:String}` 等)
 *
 * Sentry breadcrumb 制約 (~8KB) を踏まえ、redacted 後に 4000 文字でクリップ。
 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g
const LONG_DIGITS_RE = /\d{16,}/g
const URL_QUERY_RE = /(https?:\/\/[^\s?]+)\?[^\s"'`]+/g

const MAX_REDACTED_LEN = 4000

export function redactForTelemetry(input: unknown): string {
  let s: string
  if (typeof input === 'string') {
    s = input
  } else {
    try {
      s = JSON.stringify(input)
    } catch {
      s = String(input)
    }
  }
  // 順序重要: 16+digits を phone より先に redact しないと
  // 16+digits も PHONE_RE (`\d{7,}` を含む) にマッチしてしまう (test redact-1 で確認済)
  s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]')
  s = s.replace(LONG_DIGITS_RE, '[REDACTED_DIGITS]')
  s = s.replace(PHONE_RE, '[REDACTED_PHONE]')
  s = s.replace(URL_QUERY_RE, '$1?[REDACTED_QUERY]')
  if (s.length > MAX_REDACTED_LEN) {
    s = s.slice(0, MAX_REDACTED_LEN) + `…[truncated ${s.length - MAX_REDACTED_LEN}c]`
  }
  return s
}

// ── Executor ─────────────────────────────────────────────────────────

export interface ToolExecuteContext {
  ctx: TenantContext
  /** request body から検証済 siteId (LLM 入力から採用しない、必ず server-controlled) */
  requestSiteId: string
}

export interface ToolExecuteResult {
  toolName: string
  /** server-controlled input (sanitized + siteId override 後) */
  sanitizedInput: SanitizedFetchClickhouseInput
  /**
   * tool 実行結果。W2 で ClickHouse query 実装と差し替え。
   * 現在は stub: shape 検証可能な空結果を返す (E2E + IDOR test 用)。
   */
  result: { metric: AllowedMetric; rows: ReadonlyArray<Record<string, unknown>> }
}

/**
 * tool 実行 entrypoint。LLM の tool call 要求を受けて:
 *   1. server-controlled `requestSiteId` で IDOR 認可 (失敗 → 403 throw)
 *   2. LLM input を sanitize (siteId 上書き、metric/dimension/periodDays 検証)
 *   3. (W2) ClickHouse query 実行 + PII redaction + 結果返却
 *      現在は stub: shape 検証のみ
 *
 * Sprint 3 W2 着工後、ClickHouse query は `buildTenantQuery()` + parameter binding で実装する
 * (続 61 §1 観点 4 / Codex Round 8 Fix 5 整合)。
 *
 * @throws ToolIDORError cross-tenant access のとき (status 403 で API 返却)
 * @throws ToolValidationError tool input が不正なとき (status 400)
 */
export function executeTool(
  toolName: string,
  rawLlmInput: unknown,
  execCtx: ToolExecuteContext,
): ToolExecuteResult {
  // (1) 認可 (server-controlled siteId のみで判定、LLM 入力を信用しない)
  authorizeToolCall(execCtx.ctx, execCtx.requestSiteId, toolName)

  // (2) tool dispatch
  switch (toolName) {
    case 'fetch_clickhouse_data': {
      const sanitized = sanitizeFetchClickhouseInput(rawLlmInput, execCtx.requestSiteId)
      // 二重防御: sanitized.siteId は requestSiteId と一致するはず
      if (sanitized.siteId !== execCtx.requestSiteId) {
        throw new ToolIDORError(execCtx.ctx.tenant_id, sanitized.siteId, toolName)
      }
      // W2 で ClickHouse query 実装 (本ファイルでは stub に留める)
      return {
        toolName,
        sanitizedInput: sanitized,
        result: { metric: sanitized.metric, rows: [] },
      }
    }
    default:
      throw new ToolValidationError(`unknown tool: ${toolName}`)
  }
}
