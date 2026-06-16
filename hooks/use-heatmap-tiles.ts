/**
 * useHeatmapTiles — tile cursor pagination + eager prefetch + AbortController
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / Infra heatmap-pagination.md §6
 *
 * 続 117 v2 root-fix (bug #5: 「データが入ってない / 最初の tile しか出ない」):
 *   旧実装は 1 回の fetch で 1 tile しか取らず、IntersectionObserver が発火するまで
 *   2 枚目以降を取得しなかった。screenshot underlay は normal flow で一気に全高表示するため
 *   sentinel が viewport に入らず、結果ほぼ最初の tile 分の blob しか描画されなかった。
 *
 *   新実装は **eager prefetch loop**:
 *     - 1 回の呼び出しで cursor を辿り、次の上限のいずれかに達するまで連続 fetch する:
 *         a) next_cursor == null (全 tile 取得完了)
 *         b) batches >= MAX_BATCHES_PER_RUN (1 run あたりの最大 batch、暴走防止)
 *         c) accumulated pointCount >= MAX_POINTS (描画 point 上限、メモリ / 描画暴走防止)
 *     - 各 batch ごとに setTiles を呼ぶので段階的に描画が進む (progressive render)。
 *     - 上限 b/c で止まった場合は hasMore=true / cursor 保持のまま → loadMore() で続き取得可。
 *
 * 仕様 (公開 API は不変):
 *  - 初回 mount で eager prefetch (上限まで)
 *  - loadMore() で続き (最低 1 batch) を eager prefetch
 *  - query が変わったら cursor を破棄して頭から再 fetch (AbortController で前回 cancel)
 *  - tile キャッシュは `Set<y_start>` (重複 fetch 防止)
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchHeatmapTile,
  type HeatmapQuery,
  type HeatmapTile,
  type HeatmapTileMeta,
} from '@/lib/api/heatmap'

export interface UseHeatmapTilesResult {
  tiles: HeatmapTile[]
  loading: boolean
  hasMore: boolean
  pageHeightEstimate: number
  meta: HeatmapTileMeta | null
  error: string | null
  /** true: 表示中の tiles は旧 query のものです (新 query をフェッチ中)。keepPreviousData パターン。 */
  stale: boolean
  loadMore: () => void
  reset: () => void
}

// 続120: route.ts の PAGE_HEIGHT_ESTIMATE と一致させる (66_000、UInt16 click_y 上限カバー)
const DEFAULT_PAGE_HEIGHT = 66_000
/** 1 回の eager run で辿る最大 batch 数 (無限ループ / 過剰 request 防止の hard cap) */
const MAX_BATCHES_PER_RUN = 24
/** 描画 point の上限。これを超えたら eager loop を止めて loadMore に委ねる (メモリ / 描画暴走防止) */
const MAX_POINTS = 6_000

export function useHeatmapTiles(query: HeatmapQuery): UseHeatmapTilesResult {
  const [tiles, setTiles] = useState<HeatmapTile[]>([])
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [pageHeightEstimate, setPageHeightEstimate] = useState(DEFAULT_PAGE_HEIGHT)
  const [meta, setMeta] = useState<HeatmapTileMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  // keepPreviousData: true = 表示中 tiles は旧 query のもの (新 query フェッチ中)。
  // ref は fetchFrom 内 (render サイクル外) からも読む必要があるため ref + state の二重管理。
  const [stale, setStale] = useState(false)
  const staleRef = useRef(false)

  // tile キャッシュ (重複 fetch 防止) + 累積 point 数 (MAX_POINTS 判定用、render を跨いで保持)
  const seenStartsRef = useRef<Set<number>>(new Set())
  const pointCountRef = useRef<number>(0)
  const abortRef = useRef<AbortController | null>(null)

  // query の signature 文字列 (依存配列で primitive 比較したい)。続125: segment 追加。
  const querySig = `${query.site_id}|${query.page_url}|${query.layer}|${query.start_date ?? ''}|${query.end_date ?? ''}|${query.device_type ?? ''}|${query.tile_size ?? ''}|${query.segment ?? 'all'}`

  // 与えられた cursor から eager に連続取得する。1 回の呼び出しで最低 1 batch、
  // 上限 (cursor 尽き / batch 上限 / point 上限) まで辿る。
  const fetchFrom = useCallback(
    async (startCursor: string | null) => {
      // 前回 in-flight を cancel
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setLoading(true)
      setError(null)

      let currentCursor = startCursor
      let batches = 0

      try {
        // do-while: 必ず最低 1 batch は取得する (loadMore / 初回が空振りしないため)。
        do {
          const response = await fetchHeatmapTile(query, currentCursor, ctrl.signal)

          // cancelled (新 query / unmount) の場合は黙って抜ける
          if (ctrl.signal.aborted) return

          if (!response.success) {
            // CURSOR_INVALID → cursor を破棄して頭から。stale tiles も廃棄 (再 fetch の起点をリセット)
            if (response.error.code === 'CURSOR_INVALID') {
              seenStartsRef.current = new Set()
              pointCountRef.current = 0
              staleRef.current = false
              setStale(false)
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
          for (const t of fresh) {
            seen.add(t.y_start)
            pointCountRef.current += t.points.length
          }

          if (staleRef.current) {
            // keepPreviousData: 新 query の最初のバッチ到着 → 旧 tiles を丸ごと入れ替え
            setTiles([...fresh].sort((a, b) => a.y_start - b.y_start))
            staleRef.current = false
            setStale(false)
          } else if (fresh.length > 0) {
            setTiles((prev) => [...prev, ...fresh].sort((a, b) => a.y_start - b.y_start))
          }
          setMeta(response.meta)
          setPageHeightEstimate(
            Math.max(response.meta.page_height_estimate, DEFAULT_PAGE_HEIGHT),
          )

          currentCursor = next_cursor
          batches += 1

          if (next_cursor == null) break
        } while (
          currentCursor != null &&
          batches < MAX_BATCHES_PER_RUN &&
          pointCountRef.current < MAX_POINTS
        )

        if (ctrl.signal.aborted) return
        setCursor(currentCursor)
        setHasMore(currentCursor != null)
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'tile fetch failed')
        setHasMore(false)
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    },
    // query は変更時に reset effect で fetchFrom(null) 経由で呼び直すため deps から除外
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [querySig],
  )

  // query 変更時: keepPreviousData で旧 tiles を即時消去しない (画面切替の白紙防止)。
  // staleRef を true にして fetchFrom 内で「最初のバッチ = 丸ごと入れ替え」に切替える。
  useEffect(() => {
    seenStartsRef.current = new Set()
    pointCountRef.current = 0
    staleRef.current = true
    setStale(true)
    // setTiles([]) は呼ばない — 旧 tiles を keepPreviousData として表示し続ける
    setCursor(null)
    setHasMore(true)
    setError(null)
    setPageHeightEstimate(DEFAULT_PAGE_HEIGHT)
    void fetchFrom(null)

    return () => {
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySig])

  const loadMore = useCallback(() => {
    if (!hasMore || loading || cursor == null) return
    void fetchFrom(cursor)
  }, [cursor, hasMore, loading, fetchFrom])

  const reset = useCallback(() => {
    seenStartsRef.current = new Set()
    pointCountRef.current = 0
    staleRef.current = false
    setStale(false)
    setTiles([])
    setCursor(null)
    setHasMore(true)
    setError(null)
    void fetchFrom(null)
  }, [fetchFrom])

  return { tiles, loading, hasMore, pageHeightEstimate, meta, error, stale, loadMore, reset }
}
