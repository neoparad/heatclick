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

// ログアウト
export function logout(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem('user')
  sessionStorage.removeItem('isAuthenticated')
  window.location.href = '/'
}



