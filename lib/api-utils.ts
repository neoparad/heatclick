import { NextRequest, NextResponse } from 'next/server'

// --- CORS ---

// 管理画面API用（自サイトのみ許可）
export function buildCorsHeaders(request: NextRequest): HeadersInit {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || []
  const origin = request.headers.get('origin') || ''

  // 開発環境またはallowedOriginsに含まれる場合のみ許可
  const isAllowed = !origin
    || origin.includes('localhost')
    || origin.includes('127.0.0.1')
    || allowedOrigins.some(o => origin === o.trim())
    || (process.env.VERCEL_URL && origin.includes(process.env.VERCEL_URL))

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin || '*' : '',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

// トラッキングAPI用（全オリジン許可 — 外部サイトから呼ばれるため）
export function buildTrackingCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

// --- 共通エラーレスポンス ---

export function apiError(message: string, status: number = 500, code?: string): NextResponse {
  return NextResponse.json(
    { error: message, code: code || getErrorCode(status) },
    { status }
  )
}

export function unauthorized(message: string = 'Authentication required'): NextResponse {
  return apiError(message, 401, 'UNAUTHORIZED')
}

export function forbidden(message: string = 'Access denied'): NextResponse {
  return apiError(message, 403, 'FORBIDDEN')
}

export function badRequest(message: string): NextResponse {
  return apiError(message, 400, 'BAD_REQUEST')
}

export function notFound(message: string = 'Resource not found'): NextResponse {
  return apiError(message, 404, 'NOT_FOUND')
}

function getErrorCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST'
    case 401: return 'UNAUTHORIZED'
    case 403: return 'FORBIDDEN'
    case 404: return 'NOT_FOUND'
    case 429: return 'RATE_LIMITED'
    default: return 'INTERNAL_ERROR'
  }
}

// --- マルチテナント認可 ---

export interface AuthContext {
  userId: string
  email: string
  plan: string
}

// middlewareが注入したヘッダーから認証情報を取得
export function getAuthContext(request: NextRequest): AuthContext | null {
  const userId = request.headers.get('x-user-id')
  const email = request.headers.get('x-user-email')
  const plan = request.headers.get('x-user-plan')

  if (!userId) return null

  return {
    userId,
    email: email || '',
    plan: plan || 'free',
  }
}

// ユーザーがサイトにアクセスする権限があるか確認
export async function verifySiteAccess(
  request: NextRequest,
  siteId: string,
  clickhouse: any
): Promise<{ authorized: boolean; auth: AuthContext | null }> {
  const auth = getAuthContext(request)
  if (!auth) return { authorized: false, auth: null }

  try {
    const result = await clickhouse.query({
      query: `SELECT count() as count FROM clickinsight.sites WHERE id = {site_id:String} AND user_id = {user_id:String}`,
      query_params: { site_id: siteId, user_id: auth.userId },
      format: 'JSONEachRow',
    })
    const data = await result.json() as any[]
    const count = Number(data[0]?.count) || 0

    return { authorized: count > 0, auth }
  } catch {
    // DB接続エラー時はアクセス拒否（安全側に倒す）
    return { authorized: false, auth }
  }
}
