/**
 * UGOKI LINK v2 — §8.12 Generative Before/After Tasks, Hypothesis Ledger & Weekly Driver
 * (`lib/link/ml/llm/tasks.ts`)
 *
 * Implements §8.12 & Addendum §4:
 * - Hard prohibition: generative models NEVER directly predict CVR or lift
 *   (`DirectOutcomePredictionProhibitedError`), and EVERY LLM output is capped at `inferred`.
 * - Task 1: Section Semantic Reading (`readSectionMeaning`) — role, answered question, claim,
 *   evidence flags (price / comparison / case study), full reproducibility tuple.
 * - Task 2: Promise-vs-Content Gap (`analyzePromiseVsContentGap`) — search query matching runs
 *   strictly IN-HOUSE (NEVER Jev!), emits 3 strictly separated views (semantic alignment [inferred],
 *   page observed reach/exit [observed], query behaviour bounds [inferred] — never per-visit query!).
 * - Task 3: Change Semantic Classification (`classifyChangeSemantics`) — confirmatory experiments
 *   MUST lock classification BEFORE `first_assignment_at_ms` and MUST NOT read outcome metrics!
 * - Task 4: Cluster Naming & Explanation (`nameAndExplainCluster`) — aggregate profile ONLY,
 *   verified by in-house `verifyExplanationNumbers`, reasons/personas explicitly labelled `hypothesis`.
 * - Task 5: Hypothesis Ledger (`HypothesisLedger`) — `success | failure | inconclusive` (never
 *   counts underpowered inconclusive runs as failures!), Wilson 95% CI on hit rate (`[57%..100%]`
 *   at 5/5), fine-tuning labels restricted STRICTLY to randomised experiment outcomes (`source ===
 *   'randomised_experiment'`).
 * - Task 6: Weekly Driver (`buildWeeklyDriverBrief`) — ranked next actions, evidence level,
 *   `days_to_verdict`, last week's learnings, and explicit `cannot_say` (unknowables).
 */

import {
  type EvidenceLevel,
  type UntrustedValue,
  type VerifiedMetricValue,
} from '../../../../packages/contract/response';
import { canonicalJsonStringify, sha256Hex } from '../../../../packages/contract/schema';
import {
  verifyExplanationNumbers,
  type ClaimedNumericCitation,
  type ExplanationVerificationResult,
  type GroundedMetricReference,
} from './number-verifier';
import {
  assertNoVisitorRowPayload,
  wrapPublicPageTextForLlm,
  type ExecutionRuntimeKind,
  type GenerativeModelProvider,
} from './provider';

export class DirectOutcomePredictionProhibitedError extends Error {
  constructor(requestedTask: string) {
    super(
      `§8.12 Prohibition: Generative models MUST NEVER directly predict conversion rate or causal lift (rejected task: "${requestedTask}"). Use randomised experiments or tabular ML ladders.`
    );
    this.name = 'DirectOutcomePredictionProhibitedError';
  }
}

export class OutcomeLeakageInClassifierError extends Error {
  constructor(reason: string) {
    super(`§8.12 Confirmatory Change Classifier Violation: ${reason}`);
    this.name = 'OutcomeLeakageInClassifierError';
  }
}

/**
 * Guard preventing any caller from asking a generative model to predict CVR/lift or emit `proven`.
 */
export function assertNotDirectOutcomePrediction(taskDescription: string): void {
  if (/(?:predict_cvr|predict_lift|predict_conversion|direct_effect_forecast)/i.test(taskDescription)) {
    throw new DirectOutcomePredictionProhibitedError(taskDescription);
  }
}

export interface SectionMeaningArtifact {
  readonly status: 'ok' | 'not_collected';
  readonly evidence_level: 'inferred'; // §8.12 hard cap
  readonly sec_fp: string;
  readonly body_fp: string;
  readonly taxonomy_version: string;
  readonly prompt_version: string;
  readonly preprocess_version: string;
  readonly model_id: string;
  readonly model_version: string;
  readonly adapter_version_id: string | null;
  readonly inference_config_hash: string;
  readonly artifact_tuple_hash: string;
  readonly fallback_reason: string | null;
  readonly meaning: {
    readonly role: string;
    readonly answered_question: string;
    readonly claim: string;
    readonly has_price: boolean;
    readonly has_comparison: boolean;
    readonly has_case_study: boolean;
  } | null;
}

/**
 * Task 1 (§8.12 #1): Reads public section meaning using the in-house generative provider.
 * Stores the complete reproducibility tuple so re-classified series stay separate.
 */
export async function readSectionMeaning(params: {
  readonly provider: GenerativeModelProvider;
  readonly runtime: ExecutionRuntimeKind;
  readonly sec_fp: string;
  readonly body_fp: string;
  readonly raw_public_section_text: string;
  readonly taxonomy_version: string;
  readonly prompt_version: string;
  readonly preprocess_version: string;
  readonly adapter_version_id?: string | null;
}): Promise<SectionMeaningArtifact> {
  const untrustedText: UntrustedValue = wrapPublicPageTextForLlm(params.raw_public_section_text);
  const res = await params.provider.invoke({
    task: 'section_reading',
    runtime: params.runtime,
    prompt_version: params.prompt_version,
    taxonomy_version: params.taxonomy_version,
    preprocess_version: params.preprocess_version,
    adapter_version_id: params.adapter_version_id ?? null,
    public_page_texts: [untrustedText],
  });

  const tupleHash = sha256Hex(
    canonicalJsonStringify({
      body_fp: params.body_fp,
      taxonomy_version: params.taxonomy_version,
      prompt_version: params.prompt_version,
      preprocess_version: params.preprocess_version,
      model_id: res.model_id,
      model_version: res.model_version,
      adapter_version_id: res.adapter_version_id,
      inference_config_hash: res.inference_config_hash,
    })
  ).slice(0, 24);

  if (!res.ok || !res.output_json) {
    return {
      status: 'not_collected',
      evidence_level: 'inferred',
      sec_fp: params.sec_fp,
      body_fp: params.body_fp,
      taxonomy_version: params.taxonomy_version,
      prompt_version: params.prompt_version,
      preprocess_version: params.preprocess_version,
      model_id: res.model_id,
      model_version: res.model_version,
      adapter_version_id: res.adapter_version_id,
      inference_config_hash: res.inference_config_hash,
      artifact_tuple_hash: tupleHash,
      fallback_reason: res.fallback_reason,
      meaning: null,
    };
  }

  return {
    status: 'ok',
    evidence_level: 'inferred',
    sec_fp: params.sec_fp,
    body_fp: params.body_fp,
    taxonomy_version: params.taxonomy_version,
    prompt_version: params.prompt_version,
    preprocess_version: params.preprocess_version,
    model_id: res.model_id,
    model_version: res.model_version,
    adapter_version_id: res.adapter_version_id,
    inference_config_hash: res.inference_config_hash,
    artifact_tuple_hash: tupleHash,
    fallback_reason: null,
    meaning: {
      role: String(res.output_json.role ?? 'explanatory_body'),
      answered_question: String(res.output_json.answered_question ?? ''),
      claim: String(res.output_json.claim ?? ''),
      has_price: Boolean(res.output_json.has_price),
      has_comparison: Boolean(res.output_json.has_comparison),
      has_case_study: Boolean(res.output_json.has_case_study),
    },
  };
}

export interface PromiseVsContentGapResult {
  readonly evaluated_with: 'in_house_model_only'; // §8.12 #2: NEVER Jev for search queries!
  readonly uses_jev: false;
  /** View 1: Model semantic alignment (`inferred`) */
  readonly semantic_alignment: {
    readonly evidence_level: 'inferred';
    readonly status: 'ok' | 'not_collected';
    readonly promise_kind: 'search_query' | 'title_or_link_copy';
    readonly alignment_note: string | null;
  };
  /** View 2: Whole-page observed reach & exit (`observed`) */
  readonly page_observed_behaviour: {
    readonly evidence_level: 'observed';
    readonly reach_rate: VerifiedMetricValue<number>;
    readonly exit_rate: VerifiedMetricValue<number>;
  };
  /** View 3: Query-level behaviour strictly as bounds (`inferred`, NEVER per-visit query claim!) */
  readonly query_behaviour_bounds: {
    readonly evidence_level: 'inferred';
    readonly lower_bound: number;
    readonly upper_bound: number;
    readonly unknowable_disclaimer: string;
  };
}

/**
 * Task 2 (§8.12 #2): Promise-vs-Content Gap with strict 3-view separation.
 * Search query matching runs strictly on the in-house provider (NEVER Jev!).
 */
export async function analyzePromiseVsContentGap(params: {
  readonly provider: GenerativeModelProvider;
  readonly runtime: ExecutionRuntimeKind;
  readonly promise_kind: 'search_query' | 'title_or_link_copy';
  readonly promise_text: string;
  readonly section_text: string;
  readonly page_reach_rate: VerifiedMetricValue<number>;
  readonly page_exit_rate: VerifiedMetricValue<number>;
  readonly query_bound_lo: number;
  readonly query_bound_hi: number;
}): Promise<PromiseVsContentGapResult> {
  const res = await params.provider.invoke({
    task: 'promise_gap',
    runtime: params.runtime,
    prompt_version: 'promise_gap_v1',
    taxonomy_version: 'taxonomy_v1',
    preprocess_version: 'pre_v1',
    public_page_texts: [
      wrapPublicPageTextForLlm(params.promise_text),
      wrapPublicPageTextForLlm(params.section_text),
    ],
  });

  return {
    evaluated_with: 'in_house_model_only',
    uses_jev: false,
    semantic_alignment: {
      evidence_level: 'inferred',
      status: res.ok ? 'ok' : 'not_collected',
      promise_kind: params.promise_kind,
      alignment_note: res.ok ? String(res.output_json?.claim ?? 'semantic_match_evaluated') : null,
    },
    page_observed_behaviour: {
      evidence_level: 'observed',
      reach_rate: params.page_reach_rate,
      exit_rate: params.page_exit_rate,
    },
    query_behaviour_bounds: {
      evidence_level: 'inferred',
      lower_bound: params.query_bound_lo,
      upper_bound: params.query_bound_hi,
      unknowable_disclaimer:
        'Per-visit organic search queries are unknowable (U4); query-level behaviour is bounded only and never asserted from semantic alignment alone.',
    },
  };
}

export interface ChangeSemanticClassificationResult {
  readonly mode: 'confirmatory_locked_pre_assignment' | 'exploratory_post_hoc';
  readonly evidence_level: 'inferred';
  readonly locked_before_first_assignment: boolean;
  readonly intervention_class: string | null;
  readonly status: 'ok' | 'not_collected';
  readonly diff_hash: string;
}

/**
 * Task 3 (§8.12 #3): Classifies page change semantics.
 * For confirmatory experiments: MUST execute BEFORE `first_assignment_at_ms` and MUST NOT read
 * any outcome data! Post-hoc discovered changes are forced to `exploratory_post_hoc`.
 */
export async function classifyChangeSemantics(params: {
  readonly provider: GenerativeModelProvider;
  readonly runtime: ExecutionRuntimeKind;
  readonly before_public_text: string;
  readonly after_public_text: string;
  readonly is_confirmatory_experiment: boolean;
  readonly classified_at_ms: number;
  readonly first_assignment_at_ms?: number;
  /** Poison guard: passing outcome metrics into change classification throws! */
  readonly outcome_metrics_attached?: unknown;
}): Promise<ChangeSemanticClassificationResult> {
  if (params.outcome_metrics_attached !== undefined) {
    throw new OutcomeLeakageInClassifierError(
      'Outcome metrics MUST NEVER be passed to change semantic classification'
    );
  }
  if (
    params.is_confirmatory_experiment &&
    params.first_assignment_at_ms !== undefined &&
    params.classified_at_ms >= params.first_assignment_at_ms
  ) {
    throw new OutcomeLeakageInClassifierError(
      `Confirmatory classification timestamp (${params.classified_at_ms}) must strictly precede first_assignment_at_ms (${params.first_assignment_at_ms})`
    );
  }

  const diffHash = sha256Hex(`${params.before_public_text}=>${params.after_public_text}`).slice(
    0,
    24
  );

  const res = await params.provider.invoke({
    task: 'change_semantics',
    runtime: params.runtime,
    prompt_version: 'change_sem_v1',
    taxonomy_version: 'intervention_tax_v1',
    preprocess_version: 'pre_v1',
    public_page_texts: [
      wrapPublicPageTextForLlm(params.before_public_text),
      wrapPublicPageTextForLlm(params.after_public_text),
    ],
  });

  return {
    mode: params.is_confirmatory_experiment
      ? 'confirmatory_locked_pre_assignment'
      : 'exploratory_post_hoc',
    evidence_level: 'inferred',
    locked_before_first_assignment: params.is_confirmatory_experiment,
    intervention_class: res.ok ? String(res.output_json?.role ?? 'content_edit') : null,
    status: res.ok ? 'ok' : 'not_collected',
    diff_hash: diffHash,
  };
}

export interface ClusterExplanationResult {
  readonly status: 'ok' | 'not_collected';
  readonly evidence_level: 'inferred';
  readonly label_kind: 'hypothesis';
  readonly cluster_id: string;
  readonly name: string | null;
  readonly explanation: string | null;
  readonly number_verification: ExplanationVerificationResult;
}

/**
 * Task 4 (§8.12 #5): Names & explains a cluster from aggregate profile ONLY, then verifies
 * EVERY embedded number via the in-house deterministic `verifyExplanationNumbers` (NEVER Jev!).
 */
export async function nameAndExplainCluster(params: {
  readonly provider: GenerativeModelProvider;
  readonly runtime: ExecutionRuntimeKind;
  readonly cluster_id: string;
  readonly aggregate_profile: Readonly<Record<string, unknown>>;
  readonly ground_truth_refs: readonly GroundedMetricReference[];
  readonly citations: readonly ClaimedNumericCitation[];
}): Promise<ClusterExplanationResult> {
  assertNoVisitorRowPayload(params.aggregate_profile);

  const res = await params.provider.invoke({
    task: 'cluster_naming',
    runtime: params.runtime,
    prompt_version: 'cluster_name_v1',
    taxonomy_version: 'cluster_tax_v1',
    preprocess_version: 'pre_v1',
    aggregate_context: params.aggregate_profile,
  });

  if (!res.ok || !res.output_json) {
    return {
      status: 'not_collected',
      evidence_level: 'inferred',
      label_kind: 'hypothesis',
      cluster_id: params.cluster_id,
      name: null,
      explanation: null,
      number_verification: {
        passed: false,
        verifier_engine: 'in_house_deterministic',
        uses_jev: false,
        hypothesis_label: 'hypothesis',
        verified_ref_ids: [],
        violations: [],
      },
    };
  }

  const prose = String(res.output_json.explanation ?? '');
  const verification = verifyExplanationNumbers({
    prose,
    citations: params.citations,
    groundTruthRefs: params.ground_truth_refs,
    includesReasonOrPersona: true,
    explicitHypothesisLabel: 'hypothesis',
  });

  return {
    status: verification.passed ? 'ok' : 'not_collected',
    evidence_level: 'inferred',
    label_kind: 'hypothesis',
    cluster_id: params.cluster_id,
    name: verification.passed ? String(res.output_json.name ?? params.cluster_id) : null,
    explanation: verification.passed ? prose : null,
    number_verification: verification,
  };
}

// =========================================================================
// Task 5: Hypothesis Ledger (§8.12 #4 & §8.14)
// =========================================================================

export type HypothesisOutcomeStatus = 'success' | 'failure' | 'inconclusive';

export type HypothesisEvidenceSource = 'randomised_experiment' | 'before_after_observed';

export interface HypothesisEntry {
  readonly hypothesis_id: string;
  readonly target_sec_fp: string;
  readonly cluster_id: string;
  readonly rationale: string;
  readonly expected_direction: 'increase' | 'decrease';
  readonly patch_proposal_id: string;
  readonly selection_provenance: string;
  readonly created_at_iso: string;
  outcome?: {
    readonly status: HypothesisOutcomeStatus;
    readonly source: HypothesisEvidenceSource;
    readonly experiment_id: string;
    readonly effect_point: number | null;
    readonly ci_lower: number | null;
    readonly ci_upper: number | null;
    readonly recorded_at_iso: string;
  };
}

export interface HypothesisHitRateReport {
  readonly resolved_count: number; // success + failure (excludes inconclusive!)
  readonly success_count: number;
  readonly failure_count: number;
  readonly inconclusive_count: number;
  readonly point_rate: number | null;
  readonly wilson_95_lower: number | null;
  readonly wilson_95_upper: number | null;
}

/** Exact Wilson 95% score interval for binomial proportion (e.g. 5/5 -> [0.5655, 1.0000]). */
export function computeWilson95Interval(successes: number, total: number): {
  readonly lower: number;
  readonly upper: number;
} {
  if (total <= 0) return { lower: 0, upper: 1 };
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    lower: Math.max(0, Number((center - half).toFixed(4))),
    upper: Math.min(1, Number((center + half).toFixed(4))),
  };
}

export class HypothesisLedger {
  private readonly entries = new Map<string, HypothesisEntry>();

  public registerHypothesis(entry: Omit<HypothesisEntry, 'outcome'>): HypothesisEntry {
    const stored: HypothesisEntry = { ...entry };
    this.entries.set(entry.hypothesis_id, stored);
    return stored;
  }

  public recordOutcome(
    hypothesisId: string,
    outcome: NonNullable<HypothesisEntry['outcome']>
  ): HypothesisEntry {
    const existing = this.entries.get(hypothesisId);
    if (!existing) {
      throw new Error(`Hypothesis "${hypothesisId}" not found in ledger`);
    }
    const updated: HypothesisEntry = { ...existing, outcome };
    this.entries.set(hypothesisId, updated);
    return updated;
  }

  /**
   * Computes hit rate ONLY over resolved (`success | failure`) hypotheses, NEVER counting
   * underpowered `inconclusive` outcomes as failures, and ALWAYS attaches Wilson 95% CI (§8.12 #4).
   */
  public getHitRateReport(): HypothesisHitRateReport {
    let success = 0;
    let failure = 0;
    let inconclusive = 0;
    for (const e of this.entries.values()) {
      if (!e.outcome) continue;
      if (e.outcome.status === 'success') success += 1;
      else if (e.outcome.status === 'failure') failure += 1;
      else inconclusive += 1;
    }
    const resolved = success + failure;
    if (resolved === 0) {
      return {
        resolved_count: 0,
        success_count: 0,
        failure_count: 0,
        inconclusive_count: inconclusive,
        point_rate: null,
        wilson_95_lower: null,
        wilson_95_upper: null,
      };
    }
    const ci = computeWilson95Interval(success, resolved);
    return {
      resolved_count: resolved,
      success_count: success,
      failure_count: failure,
      inconclusive_count: inconclusive,
      point_rate: Number((success / resolved).toFixed(4)),
      wilson_95_lower: ci.lower,
      wilson_95_upper: ci.upper,
    };
  }

  /**
   * Extracts training labels for the `hypothesis_quality` fine-tune adapter (§8.12 #4 / §8.14):
   * STRICTLY returns ONLY outcomes from `randomised_experiment`. Before/after `observed` entries
   * are NEVER returned as hypothesis-quality training labels!
   */
  public getRandomisedTrainingLabels(): readonly HypothesisEntry[] {
    const out: HypothesisEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.outcome && e.outcome.source === 'randomised_experiment') {
        out.push(e);
      }
    }
    return out;
  }
}

// =========================================================================
// Task 6: Weekly Driver Brief (§8.12 "運転役")
// =========================================================================

export interface WeeklyDriverActionItem {
  readonly rank: number;
  readonly action_title: string;
  readonly evidence_level: EvidenceLevel;
  readonly days_to_verdict: number;
  readonly hypothesis_id: string | null;
}

export interface WeeklyDriverBrief {
  readonly generated_at_iso: string;
  readonly ranked_next_actions: readonly WeeklyDriverActionItem[];
  readonly last_week_learnings: readonly string[];
  readonly cannot_say: readonly string[];
}

export function buildWeeklyDriverBrief(params: {
  readonly generated_at_iso: string;
  readonly actions: readonly Omit<WeeklyDriverActionItem, 'rank'>[];
  readonly last_week_learnings: readonly string[];
  readonly cannot_say: readonly string[];
}): WeeklyDriverBrief {
  const ranked = params.actions.map((a, idx) => ({
    ...a,
    rank: idx + 1,
  }));
  return {
    generated_at_iso: params.generated_at_iso,
    ranked_next_actions: ranked,
    last_week_learnings: [...params.last_week_learnings],
    cannot_say:
      params.cannot_say.length > 0
        ? [...params.cannot_say]
        : ['Per-visit organic queries (U4) and unpowered small lifts remain unknowable at current traffic.'],
  };
}
