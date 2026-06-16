/**
 * Sentry server-side config (Node runtime)
 *
 * 親 SSOT §6.3 S0-11 + cross-cutting-concerns.md §3.2.4
 *
 * - release は Vercel build env から自動注入 (NEXT_PUBLIC_SENTRY_RELEASE と一致)
 * - tenant_id を Sentry tag に注入する場合は middleware / API route で `Sentry.setTag('tenant_id', ...)` を明示
 *   (PII REDACT 規約により tenant_id は opaque ID として扱う、暗号化 raw email 等は送らない)
 * - PII REDACT / SECRET_PATTERNS guard / header REDACT (9 種) / extra-tags-contexts sanitize は
 *   sentry.shared.ts に集約 (D-2 / D-3 / D-1 / D-4 統合修正、Reviewer T1 dual 2026-05-17 深夜)
 * - server は redactRequestHeaders=true (proxy / cookie / auth headers 全 REDACT)
 */

import * as Sentry from '@sentry/nextjs'

import { createSharedBeforeSend } from './sentry.shared'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,

  tracesSampleRate:
    (process.env.VERCEL_ENV || process.env.NODE_ENV) === 'production' ? 0.1 : 1.0,

  beforeSend: createSharedBeforeSend({ redactRequestHeaders: true }),
})
