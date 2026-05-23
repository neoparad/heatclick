/**
 * @type {import('next').NextConfig}
 *
 * Cross-cutting concerns (cross-cutting-concerns.md v0.1):
 *   - §1.3   images.remotePatterns = STATIC (LINKTH 配下) + DYNAMIC (config/partner-hosts.json)
 *   - §3.2.3 @sentry/nextjs source map upload via withSentryConfig (Vercel build only)
 */

const { withSentryConfig } = require('@sentry/nextjs')

// 顧客サイトの thumbnail / OGP 許可ホスト (PR + Director 承認で追加、cross-cutting §1.3.2)
const PARTNER_HOSTS = require('./config/partner-hosts.json')

const STATIC_REMOTE_PATTERNS = [
  // LINKTH / 自社配下
  { protocol: 'https', hostname: '*.vercel.app' },
  { protocol: 'https', hostname: '*.ugokimap.com' },
  { protocol: 'https', hostname: '*.linkth.co.jp' },
]

// SSRF 防御: 内部 IP / metadata endpoint / .local 等を pattern として拒否
// schema 側でも禁止しているが、JSON 改竄に備えて build 時に再確認
const FORBIDDEN_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /metadata/i,
  /\.local$/i,
  /\.lan$/i,
  /\.internal$/i,
  /\.localhost$/i,
  /\*\*/,
]

const partnerPatterns = (PARTNER_HOSTS.hosts || []).reduce((acc, host) => {
  if (typeof host !== 'string' || host.length === 0) {
    return acc
  }
  if (FORBIDDEN_HOST_PATTERNS.some((re) => re.test(host))) {
    // build を fail させる (silent drop しない、Director / Infra に気付かせる)
    throw new Error(
      `partner-hosts.json forbidden host detected: '${host}'. ` +
        'See config/partner-hosts.schema.json + cross-cutting-concerns.md §1.3.2.'
    )
  }
  acc.push({ protocol: 'https', hostname: host })
  return acc
}, [])

/** @type {import('next').NextConfig} */
const baseConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // §1.3 cross-cutting images.remotePatterns (STATIC + DYNAMIC)
  images: {
    remotePatterns: [...STATIC_REMOTE_PATTERNS, ...partnerPatterns],
    // Image Optimization API のキャッシュ TTL (default 60s) を 1h に延長 — Vercel 帯域節約
    minimumCacheTTL: 3600,
  },

  // Headers for security + privacy (parent SSOT §3.8)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ]
  },

  // API routes: 高速応答 (集約 MV 経由)
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  // Sentry release を build-time に client / server / edge config から読めるよう env 経由で渡す
  env: {
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.VERCEL_GIT_COMMIT_SHA
      ? `ugokimap-saas@${String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 12)}`
      : undefined,
  },
}

// ──────────────────────────────────────────────────────────────────────
// Sentry config (cross-cutting §3.2.3)
//   - Vercel build 時のみ source map upload (`disable*WebpackPlugin: !VERCEL`)
//   - release = `ugokimap-saas@${VERCEL_GIT_COMMIT_SHA[:12]}` (1 commit = 1 release)
//   - hideSourceMaps=true で本番 bundle に source map を残さない
//   - widenClientFileUpload=true で /_next/static の関連を漏れなく upload
// ──────────────────────────────────────────────────────────────────────
const sentryWebpackPluginOptions = {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Vercel 環境でのみ upload (ローカル dev / CI は無効化、SENTRY_AUTH_TOKEN 漏洩リスク回避)
  disableServerWebpackPlugin: !process.env.VERCEL,
  disableClientWebpackPlugin: !process.env.VERCEL,

  release: process.env.VERCEL_GIT_COMMIT_SHA
    ? `ugokimap-saas@${String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 12)}`
    : undefined,

  hideSourceMaps: true,
  widenClientFileUpload: true,

  // Tree-shake server SDK の logger (bundle size 削減)
  disableLogger: true,

  // 自動 instrumentation は middleware と衝突するため明示 off
  // (middleware.ts で必要な catch は明示 captureException で書く)
  autoInstrumentServerFunctions: false,
  autoInstrumentMiddleware: false,
}

module.exports = withSentryConfig(baseConfig, sentryWebpackPluginOptions)
