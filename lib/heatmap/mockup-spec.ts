/**
 * mockup `01_heatmap_canvas.html` の CSS / DOM 構造を TypeScript 定数化
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §3 / §4 Step 1
 *
 * 値の出典は mockup CSS。ここを Single Source of Truth として、各 component は
 * このファイルだけを参照する (mockup から rgba 値などをコピーするのは禁止)。
 */

import type {
  DeviceKind,
  EmotionKey,
  LayerKey,
  SideTab,
  SignalKey,
} from './types'

/** `.hm-page` の固定幅 (mockup `max-width: 720px`) */
export const PAGE_WIDTH = 720

/** 商品ページ underlay 全体高 (mockup でだいたい 850px、overlay 座標と一致) */
export const MOCK_PAGE_HEIGHT = 860

/** Layer メタ — controls bar + fullscreen floating bar 用 */
export const LAYERS: ReadonlyArray<{
  key: LayerKey
  label: string
  defaultActive: boolean
  /**
   * disabled: true → 「データ未収集」ツールチップを表示し、クリック無効。
   * move (マウス移動) と emo (感情) は未収集 / ML 未実装。
   * §1.7 Anti-Features / D-07 規則: データがない機能は disabled 表示必須。
   */
  disabled?: boolean
  disabledTooltip?: string
}> = [
  { key: 'click', label: 'クリック', defaultActive: true },
  // 続121: '終了'(end) は実データ層にマップされない死んだトグルだった。深度/到達は
  // 'scroll'(スクロール到達率) が担うため重複。混乱を避けるため layer 一覧から撤去。
  { key: 'attention', label: '熟読', defaultActive: false },
  { key: 'scroll', label: 'スクロール', defaultActive: false },
  { key: 'exit', label: '離脱', defaultActive: false },
  {
    key: 'move',
    label: 'マウス',
    defaultActive: false,
    disabled: true,
    disabledTooltip: 'データ未収集',
  },
  {
    key: 'emo',
    label: '感情',
    defaultActive: false,
    disabled: true,
    disabledTooltip: 'ML未実装',
  },
]

/** Emotion sub-filter chips (mockup `.emo-filter`) */
export const EMOTIONS: ReadonlyArray<{
  key: EmotionKey
  label: string
  color: string
  defaultActive: boolean
}> = [
  { key: 'frust', label: 'frustration', color: '#d64545', defaultActive: true },
  { key: 'hes', label: 'hesitation', color: '#c9911a', defaultActive: true },
  { key: 'cmp', label: 'comparison', color: '#2f86e0', defaultActive: true },
  { key: 'eng', label: 'engagement', color: '#39a169', defaultActive: true },
  { key: 'conf', label: 'confidence', color: '#7a4fd6', defaultActive: false },
  { key: 'anx', label: 'anxiety', color: '#e08743', defaultActive: false },
]

/** Signal cards (右パネル signals tab) */
export const SIGNALS: ReadonlyArray<{ key: SignalKey; label: string; unique: boolean }> = [
  { key: 'rage', label: 'rage_click (怒りクリック)', unique: false },
  { key: 'dead', label: 'dead_click (無反応クリック)', unique: false },
  { key: 'hover', label: 'CTAホバー (クリック未到達)', unique: true },
  { key: 'copy', label: 'テキストコピー検知', unique: true },
  { key: 'backscroll', label: 'スクロール逆戻り', unique: false },
  { key: 'hesitation', label: 'hesitation (迷い)', unique: true },
]

/** Side panel tabs (続125 ③: ネガティブ / 続126 ★: 構造 (クロール) を追加) */
export const SIDE_TABS: ReadonlyArray<{ key: SideTab; label: string }> = [
  { key: 'hotspots', label: 'ホットスポット' },
  { key: 'negative', label: 'ネガティブ' },
  { key: 'signals', label: 'シグナル' },
  { key: 'structure', label: '構造' },
  { key: 'summary', label: 'サマリー' },
  { key: 'sessions', label: 'セッション' },
]

/** Device tabs (canvas top + fullscreen) — mockup `.device-tabs` */
export const DEVICES: ReadonlyArray<{
  key: DeviceKind
  label: string
  /** fullscreen 時の page 最大幅 */
  fsMaxWidth: number
}> = [
  { key: 'pc', label: 'PC', fsMaxWidth: 1320 },
  { key: 'sp', label: 'SP', fsMaxWidth: 390 },
  { key: 'tab', label: 'TAB', fsMaxWidth: 820 },
]

/**
 * 続128 (初回表示速度): screenshot capture の viewport 幅 (= 座標系 referenceWidth)。
 * server 側 `lib/heatmap/screenshot-provider.ts` の CAPTURE_WIDTH_FOR_DEVICE と一致させること
 * (client から server module を import すると node 依存を巻き込むため、client-safe な定数として複製)。
 *
 * 用途: screenshot 到着前に「暫定座標系」で heatmap overlay を先行描画する際の referenceWidth。
 * 実 capture の viewportWidth と同値のため、screenshot 差し替え時に blob が水平方向に動かない。
 */
export const DEVICE_CAPTURE_WIDTH: Record<DeviceKind, number> = {
  pc: 1280,
  sp: 390,
  tab: 820,
}

/**
 * Blob radial gradient by mode/emotion/severity (mockup `.heat-blob.*` 完全一致)
 * inline `background` として使う。emotion mode は emotion key で分岐。
 */
export function blobGradient(args: {
  mode: 'click' | 'attention' | 'emotion'
  severity?: 'normal' | 'strong'
  emotion?: EmotionKey
}): string {
  const { mode, severity, emotion } = args
  if (mode === 'click') {
    return severity === 'strong'
      ? 'radial-gradient(circle, rgba(79,107,255,.85) 0%, rgba(168,85,247,.45) 40%, rgba(168,85,247,0) 75%)'
      : 'radial-gradient(circle, rgba(79,107,255,.65) 0%, rgba(79,107,255,0) 70%)'
  }
  if (mode === 'attention') {
    return severity === 'strong'
      ? 'radial-gradient(circle, rgba(214,69,69,.85) 0%, rgba(232,138,53,.6) 30%, rgba(242,201,76,.3) 55%, rgba(166,209,99,0) 80%)'
      : 'radial-gradient(circle, rgba(232,138,53,.78) 0%, rgba(242,201,76,.5) 35%, rgba(166,209,99,.18) 65%, rgba(166,209,99,0) 80%)'
  }
  // emotion
  switch (emotion) {
    case 'frust':
      return 'radial-gradient(circle, rgba(214,69,69,.7) 0%, rgba(214,69,69,0) 70%)'
    case 'hes':
      return 'radial-gradient(circle, rgba(201,145,26,.7) 0%, rgba(201,145,26,0) 70%)'
    case 'anx':
      return 'radial-gradient(circle, rgba(224,135,67,.65) 0%, rgba(224,135,67,0) 70%)'
    case 'cmp':
      return 'radial-gradient(circle, rgba(47,134,224,.6) 0%, rgba(47,134,224,0) 70%)'
    case 'eng':
      return 'radial-gradient(circle, rgba(57,161,105,.65) 0%, rgba(57,161,105,0) 70%)'
    case 'conf':
      return 'radial-gradient(circle, rgba(122,79,214,.65) 0%, rgba(122,79,214,0) 70%)'
    default:
      return 'radial-gradient(circle, rgba(79,107,255,.5) 0%, rgba(79,107,255,0) 70%)'
  }
}

/** end-bands tier color (mockup `.end-band.b1..b5`) */
export const END_BAND_BG: Record<'b1' | 'b2' | 'b3' | 'b4' | 'b5', string> = {
  b1: 'rgba(214,69,69,.72)',
  b2: 'rgba(232,138,53,.70)',
  b3: 'rgba(242,201,76,.68)',
  b4: 'rgba(166,209,99,.60)',
  b5: 'rgba(57,161,105,.55)',
}

/** exit-row level color (mockup `.exit-row.lvl-*`) */
export const EXIT_ROW_BG: Record<'lo' | 'mid' | 'hi' | 'ok', string> = {
  hi: 'rgba(214,69,69,.55)',
  mid: 'rgba(232,138,53,.5)',
  lo: 'rgba(47,134,224,.45)',
  ok: 'rgba(57,161,105,.35)',
}

/** Mockup 5 emotion summary palette (`.sum-emo i.*`) */
export const EMOTION_BAR_BG: Record<EmotionKey, string> = {
  frust: '#d64545',
  hes: '#c9911a',
  cmp: '#2f86e0',
  eng: '#39a169',
  conf: '#7a4fd6',
  anx: '#e08743',
}

/**
 * Mockup の固定 dummy 商品 (TIRTIR クッションファンデ)。
 * MockProductPageUnderlay と PageStatsBar 表示に使う。
 */
export const MOCK_PRODUCT = {
  url: 'bihadashop.jp/p/tirtir-cushion-foundation',
  title: 'TIRTIR ットルットル マスクフィット ピンク クッション',
  rating: '★★★★★ 4.6',
  reviewCount: '1,284 reviews',
  price: '¥2,640',
  oldPrice: '¥3,300',
  reviews: [
    {
      meta: 'user_4823 · 5/09 · ★★★★★',
      body: '色味が思った通りで、カバー力もしっかりあります。ファンデ難民でしたが、これに落ち着きそう。',
    },
    {
      meta: 'user_1992 · 5/08 · ★★★★★',
      body: '在庫が少ないと書いてあったので焦って買いました。届くのが楽しみです。',
    },
    {
      meta: 'user_7711 · 5/07 · ★★★★★',
      body: '比較していたのですが、レビューが多いのでこちらにしました。サンプルがあれば嬉しいです。',
    },
  ],
} as const
