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
}

export interface LocalAiModelCertificate {
  readonly certificate_id: string
  readonly model_version: string
  readonly issued_at: string
  readonly valid: boolean
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

export function computeFprUpperBound95(falsePositives: number, totalNegatives: number): number {
  if (totalNegatives <= 0) return 1
  if (falsePositives <= 0) {
    return Math.min(1, 3 / totalNegatives)
  }
  const p = falsePositives / totalNegatives
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

  if (familyNames.length < MIN_POSITIVE_FAMILIES) {
    failures.push(`positive_families_lt_${MIN_POSITIVE_FAMILIES}:${familyNames.length}`)
  }
  if (input.threshold_panel_n < MIN_THRESHOLD_PANEL_N) {
    failures.push(`threshold_panel_n_lt_${MIN_THRESHOLD_PANEL_N}:${input.threshold_panel_n}`)
  }
  if (input.test_panel_n < MIN_TEST_PANEL_N) {
    failures.push(`test_panel_n_lt_${MIN_TEST_PANEL_N}:${input.test_panel_n}`)
  }
  if (
    !input.panel_cohort_coverage.assistive_tech_included ||
    !input.panel_cohort_coverage.input_methods_included ||
    !input.panel_cohort_coverage.ad_blockers_included
  ) {
    failures.push('incomplete_panel_cohort_coverage')
  }

  const indistinguishable =
    input.panel_vs_wild_auc >= PANEL_WILD_AUC_MIN && input.panel_vs_wild_auc <= PANEL_WILD_AUC_MAX
  if (!indistinguishable) {
    failures.push(`panel_vs_wild_leakage_auc:${input.panel_vs_wild_auc.toFixed(4)}`)
  }

  const fprUpper = computeFprUpperBound95(input.test_panel_false_positives, input.test_panel_n)
  const wildFprUpper = Math.min(1, Math.max(0, input.wild_flagged_rate / Math.max(0.01, 1 - piMax)))

  return Object.freeze({
    certificate_id: input.certificate_id,
    model_version: input.model_version,
    issued_at: input.issued_at,
    valid: failures.length === 0,
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

function l2DistanceSquared(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return sum
}

export class LocalAiLikelihoodScorer {
  constructor(
    private readonly config: {
      readonly certificate: LocalAiModelCertificate
      readonly human_centroid_60: readonly number[]
      readonly human_scale: number
      readonly family_profiles: readonly FamilyCentroidProfile[]
      readonly automated_lr_threshold?: number
      readonly human_lr_threshold?: number
      readonly novelty_automated_threshold?: number
    },
  ) {}

  scorePv(input: LocalAiScoringInput): LocalAiSessionScore {
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
    const dHuman = l2DistanceSquared(x, this.config.human_centroid_60)
    const humanVar = Math.max(1e-4, this.config.human_scale * this.config.human_scale)
    const logPHuman = -dHuman / (2 * humanVar)

    const familyLrs: Record<string, number> = {}
    let maxLr = 0
    let topFamily: string | null = null

    for (const prof of this.config.family_profiles) {
      const dFam = l2DistanceSquared(x, prof.centroid_60)
      const famVar = Math.max(1e-4, prof.scale * prof.scale)
      const logPFam = -dFam / (2 * famVar)
      const lr = Math.exp(Math.max(-30, Math.min(30, logPFam - logPHuman)))
      familyLrs[prof.family_id] = lr
      if (lr > maxLr) {
        maxLr = lr
        topFamily = prof.family_id
      }
    }

    const novelty = Math.sqrt(dHuman / (BEHAVIORAL_STAT_COUNT * humanVar))
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

  scoreBatch(inputs: readonly LocalAiScoringInput[]): {
    readonly total_pvs: number
    readonly scorable_pvs: number
    readonly unscorable_pvs: number
    readonly unscorable_share: number
    readonly automated_count: number
    readonly human_like_count: number
    readonly undecided_count: number
    readonly results: readonly LocalAiSessionScore[]
  } {
    const results = inputs.map((i) => this.scorePv(i))
    const unscorable = results.filter((r) => !r.scorable).length
    const scorable = results.length - unscorable
    return Object.freeze({
      total_pvs: results.length,
      scorable_pvs: scorable,
      unscorable_pvs: unscorable,
      unscorable_share: results.length > 0 ? unscorable / results.length : 0,
      automated_count: results.filter((r) => r.status === 'automated').length,
      human_like_count: results.filter((r) => r.status === 'human_like').length,
      undecided_count: results.filter((r) => r.status === 'undecided').length,
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
