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

// 続 118 (2026-05-30 Owner 承認): dogfood 中の「操作していたら sign-in に飛ばされる」を
// 抑えるため、セッション既定を 4h → 30d に延長。招待 email allowlist 制の社内 dogfood では
// 30d は許容範囲 (本番一般公開時に短縮を再検討)。JWT exp と cookie maxAge を drift させない
// ため秒数 SESSION_MAX_AGE_SECONDS を単一ソースとし、verify route の cookie もこれを使う。
const JWT_EXPIRY = process.env.JWT_EXPIRES_IN ?? '30d'

/** セッション有効期限 (秒)。verify route の cookie maxAge と JWT exp を一致させる単一ソース。 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // 30d

const TOKEN_COOKIE_NAME = 'ugokimap_saas_token'

export type Plan = 'free' | 'starter' | 'growth' | 'agency' | 'enterprise'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * REQ-SEC-113 (フェイルセーフ): role 不明 / 解決失敗時は最小権限 (viewer) に倒す。
 * 「未設定 → owner/full のような昇格」を構造的に作らない単一ソース。
 * route ACL / UI gating は必ずこの resolveRole() を経由して role を解決する。
 */
export const DEFAULT_ROLE: Role = 'viewer'

const ROLE_VALUES: readonly Role[] = ['owner', 'admin', 'member', 'viewer']

export function resolveRole(role: unknown): Role {
  return typeof role === 'string' && (ROLE_VALUES as readonly string[]).includes(role)
    ? (role as Role)
    : DEFAULT_ROLE
}

export interface JWTPayload {
  sub: string                  // user id
  email: string
  name: string
  tenant_id: string            // multi-tenant isolation (§3.8.1)
  plan: Plan
  site_ids: string[]           // tenant 内でアクセス可能な site_id 一覧
  role?: Role
  /**
   * REQ-SEC-101 (セッション失効): 失効判定用の世代番号。
   *   - session_version    : user 単位 (パスワード相当イベント / 全セッション失効)
   *   - membership_version : 現在 active な membership 単位 (role 剥奪 / 退会 / テナント停止)
   * middleware が DB の現行 version と照合し、古い JWT を即時無効化する (P1 で DB 経路を有効化)。
   * 旧 token (version 未設定) は移行猶予として 0 とみなす。
   */
  session_version?: number
  membership_version?: number
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
      role: payload.role as Role | undefined,
      session_version: typeof payload.session_version === 'number' ? payload.session_version : 0,
      membership_version:
        typeof payload.membership_version === 'number' ? payload.membership_version : 0,
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
