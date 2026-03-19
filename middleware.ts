import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET
if (!secret) {
  throw new Error('JWT_SECRET or NEXTAUTH_SECRET environment variable is required')
}
const JWT_SECRET = new TextEncoder().encode(secret)

// 認証不要なパス（公開API）
const PUBLIC_API_PATHS = [
  '/api/track',        // トラッキングAPI（外部サイトから呼ばれる）
  '/api/health',       // ヘルスチェック
  '/api/auth/login',   // ログイン
  '/api/auth/register',// 登録
  '/api/auth/logout',  // ログアウト
  '/api/inngest',      // Inngestワーカー
  '/api/install',      // インストール確認
]

// 認証不要なページパス
const PUBLIC_PAGE_PATHS = [
  '/auth/login',
  '/auth/register',
  '/_next',
  '/favicon.ico',
]

function isPublicPath(pathname: string): boolean {
  // 公開APIパス
  for (const p of PUBLIC_API_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) return true
  }
  // 公開ページパス
  for (const p of PUBLIC_PAGE_PATHS) {
    if (pathname === p || pathname.startsWith(p)) return true
  }
  // 静的ファイル
  if (pathname.startsWith('/tracking') || pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.png') || pathname.endsWith('.ico')) {
    return true
  }
  return false
}

function extractToken(request: NextRequest): string | null {
  // 1. Authorization header
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7)

  // 2. Cookie
  const token = request.cookies.get('ugokimap_token')?.value
  if (token) return token

  return null
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 公開パスはスキップ
  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  // APIルートの認証チェック
  if (pathname.startsWith('/api/')) {
    const token = extractToken(request)
    if (!token) {
      return NextResponse.json(
        { error: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 }
      )
    }

    try {
      const { payload } = await jwtVerify(token, JWT_SECRET)

      // 認証情報をリクエストヘッダーに注入（下流のAPIハンドラで使用）
      const requestHeaders = new Headers(request.headers)
      requestHeaders.set('x-user-id', payload.sub as string)
      requestHeaders.set('x-user-email', payload.email as string)
      requestHeaders.set('x-user-plan', (payload.plan as string) || 'free')

      return NextResponse.next({
        request: { headers: requestHeaders },
      })
    } catch {
      return NextResponse.json(
        { error: 'Invalid or expired token', code: 'TOKEN_EXPIRED' },
        { status: 401 }
      )
    }
  }

  // ページルートの認証チェック（matcherで既にフィルタされているので、
  // ここに到達した非APIルートは全て認証が必要）
  const token = extractToken(request)
  if (!token) {
    const loginUrl = new URL('/auth/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  try {
    await jwtVerify(token, JWT_SECRET)
    return NextResponse.next()
  } catch {
    const loginUrl = new URL('/auth/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }
}

export const config = {
  matcher: [
    // APIルート（公開トラッキングAPI以外）
    '/api/:path*',
    // ダッシュボード系ページ
    '/dashboard/:path*',
    '/heatmap/:path*',
    '/sites/:path*',
    '/settings/:path*',
    '/tests/:path*',
    '/performance/:path*',
    '/image-visibility/:path*',
    '/ai-insights/:path*',
    '/reports/:path*',
    '/realtime/:path*',
  ],
}
