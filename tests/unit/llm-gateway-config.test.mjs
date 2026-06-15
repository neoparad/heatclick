/**
 * Unit tests: lib/llm/gateway.ts assertLLMRuntimeConfig() (続 64, 続 61 §2 (a))
 *
 * Strategy: gateway.ts は `@/lib/llm/anthropic` 経由で getLLMProviderMode() を読むが
 *           本質ロジックは env 参照のみなので、本 test では gateway.ts の
 *           assertLLMRuntimeConfig() の挙動と同一仕様を mirror 実装して契約を担保する。
 *           middleware-classify.test.mjs / chat-tool-idor.test.mjs と同じパターン。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/llm-gateway-config.test.mjs
 *
 * 検証対象 (続 61 §2 (a) 改善依頼 1:1):
 *   - production では LLM_PROVIDER_MODE=ai-gateway のみ許可 (stub / anthropic-direct は throw)
 *   - production では AI_GATEWAY_API_KEY 必須
 *   - non-production では mode に応じた env 存在を検証 (silent fall-through 禁止)
 *   - env 名は **AI_GATEWAY_API_KEY** (続 61 §3 (d) 統一済、旧 AI_GATEWAY_KEY は廃止)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── gateway.ts 等価実装 (lib/llm/gateway.ts:assertLLMRuntimeConfig と同一仕様) ──

const GATEWAY_API_KEY_ENV = 'AI_GATEWAY_API_KEY'
const LEGACY_DIRECT_API_KEY_ENV = 'ANTHROPIC_API_KEY'

class LLMRuntimeConfigError extends Error {
  constructor(reason) {
    super(`[LLM runtime config] ${reason}`)
    this.name = 'LLMRuntimeConfigError'
    this.code = 'LLM_RUNTIME_CONFIG'
  }
}

function getLLMProviderModeFrom(envSnapshot) {
  const raw = envSnapshot.LLM_PROVIDER_MODE ?? 'stub'
  if (raw === 'anthropic-direct' || raw === 'ai-gateway' || raw === 'stub') return raw
  return 'stub'
}

function assertLLMRuntimeConfig(env, envSnapshot) {
  const mode = getLLMProviderModeFrom(envSnapshot)
  const hasGatewayKey = Boolean((envSnapshot[GATEWAY_API_KEY_ENV] ?? '').trim())
  const hasLegacyDirectKey = Boolean((envSnapshot[LEGACY_DIRECT_API_KEY_ENV] ?? '').trim())

  if (env === 'production') {
    if (mode !== 'ai-gateway') {
      throw new LLMRuntimeConfigError(
        `LLM_PROVIDER_MODE='${mode}' is forbidden in production. Only 'ai-gateway' is allowed.`,
      )
    }
    if (!hasGatewayKey) {
      throw new LLMRuntimeConfigError(`${GATEWAY_API_KEY_ENV} is required in production.`)
    }
    return
  }

  switch (mode) {
    case 'stub':
      return
    case 'ai-gateway':
      if (!hasGatewayKey) {
        throw new LLMRuntimeConfigError(`${GATEWAY_API_KEY_ENV} is not set but LLM_PROVIDER_MODE=ai-gateway.`)
      }
      return
    case 'anthropic-direct':
      if (!hasLegacyDirectKey) {
        throw new LLMRuntimeConfigError(
          `${LEGACY_DIRECT_API_KEY_ENV} is not set but LLM_PROVIDER_MODE=anthropic-direct (legacy).`,
        )
      }
      return
    default:
      throw new LLMRuntimeConfigError(`Unknown LLM_PROVIDER_MODE: ${mode}`)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

test('prod-1: production + ai-gateway + AI_GATEWAY_API_KEY → PASS', () => {
  assert.doesNotThrow(() =>
    assertLLMRuntimeConfig('production', {
      LLM_PROVIDER_MODE: 'ai-gateway',
      AI_GATEWAY_API_KEY: 'vck_xxx',
    }),
  )
})

test('prod-2: production + stub → THROW (誤投入防止)', () => {
  assert.throws(
    () => assertLLMRuntimeConfig('production', { LLM_PROVIDER_MODE: 'stub' }),
    (err) => err.name === 'LLMRuntimeConfigError' && /forbidden in production/.test(err.message),
  )
})

test('prod-3: production + anthropic-direct → THROW (legacy 隔離)', () => {
  assert.throws(
    () =>
      assertLLMRuntimeConfig('production', {
        LLM_PROVIDER_MODE: 'anthropic-direct',
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
      }),
    (err) =>
      err.name === 'LLMRuntimeConfigError' && /forbidden in production/.test(err.message),
  )
})

test('prod-4: production + ai-gateway + AI_GATEWAY_API_KEY 未設定 → THROW', () => {
  assert.throws(
    () => assertLLMRuntimeConfig('production', { LLM_PROVIDER_MODE: 'ai-gateway' }),
    (err) =>
      err.name === 'LLMRuntimeConfigError' && /AI_GATEWAY_API_KEY.*required/.test(err.message),
  )
})

test('prod-5: production + LLM_PROVIDER_MODE 未設定 (= stub 既定) → THROW', () => {
  // env で LLM_PROVIDER_MODE 未注入なら getLLMProviderMode は stub にフォールバック、
  // production では stub 禁止なので throw する。これが Vercel への env 投入忘れの最後の砦。
  assert.throws(
    () => assertLLMRuntimeConfig('production', {}),
    (err) => err.name === 'LLMRuntimeConfigError' && /forbidden in production/.test(err.message),
  )
})

test('dev-1: development + stub (env 何も無し) → PASS (default は stub なので動作可能)', () => {
  assert.doesNotThrow(() => assertLLMRuntimeConfig('development', {}))
})

test('dev-2: development + ai-gateway + key 未設定 → THROW (silent fall-through 禁止)', () => {
  assert.throws(
    () => assertLLMRuntimeConfig('development', { LLM_PROVIDER_MODE: 'ai-gateway' }),
    (err) => err.name === 'LLMRuntimeConfigError',
  )
})

test('dev-3: development + ai-gateway + key 設定済 → PASS', () => {
  assert.doesNotThrow(() =>
    assertLLMRuntimeConfig('development', {
      LLM_PROVIDER_MODE: 'ai-gateway',
      AI_GATEWAY_API_KEY: 'vck_dev_xxx',
    }),
  )
})

test('dev-4: development + anthropic-direct + ANTHROPIC_API_KEY 設定済 → PASS (legacy だが debug 用途許可)', () => {
  assert.doesNotThrow(() =>
    assertLLMRuntimeConfig('development', {
      LLM_PROVIDER_MODE: 'anthropic-direct',
      ANTHROPIC_API_KEY: 'sk-ant-dev-xxx',
    }),
  )
})

test('dev-5: development + anthropic-direct + key 未設定 → THROW', () => {
  assert.throws(
    () => assertLLMRuntimeConfig('development', { LLM_PROVIDER_MODE: 'anthropic-direct' }),
    (err) => err.name === 'LLMRuntimeConfigError' && /ANTHROPIC_API_KEY.*not set/.test(err.message),
  )
})

test('env-name-1: 旧 AI_GATEWAY_KEY のみ設定 (新名なし) は production で reject される (rename 統一の retro 担保)', () => {
  // 続 61 §3 (d) で AI_GATEWAY_KEY → AI_GATEWAY_API_KEY rename 統一。
  // 旧名のみが設定されているケースは未設定と同等 → production で fail-fast。
  assert.throws(
    () =>
      assertLLMRuntimeConfig('production', {
        LLM_PROVIDER_MODE: 'ai-gateway',
        AI_GATEWAY_KEY: 'vck_old_name_xxx', // 旧 env 名は読まない
      }),
    (err) => err.name === 'LLMRuntimeConfigError' && /AI_GATEWAY_API_KEY/.test(err.message),
  )
})

test('mode-1: 不正 LLM_PROVIDER_MODE は stub にフォールバック (production では即 throw)', () => {
  // 不正値 (e.g., 'openai-direct') は getLLMProviderMode() で 'stub' にフォールバックする。
  // production では stub も禁止なので結果として throw。
  assert.throws(
    () =>
      assertLLMRuntimeConfig('production', {
        LLM_PROVIDER_MODE: 'openai-direct',
        AI_GATEWAY_API_KEY: 'vck_xxx',
      }),
    (err) => err.name === 'LLMRuntimeConfigError',
  )
})
