/**
 * GET / POST /api/auth/sign-out — logout endpoint (続 76 Task A)
 *
 * 親 SSOT §3.6.2 / §3.8.1
 * 配備理由 (Owner 2026-05-24 09:34 JST 報告 + Vercel logs):
 *   Vercel logs に `09:34:57 GET /api/auth/sign-out 404` が記録。
 *   既存 logout 経路は `/auth/sign-out` (sidebar Link、続 74 Task E) と
 *   `/api/auth/logout` (POST、lib/auth.ts:logout fetch 経路) の 2 つだが、
 *   一部 client (旧 build keep-alive / 外部リンク / browser cache) が
 *   `/api/auth/sign-out` を要求している → 404 解消のため本 endpoint を追加。
 *
 * 動作:
 *   - GET = link / form 等の直接ナビゲーション、cookie 削除 + 302 redirect to /auth/sign-in
 *   - POST = SPA fetch 互換、cookie 削除 + 302 redirect (fetch follows redirect)
 *
 * Cookie 削除対象:
 *   - `ugokimap_saas_token` (続 26 S1-09 で配備した内製 JWT cookie)
 *   - `_vercel_jwt` (Vercel preview protection)
 *   - `__session` (Firebase / 一般的な session cookie 慣習)
 *   - 全て path='/' で消し、production では secure flag 維持
 */

import { NextResponse } from 'next/server'

import { TOKEN_COOKIE_NAME } from '@/lib/jwt'
import { isPrefetchRequest } from '@/lib/http/prefetch'

export const runtime = 'nodejs'

/** 削除対象 cookie 名 (logout 後にゴミを残さない、複数 auth 経路の互換性確保) */
const COOKIES_TO_CLEAR: ReadonlyArray<string> = [
  TOKEN_COOKIE_NAME, // ugokimap_saas_token
  '_vercel_jwt',
  '__session',
]

function buildSignOutResponse(request: Request): NextResponse {
  const origin = new URL(request.url).origin
  const response = NextResponse.redirect(
    new URL('/auth/sign-in?signed-out=1', origin),
    { status: 302 },
  )
  // logout 応答はキャッシュさせない。
  response.headers.set('cache-control', 'no-store, private')
  for (const name of COOKIES_TO_CLEAR) {
    response.cookies.set(name, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
  }
  return response
}

export async function GET(request: Request): Promise<NextResponse> {
  // プリフェッチでは cookie を消さない (ページ表示だけでログアウトさせない)。
  if (isPrefetchRequest(request)) {
    return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store, private' } })
  }
  return buildSignOutResponse(request)
}

export async function POST(request: Request): Promise<NextResponse> {
  return buildSignOutResponse(request)
}
