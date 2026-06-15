/**
 * Authentication client utilities (browser side)
 *
 * 親 SSOT §3.6 / §3.8.1
 * Sprint 0 S0-03 完成版。
 *
 * ugokimap/lib/auth.ts から流用 + tenant_id / plan 対応。
 * Server side 認証は middleware.ts + lib/jwt.ts で完結。
 */

import type { Plan } from './jwt'

export interface User {
  id: string
  email: string
  name: string
  tenant_id: string
  plan: Plan
  site_ids: string[]
  role?: 'owner' | 'admin' | 'member' | 'viewer'
  status?: 'active' | 'suspended' | 'deleted'
  created_at?: string
}

const STORAGE_KEY_USER = 'ugokimap_saas_user'
const STORAGE_KEY_AUTHENTICATED = 'ugokimap_saas_isAuthenticated'

export function getCurrentUser(): User | null {
  if (typeof window === 'undefined') return null
  try {
    const userStr = sessionStorage.getItem(STORAGE_KEY_USER)
    if (!userStr) return null
    return JSON.parse(userStr) as User
  } catch {
    return null
  }
}

export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false
  return sessionStorage.getItem(STORAGE_KEY_AUTHENTICATED) === 'true'
}

/**
 * Magic link request (passwordless、Sprint 1 S1-01)
 * server 側で email にトークン送信 → /auth/verify?token=... で確定
 */
export async function requestMagicLink(email: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || 'Magic link request failed' }
    }
    return { success: true }
  } catch {
    return { success: false, error: 'Network error' }
  }
}

export async function verifySession(): Promise<User | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    if (!res.ok) {
      clearSession()
      return null
    }
    const data = await res.json()
    if (data.success && data.user) {
      sessionStorage.setItem(STORAGE_KEY_USER, JSON.stringify(data.user))
      sessionStorage.setItem(STORAGE_KEY_AUTHENTICATED, 'true')
      return data.user as User
    }
    return null
  } catch {
    return null
  }
}

export async function logout(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  } catch {
    /* silent */
  }
  clearSession()
  // Director 続 74 Task E: ログアウト後 404 解消 (旧 `/` 遷移 →
  // `/auth/sign-in` に変更、サインアウト直後の再ログイン導線を維持)
  window.location.href = '/auth/sign-in?signed-out=1'
}

function clearSession(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(STORAGE_KEY_USER)
  sessionStorage.removeItem(STORAGE_KEY_AUTHENTICATED)
}
