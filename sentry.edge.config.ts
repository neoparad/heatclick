/**
 * Sentry edge-runtime config (middleware / edge functions)
 *
 * 親 SSOT §6.3 S0-11 + cross-cutting-concerns.md §3.2.4
 *
 * edge runtime は `URL` / `Headers` / `JSON` 等の Web API のみ利用可。Node 専用 API は使えない。
 *
 * - PII REDACT / SECRET_PATTERNS guard / header REDACT (9 種) / URL query strip / extra-tags-contexts sanitize は
 *   sentry.shared.ts に集約 (D-2 / D-3 / D-1 / D-4 統合修正、Reviewer T1 dual 2026-05-17 深夜)
 *   特に D-2 (edge config の URL query / header REDACT 欠落) は本 refactor で解消
 * - edge は redactRequestHeaders=true (middleware が x-user-email / authorization を扱う = 必須)
 * - 加えて middleware Sprint 1 refactor (S1-09) で x-user-email 自体を撤去予定 (二重防御)
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
