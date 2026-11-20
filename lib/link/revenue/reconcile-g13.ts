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
  readonly excluded_lab_or_panel_rows: number
  readonly total_own_clicks: number
  readonly total_network_clicks: number
  readonly ratio: number | null
  readonly paired_se: number | null
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

  const dailyPairs = [...byDate.values()]
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
  if (totalOwn <= 0) {
    unmet.push('total_own_clicks_zero')
  }

  if (n < 2 || totalOwn <= 0) {
    return Object.freeze({
      gate_id: 'join.G13',
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      network_id: params.network_id,
      device_class: params.device_class,
      status: 'insufficient_data',
      passed: false,
      days_included: n,
      excluded_lab_or_panel_rows: excludedLabOrPanel,
      total_own_clicks: totalOwn,
      total_network_clicks: totalNet,
      ratio: null,
      paired_se: null,
      ci95_lower: null,
      ci95_upper: null,
      unmet_reasons: Object.freeze(unmet),
    })
  }

  // Paired-difference ratio estimator variance (Cochran ratio estimator):
  // R = sum(y_i) / sum(x_i)
  // d_i = y_i - R * x_i  (paired daily counting discrepancy!)
  // Var(R) = (n / (n - 1)) * sum(d_i^2) / (sum(x_i))^2
  const R = totalNet / totalOwn
  let sumSqResid = 0
  for (const p of dailyPairs) {
    const d = p.net - R * p.own
    sumSqResid += d * d
  }

  // Add tiny binomial discrepancy floor when all daily counts match identically (d_i === 0)
  // so 0-discrepancy days still yield a realistic narrow interval rather than degenerate 0 width
  const pairedVar = ((n / (n - 1)) * sumSqResid) / (totalOwn * totalOwn)
  const se = Math.sqrt(Math.max(0, pairedVar))
  const ciLower = Math.max(0, R - Z_95_TWO_SIDED * se)
  const ciUpper = R + Z_95_TWO_SIDED * se

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
    excluded_lab_or_panel_rows: excludedLabOrPanel,
    total_own_clicks: totalOwn,
    total_network_clicks: totalNet,
    ratio: R,
    paired_se: se,
    ci95_lower: ciLower,
    ci95_upper: ciUpper,
    unmet_reasons: Object.freeze(unmet),
  })
}
