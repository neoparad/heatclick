/**
 * Sentry browser-side config
 *
 * 親 SSOT §6.3 S0-11 + cross-cutting-concerns.md §3.2.4
 *
 * - release は next.config.js の env (NEXT_PUBLIC_SENTRY_RELEASE) 経由で build-time 注入
 * - PII REDACT / SECRET_PATTERNS guard / header REDACT / extra-tags-contexts sanitize は
 *   sentry.shared.ts に集約 (D-2 / D-3 / D-1 / D-4 統合修正、Reviewer T1 dual 2026-05-17 深夜)
 * - Session Replay は §1.7 Anti-Features 「セッション録画」と衝突するため使わない
 * - browser (client) は redactRequestHeaders=false (browser headers は元々最小、原則 cookie / authorization なし)
 */

import * as Sentry from '@sentry/nextjs'

import { createSharedBeforeSend } from './sentry.shared'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,

  // sampling: production は 10%、それ以外は 100%
  tracesSampleRate:
    (process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV) === 'production' ? 0.1 : 1.0,

  // §1.7 Anti-Features「セッション録画」抵触のため完全に無効
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,

  beforeSend: createSharedBeforeSend({ redactRequestHeaders: false }),
})
