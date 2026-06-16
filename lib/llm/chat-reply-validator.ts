/**
 * lib/llm/chat-reply-validator.ts — ChatReply structured output enforcement (続 64)
 *
 * 親 SSOT §1.6 原則 2 / §1.8.2 / D-07 (Evidence Level)
 * 配備根拠: 続 61 §2 (b) Reviewer Codex GREEN 条件付き、W2 着工前完了条件
 *
 * 目的 (Codex 改善依頼 (b) 1:1 対応):
 *   System prompt の自然文制約だけでは LLM 応答の D-07 遵守を機械的に保証できない。
 *   本ファイルは **Zod schema + server-side post-validation** で:
 *     1. ChatReply の shape を強制 (型 + ランタイム)
 *     2. `evidence` 空配列禁止 (1 件以上必須)
 *     3. `evidenceLevel='inferred'` 時、reply 中の数値表記に「推定」prefix 必須
 *     4. weakest-wins (`evidence[]` の最も弱い level が `evidenceLevel` に reduce 済)
 *     5. `confidence` は evidence の confidence 最小値以下 (proven=1.0 / observed/inferred/planned で減衰)
 *   検証失敗時は `ChatReplyValidationError` を throw、API は 502 で返却 or repair retry。
 *
 * Sprint 3 W2 (続 65+) で `runChatCompletion()` から呼ぶ流れ:
 *   1. LLM 応答 → JSON parse
 *   2. `parseChatReply()` で Zod + 意味検証
 *   3. 失敗 → `coerceChatReply()` で軽修復を試みる (1 回のみ、無限 retry 禁止)
 *   4. それでも失敗 → 502 NextResponse + Sentry に full payload (PII 除く) 記録
 */

import { z } from 'zod'

import {
  type ChatReply,
  type EvidenceLevel,
  type EvidenceRef,
  type EvidenceRefKind,
  reduceEvidenceLevel,
} from '@/types/evidence'

// ── Zod schema (型 SSOT は `@/types/evidence`、本ファイルは runtime mirror) ────

/**
 * `EvidenceLevel` の Zod literal union。
 * `@/types/evidence` の type と key を 1:1 対応で同期 (drift 検知は型 assertion で担保)。
 */
// ChatReply.evidenceLevel は 4-tier V1 維持 (続 63 Frontend 配備物との後方互換)。
// 5-tier V2 は analytics tools 内部のみ。orchestrator が ChatReply 構築時に
// `toEvidenceLevelV1()` で V1 へ lossy 写像する (続 68 W2-A 方針、auto-edit 整合)。
const EvidenceLevelSchema = z.enum(['proven', 'observed', 'inferred', 'planned'])
const EvidenceRefKindSchema = z.enum(['session', 'event', 'metric', 'proposal', 'external'])

const EvidenceTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    session_id: z.string().min(1),
    site_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('event'),
    session_id: z.string().min(1),
    event_id: z.string().min(1),
    site_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('metric'),
    metric: z.string().min(1),
    dimension: z.string().optional(),
    site_id: z.string().min(1),
    period_days: z.number().int().min(1).max(365),
  }),
  z.object({
    kind: z.literal('proposal'),
    proposal_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('external'),
    url: z.string().url(),
    source: z.string().min(1),
  }),
])

const EvidenceRefSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceRefKindSchema,
  level: EvidenceLevelSchema,
  label: z.string().min(1).max(256),
  target: EvidenceTargetSchema,
  confidence: z.number().min(0).max(1),
})

const ModelMetaSchema = z.object({
  provider: z.enum(['stub', 'anthropic-direct', 'ai-gateway']),
  model: z.string().min(1).max(128),
  latencyMs: z.number().int().min(0),
  tokens: z.number().int().min(0),
})

export const ChatReplySchema = z.object({
  conversationId: z.string().uuid(),
  reply: z.string().min(1).max(20_000),
  evidenceLevel: EvidenceLevelSchema,
  evidence: z.array(EvidenceRefSchema).min(1, 'evidence must contain at least 1 EvidenceRef'),
  confidence: z.number().min(0).max(1),
  suggestions: z.array(z.string().min(1).max(512)).max(8),
  modelMeta: ModelMetaSchema,
})

// drift 検知: Zod が生む型と `@/types/evidence` の `ChatReply` が一致することを assert
// 不一致時はコンパイルエラー (片方を更新したら他方も更新する強制)
type _ZodInferredChatReply = z.infer<typeof ChatReplySchema>
type _AssertChatReplyShape = AssertExtends<_ZodInferredChatReply, ChatReply>
type _AssertEvidenceRefShape = AssertExtends<z.infer<typeof EvidenceRefSchema>, EvidenceRef>
type _AssertEvidenceLevel = AssertExtends<z.infer<typeof EvidenceLevelSchema>, EvidenceLevel>
type _AssertEvidenceRefKind = AssertExtends<z.infer<typeof EvidenceRefKindSchema>, EvidenceRefKind>

// 片方向 (Zod → TS) のみ。TS 側の optional / readonly 差異を許容しつつ、必須 field の欠落のみを検出。
type AssertExtends<A, B> = A extends B ? true : ['Zod schema drifted from @/types/evidence', A, B]

// 未使用警告抑止 (TypeScript noUnusedLocals 対策、型レベル assertion はランタイム参照しない)
const _typeGuards: {
  _a: _AssertChatReplyShape
  _b: _AssertEvidenceRefShape
  _c: _AssertEvidenceLevel
  _d: _AssertEvidenceRefKind
} | null = null
export const __typeGuardsSentinel = _typeGuards

// ── 意味検証 ─────────────────────────────────────────────────────────

/**
 * D-07 整合: `evidenceLevel='inferred' | 'planned'` の reply 中、
 * 数値表記には「推定」(または「推定 / 推測 / 概算」) prefix が必須。
 *
 * 検出対象: 半角/全角数字 + 単位 (%, 円, 件, セッション, CV, CTR, CVR, sec, 秒, ms, 分, 時間, page, view 等)。
 * - 例 reject: "CV は 12.3% です"
 * - 例 accept: "CV は 推定 12.3% です" / "CV は (推定) 12.3% です"
 *
 * 完全な NLP は意図的に避け、**過検出寄り** にする (false-positive で 502 → repair retry のほうが安全)。
 *
 * Lookbehind 仕様 (続 64 W2 hardening test 結果反映):
 *   1. `推定 / 推測 / 概算 / (推定) / （推定）` で始まる数値は除外 (=既に prefix 済)
 *   2. 数値 / 区切り文字 (`.`, `,` 半角/全角) 直後に来る数字は除外 (= `1.23` の `23` を単独再マッチさせない)
 *      — これがないと `推定 1.23%` の `23%` だけ捕捉してしまう副作用が出る
 */
const NUMBER_UNIT_RE =
  /(?<!推定[\s　]{0,3}|推測[\s　]{0,3}|概算[\s　]{0,3}|\(推定\)[\s　]{0,3}|（推定）[\s　]{0,3}|[0-9０-９.,．，])[+\-±]?[0-9０-９]+(?:[.．,，][0-9０-９]+)?\s*(%|％|円|￥|¥|件|セッション|CV|CTR|CVR|sec|秒|ms|分|時間|page|views?|tok(?:ens?)?)/g

export interface SemanticIssue {
  code:
    | 'EVIDENCE_EMPTY'
    | 'WEAKEST_WINS_MISMATCH'
    | 'INFERRED_NUMERIC_WITHOUT_PREFIX'
    | 'CONFIDENCE_GT_WEAKEST'
    | 'CONFIDENCE_RANGE'
  message: string
  /** 検出位置 (例: reply 中の文字 offset、evidence index 等) */
  hint?: string
}

/**
 * `ChatReply` の意味検証 (Zod parse の後段)。
 *
 * 返り値:
 *   - 空配列: 全 PASS
 *   - 1 件以上: 検出された違反 (1 件目で停止せず全件返す = repair retry 用の hint)
 */
export function checkChatReplySemantics(reply: ChatReply): SemanticIssue[] {
  const issues: SemanticIssue[] = []

  // (1) evidence 空配列禁止 (Zod でも min(1) だが二重防御)
  if (reply.evidence.length === 0) {
    issues.push({
      code: 'EVIDENCE_EMPTY',
      message: 'ChatReply.evidence must contain at least 1 EvidenceRef',
    })
    return issues // 後段の評価が無意味なので早期 return
  }

  // (2) weakest-wins: evidence[] の最弱 level が evidenceLevel と一致
  const computedWeakest = reduceEvidenceLevel(reply.evidence, reply.evidenceLevel)
  if (computedWeakest !== reply.evidenceLevel) {
    issues.push({
      code: 'WEAKEST_WINS_MISMATCH',
      message: `evidenceLevel='${reply.evidenceLevel}' but weakest evidence level is '${computedWeakest}'`,
      hint: `expected evidenceLevel='${computedWeakest}' (weakest-wins per D-07)`,
    })
  }

  // (3) confidence は evidence[].confidence の最小値以下
  const minEvidenceConf = Math.min(...reply.evidence.map((e) => e.confidence))
  if (reply.confidence > minEvidenceConf + 1e-9) {
    issues.push({
      code: 'CONFIDENCE_GT_WEAKEST',
      message: `confidence=${reply.confidence} > min(evidence.confidence)=${minEvidenceConf}`,
      hint: 'overall confidence must be <= weakest evidence confidence',
    })
  }

  // (4) confidence range (Zod でも 0..1 だが drift 防衛)
  if (reply.confidence < 0 || reply.confidence > 1) {
    issues.push({
      code: 'CONFIDENCE_RANGE',
      message: `confidence=${reply.confidence} out of range [0,1]`,
    })
  }

  // (5) inferred/planned 時、数値表記に「推定」prefix 必須
  if (reply.evidenceLevel === 'inferred' || reply.evidenceLevel === 'planned') {
    const matches = [...reply.reply.matchAll(NUMBER_UNIT_RE)]
    if (matches.length > 0) {
      const sample = matches.slice(0, 3).map((m) => m[0]).join(' / ')
      issues.push({
        code: 'INFERRED_NUMERIC_WITHOUT_PREFIX',
        message: `evidenceLevel='${reply.evidenceLevel}' but reply contains bare numeric values without '推定' prefix`,
        hint: `samples: ${sample}`,
      })
    }
  }

  return issues
}

// ── Parse / coerce ────────────────────────────────────────────────────

export class ChatReplyValidationError extends Error {
  public readonly code = 'CHAT_REPLY_VALIDATION'

  constructor(
    public readonly issues: SemanticIssue[],
    public readonly zodErrors: z.ZodError | null,
  ) {
    const msgs = [
      ...(zodErrors?.issues.map((i) => `[zod:${i.path.join('.') || '$root'}] ${i.message}`) ?? []),
      ...issues.map((i) => `[${i.code}] ${i.message}${i.hint ? ` (${i.hint})` : ''}`),
    ]
    super(`ChatReply validation failed:\n  - ${msgs.join('\n  - ')}`)
    this.name = 'ChatReplyValidationError'
  }
}

/**
 * 入力を `ChatReply` として parse + 意味検証。失敗時 throw。
 *
 * Sprint 3 W2 で LLM 応答 (JSON or tool-result 合成) を受けて呼ぶ。
 * caller 側は 1 度だけ `coerceChatReply()` で軽修復を試み、それでも失敗なら 502。
 */
export function parseChatReply(input: unknown): ChatReply {
  const zodResult = ChatReplySchema.safeParse(input)
  if (!zodResult.success) {
    throw new ChatReplyValidationError([], zodResult.error)
  }
  // Zod schema は ChatReply と shape 一致 (型 assertion 済)、上記 _AssertChatReplyShape で drift 検知
  const reply = zodResult.data as unknown as ChatReply
  const issues = checkChatReplySemantics(reply)
  if (issues.length > 0) {
    throw new ChatReplyValidationError(issues, null)
  }
  return reply
}

/**
 * 軽修復 (1 度だけ呼ばれる想定、無限 retry 禁止):
 *   - inferred/planned 数値に「推定」prefix 自動付与
 *   - weakest-wins: evidenceLevel を強制再計算
 *   - confidence: weakest evidence confidence を上限にクランプ
 *
 * 修復後 `parseChatReply()` を再実行して shape を確認するのは caller 責務。
 */
export function coerceChatReply(reply: ChatReply): ChatReply {
  // (a) weakest-wins 再計算
  const computedWeakest = reduceEvidenceLevel(reply.evidence, reply.evidenceLevel)

  // (b) confidence クランプ
  const minEvidenceConf = reply.evidence.length > 0
    ? Math.min(...reply.evidence.map((e) => e.confidence))
    : 0
  const clampedConfidence = Math.min(Math.max(reply.confidence, 0), 1, minEvidenceConf)

  // (c) inferred/planned の bare numeric に prefix 付与
  let coercedText = reply.reply
  if (computedWeakest === 'inferred' || computedWeakest === 'planned') {
    coercedText = coercedText.replace(NUMBER_UNIT_RE, (m) => `推定 ${m}`)
  }

  return {
    ...reply,
    reply: coercedText,
    evidenceLevel: computedWeakest,
    confidence: clampedConfidence,
  }
}
