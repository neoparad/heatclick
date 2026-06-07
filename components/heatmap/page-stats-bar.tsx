/**
 * PageStatsBar — heatmap canvas 上端の URL バー + PV / sessions / CTR / 到達率 stats
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `mockup/01_heatmap_canvas.html` (.hm-canvas-top .url-bar)
 * 続 82 Frontend Sprint 4 W1 handoff §2.2
 *
 * Data source: GET /api/heatmap/page-stats
 * Tenant 認可は middleware + route で行う (本コンポーネントは fetch のみ)。
 *
 * 表示ルール:
 *   - page_views = 0 → 「直近 N 日のデータなし」を 1 行で表示 (CTR / 到達率 は出さない)
 *   - ctr = null     → CTR 行を非表示
 *   - scroll_path_rate = null → 到達率 行を非表示 (scroll event 未配備 tenant)
 *
 * EvidenceBadge は API meta の evidence_level を 5-tier の levelV2 prop に渡す。
 */

'use client'

import { useEffect, useState } from 'react'

import { EvidenceBadge } from '@/components/dashboard/evidence-badge'

interface PageStatsBarProps {
  siteId: string
  pageUrl: string
  dateRange: { start: string; end: string }
  deviceType?: 'desktop' | 'mobile' | 'tablet' | 'unknown' | 'all'
}

interface PageStatsData {
  page_views: number
  sessions: number
  ctr: number | null
  scroll_path_rate: number | null
  evidence_level: 'observed_exact' | 'observed_approx'
}

type PageStatsState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PageStatsData }
  | { kind: 'error'; message: string }

export function PageStatsBar({ siteId, pageUrl, dateRange, deviceType }: PageStatsBarProps) {
  const [state, setState] = useState<PageStatsState>({ kind: 'loading' })

  useEffect(() => {
    const ctrl = new AbortController()
    setState({ kind: 'loading' })

    const params = new URLSearchParams({
      site_id: siteId,
      page_url: pageUrl,
      start_date: dateRange.start,
      end_date: dateRange.end,
    })
    if (deviceType && deviceType !== 'all') params.set('device_type', deviceType)

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
                ? String((body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`)
                : `HTTP ${res.status}`,
          })
          return
        }
        const envelope = body as { success?: boolean; data?: PageStatsData; error?: { message?: string } }
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

    return () => ctrl.abort()
  }, [siteId, pageUrl, dateRange.start, dateRange.end, deviceType])

  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="ページ統計を取得中"
        className="h-11 animate-pulse rounded-md border border-border bg-muted/60"
      />
    )
  }

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-md border border-amber-400/40 bg-amber-100/30 px-4 py-2 text-xs text-amber-900 dark:text-amber-200"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.08em]">stats</span>
        <span className="truncate">取得失敗: {state.message}</span>
      </div>
    )
  }

  const { data } = state
  const hasData = data.page_views > 0

  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-card px-4 py-2.5 text-sm"
      data-testid="page-stats-bar"
    >
      <div
        className="max-w-md truncate font-mono text-xs text-text-3"
        title={pageUrl}
        data-testid="page-stats-url"
      >
        {pageUrl}
      </div>

      {hasData ? (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-2">
            <Stat label="PV" value={data.page_views.toLocaleString()} />
            <Stat label="セッション" value={data.sessions.toLocaleString()} />
            {data.ctr !== null ? (
              <Stat label="CTR" value={`${(data.ctr * 100).toFixed(1)}%`} />
            ) : null}
            {data.scroll_path_rate !== null ? (
              <Stat label="到達率" value={`${(data.scroll_path_rate * 100).toFixed(1)}%`} />
            ) : null}
          </div>
          <EvidenceBadge
            evidence={{
              level: data.evidence_level === 'observed_exact' ? 'observed' : 'observed',
              confidence: data.evidence_level === 'observed_exact' ? 1 : 0.95,
              references: [],
            }}
            levelV2={data.evidence_level}
            compact
          />
        </>
      ) : (
        <span className="text-xs text-text-3">
          指定期間 ({dateRange.start} 〜 {dateRange.end}) の集計データはありません。
        </span>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-text-3">{label}</span>
      <strong className="font-semibold text-foreground">{value}</strong>
    </span>
  )
}
