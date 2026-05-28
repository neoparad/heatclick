/**
 * tiles → HeatmapViewModel mapper
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 9 / §5
 *
 * 設計方針:
 *   - Phase 1 では真の field (signal / endBand / exitRow / emotion / hotspotCards / signalCards)
 *     は実 data 側に存在しない → mockup parity fixture を **常に fallback** で返す。
 *   - blobs / tags は tile.points が存在する場合に限り near-cluster で再構築 (上位 5)。
 *     ただし current pipeline の data quality を加味し、cluster が 5 つに満たない場合は
 *     不足分を fixture で補完して mockup parity を維持。
 *   - 座標変換: tile.points は SOURCE_WIDTH=1280, page Y ∈ [0, ~30000] の系。
 *     `.hm-page` は固定 720px、高さは PAGE_WIDTH 比例。両軸 720/1280 で xy scale して入れる。
 *   - 実 data 駆動の blob / tag に切替える場合でも tile が空の時は完全 fixture mode を返す
 *     (Owner デモで「点が 1 個も無い」になるのを避ける)。
 *
 * 本 mapper は pure function、副作用なし。test しやすくユニットテスト対象にしやすい。
 */

import type { HeatmapTile, HeatmapTileMeta } from '@/lib/api/heatmap'
import { MOCKUP_VIEW_MODEL } from '@/lib/fixtures/heatmap-mockup'
import { MOCK_PAGE_HEIGHT, PAGE_WIDTH } from '@/lib/heatmap/mockup-spec'
import type { HeatBlob, HeatTag, HeatmapViewModel, HotspotIntent } from '@/lib/heatmap/types'

const SOURCE_WIDTH = 1280
const MOCKUP_CANVAS_Y_RANGE = 720

interface BuildOptions {
  tiles: HeatmapTile[]
  meta: HeatmapTileMeta | null
  /**
   * Phase 1 では強制 fixture 同等 (false にしても tag は補完される)。
   * 将来 cluster heuristic が成熟したら true で純 fixture を外す。
   */
  forceFixture?: boolean
}

interface RawPoint {
  x: number
  y: number
  count: number
  sessions: number
}

/**
 * tiles を結合して flat point 配列を返す。
 * tile.y_start が大き過ぎる (= visible page 範囲外) の点は捨てる。
 * Y 座標は `.hm-page` 系 (0 - MOCK_PAGE_HEIGHT) に scale する。
 */
function flattenAndScale(tiles: HeatmapTile[], pageY: number): RawPoint[] {
  const out: RawPoint[] = []
  for (const tile of tiles) {
    for (const p of tile.points) {
      const yScaled = pageY > 0 ? (p.y / pageY) * MOCK_PAGE_HEIGHT : p.y
      if (yScaled < 0 || yScaled > MOCK_PAGE_HEIGHT * 4) continue
      const xScaled = (p.x / SOURCE_WIDTH) * PAGE_WIDTH
      out.push({ x: xScaled, y: yScaled, count: p.count, sessions: p.sessions })
    }
  }
  return out
}

/**
 * 単純な grid-bucket クラスタリング: 64px グリッドで集約し、合計 count 上位を hotspot とする。
 */
function clusterTop(points: RawPoint[], topN: number): RawPoint[] {
  if (points.length === 0) return []
  const grid = 64
  const buckets = new Map<string, RawPoint>()
  for (const p of points) {
    const gx = Math.round(p.x / grid) * grid
    const gy = Math.round(p.y / grid) * grid
    const key = `${gx}|${gy}`
    const cur = buckets.get(key)
    if (cur) {
      // immutable: 既存 bucket を新オブジェクトで置換 (Codex review LOW fix)
      buckets.set(key, {
        x: (cur.x + p.x) / 2,
        y: (cur.y + p.y) / 2,
        count: cur.count + p.count,
        sessions: cur.sessions + p.sessions,
      })
    } else {
      buckets.set(key, { ...p })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count).slice(0, topN)
}

/**
 * 実 data 由来の click blob を mockup parity 風に作る (Phase 1 では fixture が主、これは補助)。
 */
function buildClickBlobs(top: RawPoint[]): HeatBlob[] {
  return top.map((p, i) => ({
    id: `real-click-${i}`,
    mode: 'click',
    severity: i === 0 ? 'strong' : 'normal',
    x: Math.max(0, Math.round(p.x - 65)),
    y: Math.max(0, Math.round(p.y - 50)),
    width: 130,
    height: 100,
  }))
}

function buildTags(top: RawPoint[]): HeatTag[] {
  return top.map((p, i) => {
    const intent: HotspotIntent = i === 0 ? 'warn' : i === 1 ? 'win' : 'neutral'
    return {
      id: `real-tag-${i}`,
      rank: i + 1,
      label: `hotspot-${i + 1}`,
      count: p.count,
      x: Math.max(0, Math.round(p.x - 28)),
      y: Math.max(0, Math.round(p.y - 28)),
      intent,
    }
  })
}

export function buildHeatmapViewModel(opts: BuildOptions): HeatmapViewModel {
  const isDummy = opts.meta?.data_source === 'dummy_lcg' || opts.meta == null
  const pageY = opts.meta?.page_height_estimate ?? MOCKUP_CANVAS_Y_RANGE

  // Phase 1: data 由来 hotspot は **mockup parity fixture を常に override しない**。
  // tile が「明らかに real」(clickhouse_events) で十分な点数を持つ場合のみ補強する。
  const flat = flattenAndScale(opts.tiles, pageY)

  if (opts.forceFixture || isDummy || flat.length < 8) {
    return MOCKUP_VIEW_MODEL
  }

  const top = clusterTop(flat, 5)
  if (top.length < 5) {
    return MOCKUP_VIEW_MODEL
  }

  // 実 data hotspot を採用するが、emotion / signal / endBand / exitRow / emotionSummary /
  // hotspotCards / signalCards は実 data 側に存在しないため mockup fixture を継承。
  const realBlobs = buildClickBlobs(top)
  const realTags = buildTags(top)

  return {
    ...MOCKUP_VIEW_MODEL,
    blobs: [
      ...realBlobs,
      // mockup の emotion / attention blob は表現として残す (real click の上に重ね)
      ...MOCKUP_VIEW_MODEL.blobs.filter((b) => b.mode !== 'click'),
    ],
    tags: realTags,
  }
}
