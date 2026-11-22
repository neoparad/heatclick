/**
 * UGOKI LINK v2 — 束 6-B (手順 22, §7.5): ブラウザ内ローカル AI 尤度比スコアラー & 誤検知上限証明書
 *
 * 設計書 §7.5:
 * 1. **採点可能範囲の宣言**:
 *    細かいポインタ (`pointer_type === 'fine'`) かつ一定数以上の操作イベントがある PV のみ採点。
 *    タッチ専用・無操作は `unscorable` とし、バッチ集計に必ず `unscorable_share` を併記する。
 * 2. **特徴圧縮 (60 行動統計 → ≤400 バイト・端末指紋 0)**:
 *    60 個の純粋行動統計をブラウザ内で 122 バイト（上限 400 バイト以下）の固定長バイナリへ圧縮。
 *    端末指紋フィールド (`canvas_hash` / `webgl_renderer` / `fonts` 等) の混入を実行時拒否。
 * 3. **出力の厳格制約**:
 *    - 出力するもの: 既知系統ごとの尤度比 (`family_likelihood_ratios`)、未知度 (`novelty_score`)、
 *      状態 (`automated | human_like | undecided | unscorable`)。
 *    - 決して出力しないもの: 「このセッションが AI である確率 (`P(AI|session)`)」。
 *      型 (`never`) と実行時ガード (`assertNoPosteriorAiProbability`) の両方で禁止。
 * 4. **モデル証明書 (`LocalAiModelCertificate`)**:
 *    - 正例 ≥8 系統、有償同意人間パネル負例（閾値決め ≥300 人、試験 ≥1,000 人、支援技術・入力方式・広告ブロック含む）。
 *    - 誤検知率 95% 上限（試験で 0 件なら `3 / N`: 300 人で 1.0%、1,000 人で 0.3%）。
 *    - 野生検知率からの上限（前提上限 `π_max = 0.20` を必ず同時公表）。
 *    - 系統別再現率・未学習基盤再現率・パネル vs 野生識別不能性テスト (`0.45 <= AUC <= 0.55`)。
 *    - 検知不能クラス（読むだけ訪問・人間模倣 AI）を明記。
 */

export const BEHAVIORAL_STAT_COUNT = 60
export const MAX_COMPRESSED_BEHAVIORAL_BYTES = 400
export const MIN_SCORABLE_INTERACTION_EVENTS = 8
export const DEFAULT_WILD_AI_PRIOR_CAP_PI_MAX = 0.2
export const MIN_POSITIVE_FAMILIES = 8
export const MIN_THRESHOLD_PANEL_N = 300
export const MIN_TEST_PANEL_N = 1000
export const PANEL_WILD_AUC_MIN = 0.45
export const PANEL_WILD_AUC_MAX = 0.55
export const DEFAULT_MAX_HUMAN_FPR_UPPER_BOUND = 0.01
export const DEFAULT_MIN_PER_FAMILY_RECALL = 0.5
export const DEFAULT_MIN_MEAN_FAMILY_RECALL = 0.7
export const DEFAULT_MAX_CALIBRATION_ECE = 0.05
export const DEFAULT_MIN_ROC_AUC = 0.85
export const DEFAULT_MIN_PR_AUC = 0.8

const TWO_PI = 2 * Math.PI
const LOG_TWO_PI = Math.log(TWO_PI)

export const UNDETECTABLE_LOCAL_AI_CLASSES = Object.freeze([
  'read_only_visits',
  'human_mimicking_agents',
] as const)

export type PointerPrecisionKind = 'fine' | 'coarse' | 'none'

export type LocalAiSessionStatus = 'automated' | 'human_like' | 'undecided' | 'unscorable'

const FORBIDDEN_DEVICE_FINGERPRINT_KEYS = new Set([
  'canvas_hash',
  'webgl_renderer',
  'webgl_vendor',
  'audio_fp',
  'audio_hash',
  'fonts',
  'font_list',
  'hardware_concurrency',
  'device_memory',
  'screen_resolution',
  'battery_level',
  'plugins',
  'gpu_adapter',
])

const FORBIDDEN_PROBABILITY_KEYS = new Set([
  'ai_probability',
  'p_ai',
  'p_ai_given_session',
  'bot_probability',
  'posterior_ai_probability',
  'is_ai_probability',
])

export interface BehavioralStats60Input {
  readonly stats_60: readonly number[]
  readonly extra_fields?: Readonly<Record<string, unknown>>
  readonly feature_provenances?:
    | ReadonlyArray<{ readonly key?: string; readonly feature_key?: string; readonly provenance: string }>
    | Readonly<Record<string, string>>
}

export function assertNoModelInferredTrainingInputs(
  provenances: BehavioralStats60Input['feature_provenances'],
): void {
  if (!provenances) return
  if (Array.isArray(provenances)) {
    const bad = provenances
      .filter((p) => p.provenance === 'model_inferred')
      .map((p) => p.feature_key ?? p.key ?? 'unknown_feature')
    if (bad.length > 0) {
      throw new Error(
        `Model-inferred feature provenance is strictly banned in behavioral input/retraining: [${bad.join(', ')}] (§7.5)`,
      )
    }
    return
  }
  const bad = Object.entries(provenances)
    .filter(([, prov]) => prov === 'model_inferred')
    .map(([k]) => k)
  if (bad.length > 0) {
    throw new Error(
      `Model-inferred feature provenance is strictly banned in behavioral input/retraining: [${bad.join(', ')}] (§7.5)`,
    )
  }
}

export function assertNoDeviceFingerprintFields(
  obj: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!obj) return
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_DEVICE_FINGERPRINT_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `Device fingerprint field "${key}" is strictly prohibited in local AI behavioral vector (§7.5)`,
      )
    }
  }
}

export function assertNoPosteriorAiProbability(payload: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_PROBABILITY_KEYS.has(k.toLowerCase())) {
        throw new Error(
          `Posterior AI probability field "${k}" is strictly prohibited at ${path}.${k} (§7.5: output LR + FPR upper bound only)`,
        )
      }
      walk(v, `${path}.${k}`)
    }
  }
  walk(payload, '$')
}

export function compressBehavioralStats60(input: BehavioralStats60Input): Uint8Array {
  assertNoDeviceFingerprintFields(input.extra_fields)
  assertNoModelInferredTrainingInputs(input.feature_provenances)
  if (input.stats_60.length !== BEHAVIORAL_STAT_COUNT) {
    throw new Error(
      `Expected exactly ${BEHAVIORAL_STAT_COUNT} behavioral stats, received ${input.stats_60.length}`,
    )
  }

  const out = new Uint8Array(2 + BEHAVIORAL_STAT_COUNT * 2) // 122 bytes <= 400 bytes
  out[0] = 1
  out[1] = BEHAVIORAL_STAT_COUNT
  const view = new DataView(out.buffer)
  for (let i = 0; i < BEHAVIORAL_STAT_COUNT; i++) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(input.stats_60[i]) ? input.stats_60[i] : 0))
    view.setUint16(2 + i * 2, Math.round(clamped * 65535), false)
  }
  if (out.byteLength > MAX_COMPRESSED_BEHAVIORAL_BYTES) {
    throw new Error(`Compressed behavioral payload exceeded ${MAX_COMPRESSED_BEHAVIORAL_BYTES} bytes`)
  }
  return out
}

export function decompressBehavioralStats60(bytes: Uint8Array): readonly number[] {
  if (bytes.byteLength !== 2 + BEHAVIORAL_STAT_COUNT * 2 || bytes[0] !== 1) {
    throw new Error('Invalid compressed behavioral stats payload')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  for (let i = 0; i < BEHAVIORAL_STAT_COUNT; i++) {
    out.push(view.getUint16(2 + i * 2, false) / 65535)
  }
  return Object.freeze(out)
}

export interface PanelCohortCoverage {
  readonly assistive_tech_included: boolean
  readonly input_methods_included: boolean
  readonly ad_blockers_included: boolean
}

export interface LocalAiCertificateInput {
  readonly certificate_id: string
  readonly model_version: string
  readonly issued_at: string
  readonly positive_family_recalls: Readonly<Record<string, number>>
  readonly unseen_framework_recalls: Readonly<Record<string, number>>
  readonly threshold_panel_n: number
  readonly test_panel_n: number
  readonly test_panel_false_positives: number
  readonly panel_cohort_coverage: PanelCohortCoverage
  readonly wild_flagged_rate: number
  readonly disclosed_pi_max?: number
  readonly panel_vs_wild_auc: number
  readonly max_human_fpr_upper_bound?: number
  readonly min_per_family_recall?: number
  readonly min_mean_family_recall?: number
  readonly expected_calibration_error?: number
  readonly max_expected_calibration_error?: number
  readonly roc_auc?: number
  readonly min_roc_auc?: number
  readonly pr_auc?: number
  readonly min_pr_auc?: number
}

export interface LocalAiModelCertificate {
  readonly certificate_id: string
  readonly model_version: string
  readonly issued_at: string
  readonly valid: boolean
  readonly certified: boolean
  readonly gate_failures: readonly string[]
  readonly positive_family_count: number
  readonly per_family_recall: Readonly<Record<string, number>>
  readonly unseen_framework_recall: Readonly<Record<string, number>>
  readonly threshold_panel_n: number
  readonly test_panel_n: number
  readonly test_panel_false_positives: number
  readonly human_fpr_upper_bound_95: number
  readonly wild_flagged_rate: number
  readonly disclosed_pi_max: number
  readonly wild_implied_fpr_upper_bound: number
  readonly panel_vs_wild_auc: number
  readonly panel_wild_indistinguishable: boolean
  readonly panel_cohort_coverage: PanelCohortCoverage
  readonly undetectable_classes: typeof UNDETECTABLE_LOCAL_AI_CLASSES
}

/**
 * Acklam's rational approximation to the standard normal quantile function Phi^{-1}(p),
 * accurate to < 1.15e-9 across p in (0, 1).
 */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error(`normalQuantile requires p in (0, 1), received ${p}`)
  }
  const a1 = -3.969683028665376e1
  const a2 = 2.209460984245205e2
  const a3 = -2.759285104469687e2
  const a4 = 1.38357751867269e2
  const a5 = -3.066479806614716e1
  const a6 = 2.506628277459239

  const b1 = -5.447609879822406e1
  const b2 = 1.615858368580409e2
  const b3 = -1.556989798598866e2
  const b4 = 6.680131188771972e1
  const b5 = -1.328068155288572e1

  const c1 = -7.784894002430293e-3
  const c2 = -3.223964580411365e-1
  const c3 = -2.400758277161838
  const c4 = -2.549732539343734
  const c5 = 4.374664141464968
  const c6 = 2.938163982698783

  const d1 = 7.784695709041462e-3
  const d2 = 3.224671290700398e-1
  const d3 = 2.445134137142996
  const d4 = 3.754408661907416

  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    )
  }
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(
    (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
  )
}

export function wilsonScoreInterval(
  successes: number,
  trials: number,
  twoSidedAlpha = 0.05,
): { readonly lower: number; readonly upper: number; readonly z: number } {
  if (!Number.isFinite(trials) || trials <= 0) {
    return Object.freeze({ lower: 0, upper: 1, z: 0 })
  }
  const clampedK = Math.min(trials, Math.max(0, successes))
  const alpha = Math.min(0.5, Math.max(1e-12, twoSidedAlpha))
  const z = normalQuantile(1 - alpha / 2)
  const z2 = z * z
  const p = clampedK / trials
  const denom = 1 + z2 / trials
  const center = p + z2 / (2 * trials)
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
  return Object.freeze({
    lower: Math.max(0, (center - half) / denom),
    upper: Math.min(1, (center + half) / denom),
    z,
  })
}

export interface SimultaneousBucketInterval {
  readonly bucket_id: string
  readonly successes: number
  readonly trials: number
  readonly point_rate: number | null
  readonly lower: number
  readonly upper: number
  readonly adjusted_alpha: number
}

/**
 * Computes simultaneous Wilson score confidence intervals across k >= 1 buckets
 * with family-wise error rate control (Bonferroni alpha/k by default, valid under arbitrary dependence; or Sidak).
 */
export function computeSimultaneousWilsonIntervals(
  buckets: ReadonlyArray<{
    readonly bucket_id: string
    readonly successes: number
    readonly trials: number
  }>,
  options?: {
    readonly familywise_alpha?: number
    readonly method?: 'bonferroni' | 'sidak'
  },
): readonly SimultaneousBucketInterval[] {
  const k = Math.max(1, buckets.length)
  const fwAlpha = Math.min(0.5, Math.max(1e-9, options?.familywise_alpha ?? 0.05))
  const method = options?.method ?? 'bonferroni'
  const perAlpha = method === 'sidak' ? 1 - Math.pow(1 - fwAlpha, 1 / k) : fwAlpha / k

  return Object.freeze(
    buckets.map((b) => {
      const ci = wilsonScoreInterval(b.successes, b.trials, perAlpha)
      return Object.freeze({
        bucket_id: b.bucket_id,
        successes: b.successes,
        trials: b.trials,
        point_rate: b.trials > 0 ? b.successes / b.trials : null,
        lower: ci.lower,
        upper: ci.upper,
        adjusted_alpha: perAlpha,
      })
    }),
  )
}

/**
 * Conservative ratio interval arithmetic [A_L, A_U] / [B_L, B_U] (for non-negative quantities).
 * NEVER divides by a point estimate when the denominator CI contains or touches 0!
 */
export function divideConfidenceIntervalsConservative(
  numerator: { readonly lower: number; readonly upper: number },
  denominator: { readonly lower: number; readonly upper: number },
): {
  readonly identifiable: boolean
  readonly lower: number | null
  readonly upper: number | null
  readonly reason: 'ok' | 'denominator_ci_contains_zero'
} {
  if (!Number.isFinite(denominator.lower) || denominator.lower <= 0 || denominator.upper <= 0) {
    return Object.freeze({
      identifiable: false,
      lower: null,
      upper: null,
      reason: 'denominator_ci_contains_zero',
    })
  }
  const numL = Math.max(0, numerator.lower)
  const numU = Math.max(numL, numerator.upper)
  return Object.freeze({
    identifiable: true,
    lower: numL / denominator.upper,
    upper: numU / denominator.lower,
    reason: 'ok',
  })
}

export function boundWildAiPrevalenceAndLift(params: {
  readonly wild_flagged_count: number
  readonly wild_scorable_n: number
  readonly panel_false_positives: number
  readonly panel_n: number
  readonly positive_recall_hits: number
  readonly positive_recall_trials: number
  readonly disclosed_pi_max?: number
  readonly familywise_alpha?: number
}): {
  readonly identifiable: boolean
  readonly status: 'ok' | 'unidentifiable'
  readonly prevalence_lower: number
  readonly prevalence_upper: number | null
  readonly disclosed_pi_max: number
  readonly reason: string
} {
  const piMax = params.disclosed_pi_max ?? DEFAULT_WILD_AI_PRIOR_CAP_PI_MAX
  const cIs = computeSimultaneousWilsonIntervals(
    [
      {
        bucket_id: 'wild_flagged',
        successes: params.wild_flagged_count,
        trials: params.wild_scorable_n,
      },
      {
        bucket_id: 'panel_fpr',
        successes: params.panel_false_positives,
        trials: params.panel_n,
      },
      {
        bucket_id: 'positive_tpr',
        successes: params.positive_recall_hits,
        trials: params.positive_recall_trials,
      },
    ],
    { familywise_alpha: params.familywise_alpha ?? 0.05, method: 'bonferroni' },
  )
  const [fCi, fprCi, tprCi] = cIs

  // Mixture: f = fpr + pi * (tpr - fpr) => pi = (f - fpr) / (tpr - fpr)
  // Denominator lower CI bound is tpr_L - fpr_U. If <= 0, prevalence upper bound is unidentifiable from data!
  const denomLower = tprCi.lower - fprCi.upper
  const denomUpper = Math.min(1, Math.max(denomLower, tprCi.upper - fprCi.lower))
  const ratio = divideConfidenceIntervalsConservative(
    {
      lower: Math.max(0, fCi.lower - fprCi.upper),
      upper: Math.max(0, fCi.upper - fprCi.lower),
    },
    { lower: denomLower, upper: denomUpper },
  )
  if (!ratio.identifiable || ratio.upper === null || ratio.lower === null) {
    return Object.freeze({
      identifiable: false,
      status: 'unidentifiable',
      prevalence_lower: 0,
      prevalence_upper: null,
      disclosed_pi_max: piMax,
      reason: 'denominator_ci_contains_zero',
    })
  }
  return Object.freeze({
    identifiable: true,
    status: 'ok',
    prevalence_lower: Math.min(piMax, Math.max(0, ratio.lower)),
    prevalence_upper: Math.min(piMax, Math.min(1, ratio.upper)),
    disclosed_pi_max: piMax,
    reason: 'ok',
  })
}

export function computeFprUpperBound95(falsePositives: number, totalNegatives: number): number {
  if (totalNegatives <= 0) return 1
  if (falsePositives < 0 || !Number.isFinite(falsePositives)) return 1
  if (falsePositives === 0) {
    return Math.min(1, 3 / totalNegatives)
  }
  const p = Math.min(1, falsePositives / totalNegatives)
  const z = 1.6448536269514722
  const denom = 1 + (z * z) / totalNegatives
  const center = p + (z * z) / (2 * totalNegatives)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * totalNegatives)) / totalNegatives)
  return Math.min(1, (center + margin) / denom)
}

export function buildLocalAiModelCertificate(
  input: LocalAiCertificateInput,
): LocalAiModelCertificate {
  const failures: string[] = []
  const familyNames = Object.keys(input.positive_family_recalls)
  const piMax = input.disclosed_pi_max ?? DEFAULT_WILD_AI_PRIOR_CAP_PI_MAX

  if (!Number.isFinite(piMax) || piMax <= 0 || piMax >= 1) {
    failures.push(`invalid_disclosed_pi_max:${piMax}`)
  }
  if (familyNames.length < MIN_POSITIVE_FAMILIES) {
    failures.push(`positive_families_lt_${MIN_POSITIVE_FAMILIES}:${familyNames.length}`)
  }

  const minPerFamRecall = input.min_per_family_recall ?? DEFAULT_MIN_PER_FAMILY_RECALL
  const minMeanRecall = input.min_mean_family_recall ?? DEFAULT_MIN_MEAN_FAMILY_RECALL
  if (familyNames.length > 0) {
    let recallSum = 0
    for (const fam of familyNames) {
      const r = input.positive_family_recalls[fam]
      if (!Number.isFinite(r) || r < minPerFamRecall || r > 1) {
        failures.push(`family_recall_below_floor:${fam}=${r}`)
      }
      recallSum += Number.isFinite(r) ? r : 0
    }
    const meanRecall = recallSum / familyNames.length
    if (meanRecall < minMeanRecall) {
      failures.push(`mean_family_recall_lt_${minMeanRecall}:${meanRecall.toFixed(4)}`)
    }
  }

  if (input.threshold_panel_n < MIN_THRESHOLD_PANEL_N) {
    failures.push(`threshold_panel_n_lt_${MIN_THRESHOLD_PANEL_N}:${input.threshold_panel_n}`)
  }
  if (input.test_panel_n < MIN_TEST_PANEL_N) {
    failures.push(`test_panel_n_lt_${MIN_TEST_PANEL_N}:${input.test_panel_n}`)
  }
  if (input.test_panel_false_positives < 0 || input.test_panel_false_positives > input.test_panel_n) {
    failures.push(`invalid_test_panel_false_positives:${input.test_panel_false_positives}`)
  }
  if (
    !input.panel_cohort_coverage.assistive_tech_included ||
    !input.panel_cohort_coverage.input_methods_included ||
    !input.panel_cohort_coverage.ad_blockers_included
  ) {
    failures.push('incomplete_panel_cohort_coverage')
  }

  const indistinguishable =
    Number.isFinite(input.panel_vs_wild_auc) &&
    input.panel_vs_wild_auc >= PANEL_WILD_AUC_MIN &&
    input.panel_vs_wild_auc <= PANEL_WILD_AUC_MAX
  if (!indistinguishable) {
    failures.push(`panel_vs_wild_leakage_auc:${input.panel_vs_wild_auc.toFixed(4)}`)
  }

  const fprUpper = computeFprUpperBound95(input.test_panel_false_positives, input.test_panel_n)
  const maxFprUpper = input.max_human_fpr_upper_bound ?? DEFAULT_MAX_HUMAN_FPR_UPPER_BOUND
  if (fprUpper > maxFprUpper) {
    failures.push(`human_fpr_upper_bound_exceeds_cap:${fprUpper.toFixed(4)}>${maxFprUpper}`)
  }

  if (input.expected_calibration_error !== undefined) {
    const maxEce = input.max_expected_calibration_error ?? DEFAULT_MAX_CALIBRATION_ECE
    if (!Number.isFinite(input.expected_calibration_error) || input.expected_calibration_error < 0 || input.expected_calibration_error > maxEce) {
      failures.push(`calibration_ece_exceeds_cap:${input.expected_calibration_error}>${maxEce}`)
    }
  }
  if (input.roc_auc !== undefined) {
    const minRoc = input.min_roc_auc ?? DEFAULT_MIN_ROC_AUC
    if (!Number.isFinite(input.roc_auc) || input.roc_auc < minRoc || input.roc_auc > 1) {
      failures.push(`roc_auc_below_floor:${input.roc_auc}<${minRoc}`)
    }
  }
  if (input.pr_auc !== undefined) {
    const minPr = input.min_pr_auc ?? DEFAULT_MIN_PR_AUC
    if (!Number.isFinite(input.pr_auc) || input.pr_auc < minPr || input.pr_auc > 1) {
      failures.push(`pr_auc_below_floor:${input.pr_auc}<${minPr}`)
    }
  }

  const safeOneMinusPi = Number.isFinite(piMax) && piMax < 1 ? 1 - piMax : 0
  const wildFprUpper =
    safeOneMinusPi > 0
      ? Math.min(1, Math.max(0, input.wild_flagged_rate / safeOneMinusPi))
      : 1

  const isValid = failures.length === 0
  return Object.freeze({
    certificate_id: input.certificate_id,
    model_version: input.model_version,
    issued_at: input.issued_at,
    valid: isValid,
    certified: isValid,
    gate_failures: Object.freeze(failures),
    positive_family_count: familyNames.length,
    per_family_recall: Object.freeze({ ...input.positive_family_recalls }),
    unseen_framework_recall: Object.freeze({ ...input.unseen_framework_recalls }),
    threshold_panel_n: input.threshold_panel_n,
    test_panel_n: input.test_panel_n,
    test_panel_false_positives: input.test_panel_false_positives,
    human_fpr_upper_bound_95: fprUpper,
    wild_flagged_rate: input.wild_flagged_rate,
    disclosed_pi_max: piMax,
    wild_implied_fpr_upper_bound: wildFprUpper,
    panel_vs_wild_auc: input.panel_vs_wild_auc,
    panel_wild_indistinguishable: indistinguishable,
    panel_cohort_coverage: Object.freeze({ ...input.panel_cohort_coverage }),
    undetectable_classes: UNDETECTABLE_LOCAL_AI_CLASSES,
  })
}

export interface FamilyCentroidProfile {
  readonly family_id: string
  readonly centroid_60: readonly number[]
  readonly scale: number
  readonly diagonal_vars_60?: readonly number[]
}

/**
 * Exact 60D multivariate Gaussian log-density including full normalization constant:
 * log N(x | mu, Sigma) = -(d/2) log(2*pi) - (1/2) log|Sigma| - (1/2) (x - mu)^T Sigma^{-1} (x - mu).
 */
export function computeGaussianLogDensity60(
  x: readonly number[],
  centroid: readonly number[],
  scale: number,
  diagonalVars60?: readonly number[],
): { readonly logDensity: number; readonly mahalanobisSq: number } {
  const dim = Math.min(BEHAVIORAL_STAT_COUNT, x.length, centroid.length)
  const fallbackVar = Math.max(1e-6, scale * scale)
  let logDet = 0
  let mahalSq = 0
  for (let i = 0; i < dim; i++) {
    const rawVar = diagonalVars60 && i < diagonalVars60.length ? diagonalVars60[i] : fallbackVar
    const vi = Number.isFinite(rawVar) && rawVar > 1e-8 ? rawVar : fallbackVar
    const diff = x[i] - centroid[i]
    logDet += Math.log(vi)
    mahalSq += (diff * diff) / vi
  }
  const logDensity = -0.5 * dim * LOG_TWO_PI - 0.5 * logDet - 0.5 * mahalSq
  return { logDensity, mahalanobisSq: mahalSq }
}

export interface LocalAiScoringInput {
  readonly pv_id: string
  readonly pointer_type: PointerPrecisionKind
  readonly interaction_event_count: number
  readonly compressed_stats_60: Uint8Array | null
  readonly min_interaction_events?: number
}

export interface LocalAiSessionScore {
  readonly pv_id: string
  readonly scorable: boolean
  readonly unscorable_reason: string | null
  readonly status: LocalAiSessionStatus
  readonly family_likelihood_ratios: Readonly<Record<string, number>>
  readonly max_likelihood_ratio: number | null
  readonly top_family_id: string | null
  readonly novelty_score: number | null
  readonly certificate_id: string
  readonly human_fpr_upper_bound_95: number
  readonly undetectable_classes: typeof UNDETECTABLE_LOCAL_AI_CLASSES
  readonly ai_probability?: never
}

export class LocalAiLikelihoodScorer {
  constructor(
    private readonly config: {
      readonly certificate: LocalAiModelCertificate
      readonly human_centroid_60: readonly number[]
      readonly human_scale: number
      readonly human_diagonal_vars_60?: readonly number[]
      readonly family_profiles: readonly FamilyCentroidProfile[]
      readonly automated_lr_threshold?: number
      readonly human_lr_threshold?: number
      readonly novelty_automated_threshold?: number
    },
  ) {}

  scorePv(input: LocalAiScoringInput): LocalAiSessionScore {
    // Hard certification gate: NEVER score or promote to `automated` / `model_inferred` with an invalid/uncertified certificate!
    if (!this.config.certificate.valid || !this.config.certificate.certified) {
      return this.buildUnscorable(input.pv_id, 'uncertified_model_certificate')
    }

    const minEvents = input.min_interaction_events ?? MIN_SCORABLE_INTERACTION_EVENTS

    if (input.pointer_type !== 'fine') {
      return this.buildUnscorable(input.pv_id, `non_fine_pointer:${input.pointer_type}`)
    }
    if (input.interaction_event_count < minEvents) {
      return this.buildUnscorable(
        input.pv_id,
        `insufficient_interactions:${input.interaction_event_count}<${minEvents}`,
      )
    }
    if (!input.compressed_stats_60) {
      return this.buildUnscorable(input.pv_id, 'missing_behavioral_vector')
    }

    const x = decompressBehavioralStats60(input.compressed_stats_60)
    const humanGauss = computeGaussianLogDensity60(
      x,
      this.config.human_centroid_60,
      this.config.human_scale,
      this.config.human_diagonal_vars_60,
    )
    const logPHuman = humanGauss.logDensity

    const familyLrs: Record<string, number> = {}
    let maxLr = 0
    let topFamily: string | null = null

    for (const prof of this.config.family_profiles) {
      const famGauss = computeGaussianLogDensity60(
        x,
        prof.centroid_60,
        prof.scale,
        prof.diagonal_vars_60,
      )
      const logPFam = famGauss.logDensity
      const lr = Math.exp(Math.max(-60, Math.min(60, logPFam - logPHuman)))
      familyLrs[prof.family_id] = lr
      if (lr > maxLr) {
        maxLr = lr
        topFamily = prof.family_id
      }
    }

    const novelty = Math.sqrt(humanGauss.mahalanobisSq / BEHAVIORAL_STAT_COUNT)
    const autoLrThresh = this.config.automated_lr_threshold ?? 10
    const humanLrThresh = this.config.human_lr_threshold ?? 0.5
    const noveltyThresh = this.config.novelty_automated_threshold ?? 3.5

    let status: LocalAiSessionStatus
    if (maxLr >= autoLrThresh || novelty >= noveltyThresh) {
      status = 'automated'
    } else if (maxLr <= humanLrThresh && novelty < noveltyThresh * 0.6) {
      status = 'human_like'
    } else {
      status = 'undecided'
    }

    const result: LocalAiSessionScore = Object.freeze({
      pv_id: input.pv_id,
      scorable: true,
      unscorable_reason: null,
      status,
      family_likelihood_ratios: Object.freeze(familyLrs),
      max_likelihood_ratio: maxLr,
      top_family_id: topFamily,
      novelty_score: novelty,
      certificate_id: this.config.certificate.certificate_id,
      human_fpr_upper_bound_95: this.config.certificate.human_fpr_upper_bound_95,
      undetectable_classes: UNDETECTABLE_LOCAL_AI_CLASSES,
    })
    assertNoPosteriorAiProbability(result)
    return result
  }

  scoreBatch(
    inputs: readonly LocalAiScoringInput[],
    options?: { readonly familywise_alpha?: number },
  ): {
    readonly total_pvs: number
    readonly scorable_pvs: number
    readonly unscorable_pvs: number
    readonly unscorable_share: number
    readonly automated_count: number
    readonly human_like_count: number
    readonly undecided_count: number
    readonly simultaneous_bucket_intervals: readonly SimultaneousBucketInterval[]
    readonly results: readonly LocalAiSessionScore[]
  } {
    const results = inputs.map((i) => this.scorePv(i))
    const unscorable = results.filter((r) => !r.scorable).length
    const scorable = results.length - unscorable
    const automatedCount = results.filter((r) => r.status === 'automated').length
    const humanLikeCount = results.filter((r) => r.status === 'human_like').length
    const undecidedCount = results.filter((r) => r.status === 'undecided').length

    const simultaneousIntervals = computeSimultaneousWilsonIntervals(
      [
        { bucket_id: 'automated', successes: automatedCount, trials: scorable },
        { bucket_id: 'human_like', successes: humanLikeCount, trials: scorable },
        { bucket_id: 'undecided', successes: undecidedCount, trials: scorable },
        { bucket_id: 'unscorable', successes: unscorable, trials: results.length },
      ],
      { familywise_alpha: options?.familywise_alpha ?? 0.05, method: 'bonferroni' },
    )

    return Object.freeze({
      total_pvs: results.length,
      scorable_pvs: scorable,
      unscorable_pvs: unscorable,
      unscorable_share: results.length > 0 ? unscorable / results.length : 0,
      automated_count: automatedCount,
      human_like_count: humanLikeCount,
      undecided_count: undecidedCount,
      simultaneous_bucket_intervals: simultaneousIntervals,
      results: Object.freeze(results),
    })
  }

  private buildUnscorable(pvId: string, reason: string): LocalAiSessionScore {
    return Object.freeze({
      pv_id: pvId,
      scorable: false,
      unscorable_reason: reason,
      status: 'unscorable',
      family_likelihood_ratios: Object.freeze({}),
      max_likelihood_ratio: null,
      top_family_id: null,
      novelty_score: null,
      certificate_id: this.config.certificate.certificate_id,
      human_fpr_upper_bound_95: this.config.certificate.human_fpr_upper_bound_95,
      undetectable_classes: UNDETECTABLE_LOCAL_AI_CLASSES,
    })
  }
}
