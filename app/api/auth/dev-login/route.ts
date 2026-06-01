/**
 * POST /api/auth/dev-login
 *
 * Owner / dogfood 専用・メール不要ログイン (続 119, 親 SSOT §3.6.1 / §6.4 Sprint 1)
 *
 * Request:
 *   { email: string, secret: string, redirect?: string }
 *
 * Response:
 *   200 { success: true, redirect }   — secret 一致 + email allowlist 内。session Cookie 発行。
 *   401 { success: false, error }     — secret 不一致 or 未招待 email (区別しない = 列挙対策)
 *   404                               — 機能無効 (OWNER_LOGIN_SECRET 未設定 / 弱い)
 *   429 { success: false, error }     — rate limit 超過
 *   400 { success: false, error }     — 入力不正
 *
 * セキュリティ:
 *   - 公開 endpoint (middleware の auth-public、/api/auth/* prefix)。
 *   - `OWNER_LOGIN_SECRET` 未設定なら 404 = 機能ごと無効 (本番で env 未投入なら攻撃面ゼロ)。
 *   - secret は SHA-256 ダイジェスト同士の timingSafeEqual で比較 (長さ/タイミング漏洩なし)。
 *   - secret 不一致と未招待 email は同一 401 で返す (enumeration 防止)。
 *   - IP 単位 rate limit (1 分 10 回)。Redis 失敗時は fail-open (magic-link 経路と整合)。
 *   - 発行 JWT は当該 dogfood user の実 tenant_id/plan/role → tenant 分離は不変 (§3.8.1)。
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createHash, timingSafeEqual } from 'node:crypto'

import { redis } from '@/lib/redis'
import { signToken, TOKEN_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '@/lib/jwt'
import { lookupDogfoodUser } from '@/lib/auth/dogfood-users'
import { getOwnerLoginSecret } from '@/lib/auth/owner-login'
import { isSafeLocalRedirect, SAFE_REDIRECT_MAX_LENGTH } from '@/lib/auth/safe-redirect'

export const runtime = 'nodejs'

const DEV_LOGIN_RATE_LIMIT_PER_MIN = 10 // IP/min
// IP 偽装 (x-forwarded-for) で per-IP 上限をすり抜けても、全体スループット上限で
// 総当たりを封じる (security/red-team review CRITICAL 続 119)。
const DEV_LOGIN_GLOBAL_RATE_LIMIT_PER_MIN = 60 // 全体/min

const bodySchema = z.object({
  email: z.string().email().max(254),
  secret: z.string().min(1).max(512),
  redirect: z
    .string()
    .max(SAFE_REDIRECT_MAX_LENGTH)
    // ローカルパスのみ許可。page/API で共有の検証 (lib/auth/safe-redirect.ts) を使い
    // ドリフトを防ぐ。生の '//' '/\' 制御文字に加え encoded %2f/%5c/%0d%0a も拒否
    // (review 続 119: decode 後に open redirect / header splitting へ化けるため)。
    .refine(isSafeLocalRedirect, 'redirect must be a local path')
    .optional(),
})

function extractClientIp(request: Request): string {
  const h = request.headers
  const xff = h.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff) return xff
  const cf = h.get('cf-connecting-ip')
  if (cf) return cf
  const real = h.get('x-real-ip')
  if (real) return real
  return 'unknown'
}

/** SHA-256 ダイジェスト同士の constant-time 比較 (入力長に依らず固定 32byte 比較)。 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * IP 単位 + 全体の 2 段 rate limit。true = 制限超過 (429)。
 *
 * Redis 不達時は fail-open (magic-link 経路と同方針)。これは安全側かつ意図的な判断:
 *   - secret は 24 文字以上の暗号乱数を強制 (getOwnerLoginSecret が短い値を無効化)。
 *     256bit クラスの secret は総当たり不能で、rate limit は唯一の砦ではなく
 *     あくまで多層防御 / DoS・ログ汚染の緩和にすぎない。
 *   - ここを fail-closed (503) にすると、本番に REDIS_URL 未設定の場合に owner が
 *     一切ログインできず、本機能の目的 (検証ループの信頼性確保) を自ら破壊する。
 *     magic-link も fail-open のため、挙動を揃えて「Redis 有無でログイン可否が
 *     変わる」驚きを無くす。
 *   - Redis が生きている間は IP + 全体上限が有効なので、平常時の総当たり/DoS は縛れる。
 */
async function isRateLimited(ip: string): Promise<boolean> {
  try {
    const client = redis()

    // 全体バケット: IP を偽装しても全 endpoint スループットを縛る
    const globalKey = 'dev-login:rl:1m:global'
    const globalCount = await client.incr(globalKey)
    if (globalCount === 1) await client.expire(globalKey, 60)
    if (globalCount > DEV_LOGIN_GLOBAL_RATE_LIMIT_PER_MIN) return true

    // IP バケット
    const ipKey = `dev-login:rl:1m:${ip}`
    const ipCount = await client.incr(ipKey)
    if (ipCount === 1) await client.expire(ipKey, 60)
    if (ipCount > DEV_LOGIN_RATE_LIMIT_PER_MIN) return true

    return false
  } catch {
    // Redis 不可: fail-open (上記理由)。Sentry で検知。
    return false
  }
}

/**
 * same-origin POST のみ許可 (CSRF/クロスサイト悪用の防御)。
 *
 * - Origin 有り: host と完全一致のみ許可。
 * - Origin 無し: 本番では拒否 (state-changing auth に Origin 必須。ブラウザの fetch は
 *   POST に必ず Origin を付けるため正規フォームは影響なし。review 続 119 MEDIUM)。
 *   dev では許可 (curl 等での手動検証を妨げない)。
 */
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) {
    return process.env.NODE_ENV !== 'production'
  }
  try {
    const originHost = new URL(origin).host
    const host = request.headers.get('host')
    return Boolean(host) && originHost === host
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  // 機能無効 (env 未設定 / 弱い secret) なら存在ごと隠す
  const ownerSecret = getOwnerLoginSecret()
  if (!ownerSecret) {
    return new NextResponse('Not Found', { status: 404 })
  }

  // クロスサイトからの POST を拒否 (same-origin のみ)
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(
      { success: false, error: 'Forbidden', code: 'FORBIDDEN' },
      { status: 403 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body', code: 'BAD_REQUEST' },
      { status: 400 },
    )
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid request',
        code: 'BAD_REQUEST',
      },
      { status: 400 },
    )
  }

  const ip = extractClientIp(request)
  if (await isRateLimited(ip)) {
    return NextResponse.json(
      { success: false, error: 'Too many requests', code: 'RATE_LIMITED' },
      { status: 429 },
    )
  }

  const email = parsed.data.email.toLowerCase().trim()
  const secretOk = secretsMatch(parsed.data.secret, ownerSecret)
  const user = lookupDogfoodUser(email)

  // secret 不一致 と 未招待 email を区別しない (enumeration 防止)。
  // secret 検証は user 有無に関わらず常に実行済 (上で timingSafeEqual) のため
  // タイミングで user 有無を推定されにくい。
  if (!secretOk || !user) {
    return NextResponse.json(
      { success: false, error: 'Invalid credentials', code: 'UNAUTHORIZED' },
      { status: 401 },
    )
  }

  let sessionToken: string
  try {
    sessionToken = await signToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      tenant_id: user.tenant_id,
      plan: user.plan,
      site_ids: user.site_ids,
      role: user.role,
    })
  } catch {
    // JWT secret 未設定など。内部理由は漏らさず汎用 500。
    return NextResponse.json(
      { success: false, error: 'Internal error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    )
  }

  const redirectPath = parsed.data.redirect ?? '/dashboard'
  const response = NextResponse.json({ success: true, redirect: redirectPath })
  response.cookies.set(TOKEN_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS, // 続 118/119: magic-link verify と同じ 30d
  })
  return response
}
