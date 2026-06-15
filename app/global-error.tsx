'use client'

/**
 * Root global error boundary (続 117 white-screen root-fix)
 *
 * RootLayout 自体やその直下で例外が出た場合の最後の砦。global-error は RootLayout を置き換える
 * ため、自前で <html> / <body> を描画する必要がある (Next.js App Router 仕様)。
 *
 * error.tsx と同様:
 *   1. ChunkLoadError なら自動 reload で自己修復
 *   2. それ以外は Sentry 通報 + 白画面ではなく復旧 UI
 * フォント / CSS チャンクに依存しないよう inline style + system font のみで構成する。
 */

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

import { recoverFromStaleChunk } from '@/lib/chunk-recovery'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (recoverFromStaleChunk(error)) return
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f6f7f9',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
          color: '#0f1117',
        }}
      >
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            padding: '40px 28px',
            maxWidth: 460,
            textAlign: 'center',
            background: '#fff',
            borderRadius: 16,
            boxShadow: '0 8px 40px rgba(15,17,23,.08)',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #4cb782, #2c8f5f)',
              color: '#fff',
              fontSize: 24,
              fontWeight: 700,
            }}
          >
            !
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            問題が発生しました
          </h1>
          <p style={{ fontSize: 14, color: '#525866', margin: 0, lineHeight: 1.6 }}>
            ページを読み込めませんでした。再読み込みしてもう一度お試しください。
            繰り返し表示される場合はサポートまでご連絡ください。
          </p>
          <button
            type="button"
            onClick={() => {
              reset()
              if (typeof window !== 'undefined') window.location.reload()
            }}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: 0,
              background: 'linear-gradient(135deg, #4cb782, #2c8f5f)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              marginTop: 4,
            }}
          >
            再読み込み
          </button>
          {error.digest ? (
            <p style={{ fontSize: 11, color: '#9aa1ad', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
              参照コード: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  )
}
