/**
 * useHeatmapElements — 要素単位クリック集計 + シグナルの取得 hook (続123)
 *
 * heatmap tiles と独立して fetch する「強化データ」。失敗/未取得でも heatmap 本体は
 * cluster ベース fallback で描画継続するため、エラーは null に畳む (非致命)。
 */

'use client'

import { useEffect, useState } from 'react'

import type { HeatmapSegment } from '@/lib/api/heatmap'
import {
  fetchHeatmapElements,
  type HeatmapElementsData,
  type HeatmapElementsQuery,
} from '@/lib/api/heatmap-elements'

// ---------------------------------------------------------------------------
// P0 計測 (spec: docs/heatmap/SONNET_PROMPT_P0_instrumentation_2026-07-19.md §4)
// mark/measure は必ず try/catch で自壊させ、計測失敗がアプリの挙動に一切影響しないようにする
// (spec §0 絶対条件1)。
// ---------------------------------------------------------------------------
function safeMark(name: string): void {
  try {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
    performance.mark(name)
  } catch {
    // instrumentation must never affect app behavior
  }
}

function safeMeasure(name: string, startMark: string, endMark: string): void {
  try {
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
    performance.measure(name, startMark, endMark)
  } catch {
    // instrumentation must never affect app behavior
  }
}

export interface UseHeatmapElementsResult {
  elements: HeatmapElementsData | null
  loading: boolean
}

export function useHeatmapElements(query: {
  siteId: string
  pageUrl: string
  dateRange: { start: string; end: string }
  deviceType: 'all' | 'desktop' | 'mobile' | 'tablet'
  /** 続125/132: 行動セグメント (未指定 = all) */
  segment?: HeatmapSegment
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
    safeMark('hm:elements:start')
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
        if (!ctrl.signal.aborted) {
          setLoading(false)
          safeMark('hm:elements:end')
          safeMeasure('hm:elements', 'hm:elements:start', 'hm:elements:end')
        }
      })
    return () => ctrl.abort()
  }, [siteId, pageUrl, start, end, deviceType, segment])

  return { elements, loading }
}
