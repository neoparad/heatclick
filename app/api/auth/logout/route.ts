/**
 * POST /api/auth/logout — クライアント `lib/auth.ts:logout()` から呼ばれる
 *
 * Director 続 74 Task E:
 *   - 旧 `lib/auth.ts` は POST /api/auth/logout に fetch していたが
 *     対応ルート不在で 404 silent fail → cookie が残ったまま `/` に遷移していた。
 *   - 本ルートで cookie を確実に無効化し JSON 200 を返す。
 *
 * クライアント側はレスポンス受領後 `window.location.href = '/auth/sign-in'` 等で
 * 遷移する責務を持つ (本ルートは redirect しない、SPA fetch 互換のため)。
 */

import { NextResponse } from 'next/server'

import { TOKEN_COOKIE_NAME } from '@/lib/jwt'

export const runtime = 'nodejs'

export async function POST() {
  const response = NextResponse.json({ success: true })
  response.cookies.set(TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return response
}
