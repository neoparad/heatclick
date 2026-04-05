import { SignJWT, jwtVerify } from 'jose'

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

const JWT_EXPIRY = '24h'

export interface JWTPayload {
  sub: string // user id
  email: string
  name: string
  plan?: string
}

// JWTトークンの生成
export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(getJwtSecret())
}

// JWTトークンの検証
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      plan: payload.plan as string | undefined,
    }
  } catch {
    return null
  }
}

// リクエストからトークンを抽出
export function extractToken(request: Request): string | null {
  // 1. Authorization ヘッダー
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }

  // 2. Cookie
  const cookie = request.headers.get('cookie')
  if (cookie) {
    const match = cookie.match(/ugokimap_token=([^;]+)/)
    if (match) return match[1]
  }

  return null
}

// リクエストの認証検証（API用ヘルパー）
export async function authenticateRequest(request: Request): Promise<JWTPayload | null> {
  const token = extractToken(request)
  if (!token) return null
  return verifyToken(token)
}
