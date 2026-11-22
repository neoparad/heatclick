/**
 * UGOKI LINK v2 — 束 4-I (§11.12): 行為者別比較ルール & 実験との分離契約
 *
 * 設計書 §11.12:
 * 1. **行為者 5 区分**（`verified_actor` / `explicit_evidence` / `model_inferred` /
 *    `undecided_unscorable` / `lab_run`）＋ `http_crawler` に分け、常に `verdict_version` を付与。
 * 2. **`model_inferred` 群の制約**:
 *    - 確率 (`P(AI|session)`) ではなく「尤度比 (`likelihood_ratio`) ＋ 誤検知率上限 (`fpr_upper_bound`)」で表記。
 *    - **分類器の特徴に使っていない指標のみ**を返す（単独表示・群間比較ともに同一規則 §7.6 / §11.12）。
 * 3. **`http_crawler` の制約**:
 *    - 取得事実（status/redirect/blocked/raw-html diff）のみ描き、区画閲覧/滞在・クリック絵は禁止。
 * 4. **実験との関係**:
 *    - 実験・案・露出条件ごとに分け、分母 (`denominator_units`) と `comparable` フラグを表示。
 *    - `is_verdict_tool: false` を強制し、勝ち負け・停止・本採用判定には使えない旨を明記する。
 */

import type { HeatmapActorBucket, HeatmapKind } from './types'

// ---------------------------------------------------------------------------
// Classifier Feature Exclusion Guard for `model_inferred` (§7.6 / §11.12)
// ---------------------------------------------------------------------------

/**
 * ローカル AI 分類器の入力特徴（行動統計 60 特徴）に該当する指標キー。
 * `model_inferred` 群の単独表示・群間比較では循環論法を防ぐため一切出力禁止 (§7.6 / §11.12)。
 */
export const LOCAL_AI_CLASSIFIER_FEATURE_METRICS: ReadonlySet<string> = new Set([
  'pointer_velocity_mean',
  'pointer_curvature_entropy',
  'click_interval_cv',
  'scroll_cadence_uniformity',
  'keystroke_dwell_variance',
  'focus_switch_rate',
  'hover_to_click_latency_ms',
  'mouse_straightness_ratio',
  'novelty_score',
  'max_likelihood_ratio',
  'family_likelihood_ratio',
])

export function isLocalAiClassifierFeatureMetric(metricKey: string): boolean {
  const norm = metricKey.trim().toLowerCase()
  return (
    LOCAL_AI_CLASSIFIER_FEATURE_METRICS.has(norm) ||
    /^behavioral_stat_\d+$/.test(norm) ||
    norm.startsWith('family_likelihood_ratio')
  )
}

export interface FeatureProvenanceDescriptor {
  readonly feature_key?: string
  readonly key?: string
  readonly provenance: 'observed' | 'verified_actor' | 'explicit_evidence' | 'model_inferred' | string
}

export function assertNoModelInferredInputFeatures(
  features: readonly FeatureProvenanceDescriptor[] | Readonly<Record<string, string>> | undefined,
): void {
  if (!features) return
  if (Array.isArray(features)) {
    const leaked = features
      .filter((f) => f.provenance === 'model_inferred')
      .map((f) => f.feature_key ?? f.key ?? 'unknown_feature')
    if (leaked.length > 0) {
      throw new Error(
        `Model-inferred feature provenance is strictly banned as downstream input: [${leaked.join(', ')}] (§7.5 / §7.6)`,
      )
    }
    return
  }
  const leaked = Object.entries(features)
    .filter(([, prov]) => prov === 'model_inferred')
    .map(([k]) => k)
  if (leaked.length > 0) {
    throw new Error(
      `Model-inferred feature provenance is strictly banned as downstream input: [${leaked.join(', ')}] (§7.5 / §7.6)`,
    )
  }
}

export interface ModelInferredDisclosureHeader {
  readonly verdict_version: string
  readonly likelihood_ratio: number
  readonly fpr_upper_bound: number
  readonly certificate_id: string
  readonly probability_omitted_by_design: true
}

export interface ActorBucketPolicyCheck {
  readonly allowed: boolean
  readonly bucket: HeatmapActorBucket
  readonly verdict_version: string
  readonly effective_render_mode: 'behavioral_heatmap' | 'http_fetch_only' | 'rejected'
  readonly model_inferred_disclosure: ModelInferredDisclosureHeader | null
  readonly rejection_reason: string | null
}

/**
 * 行為者区分に対するヒートマップ生成規則（単独・比較共通）を検査する (§11.12)。
 */
export function validateActorBucketForHeatmap(params: {
  readonly bucket: HeatmapActorBucket
  readonly kind: HeatmapKind
  readonly verdict_version: string
  readonly requested_metric_keys?: readonly string[]
  readonly input_feature_provenances?:
    | readonly FeatureProvenanceDescriptor[]
    | Readonly<Record<string, string>>
  readonly model_inferred_header?: {
    readonly likelihood_ratio: number
    readonly fpr_upper_bound: number
    readonly certificate_id: string
    readonly certified?: boolean
    readonly ai_probability?: never
  } | null
}): ActorBucketPolicyCheck {
  if (!params.verdict_version || !params.verdict_version.trim()) {
    return Object.freeze({
      allowed: false,
      bucket: params.bucket,
      verdict_version: params.verdict_version,
      effective_render_mode: 'rejected',
      model_inferred_disclosure: null,
      rejection_reason: 'missing_verdict_version',
    })
  }

  try {
    assertNoModelInferredInputFeatures(params.input_feature_provenances)
  } catch (err) {
    return Object.freeze({
      allowed: false,
      bucket: params.bucket,
      verdict_version: params.verdict_version,
      effective_render_mode: 'rejected',
      model_inferred_disclosure: null,
      rejection_reason:
        err instanceof Error ? err.message : 'model_inferred_input_feature_prohibited',
    })
  }

  // 1. HTTP Crawler: NEVER draws click, scroll_reach, or section_dwell behavioral maps!
  if (params.bucket === 'http_crawler') {
    return Object.freeze({
      allowed: true,
      bucket: params.bucket,
      verdict_version: params.verdict_version,
      effective_render_mode: 'http_fetch_only',
      model_inferred_disclosure: null,
      rejection_reason: null,
    })
  }

  // 2. model_inferred: requires LR + FPR upper bound (NEVER probability), certified cert, and bans classifier features!
  if (params.bucket === 'model_inferred') {
    if (!params.model_inferred_header) {
      return Object.freeze({
        allowed: false,
        bucket: params.bucket,
        verdict_version: params.verdict_version,
        effective_render_mode: 'rejected',
        model_inferred_disclosure: null,
        rejection_reason: 'model_inferred_requires_likelihood_ratio_and_fpr_upper_bound',
      })
    }

    // Runtime check against accidental ai_probability leak
    const rawHeader = params.model_inferred_header as Record<string, unknown>
    if (
      'ai_probability' in rawHeader ||
      'p_ai' in rawHeader ||
      'bot_probability' in rawHeader ||
      'posterior_ai_probability' in rawHeader
    ) {
      throw new Error(
        'Prohibited posterior AI probability detected on model_inferred heatmap (§7.5 / §11.12)',
      )
    }

    if (params.model_inferred_header.certified === false) {
      return Object.freeze({
        allowed: false,
        bucket: params.bucket,
        verdict_version: params.verdict_version,
        effective_render_mode: 'rejected',
        model_inferred_disclosure: null,
        rejection_reason: 'uncertified_model_certificate_rejected',
      })
    }

    if (
      !params.model_inferred_header.certificate_id ||
      !params.model_inferred_header.certificate_id.trim() ||
      !Number.isFinite(params.model_inferred_header.likelihood_ratio) ||
      params.model_inferred_header.likelihood_ratio <= 0 ||
      !Number.isFinite(params.model_inferred_header.fpr_upper_bound) ||
      params.model_inferred_header.fpr_upper_bound <= 0 ||
      params.model_inferred_header.fpr_upper_bound > 1
    ) {
      return Object.freeze({
        allowed: false,
        bucket: params.bucket,
        verdict_version: params.verdict_version,
        effective_render_mode: 'rejected',
        model_inferred_disclosure: null,
        rejection_reason: 'invalid_model_inferred_disclosure_header_bounds',
      })
    }

    const forbiddenUsed = (params.requested_metric_keys ?? []).filter((k) =>
      isLocalAiClassifierFeatureMetric(k),
    )
    if (forbiddenUsed.length > 0) {
      return Object.freeze({
        allowed: false,
        bucket: params.bucket,
        verdict_version: params.verdict_version,
        effective_render_mode: 'rejected',
        model_inferred_disclosure: null,
        rejection_reason: `classifier_feature_metric_prohibited_for_model_inferred:${forbiddenUsed.join(',')}`,
      })
    }

    return Object.freeze({
      allowed: true,
      bucket: params.bucket,
      verdict_version: params.verdict_version,
      effective_render_mode: 'behavioral_heatmap',
      model_inferred_disclosure: Object.freeze({
        verdict_version: params.verdict_version,
        likelihood_ratio: params.model_inferred_header.likelihood_ratio,
        fpr_upper_bound: params.model_inferred_header.fpr_upper_bound,
        certificate_id: params.model_inferred_header.certificate_id,
        probability_omitted_by_design: true,
      }),
      rejection_reason: null,
    })
  }

  return Object.freeze({
    allowed: true,
    bucket: params.bucket,
    verdict_version: params.verdict_version,
    effective_render_mode: 'behavioral_heatmap',
    model_inferred_disclosure: null,
    rejection_reason: null,
  })
}

// ---------------------------------------------------------------------------
// Experiment Variant Heatmap Separation & Non-Verdict Enforcement (§11.12)
// ---------------------------------------------------------------------------

export interface ExperimentVariantHeatmapSlice {
  readonly experiment_id: string
  readonly variant_key: string
  readonly exposure_condition: string
  readonly denominator_units: number
  readonly skel_fp: string | null
  readonly css_fp: string | null
  readonly unit_key_serialized: string
  readonly actor_bucket?: HeatmapActorBucket
  readonly verdict_version?: string
  readonly model_inferred_disclosure?: ModelInferredDisclosureHeader | null
}

export interface ExperimentHeatmapComparisonContract {
  readonly experiment_id: string
  readonly slices: readonly ExperimentVariantHeatmapSlice[]
  readonly comparable: boolean
  readonly comparability_reasons: readonly string[]
  /** §11.12: Heatmaps are observational descriptions ONLY — NEVER a verdict / winner selection tool */
  readonly is_verdict_tool: false
  readonly verdict_disclaimer: string
}

export function buildExperimentHeatmapComparison(params: {
  readonly experiment_id: string
  readonly slices: readonly ExperimentVariantHeatmapSlice[]
  readonly min_comparable_units_per_arm?: number
}): ExperimentHeatmapComparisonContract {
  const minUnits = params.min_comparable_units_per_arm ?? 30
  const reasons: string[] = []

  if (params.slices.length < 2) {
    reasons.push('fewer_than_two_variant_slices')
  }

  const exposureConditions = new Set(params.slices.map((s) => s.exposure_condition))
  if (exposureConditions.size > 1) {
    reasons.push('mismatched_exposure_conditions_across_variants')
  }

  const verdictVersions = new Set(
    params.slices.map((s) => s.verdict_version).filter((v): v is string => Boolean(v)),
  )
  if (verdictVersions.size > 1) {
    reasons.push('mismatched_verdict_versions_across_variants')
  }

  for (const s of params.slices) {
    if (s.experiment_id !== params.experiment_id) {
      reasons.push(`slice_experiment_mismatch:${s.experiment_id}`)
    }
    if (s.denominator_units < minUnits) {
      reasons.push(`insufficient_denominator_units:${s.variant_key}=${s.denominator_units}`)
    }
    if (s.actor_bucket === 'model_inferred') {
      const disc = s.model_inferred_disclosure
      if (
        !disc ||
        !disc.certificate_id?.trim() ||
        !disc.verdict_version?.trim() ||
        !Number.isFinite(disc.likelihood_ratio) ||
        disc.likelihood_ratio <= 0 ||
        !Number.isFinite(disc.fpr_upper_bound) ||
        disc.fpr_upper_bound <= 0 ||
        disc.fpr_upper_bound > 1 ||
        disc.probability_omitted_by_design !== true
      ) {
        reasons.push(`missing_or_invalid_model_inferred_disclosure:${s.variant_key}`)
      }
    }
  }

  return Object.freeze({
    experiment_id: params.experiment_id,
    slices: Object.freeze([...params.slices]),
    comparable: reasons.length === 0,
    comparability_reasons: Object.freeze(reasons),
    is_verdict_tool: false,
    verdict_disclaimer:
      'Observational description only (§11.12): Do not use heatmaps for winner selection, early stopping, or promotion; decisions must pass §9 preregistered statistical testing.',
  })
}
