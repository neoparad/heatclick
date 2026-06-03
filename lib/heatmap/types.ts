/**
 * Heatmap view-model types
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §5
 *
 * `HeatmapTile` (API 由来、px 座標 + count) は `lib/api/heatmap.ts` に既存。
 * 本 file は mockup の HTML 構造に対応した「表示モデル」を定義する。
 *
 * - 座標系: 720px 幅の `.hm-page` 相対 (`left`/`top` が `.hm-page` 左上原点)
 * - 単位: px (整数推奨、CSS で left:Npx として絶対配置)
 */

export type LayerKey = 'click' | 'end' | 'attention' | 'scroll' | 'exit' | 'move' | 'emo'

export type EmotionKey = 'frust' | 'hes' | 'cmp' | 'eng' | 'conf' | 'anx'

export type SignalKey = 'rage' | 'dead' | 'hover' | 'copy' | 'backscroll' | 'hesitation'

export type SideTab = 'hotspots' | 'signals' | 'summary' | 'sessions'

export type DeviceKind = 'pc' | 'sp' | 'tab'

export type BlobMode = 'click' | 'attention' | 'emotion'

export type BlobSeverity = 'normal' | 'strong'

export type HotspotIntent = 'warn' | 'win' | 'neutral'

export interface HeatBlob {
  id: string
  x: number
  y: number
  width: number
  height: number
  mode: BlobMode
  emotion?: EmotionKey
  severity?: BlobSeverity
}

export interface HeatTag {
  id: string
  rank: number
  label: string
  count: number
  /** tag pill x (relative to .hm-page) */
  x: number
  /** tag pill y (relative to .hm-page) */
  y: number
  intent: HotspotIntent
}

export interface SignalMarker {
  id: string
  type: SignalKey
  x: number
  y: number
}

export interface EndBand {
  /** top px relative to .hm-page */
  top: number
  height: number
  /** "100%" reached label */
  reachedLabel: string
  /** "100%" / "82%" actual survival */
  survivalPct: string
  /** mockup 5-tier (b1..b5) — controls color */
  tier: 'b1' | 'b2' | 'b3' | 'b4' | 'b5'
}

export interface ExitRow {
  top: number
  height: number
  sectionLabel: string
  exitPct: string
  level: 'lo' | 'mid' | 'hi' | 'ok'
}

export interface EmotionDistribution {
  hes: number
  eng: number
  cmp: number
  frust: number
  anx: number
  conf: number
}

export interface HotspotCard {
  id: string
  rank: number
  intent: HotspotIntent
  name: string
  selector: string
  emotionLabel: EmotionKey | 'cmp'
  emotionPercents: Array<{ key: EmotionKey; pct: number }>
  stats: Array<{ label: string; value: string; tone?: 'neg' | 'pos' }>
}

export interface SignalCard {
  id: string
  type: SignalKey
  name: string
  count: number
  description: string
  whereLabel: string
  uniqueBadge?: boolean
}

/**
 * 熟読レイヤー (read / attention): read_area events を read_y で bin 集計した帯。
 * x はなし (full-width 強度帯)。top/height は capture CSS px 空間。
 */
export interface ReadBand {
  /** band 上端 CSS px (read_y の bin 下限) */
  top: number
  /** band 高さ (= bin サイズ) */
  height: number
  /** セッション数 */
  sessions: number
  /** イベント数 (intensity weight 用) */
  count: number
  /** 最大 count に対する比率 [0,1] */
  intensity: number
}

/**
 * スクロール到達率レイヤー (scroll): 各深度 band に到達したセッション割合 [0,1]。
 * 縦グラデーション帯 + % ラベルで表現する。
 */
export interface ScrollReachBand {
  /** band 上端 CSS px */
  top: number
  /** band 高さ */
  height: number
  /** 到達率 [0,1] */
  reach: number
  /** 表示ラベル (例: "78%") */
  reachLabel: string
}

export interface HeatmapViewModel {
  blobs: HeatBlob[]
  tags: HeatTag[]
  signals: SignalMarker[]
  endBands: EndBand[]
  exitRows: ExitRow[]
  /** 熟読レイヤー (read_area events 集計、read layer ON 時に HeatOverlay が描画) */
  readBands: ReadBand[]
  /** スクロール到達率レイヤー (scroll events 集計、scroll layer ON 時に HeatOverlay が描画) */
  scrollReachBands: ScrollReachBand[]
  emotionSummary: EmotionDistribution
  hotspotCards: HotspotCard[]
  signalCards: SignalCard[]
}

/**
 * Phase 2 (screenshot underlay) で追加:
 * 実 page の screenshot meta 一式。`/api/heatmap/screenshot` の data 部。
 *
 * `naturalHeight` がそのまま `.hm-page` 高に直結する (y 圧縮廃止)。
 */
export type HeatmapDevice = 'pc' | 'sp' | 'tab'

export interface HeatmapUnderlayCapture {
  pageUrl: string
  /** screenshot 画像の (CDN) URL */
  imageUrl: string
  /** capture viewport 幅 = CSS px 基準幅 (pc=1280, sp=390, tab=820)。DPR 非依存。 */
  viewportWidth: number
  /** capture viewport 高 (full page なら page 全高、provider が返した値) */
  viewportHeight: number
  /** image 実 px 幅 (= viewportWidth と一致する想定) */
  naturalWidth: number
  /** image 実 px 高 (full page、`.hm-page` の minHeight に直結) */
  naturalHeight: number
  device: HeatmapDevice
  /** ISO timestamp (cache-bust 用) */
  capturedAt: string
  /** server 計算 cache key (debug 用、UI で評価しない) */
  cacheKey: string
  /** capture を撮った provider (cloudflare = Browser Rendering、microlink = fallback) */
  provider: ScreenshotProvider
  cached: boolean
}

/**
 * screenshot capture provider 種別。
 *   - 'cloudflare': Cloudflare Browser Rendering REST API (PRIMARY、full page 確実取得)
 *   - 'microlink' : Microlink screenshot API (fallback、CF env 未設定時)
 */
export type ScreenshotProvider = 'cloudflare' | 'microlink'

/**
 * 座標変換 context: click_x / click_y を screenshot の **CSS px 座標空間** に整列するための値群。
 *
 *   - sourceWidth:    ClickHouse 正規化済 click_x の基準幅 (固定 1280)。`click_x/1280` = 水平比率。
 *   - referenceWidth: screenshot を CSS px で表示する基準幅 (= capture.viewportWidth)。
 *                     **DPR 非依存** — Microlink の naturalWidth は DPR で水増しされるため使わない。
 *                     x = `click_x/sourceWidth * referenceWidth` で CSS px に整列する。
 *   - pageHeight:     screenshot の CSS px 全高 (= naturalHeight * referenceWidth / naturalWidth)。
 *                     click_y (document 絶対 CSS px) と同じ空間。outlier guard と img 高の基準。
 *
 * 注: ここで計算した blob/tag 座標は **capture CSS px 空間** (referenceWidth × pageHeight)。
 *     実画面では `displayScale = actualOuterWidth / referenceWidth` を overlay 側で掛けて縮小する
 *     (`<img width:100%>` の縮小率と一致するため座標がずれない)。y は圧縮しない。
 */
export interface HeatmapCoordinateContext {
  sourceWidth: number
  referenceWidth: number
  pageHeight: number
}
