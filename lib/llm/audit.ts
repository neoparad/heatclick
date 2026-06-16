/**
 * lib/llm/audit.ts — LLM Audit Ledger logging (続 68 W2-A、続 66 §3 M-6)
 *
 * 親 SSOT §3.8.1 tenant isolation / CLAUDE.md tenant isolation
 * 配備根拠: 続 66 §2 Layer 1 #9 (Codex Round 3 発見、B2B audit + cost tracking + cache tuning foundation)
 *
 * 目的:
 *   全 chat / orchestrator / tool 呼出の完全 audit trail を `clickinsight.llm_audit_ledger`
 *   (Infra 続 67 D-2 配備予定) に書き込む。INSERT-only user (`chat_writer`) で接続。
 *
 *   記録内容:
 *     - tenant / user / conversation / message index / prompt version
 *     - model id (executor) + classifier model id
 *     - intent category + template id + tool call list + parent query id + evidence hashes
 *     - cache decision (hit/miss/template/bypass) + cache similarity
 *     - input/output tokens + cost USD
 *     - TTFT (ms) + end-to-end latency (ms)
 *     - answer validation result (pass/repair/fail) + evidence_level (5-tier)
 *     - error code (任意)
 *
 *   コスト最適化:
 *     - fire-and-forget INSERT (chat response の latency に影響させない)
 *     - 失敗時は console.error のみ (Sentry breadcrumb 経由)、chat 応答を失敗させない
 *
 * Sprint 3 W2-A (続 68) で `runChatCompletion()` / `executeChat()` から呼ぶフロー:
 *   const startedAt = Date.now()
 *   const result = await orchestrator.run(...)
 *   void logAuditEntry({ ...buildAuditEntry(ctx, result, Date.now() - startedAt) })  // fire-and-forget
 *
 * Infra 続 67 D-2 schema (`clickinsight.llm_audit_ledger`、想定):
 *   - id UUID DEFAULT generateUUIDv4()
 *   - tenant_id LowCardinality(String), site_id String, user_id String
 *   - conversation_id String, message_index UInt32
 *   - prompt_version LowCardinality(String)
 *   - model_id LowCardinality(String), classifier_model_id LowCardinality(String) NULL
 *   - intent_category LowCardinality(String) NULL, template_id LowCardinality(String) NULL
 *   - tool_calls Array(String), parent_query_id String NULL
 *   - evidence_hashes Array(String)
 *   - cache_decision LowCardinality(String), cache_similarity Float32 NULL
 *   - input_tokens UInt32, output_tokens UInt32, cost_usd Float64
 *   - ttft_ms UInt32 NULL, latency_ms UInt32
 *   - answer_validation_result LowCardinality(String), evidence_level LowCardinality(String)
 *   - error_code LowCardinality(String) NULL
 *   - created_at DateTime DEFAULT now()
 */

import { createHash } from 'node:crypto'

import { getClickHouseClient } from '@/lib/clickhouse'
import { redactForTelemetry } from '@/lib/llm/tools'
import type { EvidenceLevelV2 } from '@/types/evidence'

// ── Type definitions ────────────────────────────────────────────────

export type CacheDecision = 'hit' | 'miss' | 'template' | 'bypass'
export type AnswerValidationResult = 'pass' | 'repair' | 'fail'

export interface AuditEntryInput {
  tenantId: string
  siteId: string
  userId: string
  conversationId: string
  messageIndex: number
  /** prompt SSOT version (e.g., 'analyst-v1.0.0'、`lib/llm/orchestrator.ts` で管理) */
  promptVersion: string
  /** Executor model id (Gateway 形式、e.g., 'anthropic/claude-sonnet-4-5-20250929') */
  modelId: string
  /** Classifier model id (Haiku 等、未使用なら null) */
  classifierModelId: string | null
  intentCategory: string | null
  templateId: string | null
  /** Tool 呼出順序 (e.g., ['analytics.overview', 'analytics.contributors']) */
  toolCalls: string[]
  parentQueryId: string | null
  /** 各 evidence の content_hash (PII を含まない、cache 同値判定用) */
  evidenceHashes: string[]
  cacheDecision: CacheDecision
  cacheSimilarity: number | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  ttftMs: number | null
  latencyMs: number
  answerValidationResult: AnswerValidationResult
  evidenceLevel: EvidenceLevelV2
  /** Error code (e.g., 'TOOL_IDOR'、'LLM_RUNTIME_CONFIG')、成功時 null */
  errorCode: string | null
}

/**
 * Evidence content hash 生成 (cache tuning 用、PII を含まない)。
 * - input は `redactForTelemetry()` で PII 除去後に SHA-256
 * - 4000 char clip 後の文字列を hash 入力
 * - 16 hex 文字に truncate (cache key として十分な衝突耐性)
 */
export function hashEvidence(input: unknown): string {
  const safe = redactForTelemetry(input)
  return createHash('sha256').update(safe).digest('hex').slice(0, 16)
}

// ── Fire-and-forget INSERT ──────────────────────────────────────────

/**
 * Audit entry を `llm_audit_ledger` に INSERT。
 *
 * **fire-and-forget**: 呼出側で `void logAuditEntry(...)` または `.catch(() => {})` で
 * promise を破棄する。chat response の latency に影響させないこと。
 *
 * 失敗時の挙動 (production):
 *   - console.error で観測 (Sentry breadcrumb 経由で alert)
 *   - chat 応答自体は失敗させない (audit 失敗 = severe だが degraded mode で稼働継続)
 *
 * Infra 続 67 D-2/D-3 未着地時:
 *   - `chat_writer` user の credentials が未配備 → default credentials に fallback (warn ログ)
 *   - table が未配備 → INSERT 自体が失敗、console.error のみ
 *   - 本実装は **schema 投入後にそのまま稼働** するよう書く (両 case で safe)
 */
export async function logAuditEntry(entry: AuditEntryInput): Promise<void> {
  try {
    const client = getClickHouseClient('chat_writer')

    // ClickHouse INSERT 用 row (snake_case + 型整合)
    const row = {
      tenant_id: entry.tenantId,
      site_id: entry.siteId,
      user_id: entry.userId,
      conversation_id: entry.conversationId,
      message_index: entry.messageIndex,
      prompt_version: entry.promptVersion,
      model_id: entry.modelId,
      classifier_model_id: entry.classifierModelId,
      intent_category: entry.intentCategory,
      template_id: entry.templateId,
      tool_calls: entry.toolCalls,
      parent_query_id: entry.parentQueryId,
      evidence_hashes: entry.evidenceHashes,
      cache_decision: entry.cacheDecision,
      cache_similarity: entry.cacheSimilarity,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cost_usd: entry.costUsd,
      ttft_ms: entry.ttftMs,
      latency_ms: entry.latencyMs,
      answer_validation_result: entry.answerValidationResult,
      evidence_level: entry.evidenceLevel,
      error_code: entry.errorCode,
    }

    await client.insert({
      table: 'llm_audit_ledger',
      values: [row],
      format: 'JSONEachRow',
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    // raw entry を log に流すと PII 流出経路になり得るため、entry の安全 fields のみ出力
    console.error(
      `[llm_audit_ledger] INSERT failed: tenant=${entry.tenantId} conv=${entry.conversationId} ` +
        `tool_calls=[${entry.toolCalls.join(',')}] error=${msg}`,
    )
  }
}

/**
 * 部分 fields から AuditEntryInput を組み立てる helper。
 * 未指定 field には sensible default を補う (orchestrator 側の boilerplate を減らす)。
 */
export function buildAuditEntry(
  partial: Partial<AuditEntryInput> & {
    tenantId: string
    siteId: string
    userId: string
    conversationId: string
    modelId: string
    latencyMs: number
  },
): AuditEntryInput {
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
