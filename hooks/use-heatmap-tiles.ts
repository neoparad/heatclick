/**
 * useHeatmapTiles — tile lazy pagination + cursor 管理 + AbortController
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / Infra heatmap-pagination.md §6
 *
 * 仕様:
 *  - 初回 mount で 1 tile fetch
 *  - loadMore() で次 tile fetch (server 返却 cursor をそのまま使う)
 *  - query が変わったら cursor を破棄して頭から再 fetch (AbortController で前回 cancel)
 *  - tile キャッシュは `Map<y_start, HeatmapTile>` (重複 fetch 防止)
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchHeatmapTile,
  type HeatmapQuery,
  type HeatmapTile,
  type HeatmapTileMeta,
  type HeatmapTileResponse,
} from '@/lib/api/heatmap'

export interface UseHeatmapTilesResult {
  tiles: HeatmapTile[]
  loading: boolean
  hasMore: boolean
  pageHeightEstimate: number
  meta: HeatmapTileMeta | null
  error: string | null
  loadMore: () => void
  reset: () => void
}

const DEFAULT_PAGE_HEIGHT = 30_000

export function useHeatmapTiles(query: HeatmapQuery): UseHeatmapTilesResult {
  const [tiles, setTiles] = useState<HeatmapTile[]>([])
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [pageHeightEstimate, setPageHeightEstimate] = useState(DEFAULT_PAGE_HEIGHT)
  const [meta, setMeta] = useState<HeatmapTileMeta | null>(null)
  const [error, setError] = useState<string | null>(null)

  // tile cache (重複 fetch 防止)
  const seenStartsRef = useRef<Set<number>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  // query の signature 文字列 (依存配列で primitive 比較したい)
  const querySig = `${query.site_id}|${query.page_url}|${query.layer}|${query.start_date ?? ''}|${query.end_date ?? ''}|${query.device_type ?? ''}|${query.tile_size ?? ''}`

  const fetchTile = useCallback(
    async (currentCursor: string | null) => {
      // 前回 in-flight を cancel
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setLoading(true)
      setError(null)

      try {
        const response: HeatmapTileResponse = await fetchHeatmapTile(
          query,
          currentCursor,
          ctrl.signal,
        )

        // cancelled の場合 abort throws — 結果ハンドリング不要
        if (ctrl.signal.aborted) return

        if (!response.success) {
          // CURSOR_INVALID → cursor を破棄して頭から
          if (response.error.code === 'CURSOR_INVALID') {
            seenStartsRef.current = new Set()
            setTiles([])
            setCursor(null)
            setHasMore(true)
            setError('クエリ条件が変更されたため再取得しました')
            return
          }
          setError(response.error.message)
          setHasMore(false)
          return
        }

        const { tiles: newTiles, next_cursor } = response.data
        const seen = seenStartsRef.current
        const fresh = newTiles.filter((t) => !seen.has(t.y_start))
        for (const t of fresh) seen.add(t.y_start)

        setTiles((prev) => [...prev, ...fresh].sort((a, b) => a.y_start - b.y_start))
        setCursor(next_cursor)
        setHasMore(next_cursor != null)
        setMeta(response.meta)
        setPageHeightEstimate(Math.max(response.meta.page_height_estimate, DEFAULT_PAGE_HEIGHT))
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'tile fetch failed')
        setHasMore(false)
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    },
    // query は変更時に reset effect で fetchTile(null) 経由で呼び直すため deps から除外
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [querySig],
  )

  // query 変更時: reset + 初回 tile fetch
  useEffect(() => {
    seenStartsRef.current = new Set()
    setTiles([])
    setCursor(null)
    setHasMore(true)
    setError(null)
    setPageHeightEstimate(DEFAULT_PAGE_HEIGHT)
    void fetchTile(null)

    return () => {
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySig])

  const loadMore = useCallback(() => {
    if (!hasMore || loading || cursor == null) return
    void fetchTile(cursor)
  }, [cursor, hasMore, loading, fetchTile])

  const reset = useCallback(() => {
    seenStartsRef.current = new Set()
    setTiles([])
    setCursor(null)
    setHasMore(true)
    setError(null)
    void fetchTile(null)
  }, [fetchTile])

  return { tiles, loading, hasMore, pageHeightEstimate, meta, error, loadMore, reset }
}
