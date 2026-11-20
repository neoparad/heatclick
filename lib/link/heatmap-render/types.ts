/**
 * UGOKI LINK v2 — 束 4-I (§11.12): ヒートマップを絵で返す操作 — 型定義・命名ガード・再現入力契約
 *
 * 設計書 §11.12:
 * - 3 種類: `click`, `scroll_reach`, `section_dwell`（「区画の滞在」のみ許可、「注目」「視線」「要素注意」は禁止）
 * - 分割単位: `(page_url_key, variant_set_hash, skel_fp, css_fp, body_assets_rev, device_class, viewport_width_bucket, render_profile)`
 * - 描画種別 (`render_kind`) は `MeasureStatus` と厳密分離 (`screenshot_overlay` / `wireframe_schematic` / `http_fetch_diagram` / `none`)
 */

import { createHash } from 'node:crypto'

import type { MeasureStatus, UntrustedValue } from '@/packages/contract/response'
import type { DomState } from '@/packages/contract/segmenter'

// ---------------------------------------------------------------------------
// Heatmap Kinds & Terminology Guards (§11.12)
// ---------------------------------------------------------------------------

export type HeatmapKind = 'click' | 'scroll_reach' | 'section_dwell'

export const HEATMAP_KIND_DISPLAY_NAMES: Readonly<Record<HeatmapKind, string>> = Object.freeze({
  click: 'クリック',
  scroll_reach: 'スクロールの到達',
  section_dwell: '区画の滞在',
})

/** §11.12 / tel.U1: Forbidden overclaim labels for section dwell heatmaps */
export const FORBIDDEN_HEATMAP_DWELL_TERMS: readonly string[] = Object.freeze([
  '注目',
  '視線',
  '要素注意',
  '熟読',
  'attention',
  'eye-tracking',
  'gaze',
])

export function assertValidHeatmapDisplayLabel(kind: HeatmapKind, label: string): void {
  if (kind !== 'section_dwell') return
  const low = label.toLowerCase()
  for (const term of FORBIDDEN_HEATMAP_DWELL_TERMS) {
    if (low.includes(term.toLowerCase())) {
      throw new Error(
        `Prohibited section_dwell label term "${term}" detected in "${label}" (§11.12 / tel.U1: must use "区画の滞在")`,
      )
    }
  }
}

export type HeatmapRenderKind =
  | 'screenshot_overlay'
  | 'wireframe_schematic'
  | 'http_fetch_diagram'
  | 'none'

export type HeatmapDataLane = 'standard_telemetry' | 'custom_event'

export type HeatmapDeviceClass = 'desktop' | 'mobile' | 'tablet'

export type HeatmapActorBucket =
  | 'verified_actor'
  | 'explicit_evidence'
  | 'model_inferred'
  | 'undecided_unscorable'
  | 'lab_run'
  | 'http_crawler'

export type HeatmapConsentMode =
  | 'off'
  | 'cookieless'
  | 'essential_first_party'
  | 'full'
  | 'stats_exempt'

export type HeatmapConsentPurpose =
  | 'standard_analytics'
  | 'custom_events'
  | 'automation_detection'

export type HeatmapJurisdiction = 'JP' | 'EU_UK' | 'US_CA' | 'OTHER'

export type HeatmapSdkCapability = 'minimal' | 'light' | 'full'

// ---------------------------------------------------------------------------
// Strict Unit Splitting Key (§11.12 — Never Mix Versions/Variants in 1 Image)
// ---------------------------------------------------------------------------

export interface HeatmapUnitKey {
  readonly page_url_key: string
  readonly variant_set_hash: string
  readonly skel_fp: string | null
  readonly css_fp: string | null
  readonly body_assets_rev: string
  readonly device_class: HeatmapDeviceClass
  readonly viewport_width_bucket: string
  readonly render_profile: string
}

export function serializeHeatmapUnitKey(unit: HeatmapUnitKey): string {
  return [
    unit.page_url_key,
    unit.variant_set_hash,
    unit.skel_fp ?? 'null',
    unit.css_fp ?? 'null',
    unit.body_assets_rev,
    unit.device_class,
    unit.viewport_width_bucket,
    unit.render_profile,
  ].join('|')
}

// ---------------------------------------------------------------------------
// Deterministic Reproducibility Input Bundle (§11.12 Byte-Identical Guarantee)
// ---------------------------------------------------------------------------

export interface HeatmapReproducibilityInputs {
  readonly settled_agg_version: string
  readonly unsettled_snapshot_id: string
  readonly verdict_version: string
  readonly screenshot_sha256: string | null
  readonly layout_hash: string
  readonly renderer_version: string
  readonly font_spec: string
  readonly encoding_spec: 'png-rgba8-zlib6'
  readonly palette_id: 'ugk-thermal-v1'
}

export function computeReproducibilityHash(
  unit: HeatmapUnitKey,
  kind: HeatmapKind,
  actorBucket: HeatmapActorBucket,
  repro: HeatmapReproducibilityInputs,
  metricsDigest: string,
): string {
  const canonical = JSON.stringify({
    unit: serializeHeatmapUnitKey(unit),
    kind,
    actorBucket,
    repro,
    metricsDigest,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Section / Element Metric Inputs & Screenshot Provenance
// ---------------------------------------------------------------------------

export interface HeatmapSectionMetricInput {
  readonly section_uid: string
  readonly sec_fp: string
  readonly heading_label: UntrustedValue
  readonly ordinal: number
  /** Normalized content box in [0, 1] vertical coordinates */
  readonly top_ratio: number
  readonly height_ratio: number
  readonly reach_rate: number | null
  readonly reach_pvs: number
  readonly dwell_center40_ms: number | null
  readonly dwell_pvs: number
  readonly evidence: 'observed' | 'inferred'
  readonly status: MeasureStatus
  readonly pooling_weight?: number
}

export interface HeatmapClickPointInput {
  readonly el_fp: string
  readonly section_uid: string | null
  readonly element_label: UntrustedValue
  /** Element box in normalized [0, 1] viewport/document coordinates */
  readonly box_x: number
  readonly box_y: number
  readonly box_w: number
  readonly box_h: number
  /** Relative click position inside the element [0, 1] × [0, 1] (§4.3, §11.12) */
  readonly rel_x: number
  readonly rel_y: number
  readonly click_count: number
  readonly evidence: 'observed' | 'inferred'
  readonly status: MeasureStatus
}

export interface HeatmapHttpFetchMetricInput {
  readonly status_counts: Readonly<Record<string, number>>
  readonly redirect_count: number
  readonly blocked_count: number
  readonly truncated_count: number
  readonly raw_html_missing_section_count: number
  readonly total_fetches: number
}

export interface RedactionBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly reason: 'pii_region' | 'unauthorized_third_party_content' | 'protected_region'
}

export interface LabScreenshotInput {
  /** §11.12: ONLY lab_render is permitted; visitor_screen / replay_recording are strictly rejected */
  readonly provenance: 'lab_render' | 'visitor_screen' | 'replay_recording'
  readonly snapshot_id: string
  readonly captured_at: string
  readonly screenshot_sha256: string
  readonly width: number
  readonly height: number
  /** Optional raw RGBA pixels (width * height * 4); if omitted, deterministic base tone is generated */
  readonly rgba_pixels?: Uint8Array
  readonly redaction_boxes: readonly RedactionBox[]
  readonly capture_basis: string
  readonly capture_purpose: string
  /** Optional OCR / embedded text harvested from page (ALWAYS treated as UntrustedValue!) */
  readonly embedded_text_samples?: readonly string[]
}

export interface HeatmapUnitDataset {
  readonly unit: HeatmapUnitKey
  readonly dom_state: DomState
  readonly lab_render_pending_job_id?: string | null
  readonly measured_geometry_drift_G: number | null
  readonly claim_gate_passed: boolean
  readonly screenshot: LabScreenshotInput | null
  readonly has_verified_field_layout: boolean
  readonly repro_inputs: HeatmapReproducibilityInputs
  readonly sections: readonly HeatmapSectionMetricInput[]
  readonly clicks: readonly HeatmapClickPointInput[]
  readonly http_fetch_metrics?: HeatmapHttpFetchMetricInput | null
  /** Optional subject set fingerprint IDs used by DisclosureGuard to block differencing attacks */
  readonly subject_ids?: readonly string[]
  readonly total_units_in_segment: number
  readonly contains_video_or_canvas?: boolean
  readonly contains_cross_origin_iframe?: boolean
  readonly is_authenticated_or_personalized_page?: boolean
}
