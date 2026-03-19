// 認証ユーティリティ関数

export interface User {
  id: string
  email: string
  name: string
  plan?: string
  status?: string
  created_at?: string
}

// クライアント側でユーザー情報を取得
export function getCurrentUser(): User | null {
  if (typeof window === 'undefined') return null

  try {
    const userStr = sessionStorage.getItem('user')
    if (!userStr) return null
    return JSON.parse(userStr)
  } catch {
    return null
  }
}

// クライアント側で認証状態を確認
export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false
  return sessionStorage.getItem('isAuthenticated') === 'true'
}

// ログイン処理（JWT対応）
export async function login(email: string, password: string): Promise<{ success: boolean; error?: string; user?: User }> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include', // Cookieを受け取る
    })

    const data = await res.json()

    if (!res.ok || !data.success) {
      return { success: false, error: data.error || 'Login failed' }
    }

    // sessionStorageにユーザー情報を保存（UIの表示用、認証の根拠はCookie内のJWT）
    sessionStorage.setItem('user', JSON.stringify(data.user))
    sessionStorage.setItem('isAuthenticated', 'true')

    return { success: true, user: data.user }
  } catch {
    return { success: false, error: 'Network error' }
  }
}

// サーバーサイドでトークンを検証してユーザー情報を取得
export async function verifySession(): Promise<User | null> {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
    })

    if (!res.ok) {
      // トークン無効 → セッションをクリア
      sessionStorage.removeItem('user')
      sessionStorage.removeItem('isAuthenticated')
      return null
    }

    const data = await res.json()
    if (data.success && data.user) {
      sessionStorage.setItem('user', JSON.stringify(data.user))
      sessionStorage.setItem('isAuthenticated', 'true')
      return data.user
    }

    return null
  } catch {
    return null
  }
}

// ログアウト（JWT対応）
export async function logout(): Promise<void> {
  if (typeof window === 'undefined') return

  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
  } catch { /* silent */ }

  sessionStorage.removeItem('user')
  sessionStorage.removeItem('isAuthenticated')
  window.location.href = '/'
}
