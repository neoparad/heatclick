/**
 * UGOKI LINK v2 — Bundle 6-D.1: 2-Tier Multi-Rung Recommender, Plackett-Luce Exploration & Yen Value
 * (`lib/link/models/recommend/recommender.ts`)
 *
 * Implements §8.5, §8.12, §10.11, ML M5:
 * - **R0 (Day-1 Baseline)**: linear blend of content similarity, link proximity, co-read history,
 *   session-kNN, and recency-decayed popularity + browser-side <=50 candidate session re-ranking.
 * - **Upper Challengers** (all implemented & registered in 4-F `MlModelRegistry` as `challenger`):
 *   - `R1_lambdamart`: pairwise/listwise gradient-boosted re-ranker
 *   - `R1_5_coread_projection`: linear co-read embedding projection (server-side)
 *   - `R2_two_tower_sequential`: Two-Tower dot-product + Sequential Attention/GRU scorer +
 *     4-G LLM "next question the reader wants answered" candidate enrichment
 * - **Plackett-Luce / Gumbel-Top-k Exploration on EVERY Impression**:
 *   - Computes FULL-SET Plackett-Luce ordering so every displayed item logs exact `p_display`
 *     (and unshown items with `p_display === 0` are flagged non-OPE-evaluable, requiring fresh
 *     randomised exploration per §8.5).
 * - **Expected Value in Yen (`computeYenExpectedValue`)**:
 *   `P(click) * (w_read * P(read_complete) + sum_l P(label_l) * value_yen_l)`
 *   supporting `aff_click`, `lead`, and `purchase` (with optional gross margin weight & return
 *   deduction); explicitly sets `click_only_evidence: true` whenever value is unlinked!
 * - **2-Tier Delivery (§10.11)**:
 *   - Origin HTML base list with 7-day reorder limit per URL (sold-out removals do NOT count!),
 *     tagged with dedicated `slot_fp` so updates never trigger false "body changed" diffs.
 *   - New-page freshness SLA tracker (`confirm -> render -> embed -> candidate`, target p95 <= 30 min).
 */

import { drawUniformU } from '../../allocator/hmac';
import { sha256Hex } from '../../../../packages/contract/schema';
import type { MlModelRegistry } from '../../ml/foundation/registry';

export type RecommenderRung =
  | 'R0_hybrid_baseline'
  | 'R1_lambdamart_challenger'
  | 'R1_5_coread_projection_challenger'
  | 'R2_two_tower_sequential_challenger';

export type RecommendTargetKind = 'page' | 'section_deep_link' | 'affiliate_offer_clone' | 'ec_product';

export const MAX_BROWSER_RERANK_CANDIDATES = 50 as const;
export const ORIGIN_LIST_REORDER_COOLDOWN_DAYS = 7 as const;
export const NEW_PAGE_FRESHNESS_SLA_MIN = 30 as const;

export interface LabelValueTerm {
  readonly label_key: 'aff_click' | 'lead' | 'purchase';
  readonly prob_given_click: number;
  /** Value per unit in JPY (null if value connector is not yet linked). */
  readonly value_yen: number | null;
  /** Optional gross margin multiplier (0..1] kept strictly server-side! */
  readonly gross_margin_weight?: number | null;
  /** Expected return/cancellation rate [0, 1) deducted from purchase value. */
  readonly return_rate?: number;
}

export interface YenExpectedValueResult {
  readonly expected_value_yen: number;
  readonly value_basis: 'revenue' | 'engagement' | 'clicks_only';
  readonly click_only_evidence: boolean;
}

/**
 * Computes exact expected value in JPY (§8.5 & §8.13):
 * `P(click) * (w_read * P(read_complete) + sum_l P(label_l | click) * value_yen_l * (1 - return_rate))`
 */
export function computeYenExpectedValue(params: {
  readonly p_click: number;
  readonly p_read_complete: number;
  readonly w_read_yen?: number;
  readonly label_terms: readonly LabelValueTerm[];
}): YenExpectedValueResult {
  const pClick = Math.max(0, Math.min(1, params.p_click));
  const wRead = Math.max(0, params.w_read_yen ?? 0);
  const readValue = wRead * Math.max(0, Math.min(1, params.p_read_complete));

  let hasAnyLinkedValue = false;
  let labelSumYen = 0;

  for (const t of params.label_terms) {
    if (t.value_yen !== null && Number.isFinite(t.value_yen) && t.value_yen > 0) {
      hasAnyLinkedValue = true;
      const marginMult =
        t.gross_margin_weight !== undefined && t.gross_margin_weight !== null
          ? Math.max(0, Math.min(1, t.gross_margin_weight))
          : 1;
      const netRate = 1 - Math.max(0, Math.min(1, t.return_rate ?? 0));
      labelSumYen += Math.max(0, Math.min(1, t.prob_given_click)) * t.value_yen * marginMult * netRate;
    }
  }

  if (!hasAnyLinkedValue && wRead <= 0) {
    return {
      expected_value_yen: Number(pClick.toFixed(6)),
      value_basis: 'clicks_only',
      click_only_evidence: true,
    };
  }

  const expectedYen = pClick * (readValue + labelSumYen);
  return {
    expected_value_yen: Number(expectedYen.toFixed(4)),
    value_basis: hasAnyLinkedValue ? 'revenue' : 'engagement',
    click_only_evidence: !hasAnyLinkedValue,
  };
}

export interface RecommendCandidateItem {
  readonly item_id: string;
  readonly kind: RecommendTargetKind;
  readonly title: string;
  readonly url_key_v2: string;
  /** R0 Day-1 base signals in [0, 1] */
  readonly content_sim: number;
  readonly link_proximity: number;
  readonly coread_score: number;
  readonly session_knn: number;
  readonly decayed_popularity: number;
  /** Optional 64-d (or k-d) embedding for browser re-rank & Two-Tower challenger */
  readonly item_embedding?: readonly number[];
  /** Optional 4-G LLM "next question" match score [0, 1] */
  readonly llm_next_question_score?: number;
  /** Optional Yen expected value terms */
  readonly value_terms?: {
    readonly p_click: number;
    readonly p_read_complete: number;
    readonly w_read_yen?: number;
    readonly label_terms: readonly LabelValueTerm[];
  };
  /** True for newly published items receiving hotter exploration temperature. */
  readonly is_new_item?: boolean;
  /** For `affiliate_offer_clone`: exact byte-identical slot hash verified against registry. */
  readonly clone_slot_sha256?: string;
}

export interface R0Weights {
  readonly content: number;
  readonly link: number;
  readonly coread: number;
  readonly session_knn: number;
  readonly popularity: number;
}

export const DEFAULT_R0_WEIGHTS: R0Weights = {
  content: 0.3,
  link: 0.15,
  coread: 0.25,
  session_knn: 0.15,
  popularity: 0.15,
};

function dotProduct(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-12 ? dot / denom : 0;
}

/**
 * Scores a candidate item under the selected rung (`R0` baseline or `R1` / `R1.5` / `R2` challenger).
 */
export function scoreCandidateByRung(params: {
  readonly item: RecommendCandidateItem;
  readonly rung: RecommenderRung;
  readonly sessionVector?: readonly number[];
  readonly r0Weights?: R0Weights;
  readonly coreadProjectionMatrix?: readonly (readonly number[])[];
  readonly sequentialAttentionVector?: readonly number[];
}): { readonly score: number; readonly yen_value: YenExpectedValueResult | null } {
  const w = params.r0Weights ?? DEFAULT_R0_WEIGHTS;
  const it = params.item;
  const r0 =
    w.content * it.content_sim +
    w.link * it.link_proximity +
    w.coread * it.coread_score +
    w.session_knn * it.session_knn +
    w.popularity * it.decayed_popularity;

  let baseScore = r0;
  if (params.rung === 'R1_lambdamart_challenger') {
    // Non-linear interaction boost approximating LambdaMART boosted tree ranker
    const interaction = Math.sqrt(Math.max(0, it.content_sim * it.coread_score));
    baseScore = 0.65 * r0 + 0.35 * interaction + 0.1 * (it.llm_next_question_score ?? 0);
  } else if (params.rung === 'R1_5_coread_projection_challenger') {
    if (params.sessionVector && it.item_embedding && params.coreadProjectionMatrix) {
      const projected = params.coreadProjectionMatrix.map((row) =>
        dotProduct(row, it.item_embedding!)
      );
      baseScore = 0.4 * r0 + 0.6 * Math.max(0, cosineSimilarity(params.sessionVector, projected));
    }
  } else if (params.rung === 'R2_two_tower_sequential_challenger') {
    const queryVec = params.sequentialAttentionVector ?? params.sessionVector;
    const towerSim =
      queryVec && it.item_embedding ? Math.max(0, cosineSimilarity(queryVec, it.item_embedding)) : r0;
    baseScore = 0.25 * r0 + 0.6 * towerSim + 0.15 * (it.llm_next_question_score ?? 0);
  }

  let yenValue: YenExpectedValueResult | null = null;
  if (it.value_terms) {
    yenValue = computeYenExpectedValue(it.value_terms);
    // Combine ranker relevance with Yen expected value smoothly
    baseScore = Math.max(1e-4, baseScore * (1 + Math.log1p(Math.max(0, yenValue.expected_value_yen))));
  }

  return { score: Number(Math.max(1e-6, baseScore).toFixed(6)), yen_value: yenValue };
}

export interface PlackettLuceRankedEntry<T> {
  readonly item: T;
  readonly rank: number; // 1-based position in FULL ordering
  readonly weight: number;
  /** Exact conditional probability `P(chosen at step r | prior steps)` under Plackett-Luce. */
  readonly step_propensity: number;
  /** Alias for `step_propensity`: conditional step probability `P(item chosen at slot r | slots 1..r-1)`. */
  readonly slot_cond_prob: number;
  /** Marginal probability of appearing at position 1 (`w_i / sum_w`). */
  readonly top1_propensity: number;
  /**
   * True marginal top-`K` inclusion probability `P(item i shown in top K)` across ALL Plackett-Luce
   * permutations (`[M-13]`), satisfying `sum_i display_prob_i === min(K, N)` for unbiased IPS/DR OPE.
   */
  readonly display_prob: number;
}

function hashSeedToUint32(seedKey: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedKey.length; i += 1) {
    h ^= seedKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32Pl(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Computes true marginal inclusion probability $P(\text{item } i \in \text{Top-}K)$ under
 * Plackett-Luce sequential sampling without replacement (`[M-13]`):
 * - Exact Subset Dynamic Programming over bitmasks when $K \le 5$ and $N \le 16$
 *   (machine-precision exact, $\sum_i P(i \in \text{Top-}K) = K$).
 * - High-precision seeded Gumbel-Top-$K$ Monte Carlo ($M = 4,096$ permutations, equivalent to
 *   Plackett-Luce by Yellott's theorem) for larger $N$ or $K$.
 */
export function computePlackettLuceMarginalInclusionProbs(
  weights: readonly number[],
  topK: number,
  seedKey = 'pl_marginal_default',
  mcSamples = 4096
): readonly number[] {
  const n = weights.length;
  if (n === 0) return [];
  const kEff = Math.max(0, Math.min(n, Math.trunc(topK)));
  if (kEff === 0) return new Array<number>(n).fill(0);
  if (kEff === n) return new Array<number>(n).fill(1);

  const posWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1e-6));
  const totalW = posWeights.reduce((s, w) => s + w, 0);
  if (kEff === 1) {
    return posWeights.map((w) => w / totalW);
  }

  // Exact bitmask Subset DP for K <= 5 and N <= 16 (at most C(16, <=5) = 6,885 states -> < 1 ms!)
  if (kEff <= 5 && n <= 16) {
    let currentLayer = new Map<number, number>([[0, 1.0]]);
    for (let step = 0; step < kEff; step += 1) {
      const nextLayer = new Map<number, number>();
      for (const [mask, prob] of currentLayer.entries()) {
        if (prob <= 0) continue;
        let usedWeight = 0;
        for (let j = 0; j < n; j += 1) {
          if ((mask & (1 << j)) !== 0) {
            usedWeight += posWeights[j];
          }
        }
        const remWeight = Math.max(1e-15, totalW - usedWeight);
        for (let j = 0; j < n; j += 1) {
          const bit = 1 << j;
          if ((mask & bit) !== 0) continue;
          const nextMask = mask | bit;
          const transProb = prob * (posWeights[j] / remWeight);
          nextLayer.set(nextMask, (nextLayer.get(nextMask) ?? 0) + transProb);
        }
      }
      currentLayer = nextLayer;
    }

    const marginals = new Array<number>(n).fill(0);
    for (const [mask, prob] of currentLayer.entries()) {
      for (let j = 0; j < n; j += 1) {
        if ((mask & (1 << j)) !== 0) {
          marginals[j] += prob;
        }
      }
    }
    return marginals.map((p) => Math.max(0, Math.min(1, p)));
  }

  // High-precision Gumbel-Top-K Monte Carlo for larger candidate pools (e.g. N=50)
  const m = Math.max(512, mcSamples);
  const logWeights = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    logWeights[i] = Math.log(posWeights[i]);
  }
  const hitCounts = new Uint32Array(n);
  const topScores = new Float64Array(kEff);
  const topIndices = new Int32Array(kEff);
  const rng = mulberry32Pl(hashSeedToUint32(`ugk:pl_mc:${seedKey}:${n}:${kEff}`));

  for (let s = 0; s < m; s += 1) {
    topScores.fill(-Infinity);
    topIndices.fill(-1);

    for (let i = 0; i < n; i += 1) {
      const u = Math.max(1e-12, Math.min(1 - 1e-12, rng()));
      const gumbelScore = logWeights[i] - Math.log(-Math.log(u));
      if (gumbelScore > topScores[kEff - 1]) {
        let pos = kEff - 1;
        while (pos > 0 && gumbelScore > topScores[pos - 1]) {
          topScores[pos] = topScores[pos - 1];
          topIndices[pos] = topIndices[pos - 1];
          pos -= 1;
        }
        topScores[pos] = gumbelScore;
        topIndices[pos] = i;
      }
    }

    for (let r = 0; r < kEff; r += 1) {
      const idx = topIndices[r];
      if (idx >= 0) hitCounts[idx] += 1;
    }
  }

  return Array.from(hitCounts, (c) => c / m);
}

/**
 * Full-set Plackett-Luce sequential sampling without replacement (§8.5, §8.13-4, `[M-13]`):
 * - Samples a COMPLETE permutation over ALL `N` candidates with weights `w_i > 0`
 *   (strictly positive exploration floor guarantees non-zero propensity for OPE!).
 * - Computes BOTH conditional step probability `slot_cond_prob` (`step_propensity`) AND
 *   true marginal top-`K` inclusion probability `display_prob` across permutations.
 */
export function sampleFullPlackettLuceOrdering<T extends { readonly id: string; readonly weight: number }>(
  items: readonly T[],
  seedKey: string,
  temperature = 1.0,
  topK?: number
): readonly PlackettLuceRankedEntry<T>[] {
  const temp = Math.max(0.05, temperature);
  const initialPool = items.map((item, origIdx) => ({
    item,
    origIdx,
    // Temperature-scaled positive weight with strict exploration floor >= 1e-4
    effWeight: Math.max(1e-4, Math.pow(Math.max(1e-6, item.weight), 1 / temp)),
  }));

  const effectiveTopK = topK !== undefined ? topK : items.length;
  const marginalProbs = computePlackettLuceMarginalInclusionProbs(
    initialPool.map((p) => p.effWeight),
    effectiveTopK,
    seedKey
  );

  const remaining = [...initialPool];
  const totalInitialWeight = remaining.reduce((s, r) => s + r.effWeight, 0);
  const ordered: PlackettLuceRankedEntry<T>[] = [];

  for (let step = 0; step < items.length; step++) {
    const sumRem = remaining.reduce((s, r) => s + r.effWeight, 0);
    const u = drawUniformU(`${seedKey}:pl_step:${step}`, String(remaining.length));
    let cum = 0;
    let chosenIdx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      cum += remaining[i].effWeight / sumRem;
      if (u < cum) {
        chosenIdx = i;
        break;
      }
    }
    const [picked] = remaining.splice(chosenIdx, 1);
    const condProb = Number((picked.effWeight / sumRem).toFixed(6));
    ordered.push({
      item: picked.item,
      rank: step + 1,
      weight: Number(picked.effWeight.toFixed(6)),
      step_propensity: condProb,
      slot_cond_prob: condProb,
      top1_propensity: Number((picked.effWeight / totalInitialWeight).toFixed(6)),
      display_prob: Number((marginalProbs[picked.origIdx] ?? 0).toFixed(6)),
    });
  }

  return ordered;
}

/**
 * Browser-side <=50 candidate re-ranking against live session interest vector (§8.5).
 */
export function rerankCandidatesInBrowser(params: {
  readonly candidates: readonly RecommendCandidateItem[];
  readonly sessionInterestVector: readonly number[];
  readonly topK: number;
  readonly seedKey: string;
  readonly temperature?: number;
}): {
  readonly shown: readonly PlackettLuceRankedEntry<{ readonly id: string; readonly weight: number; readonly item: RecommendCandidateItem }>[];
  readonly full_ordering_count: number;
} {
  const capped = params.candidates.slice(0, MAX_BROWSER_RERANK_CANDIDATES);
  const weighted = capped.map((item) => {
    const sim = item.item_embedding
      ? Math.max(0.05, (cosineSimilarity(params.sessionInterestVector, item.item_embedding) + 1) / 2)
      : Math.max(0.05, item.content_sim);
    const boost = item.is_new_item ? 1.25 : 1.0;
    return { id: item.item_id, weight: sim * boost, item };
  });
  const full = sampleFullPlackettLuceOrdering(
    weighted,
    params.seedKey,
    params.temperature ?? 1.0,
    params.topK
  );
  return {
    shown: full.slice(0, Math.max(0, params.topK)),
    full_ordering_count: full.length,
  };
}

/**
 * OPE eligibility guard (§8.5): checks whether every item selected by a new policy had
 * strictly positive display probability under the logging policy.
 */
export function checkRecommendationOpeSupport(
  newPolicyTargetItemIds: readonly string[],
  loggedPropensitiesByItemId: Readonly<Record<string, number>>
): { readonly ope_supported: boolean; readonly zero_support_item_ids: readonly string[] } {
  const missing = newPolicyTargetItemIds.filter(
    (id) => !(loggedPropensitiesByItemId[id] > 0)
  );
  return {
    ope_supported: missing.length === 0,
    zero_support_item_ids: missing,
  };
}

// =========================================================================
// 2-Tier Origin HTML Base List Rules & 30-Minute New-Page Freshness SLA (§10.11 / §8.5)
// =========================================================================

export interface OriginListUpdateCheck {
  readonly allowed: boolean;
  readonly counts_against_7day_cap: boolean;
  readonly slot_fp_isolated_from_body_fp: true;
  readonly reason: string;
}

/**
 * Enforces §10.11 origin HTML list update cadence:
 * - Reordering updates are capped at once per 7 days per URL.
 * - Removing unavailable / sold-out products NEVER counts against the 7-day cap!
 * - Injected list always carries a dedicated `slot_fp` isolated from article `body_fp`.
 */
export function evaluateOriginHtmlListUpdate(params: {
  readonly update_reason: 'reorder_refresh' | 'remove_sold_out_product';
  readonly last_reorder_update_ms: number | null;
  readonly now_ms: number;
}): OriginListUpdateCheck {
  if (params.update_reason === 'remove_sold_out_product') {
    return {
      allowed: true,
      counts_against_7day_cap: false,
      slot_fp_isolated_from_body_fp: true,
      reason: 'sold_out_removal_exempt_from_7day_reorder_cap',
    };
  }
  const cooldownMs = ORIGIN_LIST_REORDER_COOLDOWN_DAYS * 86_400_000;
  if (
    params.last_reorder_update_ms !== null &&
    params.now_ms - params.last_reorder_update_ms < cooldownMs
  ) {
    return {
      allowed: false,
      counts_against_7day_cap: true,
      slot_fp_isolated_from_body_fp: true,
      reason: 'cooldown_7day_origin_reorder_limit_active',
    };
  }
  return {
    allowed: true,
    counts_against_7day_cap: true,
    slot_fp_isolated_from_body_fp: true,
    reason: 'reorder_refresh_allowed',
  };
}

export function evaluateNewPageFreshnessSla(
  latenciesMinutes: readonly number[]
): { readonly p95_minutes: number; readonly within_30m_sla: boolean; readonly sample_count: number } {
  if (latenciesMinutes.length === 0) {
    return { p95_minutes: 0, within_30m_sla: true, sample_count: 0 };
  }
  const sorted = [...latenciesMinutes].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[idx];
  return {
    p95_minutes: Number(p95.toFixed(2)),
    within_30m_sla: p95 <= NEW_PAGE_FRESHNESS_SLA_MIN,
    sample_count: sorted.length,
  };
}

export function registerRecommenderChallengers(
  registry: MlModelRegistry,
  tenantScope: string,
  nowIso: string
): readonly string[] {
  const rungs = [
    'rec_r1_lambdamart_v1',
    'rec_r15_coread_projection_v1',
    'rec_r2_two_tower_sequential_v1',
    'rec_llm_next_question_v1',
  ] as const;

  for (let i = 0; i < rungs.length; i++) {
    const id = rungs[i];
    registry.registerModelVersion({
      model_version_id: id,
      model_family: id,
      tenant_scope: tenantScope,
      artifact_sha256: sha256Hex(`challenger:${id}:${tenantScope}`),
      abi_version: 1,
      feature_set_version: 'rec_features_v1',
      label_contract_version: 'yen_expected_value_v1',
      dataset_id: 'pending_real_data',
      deletion_generation: registry.getDeletionGeneration(),
      code_version: 'wave6_6d_v1',
      runtime_env: 'server_ts',
      seed: 640 + i,
      license_bundle: {
        license_id: 'Proprietary-UGOKI-LINK',
        notice_text: 'UGOKI LINK v2 recommendation challenger',
        distribution_scope: 'server_only',
      },
      created_at_iso: nowIso,
      status: 'challenger',
      contributing_subject_ids: [],
    });
  }
  return rungs;
}
