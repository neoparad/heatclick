/**
 * UGOKI LINK v2 — Bundle 4-H.1: Blind Dual-Annotator Human Labeling Intake (`lib/link/ml/finetune/labeling.ts`)
 *
 * Implements §8.14 & Addendum §4:
 * - Strict BLIND labeling UI contract: model predictions / confidences MUST NEVER be exposed
 *   to human annotators (`BlindLabelingViolationError`).
 * - Dual independent annotation + Cohen's κ agreement + formal adjudication record bound to
 *   `(rubric_version, taxonomy_version, annotator_a_id, annotator_b_id, adjudicator_id)`.
 * - Stores selection probability `p_select` and bounded importance weight `1 / p_select` so
 *   active/uncertainty sampling does not bias training or evaluation.
 * - Auto-halts training & evaluation for any category whose Cohen's κ drops below floor.
 * - Routing items to humans via Jev disagreement stays CLOSED (`not_entitled`) until legal
 *   sign-off is recorded; default triage uses in-house model uncertainty + random audit sampling.
 */

export type FinetuneTaskKind = 'section_reading' | 'naming_explanation' | 'hypothesis_quality';

export class BlindLabelingViolationError extends Error {
  public readonly leakedFields: readonly string[];

  constructor(leakedFields: readonly string[]) {
    super(
      `§8.14 Blind Labeling Violation: model outputs MUST NEVER be shown to human annotators (leaked fields: ${leakedFields.join(', ')})`
    );
    this.name = 'BlindLabelingViolationError';
    this.leakedFields = leakedFields;
  }
}

const FORBIDDEN_BLIND_UI_KEYS = new Set([
  'model_prediction',
  'model_answer',
  'model_label',
  'model_confidence',
  'llm_output',
  'jev_output',
  'jev_prediction',
  'predicted_role',
  'logits',
]);

export interface BlindAnnotationTaskPayload {
  readonly task_item_id: string;
  readonly task_kind: FinetuneTaskKind;
  readonly rubric_version: string;
  readonly taxonomy_version: string;
  readonly public_section_text: string;
  readonly candidate_labels: readonly string[];
  readonly p_select: number;

  // Compile-time poison guards: model outputs cannot enter annotator UI
  readonly model_prediction?: never;
  readonly model_answer?: never;
  readonly model_confidence?: never;
  readonly jev_output?: never;
}

/**
 * Constructs a verified blind annotation task for human labelers.
 * Throws `BlindLabelingViolationError` if any model answer/confidence is present.
 */
export function buildBlindAnnotationTask(
  rawTask: BlindAnnotationTaskPayload
): BlindAnnotationTaskPayload {
  const leaked: string[] = [];
  for (const [k, v] of Object.entries(rawTask as unknown as Record<string, unknown>)) {
    if (FORBIDDEN_BLIND_UI_KEYS.has(k) && v !== undefined && v !== null) {
      leaked.push(k);
    }
  }
  if (leaked.length > 0) {
    throw new BlindLabelingViolationError(leaked);
  }
  if (!Number.isFinite(rawTask.p_select) || rawTask.p_select <= 0 || rawTask.p_select > 1) {
    throw new Error(`p_select must be in (0, 1], got ${rawTask.p_select}`);
  }
  return Object.freeze({ ...rawTask });
}

export interface DualAnnotationPair {
  readonly item_id: string;
  readonly category: string;
  readonly annotator_a_id: string;
  readonly label_a: string;
  readonly annotator_b_id: string;
  readonly label_b: string;
  readonly adjudicated_label?: string;
  readonly adjudicator_id?: string;
  readonly rubric_version: string;
  readonly taxonomy_version: string;
  readonly p_select: number;
  readonly is_random_representative_sample: boolean;
}

export interface VerifiedHumanLabelRecord {
  readonly item_id: string;
  readonly category: string;
  readonly final_label: string;
  readonly agreed_without_adjudication: boolean;
  readonly rubric_version: string;
  readonly taxonomy_version: string;
  readonly annotator_ids: readonly [string, string];
  readonly adjudicator_id: string | null;
  readonly p_select: number;
  readonly sample_weight: number;
  readonly is_random_representative_sample: boolean;
}

/**
 * Exact Cohen's κ for two independent annotators over nominal categories.
 */
export function computeCohensKappa(
  pairs: ReadonlyArray<{ readonly label_a: string; readonly label_b: string }>
): number {
  const n = pairs.length;
  if (n === 0) return 0;

  let agree = 0;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  const labels = new Set<string>();

  for (const p of pairs) {
    if (p.label_a === p.label_b) agree += 1;
    countA.set(p.label_a, (countA.get(p.label_a) ?? 0) + 1);
    countB.set(p.label_b, (countB.get(p.label_b) ?? 0) + 1);
    labels.add(p.label_a);
    labels.add(p.label_b);
  }

  const pO = agree / n;
  let pE = 0;
  for (const lbl of labels) {
    pE += ((countA.get(lbl) ?? 0) / n) * ((countB.get(lbl) ?? 0) / n);
  }

  if (1 - pE <= 1e-12) {
    return pO >= 1 - 1e-12 ? 1 : 0;
  }
  return Number(((pO - pE) / (1 - pE)).toFixed(4));
}

export interface CategoryAgreementGateResult {
  readonly category: string;
  readonly pair_count: number;
  readonly cohens_kappa: number;
  readonly min_kappa_floor: number;
  readonly training_and_eval_allowed: boolean;
  readonly status: 'ok' | 'halted_low_agreement';
}

export const DEFAULT_MIN_KAPPA_FLOOR = 0.7 as const;

/**
 * Evaluates dual-annotator agreement per category and produces weighted adjudicated labels.
 * Automatically halts training & evaluation for any category below `minKappaFloor` (§8.14).
 */
export function adjudicateAndEvaluateLabelBatch(
  pairs: readonly DualAnnotationPair[],
  options?: { readonly minKappaFloor?: number; readonly maxSampleWeight?: number }
): {
  readonly labels: readonly VerifiedHumanLabelRecord[];
  readonly category_gates: readonly CategoryAgreementGateResult[];
  readonly halted_categories: readonly string[];
} {
  const minKappa = options?.minKappaFloor ?? DEFAULT_MIN_KAPPA_FLOOR;
  const maxWeight = options?.maxSampleWeight ?? 10;

  const byCategory = new Map<string, DualAnnotationPair[]>();
  for (const p of pairs) {
    if (p.annotator_a_id === p.annotator_b_id) {
      throw new Error(`Dual annotation for "${p.item_id}" requires two distinct annotators`);
    }
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  const categoryGates: CategoryAgreementGateResult[] = [];
  const haltedCategories: string[] = [];
  const allowedCategories = new Set<string>();

  for (const [category, catPairs] of byCategory.entries()) {
    const kappa = computeCohensKappa(catPairs);
    const allowed = kappa >= minKappa;
    if (allowed) {
      allowedCategories.add(category);
    } else {
      haltedCategories.push(category);
    }
    categoryGates.push({
      category,
      pair_count: catPairs.length,
      cohens_kappa: kappa,
      min_kappa_floor: minKappa,
      training_and_eval_allowed: allowed,
      status: allowed ? 'ok' : 'halted_low_agreement',
    });
  }

  const labels: VerifiedHumanLabelRecord[] = [];
  for (const p of pairs) {
    if (!allowedCategories.has(p.category)) continue;
    const agreed = p.label_a === p.label_b;
    if (!agreed && (!p.adjudicated_label || !p.adjudicator_id)) {
      throw new Error(
        `Disagreed item "${p.item_id}" requires explicit adjudicated_label and adjudicator_id`
      );
    }
    const finalLabel = agreed ? p.label_a : p.adjudicated_label!;
    const rawWeight = 1 / Math.max(0.01, p.p_select);
    labels.push({
      item_id: p.item_id,
      category: p.category,
      final_label: finalLabel,
      agreed_without_adjudication: agreed,
      rubric_version: p.rubric_version,
      taxonomy_version: p.taxonomy_version,
      annotator_ids: [p.annotator_a_id, p.annotator_b_id],
      adjudicator_id: agreed ? null : (p.adjudicator_id ?? null),
      p_select: p.p_select,
      sample_weight: Number(Math.min(maxWeight, rawWeight).toFixed(4)),
      is_random_representative_sample: p.is_random_representative_sample,
    });
  }

  return {
    labels,
    category_gates: categoryGates,
    halted_categories: haltedCategories,
  };
}

export interface HumanTriageCandidate {
  readonly item_id: string;
  readonly in_house_confidence: number; // [0, 1]; uncertain near 0.5
  readonly uniform_draw: number; // [0, 1) for representative random audit sampling
  readonly jev_disagreed?: boolean;
}

export interface HumanTriageSelectionResult {
  readonly status: 'ok' | 'not_entitled';
  readonly reason: string | null;
  readonly selected: readonly {
    readonly item_id: string;
    readonly p_select: number;
    readonly reason: 'in_house_uncertainty' | 'random_audit' | 'jev_disagreement';
  }[];
}

/**
 * Selects candidates for human labeling (§8.14 / Addendum §4):
 * - Default mode (`useJevDisagreementTriage: false`): uses ONLY in-house model uncertainty
 *   + uniform random audit sampling.
 * - Jev-disagreement triage stays CLOSED (`not_entitled`) until legal review confirms
 *   routing via Jev outputs does not breach Jev Terms 2.3(b)!
 */
export function selectCandidatesForHumanLabeling(params: {
  readonly candidates: readonly HumanTriageCandidate[];
  readonly useJevDisagreementTriage?: boolean;
  readonly jevTriageLegalSignOffRecorded?: boolean;
  readonly randomAuditShare?: number; // default 0.10
  readonly uncertaintyBandHalfWidth?: number; // default 0.15 around 0.5 -> [0.35, 0.65]
}): HumanTriageSelectionResult {
  if (params.useJevDisagreementTriage && !params.jevTriageLegalSignOffRecorded) {
    return {
      status: 'not_entitled',
      reason: 'jev_triage_requires_legal_signoff',
      selected: [],
    };
  }

  const auditShare = params.randomAuditShare ?? 0.1;
  const band = params.uncertaintyBandHalfWidth ?? 0.15;
  const selected: Array<{
    readonly item_id: string;
    readonly p_select: number;
    readonly reason: 'in_house_uncertainty' | 'random_audit' | 'jev_disagreement';
  }> = [];

  for (const c of params.candidates) {
    if (params.useJevDisagreementTriage && c.jev_disagreed) {
      selected.push({ item_id: c.item_id, p_select: 1.0, reason: 'jev_disagreement' });
      continue;
    }
    if (Math.abs(c.in_house_confidence - 0.5) <= band) {
      selected.push({ item_id: c.item_id, p_select: 1.0, reason: 'in_house_uncertainty' });
      continue;
    }
    if (c.uniform_draw < auditShare) {
      selected.push({ item_id: c.item_id, p_select: auditShare, reason: 'random_audit' });
    }
  }

  return {
    status: 'ok',
    reason: null,
    selected,
  };
}
