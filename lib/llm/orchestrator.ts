/**
 * lib/llm/orchestrator.ts — Multi-LLM Orchestrator (Haiku → Sonnet) (続 68 W2-A、続 66 §3 M-4)
 *
 * 親 SSOT §2.2.6 LLM 抽象化 / §3.5.2 routing
 * 配備根拠: 続 66 §2 Layer 1 #8 (Haiku classifier → Sonnet executor、コスト 20-45% 削減)
 *
 * 設計方針 (続 64 hardening 1:1 継承):
 *   - LLM_PROVIDER_MODE = 'ai-gateway' canonical 経路 (production 必須)
 *   - stub mode では template + tool dispatch のみで動作 (LLM call 発火しない)
 *   - tool call は `executeAnalyticsTool()` 経由で IDOR + Zod 防御済
 *   - ChatReply は `parseChatReply()` で機械検証 (失敗時 `coerceChatReply()` 1 回限定 retry)
 *   - 全 path で `logAuditEntry()` を fire-and-forget で呼ぶ (M-6)
 *
 * 本実装 (W2-A):
 *   - Stub mode + Rule-based template classifier で動作可能なフロー配備
 *   - 実 LLM call (Haiku classifier / Sonnet executor) は **skeleton** として配備
 *     production deploy 時に AI SDK v6 + Gateway integration で activate
 *   - tool plan DSL parser で `analytics.overview(7d, [cvr])` を分解実行
 *
 * Sprint 3 W2-B (続 70+) 拡張:
 *   - In-memory conversation cache (M-9)
 *   - Semantic cache + embedding match (M-10/M-11)
 *   - Code Interpreter for freeform (M-12)
 *
 * 注意:
 *   - 本ファイルは LLM call の **skeleton + tool dispatch + audit** を組み込む
 *   - production 起動時 `assertLLMRuntimeConfig()` を `app/api/chat/route.ts` 先頭で呼ぶこと
 *     (続 64 §2a fail-fast 継承)
 */

import { randomUUID } from 'node:crypto'

import { generateText, stepCountIs } from 'ai'

import type { TenantContext } from '@/lib/tenant'
import { getLLMProviderMode } from '@/lib/llm/anthropic'
import { getGatewayDefaultModel } from '@/lib/llm/gateway'
import {
  type AnalyticsToolName,
  type AnalyticsToolResult,
  executeAnalyticsTool,
} from '@/lib/llm/analytics-tools'
import {
  buildFreeformTools,
  type FreeformToolCall,
  type FreeformToolCollector,
} from '@/lib/llm/freeform-tools'
import { getSystemPromptWithSummary } from '@/lib/llm/daily-summary'
import {
  buildAuditEntry,
  hashEvidence,
  logAuditEntry,
  type CacheDecision,
} from '@/lib/llm/audit'
import {
  classifyQuestion,
  getTemplate,
  type QuestionTemplate,
} from '@/lib/llm/question-templates'
import {
  ChatReplyValidationError,
  checkChatReplySemantics,
  coerceChatReply,
  parseChatReply,
} from '@/lib/llm/chat-reply-validator'
import {
  type EvidenceLevel,
  type EvidenceLevelV2,
  reduceEvidenceLevelV2,
  toEvidenceLevelV1,
  toEvidenceLevelV2,
} from '@/types/evidence'
import type { ChatReply, EvidenceRef } from '@/types/evidence'

// ── Types ───────────────────────────────────────────────────────────

export interface OrchestratorInput {
  message: string
  siteId: string // server-controlled (caller 責務)
  periodDays: number
  conversationId: string
  messageIndex: number
}

export interface OrchestratorOutput {
  reply: ChatReply
  /** Audit ledger に流す内部 metadata (caller が fire-and-forget で log) */
  audit: {
    templateId: string | null
    intentCategory: string | null
    toolCalls: AnalyticsToolName[]
    parentQueryId: string | null
    evidenceHashes: string[]
    cacheDecision: CacheDecision
    cacheSimilarity: number | null
    inputTokens: number
    outputTokens: number
    costUsd: number
    ttftMs: number | null
    classifierModelId: string | null
    answerValidationResult: 'pass' | 'repair' | 'fail'
    evidenceLevelV2: EvidenceLevelV2
    errorCode: string | null
  }
}

export const ORCHESTRATOR_PROMPT_VERSION = 'analyst-v1.0.0-stub'

// ── Main entry ───────────────────────────────────────────────────────

/**
 * Chat orchestrator entry point.
 *
 * フロー:
 *   1. Rule-based template classifier (`classifyQuestion()`) で hit 判定
 *   2. template hit (confidence >= 0.75) → toolPlan 実行 → answerSkeleton 埋め → ChatReply
 *   3. confidence < 0.6 → Haiku classifier (stub では skip、production で Gateway call)
 *   4. template miss + Haiku unknown → Sonnet freeform (stub では generic reply)
 *   5. ChatReply は `parseChatReply()` で検証 → 失敗時 `coerceChatReply()` で 1 回 repair
 *   6. caller が `audit` metadata を fire-and-forget で `logAuditEntry()` に流す
 *
 * Production 起動時の挙動 (`LLM_PROVIDER_MODE=ai-gateway`):
 *   - template hit 時: tool 呼出 + skeleton fill のみ、LLM call なし (高速 path)
 *   - template miss 時: Haiku classifier + Sonnet freeform (本実装は W2-A skeleton、AI SDK v6 移行で完成)
 *
 * Stub mode の挙動 (dev / `LLM_PROVIDER_MODE=stub`):
 *   - template hit 時: tool 呼出は実行可能 (ClickHouse 接続あれば実 query 発火)
 *     ClickHouse 未配備 / Infra 続 67 未着地時は tool error → fallback reply
 *   - template miss 時: generic stub reply (LLM call ゼロ)
 */
export async function executeChat(
  input: OrchestratorInput,
  ctx: TenantContext,
): Promise<OrchestratorOutput> {
  const t0 = Date.now()
  const providerMode = getLLMProviderMode()

  // 続 82 Director hot fix Layer 2 (Owner 2026-05-25 07:48 報告対応):
  //   現状 Sprint 1 では tracking schema / metric / segment が限定的のため、
  //   一部の質問は「正しく答えられない」が「誤回答」してしまうケースがある。
  //   質問テキストから未対応 keyword を機械的に検出し、template 評価前に
  //   fail-fast で「現在未対応」を明示する誠実な reply を返す。
  //
  //   検出対象:
  //     - bounce/直帰/即離脱: is_bounce 列が events table に無い (続 78 Task B で metric 削除)
  //     - organic/オーガニック/referrer/utm/流入元: tracking-js が referrer を未記録
  //     - persona/ペルソナ/segment/セグメント: persona MV を 続 67 で削除
  //     - landing/ランディング/exit page/最終ページ: session flow tracking 未実装
  const unsupported = detectUnsupportedConcepts(input.message)
  if (unsupported.length > 0) {
    return buildUnsupportedReply(input, providerMode, t0, unsupported)
  }

  const classification = classifyQuestion(input.message)
  const template = classification.templateId ? getTemplate(classification.templateId) : null

  // template hit → toolPlan 実行
  if (template) {
    try {
      const out = await runTemplate({
        template,
        input,
        ctx,
        providerMode,
        startedAt: t0,
        confidence: classification.confidence,
      })
      return out
    } catch (err: unknown) {
      return buildErrorReply(input, ctx, providerMode, t0, err, {
        templateId: template.id,
        intentCategory: template.category,
        classifierModelId: 'rule-based-v1',
      })
    }
  }

  // template miss → freeform (ai-gateway では実 LLM、それ以外は stub fallback)
  return runFreeform({
    input,
    ctx,
    providerMode,
    startedAt: t0,
    classificationConfidence: classification.confidence,
  })
}

// ── Template path (toolPlan 実行 + skeleton fill) ──────────────────

interface RunTemplateParams {
  template: QuestionTemplate
  input: OrchestratorInput
  ctx: TenantContext
  providerMode: 'stub' | 'anthropic-direct' | 'ai-gateway'
  startedAt: number
  confidence: number
}

async function runTemplate(params: RunTemplateParams): Promise<OrchestratorOutput> {
  const { template, input, ctx, providerMode, startedAt, confidence } = params
  const toolCalls: AnalyticsToolName[] = []
  const toolResults: AnalyticsToolResult[] = []
  let parentQueryId: string | null = null

  // 直近 14 日デフォルトで dateRange (W2-B で template DSL から period 解釈)
  const dateRange = defaultDateRangeForPeriod(input.periodDays)

  for (const rawCall of template.toolPlan) {
    const parsed = parseToolPlanLine(rawCall)
    if (!parsed) continue

    toolCalls.push(parsed.name)

    // parentQueryId 注入 (overview 以外は parent 必須)
    const llmInput: Record<string, unknown> = { ...parsed.args }
    if (parsed.name !== 'analytics.overview' && parentQueryId) {
      llmInput.parentQueryId = parentQueryId
    }
    if (parsed.name === 'analytics.overview' && !llmInput.dateRange) {
      llmInput.dateRange = dateRange
    }
    if (parsed.name === 'analytics.overview' && !llmInput.timezone) {
      llmInput.timezone = 'Asia/Tokyo'
    }

    const result = await executeAnalyticsTool(parsed.name, llmInput, {
      ctx,
      requestSiteId: input.siteId,
    })
    toolResults.push(result)

    if (result.tool === 'analytics.overview') {
      parentQueryId = result.result.queryId
    }
  }

  // Build reply from skeleton + tool results
  const { replyText, evidenceLevelV2, evidence } = fillSkeleton({
    template,
    toolResults,
    siteId: input.siteId,
    periodDays: input.periodDays,
  })

  // 続 82 Director hot fix Layer 3 (Owner 2026-05-25 07:48 報告対応):
  //   classifier が誤 hit して全く違う回答を返すケース対策。
  //   reply 冒頭に「解釈した意図」を必ず明示 → Owner が即座に誤解を発見可能。
  //   confidence が低い場合 (< 0.95) は警告 emoji を付与し、確認を促す。
  const confidenceWarning = confidence < 0.95 ? ' ⚠️ 自信度低めです、意図が違う場合はより限定した質問にしてください' : ''
  const interpretationHeader = `[解釈] あなたの質問を「${template.intent}」と解釈しました (${(confidence * 100).toFixed(0)}%${confidenceWarning})\n\n`
  const replyTextWithHeader = interpretationHeader + replyText

  const reply: ChatReply = {
    conversationId: input.conversationId,
    reply: replyTextWithHeader,
    evidence,
    evidenceLevel: toEvidenceLevelV1(evidenceLevelV2),
    confidence: evidenceConfidenceFromLevel(evidenceLevelV2),
    suggestions: defaultSuggestions(template),
    modelMeta: buildModelMeta({ providerMode, startedAt }),
  }

  // Zod + semantic validation (続 64 §2b 継承)
  const { validated, answerValidationResult } = validateAndCoerce(reply)

  const evidenceHashes = toolResults.map((r) => hashEvidence({ tool: r.tool, result: r.result }))

  return {
    reply: validated,
    audit: {
      templateId: template.id,
      intentCategory: template.category,
      toolCalls,
      parentQueryId,
      evidenceHashes,
      cacheDecision: 'template',
      cacheSimilarity: params.confidence,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ttftMs: null,
      classifierModelId: 'rule-based-v1',
      answerValidationResult,
      evidenceLevelV2,
      errorCode: null,
    },
  }
}

// ── Freeform stub path (W2-A skeleton、W2-B で Haiku/Sonnet 結線) ───

interface RunFreeformParams {
  input: OrchestratorInput
  ctx: TenantContext
  providerMode: 'stub' | 'anthropic-direct' | 'ai-gateway'
  startedAt: number
  classificationConfidence: number
}

/** freeform LLM 経路の multi-step tool loop 上限 (4 tools chain + 最終合成で十分) */
const FREEFORM_MAX_STEPS = 6

/**
 * 続 82-ml Codex T1 fix #1(b) (trust/D-07): freeform の回答文末尾に必ず付与する可視 caveat。
 * LLM が tool 結果を「基に生成」した回答である旨と、重要数値は元データ確認を促す注意書き。
 * `validateAndCoerce` 前に **1 回だけ** 付与する (stub degrade 経路では付与しない)。
 */
const FREEFORM_REPLY_CAVEAT =
  '\n\n※ この回答は AI が分析ツールの結果を基に生成したものです。重要な数値は元データ（ダッシュボード）でご確認ください。'

/** caveat を冪等に付与 (既に末尾に含まれていれば二重付与しない) */
function appendFreeformCaveat(text: string): string {
  return text.includes(FREEFORM_REPLY_CAVEAT.trim()) ? text : `${text}${FREEFORM_REPLY_CAVEAT}`
}

/**
 * freeform 質問 (template 未該当) を実 LLM で回答する。
 *
 * 分岐:
 *   - providerMode !== 'ai-gateway' → `runFreeformStub()` (dev / test / no-key、SAFE)
 *   - providerMode === 'ai-gateway' → AI SDK v6 `generateText()` + analytics tools の
 *     multi-step tool loop で回答生成。
 *
 * Evidence mapping (D-07 整合、planned は real answer では禁止):
 *   - tool が 1 件以上成功 → evidenceLevel 'observed' (EvidenceRef[] を tool 結果から構築)
 *     ただし freeform は LLM が tool 結果を「基に生成」した自然言語のため exact を名乗らせず、
 *     observed_approx に floor する (Codex T1 fix #1(a)、近似 caveat 適用)。
 *   - tool が 0 件 (純粋な助言など) → evidenceLevel 'inferred' / confidence <= 0.4
 *     (schema が evidence.min(1) を要求するため合成 inferred ref を 1 件付与)
 *     ※ inferred 数値は `coerceChatReply` が「推定」prefix を自動付与する (hand-prefix しない)
 *   - 回答文末尾に可視 caveat を必ず付与 (Codex T1 fix #1(b))。
 *
 * tenant isolation (§3.8.1):
 *   - siteId は input.siteId (server)、tenantId は ctx から。LLM tool args からは採用しない
 *     (`buildFreeformTools` の execute が server-controlled 値を固定)。
 *
 * 失敗時 (Gateway error / validation error) は `runFreeformStub()` に degrade し
 * audit.errorCode を設定する (安全側に倒す)。
 */
async function runFreeform(params: RunFreeformParams): Promise<OrchestratorOutput> {
  if (params.providerMode !== 'ai-gateway') {
    // dev / test / no-key 経路は stub を維持 (LLM call を発火させない、SAFE)
    return runFreeformStub(params)
  }

  const { input, ctx, providerMode, startedAt } = params
  const model = getGatewayDefaultModel()

  try {
    const system = await getSystemPromptWithSummary(ctx.tenant_id, input.siteId)
    const collector: FreeformToolCollector = { calls: [] }
    const tools = buildFreeformTools({ ctx, requestSiteId: input.siteId, collector })

    const generated = await generateText({
      model,
      system: `${system}

# freeform 分析モード (重要)
- 数値を述べる前に必ず analytics tool を呼び出すこと。tool 結果なしに数値を断定してはならない。
- siteId / tenantId は server-side で固定済。tool input に含めないこと (含めても無視される)。
- analytics.overview を最初に呼んで queryId を得てから contributors / drilldown / verify を使う。
- 最終回答は markdown-lite (番号付きリスト可)。簡潔に、根拠 (tool 結果) に基づいて述べること。`,
      prompt: input.message,
      tools,
      stopWhen: stepCountIs(FREEFORM_MAX_STEPS),
    })

    const usage = generated.totalUsage
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const baseReplyText = generated.text.trim().length > 0
      ? generated.text.trim()
      : '十分な情報が得られませんでした。より具体的な質問でお試しください。'
    // 続 82-ml Codex T1 fix #1(b): validateAndCoerce 前に caveat を必ず付与 (1 回のみ)
    const replyText = appendFreeformCaveat(baseReplyText)

    const { evidence, evidenceLevelV2 } = buildFreeformEvidence({
      calls: collector.calls,
      siteId: input.siteId,
      periodDays: input.periodDays,
    })

    const reply: ChatReply = {
      conversationId: input.conversationId,
      reply: replyText,
      evidence,
      evidenceLevel: toEvidenceLevelV1(evidenceLevelV2),
      confidence: evidenceConfidenceFromLevel(evidenceLevelV2),
      suggestions: freeformSuggestions(),
      modelMeta: {
        provider: providerMode,
        model,
        latencyMs: Date.now() - startedAt,
        tokens: inputTokens + outputTokens,
      },
    }

    const { validated, answerValidationResult } = validateAndCoerce(reply)

    if (answerValidationResult === 'fail') {
      // 続 82-ml Codex T1 再レビュー fix (D-07): validateAndCoerce が repair でも通らず planned の
      //   minimal reply に degrade した場合、real answer として planned を返さない。明示的に
      //   freeform stub (honest な「分析未提供」応答) に degrade し、audit に errorCode を残す。
      //   LLM call は発火済のため実トークン数は記録する。
      const stub = await runFreeformStub(params)
      return {
        reply: stub.reply,
        audit: {
          ...stub.audit,
          intentCategory: 'freeform',
          classifierModelId: model,
          errorCode: 'FREEFORM_VALIDATION_FAILED',
          inputTokens,
          outputTokens,
        },
      }
    }

    const evidenceHashes = collector.calls.map((c) =>
      hashEvidence({ tool: c.result.tool, result: c.result.result }),
    )
    const toolCalls: AnalyticsToolName[] = collector.calls.map((c) => c.name)

    // 続 82-ml Codex T1 fix #4 (audit accuracy): coerce が evidenceLevel を弱め得る (weakest-wins
    //   再計算 + confidence クランプ) ため、audit には **検証後 (validated)** の level を記録し、
    //   ユーザーが受け取った reply と ledger を一致させる。pre-coercion の evidenceLevelV2 ではなく
    //   validated.evidenceLevel (V1) を V2 へ写像した値を採用。
    const auditEvidenceLevelV2: EvidenceLevelV2 = toEvidenceLevelV2(validated.evidenceLevel)

    return {
      reply: validated,
      audit: {
        templateId: null,
        intentCategory: 'freeform',
        toolCalls,
        parentQueryId: null,
        evidenceHashes,
        cacheDecision: 'bypass',
        cacheSimilarity: params.classificationConfidence,
        inputTokens,
        outputTokens,
        costUsd: 0,
        ttftMs: null,
        classifierModelId: model,
        answerValidationResult,
        evidenceLevelV2: auditEvidenceLevelV2,
        errorCode: null,
      },
    }
  } catch (err: unknown) {
    // Gateway / validation 失敗時は stub に degrade (安全側)。audit に errorCode を残す。
    // 続 82-ml Codex T1 fix #5 (log hygiene): errorCode には raw error text を含めない。
    //   既知の coded category (err.code、例 'TOOL_IDOR' / 'TOOL_VALIDATION' / 'LLM_RUNTIME_CONFIG') は
    //   そのまま採用し、それ以外は固定カテゴリ 'FREEFORM_LLM_ERROR' に正規化する。
    //   err.message の slice 連結は廃止 (ledger に raw 文字列を流さない)。
    const code: string =
      err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'FREEFORM_LLM_ERROR'
    const stub = await runFreeformStub(params)
    return {
      reply: stub.reply,
      audit: {
        ...stub.audit,
        intentCategory: 'freeform',
        classifierModelId: model,
        errorCode: code,
      },
    }
  }
}

interface BuildFreeformEvidenceParams {
  calls: ReadonlyArray<FreeformToolCall>
  siteId: string
  periodDays: number
}

interface BuildFreeformEvidenceOutput {
  evidence: EvidenceRef[]
  evidenceLevelV2: EvidenceLevelV2
}

/**
 * 成功した tool 呼び出しから EvidenceRef[] を構築 (fillSkeleton の evidence shape を mirror)。
 *
 *   - freeform は tool 使用有無に依らず evidenceLevel を **'inferred' に固定** (続 82-ml Codex T1
 *     再レビュー)。自由文 LLM 出力は回答中の個々の数値が tool 結果からそのまま導かれた保証が
 *     ないため 'inferred' とし、`coerceChatReply` に bare numeric の「推定」prefix を付けさせる
 *     (D-07: 実測の誤提示禁止)。confidence は 0.4。
 *   - tool ≥1: どの tool を参照したかを EvidenceRef に残す (traceability、level=inferred)。
 *   - tool 0: 合成 inferred EvidenceRef を 1 件付与 (ChatReplySchema が evidence.min(1) を要求。
 *     空配列だと Zod parse 失敗 → planned fallback に退化してしまうため)。
 */
function buildFreeformEvidence(params: BuildFreeformEvidenceParams): BuildFreeformEvidenceOutput {
  if (params.calls.length === 0) {
    const inferredRef: EvidenceRef = {
      id: `freeform-inferred-${params.siteId}`,
      kind: 'metric',
      level: 'inferred',
      label: 'LLM 推論 (tool 未使用、数値断定なし)',
      target: {
        kind: 'metric',
        metric: 'freeform_inferred',
        site_id: params.siteId,
        period_days: params.periodDays,
      },
      confidence: evidenceConfidenceFromLevel('inferred'),
    }
    return { evidence: [inferredRef], evidenceLevelV2: 'inferred' }
  }

  // 続 82-ml Codex T1 再レビュー fix (trust/D-07): freeform の回答文は LLM が tool 結果を「基に」
  //   自然言語で合成したもので、回答中の個々の数値が tool 結果からそのまま導かれた保証はない
  //   (LLM が計算・丸め・合成し得る)。よって tool を使っても evidenceLevel は 'inferred' (推定) に
  //   固定する。これにより coerceChatReply が bare numeric に「推定」prefix を自動付与し、
  //   D-07 (実測の誤提示禁止) を機械的に満たす。どの tool を参照したかは traceability のため
  //   evidence ref に残す (level=inferred)。'inferred' は V1↔V2 変換が無損失なので audit も一致。
  const safeV2: EvidenceLevelV2 = 'inferred'
  const reducedV1: EvidenceLevel = toEvidenceLevelV1(safeV2)

  const evidence: EvidenceRef[] = params.calls.map((c, idx) => ({
    id: `freeform-${idx}-${params.siteId}`,
    kind: 'metric',
    level: reducedV1,
    label: freeformResultLabel(c.result),
    target: {
      kind: 'metric',
      metric: c.result.tool,
      site_id: params.siteId,
      period_days: params.periodDays,
    },
    confidence: evidenceConfidenceFromLevel(safeV2),
  }))

  return { evidence, evidenceLevelV2: safeV2 }
}

/** tool 結果から人間可読な evidence label を構築 (fillSkeleton と同型) */
function freeformResultLabel(result: AnalyticsToolResult): string {
  switch (result.tool) {
    case 'analytics.overview':
      return `overview tier=${result.result.tier}`
    case 'analytics.contributors':
      return `contributors dim=${result.result.contributors.length}件`
    case 'analytics.drilldown':
      return `drilldown grain=${result.result.grain}`
    case 'analytics.verify':
      return `verify withinTolerance=${result.result.withinTolerance}`
  }
}

function freeformSuggestions(): string[] {
  return ['直近 7 日の CVR', '人気ページ Top 5', 'CVR が下がった原因']
}

async function runFreeformStub(params: RunFreeformParams): Promise<OrchestratorOutput> {
  const { input, providerMode, startedAt, classificationConfidence } = params

  // W2-A: LLM call せず planned-only stub を返す (D-07 整合、断定数値なし)
  // W2-B: ここに Haiku classifier + Sonnet generateText() を結線
  const trimmed = input.message.trim().slice(0, 200)
  // 続120: 旧文言「Sprint 3 W2-B で提供予定」は freeform 実装済の現在では誤解を招く。
  //   stub に落ちる理由を providerMode で出し分け、正直に表示する。
  const reason =
    providerMode === 'ai-gateway'
      ? 'AI 自由分析を一時的に利用できませんでした（モデル接続、または本番環境変数 AI_GATEWAY_API_KEY の設定をご確認ください）。'
      : 'AI 自由分析はこの環境では現在無効です（LLM 接続が未設定）。'
  const replyText = [
    `ご質問「${trimmed}」を受け付けました。`,
    reason,
    'テンプレート定型の質問（例: 直近7日のCVR / 人気ページTop5）であればそのままお答えできます。',
    '',
    '※ Evidence Level: planned（実データに基づく回答ではありません）。',
  ].join('\n')

  const evidence: EvidenceRef[] = [
    {
      id: `stub-${input.siteId}-${input.periodDays}d`,
      kind: 'metric',
      level: 'planned',
      label: `site=${input.siteId} / ${input.periodDays}日 (freeform stub)`,
      target: {
        kind: 'metric',
        metric: 'pending',
        site_id: input.siteId,
        period_days: input.periodDays,
      },
      confidence: 0,
    },
  ]

  const reply: ChatReply = {
    conversationId: input.conversationId,
    reply: replyText,
    evidence,
    evidenceLevel: 'planned',
    confidence: 0,
    suggestions: ['CVR の週次サマリ', '離脱多いページ', '人気ページ'],
    modelMeta: buildModelMeta({ providerMode, startedAt }),
  }

  const { validated, answerValidationResult } = validateAndCoerce(reply)

  return {
    reply: validated,
    audit: {
      templateId: null,
      intentCategory: 'freeform_stub',
      toolCalls: [],
      parentQueryId: null,
      evidenceHashes: [],
      cacheDecision: 'bypass',
      cacheSimilarity: classificationConfidence,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ttftMs: null,
      classifierModelId: 'rule-based-v1',
      answerValidationResult,
      evidenceLevelV2: 'planned',
      errorCode: null,
    },
  }
}

// ── Error path ──────────────────────────────────────────────────────

function buildErrorReply(
  input: OrchestratorInput,
  _ctx: TenantContext,
  providerMode: 'stub' | 'anthropic-direct' | 'ai-gateway',
  startedAt: number,
  err: unknown,
  ctxHints: {
    templateId: string | null
    intentCategory: string | null
    classifierModelId: string | null
  },
): OrchestratorOutput {
  const msg = err instanceof Error ? err.message : 'unknown'
  const code =
    err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? ((err as { code: string }).code)
      : 'TOOL_ERROR'

  // Director 続 74 Task F (Owner 2026-05-24 09:34 JST 報告 — 4ms 0tok generic 失敗):
  //   従来は generic message のみ返却 → Owner / Director ともに Vercel logs 無しで
  //   原因切り分け不能。続 75 以降は ClickHouse 接続 / table 不在 / IDOR を区別できるよう
  //   sanitize 済 hint を 1 行追加する (secret 値は msg 由来でも含めない、
  //   buildAuditEntry の errorCode と同じ slice 100 chars policy)。
  //
  //   表示例:
  //     - `CLICKHOUSE_RO_PASSWORD is required ...` → env 未投入
  //     - `Code: 60, ... events_hourly_by_dim doesn't exist` → MV 未配備
  //     - `ToolIDORError: ...` → tenant 越え試行 (現状非該当、防御確認用)
  //   secret 流出回避: code + msg.slice(0, 140)、credentials を含む URL は含めない
  //   (clickhouse.ts は env 名のみ報告、msg に raw URL は混入しない設計)
  const hintRaw = msg.slice(0, 140)
  const hintLine = `（内部: ${code} / ${hintRaw}）`

  // 続 76 Task C (Owner 2026-05-24 09:34 JST 報告 — ai-gateway mode、4ms 0tok、generic 失敗):
  //   従来は msg 全文を hint に流していたが、Owner にとっては「何を待てばよいか」が
  //   分からない (env? schema? backfill?)。本続 76 で root cause 別に actionable な
  //   1 行 (`actionableHint`) を追加し、Owner が即「待ち事項」を把握できるようにする。
  //   - 'analytics_reader' / 'CLICKHOUSE_RO_PASSWORD' 含む → env 投入待ち
  //   - 'doesn't exist' / 'Unknown table' / 'Code: 60' 含む → MV table 未配備 (Infra dispatch)
  //   - 'ToolIDORError' 含む → tenant 越え試行 (relogin)
  //   - その他 → 一般的な「Infra 連絡」案内
  //   secret 流出回避: hintRaw を直接見せるのみで、msg 由来の credentials は含めない
  //   (clickhouse.ts は env 名のみ報告する設計のため URL/password が msg に混入しない)
  const lowerMsg = msg.toLowerCase()
  let actionableHint: string
  if (
    lowerMsg.includes('clickhouse_ro_password') ||
    lowerMsg.includes('clickhouse_writer_password') ||
    lowerMsg.includes('clickhouse_password') ||
    lowerMsg.includes('clickhouse_url is required')
  ) {
    actionableHint =
      '🛠 推定原因: ClickHouse 認証 env が未投入。Owner が Vercel project settings → Environment Variables で投入後、redeploy で復旧見込み。'
  } else if (
    lowerMsg.includes("doesn't exist") ||
    lowerMsg.includes('does not exist') ||
    lowerMsg.includes('unknown table') ||
    lowerMsg.includes('code: 60')
  ) {
    actionableHint =
      '🛠 推定原因: 分析用 ClickHouse table (events_hourly_by_dim 等、Infra 続 67 D-1) が production に未配備。Infra dispatch で migration 適用待ち。'
  } else if (lowerMsg.includes('idor') || code === 'TOOL_IDOR') {
    actionableHint =
      '🛠 推定原因: tenant 越えのアクセス試行。古い JWT を持つセッションの場合は relogin (sidebar の「ログアウト」→ 再ログイン) で解消。'
  } else if (
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('fetch failed')
  ) {
    actionableHint =
      '🛠 推定原因: ClickHouse への接続が拒否 / タイムアウト。Infra に network / VPC 設定を確認依頼。'
  } else if (lowerMsg.includes('parentqueryid')) {
    actionableHint =
      '🛠 推定原因: chat orchestrator の tool 連鎖で親 query が見つからない (Sprint 3 W2 改修中、Director に報告)。'
  } else {
    actionableHint =
      '🛠 推定原因: 想定外の tool 失敗。Owner は Director / Infra に Vercel logs と本メッセージを共有してください。'
  }

  const replyText = [
    'すみません、分析に失敗しました。',
    actionableHint,
    '',
    '一時的な接続問題の可能性もあるため、少し時間を空けて再度お試しください。繰り返す場合はサポートにご連絡ください。',
    hintLine,
  ].join('\n')

  const evidence: EvidenceRef[] = [
    {
      id: `error-${input.siteId}`,
      kind: 'metric',
      level: 'planned',
      label: `error: ${code}`,
      target: {
        kind: 'metric',
        metric: 'error',
        site_id: input.siteId,
        period_days: input.periodDays,
      },
      confidence: 0,
    },
  ]

  const reply: ChatReply = {
    conversationId: input.conversationId,
    reply: replyText,
    evidence,
    evidenceLevel: 'planned',
    confidence: 0,
    suggestions: ['CVR の週次サマリ', '離脱多いページ', '人気ページ'],
    modelMeta: buildModelMeta({ providerMode, startedAt }),
  }

  // error response も Zod validation (ChatReply shape を破らない)
  const { validated } = validateAndCoerce(reply)

  return {
    reply: validated,
    audit: {
      templateId: ctxHints.templateId,
      intentCategory: ctxHints.intentCategory,
      toolCalls: [],
      parentQueryId: null,
      evidenceHashes: [],
      cacheDecision: 'bypass',
      cacheSimilarity: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ttftMs: null,
      classifierModelId: ctxHints.classifierModelId,
      answerValidationResult: 'fail',
      evidenceLevelV2: 'planned',
      errorCode: `${code}:${msg.slice(0, 100)}`,
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function defaultDateRangeForPeriod(periodDays: number): { start: string; end: string } {
  const now = new Date()
  const end = now.toISOString().slice(0, 19)
  const start = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
  return { start, end }
}

/**
 * Tool plan DSL line を name + args に分解。
 * 例: 'analytics.overview(7d, [cvr, sessions])' → { name: 'analytics.overview', args: { metrics: ['cvr','sessions'] } }
 *
 * MVP: regex で name(...) を抽出、args はそのまま raw (orchestrator が template ごとの mapping を保持)。
 * W2-B で AST parser に置換。
 */
function parseToolPlanLine(line: string): { name: AnalyticsToolName; args: Record<string, unknown> } | null {
  const match = line.match(/^(analytics\.\w+)\s*\(/i)
  if (!match) return null
  const name = match[1] as AnalyticsToolName

  // 引数の簡易抽出 (metrics list / dimension など)
  const args: Record<string, unknown> = {}

  // metrics: [cvr, sessions] → ['cvr', 'sessions']
  // 続 78 Task B: 続 67 D-1 schema 整合で `bounce_rate` / `session_duration` を unsupported 化したため
  //   question-templates.ts の toolPlan 文字列に残っているそれらの metric を防御的に drop。
  //   空になった場合は ['sessions'] を fallback (overview tool は metrics 必須)。
  //   ANALYTICS_METRICS と同期する SUPPORTED set。
  const SUPPORTED_METRICS = new Set<string>(['cvr', 'page_views', 'sessions'])
  const metricsMatch = line.match(/\[([^\]]+)\]/)
  if (metricsMatch && name === 'analytics.overview') {
    const requested = metricsMatch[1].split(',').map((m) => m.trim()).filter(Boolean)
    const supported = requested.filter((m) => SUPPORTED_METRICS.has(m))
    args.metrics = supported.length > 0 ? supported : ['sessions']
  }

  // dimension=page_url
  const dimMatch = line.match(/dimension=(\w+)/i)
  if (dimMatch && (name === 'analytics.contributors' || name === 'analytics.drilldown')) {
    args.dimension = dimMatch[1]
  }

  // limit=N
  const limitMatch = line.match(/limit=(\d+)/i)
  if (limitMatch && name === 'analytics.contributors') {
    args.limit = Number(limitMatch[1])
  }

  // grain=hour | day
  const grainMatch = line.match(/grain=(hour|day)/i)
  if (grainMatch && name === 'analytics.drilldown') {
    args.grain = grainMatch[1]
  }

  // value=... (drilldown 用、placeholder 'top_loser' 等は MVP では未解決 → default 'all')
  const valueMatch = line.match(/value=([\w_]+)/i)
  if (valueMatch && name === 'analytics.drilldown') {
    args.value = valueMatch[1]
  }

  return { name, args }
}

interface FillSkeletonParams {
  template: QuestionTemplate
  toolResults: AnalyticsToolResult[]
  siteId: string
  periodDays: number
}

interface FillSkeletonOutput {
  replyText: string
  evidenceLevelV2: EvidenceLevelV2
  evidence: EvidenceRef[]
}

function fillSkeleton(params: FillSkeletonParams): FillSkeletonOutput {
  const overview = params.toolResults.find((r) => r.tool === 'analytics.overview')
  const contributors = params.toolResults.find((r) => r.tool === 'analytics.contributors')

  let text = params.template.answerSkeleton

  if (overview && overview.tool === 'analytics.overview') {
    const s = overview.result.summary
    // 続 82-ml skeleton: bounce_pct / duration_sec を summary 経由に配線。
    //   Infra 完了 + SQL revival (Phase 2) で summary.bounceRate / summary.avgSessionDurationSec
    //   に実値が入る。それまでは hybrid-query.aggregateSummary が null を返すため
    //   placeholder は 'N/A' に置換される (旧「未対応」より UI 整合的)。
    //   なお UNSUPPORTED_KEYWORD_MAP が 'バウンス'/'即離脱' を依然 block するため、
    //   ユーザー質問が直接 BOUNCE_WEEKLY に到達するのは Phase 2 で UNSUPPORTED_KEYWORD_MAP
    //   から bounce_metric を外した後。
    const replacements: Record<string, string> = {
      '{cvr_pct}': s.cvr !== null ? (s.cvr * 100).toFixed(2) : 'N/A',
      '{bounce_pct}': s.bounceRate !== null ? (s.bounceRate * 100).toFixed(2) : 'N/A',
      '{sessions}': String(s.sessions),
      '{page_views}': String(s.pageViews),
      '{duration_sec}': s.avgSessionDurationSec !== null ? s.avgSessionDurationSec.toFixed(0) : 'N/A',
    }
    for (const [k, v] of Object.entries(replacements)) {
      text = text.replace(new RegExp(escapeRegex(k), 'g'), v)
    }
  }

  if (contributors && contributors.tool === 'analytics.contributors') {
    const top3 = contributors.result.contributors
      .slice(0, 3)
      .map((c) => `${c.dim_value} (${(c.share_pct * 100).toFixed(1)}%)`)
      .join(' / ')
    text = text.replace(/{top_3_pages}/g, top3 || 'データ不足')
    text = text.replace(/{top_10_pages}/g, top3 || 'データ不足')
    text = text.replace(/{device_breakdown}/g, top3 || 'データ不足')
    text = text.replace(/{persona_breakdown}/g, top3 || 'データ不足')
  }

  // 未解決 placeholder は generic に置換
  text = text.replace(/{[\w_]+}/g, '取得中')

  // Evidence aggregation
  const evidenceLevelsV2 = params.toolResults.map((r) => ({
    level: 'evidenceLevel' in r.result ? r.result.evidenceLevel : ('observed_approx' as EvidenceLevelV2),
  }))
  const reducedV2 = reduceEvidenceLevelV2(evidenceLevelsV2, params.template.evidenceLevel)
  const reducedV1: EvidenceLevel = toEvidenceLevelV1(reducedV2)

  // 続 81 Director hot fix: evidenceLevel 別の prefix / 注釈を動的付与
  //   - observed_exact (raw 直接 uniqExact、誤差ゼロ): 「実測 」prefix + 注釈なし
  //   - observed_approx (MV uniqCombined64 経由、〜2% 誤差): prefix なし + 「(近似集計、誤差 〜2%)」末尾注釈
  //   - inferred / planned: prefix は chat-reply-validator が auto-add (「推定」)
  //   Owner からの「実測 vs 推定の区別が付かない」報告 (続 81) に対応。
  //   answerSkeleton は 「推定」prefix を hard-code しない方針 (続 81 で全 template 修正済)。
  if (reducedV2 === 'observed_exact') {
    text = `実測 ${text}`
  } else if (reducedV2 === 'observed_approx') {
    // 既に skeleton に「近似集計」と記載がある場合は二重注釈を避ける
    if (!text.includes('近似集計') && !text.includes('誤差')) {
      text = `${text}\n\n※ 近似集計のため誤差 〜2% を含みます (analytics.verify で exact 再計算可)。`
    }
  }

  const evidence: EvidenceRef[] = params.toolResults.map((r, idx) => ({
    id: `tool-${idx}-${params.siteId}`,
    kind: 'metric',
    level: reducedV1,
    label:
      r.tool === 'analytics.overview'
        ? `overview tier=${r.result.tier}`
        : r.tool === 'analytics.contributors'
        ? `contributors dim=${r.result.contributors.length}件`
        : r.tool === 'analytics.drilldown'
        ? `drilldown grain=${r.result.grain}`
        : `verify withinTolerance=${r.result.withinTolerance}`,
    target: {
      kind: 'metric',
      metric: r.tool,
      site_id: params.siteId,
      period_days: params.periodDays,
    },
    confidence: evidenceConfidenceFromLevel(reducedV2),
  }))

  return {
    replyText: text,
    evidenceLevelV2: reducedV2,
    evidence,
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function evidenceConfidenceFromLevel(level: EvidenceLevelV2): number {
  switch (level) {
    case 'proven_exact':
      return 1.0
    case 'observed_exact':
      return 0.9
    case 'observed_approx':
      return 0.75
    case 'inferred':
      return 0.4
    case 'planned':
      return 0
  }
}

function defaultSuggestions(template: QuestionTemplate): string[] {
  switch (template.category) {
    case 'metric_baseline':
      return ['他デバイス比較', '同期間の他ページ', '前週との差分']
    case 'metric_breakdown':
      return ['上位ページの詳細', 'CVR の時系列推移', 'デバイス別の差']
    case 'anomaly':
      return ['原因ページの詳細', '時系列で見る', 'verify で再計算']
    case 'comparison':
      return ['ページ別の差分', 'デバイス別の差分', 'verify で再計算']
    case 'guidance':
      return ['CVR の週次サマリ', '離脱多いページ', '人気ページ']
  }
}

function buildModelMeta(params: {
  providerMode: 'stub' | 'anthropic-direct' | 'ai-gateway'
  startedAt: number
}): ChatReply['modelMeta'] {
  const model = params.providerMode === 'ai-gateway' ? getGatewayDefaultModel() : 'stub'
  return {
    provider: params.providerMode,
    model,
    latencyMs: Date.now() - params.startedAt,
    tokens: 0,
  }
}

function validateAndCoerce(reply: ChatReply): {
  validated: ChatReply
  answerValidationResult: 'pass' | 'repair' | 'fail'
} {
  try {
    const v = parseChatReply(reply)
    return { validated: v, answerValidationResult: 'pass' }
  } catch (err) {
    if (!(err instanceof ChatReplyValidationError)) throw err
    // 1 回だけ repair
    const coerced = coerceChatReply(reply)
    try {
      const v = parseChatReply(coerced)
      return { validated: v, answerValidationResult: 'repair' }
    } catch (err2) {
      if (!(err2 instanceof ChatReplyValidationError)) throw err2
      // repair でも fail → 軽微エラー入り reply を作って返す (caller が 502 か degraded で判断)
      const issues = checkChatReplySemantics(coerced)
      const fallback: ChatReply = {
        ...coerced,
        reply:
          coerced.reply +
          `\n\n※ 内部検証エラー (${issues.map((i) => i.code).join(', ')}) — レビュアー通知済`,
      }
      try {
        const v = parseChatReply(fallback)
        return { validated: v, answerValidationResult: 'fail' }
      } catch {
        // 最後の手段: shape のみ強制した最小 reply
        const minimal: ChatReply = {
          ...reply,
          reply: '応答の検証に失敗しました。再度お試しください。',
          evidenceLevel: 'planned',
          confidence: 0,
        }
        return { validated: minimal, answerValidationResult: 'fail' }
      }
    }
  }
}

// ── 続 82 Director hot fix: Unsupported concept detection ──────────

/**
 * Sprint 1 / 続 67 D-1 schema 制約により未対応の質問概念を検出する。
 * tracking-js / ClickHouse MV / events schema の現状能力境界を機械的に表現:
 *
 *   - persona/ペルソナ/segment: persona MV を続 67 で削除済 (S2-03 別 table 配備まで保留)
 *   - landing/ランディング/exit/離脱ページ: session flow tracking 未実装
 *
 * 検出されたら fail-fast で「現在未対応」reply を返し、誤回答を防ぐ。
 *
 * 続 82-ml Phase 2 (2026-05-25): Infra 続 82 完了 (sessions_hourly + _v2 MV + tracking-js v2 +
 *   events table v2 列追加) により以下 3 category を unsupported list から削除:
 *   - bounce_metric (即離脱/直帰/バウンス/bounce) → sessions_hourly + bounce_sessions state で対応可
 *   - organic_segment (オーガニック/organic/自然検索/referrer/utm/流入元/流入経路) → dim='utm_source' で対応可
 *   - visitor_repeat (新規ユーザー/新規訪問/リピーター/再訪/new/returning visitor) → dim='visitor_type' で対応可
 *
 *   削除後、上記 keyword を含む質問は classifier 経路 (ORGANIC_TRAFFIC_SHARE / ORGANIC_BOUNCE_RATE /
 *   NEW_VS_RETURNING_CVR / BOUNCE_WEEKLY / BOUNCE_PAGES 等の既存 + 新 template) に流れる。
 *
 *   残置 2 category (persona_segment / session_flow) は Sprint 5 で復活予定。
 */
type UnsupportedConcept = {
  /** matched keyword (検出された語句) */
  keyword: string
  /** どの能力境界に該当するか */
  category: 'persona_segment' | 'session_flow'
  /** Sprint 何で対応予定か */
  plannedSprint: string
}

const UNSUPPORTED_KEYWORD_MAP: ReadonlyArray<{
  keywords: string[]
  category: UnsupportedConcept['category']
  plannedSprint: string
}> = [
  // 続 82-ml Phase 2 で削除済:
  //   - bounce_metric (続 82 mv-bounce-revival で sessions_hourly + bounce_sessions state 配備)
  //   - organic_segment (続 82 schema migration で events.utm_source 列追加 + mv_events_hourly_utm_source)
  //   - visitor_repeat (続 82 で __ugk_vid cookie + visitor_id 列 + mv_events_hourly_visitor_type)
  {
    keywords: ['ペルソナ', 'persona', 'セグメント別', 'segment', 'コホート', 'cohort'],
    category: 'persona_segment',
    plannedSprint: 'Sprint 5 (S2-03 persona 別 table + ML classifier 配備後)',
  },
  {
    keywords: ['ランディングページ', '入口ページ', '出口ページ', '離脱ページ', 'landing page', 'exit page'],
    category: 'session_flow',
    plannedSprint: 'Sprint 5 (session flow tracking + first/last page 列追加後)',
  },
]

export function detectUnsupportedConcepts(message: string): UnsupportedConcept[] {
  const lower = message.toLowerCase()
  const found: UnsupportedConcept[] = []
  const seenCategories = new Set<UnsupportedConcept['category']>()
  for (const entry of UNSUPPORTED_KEYWORD_MAP) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase()) && !seenCategories.has(entry.category)) {
        found.push({ keyword: kw, category: entry.category, plannedSprint: entry.plannedSprint })
        seenCategories.add(entry.category)
        break
      }
    }
  }
  return found
}

function buildUnsupportedReply(
  input: OrchestratorInput,
  providerMode: 'stub' | 'anthropic-direct' | 'ai-gateway',
  startedAt: number,
  unsupported: UnsupportedConcept[],
): OrchestratorOutput {
  const trimmedQ = input.message.trim().slice(0, 200)
  const unsupportedLines = unsupported.map(
    (u, idx) =>
      `${idx + 1}. **${u.keyword}** — ${describeCategoryJa(u.category)} (対応予定: ${u.plannedSprint})`,
  )

  const replyText = [
    `[解釈] ご質問:「${trimmedQ}」`,
    '',
    'ご質問の中に、現在の Sprint 1 では正確に分析できない概念が含まれているため、誤った回答を返すことを避けて以下を共有します。',
    '',
    '**未対応の概念:**',
    ...unsupportedLines,
    '',
    '**代わりに以下は今すぐ回答可能です** (data 取得済):',
    '- 直近 7/14/30 日の CVR / セッション数 / ページビュー数',
    '- ページ別 / デバイス別の上位寄与 (page_url / device)',
    '- 急増 / 急減の検出 (時系列 z-score > 2.5)',
    '- 任意の主張値の exact 再計算 (analytics.verify)',
    '',
    'もう少し限定した質問 (例:「直近 7 日の CVR」「人気ページ Top 5」) でお試しください。',
  ].join('\n')

  const evidence: EvidenceRef[] = [
    {
      id: `unsupported-${input.siteId}-${unsupported.map((u) => u.category).join('+')}`,
      kind: 'metric',
      level: 'planned',
      label: `unsupported: ${unsupported.map((u) => u.category).join(', ')}`,
      target: {
        kind: 'metric',
        metric: 'unsupported_concept',
        site_id: input.siteId,
        period_days: input.periodDays,
      },
      confidence: 0,
    },
  ]

  const reply: ChatReply = {
    conversationId: input.conversationId,
    reply: replyText,
    evidence,
    evidenceLevel: 'planned',
    confidence: 0,
    suggestions: [
      '直近 7 日の CVR',
      '人気ページ Top 5',
      'デバイス別 CVR',
      'CVR が下がった原因',
    ],
    modelMeta: buildModelMeta({ providerMode, startedAt }),
  }

  const { validated, answerValidationResult } = validateAndCoerce(reply)

  return {
    reply: validated,
    audit: {
      templateId: null,
      intentCategory: 'unsupported_concept',
      toolCalls: [],
      parentQueryId: null,
      evidenceHashes: [],
      cacheDecision: 'bypass',
      cacheSimilarity: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ttftMs: null,
      classifierModelId: 'unsupported-detector-v1',
      answerValidationResult,
      evidenceLevelV2: 'planned',
      errorCode: `UNSUPPORTED:${unsupported.map((u) => u.category).join('+')}`,
    },
  }
}

function describeCategoryJa(category: UnsupportedConcept['category']): string {
  // 続 82-ml Phase 2 で bounce_metric / organic_segment / visitor_repeat は対応化、
  // 本関数の case からも削除。残置 2 category のみ describe する。
  switch (category) {
    case 'persona_segment':
      return 'ペルソナ / セグメント別の分析は persona MV を未配備のため不可'
    case 'session_flow':
      return 'ランディング / 出口ページは session flow tracking を未実装のため算出不可'
  }
}

// ── Caller helper: fire-and-forget audit log ───────────────────────

/**
 * Orchestrator output を audit ledger に log (fire-and-forget)。
 * caller (`app/api/chat/route.ts`) が `void logOrchestratorAudit(...)` で呼ぶ。
 */
export function logOrchestratorAudit(params: {
  output: OrchestratorOutput
  ctx: TenantContext
  input: OrchestratorInput
}): void {
  void logAuditEntry(
    buildAuditEntry({
      tenantId: params.ctx.tenant_id,
      siteId: params.input.siteId,
      userId: params.ctx.user_id,
      conversationId: params.input.conversationId,
      messageIndex: params.input.messageIndex,
      promptVersion: ORCHESTRATOR_PROMPT_VERSION,
      modelId: params.output.reply.modelMeta.model,
      latencyMs: params.output.reply.modelMeta.latencyMs,
      templateId: params.output.audit.templateId,
      intentCategory: params.output.audit.intentCategory,
      toolCalls: params.output.audit.toolCalls,
      parentQueryId: params.output.audit.parentQueryId,
      evidenceHashes: params.output.audit.evidenceHashes,
      cacheDecision: params.output.audit.cacheDecision,
      cacheSimilarity: params.output.audit.cacheSimilarity,
      inputTokens: params.output.audit.inputTokens,
      outputTokens: params.output.audit.outputTokens,
      costUsd: params.output.audit.costUsd,
      ttftMs: params.output.audit.ttftMs,
      classifierModelId: params.output.audit.classifierModelId,
      answerValidationResult: params.output.audit.answerValidationResult,
      evidenceLevel: params.output.audit.evidenceLevelV2,
      errorCode: params.output.audit.errorCode,
    }),
  )
  // randomUUID は audit table の id default に任せる (本ファイル参照不要、unused 警告回避用)
  void randomUUID
}
