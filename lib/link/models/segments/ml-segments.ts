/**
 * UGOKI LINK v2 — Bundle 6-A.2: Learned Segments (`centroid_ml` & `density_ml`)
 * (`lib/link/models/segments/ml-segments.ts`)
 *
 * Implements §8.6, §8.12, ML M6 & connects directly to Wave 4-A `lib/link/surface/segments.ts`:
 * - Extends 4-A `SegmentRegistry` with two ML challenger tiers:
 *   1. `centroid_ml`: deterministic k-means++ / spherical centroid clustering
 *   2. `density_ml`: DBSCAN / HDBSCAN-style core-distance density clustering (with explicit noise ratio)
 * - Outcome-feature prohibition guard (`OutcomeFeatureInSegmentError`): NEVER permits conversion,
 *   revenue, click outcome, or purchase features as clustering inputs (§8.6).
 * - Lineage ID inheritance (`matchSegmentLineage`): computes pairwise Jaccard overlap between old
 *   and new cluster assignments; inherits `segmentId` whenever `jaccard >= 0.50`!
 * - Stability & Size Gates:
 *   - Bootstrap Adjusted Rand Index (`computeAdjustedRandIndex`) >= 0.75
 *   - Minimum cluster size >= `max(500 sessions, 3% of total sessions)`
 *   - Density challenger beats centroid only when `densityAri >= centroidAri && noiseShare <= 0.20`
 *   - Outcome differences between segments may ONLY be stated when replicated in a second held-out period!
 * - Connects 4-G LLM semantic interest enrichment & cluster naming strictly as `challenger`.
 */

import { sha256Hex } from '../../../../packages/contract/schema';
import type { MlModelRegistry } from '../../ml/foundation/registry';
import type {
  MlSegmentDescriptor,
  RegisteredSegment,
  SegmentRegistry,
} from '../../surface/segments';

export const MIN_SEGMENT_BOOTSTRAP_ARI = 0.75 as const;
export const MIN_SEGMENT_ABSOLUTE_SESSIONS = 500 as const;
export const MIN_SEGMENT_SHARE = 0.03 as const;
export const MIN_SEGMENT_LINEAGE_JACCARD = 0.5 as const;
export const MAX_DENSITY_NOISE_SHARE = 0.2 as const;

export class OutcomeFeatureInSegmentError extends Error {
  public readonly forbiddenFeatures: readonly string[];

  constructor(forbiddenFeatures: readonly string[]) {
    super(
      `§8.6 Segment Contamination Violation: outcome-coupled features are FORBIDDEN in segment clustering (found: ${forbiddenFeatures.join(', ')})`
    );
    this.name = 'OutcomeFeatureInSegmentError';
    this.forbiddenFeatures = forbiddenFeatures;
  }
}

const OUTCOME_FEATURE_PATTERNS: readonly RegExp[] = [
  /cvr/i,
  /conversion/i,
  /converted/i,
  /aff_click/i,
  /revenue/i,
  /purchase/i,
  /order_value/i,
  /lead_submitted/i,
  /outcome/i,
  /reward/i,
];

/**
 * Hard guard enforcing §8.6: outcome-coupled features MUST NEVER enter segment clustering.
 */
export function assertNoOutcomeFeaturesInSegment(featureNames: readonly string[]): void {
  const bad = featureNames.filter((name) =>
    OUTCOME_FEATURE_PATTERNS.some((re) => re.test(name))
  );
  if (bad.length > 0) {
    throw new OutcomeFeatureInSegmentError(bad);
  }
}

export interface SessionFeaturePoint {
  readonly session_id: string;
  readonly features: readonly number[];
}

export interface LearnedClusterResult {
  readonly cluster_idx: number;
  readonly member_session_ids: readonly string[];
  readonly centroid: readonly number[];
  readonly max_distance: number;
  readonly density_threshold?: number;
  readonly size: number;
  readonly share: number;
}

function euclideanDistance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Tier 1 Challenger (`centroid_ml`): Deterministic K-Means clustering with farthest-first seeding.
 */
export function fitCentroidSegments(params: {
  readonly featureNames: readonly string[];
  readonly points: readonly SessionFeaturePoint[];
  readonly k: number;
  readonly maxIterations?: number;
}): {
  readonly kind: 'centroid_ml';
  readonly clusters: readonly LearnedClusterResult[];
  readonly assignments: readonly number[];
} {
  assertNoOutcomeFeaturesInSegment(params.featureNames);
  const n = params.points.length;
  const k = Math.max(1, Math.min(params.k, n));
  const dim = params.featureNames.length;
  if (n === 0 || dim === 0) {
    return { kind: 'centroid_ml', clusters: [], assignments: [] };
  }

  // Deterministic farthest-first initialization (k-means++ deterministic variant)
  const centroids: number[][] = [[...params.points[0].features]];
  while (centroids.length < k) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const c of centroids) {
        const d = euclideanDistance(params.points[i].features, c);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }
    centroids.push([...params.points[bestIdx].features]);
  }

  const assignments = new Array<number>(n).fill(0);
  const maxIter = params.maxIterations ?? 25;

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclideanDistance(params.points[i].features, centroids[c]);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c] += 1;
      for (let d = 0; d < dim; d++) sums[c][d] += params.points[i].features[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
      }
    }
    if (!changed) break;
  }

  const clusters: LearnedClusterResult[] = [];
  for (let c = 0; c < k; c++) {
    const members: string[] = [];
    let maxDist = 0;
    for (let i = 0; i < n; i++) {
      if (assignments[i] === c) {
        members.push(params.points[i].session_id);
        const d = euclideanDistance(params.points[i].features, centroids[c]);
        if (d > maxDist) maxDist = d;
      }
    }
    clusters.push({
      cluster_idx: c,
      member_session_ids: members,
      centroid: centroids[c].map((v) => Number(v.toFixed(6))),
      max_distance: Number((maxDist + 1e-6).toFixed(6)),
      size: members.length,
      share: Number((members.length / n).toFixed(4)),
    });
  }

  return { kind: 'centroid_ml', clusters, assignments };
}

/**
 * Tier 2 Challenger (`density_ml`): DBSCAN-based density clustering with explicit noise tracking.
 */
export function fitDensitySegments(params: {
  readonly featureNames: readonly string[];
  readonly points: readonly SessionFeaturePoint[];
  readonly eps: number;
  readonly minPts: number;
}): {
  readonly kind: 'density_ml';
  readonly clusters: readonly LearnedClusterResult[];
  readonly assignments: readonly number[]; // -1 = noise
  readonly noise_count: number;
  readonly noise_share: number;
} {
  assertNoOutcomeFeaturesInSegment(params.featureNames);
  const n = params.points.length;
  const dim = params.featureNames.length;
  const assignments = new Array<number>(n).fill(-2); // -2 = unvisited, -1 = noise
  let clusterId = 0;

  const regionQuery = (idx: number): number[] => {
    const res: number[] = [];
    const p = params.points[idx].features;
    for (let j = 0; j < n; j++) {
      if (euclideanDistance(p, params.points[j].features) <= params.eps) {
        res.push(j);
      }
    }
    return res;
  };

  for (let i = 0; i < n; i++) {
    if (assignments[i] !== -2) continue;
    const neighbors = regionQuery(i);
    if (neighbors.length < params.minPts) {
      assignments[i] = -1; // noise
      continue;
    }
    assignments[i] = clusterId;
    const queue = [...neighbors];
    let qHead = 0;
    while (qHead < queue.length) {
      const nb = queue[qHead++];
      if (assignments[nb] === -1) assignments[nb] = clusterId;
      if (assignments[nb] !== -2) continue;
      assignments[nb] = clusterId;
      const nbNeighbors = regionQuery(nb);
      if (nbNeighbors.length >= params.minPts) {
        for (const candidate of nbNeighbors) {
          if (assignments[candidate] === -2 || assignments[candidate] === -1) {
            queue.push(candidate);
          }
        }
      }
    }
    clusterId += 1;
  }

  let noiseCount = 0;
  for (const a of assignments) if (a < 0) noiseCount += 1;

  const clusters: LearnedClusterResult[] = [];
  for (let c = 0; c < clusterId; c++) {
    const members: string[] = [];
    const sum = new Array<number>(dim).fill(0);
    for (let i = 0; i < n; i++) {
      if (assignments[i] === c) {
        members.push(params.points[i].session_id);
        for (let d = 0; d < dim; d++) sum[d] += params.points[i].features[d];
      }
    }
    const centroid = sum.map((v) => v / Math.max(1, members.length));
    let maxDistSq = 0;
    for (let i = 0; i < n; i++) {
      if (assignments[i] === c) {
        const d = euclideanDistance(params.points[i].features, centroid);
        if (d * d > maxDistSq) maxDistSq = d * d;
      }
    }
    const densityThreshold = Number(Math.exp(-0.5 * maxDistSq).toFixed(6));
    clusters.push({
      cluster_idx: c,
      member_session_ids: members,
      centroid: centroid.map((v) => Number(v.toFixed(6))),
      max_distance: Number(Math.sqrt(maxDistSq).toFixed(6)),
      density_threshold: densityThreshold,
      size: members.length,
      share: Number((members.length / Math.max(1, n)).toFixed(4)),
    });
  }

  return {
    kind: 'density_ml',
    clusters,
    assignments,
    noise_count: noiseCount,
    noise_share: Number((noiseCount / Math.max(1, n)).toFixed(4)),
  };
}

// =========================================================================
// Exact Adjusted Rand Index (ARI) for Bootstrap Stability Gate (>= 0.75)
// =========================================================================

function comb2(n: number): number {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

/**
 * Exact Adjusted Rand Index (Hubert & Arabie 1985) between two clusterings over the same N items.
 */
export function computeAdjustedRandIndex(
  labelsA: readonly number[],
  labelsB: readonly number[]
): number {
  const n = Math.min(labelsA.length, labelsB.length);
  if (n < 2) return 0;

  const pairCounts = new Map<string, number>();
  const rowSums = new Map<number, number>();
  const colSums = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const a = labelsA[i];
    const b = labelsB[i];
    const pk = `${a}|${b}`;
    pairCounts.set(pk, (pairCounts.get(pk) ?? 0) + 1);
    rowSums.set(a, (rowSums.get(a) ?? 0) + 1);
    colSums.set(b, (colSums.get(b) ?? 0) + 1);
  }

  let sumCombPairs = 0;
  for (const c of pairCounts.values()) sumCombPairs += comb2(c);
  let sumCombRows = 0;
  for (const r of rowSums.values()) sumCombRows += comb2(r);
  let sumCombCols = 0;
  for (const c of colSums.values()) sumCombCols += comb2(c);

  const totalComb = comb2(n);
  const expected = (sumCombRows * sumCombCols) / totalComb;
  const maxIndex = 0.5 * (sumCombRows + sumCombCols);
  const denom = maxIndex - expected;
  if (Math.abs(denom) <= 1e-12) return sumCombPairs >= totalComb - 1e-12 ? 1 : 0;
  return Number(((sumCombPairs - expected) / denom).toFixed(4));
}

// =========================================================================
// Lineage Matching (Jaccard >= 0.50 inherits previous segmentId, §8.6)
// =========================================================================

export interface PreviousSegmentMembers {
  readonly segmentId: string;
  readonly member_session_ids: readonly string[];
}

export interface SegmentLineageMatch {
  readonly new_cluster_idx: number;
  readonly assigned_segment_id: string;
  readonly inherited_from_segment_id: string | null;
  readonly jaccard_overlap: number;
}

/**
 * Matches newly fit clusters against previous clusters using optimal greedy 1:1 Jaccard overlap.
 * Inherits the previous `segmentId` strictly when `jaccard >= 0.50` (§8.6).
 */
export function matchSegmentLineage(
  previous: readonly PreviousSegmentMembers[],
  newClusters: readonly LearnedClusterResult[],
  newIdPrefix = 'seg_ml'
): readonly SegmentLineageMatch[] {
  const prevSets = previous.map((p) => ({
    segmentId: p.segmentId,
    set: new Set(p.member_session_ids),
  }));

  const pairs: Array<{ readonly prevIdx: number; readonly newIdx: number; readonly jaccard: number }> = [];
  for (let ni = 0; ni < newClusters.length; ni++) {
    const newSet = new Set(newClusters[ni].member_session_ids);
    for (let pi = 0; pi < prevSets.length; pi++) {
      let inter = 0;
      for (const id of newSet) {
        if (prevSets[pi].set.has(id)) inter += 1;
      }
      const union = newSet.size + prevSets[pi].set.size - inter;
      const jaccard = union > 0 ? inter / union : 0;
      pairs.push({ prevIdx: pi, newIdx: ni, jaccard });
    }
  }

  pairs.sort((a, b) => b.jaccard - a.jaccard);
  const usedPrev = new Set<number>();
  const matchedNew = new Map<number, { readonly segId: string; readonly jaccard: number }>();

  for (const p of pairs) {
    if (p.jaccard < MIN_SEGMENT_LINEAGE_JACCARD) break;
    if (usedPrev.has(p.prevIdx) || matchedNew.has(p.newIdx)) continue;
    usedPrev.add(p.prevIdx);
    matchedNew.set(p.newIdx, {
      segId: prevSets[p.prevIdx].segmentId,
      jaccard: Number(p.jaccard.toFixed(4)),
    });
  }

  return newClusters.map((c, idx) => {
    const m = matchedNew.get(idx);
    if (m) {
      return {
        new_cluster_idx: c.cluster_idx,
        assigned_segment_id: m.segId,
        inherited_from_segment_id: m.segId,
        jaccard_overlap: m.jaccard,
      };
    }
    const freshId = `${newIdPrefix}_${sha256Hex(`${c.centroid.join(',')}:${c.size}:${idx}`).slice(0, 10)}`;
    return {
      new_cluster_idx: c.cluster_idx,
      assigned_segment_id: freshId,
      inherited_from_segment_id: null,
      jaccard_overlap: 0,
    };
  });
}

// =========================================================================
// Stability, Size, Replication Gates & 4-A SegmentRegistry Plug-In
// =========================================================================

export interface SegmentQualityGateResult {
  readonly passed: boolean;
  readonly bootstrap_ari: number;
  readonly min_cluster_size_required: number;
  readonly undersized_clusters: readonly number[];
  readonly noise_share_ok: boolean;
  readonly outcome_diff_claim_allowed: boolean;
  readonly unmet_gates: readonly string[];
}

export function evaluateLearnedSegmentGates(params: {
  readonly kind: 'centroid_ml' | 'density_ml';
  readonly totalSessions: number;
  readonly clusters: readonly LearnedClusterResult[];
  readonly bootstrapAri: number;
  readonly centroidReferenceAri?: number;
  readonly noiseShare?: number;
  /** True ONLY when outcome difference replicated in an independent second time period (§8.6). */
  readonly outcomeDifferenceReplicatedInSecondPeriod: boolean;
}): SegmentQualityGateResult {
  const unmet: string[] = [];
  const minSize = Math.max(
    MIN_SEGMENT_ABSOLUTE_SESSIONS,
    Math.ceil(params.totalSessions * MIN_SEGMENT_SHARE)
  );

  if (params.bootstrapAri < MIN_SEGMENT_BOOTSTRAP_ARI) {
    unmet.push(`ml.segment_ari_ge_075 (have ${params.bootstrapAri})`);
  }

  const undersized = params.clusters
    .filter((c) => c.size < minSize)
    .map((c) => c.cluster_idx);
  if (undersized.length > 0 || params.clusters.length === 0) {
    unmet.push(`ml.segment_min_size_${minSize}`);
  }

  let noiseOk = true;
  if (params.kind === 'density_ml') {
    const ns = params.noiseShare ?? 0;
    if (ns > MAX_DENSITY_NOISE_SHARE) {
      noiseOk = false;
      unmet.push(`ml.segment_density_noise_le_20pct (have ${ns})`);
    }
    if (
      params.centroidReferenceAri !== undefined &&
      params.bootstrapAri < params.centroidReferenceAri
    ) {
      unmet.push('ml.segment_density_ari_ge_centroid');
    }
  }

  return {
    passed: unmet.length === 0,
    bootstrap_ari: params.bootstrapAri,
    min_cluster_size_required: minSize,
    undersized_clusters: undersized,
    noise_share_ok: noiseOk,
    outcome_diff_claim_allowed: unmet.length === 0 && params.outcomeDifferenceReplicatedInSecondPeriod,
    unmet_gates: unmet,
  };
}

/**
 * Registers learned challenger segments directly into BOTH Wave 4-A `SegmentRegistry`
 * AND Bundle 4-F `MlModelRegistry` (as `challenger`), preserving inherited lineage IDs
 * and optional 4-G LLM semantic cluster names/descriptions.
 */
export function registerLearnedSegmentsAsChallengers(params: {
  readonly segmentRegistry: SegmentRegistry;
  readonly mlRegistry: MlModelRegistry;
  readonly tenantId: string;
  readonly siteId: string;
  readonly kind: 'centroid_ml' | 'density_ml';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly featureNames: readonly string[];
  readonly clusters: readonly LearnedClusterResult[];
  readonly lineage: readonly SegmentLineageMatch[];
  readonly llmClusterNames?: Readonly<Record<number, { readonly name: string; readonly description: string }>>;
  readonly createdByPrincipalId: string;
  readonly nowIso: string;
}): readonly RegisteredSegment[] {
  assertNoOutcomeFeaturesInSegment(params.featureNames);

  params.mlRegistry.registerModelVersion({
    model_version_id: `${params.modelId}@${params.modelVersion}`,
    model_family: `segment_${params.kind}`,
    tenant_scope: params.tenantId,
    artifact_sha256: sha256Hex(`${params.modelId}:${params.modelVersion}:${params.featureNames.join(',')}`),
    abi_version: 1,
    feature_set_version: 'seg_behaviour_v1',
    label_contract_version: 'unsupervised_v1',
    dataset_id: `seg_ds_${params.siteId}`,
    deletion_generation: params.mlRegistry.getDeletionGeneration(),
    code_version: 'wave6_6a_seg_v1',
    runtime_env: 'server_ts',
    seed: 2026,
    license_bundle: {
      license_id: 'Proprietary-UGOKI-LINK',
      notice_text: 'UGOKI LINK v2 learned segment challenger',
      distribution_scope: 'server_only',
    },
    created_at_iso: params.nowIso,
    status: 'challenger',
    contributing_subject_ids: [],
  });

  const registered: RegisteredSegment[] = [];
  for (let i = 0; i < params.clusters.length; i++) {
    const cluster = params.clusters[i];
    const lin = params.lineage[i];
    const llmMeta = params.llmClusterNames?.[cluster.cluster_idx];
    const descriptor: MlSegmentDescriptor = {
      modelId: params.modelId,
      modelVersion: params.modelVersion,
      featureNames: [...params.featureNames],
      centroidVector: [...cluster.centroid],
      ...(params.kind === 'centroid_ml'
        ? { maxDistance: cluster.max_distance }
        : { densityThreshold: cluster.density_threshold }),
      ...(lin.inherited_from_segment_id
        ? { inheritedSegmentId: lin.inherited_from_segment_id }
        : {}),
    };

    const seg = params.segmentRegistry.register({
      tenantId: params.tenantId,
      siteId: params.siteId,
      segmentId: lin.assigned_segment_id,
      name: llmMeta?.name ?? `${params.kind}_cluster_${cluster.cluster_idx}`,
      description:
        llmMeta?.description ??
        `Challenger ${params.kind} segment (size=${cluster.size}, jaccard=${lin.jaccard_overlap})`,
      kind: params.kind,
      mlDescriptor: descriptor,
      createdByPrincipalId: params.createdByPrincipalId,
      now: new Date(params.nowIso),
    });
    registered.push(seg);
  }
  return registered;
}
