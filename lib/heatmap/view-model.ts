/**
 * tiles → HeatmapViewModel mapper
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch:
 *   - Phase 1 (2026-05-29 frontend heatmap real-data rendering): mock 演出 drop
 *   - Phase 2 (2026-05-29 frontend heatmap screenshot underlay): screenshot 座標空間採用
 *     (handoff: `2026-05-29-frontend-heatmap-screenshot-underlay.md`)
 *
 * Phase 2 設計方針:
 *   - dummy_lcg / 未定義 meta → mockup parity fixture (Phase 1 と同じ)
 *   - clickhouse_events で実 click が 1 点でも → real cluster を採用
 *   - **新規**: BuildOptions.coordinateContext が与えられた場合、
 *     x = click_x * captureWidth/sourceWidth、y = click_y (圧縮なし)
 *     coordinateContext 未指定の場合 (screenshot 取得前 / 失敗 fallback) は
 *     Phase 1 の y 圧縮 scale (y/pageY * MOCK_PAGE_HEIGHT) を維持。
 *   - real mode の tag label は `クリック密集 #N` (`hotspot-*` 文言は UI に出ない)
 *   - real hotspotCards は selector="DOM selector 未取得" / emotion 未推論 の暫定 card。
 *     emotion 推論 (rule-based / classifier) は Phase 3 Sprint 5+ で別途。
 *   - 実 data 0 点の場合は empty state を返却 (mockup parity fallback はしない)。
 *
 * 本 mapper は pure function、副作用なし。
 */

import type { HeatmapTile, HeatmapTileMeta } from '@/lib/api/heatmap'
import type { HeatmapElementsData, HeatmapElementStat } from '@/lib/api/heatmap-elements'
import { MOCKUP_VIEW_MODEL } from '@/lib/fixtures/heatmap-mockup'
import { MOCK_PAGE_HEIGHT, PAGE_WIDTH } from '@/lib/heatmap/mockup-spec'
import { logNormalize } from '@/lib/heatmap/normalize'
import type {
  EmotionDistribution,
  HeatBlob,
  HeatTag,
  HeatmapCoordinateContext,
  HeatmapViewModel,
  HotspotCard,
  ReadBand,
  ScrollReachBand,
  SignalCard,
  SignalMarker,
} from '@/lib/heatmap/types'

const SOURCE_WIDTH = 1280
const MOCKUP_CANVAS_Y_RANGE = 720

/** cluster grid (capture CSS px)。小さいほど密、大きいほど粗。 */
const CLUSTER_GRID = 48
/** density 用 blob の最大個数 (DOM blob を重ねて連続的な heat field を作る)。 */
const MAX_DENSITY_BLOBS = 60
/** label / card 化する hotspot 上位数 (clutter を避けるため blob より少なく)。 */
const MAX_HOTSPOTS = 6
/** Phase 2: pageHeight*1.05 を超える y は outlier (provider バグ / 計測ノイズ) として捨てる。 */
const PAGE_HEIGHT_OUTLIER_SLACK = 1.05
/** Phase 1 fallback: MOCK_PAGE_HEIGHT*4 を超える y は捨てる。 */
const MOCK_Y_OUTLIER_FACTOR = 4

const EMPTY_EMOTION_SUMMARY: EmotionDistribution = {
  hes: 0,
  eng: 0,
  cmp: 0,
  frust: 0,
  anx: 0,
  conf: 0,
}

interface BuildOptions {
  tiles: HeatmapTile[]
  meta: HeatmapTileMeta | null
  /**
   * Phase 1 でも debugging / Storybook で fixture を強制したい場合に使う。
   * production では未使用。
   */
  forceFixture?: boolean
  /**
   * Phase 2: 実 screenshot 座標空間 (`captureWidth` × `captureHeight`) で
   *   blob / tag / hotspot を配置する場合に指定。
   * 未指定なら Phase 1 互換の y 圧縮 scale (mockup canvas) で配置する。
   */
  coordinateContext?: HeatmapCoordinateContext
  /**
   * 続123: `/api/heatmap/elements` の要素単位集計。提供時、real click mode の
   * tag / hotspotCard を「クリック密集 #N」placeholder から **本物の要素名 + selector** に
   * 置き換え、signals (rage/dead) の marker + card を実データ化する。
   * null / 空なら従来の cluster ベース fallback (描画は止めない)。
   */
  elements?: HeatmapElementsData | null
}

interface RawPoint {
  x: number
  y: number
  count: number
  sessions: number
}

/**
 * tiles を結合して flat point 配列 (capture CSS px 空間) を返す。
 *   - coordinateContext あり (Phase 2): x = click_x/sourceWidth * referenceWidth、y = click_y そのまま
 *   - coordinateContext なし (Phase 1 fallback): x = click_x/SOURCE_WIDTH * PAGE_WIDTH、
 *     y = click_y/pageY * MOCK_PAGE_HEIGHT (mockup canvas 圧縮)
 *
 * 異常値ガード: y が pageHeight*1.05 (Phase 2) または mockup canvas 4 倍 (Phase 1) を
 *   超えるものは捨てる (provider バグ / 計測ノイズ防御)。
 */
function flattenAndScale(
  tiles: HeatmapTile[],
  pageY: number,
  ctx?: HeatmapCoordinateContext,
): RawPoint[] {
  const out: RawPoint[] = []
  const yLimit = ctx
    ? ctx.pageHeight * PAGE_HEIGHT_OUTLIER_SLACK
    : MOCK_PAGE_HEIGHT * MOCK_Y_OUTLIER_FACTOR
  for (const tile of tiles) {
    for (const p of tile.points) {
      let xScaled: number
      let yScaled: number
      if (ctx) {
        const srcW = ctx.sourceWidth > 0 ? ctx.sourceWidth : SOURCE_WIDTH
        const refW = ctx.referenceWidth > 0 ? ctx.referenceWidth : srcW
        xScaled = (p.x / srcW) * refW
        yScaled = p.y // y 圧縮なし、capture CSS px 空間 = click_y (document 絶対) そのまま
      } else {
        xScaled = (p.x / SOURCE_WIDTH) * PAGE_WIDTH
        yScaled = pageY > 0 ? (p.y / pageY) * MOCK_PAGE_HEIGHT : p.y
      }
      if (yScaled < 0 || yScaled > yLimit) continue
      out.push({ x: xScaled, y: yScaled, count: p.count, sessions: p.sessions })
    }
  }
  return out
}

/**
 * grid-bucket クラスタリング: `CLUSTER_GRID` px グリッドで count 加重平均し、合計 count 上位を返す。
 *   - count 加重で中心を求める (clicks が多い側に寄る、単純平均より hotspot 中心が正確)
 *   - 1〜topN の任意件数を返す (fixture fallback はしない、実測 cluster をそのまま返す)
 */
function clusterTop(points: RawPoint[], topN: number): RawPoint[] {
  if (points.length === 0) return []
  const grid = CLUSTER_GRID
  const buckets = new Map<string, RawPoint>()
  for (const p of points) {
    const gx = Math.round(p.x / grid) * grid
    const gy = Math.round(p.y / grid) * grid
    const key = `${gx}|${gy}`
    const cur = buckets.get(key)
    if (cur) {
      // immutable: 既存 bucket を count 加重平均で置換 (中心が click 密集側に寄る)
      const total = cur.count + p.count
      buckets.set(key, {
        x: total > 0 ? (cur.x * cur.count + p.x * p.count) / total : (cur.x + p.x) / 2,
        y: total > 0 ? (cur.y * cur.count + p.y * p.count) / total : (cur.y + p.y) / 2,
        count: total,
        sessions: cur.sessions + p.sessions,
      })
    } else {
      buckets.set(key, { ...p })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count).slice(0, topN)
}

/**
 * real click density blob 群。
 *   - 直径は count/maxCount に応じて 72〜240px (capture CSS px、sqrt で視覚的に均す)
 *   - cluster 中心に配置 (x/y は中心 - 直径/2)
 *   - severity: count が max の 50% 以上で 'strong' (色を濃く)
 *   - mix-blend-mode:multiply の blur blob を重ねて連続的な heat field を表現する
 *     (overlay 側で displayScale を掛けて img と同率縮小)
 */
function buildRealClickBlobs(clusters: RawPoint[], maxCount: number): HeatBlob[] {
  const safeMax = maxCount > 0 ? maxCount : 1
  return clusters.map((p, i) => {
    // logNormalize: 外れ値1点で max が跳ね他が潰れるのを防ぐ対数正規化 (順序は保持)
    const ratio = logNormalize(p.count, safeMax)
    const diameter = Math.round(Math.max(72, Math.min(240, 72 + Math.sqrt(ratio) * 168)))
    return {
      id: `real-click-${i + 1}`,
      mode: 'click',
      severity: ratio >= 0.5 ? 'strong' : 'normal',
      x: Math.max(0, Math.round(p.x - diameter / 2)),
      y: Math.max(0, Math.round(p.y - diameter / 2)),
      width: diameter,
      height: diameter,
    }
  })
}

/**
 * real tag pill。label は emotion / semantic を未推論で「クリック密集 #N」。
 * `hotspot-*` 文言は real mode UI に一切出さない (DoD)。
 */
function buildRealTags(top: RawPoint[]): HeatTag[] {
  return top.map((p, i) => ({
    id: `real-tag-${i + 1}`,
    rank: i + 1,
    label: `クリック密集 #${i + 1}`,
    count: p.count,
    x: Math.max(0, Math.round(p.x - 28)),
    y: Math.max(0, Math.round(p.y - 28)),
    intent: 'neutral',
  }))
}

/**
 * real hotspot 暫定 card。
 *   - selector: 「DOM selector 未取得」(Phase 2 の element_class_name 集約で本物に差替)
 *   - emotion: 未推論 (emotionPercents=[]、emotionLabel='cmp' は表示無害な neutral)
 *   - stats: 実測 click 数 / unique session のみ
 */
function buildRealHotspotCards(top: RawPoint[]): HotspotCard[] {
  return top.map((p, i) => ({
    id: `real-hs-${i + 1}`,
    rank: i + 1,
    intent: 'neutral',
    name: `クリック密集 #${i + 1}`,
    selector: 'DOM selector 未取得',
    emotionLabel: 'cmp',
    emotionPercents: [],
    stats: [
      { label: 'クリック', value: p.count.toLocaleString() },
      { label: 'セッション', value: p.sessions.toLocaleString() },
    ],
  }))
}

/**
 * 実 data 0 点 (clickhouse_events だが行なし) 用 empty view-model。
 * mockup fixture には *戻さない* — UI 側で「データなし」表示にする。
 */
function emptyViewModel(): HeatmapViewModel {
  return {
    blobs: [],
    tags: [],
    signals: [],
    endBands: [],
    exitRows: [],
    readBands: [],
    scrollReachBands: [],
    emotionSummary: EMPTY_EMOTION_SUMMARY,
    hotspotCards: [],
    signalCards: [],
  }
}

// ── READ (熟読 / attention) layer builders ────────────────────────────────

/**
 * read_area tile points (y = read_y の 200px bin、x = 0) から ReadBand 配列を生成する。
 * coordinateContext あり: y はそのまま (capture CSS px 空間)。
 * coordinateContext なし (Phase 1 fallback): y を MOCK_PAGE_HEIGHT に圧縮。
 */
function buildReadBands(
  tiles: HeatmapTile[],
  pageY: number,
  ctx?: HeatmapCoordinateContext,
): ReadBand[] {
  if (tiles.length === 0) return []

  // bin サイズ: read_y は 200px bin に丸め済み (route の SQL intDiv(..., 200)*200)。
  const BIN_HEIGHT = 200

  // flat 集計: y bin → {count, sessions}
  const bins = new Map<number, { count: number; sessions: number }>()
  for (const tile of tiles) {
    for (const p of tile.points) {
      // y スケーリング (coordinateContext あり → そのまま, なし → Phase 1 圧縮)
      let yScaled: number
      if (ctx) {
        yScaled = p.y // capture CSS px そのまま
      } else {
        yScaled = pageY > 0 ? (p.y / pageY) * MOCK_PAGE_HEIGHT : p.y
        // bin サイズも圧縮後の空間に合わせて再整列
        yScaled = Math.round(yScaled / (BIN_HEIGHT * MOCK_PAGE_HEIGHT / (pageY || MOCK_PAGE_HEIGHT))) *
          (BIN_HEIGHT * MOCK_PAGE_HEIGHT / (pageY || MOCK_PAGE_HEIGHT))
      }
      if (yScaled < 0) continue
      const key = Math.round(yScaled)
      const cur = bins.get(key)
      if (cur) {
        bins.set(key, { count: cur.count + p.count, sessions: cur.sessions + p.sessions })
      } else {
        bins.set(key, { count: p.count, sessions: p.sessions })
      }
    }
  }

  if (bins.size === 0) return []

  const maxCount = Math.max(...Array.from(bins.values()).map((v) => v.count))
  const safeMax = maxCount > 0 ? maxCount : 1

  // bin サイズ: coordinateContext あり → 200px, なし → 圧縮後のスケール
  const displayBinHeight = ctx
    ? BIN_HEIGHT
    : (BIN_HEIGHT * MOCK_PAGE_HEIGHT) / (pageY || MOCK_PAGE_HEIGHT)

  return Array.from(bins.entries())
    .sort(([a], [b]) => a - b)
    .map(([top, { count, sessions }]) => ({
      top,
      height: Math.max(4, Math.round(displayBinHeight)),
      sessions,
      count,
      // logNormalize: 外れ値で washed out しない対数正規化 (帯の色強度)
      intensity: logNormalize(count, safeMax),
    }))
}

// ── SCROLL (スクロール到達率) layer builders ───────────────────────────────

/**
 * scroll tile points (続121: y = max_scroll_percentage の 5% bin (0..100)、
 * count = その最深%バケットのセッション数) から ScrollReachBand 配列を生成する。
 *
 * reach(D) = sessions_reaching_at_least_D / total_sessions (累積生存曲線)。
 *   各バケット d の到達率 = (深度 d 以上に到達したセッション = d 以深バケットの合計) / 全セッション。
 * top/height は深度% を screenshot 高 (ctx.pageHeight、無ければ MOCK_PAGE_HEIGHT) にマップ。
 *   → viewport 非依存。生 px の truncation (続120 以前) を解消。
 */
const SCROLL_BIN_PCT = 5

function buildScrollReachBands(
  tiles: HeatmapTile[],
  _pageY: number,
  ctx?: HeatmapCoordinateContext,
): ScrollReachBand[] {
  if (tiles.length === 0) return []

  const targetHeight = ctx ? ctx.pageHeight : MOCK_PAGE_HEIGHT

  // 深度%バケット (0..100) → セッション数
  const bins = new Map<number, number>()
  for (const tile of tiles) {
    for (const p of tile.points) {
      const pct = Math.max(0, Math.min(100, Math.round(p.y)))
      bins.set(pct, (bins.get(pct) ?? 0) + p.count)
    }
  }
  if (bins.size === 0) return []

  const total = Array.from(bins.values()).reduce((s, v) => s + v, 0)
  if (total <= 0) return []

  // 連続バンド (0,5,…,95)。疎なバケットで帯が抜けないよう各深度の到達率を必ず算出する。
  // reach(s) = (最深 % が s 以上のセッション = key>=s の合計) / 全セッション。単調減少。
  const bands: ScrollReachBand[] = []
  for (let s = 0; s < 100; s += SCROLL_BIN_PCT) {
    let reachingAtLeast = 0
    for (const [pct, sessions] of bins) {
      if (pct >= s) reachingAtLeast += sessions
    }
    const reach = reachingAtLeast / total
    bands.push({
      top: Math.round((s / 100) * targetHeight),
      height: Math.max(4, Math.round((SCROLL_BIN_PCT / 100) * targetHeight)),
      reach,
      reachLabel: `${Math.round(reach * 100)}%`,
    })
  }
  return bands
}

// ── EXIT (終了 / 離脱) layer builders ─────────────────────────────────────

/**
 * exit tile points (続121: y = max_scroll_percentage の 5% bin (0..100)) から ExitRow 配列を生成する。
 * dropoff % = その深度で離脱した (それ以上進まなかった) セッション数 / 全セッション数。
 * top/height は深度% を screenshot 高にマップ (viewport 非依存、truncation 解消)。
 * level は dropoff 率で 4 段階。
 */
function buildExitRows(
  tiles: HeatmapTile[],
  _pageY: number,
  ctx?: HeatmapCoordinateContext,
): import('@/lib/heatmap/types').ExitRow[] {
  if (tiles.length === 0) return []

  const targetHeight = ctx ? ctx.pageHeight : MOCK_PAGE_HEIGHT

  // 深度%バケット (0..100) → セッション数 (dropoff count)
  const bins = new Map<number, number>()
  let totalSessions = 0
  for (const tile of tiles) {
    for (const p of tile.points) {
      const pct = Math.max(0, Math.min(100, Math.round(p.y)))
      bins.set(pct, (bins.get(pct) ?? 0) + p.sessions)
      totalSessions += p.sessions
    }
  }

  if (bins.size === 0 || totalSessions === 0) return []

  return Array.from(bins.entries())
    .sort(([a], [b]) => a - b)
    .map(([pct, sessions]) => {
      const dropoff = sessions / totalSessions
      const level: import('@/lib/heatmap/types').ExitRow['level'] =
        dropoff >= 0.3 ? 'hi' : dropoff >= 0.15 ? 'mid' : dropoff >= 0.05 ? 'lo' : 'ok'
      return {
        top: Math.round((pct / 100) * targetHeight),
        height: Math.max(4, Math.round((SCROLL_BIN_PCT / 100) * targetHeight)),
        sectionLabel: `${pct}%`,
        exitPct: `${Math.round(dropoff * 100)}%`,
        level,
      }
    })
}

// ── 続123: element-level (本物のホットスポット / シグナル) builders ────────────

/** click と同じ座標変換: x = 1280 正規化 → reference 幅、y は ctx ありなら raw、なしなら圧縮。 */
function scaleElementPoint(
  x1280: number,
  yDoc: number,
  pageY: number,
  ctx?: HeatmapCoordinateContext,
): { x: number; y: number } | null {
  if (ctx) {
    const srcW = ctx.sourceWidth > 0 ? ctx.sourceWidth : SOURCE_WIDTH
    const refW = ctx.referenceWidth > 0 ? ctx.referenceWidth : srcW
    const y = yDoc
    if (y < 0 || y > ctx.pageHeight * PAGE_HEIGHT_OUTLIER_SLACK) return null
    return { x: (x1280 / srcW) * refW, y }
  }
  const y = pageY > 0 ? (yDoc / pageY) * MOCK_PAGE_HEIGHT : yDoc
  if (y < 0 || y > MOCK_PAGE_HEIGHT * MOCK_Y_OUTLIER_FACTOR) return null
  return { x: (x1280 / SOURCE_WIDTH) * PAGE_WIDTH, y }
}

const ELEMENT_TAG_LABELS: Record<string, string> = {
  a: 'リンク',
  button: 'ボタン',
  img: '画像',
  input: '入力欄',
  textarea: '入力欄',
  select: 'プルダウン',
  label: '選択肢',
  summary: '開閉見出し',
  video: '動画',
}

/**
 * 要素の人間可読ラベルを導出する。
 *   1. element_text があればそれ (26 字で省略)
 *   2. 無ければ tag 種別ラベル + selector 末尾セグメント
 */
export function deriveElementName(el: {
  text: string
  tag: string
  selector: string
}): string {
  const t = el.text.trim().replace(/\s+/g, ' ')
  if (t.length > 0) return t.length > 26 ? `${t.slice(0, 26)}…` : t
  const tagLabel = ELEMENT_TAG_LABELS[el.tag.toLowerCase()] ?? '要素'
  const seg = el.selector.split('>').pop()?.trim() ?? ''
  if (!seg) return tagLabel
  return `${tagLabel} ${seg.length > 22 ? `${seg.slice(0, 22)}…` : seg}`
}

/** 要素集計 → canvas 上の常時ラベル (heat-tag)。サーバー側で clicks DESC 済み。 */
function buildElementTags(
  els: HeatmapElementStat[],
  pageY: number,
  ctx: HeatmapCoordinateContext | undefined,
  deadCounts: ReadonlyMap<string, number>,
): HeatTag[] {
  const out: HeatTag[] = []
  for (const el of els) {
    const p = scaleElementPoint(el.x, el.y, pageY, ctx)
    if (!p) continue
    out.push({
      id: `el-tag-${out.length + 1}`,
      rank: out.length + 1,
      label: deriveElementName(el),
      count: el.clicks,
      x: Math.max(0, Math.round(p.x - 28)),
      y: Math.max(0, Math.round(p.y - 28)),
      // 続124 ⑨: dead_click が出ている要素は「ネガティブスポット」= warn (赤)
      intent: (deadCounts.get(el.selector) ?? 0) > 0 ? 'warn' : 'neutral',
    })
    if (out.length >= MAX_HOTSPOTS) break
  }
  return out
}

/**
 * 要素集計 → 右パネルの本物ホットスポットカード。
 * 続124 ⑨ (Owner: 「ネガティブスポットもあるべき」): dead_click が観測された要素は
 * intent='warn' (赤枠) + デッド回数を stats に出す = ネガティブスポットの可視化。
 */
function buildElementHotspotCards(
  els: HeatmapElementStat[],
  deadCounts: ReadonlyMap<string, number>,
): HotspotCard[] {
  return els.slice(0, MAX_HOTSPOTS).map((el, i) => {
    const dead = deadCounts.get(el.selector) ?? 0
    const stats: HotspotCard['stats'] = [
      { label: 'クリック', value: el.clicks.toLocaleString() },
      { label: 'セッション', value: el.sessions.toLocaleString() },
    ]
    if (dead > 0) {
      stats.push({ label: 'デッド', value: dead.toLocaleString(), tone: 'neg' })
    }
    return {
      id: `el-hs-${i + 1}`,
      rank: i + 1,
      intent: dead > 0 ? ('warn' as const) : ('neutral' as const),
      name: deriveElementName(el),
      selector: el.selector,
      emotionLabel: 'cmp' as const,
      emotionPercents: [],
      stats,
    }
  })
}

/** dead_click の selector → 回数 map (ネガティブスポット判定用)。 */
function buildDeadCountMap(
  elements: HeatmapElementsData | null | undefined,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  const dead = elements?.signals.find((s) => s.type === 'dead')
  for (const t of dead?.top ?? []) {
    map.set(t.selector, (map.get(t.selector) ?? 0) + t.count)
  }
  return map
}

/** rage/dead シグナル → canvas marker + 右パネル card。データが無い type は出さない。 */
function buildSignalExtras(
  elements: HeatmapElementsData | null | undefined,
  pageY: number,
  ctx?: HeatmapCoordinateContext,
): { signals: SignalMarker[]; signalCards: SignalCard[] } {
  if (!elements || elements.signals.length === 0) return { signals: [], signalCards: [] }

  const META: Record<'rage' | 'dead', { name: string; description: string }> = {
    rage: {
      name: 'レイジクリック',
      description: '短時間に同じ要素を連打 — 反応しない UI への苛立ちシグナル。',
    },
    dead: {
      name: 'デッドクリック',
      description: 'クリックしても何も起きない要素 — リンク切れ / クリック可能と誤認させる装飾の疑い。',
    },
  }

  const signals: SignalMarker[] = []
  const signalCards: SignalCard[] = []
  for (const sig of elements.signals) {
    if (sig.count <= 0) continue
    const meta = META[sig.type]
    const top = sig.top[0]
    signalCards.push({
      id: `real-sig-${sig.type}`,
      type: sig.type,
      name: meta.name,
      count: sig.count,
      description: meta.description,
      whereLabel: top
        ? `最多: ${deriveElementName({ text: top.text, tag: '', selector: top.selector })} (${top.count}回) · ${sig.sessions} セッション`
        : `${sig.sessions} セッションで発生`,
    })
    for (const [i, t] of sig.top.entries()) {
      const p = scaleElementPoint(t.x, t.y, pageY, ctx)
      if (!p) continue
      signals.push({
        id: `real-sig-${sig.type}-${i + 1}`,
        type: sig.type,
        x: Math.round(p.x),
        y: Math.round(p.y),
        count: t.count,
        label: deriveElementName({ text: t.text, tag: '', selector: t.selector }),
      })
    }
  }
  return { signals, signalCards }
}

export function buildHeatmapViewModel(opts: BuildOptions): HeatmapViewModel {
  // 「real」とみなすのは meta.data_source が明示的に 'clickhouse_events' の時のみ。
  // 未定義 (legacy deploy) や 'dummy_lcg' は fixture parity に倒す。
  // (lib/api/heatmap.ts HeatmapTileMeta コメント + heatmap-canvas.tsx isDummySource 判定と整合、
  //  Codex T2 review HIGH fix: undefined を real 扱いしない)
  const isReal = opts.meta?.data_source === 'clickhouse_events'
  const pageY = opts.meta?.page_height_estimate ?? MOCKUP_CANVAS_Y_RANGE
  // heatmap_type: undefined の場合は 'click' 互換 (legacy deploy)
  const heatmapType = opts.meta?.heatmap_type ?? 'click'

  // dummy mode / legacy meta / 初回 render / 明示 force → mockup parity fixture
  if (opts.forceFixture || !isReal) {
    return MOCKUP_VIEW_MODEL
  }

  // 続123: rage/dead シグナル (要素集計由来)。全 real layer の view に同梱する
  // (シグナルタブは layer に依らず実データを表示する)。
  const signalExtras = buildSignalExtras(opts.elements, pageY, opts.coordinateContext)

  // 続124 ⑨: 要素ホットスポットカードも全 real layer に同梱 (右パネルは layer 非依存)。
  // Codex T1 MEDIUM fix: 座標 outlier guard で弾かれた要素が tag に出ない一方 card に
  // 残ると rank がズレるため、**同一の filter 済みリスト**を tag / card 両方に使う。
  const els = (opts.elements?.elements ?? []).filter(
    (el) => scaleElementPoint(el.x, el.y, pageY, opts.coordinateContext) !== null,
  )
  const deadCounts = buildDeadCountMap(opts.elements)
  const elementCards = els.length > 0 ? buildElementHotspotCards(els, deadCounts) : []
  const elementExtras = { ...signalExtras, hotspotCards: elementCards }

  // ── read (熟読 / attention) ─────────────────────────────────────────────
  if (heatmapType === 'read') {
    const readBands = buildReadBands(opts.tiles, pageY, opts.coordinateContext)
    if (readBands.length === 0) return { ...emptyViewModel(), ...elementExtras }
    return {
      ...emptyViewModel(),
      ...elementExtras,
      readBands,
    }
  }

  // ── scroll (スクロール到達率) ────────────────────────────────────────────
  if (heatmapType === 'scroll') {
    const scrollReachBands = buildScrollReachBands(opts.tiles, pageY, opts.coordinateContext)
    if (scrollReachBands.length === 0) return { ...emptyViewModel(), ...elementExtras }
    return {
      ...emptyViewModel(),
      ...elementExtras,
      scrollReachBands,
    }
  }

  // ── exit (終了 / 離脱) ──────────────────────────────────────────────────
  if (heatmapType === 'exit') {
    const exitRows = buildExitRows(opts.tiles, pageY, opts.coordinateContext)
    if (exitRows.length === 0) return { ...emptyViewModel(), ...elementExtras }
    return {
      ...emptyViewModel(),
      ...elementExtras,
      exitRows,
    }
  }

  // ── click (デフォルト) ──────────────────────────────────────────────────
  // real mode (clickhouse_events)
  const flat = flattenAndScale(opts.tiles, pageY, opts.coordinateContext)
  const hasRealClickData = flat.length >= 1
  if (!hasRealClickData) {
    // 実 data 0 点 — empty state (dummy fixture には戻さない、DoD)
    return { ...emptyViewModel(), ...elementExtras }
  }

  // density field: 上位 MAX_DENSITY_BLOBS cluster を blob 化 (連続的な heat 表現)。
  const clusters = clusterTop(flat, MAX_DENSITY_BLOBS)
  const maxCount = clusters.length > 0 ? clusters[0].count : 1

  // 続123: 要素集計があれば tag / card を「本物の要素名 + selector」で出す。
  // 無ければ従来の cluster ベース placeholder (クリック密集 #N) に fallback。
  const elementTags =
    els.length > 0 ? buildElementTags(els, pageY, opts.coordinateContext, deadCounts) : []
  const useElements = elementTags.length > 0
  // cluster fallback 用: 上位 MAX_HOTSPOTS (clusters は count 降順)。
  const hotspots = clusters.slice(0, MAX_HOTSPOTS)

  return {
    blobs: buildRealClickBlobs(clusters, maxCount),
    tags: useElements ? elementTags : buildRealTags(hotspots),
    signals: signalExtras.signals,
    endBands: [],
    exitRows: [],
    readBands: [],
    scrollReachBands: [],
    emotionSummary: EMPTY_EMOTION_SUMMARY,
    hotspotCards: useElements ? elementCards : buildRealHotspotCards(hotspots),
    signalCards: signalExtras.signalCards,
  }
}
