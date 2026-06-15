/**
 * POST /api/chat — UGOKIMAP AI chat endpoint (Sprint 3 W2-A、続 68 / 続 66 §3 M-4+M-7+M-8)
 *
 * 親 SSOT §1.6 原則 2 / §1.8.2 / D-07 / §3.8.1 tenant isolation
 * 配備履歴:
 *   - 続 54 §2.2 (Director dispatch)
 *   - 続 57 (Sprint 3 W1 ML stub)
 *   - 続 64 (W2 hardening: assertLLMRuntimeConfig 結線、env 名統一)
 *   - 続 68 (W2-A: Multi-LLM orchestrator + rate limit + chat_conversations INSERT)
 *
 * 実装スコープ (Sprint 3 W2-A):
 *   - Body validation (Zod)
 *   - tenant context (middleware の x-tenant-id / x-site-ids 必須、Phase 1 multi-tenant isolation)
 *   - site access check (`canAccessSite`)
 *   - LLM runtime config fail-fast (続 64 §2a)
 *   - Per-tenant rate limit 60 req/h (続 68 M-7)
 *   - Orchestrator dispatch (続 68 M-4): template + 4 tools + Zod validation + repair
 *   - Audit ledger logging (続 68 M-6) fire-and-forget
 *   - chat_conversations INSERT (続 68 M-8、Infra 続 62 配備 table 利用) fire-and-forget
 *
 * Sprint 3 W2-B (続 70+ 予定):
 *   - SSE streaming (Frontend F-1 と integrate)
 *   - 既存会話履歴の前処理 (chat_conversations SELECT で previous messages 取得)
 *   - Semantic cache (M-10) hit 時の short-circuit
 *
 * セキュリティ:
 *   - ANTHROPIC_API_KEY / AI_GATEWAY_API_KEY は .env.local のみ、git コミット禁止
 *     (env 名は続 61 §3 (d) で Vercel 標準 `AI_GATEWAY_API_KEY` に統一済、続 64 で .env.example 反映)
 *   - LLM プロンプト変更は T1 critical (続 54 §5 [→ML]、Codex dual review 必須)
 *   - reply 中の数値断定は inferred / planned で禁止 (D-07、components/dashboard/evidence-badge.tsx 整合)
 *   - production 起動時 fail-fast: `assertLLMRuntimeConfig()` で mode != 'ai-gateway' を弾く (続 64)
 *   - Rate limit 60 req/h/tenant で abuse 防御 + LLM コスト ceiling (続 66 §3 M-7)
 */

import { randomUUID } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { canAccessSite, getTenantContext, type TenantContext } from '@/lib/tenant'
import { assertLLMRuntimeConfig, LLMRuntimeConfigError } from '@/lib/llm/gateway'
import {
  CHAT_RATE_LIMIT_PER_HOUR,
  checkChatRateLimit,
} from '@/lib/llm/chat-rate-limit'
import { executeChat, logOrchestratorAudit } from '@/lib/llm/orchestrator'
import { getClickHouseClient } from '@/lib/clickhouse'
import type { ChatReply } from '@/types/evidence'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Request schema ────────────────────────────────────────────────────

const BodySchema = z.object({
  /** 既存会話を継続する場合に echo。新規会話は省略 */
  conversationId: z.string().uuid().optional(),
  /** ユーザー入力。空文字 / 4000 字超は reject */
  message: z.string().min(1).max(4000),
  /** 対象サイト。middleware で tenant の site_ids に含まれることを後段で検証 */
  siteId: z.string().min(1).max(128),
  /** 分析期間 (日)。既定 7、最大 90 (UI mock 整合) */
  periodDays: z.number().int().min(1).max(90).default(7),
  /** 会話内 message index (Frontend が送る、未指定なら 0 として audit ledger に記録) */
  messageIndex: z.number().int().min(0).max(10_000).default(0),
})

// ── Helpers ───────────────────────────────────────────────────────────

function badRequest(message: string, code = 'BAD_REQUEST'): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status: 400 },
  )
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
    { status: 401 },
  )
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: 'TENANT_FORBIDDEN', message: 'site not in tenant' } },
    { status: 403 },
  )
}

function tooManyRequests(retryAfterSec: number, remaining: number, limit: number): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Chat rate limit ${limit} req/h exceeded. Retry after ${retryAfterSec}s.`,
      },
      meta: { remaining, limit, retryAfterSec },
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': String(remaining),
      },
    },
  )
}

// ── Route handler ─────────────────────────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
  // 0. LLM runtime config の fail-fast (続 64、続 61 §2 (a)):
  //    - production では LLM_PROVIDER_MODE=ai-gateway + AI_GATEWAY_API_KEY 必須
  //    - request 時の二重防御 (instrumentation.ts でも起動時に呼ぶ予定、W2-B)
  try {
    assertLLMRuntimeConfig()
  } catch (err) {
    if (err instanceof LLMRuntimeConfigError) {
      console.error(`[/api/chat] LLM runtime config error: ${err.message}`)
      return NextResponse.json(
        {
          success: false,
          error: { code: 'LLM_RUNTIME_CONFIG', message: 'LLM runtime is not configured' },
        },
        { status: 503 },
      )
    }
    throw err
  }

  // 1. tenant 検証 (middleware が x-tenant-id / x-site-ids 注入済)
  const ctx = await getTenantContext()
  if (!ctx) return unauthorized()

  // 2. body parse + validation
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }
  const parsed = BodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'invalid body', 'VALIDATION')
  }
  const body = parsed.data

  // 3. tenant の site_ids に含まれることを検証 (middleware は query 経路のみ強制)
  if (!canAccessSite(ctx, body.siteId)) {
    return forbidden()
  }

  // 4. Per-tenant rate limit (続 68 M-7、60 req/h/tenant)
  //    plan-based rate limit (lib/rate-limit.ts) は middleware で別途 enforce (将来 wire)。
  //    本ハンドラは chat 専用 60 req/h で LLM cost ceiling + abuse 防御。
  const rl = await checkChatRateLimit(ctx.tenant_id)
  if (!rl.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((rl.resetTime - Date.now()) / 1000))
    return tooManyRequests(retryAfterSec, rl.remaining, rl.limit)
  }

  // 5. Orchestrator dispatch (続 68 M-4)
  const conversationId = body.conversationId ?? randomUUID()
  const orchestratorInput = {
    message: body.message,
    siteId: body.siteId,
    periodDays: body.periodDays,
    conversationId,
    messageIndex: body.messageIndex,
  }

  let chatReply: ChatReply
  let auditOutput: Awaited<ReturnType<typeof executeChat>>
  try {
    auditOutput = await executeChat(orchestratorInput, ctx)
    chatReply = auditOutput.reply
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[/api/chat] orchestrator failed: ${msg}`)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'ORCHESTRATOR_FAILED',
          message: 'chat orchestrator failed (degraded mode, please retry)',
        },
      },
      { status: 502 },
    )
  }

  // 6. Audit ledger logging (続 68 M-6) — fire-and-forget
  try {
    logOrchestratorAudit({
      output: auditOutput,
      ctx,
      input: orchestratorInput,
    })
  } catch (err: unknown) {
    // logOrchestratorAudit 自体は throw しない実装だが defensive に catch
    console.error('[/api/chat] audit emit failed (non-blocking):', err)
  }

  // 7. chat_conversations INSERT (続 68 M-8) — fire-and-forget
  //    Infra 続 62 配備 `clickinsight.chat_conversations` table 利用。
  //    W2-B で previous messages 取得 + append into messages JSON へ拡張予定 (現状は新規 row 1 件)。
  void persistChatConversation({
    ctx,
    siteId: body.siteId,
    conversationId,
    userMessage: body.message,
    assistantReply: chatReply,
  })

  // 8. Response
  return NextResponse.json(
    { success: true, data: chatReply },
    {
      headers: {
        'X-RateLimit-Limit': String(CHAT_RATE_LIMIT_PER_HOUR),
        'X-RateLimit-Remaining': String(rl.remaining),
      },
    },
  )
}

// ── chat_conversations INSERT (M-8) ─────────────────────────────────

async function persistChatConversation(params: {
  ctx: TenantContext
  siteId: string
  conversationId: string
  userMessage: string
  assistantReply: ChatReply
}): Promise<void> {
  try {
    const client = getClickHouseClient('chat_writer')
    const messages = JSON.stringify([
      { role: 'user', content: params.userMessage },
      {
        role: 'assistant',
        content: params.assistantReply.reply,
        evidenceLevel: params.assistantReply.evidenceLevel,
        evidence: params.assistantReply.evidence,
        suggestions: params.assistantReply.suggestions,
        modelMeta: params.assistantReply.modelMeta,
      },
    ])
    const nowIso = new Date().toISOString().slice(0, 19)
    await client.insert({
      table: 'chat_conversations',
      values: [
        {
          id: params.conversationId,
          tenant_id: params.ctx.tenant_id,
          user_id: params.ctx.user_id,
          site_id: params.siteId,
          created_at: nowIso,
          updated_at: nowIso,
          messages,
        },
      ],
      format: 'JSONEachRow',
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(
      `[/api/chat] chat_conversations INSERT failed tenant=${params.ctx.tenant_id} conv=${params.conversationId}: ${msg}`,
    )
    // fire-and-forget、chat response 自体は成功させる
  }
}
