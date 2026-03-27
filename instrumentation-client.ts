import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || '',

  // パフォーマンス監視: 本番は10%サンプリング
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // セッションリプレイ: 本番は1%、エラー時100%
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  // 開発環境では無効化
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,

  // PII送信を最小化
  sendDefaultPii: false,

  environment: process.env.NODE_ENV || 'development',
})
