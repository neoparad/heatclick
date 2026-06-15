/**
 * GET / POST /auth/sign-out — sidebar logout link 経由のサーバ side logout
 *
 * Director 続 74 Task E (Owner 2026-05-24 09:34 JST 報告 — logout 後 404):
 *   - sidebar (続 73) は logout を発行するが対応ルートが無く 404 だった。
 *   - 本ルートで cookie を即時無効化し `/auth/sign-in?signed-out=1` へ 302。
 *
 * 続 119 root-fix (Owner dogfood で全 soft navigation が sign-in に弾かれる真因):
 *   Next.js は画面内の `<Link>` を自動プリフェッチする。旧実装は logout を
 *   `<Link href="/auth/sign-out">` (GET) で発行していたため、ページ表示時に
 *   プリフェッチが sign-out を実行 → cookie 削除 → ユーザーは気付かぬうちに
 *   ログアウト。次のリンククリック (soft navigation) が no_token で弾かれていた。
 *   対策 (多層防御):
 *     1. sidebar 側を `<form method="post">` に変更 (POST はプリフェッチされない)。
 *     2. 本ルートの GET はプリフェッチ要求では副作用 (cookie 削除) を行わない。
 *
 * CSRF 観点: 副作用は cookie 削除 + 自身のセッション破棄のみ (= idempotent)、
 * 単発リクエストで他テナントに影響しないため GET も許容 (主経路は POST フォーム)。
 */

import { NextResponse } from 'next/server'

import { TOKEN_COOKIE_NAME } from '@/lib/jwt'
import { isPrefetchRequest } from '@/lib/http/prefetch'

export const runtime = 'nodejs'

/** セッション cookie を削除し sign-in へ 302。実クリック / POST 時のみ呼ぶ。 */
function clearSessionResponse(request: Request): NextResponse {
  const origin = new URL(request.url).origin
  const response = NextResponse.redirect(new URL('/auth/sign-in?signed-out=1', origin), {
    status: 302,
  })
  // logout 応答は絶対にキャッシュさせない (中間/ブラウザ層での再利用を防ぐ)。
  response.headers.set('cache-control', 'no-store, private')
  response.cookies.set(TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return response
}

export async function GET(request: Request) {
  // プリフェッチ (先読み GET) では cookie を消さない (= ページ表示だけでログアウト
  // させない)。副作用の無い 204 を no-store で返す。実クリックは prefetch header
  // 無しの要求として届き本処理が走る。
  if (isPrefetchRequest(request)) {
    return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store, private' } })
  }
  return clearSessionResponse(request)
}

export async function POST(request: Request) {
  // POST はプリフェッチ対象外なので常にログアウトを実行 (sidebar フォームの主経路)。
  return clearSessionResponse(request)
}
