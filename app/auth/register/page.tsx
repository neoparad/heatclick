'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, ArrowLeft, CheckCircle } from 'lucide-react'
import ErrorMessage from '@/components/ui/error-message'

export default function RegisterPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // パスワード確認
    if (password !== confirmPassword) {
      setError('パスワードが一致しません')
      setLoading(false)
      return
    }

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, email, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed')
      }

      setSuccess(true)
      
      // 2秒後にログインページにリダイレクト
      setTimeout(() => {
        router.push('/auth/login')
      }, 2000)
    } catch (err: any) {
      setError(err.message || '登録に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Card>
            <CardContent className="pt-6">
              <div className="text-center">
                <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
                <h2 className="text-2xl font-bold text-gray-900 mb-2">登録完了</h2>
                <p className="text-gray-600 mb-4">
                  アカウントが正常に作成されました。
                  <br />
                  ログインページにリダイレクトします...
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
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
            <CardTitle className="text-2xl">新規登録</CardTitle>
            <CardDescription>
              UGOKI MAPを無料で始める
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <ErrorMessage
                  title="登録エラー"
                  message={error}
                  onDismiss={() => setError(null)}
                />
              )}

              <div>
                <Label htmlFor="name">お名前</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="山田 太郎"
                  required
                  disabled={loading}
                />
              </div>

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
                <p className="text-xs text-gray-500 mt-1">8文字以上で入力してください</p>
              </div>

              <div>
                <Label htmlFor="confirmPassword">パスワード（確認）</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
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
                    登録中...
                  </>
                ) : (
                  '無料で始める'
                )}
              </Button>
            </form>

            <div className="mt-6 text-center text-sm text-gray-600">
              既にアカウントをお持ちですか？{' '}
              <Link href="/auth/login" className="text-blue-600 hover:text-blue-700 font-medium">
                ログイン
              </Link>
            </div>

            <div className="mt-4 text-xs text-gray-500 text-center">
              登録することで、<Link href="/terms" className="underline">利用規約</Link>と
              <Link href="/privacy" className="underline">プライバシーポリシー</Link>に同意したものとみなされます。
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

