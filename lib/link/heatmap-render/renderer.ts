/**
 * UGOKI LINK v2 — 束 4-I (§11.12): 重ね可否判定・画面写真マスク・決定論的純 TypeScript PNG/SVG レンダラ
 *
 * 設計書 §11.12:
 * 1. **画面写真ガード**: 検査環境 (`provenance === 'lab_render'`) のみ許可。訪問者画面・リプレイ記録は例外拒否。
 * 2. **個人情報・未許可領域の保存/提供前マスク (`redactScreenshotRegions`)**。
 * 3. **重ね可否判定 (`decideHeatmapRenderKind`)**:
 *    - `http_crawler` → `http_fetch_diagram` のみ（クリック/閲覧/滞在の重ね禁止）
 *    - `private_scope` または区画未収集 → `render_kind: 'none'`, `status: 'not_collected'`（画像不生成）
 *    - 描画待ち → `render_kind: 'none'`, `status: 'pending'` + `render_job_id`
 *    - 検査環境画面写真＋実測配置図あり＋`G <= 0.08`＋主張ゲート通過＋非認証ページ → `screenshot_overlay`
 *    - 画面写真不可だが有効構造＋集計あり → `wireframe_schematic`（区画並び模式図）
 * 4. **決定論的 PNG エンコーダ (外部ネイティブ依存 0)**:
 *    Node 標準 `zlib.deflateSync` (level=6) + 正確な IEEE CRC32 で有効な PNG バイト列を生成。
 *    タイムスタンプ・乱数チャンクを一切含まないため、同一再現入力からは **1 バイト違わず同一の SHA-256** を保証。
 */

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

import type { MeasureStatus } from '@/packages/contract/response'
import { VISUAL_FACT_MAX_GEOMETRY_DRIFT_G } from '@/lib/link/join'

import type {
  HeatmapActorBucket,
  HeatmapClickPointInput,
  HeatmapHttpFetchMetricInput,
  HeatmapKind,
  HeatmapRenderKind,
  HeatmapSectionMetricInput,
  HeatmapUnitDataset,
  LabScreenshotInput,
  RedactionBox,
} from './types'

// ---------------------------------------------------------------------------
// 1. IEEE 802.3 CRC32 & Pure-TypeScript Deterministic PNG Encoder
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii')
  const out = new Uint8Array(4 + 4 + data.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length, false)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  view.setUint32(8 + data.length, crc32(crcInput), false)
  return out
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 外部ネイティブ依存ゼロの決定論的 RGBA8 PNG エンコーダ。
 * `tIME` や乱数を含まないため、同一ピクセル配列から常にバイト単位で同一の PNG を出力する。
 */
export function encodeDeterministicRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error(`Invalid RGBA buffer dimensions: ${width}x${height} (len=${rgba.length})`)
  }

  // Filter byte 0 (None) before each scanline
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1)
    raw[rowOff] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowOff + 1)
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const compressed = deflateSync(raw, { level: 6 })
  const ihdrChunk = makePngChunk('IHDR', ihdr)
  const idatChunk = makePngChunk('IDAT', compressed)
  const iendChunk = makePngChunk('IEND', new Uint8Array(0))

  const total = PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  const png = new Uint8Array(total)
  let offset = 0
  png.set(PNG_SIGNATURE, offset)
  offset += PNG_SIGNATURE.length
  png.set(ihdrChunk, offset)
  offset += ihdrChunk.length
  png.set(idatChunk, offset)
  offset += idatChunk.length
  png.set(iendChunk, offset)
  return png
}

// ---------------------------------------------------------------------------
// 2. Screenshot Guard & Pre-Storage/Pre-Overlay Redaction (§11.12)
// ---------------------------------------------------------------------------

export function assertLabOnlyScreenshot(screenshot: LabScreenshotInput): void {
  if (screenshot.provenance !== 'lab_render') {
    throw new Error(
      `Prohibited screenshot provenance "${screenshot.provenance}": heatmaps MUST use lab_render screenshots only (visitor screens and replay frames are forbidden, §11.12)`,
    )
  }
}

export interface RedactedScreenshotResult {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8Array
  readonly redaction_count: number
  readonly redaction_applied: boolean
  readonly redacted_sha256: string
}

/**
 * 検査環境画面写真の個人情報・未許可領域を保存および提供前に不透明マスクする (§11.12)。
 */
export function redactScreenshotRegions(screenshot: LabScreenshotInput): RedactedScreenshotResult {
  assertLabOnlyScreenshot(screenshot)
  const w = Math.max(1, Math.floor(screenshot.width))
  const h = Math.max(1, Math.floor(screenshot.height))
  const rgba = new Uint8Array(w * h * 4)

  if (screenshot.rgba_pixels && screenshot.rgba_pixels.length === w * h * 4) {
    rgba.set(screenshot.rgba_pixels)
  } else {
    // Deterministic neutral base canvas derived from screenshot_sha256
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4
      rgba[idx] = 245
      rgba[idx + 1] = 247
      rgba[idx + 2] = 250
      rgba[idx + 3] = 255
    }
  }

  for (const box of screenshot.redaction_boxes) {
    fillRect(rgba, w, h, box, [28, 32, 38, 255])
  }

  const redactedSha = createHash('sha256').update(rgba).digest('hex')
  return Object.freeze({
    width: w,
    height: h,
    rgba,
    redaction_count: screenshot.redaction_boxes.length,
    redaction_applied: screenshot.redaction_boxes.length > 0,
    redacted_sha256: redactedSha,
  })
}

function fillRect(
  rgba: Uint8Array,
  w: number,
  h: number,
  box: Pick<RedactionBox, 'x' | 'y' | 'width' | 'height'>,
  color: readonly [number, number, number, number],
): void {
  const x0 = Math.max(0, Math.min(w, Math.floor(box.x)))
  const y0 = Math.max(0, Math.min(h, Math.floor(box.y)))
  const x1 = Math.max(x0, Math.min(w, Math.ceil(box.x + box.width)))
  const y1 = Math.max(y0, Math.min(h, Math.ceil(box.y + box.height)))
  const alpha = color[3] / 255

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * w + x) * 4
      if (alpha >= 0.999) {
        rgba[idx] = color[0]
        rgba[idx + 1] = color[1]
        rgba[idx + 2] = color[2]
        rgba[idx + 3] = 255
      } else {
        rgba[idx] = Math.round(rgba[idx] * (1 - alpha) + color[0] * alpha)
        rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - alpha) + color[1] * alpha)
        rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - alpha) + color[2] * alpha)
        rgba[idx + 3] = 255
      }
    }
  }
}

function thermalColor(intensity: number): readonly [number, number, number] {
  const t = Math.max(0, Math.min(1, intensity))
  if (t < 0.33) {
    const k = t / 0.33
    return [Math.round(30 * (1 - k)), Math.round(120 + 115 * k), Math.round(230 - 30 * k)]
  }
  if (t < 0.66) {
    const k = (t - 0.33) / 0.33
    return [Math.round(250 * k), Math.round(235 - 15 * k), Math.round(200 * (1 - k))]
  }
  const k = (t - 0.66) / 0.34
  return [250, Math.round(220 * (1 - k)), Math.round(30 * (1 - k))]
}

// ---------------------------------------------------------------------------
// 3. Overlay Eligibility Decision (§11.12 — Zero Misaligned Overlays)
// ---------------------------------------------------------------------------

export interface RenderKindDecision {
  readonly render_kind: HeatmapRenderKind
  readonly status: Extract<MeasureStatus, 'ok' | 'pending' | 'not_collected'>
  readonly pending_job_id: string | null
  readonly reasons: readonly string[]
}

export function decideHeatmapRenderKind(
  dataset: HeatmapUnitDataset,
  actorBucket: HeatmapActorBucket,
): RenderKindDecision {
  // 1. HTTP Crawler -> HTTP fetch facts diagram ONLY (never screenshot click/dwell overlay!)
  if (actorBucket === 'http_crawler') {
    if (!dataset.http_fetch_metrics) {
      return Object.freeze({
        render_kind: 'none',
        status: 'not_collected',
        pending_job_id: null,
        reasons: Object.freeze(['http_crawler_fetch_metrics_missing']),
      })
    }
    return Object.freeze({
      render_kind: 'http_fetch_diagram',
      status: 'ok',
      pending_job_id: null,
      reasons: Object.freeze(['http_crawler_fetch_facts_only']),
    })
  }

  // 2. Pending lab render job -> return pending + control job id (§11.12)
  if (dataset.lab_render_pending_job_id) {
    return Object.freeze({
      render_kind: 'none',
      status: 'pending',
      pending_job_id: dataset.lab_render_pending_job_id,
      reasons: Object.freeze(['lab_render_pending']),
    })
  }

  // 3. Outside anonymous section scope (private_scope or zero sections) -> NO image, not_collected!
  if (dataset.dom_state === 'private_scope' || dataset.sections.length === 0) {
    return Object.freeze({
      render_kind: 'none',
      status: 'not_collected',
      pending_job_id: null,
      reasons: Object.freeze(['outside_section_collection_scope']),
    })
  }

  // 4. Validate screenshot provenance immediately (never accept visitor_screen or replay!)
  if (dataset.screenshot) {
    assertLabOnlyScreenshot(dataset.screenshot)
  }

  // 5. Screenshot overlay gate (§11.12):
  //    MUST have lab screenshot + verified field layout + G <= 0.08 + claim gate passed + non-auth page + skel_fp & css_fp present
  const overlayBlockers: string[] = []
  if (dataset.is_authenticated_or_personalized_page) {
    overlayBlockers.push('authenticated_or_personalized_page_wireframe_only')
  }
  if (!dataset.screenshot) {
    overlayBlockers.push('no_lab_screenshot')
  }
  if (!dataset.has_verified_field_layout) {
    overlayBlockers.push('missing_verified_field_layout')
  }
  if (!dataset.unit.skel_fp || !dataset.unit.css_fp) {
    overlayBlockers.push('missing_skel_or_css_fp')
  }
  if (dataset.measured_geometry_drift_G === null) {
    overlayBlockers.push('geometry_drift_G_unmeasured')
  } else if (dataset.measured_geometry_drift_G > VISUAL_FACT_MAX_GEOMETRY_DRIFT_G) {
    overlayBlockers.push(`geometry_drift_G_exceeded:${dataset.measured_geometry_drift_G.toFixed(4)}`)
  }
  if (!dataset.claim_gate_passed) {
    overlayBlockers.push('claim_gate_unmet')
  }

  if (overlayBlockers.length === 0) {
    return Object.freeze({
      render_kind: 'screenshot_overlay',
      status: 'ok',
      pending_job_id: null,
      reasons: Object.freeze(['overlay_conditions_satisfied']),
    })
  }

  // Fallback: valid structure & aggregates exist -> wireframe schematic (NEVER misaligned screenshot!)
  return Object.freeze({
    render_kind: 'wireframe_schematic',
    status: 'ok',
    pending_job_id: null,
    reasons: Object.freeze(overlayBlockers),
  })
}

// ---------------------------------------------------------------------------
// 4. Deterministic Canvas Drawing -> PNG + SVG
// ---------------------------------------------------------------------------

export interface RenderedHeatmapImage {
  readonly render_kind: HeatmapRenderKind
  readonly width: number
  readonly height: number
  readonly png_bytes: Uint8Array
  readonly png_sha256: string
  readonly svg_markup: string
  readonly redaction_count: number
}

export function renderDeterministicHeatmapImage(params: {
  readonly render_kind: Exclude<HeatmapRenderKind, 'none'>
  readonly kind: HeatmapKind
  readonly dataset: HeatmapUnitDataset
  readonly sections: readonly HeatmapSectionMetricInput[]
  readonly clicks: readonly HeatmapClickPointInput[]
  readonly http_fetch?: HeatmapHttpFetchMetricInput | null
  readonly default_width?: number
  readonly default_height?: number
}): RenderedHeatmapImage {
  let w = params.default_width ?? 320
  let h = params.default_height ?? 480
  let rgba: Uint8Array
  let redactionCount = 0

  if (params.render_kind === 'screenshot_overlay' && params.dataset.screenshot) {
    const redacted = redactScreenshotRegions(params.dataset.screenshot)
    w = redacted.width
    h = redacted.height
    rgba = new Uint8Array(redacted.rgba)
    redactionCount = redacted.redaction_count
  } else {
    rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4
      rgba[idx] = 248
      rgba[idx + 1] = 250
      rgba[idx + 2] = 252
      rgba[idx + 3] = 255
    }
  }

  if (params.render_kind === 'http_fetch_diagram') {
    drawHttpFetchDiagram(rgba, w, h, params.http_fetch ?? null)
  } else if (params.kind === 'click') {
    drawClickOverlay(rgba, w, h, params.clicks)
  } else {
    drawSectionBandOverlay(rgba, w, h, params.kind, params.sections, params.render_kind === 'wireframe_schematic')
  }

  const pngBytes = encodeDeterministicRgbaPng(w, h, rgba)
  const pngSha = createHash('sha256').update(pngBytes).digest('hex')
  const svgMarkup = buildDeterministicSvg(
    w,
    h,
    params.render_kind,
    params.kind,
    params.sections,
    params.clicks,
  )

  return Object.freeze({
    render_kind: params.render_kind,
    width: w,
    height: h,
    png_bytes: pngBytes,
    png_sha256: pngSha,
    svg_markup: svgMarkup,
    redaction_count: redactionCount,
  })
}

function drawSectionBandOverlay(
  rgba: Uint8Array,
  w: number,
  h: number,
  kind: 'scroll_reach' | 'section_dwell',
  sections: readonly HeatmapSectionMetricInput[],
  isWireframe: boolean,
): void {
  const maxDwell = Math.max(
    1,
    ...sections.map((s) => (s.status === 'ok' && s.dwell_center40_ms !== null ? s.dwell_center40_ms : 0)),
  )

  for (const s of sections) {
    const y = Math.floor(s.top_ratio * h)
    const bh = Math.max(4, Math.floor(s.height_ratio * h))
    const margin = isWireframe ? 12 : 0

    let intensity = 0
    if (s.status === 'ok') {
      if (kind === 'scroll_reach' && s.reach_rate !== null) {
        intensity = s.reach_rate
      } else if (kind === 'section_dwell' && s.dwell_center40_ms !== null) {
        intensity = s.dwell_center40_ms / maxDwell
      }
    }

    const [r, g, b] = thermalColor(intensity)
    const alpha = s.status === 'ok' ? (isWireframe ? 180 : 120) : 60
    fillRect(
      rgba,
      w,
      h,
      { x: margin, y, width: w - margin * 2, height: Math.max(2, bh - 2) },
      [r, g, b, alpha],
    )
    // Deterministic 1px border line
    fillRect(
      rgba,
      w,
      h,
      { x: margin, y, width: w - margin * 2, height: 1 },
      [51, 65, 85, 220],
    )
  }
}

function drawClickOverlay(
  rgba: Uint8Array,
  w: number,
  h: number,
  clicks: readonly HeatmapClickPointInput[],
): void {
  const validClicks = clicks.filter((c) => c.status === 'ok' && c.click_count > 0)
  const maxClicks = Math.max(1, ...validClicks.map((c) => c.click_count))
  const radius = Math.max(6, Math.round(Math.min(w, h) * 0.04))

  for (const pt of validClicks) {
    const cx = Math.round((pt.box_x + pt.box_w * pt.rel_x) * w)
    const cy = Math.round((pt.box_y + pt.box_h * pt.rel_y) * h)
    const norm = pt.click_count / maxClicks
    const [r, g, b] = thermalColor(norm)

    const y0 = Math.max(0, cy - radius)
    const y1 = Math.min(h - 1, cy + radius)
    const x0 = Math.max(0, cx - radius)
    const x1 = Math.min(w - 1, cx + radius)

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))
        if (dist > radius) continue
        const falloff = (1 - dist / radius) * 0.75 * norm
        const idx = (y * w + x) * 4
        rgba[idx] = Math.round(rgba[idx] * (1 - falloff) + r * falloff)
        rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - falloff) + g * falloff)
        rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - falloff) + b * falloff)
        rgba[idx + 3] = 255
      }
    }
  }
}

function drawHttpFetchDiagram(
  rgba: Uint8Array,
  w: number,
  h: number,
  metrics: HeatmapHttpFetchMetricInput | null,
): void {
  if (!metrics || metrics.total_fetches <= 0) return
  const entries = [
    { ratio: metrics.redirect_count / metrics.total_fetches, color: [59, 130, 246, 220] as const },
    { ratio: metrics.blocked_count / metrics.total_fetches, color: [239, 68, 68, 220] as const },
    { ratio: metrics.truncated_count / metrics.total_fetches, color: [245, 158, 11, 220] as const },
    {
      ratio: Math.min(1, metrics.raw_html_missing_section_count / Math.max(1, metrics.total_fetches)),
      color: [139, 92, 246, 220] as const,
    },
  ]

  const barH = Math.max(12, Math.floor((h - 40) / entries.length) - 8)
  for (let i = 0; i < entries.length; i++) {
    const y = 20 + i * (barH + 8)
    const bw = Math.max(4, Math.round((w - 40) * Math.min(1, entries[i].ratio)))
    fillRect(rgba, w, h, { x: 20, y, width: bw, height: barH }, entries[i].color)
  }
}

function buildDeterministicSvg(
  w: number,
  h: number,
  renderKind: HeatmapRenderKind,
  kind: HeatmapKind,
  sections: readonly HeatmapSectionMetricInput[],
  clicks: readonly HeatmapClickPointInput[],
): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-render-kind="${renderKind}" data-heatmap-kind="${kind}">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#f8fafc"/>`,
  ]
  if (renderKind !== 'http_fetch_diagram') {
    for (const s of sections) {
      const y = Math.floor(s.top_ratio * h)
      const bh = Math.max(4, Math.floor(s.height_ratio * h))
      parts.push(
        `<rect x="8" y="${y}" width="${w - 16}" height="${bh}" fill="rgba(59,130,246,0.22)" stroke="#334155" data-sec-fp="${s.sec_fp}" data-status="${s.status}"/>`,
      )
    }
    if (kind === 'click') {
      for (const c of clicks) {
        if (c.status !== 'ok') continue
        const cx = Math.round((c.box_x + c.box_w * c.rel_x) * w)
        const cy = Math.round((c.box_y + c.box_h * c.rel_y) * h)
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="8" fill="rgba(239,68,68,0.65)" data-el-fp="${c.el_fp}" data-count="${c.click_count}"/>`,
        )
      }
    }
  }
  parts.push('</svg>')
  return parts.join('')
}
