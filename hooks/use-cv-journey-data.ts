/**
 * useCvJourneyData — CV経路データ取得（単発集計 + keepPreviousData）
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 *
 * heatmap (use-heatmap-tiles) の keepPreviousData 思想を踏襲しつつ、CV経路は
 * ページネーション不要の単発集計なので大幅に簡素化:
 *   - query 変更で再 fetch（前回 in-flight は AbortController で cancel）
 *   - フェッチ中は旧データを表示し続ける（stale=true）= 画面の白紙化を防ぐ
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchCvJourney,
  type CvJourneyData,
  type CvJourneyMeta,
  type CvJourneyQuery,
} from '@/lib/api/cv-journey'

export interface UseCvJourneyResult {
  data: CvJourneyData | null
  meta: CvJourneyMeta | null
  loading: boolean
  error: string | null
  /** 旧データ表示中に新 query をフェッチ中 */
  stale: boolean
  refetch: () => void
}

export function useCvJourneyData(query: CvJourneyQuery): UseCvJourneyResult {
  const [data, setData] = useState<CvJourneyData | null>(null)
  const [meta, setMeta] = useState<CvJourneyMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const querySig = `${query.site_id}|${query.start_date ?? ''}|${query.end_date ?? ''}|${query.device_type ?? ''}|${query.source ?? 'all'}`

  const run = useCallback(
    async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setLoading(true)
      setError(null)

      try {
        const res = await fetchCvJourney(query, ctrl.signal)
        if (ctrl.signal.aborted) return

        if (!res.success) {
          setError(res.error.message)
          setStale(false)
          return
        }
        setData(res.data)
        setMeta(res.meta)
        setStale(false)
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'fetch failed')
        setStale(false)
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    },
    // querySig で同一化（query オブジェクトの参照差分を無視）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [querySig],
  )

  useEffect(() => {
    // keepPreviousData: data は消さず stale 表示にする
    setStale(true)
    void run()
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySig])

  const refetch = useCallback(() => {
    setStale(true)
    void run()
  }, [run])

  return { data, meta, loading, error, stale, refetch }
}
