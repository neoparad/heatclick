/**
 * Next.js Instrumentation (Sentry init)
 *
 * 親 SSOT §3.7.1 / §6.3 S0-11
 * Sprint 0 S0-11 完成版。
 *
 * Next.js 14 instrumentation hook で Sentry を server/edge/client 各 runtime に
 * 適切に初期化する。
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}
