/**
 * lib/llm/anthropic.ts — Claude API client wrapper (mode-aware、legacy direct path)
 *
 * 親 SSOT §2.2.6 LLM 抽象化 / §3.5.2 routing
 * 配備: 続 54 §2.2 + 続 57 (Sprint 3 W1 chat stub) + 続 64 (W2 hardening, legacy 隔離)
 *
 * 設計方針:
 *   - **canonical 経路は `lib/llm/gateway.ts` (Vercel AI Gateway)** — 続 60 §2 で Owner 判断確定、
 *     続 61 §2 (a) で SSOT 化、続 64 で本ファイルを legacy direct ルートに隔離。
 *   - mode は `LLM_PROVIDER_MODE` env (`stub` / `anthropic-direct` / `ai-gateway`) で切替。
 *     既定 = `stub` (env 未設定時の fail-safe)。
 *   - production 起動時 fail-fast は `gateway.ts:assertLLMRuntimeConfig()` で担保
 *     (mode != 'ai-gateway' → throw、本ファイル `getAnthropicClient()` は production では実質呼ばれない)。
 *   - secrets (`ANTHROPIC_API_KEY` / `AI_GATEWAY_API_KEY`) は `.env.local` のみ。git コミット禁止。
 *     ※ env 名は続 61 §3 (d) で Vercel 標準 `AI_GATEWAY_API_KEY` に統一済 (旧 `AI_GATEWAY_KEY` は廃止)
 *
 * Sprint 3 W2 (続 65+ 予定) の TODO:
 *   - `runChatCompletion()` の本実装 (gateway.ts 経由、AI SDK v6 `streamText`)
 *   - tool calling (`fetch_clickhouse_data`) は `lib/llm/tools.ts` (続 64 配備済) を利用
 *   - ChatReply 検証は `lib/llm/chat-reply-validator.ts` (続 64 配備済) を利用
 *   - tenant あたり 60 req/h の rate limit middleware 統合 (lib/rate-limit.ts)
 */

import Anthropic from '@anthropic-ai/sdk'

export type LLMProviderMode = 'stub' | 'anthropic-direct' | 'ai-gateway'

/**
 * Provider mode を env から取得。
 * 既定値は 'stub' — 続 54 §3.1 B の合議で `anthropic-direct` or `ai-gateway` 確定後、
 * Vercel env で `LLM_PROVIDER_MODE` を切替える。
 */
export function getLLMProviderMode(): LLMProviderMode {
  const raw = process.env.LLM_PROVIDER_MODE ?? 'stub'
  if (raw === 'anthropic-direct' || raw === 'ai-gateway' || raw === 'stub') {
    return raw
  }
  // 不正値は fail-safe で stub
  return 'stub'
}

/**
 * @deprecated 続 64 で legacy direct ルートに隔離。canonical 経路は `lib/llm/gateway.ts`。
 *
 * 続 54 §3.1 B の直接 Anthropic SDK ルート用 client (legacy)。
 *   - production では `assertLLMRuntimeConfig()` が起動時に弾くため呼ばれない
 *   - non-production debug 用途のみ。`LLM_PROVIDER_MODE=anthropic-direct` + `ANTHROPIC_API_KEY` 必須
 *   - 新規 callsite は `gateway.ts` 経由を強く推奨
 */
let _anthropicClient: Anthropic | null = null

export function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not set — see .env.example. ' +
        'Note: anthropic-direct is legacy (続 64), prefer LLM_PROVIDER_MODE=ai-gateway + AI_GATEWAY_API_KEY.',
    )
  }
  _anthropicClient = new Anthropic({ apiKey })
  return _anthropicClient
}

/**
 * @deprecated 続 64 で `getGatewayDefaultModel()` (lib/llm/gateway.ts) に移行。
 *
 * legacy direct mode 用の model ID (provider prefix なし)。
 * canonical は `gateway.ts:getGatewayDefaultModel()` (`anthropic/claude-sonnet-4-5-20250929` 等)。
 */
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6'

/**
 * Stub response (Sprint 3 W1)。
 * 本接続は Sprint 3 W2 で `runChatCompletion()` を実装 → mode 分岐で本物に切替。
 *
 * 設計メモ:
 *   - W1 stub は **D-07 整合の inferred / planned-only** 応答に固定。
 *     断定数値を埋めない (例: 「推定 X%」「(推定)」suffix を含む reply)。
 *   - suggestions は mockup `10_ai_chat.html` で観測した chip 文言を流用。
 */
export interface StubChatInput {
  message: string
  siteId: string
  periodDays: number
}

export interface StubChatOutput {
  reply: string
  suggestions: string[]
}

export function buildStubReply(input: StubChatInput): StubChatOutput {
  const trimmed = input.message.trim().slice(0, 200)
  const reply = [
    `[STUB] ご質問「${trimmed}」を受け付けました。`,
    `直近 ${input.periodDays} 日分の site=${input.siteId} データから、推定で関連指標を確認します (Sprint 3 W1 stub: 実 LLM 応答は W2 で本接続)。`,
    '',
    '※ この応答は実 LLM 呼び出し前の固定 stub です。Evidence Level: planned。',
  ].join('\n')

  return {
    reply,
    suggestions: ['同期間の他ページも比較', 'CVR の時系列推移', 'デバイス別の離脱差分'],
  }
}
