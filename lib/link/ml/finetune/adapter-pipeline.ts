/**
 * UGOKI LINK v2 — Bundle 4-H.3: Task-Separated LoRA Adapter Training, Evaluation & Rollback
 * (`lib/link/ml/finetune/adapter-pipeline.ts`)
 *
 * Implements §8.14, §8.8, Addendum §4–§5:
 * - Separate LoRA adapters per task (`section_reading` | `naming_explanation` | `hypothesis_quality`):
 *   - Enforces reader vs hypothesis adapter separation (§8.12 / §8.14).
 *   - Enforces `tenant_dedicated` vs `shared_adapter` isolation.
 *   - Server-only GPU execution (forbids browser, edge_worker, CRAWL VPS, ClickHouse).
 * - Condition-triggered retraining (new human labels >= 200, valid randomised experiment arrived,
 *   live random audit below floor, or base model / taxonomy change — never blind calendar schedule).
 * - Paired-example evaluation on `final_eval` (>= 300 examples): computes multiple-testing adjusted
 *   paired-difference CI LCB against BOTH `base_model` and `current_champion`.
 * - Zero-tolerance defense suite (`number_reference`, `prompt_injection`, `backdoor_trigger`):
 *   even ONE failure rejects promotion!
 * - Hypothesis adapter: updates challenger on every valid experiment, keeps promotion CLOSED
 *   until `independent_experiments_count >= required_independent_experiments` (default 20).
 * - Live monitor & automatic alias rollback to a safe version (passing safety, deletion, quality)
 *   or fallback to `base_model` / `rule_fallback`.
 */

import { canonicalJsonStringify, sha256Hex } from '../../../../packages/contract/schema';
import {
  evaluateAutomaticRollback,
  evaluateModelPromotion,
  type LiveRollbackHealthMetrics,
  type NonInferioritySpec,
  type PromotionDecision,
  type PromotionEntryTrack,
  type RollbackCandidate,
  type RollbackDecision,
} from '../foundation/promotion';
import {
  validateTrainingJobContract,
  type ComputeExecutionTarget,
} from '../foundation/registry';
import type { GenerativeModelId } from '../llm/provider';
import type { AdapterTrainingScope, ThreeWayDatasetBuildResult } from './dataset-builder';
import type { FinetuneTaskKind } from './labeling';

export const MIN_FINAL_EVAL_LABELS = 300 as const;
export const RETRAIN_HUMAN_LABEL_THRESHOLD = 200 as const;
export const DEFAULT_MIN_HYPOTHESIS_EXPERIMENTS = 20 as const;

export interface LoraAdapterJobSpec {
  readonly job_id: string;
  readonly task_kind: FinetuneTaskKind;
  readonly scope: AdapterTrainingScope;
  readonly tenant_id: string | null; // non-null when `tenant_dedicated`
  readonly base_model_id: GenerativeModelId;
  readonly base_model_version: string;
  readonly compute_target: ComputeExecutionTarget;
  readonly dataset_id: string;
  readonly deletion_generation: number;
  readonly lora_rank: number;
  readonly seed: number;
  readonly max_cost_usd: number;
  readonly region: string;
  readonly challenger_only: true;
  readonly server_only: true;
  /** Enforces §8.12: reading adapter never trains on experiment outcomes; hypothesis adapter never writes reading features. */
  readonly isolated_adapter_role: FinetuneTaskKind;
}

export function createLoraAdapterJobSpec(params: {
  readonly job_id: string;
  readonly task_kind: FinetuneTaskKind;
  readonly scope: AdapterTrainingScope;
  readonly tenant_id?: string | null;
  readonly base_model_id: GenerativeModelId;
  readonly base_model_version: string;
  readonly compute_target: ComputeExecutionTarget;
  readonly dataset: ThreeWayDatasetBuildResult;
  readonly deletion_generation: number;
  readonly lora_rank?: number;
  readonly seed: number;
  readonly max_cost_usd: number;
  readonly region: string;
}): { readonly spec: LoraAdapterJobSpec; readonly spec_hash: string } {
  if (!params.dataset.provenance.passed || params.dataset.provenance.jev_output_count !== 0) {
    throw new Error('Cannot launch LoRA job: dataset failed mechanical provenance audit');
  }
  if (!params.dataset.overlap_audit.passed) {
    throw new Error('Cannot launch LoRA job: 3-way dataset has split boundary overlap');
  }
  if (params.scope === 'tenant_dedicated' && !params.tenant_id) {
    throw new Error('tenant_dedicated LoRA adapter job requires an explicit tenant_id');
  }

  // Validate against Bundle 4-F Inngest compute isolation contract (blocks crawl_vps / clickhouse_prod)
  validateTrainingJobContract({
    job_id: params.job_id,
    inngest_event_name: 'ml/train.requested',
    tenant_concurrency_key: params.tenant_id ?? 'shared_own_sites',
    compute_target: params.compute_target,
    dataset_id: params.dataset.dataset_id,
    feature_set_version: `lora_${params.task_kind}_v1`,
    label_contract_version: 'human_or_randomised_v1',
    deletion_generation: params.deletion_generation,
    seed: params.seed,
    max_cost_usd: params.max_cost_usd,
    challenger_only: true,
    region: params.region,
  });

  const spec: LoraAdapterJobSpec = {
    job_id: params.job_id,
    task_kind: params.task_kind,
    scope: params.scope,
    tenant_id: params.scope === 'tenant_dedicated' ? (params.tenant_id ?? null) : null,
    base_model_id: params.base_model_id,
    base_model_version: params.base_model_version,
    compute_target: params.compute_target,
    dataset_id: params.dataset.dataset_id,
    deletion_generation: params.deletion_generation,
    lora_rank: params.lora_rank ?? 16,
    seed: params.seed,
    max_cost_usd: params.max_cost_usd,
    region: params.region,
    challenger_only: true,
    server_only: true,
    isolated_adapter_role: params.task_kind,
  };

  return {
    spec,
    spec_hash: sha256Hex(canonicalJsonStringify(spec)),
  };
}

export interface RetrainTriggerInput {
  readonly task_kind: FinetuneTaskKind;
  readonly new_human_labels_since_last_fit: number;
  readonly new_valid_randomised_experiment_arrived: boolean;
  readonly live_random_audit_below_floor: boolean;
  readonly base_model_or_taxonomy_changed: boolean;
}

export interface RetrainTriggerDecision {
  readonly should_retrain_challenger: boolean;
  readonly triggers_fired: readonly string[];
}

/**
 * Condition-triggered retraining policy (§8.14 — never blind calendar retraining).
 */
export function evaluateAdapterRetrainTrigger(input: RetrainTriggerInput): RetrainTriggerDecision {
  const fired: string[] = [];
  if (input.new_human_labels_since_last_fit >= RETRAIN_HUMAN_LABEL_THRESHOLD) {
    fired.push(`human_labels_accumulated_${input.new_human_labels_since_last_fit}`);
  }
  if (input.task_kind === 'hypothesis_quality' && input.new_valid_randomised_experiment_arrived) {
    fired.push('new_valid_randomised_experiment_result');
  }
  if (input.live_random_audit_below_floor) {
    fired.push('live_audit_quality_below_floor');
  }
  if (input.base_model_or_taxonomy_changed) {
    fired.push('base_model_or_taxonomy_changed');
  }
  return {
    should_retrain_challenger: fired.length > 0,
    triggers_fired: fired,
  };
}

/**
 * Computes exact paired-difference lower confidence bound (same `final_eval` examples)
 * with Bonferroni multiple-testing adjustment (default 2 comparisons: vs base + vs champion).
 */
export function computePairedDifferenceLcb(
  challengerScores: readonly number[],
  baselineScores: readonly number[],
  numComparisons = 2
): { readonly mean_diff: number; readonly se: number; readonly lcb: number } {
  const n = Math.min(challengerScores.length, baselineScores.length);
  if (n < 2) {
    return { mean_diff: 0, se: Infinity, lcb: -Infinity };
  }
  const diffs: number[] = new Array<number>(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    diffs[i] = challengerScores[i] - baselineScores[i];
    sum += diffs[i];
  }
  const mean = sum / n;
  let sqSum = 0;
  for (let i = 0; i < n; i++) {
    const d = diffs[i] - mean;
    sqSum += d * d;
  }
  const variance = sqSum / (n - 1);
  const se = Math.sqrt(variance / n);
  // Bonferroni-adjusted two-sided 95% z critical value (k=1 -> 1.96, k=2 -> 2.2414, k>=3 -> 2.394)
  const z = numComparisons <= 1 ? 1.95996 : numComparisons === 2 ? 2.2414 : 2.5758;
  return {
    mean_diff: Number(mean.toFixed(6)),
    se: Number(se.toFixed(6)),
    lcb: Number((mean - z * se).toFixed(6)),
  };
}

export interface DefenseSuiteResults {
  readonly number_reference_failures: number;
  readonly prompt_injection_failures: number;
  readonly backdoor_trigger_failures: number;
}

export interface AdapterPromotionEvalInput {
  readonly task_kind: FinetuneTaskKind;
  readonly challenger_version_id: string;
  readonly champion_version_id: string;
  readonly track: PromotionEntryTrack;
  readonly affects_delivery_policy: boolean;
  /** Per-example scores on identical `final_eval` set (>= 300 examples). */
  readonly challenger_final_eval_scores: readonly number[];
  readonly base_model_final_eval_scores: readonly number[];
  readonly champion_final_eval_scores: readonly number[];
  readonly defense_suite: DefenseSuiteResults;
  readonly shadow_days_completed: number;
  readonly shadow_clean: boolean;
  readonly ope_delta_lcb?: number;
  readonly static_slice_consistent?: boolean;
  readonly policy_test_passed?: boolean;
  readonly platform_canary_passed: boolean;
  readonly non_inferiority?: NonInferioritySpec;
  /** For `hypothesis_quality`: number of independent randomised experiments accrued. */
  readonly independent_experiments_count?: number;
  readonly required_independent_experiments?: number;
}

export interface AdapterPromotionDecision {
  readonly promoted: boolean;
  readonly challenger_updated: true;
  readonly vs_base_lcb: number;
  readonly vs_champion_lcb: number;
  readonly defense_suite_passed: boolean;
  readonly foundation_promotion: PromotionDecision;
  readonly unmet_gates: readonly string[];
}

/**
 * Full §8.14 Adapter Evaluation & Promotion Gate:
 * - >= 300 `final_eval` items
 * - Zero-tolerance defense suite (1 failure -> reject!)
 * - Paired-difference CI LCB beats BOTH base model AND current champion
 * - Hypothesis adapter stays closed until required independent experiments accrue
 * - Chains cleanly through §8.8 `evaluateModelPromotion`.
 */
export function evaluateAdapterPromotion(
  input: AdapterPromotionEvalInput
): AdapterPromotionDecision {
  const unmet: string[] = [];
  const evalN = Math.min(
    input.challenger_final_eval_scores.length,
    input.base_model_final_eval_scores.length,
    input.champion_final_eval_scores.length
  );

  if (evalN < MIN_FINAL_EVAL_LABELS) {
    unmet.push(`ml.final_eval_min_300 (have ${evalN}/300)`);
  }

  // Zero-tolerance defense suite (§8.14: even 1 failure blocks promotion!)
  const defensePassed =
    input.defense_suite.number_reference_failures === 0 &&
    input.defense_suite.prompt_injection_failures === 0 &&
    input.defense_suite.backdoor_trigger_failures === 0;
  if (!defensePassed) {
    if (input.defense_suite.number_reference_failures > 0) {
      unmet.push('ml.defense_number_reference_zero_fail');
    }
    if (input.defense_suite.prompt_injection_failures > 0) {
      unmet.push('ml.defense_prompt_injection_zero_fail');
    }
    if (input.defense_suite.backdoor_trigger_failures > 0) {
      unmet.push('ml.defense_backdoor_trigger_zero_fail');
    }
  }

  // Hypothesis adapter promotion stays CLOSED until independent experiments count reaches floor (§8.14)
  if (input.task_kind === 'hypothesis_quality') {
    const reqExp = input.required_independent_experiments ?? DEFAULT_MIN_HYPOTHESIS_EXPERIMENTS;
    const haveExp = input.independent_experiments_count ?? 0;
    if (haveExp < reqExp) {
      unmet.push(`ml.hypothesis_min_independent_experiments (have ${haveExp}/${reqExp})`);
    }
  }

  // Paired-difference CI LCB against BOTH base model AND current champion
  const vsBase = computePairedDifferenceLcb(
    input.challenger_final_eval_scores,
    input.base_model_final_eval_scores,
    2
  );
  const vsChampion = computePairedDifferenceLcb(
    input.challenger_final_eval_scores,
    input.champion_final_eval_scores,
    2
  );

  const conservativeOfflineLcb = Math.min(vsBase.lcb, vsChampion.lcb);

  const foundationPromotion = evaluateModelPromotion({
    challenger_version_id: input.challenger_version_id,
    champion_version_id: input.champion_version_id,
    track: input.track,
    scope: input.affects_delivery_policy ? 'delivery_policy' : 'analytics_only',
    offline_delta_lcb: conservativeOfflineLcb,
    shadow_days_completed: input.shadow_days_completed,
    shadow_clean: input.shadow_clean,
    ope_delta_lcb: input.ope_delta_lcb,
    static_slice_consistent: input.static_slice_consistent,
    policy_test_passed: input.policy_test_passed,
    platform_canary_passed: input.platform_canary_passed,
    non_inferiority: input.non_inferiority,
  });

  for (const g of foundationPromotion.unmet_gates) {
    if (!unmet.includes(g)) unmet.push(g);
  }

  return {
    promoted: unmet.length === 0 && foundationPromotion.promoted,
    challenger_updated: true,
    vs_base_lcb: vsBase.lcb,
    vs_champion_lcb: vsChampion.lcb,
    defense_suite_passed: defensePassed,
    foundation_promotion: foundationPromotion,
    unmet_gates: unmet,
  };
}

/**
 * Live monitoring & alias rollback wrapper for LoRA adapters (§8.14).
 */
export function evaluateAdapterLiveRollback(
  health: LiveRollbackHealthMetrics & { readonly live_random_audit_below_floor: boolean },
  previousSafeCandidates: readonly RollbackCandidate[]
): RollbackDecision {
  const baseDecision = evaluateAutomaticRollback(
    {
      ...health,
      guardrail_breached: health.guardrail_breached || health.live_random_audit_below_floor,
    },
    previousSafeCandidates
  );
  if (health.live_random_audit_below_floor && !baseDecision.reasons.includes('live_random_audit_below_floor')) {
    return {
      ...baseDecision,
      reasons: [...baseDecision.reasons, 'live_random_audit_below_floor'],
    };
  }
  return baseDecision;
}
