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
import { jwtVerify } from 'jose'

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
 */
const API_PUBLIC_PATHS: ReadonlyArray<string> = [
  '/api/track',
  '/api/health',
  '/api/inngest',
  '/api/billing/webhook',
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
const PROOF_ROUTES: ReadonlyArray<string> = [
  '/dashboard',
  '/heatmap',
  '/personas',
  '/cv-journey',
  '/performance',
  '/insights',
  '/pages',
]
const AGENCY_PLANS: ReadonlySet<string> = new Set(['agency', 'enterprise'])

function isProofRoute(pathname: string): boolean {
  return PROOF_ROUTES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

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
 */
function fireAuditAsync(event: AuditEvent): void {
  const chUrl = process.env.CLICKHOUSE_URL || ''
  const chDb = process.env.CLICKHOUSE_DB || 'clickinsight'
  if (!chUrl) {
    // Sprint 0 deploy 経路で env 未投入の場合の保護、log のみ
    console.warn(`[middleware audit] CLICKHOUSE_URL unset, skip emit: ${event.action} ${event.resource}`)
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
        console.error(
          `[middleware audit] INSERT non-ok: ${event.action} ${event.resource} ` +
            `status=${resp.status} statusText=${resp.statusText} body_head="${truncated}"`,
        )
      }
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'unknown'
      console.error(
        `[middleware audit] INSERT network error: ${event.action} ${event.resource} (${msg})`,
      )
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

function redirectToSignIn(request: NextRequest): NextResponse {
  const signInUrl = new URL('/auth/sign-in', request.url)
  signInUrl.searchParams.set('redirect', request.nextUrl.pathname)
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
    } catch {
      fireAuditAsync({
        ...baseAudit,
        action: 'auth.api.invalid_token',
        tenant_id: '__unknown__',
        user_id: '',
        response_status: 401,
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
    return redirectToSignIn(request)
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    const tenant_id = (payload.tenant_id as string) || ''
    const user_id = (payload.sub as string) || ''
    const plan = (payload.plan as string) ?? 'free'
    const isAgencyUser = AGENCY_PLANS.has(plan)

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
    if (isProofRoute(pathname) && isAgencyUser) {
      fireAuditAsync({
        ...baseAudit,
        action: 'auth.page.redirect_agency',
        tenant_id,
        user_id,
        response_status: 302,
      })
      return NextResponse.redirect(new URL('/agency/dashboard', request.url))
    }

    fireAuditAsync({
      ...baseAudit,
      action: 'page.view',
      tenant_id,
      user_id,
      response_status: 0,
    })
    return NextResponse.next()
  } catch {
    fireAuditAsync({
      ...baseAudit,
      action: 'auth.page.invalid_token',
      tenant_id: '__unknown__',
      user_id: '',
      response_status: 302,
    })
    return redirectToSignIn(request)
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
