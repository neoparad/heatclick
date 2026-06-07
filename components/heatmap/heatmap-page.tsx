/**
 * HeatmapPage — P-04 のクライアントトップレベル
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild
 *
 * 構成 (mockup parity):
 *   1. 上段: PageSelector + EvidenceBadge
 *   2. SegmentChip 群: PC+SP / PC / SP, 直近 7/14/30 日 (集計フィルタ、page-level)
 *   3. PageStatsBar (URL + PV/sessions/CTR/滞留)
 *   4. HeatmapCanvas: mockup の `.hm-controls` + `.hm-main` (canvas + side) 全部を内包
 *   5. HotspotDetail (slide-in、legacy)
 *
 * 旧 deck.gl / nivo / three.js は本 dispatch で全廃。LayerToggle / HotspotRankingsPanel
 * / emotion-chip-skeleton も HeatmapCanvas 内に統合 (mockup parity)。
 *
 * `useHeatmapTiles` は本コンポーネントが own、HeatmapCanvas に props で渡す。
 */

'use client'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { ChevronDown } from 'lucide-react'

import { SegmentChip } from '@/components/ui/segment-chip'
import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import { useHeatmapTiles } from '@/hooks/use-heatmap-tiles'
import { pageStatsToLabels, usePageStats } from '@/hooks/use-page-stats'
import type { HeatmapLayer, HeatmapPoint, HeatmapTile } from '@/lib/api/heatmap'

import { HotspotDetail } from './hotspot-detail'

/** HeatmapCanvas を chunk 分離 (mockup overlays 群を含むため bundle 数十 KB) */
const HeatmapCanvas = dynamic(
  () => import('./heatmap-canvas').then((m) => ({ default: m.HeatmapCanvas })),
  { ssr: false, loading: () => <HeatmapCanvasFallback /> },
)

interface HeatmapPageProps {
  siteId: string
  initialPageUrl: string
  pageOptions: Array<{ url: string; label: string }>
}

type DeviceFilter = 'all' | 'desktop' | 'mobile'
type PeriodDays = 7 | 14 | 30

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function periodToRange(days: PeriodDays): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  return { start: isoDate(start), end: isoDate(end) }
}

export function HeatmapPage({ siteId, initialPageUrl, pageOptions }: HeatmapPageProps) {
  // activeLayer はデータ取得レイヤー (単一選択、ラジオ)。
  // 変更時に heatmapQuery が変わり useHeatmapTiles が再 fetch する。
  const [layer, setLayer] = useState<HeatmapLayer>('click')
  const [pageUrl, setPageUrl] = useState(initialPageUrl)
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>('all')
  const [periodDays, setPeriodDays] = useState<PeriodDays>(7)
  const [selected, setSelected] = useState<{ point: HeatmapPoint; tile: HeatmapTile } | null>(null)

  const dateRange = useMemo(() => periodToRange(periodDays), [periodDays])

  const heatmapQuery = useMemo(
    () => ({
      site_id: siteId,
      page_url: pageUrl,
      layer,
      device_type: deviceFilter === 'all' ? undefined : (deviceFilter as 'desktop' | 'mobile'),
      start_date: dateRange.start,
      end_date: dateRange.end,
      // 続 117 v2: tile_size = 1 tile がカバーする縦 y-px 窓 (800-6000, 既定 2400)。最大の 6000 に
      // して 1 tile で広い縦範囲を返してもらい、eager prefetch の round-trip 回数を最小化する
      // (screenshot underlay は normal flow 全高表示で sentinel が viewport に入らないため、
      //  tile を細切れにすると最初の数枚しか描画されなかった = bug #5)。
      tile_size: 6000,
    }),
    [siteId, pageUrl, layer, deviceFilter, dateRange.start, dateRange.end],
  )

  const { tiles, loading, hasMore, pageHeightEstimate, meta, error, loadMore } =
    useHeatmapTiles(heatmapQuery)

  // 段 2 PageStatsBar 撤去に伴い canvas-top に集約するため、page-stats は hook で持つ
  const pageStats = usePageStats({
    siteId,
    pageUrl,
    dateRange,
    deviceType: deviceFilter,
  })
  const statsLabels = pageStatsToLabels(pageStats)

  return (
    <div className="relative space-y-3">
      {/*
        段 1 (1.5 段化): PAGE select + DEVICE chips + PERIOD chips + Observed バッジ
        を 1 列に詰めて canvas 縦領域を拡大 (2026-05-29 dispatch Approach B)。
        段 2 (LAYER + EMOTION) は HeatmapCanvas 内 ControlsBar に残置 (chip 12 個
        詰めるとSP で窮屈なため)。
        mockup `.hm-controls` (`display:flex; gap:10px; flex-wrap:wrap;`) 踏襲。
      */}
      <div
        className="hm-controls flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-[var(--ug-border)] bg-white px-4 py-2.5"
        data-testid="heatmap-page-filter-bar"
      >
        <PageSelector value={pageUrl} options={pageOptions} onChange={setPageUrl} />

        <span className="hidden h-4 w-px bg-[var(--ug-border)] md:block" aria-hidden />

        <div role="radiogroup" aria-label="デバイス絞り込み" className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
            Device
          </span>
          <SegmentChip
            asRadio
            active={deviceFilter === 'all'}
            onClick={() => setDeviceFilter('all')}
            data-testid="segment-chip-device-all"
          >
            PC + SP
          </SegmentChip>
          <SegmentChip
            asRadio
            active={deviceFilter === 'desktop'}
            onClick={() => setDeviceFilter('desktop')}
            data-testid="segment-chip-device-desktop"
          >
            PC
          </SegmentChip>
          <SegmentChip
            asRadio
            active={deviceFilter === 'mobile'}
            onClick={() => setDeviceFilter('mobile')}
            data-testid="segment-chip-device-mobile"
          >
            SP
          </SegmentChip>
        </div>

        <span className="hidden h-4 w-px bg-[var(--ug-border)] md:block" aria-hidden />

        <div role="radiogroup" aria-label="期間絞り込み" className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
            Period
          </span>
          <SegmentChip
            asRadio
            active={periodDays === 7}
            onClick={() => setPeriodDays(7)}
            data-testid="segment-chip-period-7"
          >
            直近 7 日
          </SegmentChip>
          <SegmentChip
            asRadio
            active={periodDays === 14}
            onClick={() => setPeriodDays(14)}
            data-testid="segment-chip-period-14"
          >
            直近 14 日
          </SegmentChip>
          <SegmentChip
            asRadio
            active={periodDays === 30}
            onClick={() => setPeriodDays(30)}
            data-testid="segment-chip-period-30"
          >
            直近 30 日
          </SegmentChip>
        </div>

        <div className="ml-auto">
          <EvidenceBadge
            evidence={{
              level: 'observed',
              confidence: 1,
              references: [],
            }}
            compact
          />
        </div>
      </div>

      {/*
        2026-05-29 (続 115) Phase 2 / B 改修:
          旧段 2 `PageStatsBar` (URL + PV/sessions/CTR/到達率) を撤去。
          canvas-top (HeatmapToolbar) の URL bar + stat 領域に値を集約表示する。
          fetch 仕様は不変 (usePageStats hook で抽出)。
      */}

      {/* 3. HeatmapCanvas (内部 ControlsBar に LAYER + EMOTION = 段 2、その下に canvas + side) */}
      <HeatmapCanvas
        layer={layer}
        onLayerChange={setLayer}
        siteId={siteId}
        pageUrl={pageUrl}
        tiles={tiles}
        loading={loading}
        hasMore={hasMore}
        pageHeightEstimate={pageHeightEstimate}
        meta={meta}
        error={error}
        loadMore={loadMore}
        pvLabel={statsLabels.pvLabel}
        ctrLabel={statsLabels.ctrLabel}
        scrollLabel={statsLabels.scrollLabel}
        onHotspotSelect={(point, tile) => setSelected({ point, tile })}
      />

      {/* 4. HotspotDetail (slide-in) */}
      <HotspotDetail
        point={selected?.point ?? null}
        tile={selected?.tile ?? null}
        pageUrl={pageUrl}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

function HeatmapCanvasFallback() {
  return (
    <div
      className="flex h-[600px] w-full items-center justify-center rounded-md border border-[var(--ug-border)] bg-white text-xs text-[var(--ug-text-3)]"
      role="status"
      aria-live="polite"
      data-testid="heatmap-canvas-fallback"
    >
      ヒートマップを準備中…
    </div>
  )
}

function PageSelector({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ url: string; label: string }>
  onChange: (next: string) => void
}) {
  return (
    <label className="relative inline-flex items-center gap-2 text-xs text-[var(--ug-text-2)]">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        Page
      </span>
      <span className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none rounded-md border border-[var(--ug-border)] bg-white px-3 py-1.5 pr-8 text-xs text-[var(--ug-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ug-brand-1)]"
          aria-label="ヒートマップ表示対象ページ"
        >
          {options.map((opt) => (
            <option key={opt.url} value={opt.url}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ug-text-3)]"
          aria-hidden
        />
      </span>
    </label>
  )
}
