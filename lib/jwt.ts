/**
 * JWT signing / verification
 *
 * 親 SSOT §3.6.2 / §3.8.1 (multi-tenant isolation)
 * Sprint 0 S0-03 完成版。
 *
 * 拡張点 (ugokimap/lib/jwt.ts から):
 *   - JWTPayload に tenant_id / site_ids[] 追加
 *   - cookie 名を ugokimap_token → ugokimap_saas_token に変更 (旧 admin と分離)
 *   - JWT_EXPIRES_IN 環境変数対応 (.env.example 整合)
 */

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

const JWT_EXPIRY = process.env.JWT_EXPIRES_IN ?? '4h'
const TOKEN_COOKIE_NAME = 'ugokimap_saas_token'

export type Plan = 'free' | 'starter' | 'growth' | 'agency' | 'enterprise'

export interface JWTPayload {
  sub: string                  // user id
  email: string
  name: string
  tenant_id: string            // multi-tenant isolation (§3.8.1)
  plan: Plan
  site_ids: string[]           // tenant 内でアクセス可能な site_id 一覧
  role?: 'owner' | 'admin' | 'member' | 'viewer'
}

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(getJwtSecret())
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      tenant_id: payload.tenant_id as string,
      plan: (payload.plan as Plan) ?? 'free',
      site_ids: (payload.site_ids as string[]) ?? [],
      role: payload.role as JWTPayload['role'],
    }
  } catch {
    return null
  }
}

export function extractToken(request: Request): string | null {
  // 1. Authorization header
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }
  // 2. Cookie
  const cookie = request.headers.get('cookie')
  if (cookie) {
    const re = new RegExp(`${TOKEN_COOKIE_NAME}=([^;]+)`)
    const match = cookie.match(re)
    if (match) return match[1]
  }
  return null
}

export async function authenticateRequest(request: Request): Promise<JWTPayload | null> {
  const token = extractToken(request)
  if (!token) return null
  return verifyToken(token)
}

export { TOKEN_COOKIE_NAME }
