/**
 * CvJourneyPage — CV経路分析 クライアントページ
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 *
 * 構成: フィルタ（期間 / デバイス / 流入）→ KPI strip → 固定列ファネル → ステップドロワー。
 * heatmap と同様に dataSource='dummy' のとき注意バナーを表示（実データ未接続の明示）。
 */

'use client'

import { useEffect, useMemo, useState } from 'react'

import { SegmentChip } from '@/components/ui/segment-chip'
import { KpiCard } from '@/components/dashboard/kpi-card'
import type { KpiCard as KpiCardData } from '@/lib/fixtures/dashboard'
import { useCvJourneyData } from '@/hooks/use-cv-journey-data'
import { FunnelFlow } from './funnel-flow'
import { StepDrawer } from './step-drawer'

interface CvJourneyPageProps {
  siteId: string
}

type DeviceFilter = 'all' | 'desktop' | 'mobile'
const RANGE_OPTIONS = [7, 14, 30] as const
const DEVICE_OPTIONS: ReadonlyArray<{ key: DeviceFilter; label: string }> = [
  { key: 'all', label: 'PC + SP' },
  { key: 'desktop', label: 'PC' },
  { key: 'mobile', label: 'SP' },
]

/** days 前〜今日 の YYYY-MM-DD レンジ */
function dateRange(days: number): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end)
  start.setDate(end.getDate() - (days - 1))
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
}

export function CvJourneyPage({ siteId }: CvJourneyPageProps) {
  const [rangeDays, setRangeDays] = useState<number>(7)
  const [device, setDevice] = useState<DeviceFilter>('all')
  const [source, setSource] = useState<string>('all')
  const [selectedStep, setSelectedStep] = useState<number | null>(null)

  const { start, end } = useMemo(() => dateRange(rangeDays), [rangeDays])

  const { data, meta, loading, error, stale } = useCvJourneyData({
    site_id: siteId,
    start_date: start,
    end_date: end,
    device_type: device === 'all' ? undefined : device,
    source,
  })

  // ESC でドロワーを閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedStep(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const kpis: KpiCardData[] = useMemo(() => {
    if (!data) return []
    const t = data.totals
    const bottleneck = t.biggestBottleneck
    return [
      {
        id: 'sessions',
        label: 'SESSIONS',
        value: t.totalSessions.toLocaleString('ja-JP'),
        evidence: { level: 'observed', confidence: 1, references: [] },
      },
      {
        id: 'cv',
        label: 'CV',
        value: t.cvSessions.toLocaleString('ja-JP'),
        unit: '件',
        evidence: { level: 'observed', confidence: 1, references: [] },
      },
      {
        id: 'cvr',
        label: 'CVR',
        value: String(t.cvrPct),
        unit: '%',
        evidence: { level: 'observed', confidence: 1, references: [] },
      },
      {
        id: 'bottleneck',
        label: '最大ボトルネック',
        value: bottleneck ? `step ${bottleneck.stepIndex + 1}` : '—',
        unit: bottleneck ? `${(bottleneck.dropRate * 100).toFixed(1)}% 離脱` : '',
        highlight: true,
        evidence: { level: 'observed', confidence: 1, references: [] },
      },
    ]
  }, [data])

  const selected = data && selectedStep != null ? data.steps[selectedStep] ?? null : null

  return (
    <div className="space-y-4">
      {/* dummy バナー */}
      {meta?.dataSource === 'dummy' ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300">
          ダミーデータを表示中です（ClickHouse 未接続）。実データ接続後に自動で実測値へ切り替わります。
        </div>
      ) : null}
      {meta?.warnings && meta.warnings.length > 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-2 text-xs text-text-2">
          {meta.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      ) : null}

      {/* フィルタ */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-3">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">range</span>
        {RANGE_OPTIONS.map((d) => (
          <SegmentChip key={d} active={rangeDays === d} onClick={() => setRangeDays(d)}>
            直近{d}日
          </SegmentChip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">device</span>
        {DEVICE_OPTIONS.map((o) => (
          <SegmentChip key={o.key} active={device === o.key} onClick={() => setDevice(o.key)}>
            {o.label}
          </SegmentChip>
        ))}
        {data && data.sources.length > 0 ? (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">source</span>
            <SegmentChip active={source === 'all'} onClick={() => setSource('all')}>
              全流入
            </SegmentChip>
            {data.sources.slice(0, 4).map((s) => (
              <SegmentChip key={s.key} active={source === s.key} onClick={() => setSource(s.key)}>
                {s.label}
              </SegmentChip>
            ))}
          </>
        ) : null}
        {(loading || stale) && <span className="ml-auto font-mono text-[10px] text-text-3">更新中…</span>}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          データ取得に失敗しました: {error}
        </div>
      ) : null}

      {/* KPI strip */}
      {kpis.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.id} kpi={kpi} />
          ))}
        </div>
      ) : null}

      {/* ファネル */}
      {data ? (
        <div className="rounded-md border border-border bg-background p-4">
          <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
            <h3 className="text-sm font-semibold">経路フロー</h3>
            <span className="font-mono text-[11px] text-text-3">{data.steps.length} steps · funnel</span>
          </div>
          <FunnelFlow data={data} selectedStep={selectedStep} onSelectStep={setSelectedStep} />
        </div>
      ) : loading ? (
        <div className="rounded-md border border-border bg-background p-8 text-center text-sm text-text-3">
          読み込み中…
        </div>
      ) : null}

      <StepDrawer
        step={selected}
        siteId={siteId}
        open={selectedStep != null}
        onClose={() => setSelectedStep(null)}
      />
    </div>
  )
}
