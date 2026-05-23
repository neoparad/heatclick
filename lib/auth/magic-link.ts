/**
 * Magic link token signing / verification
 *
 * 親 SSOT §3.6.1 / §3.8.1 / Part V §5.5.1 P-01
 *
 * 設計:
 *   - magic link token は短命 (15 min) かつ single-use
 *   - JWT (HS256) で署名、verify 時に Redis SETNX で再利用検出
 *   - email 入力時に user が存在しない場合は Sprint 1 では「dogfood 招待制」
 *     なので 404 ではなく「リンクを送信しました」を常に返す (列挙対策)
 */

import { SignJWT, jwtVerify } from 'jose'

let _secret: Uint8Array | null = null
function getSecret(): Uint8Array {
  if (!_secret) {
    const secret =
      process.env.MAGIC_LINK_SECRET ||
      process.env.JWT_SECRET ||
      process.env.NEXTAUTH_SECRET
    if (!secret) {
      throw new Error(
        'MAGIC_LINK_SECRET (or JWT_SECRET / NEXTAUTH_SECRET fallback) environment variable is required',
      )
    }
    _secret = new TextEncoder().encode(secret)
  }
  return _secret
}

const MAGIC_LINK_EXPIRY = process.env.MAGIC_LINK_EXPIRES_IN ?? '15m'
export const MAGIC_LINK_EXPIRES_MIN = 15

export interface MagicLinkPayload {
  email: string
  // CSRF / replay 防止用 nonce (Redis にもキャッシュして single-use 化)
  jti: string
  // optional redirect after sign-in
  redirect?: string
}

export async function signMagicLinkToken(payload: MagicLinkPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(MAGIC_LINK_EXPIRY)
    .setJti(payload.jti)
    .setSubject(payload.email)
    .sign(getSecret())
}

export async function verifyMagicLinkToken(token: string): Promise<MagicLinkPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    const email = payload.email
    const jti = payload.jti
    if (typeof email !== 'string' || typeof jti !== 'string') return null
    return {
      email,
      jti,
      redirect: typeof payload.redirect === 'string' ? payload.redirect : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Random nonce — Web Crypto (Edge + Node 20 共通)
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
