'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, ArrowLeft } from 'lucide-react'
import ErrorMessage from '@/components/ui/error-message'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Login failed')
      }

      // セッションストレージにユーザー情報を保存（簡易実装）
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('user', JSON.stringify(data.user))
        sessionStorage.setItem('isAuthenticated', 'true')
      }

      // ダッシュボードにリダイレクト
      router.push('/dashboard')
    } catch (err: any) {
      setError(err.message || 'ログインに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Link href="/" className="inline-flex items-center text-gray-600 hover:text-gray-900 mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" />
          ホームに戻る
        </Link>

        <Card>
          <CardHeader className="text-center">
            <div className="flex items-center justify-center mb-4">
              <img 
                src="/ugokimap.png" 
                alt="UGOKI MAP" 
                className="h-12 w-auto"
                onError={(e) => {
                  // ロゴ画像が読み込めない場合のフォールバック
                  const target = e.target as HTMLImageElement
                  target.style.display = 'none'
                  const fallback = target.nextElementSibling as HTMLElement
                  if (fallback) fallback.style.display = 'flex'
                }}
              />
              <div className="h-12 w-12 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 flex items-center justify-center" style={{ display: 'none' }}>
                <span className="text-white font-bold text-xl">CI</span>
              </div>
            </div>
            <CardTitle className="text-2xl">ログイン</CardTitle>
            <CardDescription>
              UGOKI MAPアカウントにログイン
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <ErrorMessage
                  title="ログインエラー"
                  message={error}
                  onDismiss={() => setError(null)}
                />
              )}

              <div>
                <Label htmlFor="email">メールアドレス</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  disabled={loading}
                />
              </div>

              <div>
                <Label htmlFor="password">パスワード</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  disabled={loading}
                  minLength={8}
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ログイン中...
                  </>
                ) : (
                  'ログイン'
                )}
              </Button>
            </form>

            <div className="mt-6 text-center text-sm text-gray-600">
              アカウントをお持ちでないですか？{' '}
              <Link href="/auth/register" className="text-blue-600 hover:text-blue-700 font-medium">
                新規登録
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

