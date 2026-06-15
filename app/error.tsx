'use client'

/**
 * Route-segment error boundary (続 117 white-screen root-fix)
 *
 * これまでエラー境界が一切無く、描画中に例外が出ると本番で画面が真っ白になっていた。
 * 本境界は:
 *   1. ChunkLoadError (旧デプロイの古いチャンク参照) なら自動で最新を取り直す (自己修復)
 *   2. それ以外は Sentry に通報しつつ、白画面ではなく復旧 UI を表示する
 *
 * UI は inline style のみで構成する (CSS チャンク自体の読み込み失敗時でも表示できるように)。
 */

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

import { recoverFromStaleChunk } from '@/lib/chunk-recovery'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // 古いチャンク由来なら自動 reload で自己修復し、Sentry ノイズも出さない
    if (recoverFromStaleChunk(error)) return
    Sentry.captureException(error)
  }, [error])

  return (
    <div
      role="alert"
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: '48px 24px',
        textAlign: 'center',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
        color: '#0f1117',
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
        画面の読み込みでエラーが発生しました
      </h1>
      <p style={{ fontSize: 14, color: '#525866', margin: 0, maxWidth: 420, lineHeight: 1.6 }}>
        一時的な問題の可能性があります。再読み込みしてもう一度お試しください。
        繰り返し表示される場合はサポートまでご連絡ください。
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={() => {
            // reset() で segment 再描画、ダメなら hard reload で最新取得
            reset()
            if (typeof window !== 'undefined') window.location.reload()
          }}
          style={{
            padding: '10px 18px',
            borderRadius: 8,
            border: 0,
            background: 'linear-gradient(135deg, #4cb782, #2c8f5f)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          再読み込み
        </button>
        <button
          type="button"
          onClick={() => {
            // 壊れた client 状態から確実に抜けるため full navigation でトップへ
            if (typeof window !== 'undefined') window.location.assign('/')
          }}
          style={{
            padding: '10px 18px',
            borderRadius: 8,
            border: '1px solid #d8dce3',
            background: '#fff',
            color: '#0f1117',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          トップへ戻る
        </button>
      </div>
      {error.digest ? (
        <p style={{ fontSize: 11, color: '#9aa1ad', marginTop: 8, fontFamily: 'ui-monospace, monospace' }}>
          参照コード: {error.digest}
        </p>
      ) : null}
    </div>
  )
}
