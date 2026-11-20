/**
 * UGOKI LINK v2 — Bundle 4-H.2: 3-Way Dataset Builder & Mechanical Provenance Gate
 * (`lib/link/ml/finetune/dataset-builder.ts`)
 *
 * Implements §8.14, §14 Decision 31-b / 31-d, Addendum §3–§4:
 * - Mechanical Provenance Gate (`verifyTrainingDatasetProvenance`):
 *   1. **Jev outputs: STRICTLY 0** (Owner Decision `D-31b` permanent lock -> `JevTrainingProhibitedError`)
 *   2. **Per-visitor rows: STRICTLY 0**
 *   3. **Unconsented external tenant texts: STRICTLY 0** (`D-31d` pending -> shared adapter allows
 *      ONLY own-site public page text until Decision 31-d + legal sign-off!)
 *   4. **`custom_event` / `screen_replay` lanes: STRICTLY 0** (§11.11 lane separation)
 * - Owner-group weight cap `<= 1/3` applied strictly to multi-owner collaborative shared training
 *   (NOT applied to initial own-site-only adapters or tenant-dedicated adapters, §8.14).
 * - Near-duplicate deduplication + suspicious poisoning / prompt-injection quarantine.
 * - Strict 3-way split (`train` / `select_tune` / `final_eval`) grouped by connected components of
 *   `(page_lineage_id, near_duplicate_cluster_id, experiment_id)` with mechanical 0-overlap proof!
 */

import { requireDecisionEntitled } from '../../../../packages/contract/ledgers';
import { sha256Hex } from '../../../../packages/contract/schema';

export type DatasetLabelSource =
  | 'human_label'
  | 'human_adjudicated_disagreement'
  | 'randomised_experiment_outcome'
  | 'human_edited_explanation'
  | 'before_after_observed'
  | 'jev_output';

export type AdapterTrainingScope = 'tenant_dedicated' | 'shared_adapter';

export type TextOwnershipKind = 'own_site' | 'external_tenant';

export type TrainingDataLane = 'standard' | 'custom_event' | 'screen_replay';

export interface CandidateTrainingExample {
  readonly example_id: string;
  readonly tenant_id: string;
  /** Managing owner entity (all sites owned by the same organization share one owner_group_id). */
  readonly owner_group_id: string;
  readonly ownership: TextOwnershipKind;
  readonly tenant_opted_in_shared_text?: boolean;
  readonly source: DatasetLabelSource;
  readonly derived_from_jev?: boolean;
  readonly jev_reference_id?: string | null;
  readonly contains_visitor_row?: boolean;
  readonly lane: TrainingDataLane;
  readonly page_lineage_id: string;
  readonly experiment_id?: string | null;
  readonly public_text: string;
  readonly label: string;
  readonly sample_weight: number;
  readonly subject_id?: string;
}

export class JevTrainingProhibitedError extends Error {
  public readonly offendingExampleIds: readonly string[];

  constructor(offendingExampleIds: readonly string[]) {
    super(
      `PERMANENT PROHIBITION (Owner Decision D-31b / Jev Terms 2.3(b)): Jev outputs are FORBIDDEN in ML training datasets. Found ${offendingExampleIds.length} offending example(s): ${offendingExampleIds.join(', ')}`
    );
    this.name = 'JevTrainingProhibitedError';
    this.offendingExampleIds = offendingExampleIds;
  }
}

export interface ProvenanceAuditReport {
  readonly passed: boolean;
  readonly jev_output_count: number;
  readonly visitor_row_count: number;
  readonly unconsented_tenant_text_count: number;
  readonly non_standard_lane_count: number;
  readonly multi_owner_cap_applied: boolean;
  readonly max_owner_effective_weight_share: number;
  readonly errors: readonly string[];
}

const VISITOR_FIELD_NAMES = new Set([
  'visitor_id',
  'pv_id',
  'session_id',
  'member_hash',
  'user_id',
]);

const POISONING_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /system\s*prompt\s*:/i,
  /\[ugk_backdoor_trigger\]/i,
  /\u200B{3,}|\u2060{3,}/, // repeated zero-width obfuscation characters
];

export function isSuspiciousPoisoningExample(text: string): boolean {
  return POISONING_PATTERNS.some((re) => re.test(text));
}

/**
 * Deterministic near-duplicate cluster ID normalizing whitespace, punctuation, and ASCII case
 * over 3-gram word/character shingles so nearly identical page texts collapse to one cluster!
 */
export function computeNearDuplicateClusterId(rawText: string): string {
  const normalized = rawText
    .toLowerCase()
    .replace(/[\s\u3000\p{P}\p{S}]+/gu, '')
    .trim();
  // Use core normalized prefix+length bucket + sorted unique 4-char shingles
  const shingles = new Set<string>();
  for (let i = 0; i + 4 <= normalized.length; i++) {
    shingles.add(normalized.slice(i, i + 4));
  }
  const sortedTop = Array.from(shingles).sort().slice(0, 16).join('|');
  return `ndc_${sha256Hex(sortedTop || normalized).slice(0, 16)}`;
}

/**
 * Mechanical Provenance Gate (§8.14 / Addendum §4 & §6):
 * - Throws `JevTrainingProhibitedError` immediately if ANY Jev output enters the dataset (D-31b).
 * - Checks 0 visitor rows, 0 unconsented external tenant texts (D-31d), and 0 custom_event/replay rows.
 * - Enforces <= 1/3 owner-group effective weight cap strictly on multi-owner collaborative training.
 */
export function verifyTrainingDatasetProvenance(params: {
  readonly examples: readonly CandidateTrainingExample[];
  readonly scope: AdapterTrainingScope;
  readonly targetTenantId?: string;
  readonly taskKind: 'section_reading' | 'naming_explanation' | 'hypothesis_quality';
  /** Optional explicit override ONLY if Decision D-31d + legal sign-off were recorded. */
  readonly decision31dSharedExternalApproved?: boolean;
}): ProvenanceAuditReport {
  // Always verify D-31b remains prohibited in ledger
  const d31b = requireDecisionEntitled('D-31b');
  if (d31b.entitled) {
    throw new Error('Invariant broken: Decision D-31b must remain permanently prohibited');
  }

  const d31dLedger = requireDecisionEntitled('D-31d', { enforceLegalSignOff: true });
  const sharedExternalEntitled =
    d31dLedger.entitled || params.decision31dSharedExternalApproved === true;

  const jevIds: string[] = [];
  let visitorRowCount = 0;
  let unconsentedTenantCount = 0;
  let nonStandardLaneCount = 0;
  const errors: string[] = [];

  for (const ex of params.examples) {
    // 1. ZERO Jev outputs (permanent lock D-31b)
    if (ex.source === 'jev_output' || ex.derived_from_jev === true || Boolean(ex.jev_reference_id)) {
      jevIds.push(ex.example_id);
    }

    // 2. ZERO visitor rows (§8.12 / §8.14)
    const rawRec = ex as unknown as Record<string, unknown>;
    const hasVisitorKey = Object.keys(rawRec).some(
      (k) => VISITOR_FIELD_NAMES.has(k) && rawRec[k] !== undefined && rawRec[k] !== null
    );
    if (ex.contains_visitor_row === true || hasVisitorKey) {
      visitorRowCount += 1;
      errors.push(`Example "${ex.example_id}" contains forbidden per-visitor row data`);
    }

    // 3. ZERO custom_event / screen_replay lanes (§11.11)
    if (ex.lane !== 'standard') {
      nonStandardLaneCount += 1;
      errors.push(`Example "${ex.example_id}" originates from non-standard lane "${ex.lane}"`);
    }

    // 4. Task-specific label source integrity (§8.14)
    if (
      params.taskKind === 'hypothesis_quality' &&
      ex.source === 'before_after_observed'
    ) {
      errors.push(
        `Example "${ex.example_id}": before_after_observed cannot train hypothesis_quality (randomised_experiment_outcome only)`
      );
    }

    // 5. Scope & Tenant Consent Isolation (D-31d)
    if (params.scope === 'tenant_dedicated') {
      if (params.targetTenantId && ex.tenant_id !== params.targetTenantId) {
        unconsentedTenantCount += 1;
        errors.push(
          `Example "${ex.example_id}" belongs to tenant "${ex.tenant_id}", violating dedicated tenant scope "${params.targetTenantId}"`
        );
      }
    } else {
      // shared_adapter
      if (ex.ownership === 'external_tenant') {
        if (!sharedExternalEntitled || ex.tenant_opted_in_shared_text !== true) {
          unconsentedTenantCount += 1;
          errors.push(
            `Example "${ex.example_id}" external tenant text blocked (Decision D-31d pending or tenant not opted in)`
          );
        }
      }
    }
  }

  if (jevIds.length > 0) {
    throw new JevTrainingProhibitedError(jevIds);
  }

  // 6. Owner-group weight cap <= 1/3 ONLY on multi-owner collaborative shared training (§8.14)
  const ownerWeights = new Map<string, number>();
  let totalWeight = 0;
  for (const ex of params.examples) {
    const w = Math.max(0, ex.sample_weight);
    ownerWeights.set(ex.owner_group_id, (ownerWeights.get(ex.owner_group_id) ?? 0) + w);
    totalWeight += w;
  }

  const distinctOwners = ownerWeights.size;
  const multiOwnerCapApplied = params.scope === 'shared_adapter' && distinctOwners >= 2;
  let maxOwnerShare = 0;
  if (totalWeight > 0) {
    for (const w of ownerWeights.values()) {
      const share = w / totalWeight;
      if (share > maxOwnerShare) maxOwnerShare = share;
    }
  }
  if (multiOwnerCapApplied && maxOwnerShare > 1 / 3 + 1e-6) {
    errors.push(
      `Multi-owner collaborative training owner share ${(maxOwnerShare * 100).toFixed(2)}% exceeds 33.33% (1/3) cap`
    );
  }

  return {
    passed: errors.length === 0,
    jev_output_count: 0,
    visitor_row_count: visitorRowCount,
    unconsented_tenant_text_count: unconsentedTenantCount,
    non_standard_lane_count: nonStandardLaneCount,
    multi_owner_cap_applied: multiOwnerCapApplied,
    max_owner_effective_weight_share: Number(maxOwnerShare.toFixed(4)),
    errors,
  };
}

export type SplitName = 'train' | 'select_tune' | 'final_eval';

export interface SplitTrainingExample extends CandidateTrainingExample {
  readonly near_duplicate_cluster_id: string;
  readonly effective_weight: number;
  readonly split: SplitName;
}

export interface ThreeWayDatasetBuildResult {
  readonly dataset_id: string;
  readonly provenance: ProvenanceAuditReport;
  readonly train: readonly SplitTrainingExample[];
  readonly select_tune: readonly SplitTrainingExample[];
  readonly final_eval: readonly SplitTrainingExample[];
  readonly deduplicated_count: number;
  readonly quarantined_poisoning_ids: readonly string[];
  readonly overlap_audit: {
    readonly passed: boolean;
    readonly overlapping_page_lineages: number;
    readonly overlapping_near_dup_clusters: number;
    readonly overlapping_experiment_ids: number;
  };
}

/**
 * Re-scales weights on multi-owner collaborative datasets so NO single owner exceeds 1/3,
 * when >= 3 distinct owners are present.
 */
function capMultiOwnerWeights(
  examples: readonly CandidateTrainingExample[],
  scope: AdapterTrainingScope
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const ex of examples) weights.set(ex.example_id, Math.max(0.01, ex.sample_weight));

  const owners = Array.from(new Set(examples.map((e) => e.owner_group_id)));
  if (scope !== 'shared_adapter' || owners.length < 3) {
    return weights;
  }

  // Iterative proportional cap so each owner's sum <= 1/3 of total weight
  for (let iter = 0; iter < 10; iter++) {
    const ownerSum = new Map<string, number>();
    let total = 0;
    for (const ex of examples) {
      const w = weights.get(ex.example_id)!;
      ownerSum.set(ex.owner_group_id, (ownerSum.get(ex.owner_group_id) ?? 0) + w);
      total += w;
    }
    let adjusted = false;
    for (const [owner, sum] of ownerSum.entries()) {
      if (sum / total > 1 / 3 + 1e-6) {
        const otherSum = total - sum;
        const targetSum = otherSum / 2; // makes targetSum / (targetSum + otherSum) === 1/3
        const scale = targetSum / sum;
        for (const ex of examples) {
          if (ex.owner_group_id === owner) {
            weights.set(ex.example_id, weights.get(ex.example_id)! * scale);
          }
        }
        adjusted = true;
      }
    }
    if (!adjusted) break;
  }
  return weights;
}

/**
 * Verifies ZERO overlap of `page_lineage_id`, `near_duplicate_cluster_id`, and `experiment_id`
 * across `train`, `select_tune`, and `final_eval` (§8.14).
 */
export function verifyZeroSplitOverlap(
  train: readonly SplitTrainingExample[],
  selectTune: readonly SplitTrainingExample[],
  finalEval: readonly SplitTrainingExample[]
): ThreeWayDatasetBuildResult['overlap_audit'] {
  const countOverlap = (extract: (e: SplitTrainingExample) => string | null | undefined): number => {
    const sets = [train, selectTune, finalEval].map((arr) => {
      const s = new Set<string>();
      for (const e of arr) {
        const v = extract(e);
        if (v) s.add(v);
      }
      return s;
    });
    let overlap = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        for (const v of sets[i]) {
          if (sets[j].has(v)) overlap += 1;
        }
      }
    }
    return overlap;
  };

  const overlappingLineages = countOverlap((e) => e.page_lineage_id);
  const overlappingClusters = countOverlap((e) => e.near_duplicate_cluster_id);
  const overlappingExperiments = countOverlap((e) => e.experiment_id);

  return {
    passed:
      overlappingLineages === 0 &&
      overlappingClusters === 0 &&
      overlappingExperiments === 0,
    overlapping_page_lineages: overlappingLineages,
    overlapping_near_dup_clusters: overlappingClusters,
    overlapping_experiment_ids: overlappingExperiments,
  };
}

/**
 * Builds a provenance-verified, deduplicated, poisoning-quarantined 3-way split dataset
 * (`train` / `select_tune` / `final_eval`) using Union-Find over `(page_lineage_id,
 * near_duplicate_cluster_id, experiment_id)` so NO related text can ever cross split boundaries!
 */
export function buildThreeWayTrainingDataset(params: {
  readonly examples: readonly CandidateTrainingExample[];
  readonly scope: AdapterTrainingScope;
  readonly targetTenantId?: string;
  readonly taskKind: 'section_reading' | 'naming_explanation' | 'hypothesis_quality';
  readonly seed: string;
  readonly decision31dSharedExternalApproved?: boolean;
  readonly ratios?: { readonly train: number; readonly select_tune: number; readonly final_eval: number };
}): ThreeWayDatasetBuildResult {
  // 1. Quarantine suspected poisoning / prompt-injection examples BEFORE splitting (§8.14)
  const quarantinedPoisoningIds: string[] = [];
  const cleanExamples: CandidateTrainingExample[] = [];
  for (const ex of params.examples) {
    if (isSuspiciousPoisoningExample(ex.public_text)) {
      quarantinedPoisoningIds.push(ex.example_id);
    } else {
      cleanExamples.push(ex);
    }
  }

  // 2. Auto-cap multi-owner weights if >= 3 owners in shared training, then run provenance audit
  const cappedWeights = capMultiOwnerWeights(cleanExamples, params.scope);
  const weightedExamples = cleanExamples.map((ex) => ({
    ...ex,
    sample_weight: cappedWeights.get(ex.example_id) ?? ex.sample_weight,
  }));

  const provenance = verifyTrainingDatasetProvenance({
    examples: weightedExamples,
    scope: params.scope,
    targetTenantId: params.targetTenantId,
    taskKind: params.taskKind,
    decision31dSharedExternalApproved: params.decision31dSharedExternalApproved,
  });

  if (!provenance.passed) {
    throw new Error(`Dataset provenance audit failed: ${provenance.errors.join('; ')}`);
  }

  // 3. Near-duplicate deduplication (keep deterministic first per near_duplicate_cluster_id, §8.14)
  const seenDedupClusters = new Set<string>();
  const enriched: Array<CandidateTrainingExample & { readonly near_duplicate_cluster_id: string }> = [];
  let deduplicatedCount = 0;

  for (const ex of weightedExamples) {
    const clusterId = computeNearDuplicateClusterId(ex.public_text);
    if (seenDedupClusters.has(clusterId)) {
      deduplicatedCount += 1;
      continue;
    }
    seenDedupClusters.add(clusterId);
    enriched.push({ ...ex, near_duplicate_cluster_id: clusterId });
  }

  // 4. Union-Find grouping by connected boundary keys: page_lineage_id, near_duplicate_cluster_id, experiment_id
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < enriched.length; i++) parent.set(i, i);
  const keyFirstIndex = new Map<string, number>();

  for (let i = 0; i < enriched.length; i++) {
    const ex = enriched[i];
    const keys = [
      `lin:${ex.page_lineage_id}`,
      `ndc:${ex.near_duplicate_cluster_id}`,
      ...(ex.experiment_id ? [`exp:${ex.experiment_id}`] : []),
    ];
    for (const k of keys) {
      const existing = keyFirstIndex.get(k);
      if (existing !== undefined) {
        union(existing, i);
      } else {
        keyFirstIndex.set(k, i);
      }
    }
  }

  // Collect connected groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < enriched.length; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }

  // Deterministic split assignment per connected group
  const ratios = params.ratios ?? { train: 0.6, select_tune: 0.2, final_eval: 0.2 };
  const train: SplitTrainingExample[] = [];
  const selectTune: SplitTrainingExample[] = [];
  const finalEval: SplitTrainingExample[] = [];

  for (const [, indices] of groups.entries()) {
    const groupKey = indices
      .map((idx) => enriched[idx].page_lineage_id)
      .sort()[0];
    const hashU =
      parseInt(sha256Hex(`${params.seed}:split:${groupKey}`).slice(0, 8), 16) / 0x100000000;
    const split: SplitName =
      hashU < ratios.train
        ? 'train'
        : hashU < ratios.train + ratios.select_tune
          ? 'select_tune'
          : 'final_eval';

    for (const idx of indices) {
      const ex = enriched[idx];
      const item: SplitTrainingExample = {
        ...ex,
        effective_weight: ex.sample_weight,
        split,
      };
      if (split === 'train') train.push(item);
      else if (split === 'select_tune') selectTune.push(item);
      else finalEval.push(item);
    }
  }

  const overlapAudit = verifyZeroSplitOverlap(train, selectTune, finalEval);
  if (!overlapAudit.passed) {
    throw new Error('Fatal split boundary overlap detected across train/select_tune/final_eval');
  }

  const datasetId = `ds_${sha256Hex(
    `${params.taskKind}:${params.scope}:${params.seed}:${enriched.map((e) => e.example_id).sort().join(',')}`
  ).slice(0, 20)}`;

  return {
    dataset_id: datasetId,
    provenance,
    train,
    select_tune: selectTune,
    final_eval: finalEval,
    deduplicated_count: deduplicatedCount,
    quarantined_poisoning_ids: quarantinedPoisoningIds,
    overlap_audit: overlapAudit,
  };
}
