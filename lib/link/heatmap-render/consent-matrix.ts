/**
 * UGOKI LINK v2 — 束 4-I (§11.12): 種類 × 同意 × 目的 × 法域 × SDK 機能マトリクス & 車線判定
 *
 * 設計書 §11.12 / §4.5 / §11.11:
 * - `consent_mode === 'off'` では行動を一切計測していないため全種類 `not_collected`。
 * - `section_dwell` は SDK `light` または `full` のみ対応（`minimal` では `not_collected`）。
 * - `custom_event` 車線はページ・版・位置に対応づけ可能かつ目的 `custom_events` 許可時のみ別画像として許可、
 *   不可なら `not_applicable`（標準計測と混ぜない）。
 * - 動画・canvas・別オリジン枠・ログイン後ページは取得粒度の限界を `limitations[]` へ必ず明記する。
 */

import type { MeasureStatus } from '@/packages/contract/response'

import type {
  HeatmapConsentMode,
  HeatmapConsentPurpose,
  HeatmapDataLane,
  HeatmapJurisdiction,
  HeatmapKind,
  HeatmapSdkCapability,
} from './types'

export interface HeatmapConsentEligibilityInput {
  readonly kind: HeatmapKind
  readonly lane: HeatmapDataLane
  readonly consent_mode: HeatmapConsentMode
  readonly granted_purposes: readonly HeatmapConsentPurpose[]
  readonly jurisdiction: HeatmapJurisdiction
  readonly sdk_capability: HeatmapSdkCapability
  /** Required only when lane === 'custom_event' */
  readonly custom_event_mapped_to_page_version_position?: boolean
  readonly contains_video_or_canvas?: boolean
  readonly contains_cross_origin_iframe?: boolean
  readonly is_authenticated_or_personalized_page?: boolean
}

export interface HeatmapConsentEligibilityResult {
  readonly eligible: boolean
  readonly status: Extract<MeasureStatus, 'ok' | 'not_collected' | 'not_applicable' | 'not_entitled'>
  readonly lane: HeatmapDataLane
  readonly source_provenance: 'standard_telemetry' | 'customer_defined_event'
  readonly reason: string
  readonly limitations: readonly string[]
}

export function evaluateHeatmapConsentEligibility(
  input: HeatmapConsentEligibilityInput,
): HeatmapConsentEligibilityResult {
  const limitations: string[] = []

  if (input.contains_video_or_canvas) {
    limitations.push(
      'video_or_canvas_granularity_limit: Only outer element box/position is captured; inner playback/canvas pixels are not observed (§11.12)',
    )
  }
  if (input.contains_cross_origin_iframe) {
    limitations.push(
      'cross_origin_iframe_granularity_limit: Same-Origin Policy restricts capture to outer frame bounds only (tel.U5 / §11.12)',
    )
  }
  if (input.is_authenticated_or_personalized_page) {
    limitations.push(
      'authenticated_or_personalized_page: Background screenshot overlay disabled; wireframe schematic returned only when valid structure and aggregates exist (§11.12)',
    )
  }
  if (input.kind === 'section_dwell') {
    limitations.push(
      'section_dwell_definition: Measures time section remained in center 40% viewport band ("区画の滞在"); does not claim gaze, attention, or comprehension (tel.U1 / §11.12)',
    )
  }

  const provenance: HeatmapConsentEligibilityResult['source_provenance'] =
    input.lane === 'custom_event' ? 'customer_defined_event' : 'standard_telemetry'

  // 1. Consent OFF -> ALL heatmap kinds are strictly not_collected (§11.12)
  if (input.consent_mode === 'off') {
    return Object.freeze({
      eligible: false,
      status: 'not_collected',
      lane: input.lane,
      source_provenance: provenance,
      reason: 'consent_mode_off_no_behavioral_collection',
      limitations: Object.freeze(limitations),
    })
  }

  // 2. Customer-defined event lane rules (§11.11 / §11.12)
  if (input.lane === 'custom_event') {
    if (input.consent_mode === 'stats_exempt') {
      return Object.freeze({
        eligible: false,
        status: 'not_entitled',
        lane: input.lane,
        source_provenance: provenance,
        reason: 'custom_events_prohibited_under_stats_exempt',
        limitations: Object.freeze(limitations),
      })
    }
    if (!input.granted_purposes.includes('custom_events')) {
      return Object.freeze({
        eligible: false,
        status: 'not_collected',
        lane: input.lane,
        source_provenance: provenance,
        reason: 'missing_custom_events_consent_purpose',
        limitations: Object.freeze(limitations),
      })
    }
    if (!input.custom_event_mapped_to_page_version_position) {
      return Object.freeze({
        eligible: false,
        status: 'not_applicable',
        lane: input.lane,
        source_provenance: provenance,
        reason: 'custom_event_unmapped_to_page_version_position',
        limitations: Object.freeze(limitations),
      })
    }
    limitations.push(
      'custom_event_lane_separate_image: Rendered from customer-defined events only; never blended with standard telemetry or cross-tenant pooling (§11.11)',
    )
    return Object.freeze({
      eligible: true,
      status: 'ok',
      lane: input.lane,
      source_provenance: provenance,
      reason: 'eligible_custom_event_lane',
      limitations: Object.freeze(limitations),
    })
  }

  // 3. Standard telemetry lane: check jurisdiction + purpose + SDK capability
  if (
    input.jurisdiction === 'EU_UK' &&
    input.consent_mode === 'cookieless' &&
    !input.granted_purposes.includes('standard_analytics')
  ) {
    return Object.freeze({
      eligible: false,
      status: 'not_collected',
      lane: input.lane,
      source_provenance: provenance,
      reason: 'eu_uk_requires_standard_analytics_purpose',
      limitations: Object.freeze(limitations),
    })
  }

  if (input.kind === 'section_dwell' && input.sdk_capability === 'minimal') {
    return Object.freeze({
      eligible: false,
      status: 'not_collected',
      lane: input.lane,
      source_provenance: provenance,
      reason: 'section_dwell_requires_light_or_full_sdk',
      limitations: Object.freeze(limitations),
    })
  }

  return Object.freeze({
    eligible: true,
    status: 'ok',
    lane: input.lane,
    source_provenance: provenance,
    reason: 'eligible_standard_telemetry',
    limitations: Object.freeze(limitations),
  })
}
