/**
 * RealPageScreenshotUnderlay — `/api/heatmap/screenshot` で取得した実 page screenshot を
 * `.hm-page` 内に absolute 配置で敷く。
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap screenshot underlay Phase 2
 *
 * 設計 (続 117 v2 root-fix):
 *   - **normal flow** の `<img width:100% height:auto>` として配置 → 親 `.hm-page` の高さを
 *     画像が決める (巨大 transform layer 廃止)。ブラウザが画像を効率 tile/decode するため軽い。
 *   - overlay (heat-blob / heat-tag) は `.hm-page` に absolute 配置され、`displayScale`
 *     (= actualOuterWidth / referenceWidth) を各要素に掛けて画像と座標一致させる。
 *   - aria-hidden (screen reader 用 a11y は HeatmapAccessibleTable 側に集約)
 *   - エラー image は親 (HeatmapCanvas) 側で onError → fallback MockProductPageUnderlay 切替
 */

'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

import type { HeatmapUnderlayCapture } from '@/lib/heatmap/types'
import { isImageUrlTrusted } from '@/lib/heatmap/image-url-validator'

interface RealPageScreenshotUnderlayProps {
  capture: HeatmapUnderlayCapture
  onImageError?: () => void
}

export function RealPageScreenshotUnderlay({
  capture,
  onImageError,
}: RealPageScreenshotUnderlayProps) {
  // 診断: imageUrl の origin 分類 (pure function、副作用なし)
  const urlValidation = isImageUrlTrusted(capture.imageUrl)

  // render 副作用のある警告ログは useEffect に分離 (Strict Mode 二重発火を防ぐ)
  useEffect(() => {
    if (!urlValidation.trusted) {
      console.warn('[heatmap] screenshot image URL: untrusted origin', {
        reason: urlValidation.reason,
        provider: capture.provider,
        // URL 全体は機微情報の可能性があるため hostname のみ記録
        hostname: (() => { try { return new URL(capture.imageUrl).hostname } catch { return 'unknown' } })(),
      })
    }
  }, [capture.imageUrl, capture.provider, urlValidation.trusted, urlValidation.reason])

  const handleImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const errorDetails = {
      provider: capture.provider,
      cached: capture.cached,
      // capture 側の期待サイズ vs 実際の <img> サイズ（失敗時は 0x0 になる）
      expectedSize: `${capture.naturalWidth}x${capture.naturalHeight}`,
      actualSize: `${img.naturalWidth}x${img.naturalHeight}`,
      // URL 全体ではなく scheme のみ（機微情報除去）
      urlScheme: capture.imageUrl.startsWith('data:')
        ? 'data-url'
        : capture.imageUrl.startsWith('blob:')
          ? 'blob'
          : (() => { try { return new URL(capture.imageUrl).protocol.replace(':', '') } catch { return 'unknown' } })(),
      urlTrusted: urlValidation.trusted,
      urlReason: urlValidation.reason,
      _diagnostics: capture._diagnostics,
    }

    console.error('[heatmap] screenshot image failed to load', errorDetails)

    Sentry.captureMessage('heatmap: screenshot image load failed', {
      level: 'warning',
      contexts: { heatmap: errorDetails },
      tags: { provider: capture.provider, cached: String(capture.cached) },
    })

    onImageError?.()
  }

  return (
    <div
      className="real-page-underlay block w-full"
      data-testid="real-page-screenshot-underlay"
      data-data-source="screenshot"
      data-provider={capture.provider}
      data-cached={capture.cached ? '1' : '0'}
      data-capped={capture.capped ? '1' : '0'}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={capture.imageUrl}
        alt=""
        width={capture.naturalWidth}
        height={capture.naturalHeight}
        style={{
          // 続 117 v2: normal flow の block img。width:100% → 親 .hm-page 幅に縮小、
          //   height:auto で aspect 比維持 → この高さが .hm-page 全体の高さを決める。
          //   transform/contain を使わないので巨大 GPU layer を作らない (perf root-fix)。
          display: 'block',
          width: '100%',
          height: 'auto',
        }}
        // perf: async decode。eager (lazy だと scroll するまで描画されず overlay と乖離) 。
        // fetchPriority=high: underlay は最重要ピクセル。既定優先度だと他リクエストに負ける。
        loading="eager"
        decoding="async"
        fetchPriority="high"
        referrerPolicy="no-referrer"
        onError={handleImageError}
        data-testid="real-page-screenshot-img"
      />
    </div>
  )
}
