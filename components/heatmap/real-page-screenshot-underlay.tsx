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

import type { HeatmapUnderlayCapture } from '@/lib/heatmap/types'

interface RealPageScreenshotUnderlayProps {
  capture: HeatmapUnderlayCapture
  onImageError?: () => void
}

export function RealPageScreenshotUnderlay({
  capture,
  onImageError,
}: RealPageScreenshotUnderlayProps) {
  return (
    <div
      className="real-page-underlay block w-full"
      data-testid="real-page-screenshot-underlay"
      data-data-source="screenshot"
      data-provider={capture.provider}
      data-cached={capture.cached ? '1' : '0'}
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
        onError={onImageError}
        data-testid="real-page-screenshot-img"
      />
    </div>
  )
}
