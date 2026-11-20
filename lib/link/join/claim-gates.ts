/**
 * UGOKI LINK v2 — 束 4-D (手順 13): 主張ごとゲート・突合品質付与・テナント内階層部分持ち寄り
 *
 * 設計書 §6.8 / join-final.md M8:
 * 1. 全回答へ網羅率・精度・ずれを「件数＋95%下限」つきで添付する。計算不能なゲートは `unmet`。
 * 2. ゲートは主張ごと（区画単体 / ページ内比較 / 本文主張 / 見た目主張 / ロールアップ）。
 * 3. 固定件数しきい値ではなく「幅の狭さ」（到達率 ±10pt、滞在時間 相対 ±25%）で判定。
 * 4. 不足時は**テナント内のみ**で `page → template_role → site` の階層部分持ち寄り（経験ベイズ縮約）を実施。
 *    自データの重みが `>= 0.80` なら `observed`、`< 0.80` なら `inferred`。
 */

import type { EvidenceLevel, IntervalBlock, UnmetGate } from '@/packages/contract/response'

// ---------------------------------------------------------------------------
// Constants (§6.8)
// ---------------------------------------------------------------------------

/** Reach rate target 95% half-width: ±10 percentage points */
export const REACH_RATE_MAX_HALF_WIDTH = 0.1
/** Dwell time target 95% relative half-width: ±25% */
export const DWELL_TIME_MAX_REL_HALF_WIDTH = 0.25
/** Own-data weight threshold for `observed` vs `inferred` under partial pooling */
export const POOLING_OBSERVED_WEIGHT_THRESHOLD = 0.8
const Z_95_ONE_SIDED = 1.6448536269514722
const Z_95_TWO_SIDED = 1.959963984540054

// ---------------------------------------------------------------------------
// Statistical Helpers (95% Lower Bound & Width)
// ---------------------------------------------------------------------------

export interface BoundedRateMetric {
  readonly successes: number
  readonly trials: number
  readonly rate: number | null
  readonly lower_95: number | null
  readonly upper_95: number | null
  readonly half_width_95: number | null
}

/**
 * Wilson score interval for a binomial proportion (exact behavior at small n and 0/1 boundaries).
 * `lower_95` is the one-sided 95% lower confidence bound (z = 1.645), matching gate lower-bound specs.
 */
export function computeBoundedRate(successes: number, trials: number): BoundedRateMetric {
  if (!Number.isFinite(trials) || trials <= 0 || successes < 0 || successes > trials) {
    return Object.freeze({
      successes: Math.max(0, Math.floor(successes)),
      trials: Math.max(0, Math.floor(trials)),
      rate: null,
      lower_95: null,
      upper_95: null,
      half_width_95: null,
    })
  }

  const p = successes / trials
  const z1 = Z_95_ONE_SIDED
  const denom1 = 1 + (z1 * z1) / trials
  const center1 = p + (z1 * z1) / (2 * trials)
  const margin1 = z1 * Math.sqrt((p * (1 - p) + (z1 * z1) / (4 * trials)) / trials)
  const lower95 = Math.max(0, (center1 - margin1) / denom1)

  const z2 = Z_95_TWO_SIDED
  const denom2 = 1 + (z2 * z2) / trials
  const center2 = p + (z2 * z2) / (2 * trials)
  const margin2 = z2 * Math.sqrt((p * (1 - p) + (z2 * z2) / (4 * trials)) / trials)
  const ciLow = Math.max(0, (center2 - margin2) / denom2)
  const ciHigh = Math.min(1, (center2 + margin2) / denom2)

  return Object.freeze({
    successes,
    trials,
    rate: p,
    lower_95: lower95,
    upper_95: ciHigh,
    half_width_95: (ciHigh - ciLow) / 2,
  })
}

// ---------------------------------------------------------------------------
// Join Quality Attachment (Attached to ALL Responses — §6.8)
// ---------------------------------------------------------------------------

export interface JoinQualityAttachment {
  readonly coverage: BoundedRateMetric
  readonly precision: BoundedRateMetric
  readonly drift: {
    readonly M_sec: BoundedRateMetric | null
    readonly M_sec_u: BoundedRateMetric | null
    readonly O: number | null
    readonly G: number | null
    readonly positional_share: number | null
  }
  readonly has_lab_or_escrow_text: boolean
  readonly has_valid_full_render: boolean
  readonly target_entity_matched: boolean
}

export type JoinClaimScope =
  | 'section_own_metric'
  | 'page_relative_comparison'
  | 'text_claim'
  | 'visual_claim'
  | 'rollup_aggregate'

export interface ClaimGateEvaluationResult {
  readonly claim_scope: JoinClaimScope
  readonly passed: boolean
  readonly status: 'ok' | 'partial'
  readonly quality: JoinQualityAttachment
  readonly unmet_gates: readonly UnmetGate[]
}

/**
 * 主張種別ごとの突合品質ゲートを評価する (§6.8)。
 * 計算不能（null / 0件）な指標があるゲートは必ず `unmet` に倒す。
 */
export function evaluateClaimScopedGates(
  claimScope: JoinClaimScope,
  quality: JoinQualityAttachment,
): ClaimGateEvaluationResult {
  const unmet: UnmetGate[] = []

  // Rule: Named entity/section must itself be matched
  if (!quality.target_entity_matched) {
    unmet.push(
      Object.freeze({
        id: 'join.target_entity_matched',
        required: 'true',
        observed: 'false',
        unlock: 'Match target section/element by exact fingerprint against a confirmed lab snapshot',
      }),
    )
  }

  // Rule: Precision lower bound >= 0.98 (uncomputable -> unmet!)
  if (quality.precision.lower_95 === null || quality.precision.lower_95 < 0.98) {
    unmet.push(
      Object.freeze({
        id: 'join.precision_lower_95',
        required: 0.98,
        observed: quality.precision.lower_95,
        unlock: 'Audit matched pairs to confirm precision 95% lower bound >= 0.98',
        reason: quality.precision.lower_95 === null ? 'uncomputable_precision_gate' : undefined,
      }),
    )
  }

  // Claim-specific gates
  if (claimScope === 'page_relative_comparison') {
    const mSecLow = quality.drift.M_sec?.lower_95 ?? null
    const mSecULow = quality.drift.M_sec_u?.lower_95 ?? null
    if (mSecLow === null || mSecLow < 0.9) {
      unmet.push(
        Object.freeze({
          id: 'join.G4_M_sec',
          required: 0.9,
          observed: mSecLow,
          unlock: 'Trigger identity_render until M_sec 95% lower bound >= 0.90',
        }),
      )
    }
    if (mSecULow === null || mSecULow < 0.9) {
      unmet.push(
        Object.freeze({
          id: 'join.G4_M_sec_u',
          required: 0.9,
          observed: mSecULow,
          unlock: 'Trigger identity_render until M_sec_u 95% lower bound >= 0.90',
        }),
      )
    }
    if (quality.drift.O === null || quality.drift.O > 0.1) {
      unmet.push(
        Object.freeze({
          id: 'join.G4_order_O',
          required: '<= 0.10',
          observed: quality.drift.O,
          unlock: 'Trigger identity_render until section order drift O <= 0.10',
        }),
      )
    }
    if (quality.drift.positional_share === null || quality.drift.positional_share > 0.2) {
      unmet.push(
        Object.freeze({
          id: 'join.G4_positional_share',
          required: '<= 0.20',
          observed: quality.drift.positional_share,
          unlock: 'Reduce depth-band positional fallback share to <= 0.20',
        }),
      )
    }
  }

  if (claimScope === 'text_claim' && !quality.has_lab_or_escrow_text) {
    unmet.push(
      Object.freeze({
        id: 'join.text_source_present',
        required: 'lab_or_escrow_text',
        observed: 'missing',
        unlock: 'Obtain confirmed lab render text or D-08 k-anonymous text escrow',
      }),
    )
  }

  if (claimScope === 'visual_claim') {
    if (!quality.has_valid_full_render) {
      unmet.push(
        Object.freeze({
          id: 'join.valid_full_render',
          required: 'full_render_skel_css_match',
          observed: 'invalid_or_missing',
          unlock: 'Complete full_render with matching skel_fp and css_fp',
        }),
      )
    }
    if (quality.drift.G === null || quality.drift.G > 0.08) {
      unmet.push(
        Object.freeze({
          id: 'join.visual_geometry_G',
          required: '<= 0.08',
          observed: quality.drift.G,
          unlock: 'Complete full_render at field-median viewport so G <= 0.08',
        }),
      )
    }
  }

  if (claimScope === 'rollup_aggregate') {
    if (quality.coverage.lower_95 === null || quality.coverage.lower_95 < 0.98) {
      unmet.push(
        Object.freeze({
          id: 'join.G11_coverage_lower_95',
          required: 0.98,
          observed: quality.coverage.lower_95,
          unlock: 'Increase visit-weighted join coverage lower bound to >= 0.98',
        }),
      )
    }
  }

  return Object.freeze({
    claim_scope: claimScope,
    passed: unmet.length === 0,
    status: unmet.length === 0 ? 'ok' : 'partial',
    quality,
    unmet_gates: Object.freeze(unmet),
  })
}

// ---------------------------------------------------------------------------
// Width-Based Sufficiency & Tenant-Scoped Hierarchical Partial Pooling (§6.8)
// ---------------------------------------------------------------------------

export interface RateLevelObservation {
  readonly tenant_id: string
  readonly successes: number
  readonly trials: number
}

export interface PooledRateEstimateResult {
  readonly tenant_id: string
  readonly estimate: number
  readonly interval: IntervalBlock
  readonly half_width: number
  readonly target_half_width: number
  readonly width_sufficient: boolean
  readonly used_partial_pooling: boolean
  readonly pooling_weight: number
  readonly evidence_level: Extract<EvidenceLevel, 'observed' | 'inferred'>
  readonly hierarchy_levels_used: readonly ('page' | 'template_role' | 'site')[]
}

/**
 * 到達率など割合指標の幅ベース判定＋テナント内階層部分持ち寄り (`page → template_role → site`)。
 * - 固定件数しきい値は使わず、95% 半幅 `<= 0.10` (±10pt) を満たすかで判定 (§6.8)。
 * - 不足時はテナント内のみで経験ベイズ縮約し、自データ重み `>= 0.80` なら `observed`、`< 0.80` なら `inferred`。
 */
export function computePooledReachRate(params: {
  readonly tenant_id: string
  readonly page: RateLevelObservation
  readonly template_role?: RateLevelObservation | null
  readonly site: RateLevelObservation
  readonly target_half_width?: number
  /** Prior pseudo-count strength when shrinking page -> parent (default: 20) */
  readonly prior_strength?: number
}): PooledRateEstimateResult {
  // Strict tenant boundary check — pooling NEVER leaves tenant (§6.8)
  if (
    params.page.tenant_id !== params.tenant_id ||
    params.site.tenant_id !== params.tenant_id ||
    (params.template_role && params.template_role.tenant_id !== params.tenant_id)
  ) {
    throw new Error('Cross-tenant partial pooling is strictly prohibited (§6.8)')
  }

  const targetHalfWidth = params.target_half_width ?? REACH_RATE_MAX_HALF_WIDTH
  const priorStrength = Math.max(1, params.prior_strength ?? 20)
  const pageDirect = computeBoundedRate(params.page.successes, params.page.trials)

  // If page's own data already achieves target width (±10pt), no pooling needed!
  if (
    pageDirect.rate !== null &&
    pageDirect.half_width_95 !== null &&
    pageDirect.half_width_95 <= targetHalfWidth
  ) {
    const low = Math.max(0, pageDirect.rate - pageDirect.half_width_95)
    const high = Math.min(1, pageDirect.rate + pageDirect.half_width_95)
    return Object.freeze({
      tenant_id: params.tenant_id,
      estimate: pageDirect.rate,
      interval: Object.freeze({
        level: 0.95,
        lower: low,
        upper: high,
        method: 'wilson_direct',
      }),
      half_width: pageDirect.half_width_95,
      target_half_width: targetHalfWidth,
      width_sufficient: true,
      used_partial_pooling: false,
      pooling_weight: 1,
      evidence_level: 'observed',
      hierarchy_levels_used: Object.freeze(['page'] as const),
    })
  }

  // Step 1: Site anchor (weak Beta(1,1) baseline if site itself is empty)
  const siteRate =
    params.site.trials > 0 ? (params.site.successes + 1) / (params.site.trials + 2) : 0.5
  const levelsUsed: Array<'page' | 'template_role' | 'site'> = ['page']

  // Step 2: Shrink template_role toward site if present
  let parentRate = siteRate
  let parentEffectiveN = Math.min(priorStrength, Math.max(2, params.site.trials))
  if (params.template_role && params.template_role.trials > 0) {
    levelsUsed.push('template_role')
    const wRole = params.template_role.trials / (params.template_role.trials + priorStrength)
    const roleRate = params.template_role.successes / params.template_role.trials
    parentRate = wRole * roleRate + (1 - wRole) * siteRate
    parentEffectiveN = Math.min(priorStrength, params.template_role.trials + 2)
  }
  levelsUsed.push('site')

  // Step 3: Empirical Bayes Beta-Binomial shrinkage of page toward parent
  const alpha0 = Math.max(0.5, parentRate * parentEffectiveN)
  const beta0 = Math.max(0.5, (1 - parentRate) * parentEffectiveN)
  const postAlpha = alpha0 + Math.max(0, params.page.successes)
  const postBeta = beta0 + Math.max(0, params.page.trials - params.page.successes)
  const totalPost = postAlpha + postBeta

  const pooledEstimate = postAlpha / totalPost
  const postVar = (postAlpha * postBeta) / (totalPost * totalPost * (totalPost + 1))
  const halfWidth = Z_95_TWO_SIDED * Math.sqrt(Math.max(0, postVar))
  const lower = Math.max(0, pooledEstimate - halfWidth)
  const upper = Math.min(1, pooledEstimate + halfWidth)

  const ownWeight = params.page.trials / (params.page.trials + alpha0 + beta0)
  const evidenceLevel: Extract<EvidenceLevel, 'observed' | 'inferred'> =
    ownWeight >= POOLING_OBSERVED_WEIGHT_THRESHOLD ? 'observed' : 'inferred'

  return Object.freeze({
    tenant_id: params.tenant_id,
    estimate: pooledEstimate,
    interval: Object.freeze({
      level: 0.95,
      lower,
      upper,
      method: 'empirical_bayes_beta_binomial_hierarchical',
    }),
    half_width: halfWidth,
    target_half_width: targetHalfWidth,
    width_sufficient: halfWidth <= targetHalfWidth,
    used_partial_pooling: true,
    pooling_weight: ownWeight,
    evidence_level: evidenceLevel,
    hierarchy_levels_used: Object.freeze(levelsUsed),
  })
}

export interface DwellLevelObservation {
  readonly tenant_id: string
  readonly n: number
  readonly mean_ms: number
  /** Sample standard deviation in ms */
  readonly sd_ms: number
}

export interface PooledDwellEstimateResult {
  readonly tenant_id: string
  readonly estimate_ms: number
  readonly interval: IntervalBlock
  readonly relative_half_width: number
  readonly target_relative_half_width: number
  readonly width_sufficient: boolean
  readonly used_partial_pooling: boolean
  readonly pooling_weight: number
  readonly evidence_level: Extract<EvidenceLevel, 'observed' | 'inferred'>
  readonly hierarchy_levels_used: readonly ('page' | 'template_role' | 'site')[]
}

/**
 * 滞在時間など連続指標の相対幅ベース判定（相対 ±25%）＋テナント内階層部分持ち寄り。
 */
export function computePooledDwellTime(params: {
  readonly tenant_id: string
  readonly page: DwellLevelObservation
  readonly template_role?: DwellLevelObservation | null
  readonly site: DwellLevelObservation
  readonly target_relative_half_width?: number
}): PooledDwellEstimateResult {
  if (
    params.page.tenant_id !== params.tenant_id ||
    params.site.tenant_id !== params.tenant_id ||
    (params.template_role && params.template_role.tenant_id !== params.tenant_id)
  ) {
    throw new Error('Cross-tenant partial pooling is strictly prohibited (§6.8)')
  }

  const targetRel = params.target_relative_half_width ?? DWELL_TIME_MAX_REL_HALF_WIDTH
  const pageSe = params.page.n > 1 ? params.page.sd_ms / Math.sqrt(params.page.n) : Infinity
  const pageHalf = Z_95_TWO_SIDED * pageSe
  const pageRelHalf = params.page.mean_ms > 0 ? pageHalf / params.page.mean_ms : Infinity

  if (Number.isFinite(pageRelHalf) && pageRelHalf <= targetRel) {
    return Object.freeze({
      tenant_id: params.tenant_id,
      estimate_ms: params.page.mean_ms,
      interval: Object.freeze({
        level: 0.95,
        lower: Math.max(0, params.page.mean_ms - pageHalf),
        upper: params.page.mean_ms + pageHalf,
        method: 'normal_direct',
      }),
      relative_half_width: pageRelHalf,
      target_relative_half_width: targetRel,
      width_sufficient: true,
      used_partial_pooling: false,
      pooling_weight: 1,
      evidence_level: 'observed',
      hierarchy_levels_used: Object.freeze(['page'] as const),
    })
  }

  const levelsUsed: Array<'page' | 'template_role' | 'site'> = ['page']
  let priorMean = params.site.mean_ms
  let priorVar = Math.max(1, params.site.sd_ms * params.site.sd_ms / Math.max(1, Math.min(params.site.n, 20)))

  if (params.template_role && params.template_role.n > 0) {
    levelsUsed.push('template_role')
    const roleVar = Math.max(
      1,
      (params.template_role.sd_ms * params.template_role.sd_ms) / Math.max(1, params.template_role.n),
    )
    const wRole = (1 / roleVar) / (1 / roleVar + 1 / priorVar)
    priorMean = wRole * params.template_role.mean_ms + (1 - wRole) * priorMean
    priorVar = Math.max(1, params.template_role.sd_ms * params.template_role.sd_ms / Math.max(1, Math.min(params.template_role.n, 20)))
  }
  levelsUsed.push('site')

  const pageVar =
    params.page.n > 0
      ? Math.max(1, (Math.max(params.page.sd_ms, params.site.sd_ms) ** 2) / params.page.n)
      : Infinity

  const precPage = Number.isFinite(pageVar) ? 1 / pageVar : 0
  const precPrior = 1 / priorVar
  const totalPrec = precPage + precPrior
  const ownWeight = precPage / totalPrec
  const pooledMean = ownWeight * params.page.mean_ms + (1 - ownWeight) * priorMean
  const postHalf = Z_95_TWO_SIDED * Math.sqrt(1 / totalPrec)
  const relHalf = pooledMean > 0 ? postHalf / pooledMean : Infinity

  return Object.freeze({
    tenant_id: params.tenant_id,
    estimate_ms: pooledMean,
    interval: Object.freeze({
      level: 0.95,
      lower: Math.max(0, pooledMean - postHalf),
      upper: pooledMean + postHalf,
      method: 'empirical_bayes_normal_hierarchical',
    }),
    relative_half_width: relHalf,
    target_relative_half_width: targetRel,
    width_sufficient: relHalf <= targetRel,
    used_partial_pooling: true,
    pooling_weight: ownWeight,
    evidence_level: ownWeight >= POOLING_OBSERVED_WEIGHT_THRESHOLD ? 'observed' : 'inferred',
    hierarchy_levels_used: Object.freeze(levelsUsed),
  })
}
