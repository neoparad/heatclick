# Cross-cutting concerns — Infra 起点 3 件

**起票**: Infrastructure Engineer (2026-05-16 夜)
**親 SSOT**: `linkscrawl/docs/fusion/strategy/19_grand_v1.md` §3.6 / §3.8 / §5.5
**対応裁定**: decisions.md 2026-05-16 夕 — Infra タスク 3 (Reviewer F-1 5 件のうち Infra 起点 3 件)
**期限**: Sprint 1 着工前

Reviewer F-1 で指摘された Cross-cutting concerns 5 件のうち、Frontend 起点 (Stripe Preview 切替 / robots.txt + auth noindex) は Frontend 側 §5.5 末尾追記担当。本 doc は **Infra 起点 3 件** の設計を確定する。

---

## 概要

| # | 項目 | 担当 | 完了期限 |
|---|---|---|---|
| 1 | `next.config.js` `images.remotePatterns` で顧客サイト thumbnail 用 URL allowlist | Infra | Sprint 1 着工前 |
| 2 | middleware path allowlist (`/api/health`, `/api/auth/*` は tenant 検証 skip、その他強制) | Infra | Sprint 1 着工前 |
| 3 | `@sentry/nextjs` source map upload を Vercel build hook で release version + source map 自動化 | Infra | Sprint 1 着工前 |

---

# 1. `next.config.js` `images.remotePatterns` 顧客サイト thumbnail allowlist

## 1.1 現状

```javascript
// next.config.js (Sprint 0 scaffold 時点)
images: {
  remotePatterns: [
    { protocol: 'https', hostname: '*.vercel.app' },
    { protocol: 'https', hostname: '*.ugokimap.com' },
    { protocol: 'https', hostname: '*.linkth.co.jp' },
  ],
}
```

LINKTH 配下 + Vercel preview のみ許可されている。**顧客サイトの thumbnail (例: bihadashop.jp の OGP 画像)** を `next/image` で表示すると **Next.js が default で 400 を返す**。Sprint 2 以降の P-04 heatmap (page thumbnail) / P-15 performance (画像視認分析) で必須機能。

## 1.2 セキュリティ制約

- **`{ hostname: '**' }` ワイルドカードは使わない**: Next.js Image Optimization API がそのまま image proxy になり SSRF (内部 IP / cloud metadata エンドポイントへの fetch) のリスク
- **DB-driven allowlist** が理想だが、`next.config.js` は build time 評価で動的にできない。代替として「**起動時にレジストリ DB から hostname を pull → 環境変数で next.config.js に注入**」をする
  - Phase 1 (Sprint 1) はリポジトリに静的 allowlist + 「顧客が `sites` テーブル登録時に `tracking_id` から自動派生する hostname を許可リスト追加する PR」運用 (週 1 回の Infra マージ)
  - Phase 2 (Sprint 5 末) でビルドステップでレジストリ pull する dynamic 化を検討

## 1.3 確定設計

### 1.3.1 静的 allowlist の構造化

```javascript
// next.config.js
const PARTNER_HOSTS = require('./config/partner-hosts.json')

const nextConfig = {
  // ...
  images: {
    remotePatterns: [
      // LINKTH 配下
      { protocol: 'https', hostname: '*.vercel.app' },
      { protocol: 'https', hostname: '*.ugokimap.com' },
      { protocol: 'https', hostname: '*.linkth.co.jp' },

      // 顧客サイト (config/partner-hosts.json から動的展開、JSON 編集 = PR で追加)
      ...PARTNER_HOSTS.map((host) => ({
        protocol: 'https',
        hostname: host,
        // pathname 制限なし (顧客サイトの任意 OGP / static asset)
        // ただし port 制限なし = 標準 443 のみ受理 (Next.js default)
      })),
    ],
    // Image Optimization API のキャッシュ TTL (default 60s) を 1h に延長
    minimumCacheTTL: 3600,
    // domain alias 廃止 (deprecated、remotePatterns 一本化)
  },
}
```

### 1.3.2 `config/partner-hosts.json` (Sprint 1 初期)

```json
{
  "$schema": "./partner-hosts.schema.json",
  "_comment": "顧客サイトの thumbnail 許可ホスト。追加は Infra PR + Director merge。`*` ワイルドカードは subdomain のみ可、`**` は禁止。",
  "_audit_log": "decisions.md [→Infra] タグで顧客追加時に追記",
  "hosts": [
    "bihadashop.jp",
    "wakegai.jp"
  ]
}
```

### 1.3.3 partner-hosts.schema.json (PR validation 用)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["hosts"],
  "properties": {
    "hosts": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^(\\*\\.)?[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$",
        "not": { "pattern": "^(localhost|127\\.|10\\.|192\\.168\\.|169\\.254\\.|metadata|internal)" }
      }
    }
  }
}
```

PR で `partner-hosts.json` を変更したら GitHub Actions で `ajv-cli` 等で schema validate (lint job に追加、別 PR)。

### 1.3.4 SSRF 追加防御 (アプリ層)

`next/image` 経由ではなく自前で `<img>` を出す or `fetch` する場合は `lib/url-allowlist.ts` で hostname を再検証:

```typescript
// lib/url-allowlist.ts
import partnerHosts from '@/config/partner-hosts.json'

const STATIC_ALLOW = new Set([
  'vercel.app', 'ugokimap.com', 'linkth.co.jp',
])

export function isAllowedHost(input: string): boolean {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:') return false
    if (url.port && url.port !== '443') return false
    const host = url.hostname.toLowerCase()

    // 内部 IP / metadata 拒否
    if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host))
      return false

    // 静的 allow (subdomain 一致)
    for (const root of STATIC_ALLOW) {
      if (host === root || host.endsWith('.' + root)) return true
    }

    // partner-hosts.json (subdomain 一致)
    for (const root of partnerHosts.hosts) {
      const stripped = root.startsWith('*.') ? root.slice(2) : root
      if (host === stripped || host.endsWith('.' + stripped)) return true
    }

    return false
  } catch {
    return false
  }
}
```

---

# 2. middleware path allowlist (tenant 検証 skip 経路)

## 2.1 現状

`middleware.ts` (Sprint 0 scaffold) は `PUBLIC_ROUTES` に `/api/health` / `/api/track` を含むが、JWT 検証ロジックは TODO のまま。Sprint 1 で実装する際の **path allowlist 設計** をここで確定。

## 2.2 確定方針

### 2.2.1 4 区分

| 区分 | 例 | 認証 | tenant_id 注入 | audit_events emit |
|---|---|---|---|---|
| `public` | `/`, `/auth/sign-in`, `/legal/*` | 不要 | 不要 | しない |
| `auth-public-api` | `/api/auth/sign-in`, `/api/auth/sign-up`, `/api/auth/verify`, `/api/auth/reset` | 不要 | 不要 | する (action='auth.*') |
| `health` | `/api/health` | 不要 | 不要 | しない (uptime monitor のノイズ防止) |
| `ingest` | `/api/track` | 不要 (site_id ベース、Worker 経由) | 不要 (Worker が tenant_id 解決済) | しない (volume 過大、Worker 側で audit) |
| `tenant-protected` | 上記以外の `/api/**`, `/app/**` | **必須** (JWT) | **必須** | **必須** (200/4xx 全件) |

### 2.2.2 middleware 実装パターン

```typescript
// middleware.ts (Sprint 1 完成版の骨格)
import { NextResponse, NextRequest } from 'next/server'
import { verifyJwt } from '@/lib/jwt'
import { emitAuditEvent } from '@/lib/audit'

// path 区分判定 (上から順、最初にヒットした区分を採用)
const PATH_PUBLIC = [
  /^\/$/,
  /^\/auth\/(sign-in|sign-up|verify|reset)$/,
  /^\/legal\/(privacy|terms|dpa)$/,
  /^\/onboarding\/install$/,                                  // 認証前にトークンを見せる必要あり (要再検討、Sprint 1 でレビュー)
]
const PATH_AUTH_PUBLIC_API = [/^\/api\/auth\/(sign-in|sign-up|verify|reset|magic-link)$/]
const PATH_HEALTH = [/^\/api\/health$/]
const PATH_INGEST = [/^\/api\/track$/]                          // Worker からの POST、tracking.js 由来

function classify(pathname: string):
  | 'public' | 'auth-public-api' | 'health' | 'ingest' | 'tenant-protected' {
  if (PATH_PUBLIC.some((r) => r.test(pathname))) return 'public'
  if (PATH_AUTH_PUBLIC_API.some((r) => r.test(pathname))) return 'auth-public-api'
  if (PATH_HEALTH.some((r) => r.test(pathname))) return 'health'
  if (PATH_INGEST.some((r) => r.test(pathname))) return 'ingest'
  return 'tenant-protected'
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const kind = classify(pathname)

  // 1. health / ingest / public はパススルー (audit せず)
  if (kind === 'health' || kind === 'ingest' || kind === 'public') {
    return NextResponse.next()
  }

  // 2. auth-public-api はパススルーするが audit_events に書く (失敗試行検出のため)
  if (kind === 'auth-public-api') {
    const res = NextResponse.next()
    // emit は API route 完了後に WORKER waitUntil で書く設計 (middleware 内で fetch 不可)
    // → API route 内で emit する。middleware では何もしない。
    return res
  }

  // 3. tenant-protected
  const token = request.cookies.get('session_token')?.value
  if (!token) {
    return redirectOr401(request, pathname)
  }
  const payload = await verifyJwt(token)
  if (!payload) {
    return redirectOr401(request, pathname)
  }

  const res = NextResponse.next()
  res.headers.set('x-tenant-id', payload.tenant_id)
  res.headers.set('x-user-id', payload.sub)
  res.headers.set('x-plan', payload.plan)
  // audit emit は API route 内 (middleware は edge runtime で ClickHouse client 使えない)
  return res
}

function redirectOr401(request: NextRequest, pathname: string): NextResponse {
  if (pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  const url = new URL('/auth/sign-in', request.url)
  url.searchParams.set('redirect', pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    // _next 系 / favicon 等は除外
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|opengraph-image|apple-icon|icon).*)',
  ],
}
```

### 2.2.3 audit_events emit を middleware に書かない理由

Next.js middleware は **Edge Runtime** で動作するが、`@clickhouse/client` (Node.js socket 系) は Edge で動かない。代替として:

- API route 内 (Node runtime) で `lib/audit.ts` の `emitAuditEvent()` を `waitUntil` で非同期 emit
- 4xx / 5xx は API route catch-all で emit
- middleware では `x-tenant-id` / `x-user-id` / `x-plan` の header 注入のみに専念

### 2.2.4 `/api/track` を中間者にしない理由

tracking.js → `https://ugokimap-event-ingest.linkth.workers.dev/api/track` (Cloudflare Worker) → ClickHouse の経路は既に確立。**ugokimap-saas 側の `/api/track` は冗長 path 防御として残置**するが、Phase 1 では本番 traffic を流さない (Worker 直送一本化、infrastructure_engineer.md 2026-04-04 「Vercel /api/track 経路廃止判定」整合)。middleware では INGEST 区分で path を予約しておくが、実体は 410 Gone を返す API stub を Sprint 1 で立てる別 PR を起票。

---

# 3. `@sentry/nextjs` source map upload を Vercel build hook で自動化

## 3.1 現状

`package.json` に `"@sentry/nextjs": "^8.0.0"` 追加済 (Sprint 0)。`sentry.client.config.ts` / `sentry.server.config.ts` / `sentry.edge.config.ts` 未配備。Source map upload も未設定。

## 3.2 確定設計

### 3.2.1 必要な環境変数

| 変数 | 場所 | 用途 |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | Vercel env (Production / Preview / Dev) **+ GitHub Actions secrets** | source map upload 認証。`sentry-cli` が読む。 **commit 厳禁**。Sentry Settings → Auth Tokens で `project:releases` + `org:read` scope のみ発行 |
| `SENTRY_ORG` | Vercel env (全環境) | linkth-org (例) |
| `SENTRY_PROJECT` | Vercel env (全環境) | ugokimap-saas |
| `NEXT_PUBLIC_SENTRY_DSN` | Vercel env (全環境、public OK) | client SDK が使う DSN |
| `SENTRY_DSN` | Vercel env (Production / Preview) | server SDK が使う DSN (NEXT_PUBLIC_ と同値) |
| `VERCEL_GIT_COMMIT_SHA` | Vercel auto-injected | release version source |

### 3.2.2 release version の決定方針

Vercel ビルド環境変数 `VERCEL_GIT_COMMIT_SHA` (40 char SHA) を release name に使う:

```
release_name = `ugokimap-saas@${VERCEL_GIT_COMMIT_SHA.slice(0, 12)}`
              # = "ugokimap-saas@abc123def456"
```

これで Sentry 上で 1 commit = 1 release (Vercel preview / production 両方で同じ SHA を共有 = 同一 release に紐付く)。

### 3.2.3 next.config.js への組込

```javascript
// next.config.js
const { withSentryConfig } = require('@sentry/nextjs')

const baseConfig = {
  // ... 既存設定
}

const sentryWebpackPluginOptions = {
  // sentry-cli が prompt 表示しないように
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Vercel ビルド時のみ source map upload を有効化
  disableServerWebpackPlugin: !process.env.VERCEL,
  disableClientWebpackPlugin: !process.env.VERCEL,

  // release は VERCEL_GIT_COMMIT_SHA をベースに自動生成
  release: process.env.VERCEL_GIT_COMMIT_SHA
    ? `ugokimap-saas@${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12)}`
    : undefined,

  // upload 後に削除 (本番 bundle に source map を残さない)
  hideSourceMaps: true,
  widenClientFileUpload: true,

  // Vercel deploy 時 release を自動 finalize (deploy 完了 = release 公開)
  autoInstrumentServerFunctions: true,
}

module.exports = withSentryConfig(baseConfig, sentryWebpackPluginOptions)
```

### 3.2.4 sentry.{client,server,edge}.config.ts (新規 3 ファイル)

```typescript
// sentry.client.config.ts
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,    // build time injection (next.config.js で env として埋込)
  environment: process.env.VERCEL_ENV || 'development',
  tracesSampleRate: process.env.VERCEL_ENV === 'production' ? 0.1 : 1.0,
  // 個人情報を Sentry に送らない
  beforeSend(event) {
    delete event.user?.email
    delete event.user?.ip_address
    return event
  },
})

// sentry.server.config.ts (同様)
// sentry.edge.config.ts (同様、edge runtime 用)
```

### 3.2.5 Vercel deploy hook 経由の release finalize

source map upload は build 時に `withSentryConfig` 経由で自動。**deploy 後の release finalize** だけ Vercel deploy hook で実行する:

```yaml
# .github/workflows/sentry-release.yml (Vercel Production deploy 完了 webhook 起動)
name: Sentry Release Finalize
on:
  deployment_status:
jobs:
  finalize:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sentry Release
        uses: getsentry/action-release@v1
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
        with:
          environment: production
          version: ugokimap-saas@${{ github.sha }}
          finalize: true
          set_commits: auto
```

**動作**:
- Vercel が Production deploy 完了 → GitHub `deployment_status` event
- Workflow が起動 → Sentry release を `production` environment で finalize + commits 紐付け
- 以後の Sentry issue が「どの commit で発生したか」を自動表示
- `set_commits: auto` で前回 release との diff commits が自動記録 (regression 検知が容易)

### 3.2.6 Preview deploy の扱い

Preview deploy では:
- source map upload は **する** (`withSentryConfig` の `disableClientWebpackPlugin: !process.env.VERCEL` = Vercel build 中なら upload)
- release finalize は **しない** (上記 workflow で `environment == 'Production'` でフィルタ)
- 結果として Preview 由来エラーも source map 付きで Sentry に届くが、release 未確定なので "preview" environment にだけ表示される

これにより本番 / Preview を Sentry UI で完全分離可。

### 3.2.7 監視 alarm 設定 (別 Issue 化)

source map upload の **失敗** を捕捉する Sentry alarm を別途設定 (Sprint 1 完了直後 Operator タスク):

- Sentry → Alerts → New Alert → "Number of new issues without source maps in last 1h > 5" → Slack 通知

これで `SENTRY_AUTH_TOKEN` 失効や Vercel build hook の失敗に気付ける。

---

## 4. 完了条件

| # | 項目 | 検証方法 | 期限 |
|---|---|---|---|
| 1 | `next.config.js` images.remotePatterns + `config/partner-hosts.json` + `lib/url-allowlist.ts` 配備 | bihadashop.jp の OGP を `next/image` で取得 → 200 | Sprint 1 着工前 |
| 2 | middleware path 4 区分実装 + JWT 検証 + `x-tenant-id` 注入 | E2E: 未認証で `/api/heatmap` → 401, `/api/health` → 200 | Sprint 1 着工前 (S0-09 と並走) |
| 3 | `withSentryConfig` + sentry.*.config.ts 3 ファイル + GH Actions release-finalize workflow | Production deploy → Sentry に release `ugokimap-saas@<sha>` 出現 + source map 解決 | Sprint 1 着工前 (S0-11 と並走) |

---

## 5. リスクと未決事項

| # | リスク | 緩和 |
|---|---|---|
| R1 | partner-hosts.json 編集が PR レビューを経ずに merge される | CODEOWNERS で `config/partner-hosts.json` を Infra + Director 承認必須に設定 (別 PR) |
| R2 | middleware が edge runtime のため `verifyJwt` が `jose` パッケージを使う必要 | `lib/jwt.ts` を `jose` ベースに統一済 (package.json `"jose": "^5.9.0"` 確認済) |
| R3 | `/api/track` を 410 化したが Cloudflare Worker 障害時に fallback 不能 | infrastructure_engineer.md 2026-04-04 で Worker 一本化済 (フォールバック削除済)。Worker 障害は Sentry / Cloudflare alert で検知 |
| R4 | SENTRY_AUTH_TOKEN を誤って commit | Vercel env + GH Actions secrets のみ、リポジトリ外管理。pre-commit に `secretlint` 導入を別途検討 |
| R5 | source map upload 量が増えて Sentry plan の quota 圧迫 | hideSourceMaps + widenClientFileUpload で過剰 upload 抑制、月次で Sentry usage 監視 |

---

## 6. 改訂履歴

| ver | date | author | 概要 |
|---|---|---|---|
| 0.1 | 2026-05-16 | Infrastructure Engineer | 初版起票 (Reviewer F-1 5 件のうち Infra 起点 3 件) |
