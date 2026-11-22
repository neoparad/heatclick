/**
 * UGOKI LINK v2 — 束 2-C (手順 5): 操作可能性の監査 (§7.6 計器 A / ゲート `act.G19`)
 *
 * 通信量ゼロ (`n = 0` PV) でも有効な `observed` 監査。
 * 成果までの道筋にある各要素（アフィリエイトリンク・CTA リンク・ボタン・フォーム入力欄）が
 *   ① アクセシビリティツリー（role / accessible name / focusable / aria-hidden / disabled）
 *   ② DOM 構造（ネイティブ操作要素 / 有効な遷移先 / label 紐付け / pointer-events）
 *   ③ 画素・配置（タップサイズ / 画面外・ゼロサイズ / 重なり遮蔽 / ホバー限定出現）
 * の 3 面で AI エージェントから到達可能かを評価し、共通返答形式 (`packages/contract/response`) で返す。
 *
 * 設計根拠:
 * - マスター設計書 v2 §7.6 A, §11.5
 * - actors-final.md M6 A, C.M6 A, Gate G19
 * - packages/contract/response (Invariants I1–I7)
 */

import { createHash } from 'node:crypto'

import {
  buildResponseEnvelope,
  createDataLayerMetric,
  wrapUntrusted,
  type ActiveEvidenceRef,
  type EvidenceBlock,
  type MeasureInput,
  type ResidencyBlock,
  type SerializedResponseEnvelope,
  type UnmetGate,
  type UntrustedValue,
  type VerifiedNumericLeaf,
} from '@/packages/contract/response'

import type { RenderPageResult, RenderedElementDetails } from './secondary-renderer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const OPERABILITY_MIN_TAP_TARGET_PX = 24
export const ACT_G19_MIN_THREE_CHANNEL_COVERAGE = 0.95

export type A11yDefectCode =
  | 'missing_role'
  | 'missing_accessible_name'
  | 'not_focusable'
  | 'aria_hidden'
  | 'disabled'

export type DomStructureDefectCode =
  | 'non_native_scripted_control'
  | 'missing_or_script_href'
  | 'unbound_form_label'
  | 'pointer_events_none'

export type PixelLayoutDefectCode =
  | 'zero_size_box'
  | 'tap_target_too_small'
  | 'offscreen_element'
  | 'occluded_by_overlay'
  | 'hover_only_reveal'

export interface ElementOperabilityAssessment {
  readonly el_fp: string
  readonly sec_fp: string | null
  readonly slot_id: string
  readonly kind: string
  readonly region: 'root' | 'chrome'
  readonly is_affiliate_link: boolean
  readonly accessible_name: UntrustedValue | null
  readonly href: UntrustedValue | null
  readonly channels: {
    readonly a11y: {
      readonly measured: true
      readonly reachable: boolean
      readonly role: string | null
      readonly focusable: boolean
      readonly defects: readonly A11yDefectCode[]
    }
    readonly dom: {
      readonly measured: true
      readonly reachable: boolean
      readonly is_native_control: boolean
      readonly has_label_binding: boolean
      readonly defects: readonly DomStructureDefectCode[]
    }
    readonly pixel: {
      readonly measured: boolean
      readonly reachable: boolean | null
      readonly width_px: number | null
      readonly height_px: number | null
      readonly occluded: boolean | null
      readonly hover_only_reveal: boolean | null
      readonly defects: readonly PixelLayoutDefectCode[]
    }
  }
  readonly all_three_measured: boolean
  /** Strictly null when pixel channel is unmeasured (no guessing / no 0-substitution) */
  readonly reachable_all_three: boolean | null
}

export interface OperabilityAuditOptions {
  /** Restrict audit to specific conversion-path element fingerprints */
  readonly conversion_el_fps?: readonly string[]
  /** Include chrome region interactive controls (default: false -> focus on root conversion path + affiliate links) */
  readonly include_chrome?: boolean
  /** Minimum tap target width/height in px (default: 24px per WCAG 2.2 AA) */
  readonly min_tap_target_px?: number
  /** Snapshot reference ID for active evidence provenance (Invariant I6) */
  readonly snapshot_ref_id?: string
  /** Residency metadata for unified response envelope (§11.11 item 13) */
  readonly residency?: ResidencyBlock
  /** Audit timestamp UTC ISO-8601 (defaults to render.rendered_at) */
  readonly audited_at?: string
}

export interface OperabilityAuditResult {
  readonly envelope: SerializedResponseEnvelope
  readonly gate_act_g19_passed: boolean
  readonly three_channel_coverage_ratio: number
  readonly elements: readonly ElementOperabilityAssessment[]
}

// ---------------------------------------------------------------------------
// Conversion-Path Selection & 3-Channel Evaluator
// ---------------------------------------------------------------------------

const CONVERSION_ELEMENT_KINDS = new Set(['link', 'button', 'field'])

function isConversionPathElement(
  el: RenderedElementDetails,
  explicitSet: ReadonlySet<string> | null,
  includeChrome: boolean,
): boolean {
  if (explicitSet) {
    return explicitSet.has(el.el_fp)
  }
  if (!CONVERSION_ELEMENT_KINDS.has(el.kind)) return false
  if (el.is_affiliate_link) return true
  if (includeChrome) return true
  return el.region === 'root'
}

export function evaluateElementOperability(
  el: RenderedElementDetails,
  viewport: { readonly width: number; readonly height: number },
  minTapTargetPx = OPERABILITY_MIN_TAP_TARGET_PX,
): ElementOperabilityAssessment {
  // Channel 1: Accessibility tree
  const a11yDefects: A11yDefectCode[] = []
  if (!el.role) a11yDefects.push('missing_role')
  if (!el.accessible_name || el.accessible_name.trim().length === 0) {
    a11yDefects.push('missing_accessible_name')
  }
  if (el.aria_hidden) a11yDefects.push('aria_hidden')
  if (el.disabled) a11yDefects.push('disabled')
  if (!el.focusable && !el.aria_hidden && !el.disabled) {
    a11yDefects.push('not_focusable')
  }
  const a11yReachable = a11yDefects.length === 0

  // Channel 2: DOM structure
  const domDefects: DomStructureDefectCode[] = []
  if (!el.is_native_control) {
    domDefects.push('non_native_scripted_control')
  }
  if (el.kind === 'link') {
    const h = (el.href ?? '').trim()
    if (!h || h === '#' || /^javascript:/i.test(h)) {
      domDefects.push('missing_or_script_href')
    }
  }
  if (el.kind === 'field' && !el.has_label_binding) {
    domDefects.push('unbound_form_label')
  }
  if (el.pointer_events_none === true) {
    domDefects.push('pointer_events_none')
  }
  const domReachable = domDefects.length === 0

  // Channel 3: Pixel / layout geometry
  const pixelDefects: PixelLayoutDefectCode[] = []
  let pixelMeasured = false
  let pixelReachable: boolean | null = null

  if (el.rect !== null) {
    pixelMeasured = true
    if (el.rect.width <= 0 || el.rect.height <= 0) {
      pixelDefects.push('zero_size_box')
    } else if (el.rect.width < minTapTargetPx || el.rect.height < minTapTargetPx) {
      pixelDefects.push('tap_target_too_small')
    }

    const isOffscreen =
      el.rect.x + el.rect.width <= 0 ||
      el.rect.x >= viewport.width ||
      el.rect.y + el.rect.height <= 0
    if (isOffscreen && !pixelDefects.includes('zero_size_box')) {
      pixelDefects.push('offscreen_element')
    }

    if (el.occluded === true) {
      pixelDefects.push('occluded_by_overlay')
    }
    if (el.hover_only_reveal === true) {
      pixelDefects.push('hover_only_reveal')
    }
    pixelReachable = pixelDefects.length === 0
  }

  const allThreeMeasured = pixelMeasured
  const reachableAllThree =
    allThreeMeasured && pixelReachable !== null
      ? a11yReachable && domReachable && pixelReachable
      : null

  return Object.freeze({
    el_fp: el.el_fp,
    sec_fp: el.sec_fp,
    slot_id: el.slot_id,
    kind: el.kind,
    region: el.region,
    is_affiliate_link: el.is_affiliate_link,
    accessible_name:
      el.accessible_name !== null ? wrapUntrusted(el.accessible_name, 'click_text') : null,
    href: el.href !== null ? wrapUntrusted(el.href, 'url') : null,
    channels: Object.freeze({
      a11y: Object.freeze({
        measured: true as const,
        reachable: a11yReachable,
        role: el.role,
        focusable: el.focusable,
        defects: Object.freeze(a11yDefects),
      }),
      dom: Object.freeze({
        measured: true as const,
        reachable: domReachable,
        is_native_control: el.is_native_control,
        has_label_binding: el.has_label_binding,
        defects: Object.freeze(domDefects),
      }),
      pixel: Object.freeze({
        measured: pixelMeasured,
        reachable: pixelReachable,
        width_px: el.rect ? el.rect.width : null,
        height_px: el.rect ? el.rect.height : null,
        occluded: el.occluded,
        hover_only_reveal: el.hover_only_reveal,
        defects: Object.freeze(pixelDefects),
      }),
    }),
    all_three_measured: allThreeMeasured,
    reachable_all_three: reachableAllThree,
  })
}

// ---------------------------------------------------------------------------
// Main Audit Entry Point (Returns Canonical `SerializedResponseEnvelope`)
// ---------------------------------------------------------------------------

export function runOperabilityAudit(
  render: RenderPageResult,
  options?: OperabilityAuditOptions,
): OperabilityAuditResult {
  const auditedAt = options?.audited_at ?? render.rendered_at
  const minTapPx = options?.min_tap_target_px ?? OPERABILITY_MIN_TAP_TARGET_PX
  const includeChrome = options?.include_chrome ?? false
  const explicitSet = options?.conversion_el_fps ? new Set(options.conversion_el_fps) : null
  const residency: ResidencyBlock = options?.residency ?? {
    storage_region: 'jp-tokyo',
    processing_region: 'jp-tokyo',
  }

  const refId =
    options?.snapshot_ref_id ??
    `lab_render_${render.url_key_result.url_id_hex}_${render.profile.profile_id}`
  const validUntil = new Date(Date.parse(auditedAt) + 30 * 24 * 60 * 60 * 1000).toISOString()

  const paramsHash = createHash('sha256')
    .update(
      JSON.stringify({
        tenant_id: render.tenant_id,
        site_id: render.site_id,
        url_id: render.url_key_result.url_id,
        profile_id: render.profile.profile_id,
        variant_set_key: render.variant_set_key,
        segmenter_hash: render.segmenter_hash,
      }),
      'utf8',
    )
    .digest('hex')

  // Render failed or blocked -> return not_collected envelope with unmet act.G19 gate
  if (render.status !== 'ok' || !render.segmenter_output) {
    const resultDigest = createHash('sha256').update(`unrendered:${render.status}`, 'utf8').digest('hex')
    const activeRef: ActiveEvidenceRef = {
      ref_id: refId,
      kind: 'snapshot',
      params_hash: paramsHash,
      watermarks: { rendered_at: render.rendered_at },
      result_digest: resultDigest,
      issued_at: auditedAt,
      valid_until: validUntil,
      kid: 'lab-audit-v1',
    }
    const baseEvidence: EvidenceBlock = {
      level: 'observed',
      exactness: 'exact',
      criteria: [],
      refs: [activeRef],
      scope: `page:${render.url_key_result.url_id_hex}|profile:${render.profile.profile_id}|variant:${render.variant_set_key}`,
      as_of_state: 'confirmed',
    }
    const unmet: UnmetGate = {
      id: 'act.G19',
      required: ACT_G19_MIN_THREE_CHANNEL_COVERAGE,
      observed: 0,
      reason: render.status,
      unlock: render.unlock ?? 'Complete full lab render for target page',
    }

    const notCollectedCell = (unit: string): MeasureInput<VerifiedNumericLeaf> => ({
      value: null,
      unit,
      status: 'not_collected',
      reason: render.status,
      evidence: baseEvidence,
      sample: null,
      interval: null,
      unmet_gates: [unmet],
    })

    const envelope = buildResponseEnvelope({
      window: { start: render.rendered_at, end: auditedAt, timezone: 'UTC' },
      freshness: {
        data_through: render.rendered_at,
        lag_s: 0,
        sources: { lab_renderer: render.executor_id },
        stale: false,
      },
      coverage: { ratio: 0, denominator_n: 0 },
      lineage: {
        schema_version: '2.0',
        def_ver: 1,
        collection_gen: 'v3',
      },
      residency,
      measures: {
        conversion_elements_audited: notCollectedCell('elements'),
        three_channel_coverage_ratio: notCollectedCell('ratio'),
        all_three_reachable_ratio: notCollectedCell('ratio'),
        a11y_reachable_ratio: notCollectedCell('ratio'),
        dom_reachable_ratio: notCollectedCell('ratio'),
        pixel_reachable_ratio: notCollectedCell('ratio'),
        unreachable_element_count: notCollectedCell('elements'),
      },
      data: {
        instrument: 'A_operability_audit',
        page_url: wrapUntrusted(render.final_url, 'url'),
        url_id: render.url_key_result.url_id,
        profile_id: render.profile.profile_id,
        device_class: render.profile.device_class,
        variant_set_key: render.variant_set_key,
        skel_fp: null,
        segmenter_hash: render.segmenter_hash,
        elements: [],
      },
    })

    return Object.freeze({
      envelope,
      gate_act_g19_passed: false,
      three_channel_coverage_ratio: 0,
      elements: Object.freeze([]),
    })
  }

  // Evaluate all conversion-path elements across the 3 channels
  const targets = render.element_details.filter((el) =>
    isConversionPathElement(el, explicitSet, includeChrome),
  )
  const assessments = Object.freeze(
    targets.map((el) => evaluateElementOperability(el, render.profile.viewport, minTapPx)),
  )

  const total = assessments.length
  const threeChannelMeasuredCount = assessments.filter((a) => a.all_three_measured).length
  const a11yOkCount = assessments.filter((a) => a.channels.a11y.reachable).length
  const domOkCount = assessments.filter((a) => a.channels.dom.reachable).length
  const pixelOkCount = assessments.filter((a) => a.channels.pixel.reachable === true).length
  const allThreeOkCount = assessments.filter((a) => a.reachable_all_three === true).length
  const unreachableAllThreeCount = assessments.filter((a) => a.reachable_all_three === false).length

  const threeChannelCoverage = total === 0 ? 1 : Number((threeChannelMeasuredCount / total).toFixed(4))
  const gateActG19Passed = total === 0 ? true : threeChannelCoverage >= ACT_G19_MIN_THREE_CHANNEL_COVERAGE

  const resultDigest = createHash('sha256')
    .update(
      JSON.stringify({
        skel_fp: render.segmenter_output.skel_fp,
        total,
        threeChannelMeasuredCount,
        a11yOkCount,
        domOkCount,
        pixelOkCount,
        allThreeOkCount,
      }),
      'utf8',
    )
    .digest('hex')

  const activeRef: ActiveEvidenceRef = {
    ref_id: refId,
    kind: 'snapshot',
    params_hash: paramsHash,
    watermarks: { rendered_at: render.rendered_at },
    result_digest: resultDigest,
    issued_at: auditedAt,
    valid_until: validUntil,
    kid: 'lab-audit-v1',
  }

  const observedEvidence: EvidenceBlock = {
    level: 'observed',
    exactness: 'exact',
    criteria: [],
    refs: [activeRef],
    scope: `page:${render.url_key_result.url_id_hex}|profile:${render.profile.profile_id}|variant:${render.variant_set_key}`,
    as_of_state: 'confirmed',
  }

  const metric = (val: number) =>
    createDataLayerMetric(val, refId, { authority: 'data_layer', createdAt: auditedAt })

  const unmetG19: UnmetGate = {
    id: 'act.G19',
    required: ACT_G19_MIN_THREE_CHANNEL_COVERAGE,
    observed: threeChannelCoverage,
    reason: 'pixel_channel_unmeasured',
    unlock: 'Run full lab render with layout geometry & occlusion checks for >= 95% of conversion-path elements',
  }

  const noElementsGate: UnmetGate = {
    id: 'no_conversion_path_elements',
    required: 1,
    observed: 0,
    reason: 'no_conversion_path_elements',
    unlock: 'render_page_with_conversion_elements',
  }

  const wrapDataNumerics = (node: unknown): unknown => {
    if (typeof node === 'number' && Number.isFinite(node)) {
      return metric(node)
    }
    if (node === null || node === undefined || typeof node !== 'object') {
      return node
    }
    if (Array.isArray(node)) {
      return node.map((item) => wrapDataNumerics(item))
    }
    const obj = node as Record<string, unknown>
    if (obj.__untrusted === true || obj.__verified_metric === true) {
      return node
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = wrapDataNumerics(v)
    }
    return out
  }

  const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {
    conversion_elements_audited: {
      value: metric(total),
      unit: 'elements',
      status: 'ok',
      evidence: observedEvidence,
      sample: { n: total, unit_kind: 'conversion_element' },
      interval: null,
    },
    three_channel_coverage_ratio: {
      value: total === 0 ? null : metric(threeChannelCoverage),
      unit: 'ratio',
      status: total === 0 ? 'not_applicable' : 'ok',
      ...(total === 0 ? { reason: 'no_conversion_path_elements', unmet_gates: [noElementsGate] } : {}),
      evidence: observedEvidence,
      sample: total === 0 ? null : { n: total, unit_kind: 'conversion_element' },
      interval: null,
    },
    a11y_reachable_ratio: {
      value: total === 0 ? null : metric(Number((a11yOkCount / total).toFixed(4))),
      unit: 'ratio',
      status: total === 0 ? 'not_applicable' : 'ok',
      ...(total === 0 ? { reason: 'no_conversion_path_elements', unmet_gates: [noElementsGate] } : {}),
      evidence: observedEvidence,
      sample: total === 0 ? null : { n: total, unit_kind: 'conversion_element' },
      interval: null,
    },
    dom_reachable_ratio: {
      value: total === 0 ? null : metric(Number((domOkCount / total).toFixed(4))),
      unit: 'ratio',
      status: total === 0 ? 'not_applicable' : 'ok',
      ...(total === 0 ? { reason: 'no_conversion_path_elements', unmet_gates: [noElementsGate] } : {}),
      evidence: observedEvidence,
      sample: total === 0 ? null : { n: total, unit_kind: 'conversion_element' },
      interval: null,
    },
    pixel_reachable_ratio:
      total === 0
        ? {
            value: null,
            unit: 'ratio',
            status: 'not_applicable',
            reason: 'no_conversion_path_elements',
            unmet_gates: [noElementsGate],
            evidence: observedEvidence,
            sample: null,
            interval: null,
          }
        : gateActG19Passed
          ? {
              value: metric(Number((pixelOkCount / total).toFixed(4))),
              unit: 'ratio',
              status: 'ok',
              evidence: observedEvidence,
              sample: { n: threeChannelMeasuredCount, unit_kind: 'conversion_element' },
              interval: null,
            }
          : {
              value: null,
              unit: 'ratio',
              status: 'not_collected',
              reason: 'pixel_channel_unmeasured',
              evidence: observedEvidence,
              sample: null,
              interval: null,
              unmet_gates: [unmetG19],
            },
    all_three_reachable_ratio:
      total === 0
        ? {
            value: null,
            unit: 'ratio',
            status: 'not_applicable',
            reason: 'no_conversion_path_elements',
            evidence: observedEvidence,
            sample: null,
            interval: null,
          }
        : gateActG19Passed
          ? {
              value: metric(Number((allThreeOkCount / total).toFixed(4))),
              unit: 'ratio',
              status: 'ok',
              evidence: observedEvidence,
              sample: { n: threeChannelMeasuredCount, unit_kind: 'conversion_element' },
              interval: null,
            }
          : {
              value: null,
              unit: 'ratio',
              status: 'not_collected',
              reason: 'pixel_channel_unmeasured',
              evidence: observedEvidence,
              sample: null,
              interval: null,
              unmet_gates: [unmetG19],
            },
    unreachable_element_count:
      total === 0
        ? {
            value: metric(0),
            unit: 'elements',
            status: 'ok',
            evidence: observedEvidence,
            sample: { n: 0, unit_kind: 'conversion_element' },
            interval: null,
          }
        : gateActG19Passed
          ? {
              value: metric(unreachableAllThreeCount),
              unit: 'elements',
              status: 'ok',
              evidence: observedEvidence,
              sample: { n: threeChannelMeasuredCount, unit_kind: 'conversion_element' },
              interval: null,
            }
          : {
              value: null,
              unit: 'elements',
              status: 'not_collected',
              reason: 'pixel_channel_unmeasured',
              evidence: observedEvidence,
              sample: null,
              interval: null,
              unmet_gates: [unmetG19],
            },
  }

  const envelope = buildResponseEnvelope({
    window: { start: render.rendered_at, end: auditedAt, timezone: 'UTC' },
    freshness: {
      data_through: render.rendered_at,
      lag_s: 0,
      sources: { lab_renderer: render.executor_id },
      stale: false,
    },
    coverage: {
      ratio: threeChannelCoverage,
      denominator_n: total,
    },
    lineage: {
      schema_version: '2.0',
      def_ver: 1,
      collection_gen: 'v3',
    },
    residency,
    measures,
    data: {
      instrument: 'A_operability_audit',
      page_url: wrapUntrusted(render.final_url, 'url'),
      url_id: render.url_key_result.url_id,
      profile_id: render.profile.profile_id,
      device_class: render.profile.device_class,
      variant_set_key: render.variant_set_key,
      skel_fp: render.segmenter_output.skel_fp,
      segmenter_hash: render.segmenter_hash,
      gate_act_g19_passed: gateActG19Passed,
      elements: wrapDataNumerics(assessments),
    },
  })

  return Object.freeze({
    envelope,
    gate_act_g19_passed: gateActG19Passed,
    three_channel_coverage_ratio: threeChannelCoverage,
    elements: assessments,
  })
}
