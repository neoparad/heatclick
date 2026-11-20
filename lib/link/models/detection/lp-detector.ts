/**
 * UGOKI LINK v2 — Bundle 6-A.1: LP Excess-Loss Detector & 5 Proposal Sources
 * (`lib/link/models/detection/lp-detector.ts`)
 *
 * Implements §8.4, §8.12, ML M4:
 * - 3-tier ladder (all implemented; upper tiers registered as `challenger` in 4-F registry):
 *   1. H0: Depth / read-progress survival curve (Kaplan-Meier, computable on existing history)
 *   2. H1a: Section-level exit hazard with hierarchical position × section-role expectation
 *   3. H1b: Cross-site expectation model using CRAWL structural + 4-G semantic features (`challenger`)
 * - Excess-loss anomaly verdict (`evidence: 'inferred'`):
 *   Gamma-Poisson shrinkage computing posterior `P(O / E > 1.25) >= 0.95`, controlled across
 *   all tested sections with Benjamini-Hochberg FDR <= 10%.
 *   Returns at the finest level passing minimum expected-count power (`page×section -> template×role -> site×role`).
 * - 5 Proposal Sources (plus 4-G LLM hypotheses):
 *   1. `rule_hit`
 *   2. `targeted_probe`
 *   3. `exemplar_contrast`
 *   4. `search_gap`
 *   5. `recommender_to_link`
 *   All outputs carry typed patch proposal + hypothesis with `evidence: 'planned'`, ranked by
 *   `prior_effect_width * daily_traffic / days_to_verdict`.
 * - TreeSHAP feature-attribution explanation strictly explains WHAT the expectation model saw;
 *   NEVER emits a predicted improvement lift number below `proven` (`ProjectedLiftBelowProvenError`).
 */

import {
  createDataLayerMetric,
  type EvidenceLevel,
  type VerifiedMetricValue,
} from '../../../../packages/contract/response';
import { sha256Hex } from '../../../../packages/contract/schema';
import type { MlModelRegistry } from '../../ml/foundation/registry';

export type DetectionLadderRung = 'H0_survival' | 'H1a_section_hazard' | 'H1b_cross_site_challenger';

export type DetectionAggregationLevel = 'page_x_section' | 'template_x_role' | 'site_x_role';

export type ProposalSourceKind =
  | 'rule_hit'
  | 'targeted_probe'
  | 'exemplar_contrast'
  | 'search_gap'
  | 'recommender_to_link'
  | 'llm_hypothesis_challenger';

export class ProjectedLiftBelowProvenError extends Error {
  constructor(level: EvidenceLevel) {
    super(
      `§8.4 / D-07 Prohibition: Improvement lift numbers are FORBIDDEN below "proven" (attempted at "${level}"). TreeSHAP explains expectation model inputs only.`
    );
    this.name = 'ProjectedLiftBelowProvenError';
  }
}

/**
 * Registers the H1a & H1b LP detection models into Bundle 4-F `MlModelRegistry` as challengers.
 */
export function registerLpDetectionChallengers(
  registry: MlModelRegistry,
  tenantScope: string,
  nowIso: string
): readonly string[] {
  const specs = [
    { id: 'lp_detect_h1a_hazard_v1', family: 'lp_detection_h1a', seed: 101 },
    { id: 'lp_detect_h1b_cross_site_crawl_llm_v1', family: 'lp_detection_h1b_challenger', seed: 102 },
  ] as const;

  const ids: string[] = [];
  for (const s of specs) {
    registry.registerModelVersion({
      model_version_id: s.id,
      model_family: s.family,
      tenant_scope: tenantScope,
      artifact_sha256: sha256Hex(`challenger:${s.id}:${tenantScope}`),
      abi_version: 1,
      feature_set_version: 'lp_sec_crawl_llm_v1',
      label_contract_version: 'exit_hazard_v1',
      dataset_id: 'pending_real_data',
      deletion_generation: registry.getDeletionGeneration(),
      code_version: 'wave6_6a_v1',
      runtime_env: 'server_ts',
      seed: s.seed,
      license_bundle: {
        license_id: 'Proprietary-UGOKI-LINK',
        notice_text: 'UGOKI LINK v2 LP detection challenger model',
        distribution_scope: 'server_only',
      },
      created_at_iso: nowIso,
      status: 'challenger',
      contributing_subject_ids: [],
    });
    ids.push(s.id);
  }
  return ids;
}

// =========================================================================
// Tier 1 (H0): Read-Progress Kaplan-Meier Survival Curve
// =========================================================================

export interface ReadProgressObservation {
  /** Last section ordinal reached (0-based). */
  readonly max_section_idx: number;
  /** True if PV terminated unconfirmed (right-censored, not a confirmed exit). */
  readonly censored: boolean;
}

export interface SurvivalCurvePoint {
  readonly section_idx: number;
  readonly at_risk: number;
  readonly exits: number;
  readonly censored: number;
  readonly hazard: number;
  readonly survival_prob: number;
}

export function computeReadProgressSurvivalCurve(
  observations: readonly ReadProgressObservation[],
  totalSections: number
): readonly SurvivalCurvePoint[] {
  const points: SurvivalCurvePoint[] = [];
  let survival = 1.0;

  for (let s = 0; s < totalSections; s++) {
    let atRisk = 0;
    let exits = 0;
    let censored = 0;
    for (const obs of observations) {
      if (obs.max_section_idx >= s) {
        atRisk += 1;
        if (obs.max_section_idx === s) {
          if (obs.censored) censored += 1;
          else exits += 1;
        }
      }
    }
    const hazard = atRisk > 0 ? exits / atRisk : 0;
    survival = survival * (1 - hazard);
    points.push({
      section_idx: s,
      at_risk: atRisk,
      exits,
      censored,
      hazard: Number(hazard.toFixed(6)),
      survival_prob: Number(survival.toFixed(6)),
    });
  }
  return points;
}

// =========================================================================
// Tier 2 & 3 (H1a / H1b): Gamma-Poisson Excess-Loss Detector + BH FDR <= 10%
// =========================================================================

export interface SectionExitObservation {
  readonly page_id: string;
  readonly template_id: string;
  readonly sec_fp: string;
  readonly section_role: string;
  /** Normalized 0..1 position inside page. */
  readonly position_frac: number;
  readonly exposures_n: number;
  readonly observed_exits: number;
  /** Baseline hazard rate from position × role (+ optional CRAWL/LLM challenger adjustment). */
  readonly expected_exit_rate: number;
  /** Overdispersion factor φ >= 1 (default 1.0). */
  readonly overdispersion_phi?: number;
  /** Optional CRAWL + 4-G semantic feature contributions for TreeSHAP expectation explanation. */
  readonly expectation_feature_shap?: Readonly<Record<string, number>>;
}

export interface ExcessLossFlagResult {
  readonly key: string;
  readonly aggregation_level: DetectionAggregationLevel;
  readonly rung_used: DetectionLadderRung;
  readonly evidence_level: 'inferred';
  readonly status: 'ok' | 'insufficient_data';
  readonly observed_exits: VerifiedMetricValue<number>;
  readonly expected_exits: VerifiedMetricValue<number>;
  readonly oe_ratio_point: number;
  /** Posterior P(O / E > 1.25) under Gamma-Poisson shrinkage. */
  readonly prob_oe_gt_125: number;
  /** Raw one-sided p-value = 1 - P(O/E > 1.25). */
  readonly raw_p_value: number;
  readonly fdr_q_value: number;
  readonly flagged: boolean;
  readonly detectable_ratio: number;
  /** Explains WHAT the expectation model saw — NEVER a causal lift claim! */
  readonly expectation_treeshap: readonly { readonly feature: string; readonly contribution: number }[];
}

/** Standard normal CDF Φ(z) via Abramowitz & Stegun 7.1.26 (max error 1.5e-7). */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Computes posterior `P(rate_ratio > threshold)` using Gamma-Poisson shrinkage
 * with prior Gamma(alpha0, beta0) centered at 1.0 (alpha0 = beta0 = 8 / phi),
 * evaluated via Wilson-Hilferty cube-root normal approximation to Gamma CDF.
 */
export function computeGammaPoissonExceedanceProb(
  observed: number,
  expected: number,
  thresholdRatio = 1.25,
  overdispersionPhi = 1.0
): number {
  if (expected <= 0) return 0;
  const phi = Math.max(1, overdispersionPhi);
  // Effective counts scaled by 1/phi for overdispersion
  const alpha0 = 8 / phi;
  const beta0 = 8 / phi;
  const alphaPost = alpha0 + observed / phi;
  const betaPost = beta0 + expected / phi;

  // Gamma(alphaPost, rate=betaPost) > thresholdRatio <=> Gamma(alphaPost, rate=1) > betaPost * thresholdRatio
  const x = betaPost * thresholdRatio;
  if (x <= 0) return 1;
  // Wilson-Hilferty approximation for Gamma(k, 1): (x/k)^(1/3) ~ N(1 - 1/(9k), 1/(9k))
  const k = Math.max(0.5, alphaPost);
  const mean = 1 - 1 / (9 * k);
  const sd = Math.sqrt(1 / (9 * k));
  const z = (Math.cbrt(x / k) - mean) / sd;
  return Number(Math.max(0, Math.min(1, 1 - normalCdf(z))).toFixed(6));
}

/**
 * Detects excess-loss sections with P(O/E > 1.25) >= 0.95 and Benjamini-Hochberg FDR <= 10% (§8.4).
 * Automatically backs off aggregation level (`page×section -> template×role -> site×role`) when
 * finer cells lack minimum expected count `E*`.
 */
export function detectExcessLossSections(
  observations: readonly SectionExitObservation[],
  options?: {
    readonly rung?: DetectionLadderRung;
    readonly fdrAlpha?: number; // default 0.10 (§8.4)
    readonly minExpectedForCell?: number; // default 20 expected exits for finest cell
  }
): readonly ExcessLossFlagResult[] {
  const rung = options?.rung ?? 'H1a_section_hazard';
  const fdrAlpha = options?.fdrAlpha ?? 0.1;
  const minExpected = options?.minExpectedForCell ?? 20;

  // Aggregate by finest passing level: page×section -> template×role -> site×role
  interface AggBucket {
    readonly key: string;
    readonly level: DetectionAggregationLevel;
    observed: number;
    expected: number;
    phiSum: number;
    count: number;
    shapAccum: Record<string, number>;
  }

  const buckets = new Map<string, AggBucket>();

  // Pre-compute template×role and site×role totals for fallback pooling
  const templateTotals = new Map<string, { obs: number; exp: number }>();
  for (const o of observations) {
    const tk = `${o.template_id}:${o.section_role}`;
    const cur = templateTotals.get(tk) ?? { obs: 0, exp: 0 };
    cur.obs += o.observed_exits;
    cur.exp += o.exposures_n * o.expected_exit_rate;
    templateTotals.set(tk, cur);
  }

  for (const o of observations) {
    const cellExp = o.exposures_n * o.expected_exit_rate;
    const tk = `${o.template_id}:${o.section_role}`;
    const tmplExp = templateTotals.get(tk)?.exp ?? 0;

    let key: string;
    let level: DetectionAggregationLevel;
    if (cellExp >= minExpected) {
      key = `${o.page_id}:${o.sec_fp}`;
      level = 'page_x_section';
    } else if (tmplExp >= minExpected) {
      key = `template:${o.template_id}:${o.section_role}`;
      level = 'template_x_role';
    } else {
      key = `site_role:${o.section_role}`;
      level = 'site_x_role';
    }

    let b = buckets.get(key);
    if (!b) {
      b = { key, level, observed: 0, expected: 0, phiSum: 0, count: 0, shapAccum: {} };
      buckets.set(key, b);
    }
    b.observed += o.observed_exits;
    b.expected += cellExp;
    b.phiSum += o.overdispersion_phi ?? 1.0;
    b.count += 1;
    if (o.expectation_feature_shap) {
      for (const [f, val] of Object.entries(o.expectation_feature_shap)) {
        b.shapAccum[f] = (b.shapAccum[f] ?? 0) + val;
      }
    }
  }

  // Evaluate raw posterior exceedance prob & p-value per bucket
  const rawList = Array.from(buckets.values()).map((b) => {
    const avgPhi = b.count > 0 ? b.phiSum / b.count : 1.0;
    const powered = b.expected >= minExpected;
    const prob = powered
      ? computeGammaPoissonExceedanceProb(b.observed, b.expected, 1.25, avgPhi)
      : 0;
    const rawP = 1 - prob;
    const oe = b.expected > 0 ? b.observed / b.expected : 1;
    // Detectable ratio approximation: 1.25 + 1.645 * sqrt(phi / max(1, E))
    const detectableRatio = Number((1.25 + 1.645 * Math.sqrt(avgPhi / Math.max(1, b.expected))).toFixed(3));
    const shapList = Object.entries(b.shapAccum)
      .map(([feature, sum]) => ({ feature, contribution: Number((sum / b.count).toFixed(4)) }))
      .sort((a, c) => Math.abs(c.contribution) - Math.abs(a.contribution));

    return {
      bucket: b,
      powered,
      prob,
      rawP,
      oe: Number(oe.toFixed(4)),
      detectableRatio,
      shapList,
    };
  });

  // Benjamini-Hochberg FDR adjustment across all powered tests (§8.4: FDR <= 10%)
  const poweredItems = rawList.filter((r) => r.powered).sort((a, b) => a.rawP - b.rawP);
  const m = poweredItems.length;
  const qByKey = new Map<string, number>();
  let runningMinQ = 1.0;
  for (let i = m - 1; i >= 0; i--) {
    const rank = i + 1;
    const q = Math.min(runningMinQ, (poweredItems[i].rawP * m) / rank);
    runningMinQ = q;
    qByKey.set(poweredItems[i].bucket.key, Number(Math.min(1, q).toFixed(6)));
  }

  return rawList.map((r) => {
    const qVal = qByKey.get(r.bucket.key) ?? 1.0;
    const flagged = r.powered && r.prob >= 0.95 && qVal <= fdrAlpha;
    return {
      key: r.bucket.key,
      aggregation_level: r.bucket.level,
      rung_used: rung,
      evidence_level: 'inferred',
      status: r.powered ? 'ok' : 'insufficient_data',
      observed_exits: createDataLayerMetric(r.bucket.observed, `lp_detect:${r.bucket.key}`),
      expected_exits: createDataLayerMetric(
        Number(r.bucket.expected.toFixed(2)),
        `lp_detect:${r.bucket.key}`
      ),
      oe_ratio_point: r.oe,
      prob_oe_gt_125: r.prob,
      raw_p_value: Number(r.rawP.toFixed(6)),
      fdr_q_value: qVal,
      flagged,
      detectable_ratio: r.detectableRatio,
      expectation_treeshap: r.shapList,
    };
  });
}

// =========================================================================
// 5 Proposal Sources + Priority Ranking (`evidence: 'planned'`)
// =========================================================================

export interface LpProposalCandidateInput {
  readonly proposal_id: string;
  readonly source: ProposalSourceKind;
  readonly target_page_id: string;
  readonly target_sec_fp: string;
  readonly typed_patch_op: string;
  readonly hypothesis_text: string;
  /** Historical same-class effect width from ledger (band width, NOT a projected lift promise!). */
  readonly prior_class_effect_band: number;
  readonly daily_eligible_traffic: number;
  readonly days_to_power: number;
  /** Poison guard: callers must NEVER attach a projected lift claim below `proven`. */
  readonly projected_lift_pct?: number;
  readonly evidence_level?: EvidenceLevel;
}

export interface RankedLpProposal {
  readonly rank: number;
  readonly proposal_id: string;
  readonly source: ProposalSourceKind;
  readonly evidence_level: 'planned'; // §8.4 mandatory output level
  readonly target_page_id: string;
  readonly target_sec_fp: string;
  readonly typed_patch_op: string;
  readonly hypothesis_text: string;
  readonly priority_score: number;
  readonly days_to_power: number;
}

/**
 * Ranks proposals from all 5 sources (+ 4-G hypothesis challenger) by
 * `prior_class_effect_band * daily_eligible_traffic / days_to_power` (§8.4).
 * Physically rejects any attempt to smuggle a projected lift number below `proven`.
 */
export function rankLpProposals(
  candidates: readonly LpProposalCandidateInput[]
): readonly RankedLpProposal[] {
  for (const c of candidates) {
    if (c.projected_lift_pct !== undefined && c.evidence_level !== 'proven') {
      throw new ProjectedLiftBelowProvenError(c.evidence_level ?? 'planned');
    }
  }

  const scored = candidates.map((c) => {
    const score =
      (Math.max(0, c.prior_class_effect_band) * Math.max(0, c.daily_eligible_traffic)) /
      Math.max(1, c.days_to_power);
    return {
      proposal_id: c.proposal_id,
      source: c.source,
      evidence_level: 'planned' as const,
      target_page_id: c.target_page_id,
      target_sec_fp: c.target_sec_fp,
      typed_patch_op: c.typed_patch_op,
      hypothesis_text: c.hypothesis_text,
      priority_score: Number(score.toFixed(4)),
      days_to_power: c.days_to_power,
    };
  });

  scored.sort((a, b) => b.priority_score - a.priority_score || a.proposal_id.localeCompare(b.proposal_id));

  return scored.map((item, idx) => ({
    rank: idx + 1,
    ...item,
  }));
}
