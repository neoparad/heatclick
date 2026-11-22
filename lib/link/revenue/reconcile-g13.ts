/**
 * UGOKI LINK v2 — 束 4-D (手順 14): `join.G13` クリック照合ゲート
 *
 * 設計書 §6.5 / §8.1:
 * - 自社カウント外部クリックとネットワーク報告クリックの比が、
 *   1. 14 日以上 (`days >= 14`)
 *   2. ネットワーク報告クリック合計 200 件以上 (`network_clicks >= 200`)
 *   3. **対応差分散**（同じクリックを 2 通りに数えた日次ペア残差 `d_i = y_i - R * x_i` による比率分散）
 *      から算出した 95% 信頼区間全体が `[0.85, 1.15]` の内側に収まること
 * - サイト × 端末区分 (`desktop` / `mobile`) ごとに評価する。
 * - 検査走行 (lab) と有償人間パネル (panel) の時間帯は照合から必ず除外する。
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const G13_MIN_DAYS = 14
export const G13_MIN_NETWORK_CLICKS = 200
export const G13_RATIO_LOWER_BOUND = 0.85
export const G13_RATIO_UPPER_BOUND = 1.15
const Z_95_TWO_SIDED = 1.959963984540054

/** Exact two-sided 95% Student-t critical values t_{0.975, df} for df = 1..60 */
const STUDENT_T_975_TABLE: Readonly<Record<number, number>> = Object.freeze({
  1: 12.706205,
  2: 4.302653,
  3: 3.182446,
  4: 2.776445,
  5: 2.570582,
  6: 2.446912,
  7: 2.364624,
  8: 2.306004,
  9: 2.262157,
  10: 2.228139,
  11: 2.200985,
  12: 2.178813,
  13: 2.160369,
  14: 2.144787,
  15: 2.13145,
  16: 2.119905,
  17: 2.109816,
  18: 2.100922,
  19: 2.093024,
  20: 2.085963,
  21: 2.079614,
  22: 2.073873,
  23: 2.068658,
  24: 2.063899,
  25: 2.059539,
  26: 2.055529,
  27: 2.051831,
  28: 2.048407,
  29: 2.04523,
  30: 2.042272,
  35: 2.030108,
  40: 2.021075,
  45: 2.014103,
  50: 2.008559,
  60: 2.000298,
})

/**
 * Computes two-sided 95% Student-t critical value t_{0.975, df} (df >= 1).
 * Uses exact lookup table for small df and Cornish-Fisher asymptotic expansion for larger df.
 */
export function studentT975Critical(df: number): number {
  const k = Math.max(1, Math.floor(df))
  const exact = STUDENT_T_975_TABLE[k]
  if (exact !== undefined) return exact
  const z = Z_95_TWO_SIDED
  const z2 = z * z
  const z3 = z2 * z
  const z5 = z3 * z2
  return z + (z3 + z) / (4 * k) + (5 * z5 + 16 * z3 + 3 * z) / (96 * k * k)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconciliationDeviceClass = 'desktop' | 'mobile' | 'tablet'

export interface DailyClickReconciliationRow {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly device_class: ReconciliationDeviceClass
  /** UTC YYYY-MM-DD */
  readonly date: string
  readonly own_clicks: number
  readonly network_clicks: number
  /** §6.5: Lab runs & human panel windows MUST be excluded from G13 reconciliation */
  readonly is_lab_or_panel_window?: boolean
}

export interface JoinG13EvaluationResult {
  readonly gate_id: 'join.G13'
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly device_class: ReconciliationDeviceClass
  readonly status: 'pass' | 'fail' | 'insufficient_data'
  readonly passed: boolean
  readonly days_included: number
  readonly inactive_zero_days_excluded: number
  readonly excluded_lab_or_panel_rows: number
  readonly total_own_clicks: number
  readonly total_network_clicks: number
  readonly ratio: number | null
  readonly relative_diff: number | null
  readonly paired_se: number | null
  readonly t_critical_95: number | null
  readonly ci95_lower: number | null
  readonly ci95_upper: number | null
  readonly unmet_reasons: readonly string[]
}

// ---------------------------------------------------------------------------
// Paired-Difference Ratio Estimator (join.G13)
// ---------------------------------------------------------------------------

export function evaluateJoinG13Gate(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly network_id: string
  readonly device_class: ReconciliationDeviceClass
  readonly rows: readonly DailyClickReconciliationRow[]
}): JoinG13EvaluationResult {
  const scoped = params.rows.filter(
    (r) =>
      r.tenant_id === params.tenant_id &&
      r.site_id === params.site_id &&
      r.network_id === params.network_id &&
      r.device_class === params.device_class,
  )

  let excludedLabOrPanel = 0
  const byDate = new Map<string, { own: number; net: number }>()
  for (const r of scoped) {
    if (r.is_lab_or_panel_window) {
      excludedLabOrPanel++
      continue
    }
    const cur = byDate.get(r.date) ?? { own: 0, net: 0 }
    cur.own += Math.max(0, r.own_clicks)
    cur.net += Math.max(0, r.network_clicks)
    byDate.set(r.date, cur)
  }

  // Exclude 0/0 inactive days so zero-traffic days cannot pad the 14-day minimum sample requirement!
  const allDates = [...byDate.values()]
  const dailyPairs = allDates.filter((p) => p.own > 0 || p.net > 0)
  const inactiveZeroDaysExcluded = allDates.length - dailyPairs.length

  const n = dailyPairs.length
  const totalOwn = dailyPairs.reduce((s, p) => s + p.own, 0)
  const totalNet = dailyPairs.reduce((s, p) => s + p.net, 0)

  const unmet: string[] = []
  if (n < G13_MIN_DAYS) {
    unmet.push(`days_lt_${G13_MIN_DAYS}:${n}`)
  }
  if (totalNet < G13_MIN_NETWORK_CLICKS) {
    unmet.push(`network_clicks_lt_${G13_MIN_NETWORK_CLICKS}:${totalNet}`)
  }

  if (n < 2 || totalNet <= 0) {
    return Object.freeze({
      gate_id: 'join.G13',
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      network_id: params.network_id,
      device_class: params.device_class,
      status: 'insufficient_data',
      passed: false,
      days_included: n,
      inactive_zero_days_excluded: inactiveZeroDaysExcluded,
      excluded_lab_or_panel_rows: excludedLabOrPanel,
      total_own_clicks: totalOwn,
      total_network_clicks: totalNet,
      ratio: null,
      relative_diff: null,
      paired_se: null,
      t_critical_95: null,
      ci95_lower: null,
      ci95_upper: null,
      unmet_reasons: Object.freeze(unmet),
    })
  }

  // Paired-difference Cochran ratio estimator (§6.5 / §8.1):
  // Ratio direction: link_attributed / ledger_net = own_clicks / network_clicks
  // R = sum(y_i) / sum(x_i) where y_i = own_i, x_i = net_i
  // d_i = y_i - R * x_i  (paired daily counting discrepancy!)
  // Var(R) = (n / (n - 1)) * sum(d_i^2) / (sum(x_i))^2
  const R = totalOwn / totalNet
  const relativeDiff = (totalOwn - totalNet) / totalNet
  let sumSqResid = 0
  for (const p of dailyPairs) {
    const d = p.own - R * p.net
    sumSqResid += d * d
  }

  const pairedVar = ((n / (n - 1)) * sumSqResid) / (totalNet * totalNet)
  const rawSe = Math.sqrt(Math.max(0, pairedVar))
  const tCrit = studentT975Critical(n - 1)

  // Rule-of-Three binomial/Poisson discrepancy floor (`3 / totalNet`) when all daily counts match identically (`d_i = 0`)
  // so finite-sample 0-discrepancy series NEVER produce a degenerate 0-width interval!
  const ruleOfThreeHalfWidth = 3 / totalNet
  const se = Math.max(rawSe, ruleOfThreeHalfWidth / tCrit)
  const halfWidth = Math.max(tCrit * rawSe, ruleOfThreeHalfWidth)
  const ciLower = Math.max(0, R - halfWidth)
  const ciUpper = R + halfWidth

  if (totalOwn <= 0) {
    unmet.push('total_own_clicks_zero')
  }
  if (ciLower < G13_RATIO_LOWER_BOUND) {
    unmet.push(`ci95_lower_lt_${G13_RATIO_LOWER_BOUND}:${ciLower.toFixed(4)}`)
  }
  if (ciUpper > G13_RATIO_UPPER_BOUND) {
    unmet.push(`ci95_upper_gt_${G13_RATIO_UPPER_BOUND}:${ciUpper.toFixed(4)}`)
  }

  const passed = unmet.length === 0
  const status: JoinG13EvaluationResult['status'] = passed
    ? 'pass'
    : n < G13_MIN_DAYS || totalNet < G13_MIN_NETWORK_CLICKS
      ? 'insufficient_data'
      : 'fail'

  return Object.freeze({
    gate_id: 'join.G13',
    tenant_id: params.tenant_id,
    site_id: params.site_id,
    network_id: params.network_id,
    device_class: params.device_class,
    status,
    passed,
    days_included: n,
    inactive_zero_days_excluded: inactiveZeroDaysExcluded,
    excluded_lab_or_panel_rows: excludedLabOrPanel,
    total_own_clicks: totalOwn,
    total_network_clicks: totalNet,
    ratio: R,
    relative_diff: relativeDiff,
    paired_se: se,
    t_critical_95: tCrit,
    ci95_lower: ciLower,
    ci95_upper: ciUpper,
    unmet_reasons: Object.freeze(unmet),
  })
}
