/**
 * Sentry 共通 beforeSend helpers — PII REDACT + SECRET_PATTERNS guard を 3 config で DRY 共有
 *
 * 親 SSOT §3.8.2 PII REDACT 規約 / Anti-Feature §1.7 (PII 露出禁止)
 * 起票: Infrastructure Engineer 2026-05-17 (深夜・続)
 * Reviewer T1 dual BLOCKER D-2 / D-3 / D-1 / D-4 統合修正
 *
 * 設計判断:
 *   - SECRET_PATTERNS guard (D-3) は beforeSend 冒頭で event 全体を JSON.stringify し pattern match、
 *     ヒットしたら event 破棄 (return null)。D-infra-credentials-001 §7.2 完了基準 #5 整合
 *   - HEADER_REDACT_LIST (D-1) は server/edge config 共通、9 種カバー
 *   - URL query strip (D-2) は client/server/edge 全 config 共通
 *   - event.extra / event.tags / event.contexts sanitizer (D-4) は Phase 1 で受動 strip、
 *     Phase 2 BLOCKER 化前に active recursive sanitizer に拡張
 *   - edge runtime は Node 専用 API 使えないが、JSON.stringify / URL / Object.keys は全て edge 対応
 */

import type { ErrorEvent, EventHint } from '@sentry/nextjs'

// Sprint 0 scaffold drift fix (Frontend P-03 着工時、@sentry/nextjs@8 で beforeSend
// が ErrorEvent 専用 signature に変わったため、Event エイリアスを廃止)

// ============================================================================
// SECRET_PATTERNS guard (D-3): D-infra-credentials-001 §7.2 完了基準 #5
// ============================================================================
//
// Google Ads OAuth credentials + 汎用 secret 形式 7 種。
// event JSON 全体に対する pattern match、1 件でもヒットすれば event 破棄。
// false positive は許容 (suppress 側に倒す = 最終防御ライン)。

export const SECRET_PATTERNS: readonly RegExp[] = [
  /refresh_token/i,
  /developer_token/i,
  /client_secret/i,
  /access_token/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /AIza[0-9A-Za-z\-_]{35}/, // Google API key (Maps / Vision / etc.)
  /1\/\/0[0-9A-Za-z\-_]{60,}/, // Google OAuth refresh_token
  // H-4 fix (Reviewer T1 dual 続 10): SaaS で頻出する secret prefix 5 種追加。
  // event.extra / event.contexts に raw payload が紛れた場合の最終防衛。
  /\bsk_(live|test)_[0-9A-Za-z]{16,}/, // Stripe Secret Key
  /\b(ghp_|gho_|ghu_|ghs_|ghr_)[0-9A-Za-z]{36,}/, // GitHub Personal/OAuth/App tokens
  /\bxox[abprsv]-[0-9A-Za-z\-]{10,}/, // Slack Bot/User/App tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS Access Key ID
  /\bre_[0-9A-Za-z]{16,}/, // Resend API key
] as const

// ============================================================================
// Header REDACT (D-1): 9 種カバー
// ============================================================================
//
// authorization / cookie / x-api-key (既存 server config 3 種) +
// proxy-authorization / set-cookie / x-auth-token / x-csrf-token / x-forwarded-for /
// x-forwarded-host (Codex 指摘 6 種)。
// x-user-email は middleware Sprint 1 refactor で撤去予定 (Infra §2.2 task 3)、
// 撤去まで二重防御として REDACT 対象に含める。

const HEADER_REDACT_LIST: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
  'set-cookie',
  'x-auth-token',
  'x-csrf-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-user-email', // middleware 撤去まで二重防御
])

// ============================================================================
// extra / tags / contexts sanitizer (D-4): Phase 2 BLOCKER 化前の予防防御
// ============================================================================
//
// Phase 1 では SECRET_PATTERNS で event 全体 strip 済のため二重防御。
// captureException(err, { extra: { rawUser: user } }) のような future call で
// raw object が leak する経路を string-level 検査で予防する。

function sanitizeContextField(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    // 値そのものに secret pattern が含まれれば REDACT 文字列に置換
    for (const re of SECRET_PATTERNS) {
      if (re.test(value)) return '[REDACTED-BY-SHARED]'
    }
    return value
  }
  if (typeof value === 'object') {
    // 浅い 1 階層のみ string-level sanitize (深い再帰は Phase 2 で拡張)
    try {
      const json = JSON.stringify(value)
      for (const re of SECRET_PATTERNS) {
        if (re.test(json)) return '[REDACTED-OBJECT-BY-SHARED]'
      }
    } catch {
      /* ignore non-serializable */
    }
    return value
  }
  return value
}

// ============================================================================
// 統合 beforeSend (D-2 / D-3 / D-1 / D-4 を 1 関数に集約)
// ============================================================================

export interface SharedBeforeSendOptions {
  /** server / edge は true、client (browser) は false (browser headers は元々最小) */
  redactRequestHeaders: boolean
}

export function createSharedBeforeSend(opts: SharedBeforeSendOptions) {
  const { redactRequestHeaders } = opts

  return function sharedBeforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
    // ----- D-3: SECRET_PATTERNS guard (最終防御、最優先) -----
    try {
      const json = JSON.stringify(event)
      if (SECRET_PATTERNS.some((re) => re.test(json))) {
        // 意図的 console.error で監視 (Sentry には送らない、無限ループ回避)
        // eslint-disable-next-line no-console
        console.error(
          '[SECRET-LEAK-GUARD] Sentry event contained secret-like pattern, suppressed',
        )
        return null // event 破棄
      }
    } catch {
      /* ignore JSON.stringify failure (循環参照等)、後段の field-level strip に委ねる */
    }

    // ----- 既存 PII REDACT: user (3 config 共通) -----
    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
      delete event.user.username
    }

    // ----- 既存 PII REDACT: cookies (3 config 共通、opt-in safe) -----
    if (event.request?.cookies) {
      const safe: Record<string, string> = {}
      for (const [key] of Object.entries(event.request.cookies)) {
        if (key === 'ugokimap_saas_token') {
          safe[key] = '[REDACTED]'
        }
        // それ以外の cookie は drop (allowlist 方式)
      }
      event.request.cookies = safe
    }

    // ----- D-1: header REDACT (server / edge config 用、client では skip) -----
    if (redactRequestHeaders && event.request?.headers) {
      const headers = event.request.headers as Record<string, string>
      for (const key of Object.keys(headers)) {
        if (HEADER_REDACT_LIST.has(key.toLowerCase())) {
          headers[key] = '[REDACTED]'
        }
      }
    }

    // ----- D-2: URL query strip (3 config 共通、edge config に欠落していた BLOCKER) -----
    if (event.request?.url) {
      try {
        const u = new URL(event.request.url)
        u.search = ''
        event.request.url = u.toString()
      } catch {
        /* malformed URL: そのまま (どのみち event は強い加工対象) */
      }
    }

    // ----- D-4: event.extra / event.tags / event.contexts string-level sanitize -----
    if (event.extra) {
      for (const key of Object.keys(event.extra)) {
        event.extra[key] = sanitizeContextField(event.extra[key])
      }
    }
    if (event.tags) {
      for (const key of Object.keys(event.tags)) {
        const sanitized = sanitizeContextField(event.tags[key])
        // tags は string | number | boolean | null | undefined のみ許容
        if (
          typeof sanitized === 'string' ||
          typeof sanitized === 'number' ||
          typeof sanitized === 'boolean' ||
          sanitized == null
        ) {
          event.tags[key] = sanitized
        } else {
          event.tags[key] = '[REDACTED]'
        }
      }
    }
    if (event.contexts) {
      for (const ctxKey of Object.keys(event.contexts)) {
        const ctx = event.contexts[ctxKey]
        if (ctx && typeof ctx === 'object') {
          for (const k of Object.keys(ctx)) {
            ;(ctx as Record<string, unknown>)[k] = sanitizeContextField(
              (ctx as Record<string, unknown>)[k],
            )
          }
        }
      }
    }

    return event
  }
}

// ============================================================================
// テスト用 export (本番コードからは使わない)
// ============================================================================

export const __TEST_ONLY__ = {
  SECRET_PATTERNS,
  HEADER_REDACT_LIST,
  sanitizeContextField,
}
