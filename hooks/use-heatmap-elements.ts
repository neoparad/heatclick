/**
 * useHeatmapElements — 要素単位クリック集計 + シグナルの取得 hook (続123)
 *
 * heatmap tiles と独立して fetch する「強化データ」。失敗/未取得でも heatmap 本体は
 * cluster ベース fallback で描画継続するため、エラーは null に畳む (非致命)。
 */

'use client'

import { useEffect, useState } from 'react'

import {
  fetchHeatmapElements,
  type HeatmapElementsData,
  type HeatmapElementsQuery,
} from '@/lib/api/heatmap-elements'

export interface UseHeatmapElementsResult {
  elements: HeatmapElementsData | null
  loading: boolean
}

export function useHeatmapElements(query: {
  siteId: string
  pageUrl: string
  dateRange: { start: string; end: string }
  deviceType: 'all' | 'desktop' | 'mobile' | 'tablet'
  /** 続125: 行動セグメント (未指定 = all) */
  segment?: 'all' | 'deep_read' | 'bounce' | 'ad'
}): UseHeatmapElementsResult {
  const [elements, setElements] = useState<HeatmapElementsData | null>(null)
  const [loading, setLoading] = useState(false)

  const { siteId, pageUrl, deviceType } = query
  const { start, end } = query.dateRange
  const segment = query.segment ?? 'all'

  useEffect(() => {
    if (!siteId || !pageUrl) {
      setElements(null)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    const apiQuery: HeatmapElementsQuery = {
      site_id: siteId,
      page_url: pageUrl,
      start_date: start,
      end_date: end,
      device_type: deviceType === 'all' ? undefined : deviceType,
      segment,
    }
    fetchHeatmapElements(apiQuery, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setElements(data)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [siteId, pageUrl, start, end, deviceType, segment])

  return { elements, loading }
}
