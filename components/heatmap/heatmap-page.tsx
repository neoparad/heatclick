/**
 * HeatmapPage — P-04 のクライアントトップレベル
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild
 *
 * 構成 (mockup parity):
 *   1. 上段: PageSelector + EvidenceBadge
 *   2. SegmentChip 群: PC+SP / PC / SP, 直近 7/14/30 日 (集計フィルタ、page-level)
 *   3. (旧 PageStatsBar は続116で撤去 → PV/CTR/到達率/滞留 は HeatmapCanvas の canvas-top に集約)
 *   4. HeatmapCanvas: mockup の `.hm-controls` + `.hm-main` (canvas + side) 全部を内包
 *   5. HotspotDetail (slide-in、legacy)
 *
 * 旧 deck.gl / nivo / three.js は本 dispatch で全廃。LayerToggle / HotspotRankingsPanel
 * / emotion-chip-skeleton も HeatmapCanvas 内に統合 (mockup parity)。
 *
 * `useHeatmapTiles` は本コンポーネントが own、HeatmapCanvas に props で渡す。
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { SegmentChip } from '@/components/ui/segment-chip'
import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import { useHeatmapElements } from '@/hooks/use-heatmap-elements'
import { useHeatmapTiles } from '@/hooks/use-heatmap-tiles'
import { pageStatsToLabels, usePageStats } from '@/hooks/use-page-stats'
import {
  SEGMENT_LABELS,
  type HeatmapLayer,
  type HeatmapPoint,
  type HeatmapSegment,
  type HeatmapTile,
} from '@/lib/api/heatmap'

// 直接 import (旧: dynamic({ssr:false}))。本コンポーネントは route 側で既に ssr:false の
// 配下にあり、二重 dynamic は client チャンクの待ちを増やすだけで利点が無いため統合。
import type { PageOption } from '@/lib/pages/fetch-pages'

import { HeatmapCanvas } from './heatmap-canvas'
import { HotspotDetail } from './hotspot-detail'

interface HeatmapPageProps {
  siteId: string
  initialPageUrl: string
  pageOptions: PageOption[]
}

type PeriodDays = 7 | 14 | 30

/**
 * 続124: デバイス座標系の統一。
 * PC のページと SP のページは縦の長さ・レイアウトが別物 (座標系が別)。混ぜて 1 枚の
 * screenshot に重ねると「途中で切れる / ズレる / 空白」になる (Owner 報告 ①④⑦)。
 * 業界標準 (Hotjar 等) と同じく **デバイス別ヒートマップ** とし、canvas の PC/SP/TAB
 * タブが screenshot と行動データの両方を同時に切替える。
 */
export type CanvasDevice = 'pc' | 'sp' | 'tab'

function deviceToEventFilter(d: CanvasDevice): 'desktop' | 'mobile' | 'tablet' {
  return d === 'pc' ? 'desktop' : d === 'sp' ? 'mobile' : 'tablet'
}

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
  // 続135: 初期デバイスは「そのページで最もイベントが多いデバイス」。
  //   旧 'pc' 固定は、モバイル主体サイトで device_type='desktop' 絞りにモバイルの
  //   クリックが当たらず「クリックデータなし」誤表示になっていた (Owner 報告 ④⑧)。
  const topDeviceForUrl = useCallback(
    (u: string): CanvasDevice => pageOptions.find((p) => p.url === u)?.topDevice ?? 'sp',
    [pageOptions],
  )
  // 続124: device は canvas の PC/SP/TAB タブと同一 state (screenshot + データ両方を切替)
  const [device, setDevice] = useState<CanvasDevice>(() => topDeviceForUrl(initialPageUrl))
  // ページ切替時はそのページの最多デバイスへ自動追従 (手動タブ変更はページ切替まで保持)。
  //   初回 mount では init 値と同一なので skip (不要な再 fetch を避ける)。
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    setDevice(topDeviceForUrl(pageUrl))
  }, [pageUrl, topDeviceForUrl])
  const [periodDays, setPeriodDays] = useState<PeriodDays>(7)
  // 続125 (Owner ①): 行動セグメント — 観測ベースのクラスタ分け (熟読層/浅読層/広告流入)
  const [segment, setSegment] = useState<HeatmapSegment>('all')
  const [selected, setSelected] = useState<{ point: HeatmapPoint; tile: HeatmapTile } | null>(null)

  const dateRange = useMemo(() => periodToRange(periodDays), [periodDays])
  const deviceFilter = deviceToEventFilter(device)

  const heatmapQuery = useMemo(
    () => ({
      site_id: siteId,
      page_url: pageUrl,
      layer,
      device_type: deviceFilter,
      segment,
      start_date: dateRange.start,
      end_date: dateRange.end,
      // 続 117 v2: tile_size = 1 tile がカバーする縦 y-px 窓 (800-6000, 既定 2400)。最大の 6000 に
      // して 1 tile で広い縦範囲を返してもらい、eager prefetch の round-trip 回数を最小化する
      // (screenshot underlay は normal flow 全高表示で sentinel が viewport に入らないため、
      //  tile を細切れにすると最初の数枚しか描画されなかった = bug #5)。
      tile_size: 6000,
    }),
    [siteId, pageUrl, layer, deviceFilter, segment, dateRange.start, dateRange.end],
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

  // 続123: 要素単位クリック集計 + rage/dead シグナル (本物のホットスポットカード用)。
  // tiles と独立 fetch。失敗時 null = cluster fallback で描画継続 (非致命)。
  const { elements } = useHeatmapElements({
    siteId,
    pageUrl,
    dateRange,
    deviceType: deviceFilter,
    segment,
  })

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

        {/* 続124: Device chips は撤去。デバイスは canvas の PC/SP/TAB タブに一本化
            (screenshot とデータの座標系を常に一致させるため。混在表示は座標が合わず
            「切れる/ズレる/空白」の原因だった = Owner 報告 ①④⑦)。 */}

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

        <span className="hidden h-4 w-px bg-[var(--ug-border)] md:block" aria-hidden />

        {/* 続125/132 (Owner ①): 行動セグメント — 観測データから直接導出するクラスタ分け。
            リピーター = visitor 初回来訪<当該session / 新規 = 初回来訪=当該session /
            熟読層 = max scroll>=70% / 浅読・直帰層 = <=20% / 広告流入 = gclid・fbclid。
            ML ペルソナ (persona_sessions) が ClickHouse に配管されたら同じ列に追加する。 */}
        <div
          role="radiogroup"
          aria-label="行動セグメント"
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
            Segment
          </span>
          {SEGMENT_LABELS.map((s) => (
            <SegmentChip
              key={s.key}
              asRadio
              active={segment === s.key}
              onClick={() => setSegment(s.key)}
              data-testid={`segment-chip-segment-${s.key}`}
            >
              {s.label}
            </SegmentChip>
          ))}
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
        elements={elements}
        device={device}
        onDeviceChange={setDevice}
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
