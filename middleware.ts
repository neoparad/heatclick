/**
 * Middleware — 認証 + tenant 分離 + route group access control + audit emit
 *
 * 親 SSOT §3.6.1 / §3.8.1 / §6.3 S0-09 + Sprint 1 S1-09 (Infra 続 24)
 *
 * S1-09 変更点 (続 23 §6 計画起票、続 24 実装):
 *   1. classify(pathname) で 5 region 分類 (static / api-public / auth-public / api-tenant / tenant-protected)
 *   2. audit_events emit を全 non-static region に追加 (fire-and-forget fetch、Phase 5 で waitUntil 化)
 *   3. x-user-email header 注入を撤去 (PII 縮小、API 側で `getServerSession()` 経由 lookup)
 *   4. cross-tenant / 認証失敗の全シグナルを audit に記録 (Reviewer 観点: observability)
 *
 * 動作概要:
 *   - static     → pass through (audit なし)
 *   - api-public → pass through + audit (`request.api-public`)
 *   - auth-public → pass through + audit (`request.auth-public`、sign-in 試行追跡)
 *   - api-tenant → JWT verify → 401 / 403 / pass + tenant header inject + audit
 *   - tenant-protected → JWT verify → redirect / route group ACL + audit
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify, SignJWT } from 'jose'

const TOKEN_COOKIE_NAME = 'ugokimap_saas_token'

let _jwtSecret: Uint8Array | null = null
function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET
    if (!secret) {
      throw new Error('JWT_SECRET or NEXTAUTH_SECRET environment variable is required')
    }
    _jwtSecret = new TextEncoder().encode(secret)
  }
  return _jwtSecret
}

// ── Rolling session refresh + bounce reason 可視化 (続 118、2026-05-30) ──
//
// 背景: dogfood で「操作していたら突然 sign-in に飛ばされる」が数日間 未解決ループ。
// 根本原因の最有力候補は token 期限切れ (旧 4h token) + deploy/再ログインの隙間 +
// 「なぜ飛ばされたか」が一切見えないこと。lib/jwt.ts で既定を 30d に延長済 (続 118)。
// 本 middleware では 2 段で再発を断つ:
//   A. Rolling refresh: 有効 token の残存期間が閾値 (25d) を切ったら、ページ遷移の
//      ついでに 30d の新 cookie を再発行 → アクティブユーザーは実質ずっとログイン維持。
//   B. Reason 可視化: bounce 時に ?reason=no_token|session_expired|invalid_token を付与
//      → sign-in ページで理由を表示。「謎の bounce」を 1 テストで切り分け可能化
//        (invalid_token 再発 = secret 不整合 / session_expired = 再ログインで解消確認)。

/** セッション有効期限 (秒)。lib/jwt.ts SESSION_MAX_AGE_SECONDS / verify route cookie と一致。 */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // 30d
/** 残存期間がこの秒数を切ったら rolling refresh する閾値 (25d)。30d 発行 → 5d 使用で更新。 */
const SESSION_REFRESH_THRESHOLD_SECONDS = 25 * 24 * 60 * 60 // 25d

export type BounceReason = 'no_token' | 'session_expired' | 'invalid_token'

/**
 * jwtVerify が投げた error から bounce 理由を判定 (pure、unit test 対象)。
 * jose は期限切れで `code === 'ERR_JWT_EXPIRED'` を投げる。それ以外 (署名不一致・
 * malformed 等) は invalid_token に集約。
 */
export function bounceReasonFromError(err: unknown): BounceReason {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ERR_JWT_EXPIRED'
  ) {
    return 'session_expired'
  }
  return 'invalid_token'
}

/**
 * token の残存期間が閾値を切っているか判定 (pure、unit test 対象)。
 * exp/now は秒。既に期限切れ (remaining <= 0) なら refresh しない (verify が先に throw する想定だが防御)。
 */
export function shouldRefreshSession(
  expSec: number | undefined,
  nowSec: number,
  thresholdSec: number = SESSION_REFRESH_THRESHOLD_SECONDS,
): boolean {
  if (typeof expSec !== 'number' || !Number.isFinite(expSec)) return false
  const remaining = expSec - nowSec
  return remaining > 0 && remaining < thresholdSec
}

// ── classify(): 5 region 分類 (S1-09 中核、pure function、unit test 対象) ─

export type MiddlewareRegion =
  | 'static'           // _next, favicon, *.js/css/png/svg/ico/webp/woff2 等
  | 'api-public'       // /api/track, /api/health, /api/inngest, /api/billing/webhook
  | 'auth-public'      // /, /auth/*, /onboarding/install, /legal/*, /api/auth/*, /api/install/verify
  | 'api-tenant'       // /api/* (上記 api-public / auth-public 以外)、要 JWT
  | 'tenant-protected' // /dashboard, /heatmap, /agency/*, /account/*, /personas 等、要 JWT

const STATIC_EXT_REGEX = /\.(js|css|png|svg|ico|webp|woff2?|map|jpg|jpeg|gif|txt|xml|json)$/

/**
 * 静的ファイル / Next.js 内部経路は audit / JWT verify 全 skip
 */
function isStatic(pathname: string): boolean {
  if (pathname.startsWith('/_next/')) return true
  if (pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true
  if (STATIC_EXT_REGEX.test(pathname)) return true
  return false
}

/**
 * Cloudflare Workers / Stripe webhook / Inngest 等の Public API
 * (JWT 不要、独自の認証メカニズム — Worker は site_id/tenant_id pair lookup、
 *  Stripe は signature 検証等)
 *
 * /api/scenarios/runtime は匿名 visitor (customer site 埋め込みスクリプト) が
 * JWT を持たない状態でアクセスする公開エンドポイント。
 * route 自身が site_id/tenant_id query を Zod validate し、`live` status のみを
 * 返す (preview/draft/cross-tenant は gate 済み、REQ-SEC-006 no-store + kill-switch)。
 * 他の /api/scenarios/* (list / CRUD / stats) は api-tenant に留まり JWT 必須。
 *
 * /api/experiments/assign も同型の公開エンドポイント (宝プロジェクト M2b、続126)。
 * customer タグが visitor_id 付きで叩き、running+window 内の実験の **server-arm** を返す。
 * route 自身が tenant_id/site_id/visitor_id を Zod validate、no-store、PII なし、
 * cross-tenant probe は 404。他の /api/experiments/* (CRUD 等) は api-tenant で JWT 必須。
 */
const API_PUBLIC_PATHS: ReadonlyArray<string> = [
  '/api/track',
  '/api/health',
  '/api/inngest',
  '/api/billing/webhook',
  '/api/scenarios/runtime',
  '/api/experiments/assign',
]

/**
 * 認証経路の Public API/page (sign-in / magic-link 等、JWT 不要)
 * 注: install token verify (公開 install 経路) も Phase 1 では公開、Sprint 3 で signed link 化
 */
const AUTH_PUBLIC_API_PREFIX = '/api/auth/'
const AUTH_PUBLIC_API_PATHS: ReadonlyArray<string> = ['/api/install/verify']
const AUTH_PUBLIC_PAGE_EXACT: ReadonlyArray<string> = ['/']
const AUTH_PUBLIC_PAGE_PREFIXES: ReadonlyArray<string> = [
  '/auth/',
  '/onboarding/install',
  '/legal/',
]

export function classify(pathname: string): MiddlewareRegion {
  if (isStatic(pathname)) return 'static'

  // api-public 判定が auth-public より先 (api/track は auth-public 経路に該当しないため安全だが、
  // 順序固定で攻撃面ゼロ化)
  for (const p of API_PUBLIC_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) return 'api-public'
  }

  // auth-public API
  if (pathname.startsWith(AUTH_PUBLIC_API_PREFIX)) return 'auth-public'
  for (const p of AUTH_PUBLIC_API_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) return 'auth-public'
  }

  // auth-public page (prefix の trailing '/' は normalize して exact + prefix-with-/ で照合)
  if (AUTH_PUBLIC_PAGE_EXACT.includes(pathname)) return 'auth-public'
  for (const rawPrefix of AUTH_PUBLIC_PAGE_PREFIXES) {
    const p = rawPrefix.endsWith('/') ? rawPrefix.slice(0, -1) : rawPrefix
    if (pathname === p || pathname.startsWith(p + '/')) return 'auth-public'
  }

  // 残りは tenant 要認証
  if (pathname.startsWith('/api/')) return 'api-tenant'
  return 'tenant-protected'
}

// ── Route group access control (tenant-protected 内で) ───────────────

const AGENCY_PREFIX = '/agency'
const AGENCY_PLANS: ReadonlySet<string> = new Set(['agency', 'enterprise'])
// 続 72 (B-1 fix): PROOF_ROUTES / isProofRoute は agency → proof 強制 redirect で
// のみ使用されていたが、Owner 動作テスト (2026-05-23 22:50) で agency owner が
// /heatmap・/chat 等の (proof) ページに到達不能と判明したため削除。
// 続 66 §3 IA SSOT: agency plan は agency dashboard + 全 proof ページにアクセス可能。
// (proof) ページ側で agency-only 機能制限が必要になった場合は API route レベル
// または個別 page で行う (middleware redirect ではなく)。

// ── Audit emit (fire-and-forget、Phase 5 で waitUntil 化) ────────────

interface AuditEvent {
  action: string                          // e.g., 'request.api-public', 'auth.api.invalid_token'
  resource: string                        // pathname
  tenant_id: string                       // '__unknown__' for unauthenticated
  user_id: string                         // '' for unauthenticated
  ip_anonymized: string
  user_agent: string                      // truncated 256 char
  request_id: string                      // cf-ray or fresh UUID
  response_status: number                 // 0 = pass-through (downstream で実 status 決まる)
  region: MiddlewareRegion
  metadata?: Record<string, unknown>
}

/**
 * S1-09: ClickHouse `clickinsight.audit_events` に INSERT (fire-and-forget)
 *
 * Phase 1:
 *   - CLICKHOUSE_URL env が無い場合は console.warn のみ (Sprint 0 deploy 経路で env 未投入時の保護)
 *   - fetch を await しない (middleware が pass-through 速度を維持)
 *   - 失敗時は console.error (Sentry breadcrumb 経由で観測可)
 *
 * Phase 5 (Sprint 5 着工時想定):
 *   - `@vercel/functions` の `waitUntil` 経由で guaranteed delivery
 *   - 失敗時 retry (Vercel 内部 queue)
 *
 * 続 76 Task B (Owner 2026-05-24 09:34 JST Vercel logs 「[middleware audit] INSERT non-ok」多数):
 *   - `AUDIT_DISABLED=1` env で全 emit を停止 (Owner 緊急回避用 kill switch)
 *   - 同一エラーは 60s に 1 回だけ console.error (log spam 抑制)
 *   - 後者のエラーは内部カウンタに集約、N 件目で「continuing to fail」summary を出す
 *
 *   想定 root cause (本続 76 §3 §4 で Infra dispatch 検討):
 *     (a) production ClickHouse に `audit_events` table 未配備
 *         (`migrations/2026-05-17-sprint0-tenant-isolation.sql` の Step 3 が production に未適用)
 *     (b) `CLICKHOUSE_URL` の credentials が `audit_events` に INSERT 権限を持たない
 *         (audit_events INSERT には専用 user/role が必要、default user では permission denied)
 *     (c) schema mismatch (続 26 以降の middleware の row shape が table schema から ズレた)
 *
 *   本続 76 では Frontend 側ではコード変更で根本解決できないため、kill switch + 観測性向上のみ。
 *   実 schema 修正 / table 再配備は Infra dispatch (Director 続 77 起票候補)。
 */

/** 続 76 Task B: 同一エラーを抑制する throttled logger (60s 窓、N 件目で summary) */
interface AuditErrorThrottle {
  /** 直近 60s 内の同一エラー件数 */
  count: number
  /** 直近 console.error を出した時刻 */
  lastEmittedAt: number
}
const _auditErrorThrottle = new Map<string, AuditErrorThrottle>()
const AUDIT_ERROR_WINDOW_MS = 60_000

function shouldEmitAuditError(key: string): boolean {
  const now = Date.now()
  const entry = _auditErrorThrottle.get(key)
  if (!entry || now - entry.lastEmittedAt > AUDIT_ERROR_WINDOW_MS) {
    _auditErrorThrottle.set(key, { count: 1, lastEmittedAt: now })
    return true
  }
  entry.count += 1
  // 100 件溜まったら summary 1 行出して reset
  if (entry.count >= 100) {
    console.error(
      `[middleware audit] suppressed ${entry.count} duplicate errors for key="${key}" in ${AUDIT_ERROR_WINDOW_MS / 1000}s, resetting throttle`,
    )
    _auditErrorThrottle.set(key, { count: 1, lastEmittedAt: now })
    return false
  }
  return false
}

function fireAuditAsync(event: AuditEvent): void {
  // 続 76 Task B: 緊急 kill switch (Owner が Vercel env で AUDIT_DISABLED=1 投入時に全 emit 停止)
  // root cause (audit_events 不在 or 権限不足) の Infra 修正が完了するまでの一時回避。
  if (process.env.AUDIT_DISABLED === '1') {
    return
  }
  const chUrl = process.env.CLICKHOUSE_URL || ''
  const chDb = process.env.CLICKHOUSE_DB || 'clickinsight'
  if (!chUrl) {
    // Sprint 0 deploy 経路で env 未投入の場合の保護、log のみ
    if (shouldEmitAuditError('unset_url')) {
      console.warn(`[middleware audit] CLICKHOUSE_URL unset, skip emit (suppressing further for 60s)`)
    }
    return
  }

  // 続 28 (S1-09 HIGH-27-1 同型対策): parseClickHouseEnv は malformed URL 時に
  // fail-closed (throw) する。fire-and-forget 契約維持のため caller 側で catch、
  // raw URL を log に含めず audit emit を skip する。
  let baseUrl: string
  let authHeader: string
  try {
    ;({ baseUrl, authHeader } = parseClickHouseEnv(chUrl))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    // raw URL (credentials を含む可能性) は出力しない、message のみ
    console.error(`[middleware audit] parseClickHouseEnv failed, skip emit: ${event.action} ${event.resource} (${msg})`)
    return
  }

  const row = {
    tenant_id: event.tenant_id || '__unknown__',
    user_id: event.user_id,
    action: event.action,
    resource: event.resource,
    ip_anonymized: event.ip_anonymized,
    user_agent: event.user_agent,
    request_id: event.request_id,
    response_status: event.response_status,
    plan_tier: 'Growth', // 認証経路で plan 確定するまで Growth (最短 TTL 30 日)
    metadata: JSON.stringify({
      region: event.region,
      ...(event.metadata ?? {}),
    }),
  }

  const insertUrl = `${baseUrl}/?database=${encodeURIComponent(chDb)}`
    + `&query=${encodeURIComponent('INSERT INTO audit_events FORMAT JSONEachRow')}`
    + `&input_format_skip_unknown_fields=1`

  // Fire-and-forget: middleware の latency に影響させない
  // .catch で console.error、Sentry が breadcrumb 経由で捕捉
  // 注: 続 28 で fetch error 時の log には URL/credentials を含めない (HIGH-27-1 整合)
  // Reviewer R7-3 + Director 続 34 §5.4: resp.ok 検証で silent fail 撲滅 (続 35 Step 5)
  //   旧 = network error のみ catch、HTTP 5xx は silent
  //   新 = .then で resp.ok 検証 + 非 ok は status / 切詰 body で console.error
  //   制約: fire-and-forget 契約維持のため .then chain 内で完結、middleware 関数は await しない
  fetch(insertUrl, {
    method: 'POST',
    body: JSON.stringify(row) + '\n',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
  })
    .then(async (resp) => {
      if (!resp.ok) {
        // response body は CH server error context、credentials 含まない (Basic Auth header 渡し済)
        const respText = await resp.text().catch(() => '')
        const truncated = respText.slice(0, 256)
        // 続 76 Task B: 同一 status + body head を 60s に 1 回だけ console.error (log spam 抑制)
        const key = `non_ok:${resp.status}:${truncated.slice(0, 64)}`
        if (shouldEmitAuditError(key)) {
          console.error(
            `[middleware audit] INSERT non-ok: ${event.action} ${event.resource} ` +
              `status=${resp.status} statusText=${resp.statusText} body_head="${truncated}" ` +
              `(throttled; suppressing further 同一 errors for 60s; AUDIT_DISABLED=1 で全停止可)`,
          )
        }
      }
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'unknown'
      // 続 76 Task B: network error は通常 timeout / DNS / TLS、メッセージ先頭で同種判定して throttle
      const key = `network:${msg.slice(0, 64)}`
      if (shouldEmitAuditError(key)) {
        console.error(
          `[middleware audit] INSERT network error: ${event.action} ${event.resource} (${msg}) ` +
            `(throttled; suppressing further 同一 errors for 60s; AUDIT_DISABLED=1 で全停止可)`,
        )
      }
    })
}

/**
 * Parse CLICKHOUSE_URL using WHATWG URL (B-2 続 23 H-2 整合、credentials を URL 排除)
 *
 * 続 28 (S1-09 HIGH-27-1 同型対策、worker.ts:281-283 と同期):
 *   malformed URL 時の fail-open fallback (`{ baseUrl: raw, authHeader }`) は
 *   raw 中の `user:password@` を URL に残し、後続 fetch error log で credentials が
 *   Workers logs / Sentry breadcrumb に流出する経路を作る (HIGH-27-1)。
 *   本実装は **fail-closed (throw)** に変更し、上位 caller (fireAuditAsync) が
 *   `.catch` で console.error のみ (raw URL は出力しない) して audit emit を skip する。
 */
function parseClickHouseEnv(raw: string): { baseUrl: string; authHeader: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('CLICKHOUSE_URL is malformed (parseClickHouseEnv fail-closed, S1-09 続 28 HIGH-27-1 同型対策)')
  }
  const user = decodeURIComponent(u.username) || 'default'
  const password = decodeURIComponent(u.password) || ''
  u.username = ''
  u.password = ''
  const baseUrl = `${u.protocol}//${u.host}`
  const authHeader = 'Basic ' + btoa(`${user}:${password}`)
  return { baseUrl, authHeader }
}

// ── IP anonymization (B-2 worker.ts と同一仕様) ────────────────────────

function anonymizeIp(ip: string | null | undefined): string {
  if (!ip) return ''
  if (ip.includes('.')) {
    const parts = ip.split('.')
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`
  }
  if (ip.includes(':')) {
    const parts = ip.split(':')
    return parts.slice(0, 3).join(':') + '::'
  }
  return ''
}

// ── Request context extraction (audit emit 用) ──────────────────────

function buildBaseAuditCtx(
  request: NextRequest,
  region: MiddlewareRegion,
): Omit<AuditEvent, 'action' | 'tenant_id' | 'user_id' | 'response_status' | 'metadata'> {
  const ipRaw =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    ''
  const ua = (request.headers.get('user-agent') ?? '').slice(0, 256)
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID()
  return {
    resource: request.nextUrl.pathname,
    ip_anonymized: anonymizeIp(ipRaw),
    user_agent: ua,
    request_id: requestId,
    region,
  }
}

// ── Token extraction (jwt.ts 互換) ──────────────────────────────────

function extractToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7)
  const token = request.cookies.get(TOKEN_COOKIE_NAME)?.value
  if (token) return token
  return null
}

function redirectToSignIn(request: NextRequest, reason: BounceReason): NextResponse {
  const signInUrl = new URL('/auth/sign-in', request.url)
  signInUrl.searchParams.set('redirect', request.nextUrl.pathname)
  // 続 118: bounce 理由を sign-in ページに渡して可視化 (謎 bounce の切り分け用)
  signInUrl.searchParams.set('reason', reason)
  return NextResponse.redirect(signInUrl)
}

// ── Middleware entry ────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const region = classify(pathname)

  // static は audit 不要、即 pass
  if (region === 'static') return NextResponse.next()

  const baseAudit = buildBaseAuditCtx(request, region)

  // ── api-public / auth-public: JWT 不要、audit emit + pass ──
  if (region === 'api-public' || region === 'auth-public') {
    fireAuditAsync({
      ...baseAudit,
      action: `request.${region}`,
      tenant_id: '__unknown__',
      user_id: '',
      response_status: 0,
    })
    return NextResponse.next()
  }

  // ── api-tenant: 要 JWT、401 / 403 / pass + tenant header inject ──
  const token = extractToken(request)

  if (region === 'api-tenant') {
    if (!token) {
      fireAuditAsync({
        ...baseAudit,
        action: 'auth.api.unauthenticated',
        tenant_id: '__unknown__',
        user_id: '',
        response_status: 401,
      })
      return NextResponse.json(
        { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 },
      )
    }

    try {
      const { payload } = await jwtVerify(token, getJwtSecret())
      const tenant_id = (payload.tenant_id as string) || ''
      const user_id = (payload.sub as string) || ''
      const plan = (payload.plan as string) ?? 'free'
      const site_ids = (payload.site_ids as string[]) ?? []

      // site_id query parameter 検証 (cross-tenant 試行検知)
      const requestedSite = request.nextUrl.searchParams.get('site_id')
      if (requestedSite && !site_ids.includes(requestedSite)) {
        fireAuditAsync({
          ...baseAudit,
          action: 'auth.api.cross_tenant_attempted',
          tenant_id,
          user_id,
          response_status: 403,
          metadata: { requested_site: requestedSite },
        })
        return NextResponse.json(
          { success: false, error: 'Access denied to site', code: 'FORBIDDEN' },
          { status: 403 },
        )
      }

      // Header inject (downstream API route 参照、S1-09 で x-user-email 撤去)
      const requestHeaders = new Headers(request.headers)
      requestHeaders.set('x-tenant-id', tenant_id)
      requestHeaders.set('x-user-id', user_id)
      requestHeaders.set('x-plan', plan)
      requestHeaders.set('x-site-ids', site_ids.join(','))
      // 注: x-user-email は S1-09 で **撤去**。email 必要な API route は
      // `lib/auth/server-session.ts:getUserEmail()` で取得すること。

      fireAuditAsync({
        ...baseAudit,
        action: `api.${request.method.toLowerCase()}`,
        tenant_id,
        user_id,
        response_status: 0, // pass-through、downstream で実 status
      })
      return NextResponse.next({ request: { headers: requestHeaders } })
    } catch (err: unknown) {
      const reason = bounceReasonFromError(err)
      fireAuditAsync({
        ...baseAudit,
        action: 'auth.api.invalid_token',
        tenant_id: '__unknown__',
        user_id: '',
        response_status: 401,
        metadata: { reason },
      })
      return NextResponse.json(
        { success: false, error: 'Invalid or expired token', code: 'TOKEN_EXPIRED' },
        { status: 401 },
      )
    }
  }

  // ── tenant-protected: 要 JWT、redirect / route group ACL ──
  if (!token) {
    fireAuditAsync({
      ...baseAudit,
      action: 'auth.page.unauthenticated',
      tenant_id: '__unknown__',
      user_id: '',
      response_status: 302,
    })
    return redirectToSignIn(request, 'no_token')
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    const tenant_id = (payload.tenant_id as string) || ''
    const user_id = (payload.sub as string) || ''
    const plan = (payload.plan as string) ?? 'free'
    const isAgencyUser = AGENCY_PLANS.has(plan)

    // 続 72 (B-1 fix): agency / enterprise plan user は `/agency/*` に加えて
    // `(proof)` route group (dashboard / heatmap / personas / chat 等) にも
    // 直接アクセス可能とする (続 66 §3 IA SSOT)。
    //
    // 旧 (続 24): isProofRoute && isAgencyUser → `/agency/dashboard` へ強制 redirect
    //   → owner 動作テスト (2026-05-23 22:50) で `/heatmap` / `/chat` が
    //     永久 redirect 化 (agency plan owner が proof ページに到達不能)
    // 新: agency plan でも proof route を許容、redirect なし
    //   - 非 agency が `/agency/*` にアクセス → `/dashboard` redirect は維持
    //     (agency-only 機能の保護、tenant isolation とは独立)
    if (pathname.startsWith(AGENCY_PREFIX) && !isAgencyUser) {
      fireAuditAsync({
        ...baseAudit,
        action: 'auth.page.redirect_proof',
        tenant_id,
        user_id,
        response_status: 302,
      })
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }

    fireAuditAsync({
      ...baseAudit,
      action: 'page.view',
      tenant_id,
      user_id,
      response_status: 0,
    })

    // ── 続 118 Fix A: Rolling session refresh ──
    // 残存期間が閾値 (25d) を切ったら、このページ遷移のついでに 30d 新 cookie を再発行。
    // アクティブユーザーは触り続ける限りログイン維持され、突然 sign-in に飛ばされない。
    // 失敗 (再署名エラー等) は致命的でないため握りつぶして通常 next() を返す (既存 token は有効)。
    //
    // REQ-SEC-127 (Codex T1 / §13.7): **db モードでは refresh を無効化**。
    // middleware は edge で DB 失効照合できないため、refresh は stale claim (剥奪済み role /
    // 退会済み membership / 古い site_ids) を再署名して延命してしまう。db モードでは refresh を
    // 止め、token は自然失効 → 再ログインで最新 claim を再導出させる。失効の gate-level 反映 (KV
    // ミラー) 実装後 (P2) に refresh を revalidation 付きで復活させる。hardcode は従来通り refresh ON。
    const res = NextResponse.next()
    const nowSec = Math.floor(Date.now() / 1000)
    const refreshEnabled = process.env.USER_REGISTRY !== 'db'
    if (refreshEnabled && shouldRefreshSession(payload.exp, nowSec)) {
      try {
        // exp/iat/nbf は再発行で setIssuedAt / setExpirationTime が付け直すため除去。
        // strict (noUnusedLocals) 回避のため destructure-omit ではなく spread + delete。
        const claims: Record<string, unknown> = { ...payload }
        delete claims.iat
        delete claims.exp
        delete claims.nbf
        const refreshed = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt()
          .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
          .sign(getJwtSecret())
        res.cookies.set(TOKEN_COOKIE_NAME, refreshed, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: SESSION_MAX_AGE_SECONDS,
        })
      } catch {
        // refresh 失敗は非致命的 (既存 token はまだ有効)、そのまま通す
      }
    }
    return res
  } catch (err: unknown) {
    const reason = bounceReasonFromError(err)
    fireAuditAsync({
      ...baseAudit,
      action: 'auth.page.invalid_token',
      tenant_id: '__unknown__',
      user_id: '',
      response_status: 302,
      metadata: { reason },
    })
    return redirectToSignIn(request, reason)
  }
}

export const config = {
  matcher: [
    /*
     * 全パスにマッチ、ただし以下は除外:
     * - _next/static, _next/image
     * - favicon.ico, robots.txt, sitemap.xml
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
}
