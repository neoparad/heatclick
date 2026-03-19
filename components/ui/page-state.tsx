'use client'

import Loading from './loading'
import ErrorMessage from './error-message'
import { RefreshCw } from 'lucide-react'
import { Button } from './button'

interface PageStateProps {
  isLoading: boolean
  error: string | null
  isEmpty?: boolean
  emptyMessage?: string
  onRetry?: () => void
  children: React.ReactNode
}

// ページ全体のローディング/エラー/空状態を統一的に処理
export default function PageState({
  isLoading,
  error,
  isEmpty = false,
  emptyMessage = 'データがありません',
  onRetry,
  children,
}: PageStateProps) {
  if (isLoading) {
    return <Loading size="lg" text="データを読み込み中..." />
  }

  if (error) {
    return (
      <div className="p-8 max-w-md mx-auto space-y-4">
        <ErrorMessage
          title="エラーが発生しました"
          message={error}
          variant="error"
        />
        {onRetry && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={onRetry} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              再試行
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-gray-500">
        <p className="text-lg">{emptyMessage}</p>
        {onRetry && (
          <Button variant="outline" onClick={onRetry} className="mt-4 gap-2">
            <RefreshCw className="w-4 h-4" />
            再読み込み
          </Button>
        )}
      </div>
    )
  }

  return <>{children}</>
}
