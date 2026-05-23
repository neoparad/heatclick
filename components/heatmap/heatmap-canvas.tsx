/**
 * HeatmapCanvas — heatmap.js を tile pagination で 30000px+ LP に描画
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / Infra heatmap-pagination.md §6
 *
 * 旧 ugokimap バグ 3 修正:
 *   1. canvas 単一描画 → tile (2400px) 単位の分割描画 (Canvas 高さ上限 32767px 回避)
 *   2. ResizeObserver 無限 re-render → useEffect deps を `[]` に固定
 *   3. flex layout 衝突 → 親は CSS grid (本コンポーネントは relative absolute layer のみ)
 *
 * heatmap.js instance は **tile ごとに 1 つ作って使い回し**、setData で差分更新する。
 */

'use client'

import { useEffect, useRef, useState } from 'react'

import { useHeatmapTiles } from '@/hooks/use-heatmap-tiles'
import type { HeatmapPoint, HeatmapTile } from '@/lib/api/heatmap'
import type { HeatmapQuery } from '@/lib/api/heatmap'
import { HeatmapAccessibleTable } from './heatmap-accessible-table'

const RADIUS: Record<string, number> = {
  click: 25,
  move: 35,
  emotion: 30,
  friction: 28,
}

const GRADIENT: Record<string, Record<string, string>> = {
  click: { '0.2': '#4F6BFF', '0.5': '#22D3EE', '0.8': '#F59E0B', '1.0': '#EF4444' },
  move: { '0.2': '#A855F7', '0.5': '#4F6BFF', '0.8': '#22D3EE', '1.0': '#F59E0B' },
  emotion: { '0.2': '#10B981', '0.5': '#F59E0B', '0.8': '#EF4444', '1.0': '#7C2D12' },
  friction: { '0.2': '#FBBF24', '0.5': '#F97316', '0.8': '#EF4444', '1.0': '#7F1D1D' },
}

export interface HeatmapCanvasProps {
  query: HeatmapQuery
  /** hotspot をクリックしたとき呼ばれる。右パネル open に使う */
  onHotspotSelect?: (point: HeatmapPoint, tile: HeatmapTile) => void
}

const SENTINEL_LEAD = 600 // px、tile y_end より上に置く距離 (loadMore 余白)
const INITIAL_SENTINEL_TOP = 1800 // px、最初の tile (0..2400) で early-trigger 用

export function HeatmapCanvas({ query, onHotspotSelect }: HeatmapCanvasProps) {
  const { tiles, loading, hasMore, pageHeightEstimate, error, loadMore } = useHeatmapTiles(query)
  const rootRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)

  // sentinel top 計算: 最新 tile の y_end - SENTINEL_LEAD。tiles 空なら INITIAL。
  const sentinelTop = tiles.length
    ? Math.max(0, tiles[tiles.length - 1].y_end - SENTINEL_LEAD)
    : INITIAL_SENTINEL_TOP
  const sentinelTopRef = useRef(sentinelTop)
  sentinelTopRef.current = sentinelTop

  // ResizeObserver: コンテナ幅を取得 (deps = [] 固定で旧バグ #3 を回避)
  useEffect(() => {
    if (!rootRef.current) return
    const el = rootRef.current
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect
        setWidth(cr.width)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // IntersectionObserver: sentinel が viewport に入ったら loadMore
  // B-1 fix: sentinel は最新 tile の y_end - 600px に動的配置されるので、
  // ユーザーが「次 tile が必要になる ~600px 手前」に到達すると即 trigger。
  useEffect(() => {
    if (!sentinelRef.current) return
    if (!hasMore) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore()
        }
      },
      { rootMargin: '200px 0px', threshold: 0 },
    )
    io.observe(sentinelRef.current)
    return () => io.disconnect()
  }, [hasMore, loadMore, sentinelTop])

  // Safety net: 初回マウント直後 (tiles 1 つだけ) で sentinel が即 viewport 内なら、
  // IntersectionObserver の最初の callback を待たずに loadMore を kick。
  // (一部の jsdom / Playwright 環境で IO 初期通知が遅延するケース対応、Reviewer 推奨)
  useEffect(() => {
    if (!hasMore || loading || !sentinelRef.current || !rootRef.current) return
    const sentinelRect = sentinelRef.current.getBoundingClientRect()
    if (sentinelRect.top < window.innerHeight + 600 && sentinelRect.top > -100) {
      loadMore()
    }
  }, [hasMore, loading, loadMore, sentinelTop])

  return (
    <div
      ref={rootRef}
      className="relative w-full overflow-hidden rounded-md border border-border bg-background"
      style={{ height: pageHeightEstimate }}
      role="img"
      aria-label={`${query.layer} ヒートマップ ${query.page_url}`}
    >
      {width != null
        ? tiles.map((tile) => (
            <HeatmapTileLayer
              key={tile.y_start}
              tile={tile}
              width={width}
              layer={query.layer}
              onHotspotSelect={onHotspotSelect}
            />
          ))
        : null}

      {/*
        IntersectionObserver sentinel — B-1 fix (Reviewer T1 dual 続 10):
        旧実装は `bottom: 0` 固定で、30000px 高さ container の最下部のみ監視 →
        ユーザーが y=29400 付近に到達するまで loadMore が trigger されない。
        修正: 「最新 tile の y_end - 600px」を sentinel top に動的設定。
        - 初回 (tiles 空): 0 + (tile_size - 600) = 1800px に sentinel → 即発火に近い
        - tile 増えるごとに sentinel が下にスライド、常に「次 tile が描画されるべき直前」を監視
      */}
      <div
        ref={sentinelRef}
        aria-hidden
        data-testid="heatmap-load-more-sentinel"
        style={{
          position: 'absolute',
          top: Math.max(0, sentinelTopRef.current),
          left: 0,
          height: 1,
          width: '100%',
        }}
      />

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none sticky top-2 mx-auto w-fit rounded-full bg-foreground/85 px-3 py-1 text-xs text-background"
          style={{ position: 'sticky', top: 8 }}
        >
          tile を読み込み中…
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="absolute inset-x-0 top-2 mx-auto w-fit rounded-md bg-destructive/90 px-3 py-1.5 text-xs text-white"
        >
          {error}
        </div>
      ) : null}

      {/* a11y: canvas 不可視部分の代替表示 — visually hidden だが SR が読める */}
      <HeatmapAccessibleTable tiles={tiles} layer={query.layer} pageUrl={query.page_url} />
    </div>
  )
}

interface HeatmapTileLayerProps {
  tile: HeatmapTile
  width: number
  layer: HeatmapQuery['layer']
  onHotspotSelect?: (point: HeatmapPoint, tile: HeatmapTile) => void
}

function HeatmapTileLayer({ tile, width, layer, onHotspotSelect }: HeatmapTileLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<unknown>(null)
  const height = tile.y_end - tile.y_start

  useEffect(() => {
    let cancelled = false
    let instance: ReturnType<(typeof import('heatmap.js'))['default']['create']> | null = null

    async function init() {
      if (!containerRef.current) return
      const h337 = (await import('heatmap.js')).default
      if (cancelled || !containerRef.current) return

      instance = h337.create({
        container: containerRef.current,
        radius: RADIUS[layer] ?? 24,
        maxOpacity: 0.7,
        minOpacity: 0.05,
        blur: 0.85,
        gradient: GRADIENT[layer] ?? GRADIENT.click,
      })
      instanceRef.current = instance

      const max = tile.points.length ? Math.max(...tile.points.map((p) => p.count)) : 0
      instance.setData({
        max: Math.max(max, 1),
        data: tile.points.map((p) => ({
          x: scaleX(p.x, width),
          y: p.y - tile.y_start, // tile 座標系
          value: p.count,
        })),
      })
    }

    void init()
    return () => {
      cancelled = true
      // heatmap.js には destroy API がない。container 削除でリーフ canvas も削除される。
      instanceRef.current = null
    }
  }, [tile, width, layer])

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!onHotspotSelect) return
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    const docY = tile.y_start + localY
    // 最近傍 hotspot を探す (簡易、Sprint 1)
    let best: HeatmapPoint | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const p of tile.points) {
      const dx = scaleX(p.x, width) - localX
      const dy = p.y - docY
      const d = dx * dx + dy * dy
      if (d < bestDist) {
        best = p
        bestDist = d
      }
    }
    if (best && bestDist < 60 * 60) onHotspotSelect(best, tile)
  }

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      role="presentation"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: tile.y_start,
        height,
        width: '100%',
      }}
    />
  )
}

/**
 * heatmap.js の x 座標は **container の絶対 px**。API は `click_x` を 0-1280 の
 * 想定で返すため、container 幅で線形スケーリング。Sprint 2 で client viewport
 * width との正規化を改善。
 */
function scaleX(rawX: number, width: number): number {
  const SOURCE_WIDTH = 1280
  return (rawX / SOURCE_WIDTH) * width
}
