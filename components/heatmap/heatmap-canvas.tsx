/**
 * HeatmapCanvas — mockup parity 完全再実装
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild
 *
 * 旧 deck.gl / nivo / three.js を全廃し、mockup の HTML/CSS を React 化した
 * compositional architecture に置換:
 *   - 720px 固定幅の MockProductPageUnderlay
 *   - HeatOverlay (heat-blob / heat-tag / att-mode / end-bands / exit-overlay)
 *   - SignalOverlay (6 markers)
 *   - HeatmapToolbar (canvas top: device + URL + stats + action btns)
 *   - HeatmapSidePanel (4 tab: hotspots / signals / summary / sessions)
 *   - FullscreenToolbar (全画面時)
 *
 * 維持事項 (本 dispatch §7 制約):
 *   - HeatmapCanvasProps の shape (HeatmapPage との契約、`layer` は legacy 初期値)
 *   - tile fetch / IntersectionObserver は HeatmapPage 側、本コンポーネントは
 *     view-model 化された tile を表示するだけ。
 *   - HeatmapAccessibleTable (a11y) を維持
 *   - 既存 testid: `heatmap-canvas` / `heatmap-load-more-sentinel`
 *     / `heatmap-dummy-banner` / `data-data-source`
 *   - 新 testid: mockup-spec.ts で定義 / 各 sub-component が付与
 *
 * §1.7 Anti-Features 厳守: セッション録画禁止、A/B execution は VWO 委譲、
 * signal は集約イベントのみ (本文 / DOM スナップは生成しない)。
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { HeatmapLayer, HeatmapPoint, HeatmapTile, HeatmapTileMeta } from '@/lib/api/heatmap'
import { buildHeatmapViewModel } from '@/lib/heatmap/view-model'
import {
  DEVICES,
  EMOTIONS,
  LAYERS,
  MOCK_PAGE_HEIGHT,
  PAGE_WIDTH,
} from '@/lib/heatmap/mockup-spec'
import type {
  DeviceKind,
  EmotionKey,
  LayerKey,
  SideTab,
  SignalKey,
} from '@/lib/heatmap/types'

import { FullscreenToolbar } from './fullscreen-toolbar'
import { HeatOverlay } from './heat-overlay'
import { HeatmapAccessibleTable } from './heatmap-accessible-table'
import { HeatmapSidePanel } from './heatmap-side-panel'
import { HeatmapToolbar } from './heatmap-toolbar'
import { MockProductPageUnderlay } from './mock-product-page-underlay'
import { SignalOverlay } from './signal-overlay'

export interface HeatmapCanvasProps {
  /** legacy: HeatmapPage が選んだ初期 layer。複数 layer 同時 ON に拡張済 */
  layer: HeatmapLayer
  pageUrl: string
  tiles: HeatmapTile[]
  loading: boolean
  hasMore: boolean
  pageHeightEstimate: number
  error: string | null
  meta: HeatmapTileMeta | null
  loadMore: () => void
  onHotspotSelect?: (point: HeatmapPoint, tile: HeatmapTile) => void
}

const SENTINEL_LEAD = 600
const INITIAL_SENTINEL_TOP = 1800

/** legacy HeatmapLayer → mockup LayerKey 変換 */
function mapLegacyLayer(l: HeatmapLayer): LayerKey {
  if (l === 'click') return 'click'
  if (l === 'move') return 'move'
  if (l === 'emotion') return 'emo'
  return 'exit' // friction → exit (mockup に friction が無いため最も近い意味の exit に)
}

function initialActiveLayers(initial: HeatmapLayer): Set<LayerKey> {
  // mockup default: click + emo。HeatmapPage の指定 layer も加える。
  return new Set<LayerKey>(['click', 'emo', mapLegacyLayer(initial)])
}

function initialActiveEmotions(): Set<EmotionKey> {
  return new Set(EMOTIONS.filter((e) => e.defaultActive).map((e) => e.key))
}

export function HeatmapCanvas({
  layer,
  pageUrl,
  tiles,
  loading,
  hasMore,
  pageHeightEstimate: _pageHeightEstimate,
  error,
  meta,
  loadMore,
  onHotspotSelect,
}: HeatmapCanvasProps) {
  // pageHeightEstimate は legacy 契約。mockup parity rebuild では 720px 固定 underlay
  // のため canvas 高さ計算には使わない。Phase 2 (実 screenshot underlay) で復活予定。
  void _pageHeightEstimate
  const [activeLayers, setActiveLayers] = useState<Set<LayerKey>>(() => initialActiveLayers(layer))
  const [activeEmotions, setActiveEmotions] = useState<Set<EmotionKey>>(() =>
    initialActiveEmotions(),
  )
  const [activeSignals, setActiveSignals] = useState<Set<SignalKey>>(
    () => new Set<SignalKey>(['rage', 'dead', 'hover', 'copy', 'backscroll', 'hesitation']),
  )
  const [sideTab, setSideTab] = useState<SideTab>('hotspots')
  const [controlsVisible, setControlsVisible] = useState(true)
  const [sideVisible, setSideVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [device, setDevice] = useState<DeviceKind>('pc')
  const [highlightedTagId, setHighlightedTagId] = useState<string | null>(null)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const tagRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())

  // tiles + meta → view model
  const vm = useMemo(
    () => buildHeatmapViewModel({ tiles, meta }),
    [tiles, meta],
  )

  // signal overlay は signals tab を開くと自動 ON (mockup 同等)
  const signalsOn = sideTab === 'signals'

  // load-more sentinel
  const sentinelTop = tiles.length
    ? Math.max(0, tiles[tiles.length - 1].y_end - SENTINEL_LEAD)
    : INITIAL_SENTINEL_TOP

  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) loadMore()
      },
      { rootMargin: '200px 0px', threshold: 0 },
    )
    io.observe(sentinelRef.current)
    return () => io.disconnect()
  }, [hasMore, loadMore])

  // fullscreen: body スクロール抑止 + ESC で退出
  useEffect(() => {
    if (!fullscreen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [fullscreen])

  // layer toggle (mockup: 複数選択可)
  const toggleLayer = useCallback((k: LayerKey) => {
    setActiveLayers((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  const toggleEmotion = useCallback((k: EmotionKey) => {
    setActiveEmotions((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  const toggleSignal = useCallback((k: SignalKey) => {
    setActiveSignals((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  const isDummySource =
    meta?.data_source === 'dummy_lcg' || (meta != null && meta.data_source === undefined)

  // hotspot card クリック: 該当 tag を highlight + scroll、real data の場合のみ
  // legacy slide-in detail を起動 (fixture 時は detail 不一致を避けるため抑止 — Codex review MEDIUM)。
  const onSelectHotspot = useCallback(
    (cardId: string) => {
      const m = /hs-(\d+)/.exec(cardId)
      const rank = m ? Number(m[1]) : null
      const tag = rank != null ? vm.tags.find((t) => t.rank === rank) : null
      if (!tag) return
      setHighlightedTagId(tag.id)
      tagRefs.current.get(tag.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => setHighlightedTagId(null), 1200)

      if (!onHotspotSelect || isDummySource || rank == null) return
      // 実 data 起点: 該当 rank に対応する real cluster の代表 point を探す。
      // count 降順で rank-1 番目の point を選ぶ近似。
      const flat = tiles
        .flatMap((tile) => tile.points.map((p) => ({ tile, point: p })))
        .sort((a, b) => b.point.count - a.point.count)
      const target = flat[Math.max(0, rank - 1)] ?? flat[0]
      if (target) onHotspotSelect(target.point, target.tile)
    },
    [vm.tags, onHotspotSelect, tiles, isDummySource],
  )

  // .hm-page の幅 (fullscreen 時に device で切替)
  const pageMaxWidth = fullscreen
    ? (DEVICES.find((d) => d.key === device)?.fsMaxWidth ?? PAGE_WIDTH)
    : PAGE_WIDTH

  // 全画面時はビューポート全体を fixed で覆う
  const rootStyle: React.CSSProperties = fullscreen
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'linear-gradient(180deg, #1a1c20 0%, #0f1114 100%)',
      }
    : {}

  return (
    <div
      data-testid="heatmap-canvas"
      data-data-source={meta?.data_source ?? 'unknown'}
      data-fullscreen={fullscreen ? '1' : '0'}
      data-fs-device={fullscreen ? device : undefined}
      className={fullscreen ? 'overflow-hidden' : 'space-y-3'}
      style={rootStyle}
      role="region"
      aria-label={`${pageUrl} のヒートマップ`}
    >
      {/* ===== Controls bar (.hm-controls): layer toggles + emotion chips ===== */}
      {controlsVisible && !fullscreen ? (
        <ControlsBar
          activeLayers={activeLayers}
          onToggleLayer={toggleLayer}
          activeEmotions={activeEmotions}
          onToggleEmotion={toggleEmotion}
        />
      ) : null}

      {/* ===== Main (.hm-main): canvas-wrap + side ===== */}
      <div
        className={
          fullscreen
            ? 'flex h-full'
            : 'flex gap-3.5'
        }
      >
        <div
          className={
            'flex min-w-0 flex-1 flex-col overflow-hidden ' +
            (fullscreen
              ? ''
              : 'rounded-md border border-[var(--ug-border)] bg-white shadow-sm')
          }
        >
          <HeatmapToolbar
            device={device}
            onDeviceChange={setDevice}
            pageUrl={pageUrl}
            pvLabel="6,210"
            ctrLabel="26.5%"
            dwellLabel="2m 18s"
            controlsVisible={controlsVisible}
            onToggleControls={() => setControlsVisible((v) => !v)}
            sideVisible={sideVisible}
            onToggleSide={() => setSideVisible((v) => !v)}
            onEnterFullscreen={() => setFullscreen(true)}
          />

          <div
            data-testid="hm-canvas-scroll"
            className="hm-canvas relative flex-1 overflow-y-auto p-5"
            style={{
              background: fullscreen
                ? 'linear-gradient(180deg, #1a1c20 0%, #0f1114 100%)'
                : 'linear-gradient(180deg, #f7f8fb 0%, #f0f2f6 100%)',
              minHeight: fullscreen ? '100vh' : 540,
            }}
          >
            {isDummySource ? (
              <div
                data-testid="heatmap-dummy-banner"
                className="sticky top-0 z-10 mx-auto mb-3 w-fit rounded-full border border-amber-400/40 bg-amber-100/95 px-3 py-1 font-mono text-[11px] text-amber-900 shadow-sm"
              >
                dummy data fallback — 実 tracking が届き始めると自動撤去されます
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="mx-auto mb-3 w-fit rounded-md bg-red-600/90 px-3 py-1.5 text-xs text-white"
              >
                {error}
              </div>
            ) : null}

            {loading && tiles.length === 0 ? (
              <div
                role="status"
                aria-live="polite"
                className="mx-auto w-fit rounded-md border border-[var(--ug-border)] bg-white px-4 py-2 text-xs text-[var(--ug-text-2)] shadow-sm"
              >
                ヒートマップ tile を取得中…
              </div>
            ) : null}

            <div
              data-testid="hm-page"
              className="hm-page relative mx-auto overflow-hidden rounded-md border border-[#e3e6ec] bg-white shadow-[0_8px_32px_rgba(15,17,23,.06)]"
              style={{
                maxWidth: pageMaxWidth,
                width: '100%',
                minHeight: MOCK_PAGE_HEIGHT,
              }}
            >
              <MockProductPageUnderlay />
              <HeatOverlay
                vm={vm}
                layers={activeLayers}
                activeEmotions={activeEmotions}
                highlightedTagId={highlightedTagId}
                tagRefs={tagRefs}
              />
              <SignalOverlay
                signals={vm.signals}
                signalsOn={signalsOn}
                enabledSignals={activeSignals}
              />
            </div>

            <div
              ref={sentinelRef}
              data-testid="heatmap-load-more-sentinel"
              aria-hidden
              style={{
                position: 'relative',
                marginTop: Math.max(0, sentinelTop - MOCK_PAGE_HEIGHT),
                height: 1,
                width: '100%',
              }}
            />
          </div>
        </div>

        {sideVisible && !fullscreen ? (
          <HeatmapSidePanel
            activeTab={sideTab}
            onTabChange={setSideTab}
            emotionSummary={vm.emotionSummary}
            hotspotCards={vm.hotspotCards}
            signalCards={vm.signalCards}
            enabledSignals={activeSignals}
            onToggleSignal={toggleSignal}
            onSelectHotspot={onSelectHotspot}
          />
        ) : null}
      </div>

      <FullscreenToolbar
        visible={fullscreen}
        layers={activeLayers}
        onToggleLayer={toggleLayer}
        device={device}
        onDeviceChange={setDevice}
        onExit={() => setFullscreen(false)}
      />

      <HeatmapAccessibleTable
        viewModel={vm}
        tiles={tiles}
        layer={layer}
        pageUrl={pageUrl}
      />
    </div>
  )
}

function ControlsBar({
  activeLayers,
  onToggleLayer,
  activeEmotions,
  onToggleEmotion,
}: {
  activeLayers: ReadonlySet<LayerKey>
  onToggleLayer: (k: LayerKey) => void
  activeEmotions: ReadonlySet<EmotionKey>
  onToggleEmotion: (k: EmotionKey) => void
}) {
  const emoLayerOn = activeLayers.has('emo')
  return (
    <div
      data-testid="heatmap-controls-bar"
      className="flex flex-wrap items-center gap-2.5 rounded-md border border-[var(--ug-border)] bg-white p-3 shadow-sm"
    >
      <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        layer
      </span>
      <div
        role="group"
        aria-label="ヒートマップ レイヤー"
        className="inline-flex overflow-hidden rounded-md border border-[var(--ug-border)] bg-white"
      >
        {LAYERS.map((l) => {
          const active = activeLayers.has(l.key)
          return (
            <button
              key={l.key}
              type="button"
              data-testid={`layer-toggle-${l.key}`}
              aria-pressed={active}
              onClick={() => onToggleLayer(l.key)}
              className={
                'inline-flex items-center border-r border-[var(--ug-border)] px-3 py-1.5 text-[12px] transition last:border-r-0 ' +
                (active
                  ? 'bg-[var(--ug-accent-bg,rgba(79,107,255,.09))] font-semibold text-[var(--ug-brand-1)]'
                  : 'text-[var(--ug-text-2)] hover:bg-[var(--ug-bg-subtle)] hover:text-[var(--ug-text-1)]')
              }
            >
              {l.label}
            </button>
          )
        })}
      </div>

      <span className="mx-1 h-4 w-px bg-[var(--ug-border)]" aria-hidden />

      <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        emotion
      </span>
      <div
        role="group"
        aria-label="感情フィルタ"
        data-testid="emotion-chip-group"
        className={'inline-flex flex-wrap items-center gap-1 ' + (emoLayerOn ? '' : 'opacity-60')}
      >
        {EMOTIONS.map((e) => {
          const active = activeEmotions.has(e.key)
          return (
            <button
              key={e.key}
              type="button"
              data-testid={`emo-chip-${e.key}`}
              aria-pressed={active}
              onClick={() => onToggleEmotion(e.key)}
              disabled={!emoLayerOn}
              className={
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[11px] font-medium transition ' +
                (active
                  ? 'border-[var(--ug-border-strong)] bg-[var(--ug-bg-2,#f4f5f7)] text-[var(--ug-text)]'
                  : 'border-[var(--ug-border)] bg-white text-[var(--ug-text-2)] opacity-60 hover:opacity-90')
              }
            >
              <i
                aria-hidden
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: e.color }}
              />
              {e.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
