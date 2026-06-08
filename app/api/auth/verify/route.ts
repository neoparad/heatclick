/**
 * GET /api/auth/verify?token=...
 *
 * 親 SSOT §3.6.1 / §6.4 Sprint 1 / Part V §5.5.1 P-01
 *
 * 動作:
 *   1. magic link token を verify
 *   2. Redis 上の nonce を DEL で single-use 化
 *   3. user lookup (Sprint 1 は dogfood seed の email allowlist で擬似実装)
 *   4. JWT 発行 → cookie 設定 → /dashboard に redirect
 *
 * Sprint 1 限定: user は dogfood 招待 email のみで、ストレージは
 * `data/dogfood-users.json` (Sprint 3 で Postgres `users` テーブルに移行)。
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { redis } from '@/lib/redis'
import { signToken, TOKEN_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, type Plan } from '@/lib/jwt'
import { verifyMagicLinkToken } from '@/lib/auth/magic-link'
import { lookupDogfoodUser } from '@/lib/auth/dogfood-users'

export const runtime = 'nodejs'

const querySchema = z.object({
  token: z.string().min(10).max(2000),
})

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({ token: url.searchParams.get('token') })

  if (!parsed.success) {
    return redirectToSignIn(url.origin, 'invalid-token')
  }

  const payload = await verifyMagicLinkToken(parsed.data.token)
  if (!payload) {
    return redirectToSignIn(url.origin, 'invalid-token')
  }

  // single-use check
  try {
    const client = redis()
    const removed = await client.del(`magic-link:nonce:${payload.jti}`)
    if (removed === 0) {
      // すでに使われた nonce
      return redirectToSignIn(url.origin, 'link-used')
    }
  } catch {
    // Redis 不通時は fail-open (Sprint 1 dogfood 規模では許容、Sentry で検知)
  }

  const user = lookupDogfoodUser(payload.email)
  if (!user) {
    return redirectToSignIn(url.origin, 'not-invited')
  }

  const sessionToken = await signToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    tenant_id: user.tenant_id,
    plan: user.plan as Plan,
    site_ids: user.site_ids,
    role: user.role,
  })

  const redirectPath = sanitizeRedirect(payload.redirect) ?? '/dashboard'
  const response = NextResponse.redirect(new URL(redirectPath, url.origin))
  response.cookies.set(TOKEN_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS, // 続 118: JWT exp と単一ソースで一致 (既定 30d)
  })
  return response
}

function sanitizeRedirect(raw: string | undefined): string | null {
  if (!raw) return null
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  return raw
}

function redirectToSignIn(origin: string, reason: 'invalid-token' | 'link-used' | 'not-invited') {
  const url = new URL('/auth/sign-in', origin)
  url.searchParams.set('error', reason)
  return NextResponse.redirect(url)
}
