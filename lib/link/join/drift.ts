/**
 * UGOKI LINK v2 — 束 4-D (手順 13): ずれ指標 (`M_sec`, `M_sec_u`, `O`, `G`) & 再描画トリガー生成器
 *
 * 設計書 §6.2 / join-final.md M2, M7:
 * - 実訪問の実測配置図 (field geometry) と検査環境配置図 (lab geometry) から、
 *   広告・同意バナーの高さを両側から差し引いた本文座標系で以下を算出:
 *   - `M_sec`: 注視時間重み付きの区画一致率
 *   - `M_sec_u`: 等重みの区画一致率
 *   - `O`: 順序ずれ (`1 - LCS / |intersection|`)
 *   - `G`: 注視時間重み付きの位置ずれ (`Σ w_s * |c_s(field) - c_s(lab)|`)
 * - 再描画スケジューラ要求の判定:
 *   - ID 描画 (`identity_render`): `M_sec < 0.90` / `M_sec_u < 0.90` / `O > 0.10` / 未知 `skel_fp`
 *   - 本文変更 (既知 `skel_fp` + 未知 `body_fp`): まず `light_html_fetch`、生 HTML に新本文が無ければ `identity_render`
 *   - 全描画 (`full_render`): `css_fp` 変化（揺らぎ判定済み除外）/ 高さ中央値 ≥5% 変動 / `G > 0.08` / `slot_fp` 変化
 *   - 2 回非再現 (`lab_unreproducible`): 実訪問側キーが変わるまで再描画費用停止
 * - 検査環境の位置・画面写真・押しやすさが有効なのは `full_render` かつ `skel_fp`・`css_fp` 一致かつ `G <= 0.08` のみ。
 */

// ---------------------------------------------------------------------------
// Constants (Master Architecture v2 §6.2)
// ---------------------------------------------------------------------------

export const DRIFT_M_SEC_THRESHOLD = 0.9
export const DRIFT_ORDER_O_THRESHOLD = 0.1
export const DRIFT_GEOMETRY_G_THRESHOLD = 0.08
export const DRIFT_DOC_HEIGHT_SHIFT_THRESHOLD = 0.05

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SectionLayoutBox {
  readonly sec_fp: string
  readonly ordinal: number
  readonly top_px: number
  readonly height_px: number
  /** Field focal dwell ms (ignored on lab side; defaults to 1 when unweighted) */
  readonly focal_ms?: number
  /** Sum of pruned ad container heights above this section */
  readonly pruned_ad_height_above_px?: number
  /** Sum of pruned consent banner heights above this section */
  readonly pruned_consent_height_above_px?: number
}

export interface LayoutGeometryMap {
  readonly doc_h_px: number
  readonly total_pruned_ad_height_px?: number
  readonly total_pruned_consent_height_px?: number
  readonly sections: readonly SectionLayoutBox[]
}

export interface DriftMetricsResult {
  readonly field_section_count: number
  readonly lab_section_count: number
  readonly matched_section_count: number
  /** Focal-weighted share of field sections present in lab */
  readonly M_sec: number
  /** Unweighted share of field sections present in lab */
  readonly M_sec_u: number
  /** Order drift: 1 - LCS / |matched| */
  readonly O: number
  /** Geometry drift in content coordinates (ad + consent heights subtracted on both sides) */
  readonly G: number
  /** Relative median document height shift: |field_content_h - lab_content_h| / lab_content_h */
  readonly doc_h_rel_shift: number
}

export type RenderTriggerAction =
  | 'none'
  | 'light_html_fetch'
  | 'identity_render'
  | 'full_render'

export interface DriftTriggerInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly variant_set_key: string
  readonly field_skel_fp: string
  readonly field_css_fp: string | null
  readonly field_slot_fp: string | null
  readonly field_unknown_body_fps: readonly string[]
  readonly field_layout: LayoutGeometryMap
  readonly lab_snapshot: {
    readonly snapshot_id: string
    readonly job_class: 'raw_html_id' | 'id_only' | 'identity_render' | 'full' | 'full_render'
    readonly skel_fp: string | null
    readonly css_fp: string | null
    readonly slot_fp: string | null
    readonly css_volatile: boolean
    readonly layout: LayoutGeometryMap | null
  } | null
  /** True if 2 consecutive renders failed to reproduce this exact field fingerprint (§6.2) */
  readonly lab_unreproducible_for_field_fp?: boolean
  /** When evaluating unknown body_fp, whether light raw HTML fetch already ran and lacked the new body */
  readonly light_html_fetch_lacked_new_body?: boolean
}

export interface DriftTriggerDecision {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_id: string
  readonly variant_set_key: string
  readonly action: RenderTriggerAction
  readonly trigger_reasons: readonly string[]
  readonly drift: DriftMetricsResult | null
  /** §6.2: Lab position / screenshot / operability valid ONLY when skel_fp & css_fp match and G <= 0.08 */
  readonly visual_facts_valid: boolean
  readonly visual_invalidation_reasons: readonly string[]
  readonly spend_halted_unreproducible: boolean
}

// ---------------------------------------------------------------------------
// Core Math: Content Coordinates, LCS, M_sec, M_sec_u, O, G
// ---------------------------------------------------------------------------

function computeContentNormalizedCenter(
  box: SectionLayoutBox,
  contentDocH: number,
): number {
  const adAbove = box.pruned_ad_height_above_px ?? 0
  const consentAbove = box.pruned_consent_height_above_px ?? 0
  const adjustedTop = Math.max(0, box.top_px - adAbove - consentAbove)
  const center = adjustedTop + Math.max(0, box.height_px) / 2
  return Math.min(1, Math.max(0, center / Math.max(1, contentDocH)))
}

function longestCommonSubsequenceLength(a: readonly string[], b: readonly string[]): number {
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return 0

  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1]
      }
    }
    const tmp = prev
    prev = curr
    curr = tmp
    curr.fill(0)
  }

  return prev[n]
}

export function computeLayoutDriftMetrics(
  field: LayoutGeometryMap,
  lab: LayoutGeometryMap,
): DriftMetricsResult {
  const fieldContentH = Math.max(
    1,
    field.doc_h_px -
      (field.total_pruned_ad_height_px ?? 0) -
      (field.total_pruned_consent_height_px ?? 0),
  )
  const labContentH = Math.max(
    1,
    lab.doc_h_px -
      (lab.total_pruned_ad_height_px ?? 0) -
      (lab.total_pruned_consent_height_px ?? 0),
  )

  const docHRelShift = Math.abs(fieldContentH - labContentH) / labContentH

  const labMap = new Map<string, SectionLayoutBox>()
  for (const s of lab.sections) {
    if (!labMap.has(s.sec_fp)) labMap.set(s.sec_fp, s)
  }

  const fieldSorted = [...field.sections].sort((a, b) => a.ordinal - b.ordinal)
  const labSorted = [...lab.sections].sort((a, b) => a.ordinal - b.ordinal)

  if (fieldSorted.length === 0) {
    return Object.freeze({
      field_section_count: 0,
      lab_section_count: labSorted.length,
      matched_section_count: 0,
      M_sec: 0,
      M_sec_u: 0,
      O: 1,
      G: 1,
      doc_h_rel_shift: docHRelShift,
    })
  }

  let totalFocal = 0
  let matchedFocal = 0
  let matchedCount = 0

  const matchedFieldBoxes: Array<{ field: SectionLayoutBox; lab: SectionLayoutBox; w: number }> = []
  const fieldMatchedOrder: string[] = []
  const matchedSet = new Set<string>()

  for (const fs of fieldSorted) {
    const focal = Math.max(0, fs.focal_ms ?? 1)
    totalFocal += focal
    const ls = labMap.get(fs.sec_fp)
    if (ls) {
      matchedCount++
      matchedFocal += focal
      fieldMatchedOrder.push(fs.sec_fp)
      matchedSet.add(fs.sec_fp)
      matchedFieldBoxes.push({ field: fs, lab: ls, w: focal })
    }
  }

  const M_sec_u = matchedCount / fieldSorted.length
  const M_sec = totalFocal > 0 ? matchedFocal / totalFocal : M_sec_u

  const labMatchedOrder = labSorted
    .filter((s) => matchedSet.has(s.sec_fp))
    .map((s) => s.sec_fp)

  const lcs = longestCommonSubsequenceLength(fieldMatchedOrder, labMatchedOrder)
  const O = matchedCount > 0 ? 1 - lcs / matchedCount : 1

  let G = 1
  if (matchedFieldBoxes.length > 0) {
    const sumW = matchedFieldBoxes.reduce((acc, p) => acc + p.w, 0)
    let weightedDiff = 0
    for (const pair of matchedFieldBoxes) {
      const weight = sumW > 0 ? pair.w / sumW : 1 / matchedFieldBoxes.length
      const cf = computeContentNormalizedCenter(pair.field, fieldContentH)
      const cl = computeContentNormalizedCenter(pair.lab, labContentH)
      weightedDiff += weight * Math.abs(cf - cl)
    }
    G = weightedDiff
  }

  return Object.freeze({
    field_section_count: fieldSorted.length,
    lab_section_count: labSorted.length,
    matched_section_count: matchedCount,
    M_sec,
    M_sec_u,
    O,
    G,
    doc_h_rel_shift: docHRelShift,
  })
}

// ---------------------------------------------------------------------------
// Re-render Trigger & Visual Validity Evaluator (§6.2)
// ---------------------------------------------------------------------------

export function evaluateDriftAndRenderTrigger(input: DriftTriggerInput): DriftTriggerDecision {
  const visualInvalidation: string[] = []
  const triggerReasons: string[] = []

  // Spend halt after 2 non-reproducing renders until field fingerprint changes (§6.2)
  if (input.lab_unreproducible_for_field_fp) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      page_id: input.page_id,
      variant_set_key: input.variant_set_key,
      action: 'none',
      trigger_reasons: Object.freeze([]),
      drift:
        input.lab_snapshot?.layout
          ? computeLayoutDriftMetrics(input.field_layout, input.lab_snapshot.layout)
          : null,
      visual_facts_valid: false,
      visual_invalidation_reasons: Object.freeze(['lab_unreproducible']),
      spend_halted_unreproducible: true,
    })
  }

  // Case 1: No lab snapshot exists at all -> unknown skel_fp -> identity_render (or full_render if first time)
  if (!input.lab_snapshot) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      page_id: input.page_id,
      variant_set_key: input.variant_set_key,
      action: 'identity_render',
      trigger_reasons: Object.freeze(['unknown_skel_fp_no_snapshot']),
      drift: null,
      visual_facts_valid: false,
      visual_invalidation_reasons: Object.freeze(['no_lab_snapshot']),
      spend_halted_unreproducible: false,
    })
  }

  const snap = input.lab_snapshot
  const drift = snap.layout ? computeLayoutDriftMetrics(input.field_layout, snap.layout) : null

  const skelMatches = snap.skel_fp !== null && snap.skel_fp === input.field_skel_fp
  const cssChanged =
    input.field_css_fp !== null && snap.css_fp !== null && input.field_css_fp !== snap.css_fp
  const slotChanged =
    input.field_slot_fp !== null && snap.slot_fp !== null && input.field_slot_fp !== snap.slot_fp

  // Visual facts validity (§6.2): ONLY when full render + skel_fp match + css_fp match + G <= 0.08
  if (snap.job_class !== 'full' && snap.job_class !== 'full_render') {
    visualInvalidation.push('not_full_render')
  }
  if (!skelMatches) visualInvalidation.push('skel_fp_mismatch')
  if (cssChanged || input.field_css_fp === null || snap.css_fp === null) {
    visualInvalidation.push('css_fp_mismatch')
  }
  if (!drift) {
    visualInvalidation.push('missing_lab_layout')
  } else if (drift.G > DRIFT_GEOMETRY_G_THRESHOLD) {
    visualInvalidation.push(`geometry_drift_G_exceeded:${drift.G.toFixed(4)}`)
  }
  const visualFactsValid = visualInvalidation.length === 0

  // Check Full Render triggers first (§6.2)
  let needsFullRender = false
  if (cssChanged && !snap.css_volatile) {
    needsFullRender = true
    triggerReasons.push('css_fp_changed')
  }
  if (slotChanged) {
    needsFullRender = true
    triggerReasons.push('slot_fp_changed')
  }
  if (drift && drift.doc_h_rel_shift >= DRIFT_DOC_HEIGHT_SHIFT_THRESHOLD) {
    needsFullRender = true
    triggerReasons.push(`doc_h_shift_gte_5pct:${drift.doc_h_rel_shift.toFixed(4)}`)
  }
  if (drift && drift.G > DRIFT_GEOMETRY_G_THRESHOLD) {
    needsFullRender = true
    triggerReasons.push(`geometry_drift_G_gt_0.08:${drift.G.toFixed(4)}`)
  }

  if (needsFullRender) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      page_id: input.page_id,
      variant_set_key: input.variant_set_key,
      action: 'full_render',
      trigger_reasons: Object.freeze(triggerReasons),
      drift,
      visual_facts_valid: visualFactsValid,
      visual_invalidation_reasons: Object.freeze(visualInvalidation),
      spend_halted_unreproducible: false,
    })
  }

  // Check Identity Render triggers (§6.2)
  let needsIdentityRender = false
  if (!skelMatches) {
    needsIdentityRender = true
    triggerReasons.push('unknown_skel_fp')
  }
  if (drift && drift.M_sec < DRIFT_M_SEC_THRESHOLD) {
    needsIdentityRender = true
    triggerReasons.push(`M_sec_lt_0.90:${drift.M_sec.toFixed(4)}`)
  }
  if (drift && drift.M_sec_u < DRIFT_M_SEC_THRESHOLD) {
    needsIdentityRender = true
    triggerReasons.push(`M_sec_u_lt_0.90:${drift.M_sec_u.toFixed(4)}`)
  }
  if (drift && drift.O > DRIFT_ORDER_O_THRESHOLD) {
    needsIdentityRender = true
    triggerReasons.push(`order_drift_O_gt_0.10:${drift.O.toFixed(4)}`)
  }

  if (needsIdentityRender) {
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      page_id: input.page_id,
      variant_set_key: input.variant_set_key,
      action: 'identity_render',
      trigger_reasons: Object.freeze(triggerReasons),
      drift,
      visual_facts_valid: visualFactsValid,
      visual_invalidation_reasons: Object.freeze(visualInvalidation),
      spend_halted_unreproducible: false,
    })
  }

  // Known skel_fp + unknown body_fp -> light HTML fetch first, escalate to identity_render if raw HTML lacks new body (§6.2)
  if (skelMatches && input.field_unknown_body_fps.length > 0) {
    if (input.light_html_fetch_lacked_new_body) {
      return Object.freeze({
        tenant_id: input.tenant_id,
        site_id: input.site_id,
        page_id: input.page_id,
        variant_set_key: input.variant_set_key,
        action: 'identity_render',
        trigger_reasons: Object.freeze(['unknown_body_fp_absent_in_raw_html']),
        drift,
        visual_facts_valid: visualFactsValid,
        visual_invalidation_reasons: Object.freeze(visualInvalidation),
        spend_halted_unreproducible: false,
      })
    }
    return Object.freeze({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      page_id: input.page_id,
      variant_set_key: input.variant_set_key,
      action: 'light_html_fetch',
      trigger_reasons: Object.freeze(['unknown_body_fp_on_known_skel']),
      drift,
      visual_facts_valid: visualFactsValid,
      visual_invalidation_reasons: Object.freeze(visualInvalidation),
      spend_halted_unreproducible: false,
    })
  }

  return Object.freeze({
    tenant_id: input.tenant_id,
    site_id: input.site_id,
    page_id: input.page_id,
    variant_set_key: input.variant_set_key,
    action: 'none',
    trigger_reasons: Object.freeze([]),
    drift,
    visual_facts_valid: visualFactsValid,
    visual_invalidation_reasons: Object.freeze(visualInvalidation),
    spend_halted_unreproducible: false,
  })
}
