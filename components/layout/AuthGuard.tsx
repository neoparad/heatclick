'use client'

interface AuthGuardProps {
  children: React.ReactNode
}

// 認証システムが未実装のため、現在は全アクセスを許可
// TODO: 認証システム実装後に有効化する
export default function AuthGuard({ children }: AuthGuardProps) {
  return <>{children}</>
}












