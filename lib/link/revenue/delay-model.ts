/**
 * UGOKI LINK v2 — 束 4-D (手順 14): 成果遅れモデル & 少数データ承認率推定
 *
 * 設計書 §8.1:
 * - 売上確定の 30〜90 日遅れを待たずにモデル化する:
 *   `P(conversion) × P(arrive_by_day_t)` の到着遅れ CDF と、
 *   少数データに強い Beta-Binomial 経験ベイズ承認率推定で見込み売上 (`inferred`) を算出。
 * - 確定報告（または返品・キャンセル報告）が到着した時点で、見込み売上 (`inferred`) を
 *   承認済み売上 (`observed`) へ置換する。
 */

import type { EvidenceLevel, IntervalBlock } from '@/packages/contract/response'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelayCurvePoint {
  readonly day: number
  /** Cumulative arrival probability P(arrive_by_day <= day) in (0, 1] */
  readonly cumulative_prob: number
}

export interface ApprovalRateEstimate {
  readonly approved_count: number
  readonly rejected_count: number
  readonly posterior_mean: number
  readonly interval_95: IntervalBlock
  readonly prior_strength: number
}

export interface ExpectedRevenueEstimate {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly elapsed_days: number
  readonly p_arrive_by_day_t: number
  readonly approval_rate_estimate: ApprovalRateEstimate
  readonly observed_pending_jpy: number
  readonly expected_settled_jpy: number
  readonly interval_95: IntervalBlock
  readonly evidence_level: Extract<EvidenceLevel, 'inferred' | 'observed'>
  readonly is_settled: boolean
}

export interface TrackedConversionRevenue {
  readonly conversion_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly gross_amount_jpy: number
  readonly status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled'
  readonly settled_amount_jpy: number | null
  readonly expected_amount_jpy: number
  readonly evidence_level: Extract<EvidenceLevel, 'inferred' | 'observed'>
  readonly updated_at: string
}

// ---------------------------------------------------------------------------
// Delay CDF & Small-Sample Approval Rate Estimation
// ---------------------------------------------------------------------------

/**
 * 経過日数 `day` 時点での成果報告到着確率 `P(arrive_by_day_t)` を補間算出する。
 * 曲線未指定時は標準的な対数正規型カーブ（1日=0.45, 7日=0.80, 30日=0.96, 60日=1.0）を使用。
 */
export function evaluateArrivalProbabilityAtDay(
  elapsedDays: number,
  curve?: readonly DelayCurvePoint[],
): number {
  const defaultCurve: readonly DelayCurvePoint[] = [
    { day: 0, cumulative_prob: 0.25 },
    { day: 1, cumulative_prob: 0.45 },
    { day: 3, cumulative_prob: 0.65 },
    { day: 7, cumulative_prob: 0.8 },
    { day: 14, cumulative_prob: 0.9 },
    { day: 30, cumulative_prob: 0.96 },
    { day: 60, cumulative_prob: 1.0 },
  ]
  const pts = [...(curve && curve.length > 0 ? curve : defaultCurve)].sort((a, b) => a.day - b.day)
  const d = Math.max(0, elapsedDays)

  if (d <= pts[0].day) return Math.min(1, Math.max(0.05, pts[0].cumulative_prob))
  if (d >= pts[pts.length - 1].day) return Math.min(1, Math.max(0.05, pts[pts.length - 1].cumulative_prob))

  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i].day) {
      const prev = pts[i - 1]
      const next = pts[i]
      const span = Math.max(1e-9, next.day - prev.day)
      const ratio = (d - prev.day) / span
      const val = prev.cumulative_prob + ratio * (next.cumulative_prob - prev.cumulative_prob)
      return Math.min(1, Math.max(0.05, val))
    }
  }
  return 1.0
}

/**
 * 少数データに強い Beta-Binomial 経験ベイズ承認率推定 (§8.1)。
 * 0件・1件でも 0% や 100% へ張り付かず、プログラム/ネットワーク事前分布へ滑らかに縮約する。
 */
export function estimateSmallSampleApprovalRate(params: {
  readonly approved_count: number
  readonly rejected_count: number
  /** Prior approval rate from program/network hierarchy (default 0.75) */
  readonly prior_mean?: number
  /** Effective prior sample size (default 10) */
  readonly prior_strength?: number
}): ApprovalRateEstimate {
  const priorMean = Math.min(0.99, Math.max(0.01, params.prior_mean ?? 0.75))
  const priorStrength = Math.max(1, params.prior_strength ?? 10)
  const alpha0 = priorMean * priorStrength
  const beta0 = (1 - priorMean) * priorStrength

  const alpha = alpha0 + Math.max(0, params.approved_count)
  const beta = beta0 + Math.max(0, params.rejected_count)
  const total = alpha + beta
  const mean = alpha / total
  const variance = (alpha * beta) / (total * total * (total + 1))
  const half = 1.959963984540054 * Math.sqrt(Math.max(0, variance))

  return Object.freeze({
    approved_count: Math.max(0, params.approved_count),
    rejected_count: Math.max(0, params.rejected_count),
    posterior_mean: mean,
    interval_95: Object.freeze({
      level: 0.95,
      lower: Math.max(0, mean - half),
      upper: Math.min(1, mean + half),
      method: 'beta_binomial_eb',
    }),
    prior_strength: priorStrength,
  })
}

/**
 * 経過日数 `elapsed_days` 時点の見込み売上 (`inferred`) を算出する (§8.1)。
 * - 発生済みの未確定売上 × 承認率 ÷ 到着確率 `P(arrive_by_day_t)`
 */
export function projectExpectedRevenue(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly elapsed_days: number
  readonly observed_pending_jpy: number
  readonly historical_approved_count: number
  readonly historical_rejected_count: number
  readonly prior_approval_mean?: number
  readonly prior_strength?: number
  readonly delay_curve?: readonly DelayCurvePoint[]
}): ExpectedRevenueEstimate {
  const pArrive = evaluateArrivalProbabilityAtDay(params.elapsed_days, params.delay_curve)
  const approval = estimateSmallSampleApprovalRate({
    approved_count: params.historical_approved_count,
    rejected_count: params.historical_rejected_count,
    prior_mean: params.prior_approval_mean,
    prior_strength: params.prior_strength,
  })

  const arrivalScale = 1 / Math.max(0.1, pArrive)
  const expected = params.observed_pending_jpy * approval.posterior_mean * arrivalScale
  const lower = params.observed_pending_jpy * approval.interval_95.lower
  const upper = params.observed_pending_jpy * approval.interval_95.upper * arrivalScale

  return Object.freeze({
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    network_id: params.network_id,
    elapsed_days: params.elapsed_days,
    p_arrive_by_day_t: pArrive,
    approval_rate_estimate: approval,
    observed_pending_jpy: params.observed_pending_jpy,
    expected_settled_jpy: expected,
    interval_95: Object.freeze({
      level: 0.95,
      lower,
      upper,
      method: 'delay_adjusted_approval_projection',
    }),
    evidence_level: 'inferred',
    is_settled: false,
  })
}

/**
 * 見込み売上 (`inferred`) から確定売上 (`observed`) への置換・返品/キャンセル反映 (§8.1, §8.13)。
 */
export function settleConversionRevenue(
  record: TrackedConversionRevenue,
  settlement: {
    readonly status: 'approved' | 'rejected' | 'returned' | 'cancelled'
    readonly settled_amount_jpy: number
    readonly settled_at: string
  },
): TrackedConversionRevenue {
  const finalAmount =
    settlement.status === 'approved' ? Math.max(0, settlement.settled_amount_jpy) : 0
  return Object.freeze({
    ...record,
    status: settlement.status,
    settled_amount_jpy: finalAmount,
    expected_amount_jpy: finalAmount,
    evidence_level: 'observed',
    updated_at: settlement.settled_at,
  })
}
