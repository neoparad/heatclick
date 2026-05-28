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

export type LayerKey = 'click' | 'end' | 'attention' | 'exit' | 'move' | 'emo'

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

export interface HeatmapViewModel {
  blobs: HeatBlob[]
  tags: HeatTag[]
  signals: SignalMarker[]
  endBands: EndBand[]
  exitRows: ExitRow[]
  emotionSummary: EmotionDistribution
  hotspotCards: HotspotCard[]
  signalCards: SignalCard[]
}
