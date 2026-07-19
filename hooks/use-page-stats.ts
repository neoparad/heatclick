/**
 * usePageStats — `/api/heatmap/page-stats` を hook 化 (段 2 PageStatsBar 撤去に伴う抽出)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap screenshot underlay + controls compact Phase 2 (B)
 *
 * 旧 `PageStatsBar` 内の fetch logic を hook 化し、heatmap-page から取得した値を
 * canvas-top (`HeatmapToolbar`) に集約表示する。fetch 仕様は不変 (URL / abort / 5xx ハンドリング)。
 */

'use client'

import { useEffect, useState } from 'react'

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

export interface PageStatsData {
  page_views: number
  sessions: number
  ctr: number | null
  scroll_path_rate: number | null
  evidence_level: 'observed_exact' | 'observed_approx'
}

export type PageStatsState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PageStatsData }
  | { kind: 'error'; message: string }

export interface UsePageStatsInput {
  siteId: string
  pageUrl: string
  dateRange: { start: string; end: string }
  deviceType?: 'desktop' | 'mobile' | 'tablet' | 'unknown' | 'all'
}

export function usePageStats(input: UsePageStatsInput): PageStatsState {
  const [state, setState] = useState<PageStatsState>({ kind: 'loading' })

  useEffect(() => {
    const ctrl = new AbortController()
    setState({ kind: 'loading' })
    safeMark('hm:stats:start')

    const params = new URLSearchParams({
      site_id: input.siteId,
      page_url: input.pageUrl,
      start_date: input.dateRange.start,
      end_date: input.dateRange.end,
    })
    if (input.deviceType && input.deviceType !== 'all') {
      params.set('device_type', input.deviceType)
    }

    fetch(`/api/heatmap/page-stats?${params.toString()}`, {
      credentials: 'include',
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null)
        if (!res.ok || !body || typeof body !== 'object') {
          setState({
            kind: 'error',
            message:
              body && typeof body === 'object' && 'error' in body
                ? String(
                    (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`,
                  )
                : `HTTP ${res.status}`,
          })
          return
        }
        const envelope = body as {
          success?: boolean
          data?: PageStatsData
          error?: { message?: string }
        }
        if (envelope.success && envelope.data) {
          setState({ kind: 'ready', data: envelope.data })
        } else {
          setState({ kind: 'error', message: envelope.error?.message ?? 'unknown error' })
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'page stats fetch failed',
        })
      })
      .finally(() => {
        if (!ctrl.signal.aborted) {
          safeMark('hm:stats:end')
          safeMeasure('hm:stats', 'hm:stats:start', 'hm:stats:end')
        }
      })

    return () => ctrl.abort()
  }, [
    input.siteId,
    input.pageUrl,
    input.dateRange.start,
    input.dateRange.end,
    input.deviceType,
  ])

  return state
}

/** PageStatsData → HeatmapToolbar 用 label。 0 / null は undefined 化して非表示にする。 */
export function pageStatsToLabels(state: PageStatsState): {
  pvLabel?: string
  ctrLabel?: string
  scrollLabel?: string
} {
  if (state.kind !== 'ready') return {}
  const d = state.data
  if (d.page_views <= 0) return {}
  return {
    pvLabel: d.page_views.toLocaleString(),
    ctrLabel: d.ctr !== null ? `${(d.ctr * 100).toFixed(1)}%` : undefined,
    scrollLabel:
      d.scroll_path_rate !== null ? `${(d.scroll_path_rate * 100).toFixed(1)}%` : undefined,
  }
}
