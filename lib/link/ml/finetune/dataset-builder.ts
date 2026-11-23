/**
 * UGOKI LINK v2 — Bundle 4-H.2: 3-Way Dataset Builder & Mechanical Provenance Gate
 * (`lib/link/ml/finetune/dataset-builder.ts`)
 *
 * Implements §8.14, §14 Decision 31-b / 31-d, Addendum §3–§4, `[H-04]`, `[M-18]`:
 * - Mechanical Provenance Gate (`verifyTrainingDatasetProvenance` & Step 0 in `buildThreeWayTrainingDataset`):
 *   1. **Jev outputs: STRICTLY 0 — checked FIRST** before poisoning quarantine or dedup (`[H-04]`),
 *      using unbounded-depth explicit stack traversal (`WeakSet` + 100,000-node fail-closed cap, `[M-18]`)
 *      -> `JevTrainingProhibitedError`.
 *   2. **Per-visitor rows: STRICTLY 0** (checked across nested objects at arbitrary depth).
 *   3. **Unconsented external tenant texts: STRICTLY 0** (`D-31d` pending -> shared adapter allows
 *      ONLY own-site public page text until Decision 31-d + legal sign-off!).
 *   4. **`custom_event` / `screen_replay` lanes: STRICTLY 0** (§11.11 lane separation).
 * - Exact Active-Set Water-Filling Multi-Owner Weight Cap (`capMultiOwnerWeights`, `[H-04]`):
 *   Guarantees every owner's normalized weight share is strictly `<= maxOwnerShare` (`<= 1/3` default,
 *   or arbitrary `maxOwnerShare` such as `0.05` when `distinctOwners * maxOwnerShare >= 1`).
 * - Full UTF-8 / Unicode Code-Point Multi-Seed MinHash Shingling (`[H-04]`):
 *   Zero ASCII lexicographic bias on Japanese CJK text.
 * - Union-Find BEFORE Dedup (`[H-04]`):
 *   Connects ALL near-duplicate pairs, `tenant_id`/`site_id`/`page_lineage_id` lineages,
 *   `skeleton_hash`, and `experiment_id` BEFORE dropping near-duplicates; assigns each connected
 *   component atomically to ONE split (`train` / `select_tune` / `final_eval`) and deduplicates
 *   WITHIN each split — guaranteeing ZERO cross-split near-duplicate bridge leakage!
 */

import { requireDecisionEntitled } from '../../../../packages/contract/ledgers';
import { sha256Hex, utf8ToBytes } from '../../../../packages/contract/schema';
import { withSplitManifest } from './split-manifest';

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
  readonly site_id?: string;
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
  readonly skeleton_hash?: string | null;
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
  'visitorId',
  'pv_id',
  'pvId',
  'session_id',
  'sessionId',
  'member_hash',
  'memberHash',
  'user_id',
  'userId',
]);

const JEV_PROVENANCE_KEYS = new Set([
  'source',
  'origin',
  'origin_source',
  'label_source',
  'teacher',
  'teacher_origin',
]);

const JEV_PROVENANCE_VALUES = new Set([
  'jev',
  'jev_output',
  'jev_external_service',
  'jev_teacher',
]);

export const MAX_PROVENANCE_SCAN_NODES = 100_000;

/**
 * [M-18] Explicit stack-based iterative provenance & visitor-field scanner with `WeakSet` cycle
 * protection and fail-closed 100,000-node budget (catches `{ a: { b: ... { source: 'jev' } } }`
 * at depth 20+ without stack overflow or depth-6 truncation!).
 */
export function scanDeepProhibitedProvenance(root: unknown): {
  readonly hasJevProvenance: boolean;
  readonly hasJevTeacher: boolean;
  readonly hasVisitorField: boolean;
  readonly exceededNodeLimit: boolean;
  readonly matchedJevDetail: string | null;
  readonly visitorKeys: readonly string[];
} {
  if (root === null || root === undefined || typeof root !== 'object') {
    return {
      hasJevProvenance: false,
      hasJevTeacher: false,
      hasVisitorField: false,
      exceededNodeLimit: false,
      matchedJevDetail: null,
      visitorKeys: [],
    };
  }

  const visited = new WeakSet<object>();
  const stack: unknown[] = [root];
  let scannedNodes = 0;
  let hasJevProvenance = false;
  let hasJevTeacher = false;
  let matchedJevDetail: string | null = null;
  const visitorKeySet = new Set<string>();

  while (stack.length > 0) {
    const curr = stack.pop();
    if (curr === null || curr === undefined || typeof curr !== 'object') {
      continue;
    }
    if (visited.has(curr)) {
      continue;
    }
    visited.add(curr);
    scannedNodes += 1;
    if (scannedNodes > MAX_PROVENANCE_SCAN_NODES) {
      return {
        hasJevProvenance: true,
        hasJevTeacher: true,
        hasVisitorField: true,
        exceededNodeLimit: true,
        matchedJevDetail: 'node_limit_exceeded_100000',
        visitorKeys: ['__node_limit_exceeded_100000__'],
      };
    }

    if (Array.isArray(curr)) {
      for (let i = curr.length - 1; i >= 0; i -= 1) {
        stack.push(curr[i]);
      }
      continue;
    }

    const rec = curr as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const val = rec[key];
      if (val === undefined || val === null) {
        continue;
      }

      if (VISITOR_FIELD_NAMES.has(key)) {
        visitorKeySet.add(key);
      }

      if (
        (key === 'derived_from_jev' && val === true) ||
        (key === 'prohibited_for_training' && val === true) ||
        (key === 'jev_reference_id' && typeof val === 'string' && val.trim().length > 0) ||
        key === 'jev_output' ||
        key === 'jev_prediction'
      ) {
        hasJevProvenance = true;
        matchedJevDetail = matchedJevDetail ?? `${key}=${String(val)}`;
      }

      if (JEV_PROVENANCE_KEYS.has(key) && typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        if (JEV_PROVENANCE_VALUES.has(lower) || /\bjev\b/.test(lower) || lower.startsWith('jev-') || lower.startsWith('jev_')) {
          hasJevProvenance = true;
          matchedJevDetail = matchedJevDetail ?? `${key}=${val}`;
          if (key === 'teacher' || key === 'teacher_origin') {
            hasJevTeacher = true;
          }
        }
      }

      if ((key === 'teacher_id' || key === 'teacherId') && typeof val === 'string' && /jev/i.test(val)) {
        hasJevProvenance = true;
        hasJevTeacher = true;
        matchedJevDetail = matchedJevDetail ?? `${key}=${val}`;
      }

      if (typeof val === 'object') {
        stack.push(val);
      }
    }
  }

  return {
    hasJevProvenance,
    hasJevTeacher,
    hasVisitorField: visitorKeySet.size > 0,
    exceededNodeLimit: false,
    matchedJevDetail,
    visitorKeys: Array.from(visitorKeySet).sort(),
  };
}

const POISONING_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /system\s*prompt\s*:/i,
  /\[ugk_backdoor_trigger\]/i,
  /\u200B{3,}|\u2060{3,}/, // repeated zero-width obfuscation characters
];

export function isSuspiciousPoisoningExample(text: string): boolean {
  return POISONING_PATTERNS.some((re) => re.test(text));
}

// =========================================================================
// Full Unicode Code-Point Multi-Seed MinHash Shingling ([H-04])
// =========================================================================

const NUM_MINHASH_SEEDS = 16;
const MINHASH_BANDS = 8;
const MINHASH_ROWS_PER_BAND = 2;

const MINHASH_SEEDS: readonly number[] = Array.from(
  { length: NUM_MINHASH_SEEDS },
  (_, k) => (Math.imul(k + 1, 0x9e3779b1) ^ 0x85ebca6b) >>> 0
);

function hashUtf8WithSeed32(bytes: Uint8Array, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Murmur3 32-bit avalanche finalizer so ASCII and CJK UTF-8 bytes mix uniformly
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function extractNormalizedUnicodeShingles(rawText: string): {
  readonly normalized: string;
  readonly shingles: ReadonlySet<string>;
} {
  const normalized = rawText
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000\p{P}\p{S}]+/gu, '')
    .trim();
  // Split into true Unicode code points (never splitting UTF-16 surrogate pairs)
  const codePoints = Array.from(normalized);
  const shingles = new Set<string>();
  if (codePoints.length === 0) {
    return { normalized: '', shingles };
  }
  if (codePoints.length < 4) {
    shingles.add(codePoints.join(''));
    return { normalized, shingles };
  }
  for (let i = 0; i + 4 <= codePoints.length; i += 1) {
    shingles.add(codePoints.slice(i, i + 4).join(''));
  }
  return { normalized, shingles };
}

export function computeUnicodeMinHashSignature(rawText: string): {
  readonly normalized: string;
  readonly shingles: ReadonlySet<string>;
  readonly signature: Uint32Array;
  readonly bandKeys: readonly string[];
} {
  const { normalized, shingles } = extractNormalizedUnicodeUnicodeShinglesCached(rawText);
  const sig = new Uint32Array(NUM_MINHASH_SEEDS);
  sig.fill(0xffffffff);

  if (shingles.size === 0) {
    sig.fill(0);
  } else {
    for (const sh of shingles) {
      const shBytes = utf8ToBytes(sh);
      for (let s = 0; s < NUM_MINHASH_SEEDS; s += 1) {
        const hv = hashUtf8WithSeed32(shBytes, MINHASH_SEEDS[s]);
        if (hv < sig[s]) {
          sig[s] = hv;
        }
      }
    }
  }

  const bandKeys: string[] = [];
  for (let b = 0; b < MINHASH_BANDS; b += 1) {
    const offset = b * MINHASH_ROWS_PER_BAND;
    const parts: string[] = [];
    for (let r = 0; r < MINHASH_ROWS_PER_BAND; r += 1) {
      parts.push(sig[offset + r].toString(16).padStart(8, '0'));
    }
    bandKeys.push(`mh_b${b}:${parts.join('_')}`);
  }

  return { normalized, shingles, signature: sig, bandKeys };
}

function extractNormalizedUnicodeUnicodeShinglesCached(rawText: string) {
  return extractNormalizedUnicodeShingles(rawText);
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of smaller) {
    if (larger.has(x)) inter += 1;
  }
  const unionSize = a.size + b.size - inter;
  return unionSize > 0 ? inter / unionSize : 0;
}

/**
 * Deterministic near-duplicate cluster ID using 16-seed Unicode code-point MinHash (`[H-04]`).
 * Zero ASCII lexicographic bias: Japanese CJK shingles participate equally alongside ASCII tokens.
 */
export function computeNearDuplicateClusterId(rawText: string): string {
  const { signature } = computeUnicodeMinHashSignature(rawText);
  const hexSig = Array.from(signature, (v) => v.toString(16).padStart(8, '0')).join('');
  return `ndc_${sha256Hex(hexSig).slice(0, 16)}`;
}

/**
 * Asserts zero Jev provenance across all candidate examples FIRST (`[H-04]` + `[M-18]`).
 */
export function assertZeroJevProvenanceFirst(examples: readonly CandidateTrainingExample[]): void {
  const d31b = requireDecisionEntitled('D-31b');
  if (d31b.entitled) {
    throw new Error('Invariant broken: Decision D-31b must remain permanently prohibited');
  }

  const jevIds: string[] = [];
  for (const ex of examples) {
    const deep = scanDeepProhibitedProvenance(ex);
    if (
      ex.source === 'jev_output' ||
      ex.derived_from_jev === true ||
      Boolean(ex.jev_reference_id) ||
      deep.hasJevProvenance
    ) {
      jevIds.push(ex.example_id || '__unknown_example__');
    }
  }
  if (jevIds.length > 0) {
    throw new JevTrainingProhibitedError(jevIds);
  }
}

/**
 * Mechanical Provenance Gate (§8.14 / Addendum §4 & §6):
 * - Throws `JevTrainingProhibitedError` immediately if ANY Jev output enters the dataset (D-31b).
 * - Checks 0 visitor rows, 0 unconsented external tenant texts (D-31d), and 0 custom_event/replay rows.
 * - Enforces <= `maxOwnerShare` (default `1/3`) owner-group effective weight cap on multi-owner collaborative training.
 */
export function verifyTrainingDatasetProvenance(params: {
  readonly examples: readonly CandidateTrainingExample[];
  readonly scope: AdapterTrainingScope;
  readonly targetTenantId?: string;
  readonly taskKind: 'section_reading' | 'naming_explanation' | 'hypothesis_quality';
  /** Optional explicit override ONLY if Decision D-31d + legal sign-off were recorded. */
  readonly decision31dSharedExternalApproved?: boolean;
  readonly maxOwnerShare?: number;
}): ProvenanceAuditReport {
  // 1. [H-04] & [M-18]: Run D-31b deep Jev check FIRST!
  assertZeroJevProvenanceFirst(params.examples);

  const d31dLedger = requireDecisionEntitled('D-31d', { enforceLegalSignOff: true });
  const sharedExternalEntitled =
    d31dLedger.entitled || params.decision31dSharedExternalApproved === true;

  let visitorRowCount = 0;
  let unconsentedTenantCount = 0;
  let nonStandardLaneCount = 0;
  const errors: string[] = [];

  for (const ex of params.examples) {
    // 2. ZERO visitor rows (§8.12 / §8.14) — deep iterative scan
    const deep = scanDeepProhibitedProvenance(ex);
    if (ex.contains_visitor_row === true || deep.hasVisitorField) {
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

  // 6. Owner-group weight cap <= maxOwnerShare (default 1/3) on multi-owner collaborative shared training (§8.14)
  const capLimit = params.maxOwnerShare ?? 1 / 3;
  const ownerWeights = new Map<string, number>();
  let totalWeight = 0;
  for (const ex of params.examples) {
    const w = Math.max(0, ex.sample_weight);
    ownerWeights.set(ex.owner_group_id, (ownerWeights.get(ex.owner_group_id) ?? 0) + w);
    totalWeight += w;
  }

  const distinctOwners = ownerWeights.size;
  const multiOwnerCapApplied = params.scope === 'shared_adapter' && distinctOwners >= 2;
  let maxObservedOwnerShare = 0;
  if (totalWeight > 0) {
    for (const w of ownerWeights.values()) {
      const share = w / totalWeight;
      if (share > maxObservedOwnerShare) maxObservedOwnerShare = share;
    }
  }
  if (multiOwnerCapApplied && maxObservedOwnerShare > capLimit + 1e-6) {
    errors.push(
      `Multi-owner collaborative training owner share ${(maxObservedOwnerShare * 100).toFixed(2)}% exceeds ${(capLimit * 100).toFixed(2)}% cap`
    );
  }

  return {
    passed: errors.length === 0,
    jev_output_count: 0,
    visitor_row_count: visitorRowCount,
    unconsented_tenant_text_count: unconsentedTenantCount,
    non_standard_lane_count: nonStandardLaneCount,
    multi_owner_cap_applied: multiOwnerCapApplied,
    max_owner_effective_weight_share: Number(maxObservedOwnerShare.toFixed(6)),
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
  readonly splitAssignmentsByComponent: ReadonlyMap<string, SplitName>;
  readonly splitAssignmentsByExample: ReadonlyMap<string, SplitName>;
  readonly overlap_audit: {
    readonly passed: boolean;
    readonly overlapping_page_lineages: number;
    readonly overlapping_near_dup_clusters: number;
    readonly overlapping_experiment_ids: number;
  };
}

/**
 * [H-04] Exact active-set water-filling weight capper for multi-owner collaborative training:
 * Converges in at most `|owners|` exact active-set steps so every owner's normalized weight
 * share is strictly `<= maxOwnerShare + 1e-9` whenever `|owners| * maxOwnerShare >= 1`
 * (including `maxOwnerShare = 1/3` for `>= 3` owners and `maxOwnerShare = 0.05` for `>= 20` owners!).
 */
export function capMultiOwnerWeights(
  examples: readonly CandidateTrainingExample[],
  scope: AdapterTrainingScope,
  maxOwnerShare: number = 1 / 3
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const ex of examples) {
    weights.set(ex.example_id, Math.max(1e-6, ex.sample_weight));
  }

  if (scope !== 'shared_adapter' || examples.length === 0) {
    return weights;
  }

  const rawOwnerSums = new Map<string, number>();
  let rawTotal = 0;
  for (const ex of examples) {
    const w = weights.get(ex.example_id)!;
    rawOwnerSums.set(ex.owner_group_id, (rawOwnerSums.get(ex.owner_group_id) ?? 0) + w);
    rawTotal += w;
  }

  const owners = Array.from(rawOwnerSums.keys());
  const numOwners = owners.length;
  const tau = Math.max(1e-6, Math.min(1, maxOwnerShare));

  // Mathematically feasible iff `numOwners * tau >= 1`
  if (numOwners < 2 || numOwners * tau < 1 - 1e-12 || rawTotal <= 0) {
    return weights;
  }

  const clampedOwners = new Set<string>();
  const targetOwnerShare = new Map<string, number>();

  for (let step = 0; step < numOwners; step += 1) {
    const remShare = Math.max(0, 1 - clampedOwners.size * tau);
    const unclampedOwners = owners.filter((o) => !clampedOwners.has(o));
    if (unclampedOwners.length === 0) {
      break;
    }

    let unclampedSum = 0;
    for (const o of unclampedOwners) {
      unclampedSum += rawOwnerSums.get(o) ?? 0;
    }

    if (unclampedSum <= 1e-15) {
      const equalShare = remShare / unclampedOwners.length;
      for (const o of unclampedOwners) {
        targetOwnerShare.set(o, equalShare);
      }
      break;
    }

    let newlyClamped = false;
    for (const o of unclampedOwners) {
      const candidateShare = remShare * ((rawOwnerSums.get(o) ?? 0) / unclampedSum);
      if (candidateShare > tau + 1e-13) {
        clampedOwners.add(o);
        targetOwnerShare.set(o, tau);
        newlyClamped = true;
      } else {
        targetOwnerShare.set(o, candidateShare);
      }
    }

    if (!newlyClamped) {
      break;
    }
  }

  // Scale each example's weight proportionally so owner m's normalized share equals `targetOwnerShare.get(m)`
  for (const ex of examples) {
    const origW = weights.get(ex.example_id)!;
    const ownerRaw = rawOwnerSums.get(ex.owner_group_id) ?? origW;
    const desiredShare = targetOwnerShare.get(ex.owner_group_id);
    if (desiredShare !== undefined && ownerRaw > 0) {
      weights.set(ex.example_id, origW * ((desiredShare * rawTotal) / ownerRaw));
    }
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

export class InsufficientSplitComponentsError extends Error {
  public readonly componentCount: number;

  constructor(componentCount: number, detail: string) {
    super(`INSUFFICIENT_SPLIT_COMPONENTS (components=${componentCount}): ${detail}`);
    this.name = 'InsufficientSplitComponentsError';
    this.componentCount = componentCount;
  }
}

export class SplitContaminationConflictError extends Error {
  public readonly groupKey: string;
  public readonly conflictingSplits: readonly SplitName[];
  public readonly exampleIds: readonly string[];

  constructor(
    groupKey: string,
    conflictingSplits: readonly SplitName[],
    exampleIds: readonly string[]
  ) {
    super(
      `SPLIT_CONTAMINATION_CONFLICT (groupKey=${groupKey}, splits=${conflictingSplits.join(',')}): Connected component bridges prior locked assignments across distinct splits; refusing silent merge (examples=${exampleIds.join(',')})`
    );
    this.name = 'SplitContaminationConflictError';
    this.groupKey = groupKey;
    this.conflictingSplits = conflictingSplits;
    this.exampleIds = exampleIds;
  }
}

export class MissingPriorSplitAssignmentsError extends Error {
  constructor(
    detail = 'isRebuild=true requires non-empty priorSplitAssignments to prevent cross-split leakage'
  ) {
    super(`MISSING_PRIOR_SPLIT_ASSIGNMENTS: ${detail}`);
    this.name = 'MissingPriorSplitAssignmentsError';
  }
}

/**
 * Builds a provenance-verified, poisoning-quarantined, deduplicated 3-way split dataset
 * (`train` / `select_tune` / `final_eval`, `[H-04]` / `[#23]`):
 * 0. Checks `D-31b` Jev provenance FIRST across ALL input records (before quarantine or dedup!).
 * 1. Quarantines poisoning / prompt-injection records.
 * 2. Builds Union-Find connected components strictly on `(page_lineage_id, near_duplicate_cluster,
 *    skeleton_hash, experiment_id)` BEFORE dedup (never collapsing unrelated pages sharing `site_id`
 *    unless `splitBoundaryMode: 'site'` is explicitly requested).
 * 3. Assigns each connected component atomically to ONE split (`train` / `select_tune` / `final_eval`),
 *    failing closed with `INSUFFICIENT_SPLIT_COMPONENTS` if all 3 splits cannot be populated!
 */
interface ThreeWayDatasetParams {
  /** Stable absolute file path per dataset series on durable storage shared by every builder.
   * The parent directory must exist; the first successful build creates the manifest. */
  readonly splitManifestPath: string;
  readonly examples: readonly CandidateTrainingExample[];
  readonly scope: AdapterTrainingScope;
  readonly targetTenantId?: string;
  readonly taskKind: 'section_reading' | 'naming_explanation' | 'hypothesis_quality';
  readonly seed: string;
  readonly decision31dSharedExternalApproved?: boolean;
  readonly maxOwnerShare?: number;
  readonly nearDuplicateJaccardThreshold?: number;
  /**
   * Controls whether `site_id` is included as a Union-Find boundary (`[#23]`).
   * Defaults to `'lineage'` (page_lineage_id + near-dup + skeleton_hash + experiment_id)
   * so single-site corpora do NOT collapse into 1 component.
   */
  readonly splitBoundaryMode?: 'lineage' | 'site';
  /**
   * Persistent split assignments from prior dataset builds (`[#23]`).
   * Keys may be component `groupKey` (`splitAssignmentsByComponent`), `page_lineage_id`, or `example_id`
   * (`splitAssignmentsByExample`). Every previously assigned component/example is strictly locked to its
   * original split so a prior `train` or `select_tune` example can NEVER migrate into `final_eval`,
   * and bridging two distinct prior splits immediately throws `SplitContaminationConflictError`.
   */
  readonly priorSplitAssignments?: ReadonlyMap<string, SplitName>;
  /**
   * Require a committed manifest or explicit legacy assignments on the first import.
   */
  readonly isRebuild?: boolean;
  readonly ratios?: { readonly train: number; readonly select_tune: number; readonly final_eval: number };
}

export function buildThreeWayTrainingDataset(params: ThreeWayDatasetParams): ThreeWayDatasetBuildResult {
  // 0. [H-04]: Run D-31b Jev provenance check FIRST on ALL raw examples (even if text looks like poisoning!)
  assertZeroJevProvenanceFirst(params.examples);

  const scope = JSON.stringify([params.scope, params.targetTenantId ?? null, params.taskKind]);
  return withSplitManifest(params.splitManifestPath, scope, (history) => buildWithHistory(params, history));
}

function buildWithHistory(params: ThreeWayDatasetParams, history: ReadonlyMap<string, SplitName>) {
  if (params.isRebuild === true && !history.size && !params.priorSplitAssignments?.size) {
    throw new MissingPriorSplitAssignmentsError();
  }

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

  const maxOwnerShare = params.maxOwnerShare ?? 1 / 3;
  const nearDupThreshold = params.nearDuplicateJaccardThreshold ?? 0.9;

  // 2. Cap multi-owner weights via exact water-filling and verify full provenance
  const preSplitWeights = capMultiOwnerWeights(cleanExamples, params.scope, maxOwnerShare);
  const weightedExamples = cleanExamples.map((ex) => ({
    ...ex,
    sample_weight: preSplitWeights.get(ex.example_id) ?? ex.sample_weight,
  }));

  const initialProvenance = verifyTrainingDatasetProvenance({
    examples: weightedExamples,
    scope: params.scope,
    targetTenantId: params.targetTenantId,
    taskKind: params.taskKind,
    decision31dSharedExternalApproved: params.decision31dSharedExternalApproved,
    maxOwnerShare,
  });

  if (!initialProvenance.passed) {
    throw new Error(`Dataset provenance audit failed: ${initialProvenance.errors.join('; ')}`);
  }

  // 3. [H-04]: Compute Unicode code-point MinHash & build Union-Find across ALL examples BEFORE dedup!
  const n = weightedExamples.length;
  const mhInfos = weightedExamples.map((ex) => computeUnicodeMinHashSignature(ex.public_text));
  const rawClusterIds = mhInfos.map((info) => {
    const hexSig = Array.from(info.signature, (v) => v.toString(16).padStart(8, '0')).join('');
    return `ndc_${sha256Hex(hexSig).slice(0, 16)}`;
  });

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (cur !== root) {
      const nxt = parent[cur];
      parent[cur] = root;
      cur = nxt;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
  };

  // 3a. [#23] Union strictly by page_lineage_id, near-dup cluster, skeleton_hash, and experiment_id.
  // NEVER unconditionally union unrelated pages by `site_id` unless `splitBoundaryMode === 'site'`!
  const splitBoundaryMode = params.splitBoundaryMode ?? 'lineage';
  const keyFirstIndex = new Map<string, number>();
  const manifestKeys: string[][] = [];
  for (let i = 0; i < n; i += 1) {
    const ex = weightedExamples[i];
    const boundaryKeys: string[] = [
      `lin:${ex.page_lineage_id}`,
      `lin_ten:${ex.tenant_id}:${ex.page_lineage_id}`,
      `ndc:${rawClusterIds[i]}`,
    ];
    if (splitBoundaryMode === 'site' && ex.site_id) {
      boundaryKeys.push(`site:${ex.tenant_id}:${ex.site_id}`);
    }
    if (ex.skeleton_hash) {
      boundaryKeys.push(`skel:${ex.skeleton_hash}`);
    }
    if (ex.experiment_id) {
      boundaryKeys.push(`exp:${ex.experiment_id}`);
    }
    manifestKeys.push([...boundaryKeys, 'example:' + ex.example_id].map((key) => sha256Hex(key)));
    for (const k of boundaryKeys) {
      const prev = keyFirstIndex.get(k);
      if (prev !== undefined) union(prev, i);
      else keyFirstIndex.set(k, i);
    }
  }

  // 3b. Union near-duplicate pairs discovered via Unicode MinHash LSH bands + Jaccard >= threshold
  const bandBuckets = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    for (const bk of mhInfos[i].bandKeys) {
      let list = bandBuckets.get(bk);
      if (!list) {
        list = [];
        bandBuckets.set(bk, list);
      }
      list.push(i);
    }
  }

  for (const bucketIndices of bandBuckets.values()) {
    if (bucketIndices.length < 2) continue;
    for (let a = 0; a < bucketIndices.length; a += 1) {
      const idxA = bucketIndices[a];
      for (let b = a + 1; b < bucketIndices.length; b += 1) {
        const idxB = bucketIndices[b];
        if (find(idxA) === find(idxB)) continue;
        const jac = jaccardSimilarity(mhInfos[idxA].shingles, mhInfos[idxB].shingles);
        if (jac >= nearDupThreshold) {
          union(idxA, idxB);
        }
      }
    }
  }

  // Group ALL examples by their connected component root
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const list = components.get(r) ?? [];
    list.push(i);
    components.set(r, list);
  }

  // 4. Assign each connected component atomically to ONE split, locking any prior assignments (`[#23]`)!
  //    Detect conflicting prior-split bridges BEFORE checking component count so a bridge that collapses
  //    3 components into 2 still fails explicitly with SplitContaminationConflictError!
  const ratios = params.ratios ?? { train: 0.6, select_tune: 0.2, final_eval: 0.2 };
  const priorSplits = params.priorSplitAssignments;
  const componentList = Array.from(components.entries()).map(([compRoot, indices]) => {
    const groupKey = indices
      .map((idx) => weightedExamples[idx].page_lineage_id)
      .sort()[0];
    const hashU =
      parseInt(sha256Hex(`${params.seed}:split:${groupKey}`).slice(0, 8), 16) / 0x100000000;

    // Resolve any prior split assignments across component key, lineage IDs, and example IDs
    let locked = false;
    let initialSplit: SplitName =
      hashU < ratios.train
        ? 'train'
        : hashU < ratios.train + ratios.select_tune
          ? 'select_tune'
          : 'final_eval';

    if (history.size || priorSplits?.size) {
      const matchedPrior = new Set<SplitName>();
      const byComp = priorSplits?.get(groupKey);
      if (byComp) matchedPrior.add(byComp);
      for (const idx of indices) {
        const ex = weightedExamples[idx];
        for (const key of manifestKeys[idx]) {
          const saved = history.get(key);
          if (saved) matchedPrior.add(saved);
        }
        const byEx = priorSplits?.get(ex.example_id);
        if (byEx) matchedPrior.add(byEx);
        const byLin = priorSplits?.get(ex.page_lineage_id);
        if (byLin) matchedPrior.add(byLin);
      }
      if (matchedPrior.size > 1) {
        // [#23] NEVER silently merge distinct prior splits (e.g. final_eval into train) — fail closed!
        const sortedSplits = Array.from(matchedPrior).sort() as SplitName[];
        const compExampleIds = indices.map((idx) => weightedExamples[idx].example_id).sort();
        throw new SplitContaminationConflictError(groupKey, sortedSplits, compExampleIds);
      }
      if (matchedPrior.size === 1) {
        locked = true;
        initialSplit = Array.from(matchedPrior)[0];
      }
    }

    return { compRoot, indices, groupKey, hashU, split: initialSplit, locked };
  });

  // [#23] Fail closed if fewer than 3 independent connected components exist for a 3-way split!
  if (components.size < 3) {
    throw new InsufficientSplitComponentsError(
      components.size,
      'At least 3 disjoint connected components are required to populate train, select_tune, and final_eval'
    );
  }

  // Ensure every split receives at least 1 atomic component when components.size >= 3,
  // moving ONLY unlocked (newly arrived) components so prior assignments are NEVER mutated (`[#23]`)!
  const splitOrder: readonly SplitName[] = ['train', 'select_tune', 'final_eval'];
  const bySplitMap = new Map<SplitName, typeof componentList>([
    ['train', []],
    ['select_tune', []],
    ['final_eval', []],
  ]);
  for (const comp of componentList) {
    bySplitMap.get(comp.split)!.push(comp);
  }
  for (const targetSplit of splitOrder) {
    if (bySplitMap.get(targetSplit)!.length === 0) {
      // Deterministically move the highest-hashU UNLOCKED atomic component from the largest eligible donor split
      let donorSplit: SplitName | null = null;
      let maxLen = -1;
      for (const s of splitOrder) {
        const list = bySplitMap.get(s)!;
        const hasUnlocked = list.some((c) => !c.locked);
        if (list.length > 1 && hasUnlocked && list.length > maxLen) {
          maxLen = list.length;
          donorSplit = s;
        }
      }
      if (donorSplit !== null) {
        const donorList = bySplitMap.get(donorSplit)!;
        const unlocked = donorList.filter((c) => !c.locked).sort((a, b) => a.hashU - b.hashU);
        const moved = unlocked.pop()!;
        const removeIdx = donorList.indexOf(moved);
        if (removeIdx >= 0) {
          donorList.splice(removeIdx, 1);
        }
        moved.split = targetSplit;
        bySplitMap.get(targetSplit)!.push(moved);
      }
    }
  }

  const survivingBySplit: Record<SplitName, Array<{ idx: number; compClusterId: string }>> = {
    train: [],
    select_tune: [],
    final_eval: [],
  };
  let deduplicatedCount = 0;

  for (const { compRoot, indices, split } of componentList) {
    const compClusterId = `ndc_comp_${sha256Hex(`${params.seed}:${compRoot}:${rawClusterIds[compRoot]}`).slice(0, 16)}`;

    // Deduplicate near-duplicates WITHIN this connected component / split
    const keptIndicesInComp: number[] = [];
    const seenExactClusters = new Set<string>();

    for (const idx of indices) {
      const exactKey = rawClusterIds[idx];
      if (seenExactClusters.has(exactKey)) {
        deduplicatedCount += 1;
        continue;
      }
      let isNearDupOfKept = false;
      for (const keptIdx of keptIndicesInComp) {
        if (jaccardSimilarity(mhInfos[idx].shingles, mhInfos[keptIdx].shingles) >= nearDupThreshold) {
          isNearDupOfKept = true;
          break;
        }
      }
      if (isNearDupOfKept) {
        deduplicatedCount += 1;
        continue;
      }
      seenExactClusters.add(exactKey);
      keptIndicesInComp.push(idx);
      survivingBySplit[split].push({ idx, compClusterId });
    }
  }

  // Re-apply exact water-filling on post-dedup surviving examples so owner weight share cap holds after dedup too
  const postDedupExamples: CandidateTrainingExample[] = [
    ...survivingBySplit.train.map((x) => cleanExamples[x.idx]),
    ...survivingBySplit.select_tune.map((x) => cleanExamples[x.idx]),
    ...survivingBySplit.final_eval.map((x) => cleanExamples[x.idx]),
  ];
  const finalWeights = capMultiOwnerWeights(postDedupExamples, params.scope, maxOwnerShare);
  const finalWeightedList = postDedupExamples.map((ex) => ({
    ...ex,
    sample_weight: finalWeights.get(ex.example_id) ?? ex.sample_weight,
  }));

  const finalProvenance =
    postDedupExamples.length > 0
      ? verifyTrainingDatasetProvenance({
          examples: finalWeightedList,
          scope: params.scope,
          targetTenantId: params.targetTenantId,
          taskKind: params.taskKind,
          decision31dSharedExternalApproved: params.decision31dSharedExternalApproved,
          maxOwnerShare,
        })
      : initialProvenance;

  if (!finalProvenance.passed) {
    throw new Error(`Post-dedup dataset provenance audit failed: ${finalProvenance.errors.join('; ')}`);
  }

  const buildSplitItems = (
    entries: ReadonlyArray<{ idx: number; compClusterId: string }>,
    split: SplitName
  ): SplitTrainingExample[] =>
    entries.map(({ idx, compClusterId }) => {
      const base = cleanExamples[idx];
      const effW = finalWeights.get(base.example_id) ?? base.sample_weight;
      return {
        ...base,
        sample_weight: effW,
        near_duplicate_cluster_id: compClusterId,
        effective_weight: effW,
        split,
      };
    });

  const train = buildSplitItems(survivingBySplit.train, 'train');
  const selectTune = buildSplitItems(survivingBySplit.select_tune, 'select_tune');
  const finalEval = buildSplitItems(survivingBySplit.final_eval, 'final_eval');

  if (train.length === 0 || selectTune.length === 0 || finalEval.length === 0) {
    throw new InsufficientSplitComponentsError(
      components.size,
      `3-way split produced empty partition(s): train=${train.length}, select_tune=${selectTune.length}, final_eval=${finalEval.length}`
    );
  }

  const overlapAudit = verifyZeroSplitOverlap(train, selectTune, finalEval);
  if (!overlapAudit.passed) {
    throw new Error('Fatal split boundary overlap detected across train/select_tune/final_eval');
  }

  const allKeptIds = [...train, ...selectTune, ...finalEval]
    .map((e) => e.example_id)
    .sort()
    .join(',');
  const datasetId = `ds_${sha256Hex(`${params.taskKind}:${params.scope}:${params.seed}:${allKeptIds}`).slice(0, 20)}`;

  const splitAssignmentsByComponent = new Map<string, SplitName>();
  const assignments = new Map<string, SplitName>();
  for (const comp of componentList) {
    splitAssignmentsByComponent.set(comp.groupKey, comp.split);
    for (const idx of comp.indices) {
      for (const key of manifestKeys[idx]) {
        if (assignments.has(key) && assignments.get(key) !== comp.split) {
          throw new SplitContaminationConflictError(comp.groupKey, [assignments.get(key)!, comp.split],
            [weightedExamples[idx].example_id]);
        }
        assignments.set(key, comp.split);
      }
    }
  }
  const splitAssignmentsByExample = new Map<string, SplitName>();
  for (const item of [...train, ...selectTune, ...finalEval]) {
    splitAssignmentsByExample.set(item.example_id, item.split);
  }

  const result: ThreeWayDatasetBuildResult = {
    dataset_id: datasetId,
    provenance: finalProvenance,
    train,
    select_tune: selectTune,
    final_eval: finalEval,
    deduplicated_count: deduplicatedCount,
    quarantined_poisoning_ids: quarantinedPoisoningIds,
    splitAssignmentsByComponent,
    splitAssignmentsByExample,
    overlap_audit: overlapAudit,
  };
  return { result, assignments };
}
