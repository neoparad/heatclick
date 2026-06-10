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
import type { HeatmapElementsData } from '@/lib/api/heatmap-elements'
import { fetchHeatmapUnderlay } from '@/lib/api/heatmap-screenshot'
import { isRealEmptyHeatmap } from '@/lib/heatmap/display-state'
import { computeDisplayScale, computePageCssHeight } from '@/lib/heatmap/stage-layout'
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
  HeatmapCoordinateContext,
  HeatmapDevice,
  HeatmapUnderlayCapture,
  LayerKey,
  SideTab,
  SignalKey,
} from '@/lib/heatmap/types'

import { FullscreenToolbar } from './fullscreen-toolbar'
import { HeatOverlay } from './heat-overlay'
import { HeatmapAccessibleTable } from './heatmap-accessible-table'
import { HeatmapLegend } from './heatmap-legend'
import { HeatmapSidePanel } from './heatmap-side-panel'
import { HeatmapToolbar } from './heatmap-toolbar'
import { MockProductPageUnderlay } from './mock-product-page-underlay'
import { RealPageScreenshotUnderlay } from './real-page-screenshot-underlay'
import { SignalOverlay } from './signal-overlay'

export interface HeatmapCanvasProps {
  /**
   * 現在アクティブなデータ取得レイヤー (HeatmapPage が own、onLayerChange で更新)。
   * ControlsBar は単一選択ラジオ — 変更時に heatmap_type が変わり再 fetch が走る。
   */
  layer: HeatmapLayer
  /**
   * ユーザーがレイヤーを切替えたときのコールバック (HeatmapPage の setState)。
   * 未指定 (legacy 呼び出し) は no-op。
   */
  onLayerChange?: (next: HeatmapLayer) => void
  siteId: string
  pageUrl: string
  tiles: HeatmapTile[]
  loading: boolean
  hasMore: boolean
  pageHeightEstimate: number
  error: string | null
  meta: HeatmapTileMeta | null
  loadMore: () => void
  onHotspotSelect?: (point: HeatmapPoint, tile: HeatmapTile) => void
  /**
   * Phase 2 (B 改修): heatmap-toolbar (canvas-top) に集約表示する page-stats。
   * heatmap-page 側 `usePageStats` の取得結果を string label 化して渡す。
   */
  pvLabel?: string
  ctrLabel?: string
  dwellLabel?: string
  scrollLabel?: string
  /**
   * 続123: `/api/heatmap/elements` の要素単位集計 (heatmap-page の useHeatmapElements が own)。
   * 提供時、hotspot card / tag が本物の要素名 + selector になり、rage/dead シグナルが実データ化。
   * null でも cluster fallback で描画は継続する (非致命の強化データ)。
   */
  elements?: HeatmapElementsData | null
  /**
   * 続124: デバイスタブ (PC/SP/TAB) の controlled prop。親が screenshot とデータの
   * 両方を同じデバイスに揃えるために own する。未指定なら内部 state (legacy 互換)。
   */
  device?: DeviceKind
  onDeviceChange?: (d: DeviceKind) => void
}

/** view-model に渡す sourceWidth: ClickHouse 正規化済 click_x の最大幅 */
const SOURCE_WIDTH = 1280

/** HeatmapLayer (API / data) → LayerKey (UI / overlay) 変換 */
function heatmapLayerToKey(l: HeatmapLayer): LayerKey {
  switch (l) {
    case 'click': return 'click'
    case 'read': return 'attention'
    case 'scroll': return 'scroll'
    case 'exit': return 'exit'
    case 'move': return 'move'
    case 'emotion': return 'emo'
    case 'friction': return 'exit'
  }
}

/** LayerKey (UI) → HeatmapLayer (data / API) 逆変換。data layer 以外は null。 */
function layerKeyToHeatmapLayer(k: LayerKey): HeatmapLayer | null {
  switch (k) {
    case 'click': return 'click'
    case 'attention': return 'read'
    case 'scroll': return 'scroll'
    case 'exit': return 'exit'
    // end / move / emo はデータ取得変換なし (move/emo は disabled)
    default: return null
  }
}

function initialActiveLayers(initial: HeatmapLayer): Set<LayerKey> {
  // アクティブ layer は initial の data layer のみ (mockup multi-select 廃止)。
  return new Set<LayerKey>([heatmapLayerToKey(initial)])
}

function initialActiveEmotions(): Set<EmotionKey> {
  return new Set(EMOTIONS.filter((e) => e.defaultActive).map((e) => e.key))
}

/**
 * capture.capturedAt (ISO 文字列) を ja-JP の読みやすい日時に整形する。
 * 不正値 / 空のときは生文字列をそのまま返す (UI を壊さない安全側)。
 */
function formatCapturedAt(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function HeatmapCanvas({
  layer,
  onLayerChange,
  siteId,
  pageUrl,
  tiles,
  loading,
  hasMore,
  pageHeightEstimate: _pageHeightEstimate,
  error,
  meta,
  loadMore,
  onHotspotSelect,
  pvLabel,
  ctrLabel,
  dwellLabel,
  scrollLabel,
  elements,
  device: deviceProp,
  onDeviceChange,
}: HeatmapCanvasProps) {
  // pageHeightEstimate は legacy 契約。mockup parity rebuild では 720px 固定 underlay
  // のため canvas 高さ計算には使わない。Phase 2 (実 screenshot underlay) で復活予定。
  void _pageHeightEstimate
  const [activeLayers, setActiveLayers] = useState<Set<LayerKey>>(() => initialActiveLayers(layer))

  // layer prop が外部 (HeatmapPage) から変わったときに activeLayers を同期する。
  // (HeatmapPage が setLayer した場合: e.g. 初回 URL 切替 / 将来の URL param 復元)
  useEffect(() => {
    setActiveLayers(new Set<LayerKey>([heatmapLayerToKey(layer)]))
  }, [layer])

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
  // 続124: device は親 (HeatmapPage) が own できる controlled prop (screenshot + データを
  // 同時切替するため)。未指定 (legacy 呼出 / test) は内部 state fallback。
  const [internalDevice, setInternalDevice] = useState<DeviceKind>('pc')
  const device = deviceProp ?? internalDevice
  const setDevice = onDeviceChange ?? setInternalDevice
  const [highlightedTagId, setHighlightedTagId] = useState<string | null>(null)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const tagRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())
  // 続 116 Codex T2 HIGH fix: outer hm-page の実 rendered width を測定して stage scale 計算に使う。
  //   width: '100%' + maxWidth で narrow container 内では outer が pageMaxWidth 未満になるため、
  //   pageMaxWidth ベースの scale だと右側 clip される。実 px で scale 再計算する。
  const hmPageRef = useRef<HTMLDivElement>(null)

  // ── Phase 2: screenshot underlay state ─────────────────────────────────
  // device は HeatmapToolbar の選択 (pc/sp/tab)。view-model 上の HeatmapDevice と一致するため
  // そのまま渡せる (DeviceKind = HeatmapDevice)。
  const screenshotDevice: HeatmapDevice = device
  type CaptureState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; capture: HeatmapUnderlayCapture }
    | { kind: 'error'; code: string; message: string }

  const [captureState, setCaptureState] = useState<CaptureState>({ kind: 'idle' })

  // .hm-page の幅 (mockup SSOT 720px、fullscreen 時のみ device で切替)
  const pageMaxWidth = fullscreen
    ? (DEVICES.find((d) => d.key === device)?.fsMaxWidth ?? PAGE_WIDTH)
    : PAGE_WIDTH

  // ── 続 117 v2: capture geometry (transform stage 廃止、native img + displayScale) ──
  //   cap が取れたら capture CSS px 空間で座標計算し、displayScale で実 px に縮小する。
  const cap = captureState.kind === 'ready' ? captureState.capture : null
  const ready = cap != null
  // referenceWidth = capture の CSS px 基準幅 (= viewportWidth、DPR 非依存)。fallback は mockup 720。
  const referenceWidth = cap ? cap.viewportWidth : PAGE_WIDTH
  // pageCssHeight = DPR 除去後の screenshot CSS px 全高 (click_y と同じ document 絶対 CSS px 空間)。
  const pageCssHeight = cap
    ? computePageCssHeight(cap.naturalWidth, cap.naturalHeight, referenceWidth) || MOCK_PAGE_HEIGHT
    : MOCK_PAGE_HEIGHT
  // outer .hm-page の最大幅: ready 時は referenceWidth で頭打ち (wide screenshot を column 幅に収め、
  //   sp は native 390 に収める、それ以上 upscale しない)。fallback は mockup pageMaxWidth。
  const displayMaxWidth = cap ? Math.min(pageMaxWidth, referenceWidth) : pageMaxWidth

  // outer hm-page の実 rendered width (CSS で shrink された場合の実 px)。
  // 初期値は displayMaxWidth (ResizeObserver fire 前の暫定)、ResizeObserver で実 px に追従。
  const [actualOuterWidth, setActualOuterWidth] = useState<number>(displayMaxWidth)
  useEffect(() => {
    // displayMaxWidth (fullscreen / device / capture) 変更時は実測値を一旦リセットして暫定値に
    setActualOuterWidth(displayMaxWidth)
  }, [displayMaxWidth])
  useEffect(() => {
    const el = hmPageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width)
        if (w > 0) setActualOuterWidth(w)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
    // capture 切替 / displayMaxWidth 変更時に outer DOM が変わるため再 observe
  }, [ready, displayMaxWidth])

  // displayScale = <img width:100%> の実縮小率。overlay 各要素に掛けて画像と座標一致。
  //   ready でない (mock fallback) 時は 1 (mockup 720/860 空間そのまま)。
  const displayScale = cap ? computeDisplayScale(actualOuterWidth, referenceWidth) : 1

  // 続124 ⑥: 他デバイス screenshot の先読み済み key (siteId|pageUrl|device)。重複発火防止。
  const prefetchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!pageUrl || !siteId) return
    const ctrl = new AbortController()
    setCaptureState({ kind: 'loading' })
    fetchHeatmapUnderlay({
      siteId,
      pageUrl,
      device: screenshotDevice,
      signal: ctrl.signal,
    })
      .then((res) => {
        if (ctrl.signal.aborted) return
        if (res.success) {
          setCaptureState({ kind: 'ready', capture: res.data })
          // 続124 ⑥ (Owner: 「タブを合わせてから取得は遅い、裏で先に」): 現在デバイスの
          // capture が確定したら、残り 2 デバイスをバックグラウンドで先読みして server 側
          // R2 cache を温める。タブ切替時は warm hit で即表示になる。失敗は無視 (非致命)。
          const others = (['pc', 'sp', 'tab'] as const).filter((d) => d !== screenshotDevice)
          others.forEach((d, i) => {
            const key = `${siteId}|${pageUrl}|${d}`
            if (prefetchedRef.current.has(key)) return
            prefetchedRef.current.add(key)
            setTimeout(
              () => {
                fetchHeatmapUnderlay({ siteId, pageUrl, device: d }).catch(() => {})
              },
              4000 * (i + 1),
            )
          })
        } else {
          setCaptureState({
            kind: 'error',
            code: res.error.code,
            message: res.error.message,
          })
        }
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        const msg = err instanceof Error ? err.message : 'screenshot fetch failed'
        setCaptureState({ kind: 'error', code: 'NETWORK', message: msg })
      })
    return () => ctrl.abort()
  }, [siteId, pageUrl, screenshotDevice])

  // tiles + meta + screenshot → view model。
  // 続 117 v2: view-model は capture CSS px 空間 (referenceWidth × pageCssHeight) で blob/tag を
  //   配置し、overlay 側が displayScale を掛けて native <img width:100%> と座標一致させる。
  //   referenceWidth は DPR 非依存 (viewportWidth)、pageHeight は DPR 除去後の CSS px 全高。
  const coordinateContext: HeatmapCoordinateContext | undefined = cap
    ? {
        sourceWidth: SOURCE_WIDTH,
        referenceWidth,
        pageHeight: pageCssHeight,
      }
    : undefined

  // coordinateContext を primitive 依存に分解 (object 参照で useMemo が毎回 invalidate しないよう)
  const ctxSig = cap ? `${SOURCE_WIDTH}|${referenceWidth}|${pageCssHeight}` : ''
  const vm = useMemo(
    () => buildHeatmapViewModel({ tiles, meta, coordinateContext, elements }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tiles, meta, ctxSig, elements],
  )

  // signal overlay は signals tab を開くと自動 ON (mockup 同等)
  const signalsOn = sideTab === 'signals'

  // load-more sentinel (続 119: 位置は marginTop:0 で screenshot 直下。下記 IntersectionObserver で発火)
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

  // layer toggle: data layers (click/attention/scroll/exit) は単一選択ラジオ。
  // 選択時に onLayerChange を呼んで heatmap_type を切替 → re-fetch が走る。
  // activeLayers の Set は overlay の表示制御にも使う (data layer は排他 + end/emo は別途)。
  const toggleLayer = useCallback(
    (k: LayerKey) => {
      const dataLayer = layerKeyToHeatmapLayer(k)
      if (dataLayer !== null) {
        // data layer: 単一選択ラジオ (すでに選択済みの場合はそのまま)
        setActiveLayers(new Set<LayerKey>([k]))
        onLayerChange?.(dataLayer)
      } else {
        // 非 data layer (end 等): 従来の multi-select toggle
        setActiveLayers((prev) => {
          const next = new Set(prev)
          if (next.has(k)) next.delete(k)
          else next.add(k)
          return next
        })
      }
    },
    [onLayerChange],
  )

  // Emotion は ML 未実装につきレイヤーが disabled。activeEmotions は fixture (mockup) モードで
  // emotion blob の表示フィルタに使う。切替 UI は無効化したため setter は内部保留。
  void setActiveEmotions

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

  // 続 117 v3 (Owner:「ヒートマップが表示されない」): 実 query 成功だが 0 hotspot の状態を検知する。
  //   GTM が v1 tracking (tenant_id='__legacy__') を fire していると tenant-scoped query が空 row を
  //   返し、data_source='clickhouse_events' のまま blob/tag 0 になる。従来は underlay のみ描画して
  //   無言の白紙になっていた。informative な empty-state を出すための flag。
  // 続121: 現在の active data layer の band 数。click 以外 (read/scroll/exit) は blob/tag を
  // 持たず band で描画するため、これも 0 の時に real-empty にして無言の白紙を防ぐ。
  const activeDataLayer = Array.from(activeLayers)
    .map(layerKeyToHeatmapLayer)
    .find((l): l is HeatmapLayer => l !== null)
  const activeBandCount =
    activeDataLayer === 'read'
      ? vm.readBands.length
      : activeDataLayer === 'scroll'
        ? vm.scrollReachBands.length
        : activeDataLayer === 'exit'
          ? vm.exitRows.length
          : 0
  const realEmpty = isRealEmptyHeatmap({
    dataSource: meta?.data_source,
    blobCount: vm.blobs.length,
    tagCount: vm.tags.length,
    bandCount: activeBandCount,
    tileCount: tiles.length,
    loading,
    error,
  })

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
      {/* ===== Controls bar (.hm-controls): layer toggles (single-select radio) ===== */}
      {controlsVisible && !fullscreen ? (
        <ControlsBar
          activeLayers={activeLayers}
          onToggleLayer={toggleLayer}
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
            pvLabel={pvLabel}
            ctrLabel={ctrLabel}
            dwellLabel={dwellLabel}
            scrollLabel={scrollLabel}
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

            {/* 続 117 v3: 実 query 成功 (clickhouse_events) だが hotspot 0 件の empty-state。
                数値の捏造をせず (Evidence Level: observed, 0 行)、無言の白紙を避けて状況を伝える。
                underlay (実 page / mock) はそのまま下に残し「どのページか」は分かるようにする。 */}
            {realEmpty ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="heatmap-empty-state"
                className="mx-auto mb-3 max-w-md rounded-lg border border-[var(--ug-border)] bg-white/95 px-5 py-4 text-center shadow-sm backdrop-blur"
              >
                <p className="text-sm font-semibold text-[var(--ug-text-1)]">
                  このページのクリックデータはまだありません
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--ug-text-2)]">
                  選択中の期間・デバイスで計測されたクリックがまだ届いていません。
                  計測タグの設置直後はデータ反映に数時間かかることがあります。
                  半日〜1 日待っても表示されない場合は、タグが正しく設置されているかご確認ください。
                </p>
              </div>
            ) : null}

            {(() => {
              // 続 117 v2 root-fix (Owner: 重い / heatmap 出ない / PC でスマホ / ページ切れ):
              //
              //   旧: `.hm-page-stage` を naturalWidth×naturalHeight (DPR 込で最大 2560×80000) に
              //       広げ `transform: scale` + `contain:paint` → 数百 MB の GPU layer = 重さの主因。
              //   新: native `<img width:100% height:auto>` を normal flow で配置 (ブラウザが効率 tile)。
              //       overlay は capture CSS px 空間で配置し displayScale を掛けて img と座標一致。
              //
              //   - outer `.hm-page` 高さは img が決める (height:auto)、巨大 layer を作らない
              //   - overlay は `displayScale = actualOuterWidth / referenceWidth` で縮小
              //   - fallback (loading / error / 未取得) は mock underlay + 同 overlay (displayScale=1)
              const outerStyle: React.CSSProperties = cap
                ? { maxWidth: displayMaxWidth, width: '100%', height: 'auto' }
                : { maxWidth: displayMaxWidth, width: '100%', minHeight: MOCK_PAGE_HEIGHT }
              return (
                <>
                  <div
                    ref={hmPageRef}
                    data-testid="hm-page"
                    data-underlay={
                      cap ? 'screenshot' : captureState.kind === 'error' ? 'mock' : 'skeleton'
                    }
                    data-capture-natural-width={cap?.naturalWidth ?? ''}
                    data-capture-natural-height={cap?.naturalHeight ?? ''}
                    data-reference-width={referenceWidth}
                    data-page-css-height={cap ? pageCssHeight : ''}
                    data-display-width={displayMaxWidth}
                    data-actual-outer-width={actualOuterWidth}
                    data-display-scale={displayScale.toFixed(4)}
                    className="hm-page relative mx-auto overflow-hidden rounded-md border border-[#e3e6ec] bg-white shadow-[0_8px_32px_rgba(15,17,23,.06)]"
                    style={outerStyle}
                  >
                    {cap ? (
                      <RealPageScreenshotUnderlay
                        capture={cap}
                        onImageError={() =>
                          setCaptureState({
                            kind: 'error',
                            code: 'IMAGE_LOAD_FAILED',
                            message: 'screenshot image failed to load',
                          })
                        }
                      />
                    ) : captureState.kind === 'error' ? (
                      // 実 screenshot 取得不可: 仮 underlay にフォールバック (overlay は displayScale=1)
                      <MockProductPageUnderlay />
                    ) : (
                      // idle / loading: ダミーは出さず中立のスケルトン。
                      // 実座標が無いため overlay も ready/error まで描画しない (差し替えチラつき防止)。
                      <div
                        data-testid="heatmap-canvas-skeleton"
                        aria-hidden
                        className="absolute inset-0 animate-pulse bg-gradient-to-b from-[#f4f5f7] to-[#eceef1]"
                      />
                    )}
                    {cap || captureState.kind === 'error' ? (
                      <>
                        <HeatOverlay
                          vm={vm}
                          layers={activeLayers}
                          activeEmotions={activeEmotions}
                          highlightedTagId={highlightedTagId}
                          tagRefs={tagRefs}
                          displayScale={displayScale}
                        />
                        <SignalOverlay
                          signals={vm.signals}
                          signalsOn={signalsOn}
                          enabledSignals={activeSignals}
                          displayScale={displayScale}
                        />
                        <HeatmapLegend layers={activeLayers} />
                      </>
                    ) : null}
                    {captureState.kind === 'loading' ? (
                      <div
                        role="status"
                        aria-live="polite"
                        data-testid="screenshot-loading-badge"
                        className="absolute right-3 top-3 z-10 rounded-full border border-[var(--ug-border)] bg-white/90 px-2.5 py-1 font-mono text-[10.5px] text-[var(--ug-text-3)] shadow-sm"
                      >
                        実 page 取得中…
                      </div>
                    ) : null}
                    {captureState.kind === 'error' ? (
                      <div
                        role="status"
                        data-testid="screenshot-error-badge"
                        className="absolute right-3 top-3 z-10 rounded-full border border-amber-400/40 bg-amber-100/95 px-2.5 py-1 font-mono text-[10.5px] text-amber-900 shadow-sm"
                        title={`${captureState.code}: ${captureState.message}`}
                      >
                        実 page 未取得 — 仮 underlay 表示中
                      </div>
                    ) : null}
                  </div>
                  {cap ? (
                    <p
                      data-testid="capture-meta-caption"
                      className="mx-auto mt-2 max-w-[720px] text-center font-mono text-[10px] leading-relaxed text-[var(--ug-text-3)]"
                    >
                      実ページ取得: {formatCapturedAt(cap.capturedAt)}
                      {cap.cached ? ' (cache)' : ''} · レイアウトは閲覧時と異なる場合があります
                    </p>
                  ) : null}
                </>
              )
            })()}

            {/* 続 119 fix: load-more sentinel は screenshot/overlay の直下に置く。
                旧実装は marginTop に「tile 空間 (固定 36000px) − MOCK_PAGE_HEIGHT」を入れ、
                データ量と無関係に画像の遥か下 (~34,500px) へ sentinel を飛ばしていたため、
                スクリーンショット下に巨大な空白スクロール領域が生まれていた (切れ/重さの一因)。
                img は height:auto で実寸描画されるので、sentinel は直後 (marginTop:0) で良い。 */}
            <div
              ref={sentinelRef}
              data-testid="heatmap-load-more-sentinel"
              aria-hidden
              style={{
                position: 'relative',
                marginTop: 0,
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
}: {
  activeLayers: ReadonlySet<LayerKey>
  onToggleLayer: (k: LayerKey) => void
}) {
  return (
    <div
      data-testid="heatmap-controls-bar"
      className="flex flex-wrap items-center gap-2.5 rounded-md border border-[var(--ug-border)] bg-white p-3 shadow-sm"
    >
      <span className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ug-text-3)]">
        layer
      </span>
      <div
        role="radiogroup"
        aria-label="ヒートマップ レイヤー"
        className="inline-flex overflow-hidden rounded-md border border-[var(--ug-border)] bg-white"
      >
        {LAYERS.map((l) => {
          const active = activeLayers.has(l.key)
          const isDisabled = l.disabled === true
          return (
            <button
              key={l.key}
              type="button"
              data-testid={`layer-toggle-${l.key}`}
              role="radio"
              aria-checked={active}
              aria-disabled={isDisabled}
              disabled={isDisabled}
              title={isDisabled ? l.disabledTooltip : undefined}
              onClick={() => !isDisabled && onToggleLayer(l.key)}
              className={
                'inline-flex items-center border-r border-[var(--ug-border)] px-3 py-1.5 text-[12px] transition last:border-r-0 ' +
                (isDisabled
                  ? 'cursor-not-allowed opacity-40 text-[var(--ug-text-3)]'
                  : active
                    ? 'bg-[var(--ug-accent-bg,rgba(79,107,255,.09))] font-semibold text-[var(--ug-brand-1)]'
                    : 'text-[var(--ug-text-2)] hover:bg-[var(--ug-bg-subtle)] hover:text-[var(--ug-text-1)]')
              }
            >
              {l.label}
              {isDisabled ? (
                <span className="ml-1 text-[9px] opacity-70">
                  {l.disabledTooltip}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
