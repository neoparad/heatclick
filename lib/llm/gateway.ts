/**
 * lib/llm/gateway.ts — Vercel AI Gateway SSOT (Sprint 3 W2 hardening, 続 64)
 *
 * 親 SSOT §2.2.6 LLM 抽象化 / §3.5.2 routing
 * 配備根拠: 続 61 §2 (a) Reviewer Codex GREEN 条件付き、W2 着工前完了条件
 *
 * 設計方針 (続 61 §2 (a) の改善依頼 1:1 対応):
 *   1. Gateway model id (`anthropic/claude-...` 形式) を本ファイルで一元管理
 *      → `app/api/chat/route.ts` / W2 で実装する `runChatCompletion()` は
 *        いずれも `getGatewayDefaultModel()` 経由で参照、文字列リテラル禁止
 *   2. `anthropic-direct` mode は legacy として隔離:
 *        - non-production では debug 用途のみ許可 (env が揃った場合のみ)
 *        - **production 起動時 fail-fast** = mode != 'ai-gateway' で throw
 *   3. provider mode と必要 env の整合を `assertLLMRuntimeConfig()` で startup check
 *      Next.js には true startup hook が無いため、`instrumentation.ts` + 各 LLM 経路
 *      ハンドラ先頭で呼び出す lazy assertion 戦略を採る
 *   4. env 名は **`AI_GATEWAY_API_KEY`** (Vercel 標準、続 61 §3 (d))。
 *      旧 `AI_GATEWAY_KEY` は本続 64 で .env.example + コード参照箇所すべて統一
 *
 * Sprint 3 W2 本実装 (続 65+ 予定) の参照箇所:
 *   - `lib/llm/anthropic.ts:runChatCompletion()` (新規): `getGatewayDefaultModel()` を採用
 *   - `app/api/chat/route.ts`: ハンドラ先頭で `assertLLMRuntimeConfig()` を呼ぶ
 *   - `instrumentation.ts` (新規予定): プロセス起動時 fail-fast
 */

import { getLLMProviderMode, type LLMProviderMode } from './anthropic'

/**
 * Vercel AI Gateway 経由で参照する既定 model id。
 *
 * 形式: `<provider>/<model-id>` (Vercel knowledge-update 整合)
 * 既定: Anthropic Claude Sonnet 4.5 安定版。env `AI_GATEWAY_DEFAULT_MODEL` で override 可能。
 *
 * **重要 (続 82-ml Codex T1 fix #6)**: Vercel AI Gateway の正規 model slug は
 * `@ai-sdk/gateway` の model registry (`GatewayModelId`) に列挙された値のみ受理される。
 * Anthropic Sonnet 4.5 の正規 slug は **`anthropic/claude-sonnet-4.5`** (dot 区切り、date suffix なし)。
 * 旧値 `anthropic/claude-sonnet-4-5-20250929` は registry 非掲載のため `generateText` が
 * model 解決に失敗 → freeform が常に stub に degrade する (機能が一切動かない) 不具合だった。
 *
 * Sprint 3 W2 着工後、コスト最適化動機 (続 60 §2) に従い質問の重さで自動振り分け
 * (e.g., 短い質問は `google/gemini-2.5-flash`) を Gateway 側 routing 設定で実現する。
 * 本 SSOT は **既定 Anthropic ルート** を返すのみ、provider 自動切替は Gateway 側責務。
 */
const DEFAULT_GATEWAY_MODEL = 'anthropic/claude-sonnet-4.5'

/** Vercel AI Gateway の標準 env 名 (続 61 §3 (d) 統一済) */
export const GATEWAY_API_KEY_ENV = 'AI_GATEWAY_API_KEY'

/** 直接 Anthropic SDK ルート用 legacy env (production では使用禁止) */
export const LEGACY_DIRECT_API_KEY_ENV = 'ANTHROPIC_API_KEY'

/** Gateway model id override 用 env (任意、未設定時は DEFAULT_GATEWAY_MODEL) */
export const GATEWAY_MODEL_ENV = 'AI_GATEWAY_DEFAULT_MODEL'

/** 評価対象 NODE_ENV (test では明示注入できるよう引数化) */
export type NodeEnv = 'development' | 'test' | 'production'

export interface GatewayConfig {
  /** 解決済 provider mode (`stub` / `anthropic-direct` / `ai-gateway`) */
  mode: LLMProviderMode
  /** Gateway model id (mode != 'ai-gateway' でも参照可、W2 で actual call 時に消費) */
  model: string
  /** AI_GATEWAY_API_KEY の有無 (値そのものは返さない、漏洩面縮小) */
  hasGatewayKey: boolean
  /** ANTHROPIC_API_KEY の有無 (legacy direct mode 用) */
  hasLegacyDirectKey: boolean
}

/**
 * Gateway 既定 model id を返す。env override 優先、未設定時は SSOT 既定値。
 *
 * W2 で `runChatCompletion()` から呼ぶ。文字列リテラル `'anthropic/claude-...'` を
 * 他ファイルに散らさず、ここを SSOT として統一する (続 61 §2 (a) ⓐ)。
 */
export function getGatewayDefaultModel(): string {
  const override = process.env[GATEWAY_MODEL_ENV]?.trim()
  return override && override.length > 0 ? override : DEFAULT_GATEWAY_MODEL
}

/**
 * 現在の Gateway 設定 snapshot を返す。secret 値は返さず、有無 boolean のみ。
 */
export function getGatewayConfig(): GatewayConfig {
  return {
    mode: getLLMProviderMode(),
    model: getGatewayDefaultModel(),
    hasGatewayKey: Boolean(process.env[GATEWAY_API_KEY_ENV]?.trim()),
    hasLegacyDirectKey: Boolean(process.env[LEGACY_DIRECT_API_KEY_ENV]?.trim()),
  }
}

/**
 * Runtime config validation 失敗を表す。production 起動 / リクエスト先頭で throw。
 *
 * `message` 中に **secret 値を含めない** こと (env 名のみ)。
 * Sentry / pino log にそのまま流しても安全な setup を維持する。
 */
export class LLMRuntimeConfigError extends Error {
  public readonly code = 'LLM_RUNTIME_CONFIG'

  constructor(reason: string) {
    super(`[LLM runtime config] ${reason}`)
    this.name = 'LLMRuntimeConfigError'
  }
}

/**
 * Production 起動時 fail-fast + dev/test mode-env 整合 check。
 *
 * 続 61 §2 (a) 改善依頼:
 *   - production では `LLM_PROVIDER_MODE=ai-gateway` のみ許可
 *     (`stub` / `anthropic-direct` は誤投入防止のため起動不可)
 *   - production では `AI_GATEWAY_API_KEY` 必須
 *   - non-production では mode に応じた env 存在を検証 (silent fall-through 禁止)
 *
 * 呼び出し箇所:
 *   - `instrumentation.ts:register()` (プロセス起動時)
 *   - `app/api/chat/route.ts:POST()` 先頭 (request 時の二重防御)
 *
 * @param env 評価対象 NODE_ENV。既定は `process.env.NODE_ENV ?? 'development'`。
 *            test では明示注入することで NODE_ENV 切替なしに分岐を網羅できる。
 * @throws LLMRuntimeConfigError 起動 / 受付不可な構成のとき
 */
export function assertLLMRuntimeConfig(env: NodeEnv = resolveNodeEnv()): void {
  const cfg = getGatewayConfig()

  if (env === 'production') {
    if (cfg.mode !== 'ai-gateway') {
      throw new LLMRuntimeConfigError(
        `LLM_PROVIDER_MODE='${cfg.mode}' is forbidden in production. ` +
          `Only 'ai-gateway' is allowed (legacy isolation, 続 61 §2 (a)). ` +
          `Set LLM_PROVIDER_MODE=ai-gateway and ${GATEWAY_API_KEY_ENV} in Vercel env.`,
      )
    }
    if (!cfg.hasGatewayKey) {
      throw new LLMRuntimeConfigError(
        `${GATEWAY_API_KEY_ENV} is required in production when LLM_PROVIDER_MODE=ai-gateway.`,
      )
    }
    // production では legacy direct key の残置を warning として観測対象に
    // (throw はしない — direct mode を使わない限り副作用ゼロ、削除指示は Owner 経由で別途)
    return
  }

  // non-production (development / test)
  switch (cfg.mode) {
    case 'stub':
      // stub は env 不要、常に許可
      return
    case 'ai-gateway':
      if (!cfg.hasGatewayKey) {
        throw new LLMRuntimeConfigError(
          `${GATEWAY_API_KEY_ENV} is not set but LLM_PROVIDER_MODE=ai-gateway. ` +
            `Configure ${GATEWAY_API_KEY_ENV} in .env.local or fall back to stub mode.`,
        )
      }
      return
    case 'anthropic-direct':
      if (!cfg.hasLegacyDirectKey) {
        throw new LLMRuntimeConfigError(
          `${LEGACY_DIRECT_API_KEY_ENV} is not set but LLM_PROVIDER_MODE=anthropic-direct (legacy). ` +
            `'anthropic-direct' is legacy-isolated; prefer 'ai-gateway' for production.`,
        )
      }
      return
    default: {
      // exhaustiveness — `LLMProviderMode` 拡張時にここでコンパイルエラー
      const _exhaustive: never = cfg.mode
      throw new LLMRuntimeConfigError(`Unknown LLM_PROVIDER_MODE: ${String(_exhaustive)}`)
    }
  }
}

/**
 * `process.env.NODE_ENV` を `NodeEnv` 型に正規化。
 * 想定外値は `'development'` 扱い (本番誤判定回避: production と認識するには明示 'production' のみ)。
 */
function resolveNodeEnv(): NodeEnv {
  const raw = process.env.NODE_ENV
  if (raw === 'production' || raw === 'test' || raw === 'development') return raw
  return 'development'
}
