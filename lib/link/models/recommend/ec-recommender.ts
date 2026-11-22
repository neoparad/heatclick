/**
 * UGOKI LINK v2 — Bundle 6-D.2: E-Commerce Recommender (§8.13 Sections 3, 4, 5, 6)
 * (`lib/link/models/recommend/ec-recommender.ts`)
 *
 * Implements §8.13 (3–6) connected directly to Wave 4-D `EcCatalogService` & `EcMemberSummaryStore`:
 * 1. **Pre-Draw Exclusions + FULL-SET Plackett-Luce Probability Preservation (§8.13-3 & 4)**:
 *    - Order: Full candidate pool -> Pre-draw exclusion rules (cart + color/size sibling SKUs,
 *      recently purchased durables & substitutes, freshly purchased consumables, sold-out,
 *      stale feed/heartbeat, sensitive category) recording `exclusion_rule_ver` & per-item reasons
 *      -> FULL-SET Plackett-Luce permutation over ALL surviving items!
 *    - Last-second sold-out drops take the first `K` available items from the FULL permutation
 *      (or re-draw on the surviving set), mathematically eliminating the §8.13-4 `7/18 vs 1/3`
 *      truncated-spare bias!
 * 2. **Directed Co-Purchase & Substitute / Complement / Unknown Classifier (§8.13-5)**:
 *    - Directional lift (`A -> B` != `B -> A`), product -> category hierarchical shrinkage,
 *      denominator strictly "opportunities where BOTH products were available".
 *    - Never marks an item as a substitute merely from sparse 0 co-purchases (e.g. 5% rate over
 *      10 trials has ~60% zero-hit chance -> stays `'unknown'`!).
 *    - Cart placement boosts `'complement'` and suppresses verified `'substitute'`.
 * 3. **Censored + Return-Aware Repurchase Hazard Model (§8.13-5)**:
 *    - Includes non-repurchasers, right-censored histories (window end / churn / retention),
 *      and returns/cancellations; falls back to catalog `repurchase_cycle_days` when sparse.
 *    - Durability inference when feed says `'unknown'` is explicitly tagged `evidence_level: 'inferred'`.
 * 4. **Logged-in Member Join & Zero-Leakage Browser Projection (§8.13-6)**:
 *    - Primary path: EC server direct call (`POST /v1/recommend`) with verified `member_key`.
 *    - Browser path: REQUIRES EC-server-signed proof token bound to `(member_key, session_id,
 *      purpose='recommend', expires_at)` — rejects bare member hashes (`MemberProofRequiredError`)!
 *    - Strictly enforces dual consent (`member_link` AND `personalisation`) + `EcMemberSummaryStore`
 *      `suppression_epoch`; missing either consent falls back to anonymous (cart exclusion needs NO consent!).
 *    - NEVER returns gross margin, member purchase history, score boost deltas, or exclusion reasons
 *      in the browser-facing DTO (`assertNoEcConfidentialLeak`)!
 * 5. **EC Guardrails**: monitors cart abandonment rate, AOV, and return rate!
 */

import { hmacSha256Hex } from '../../allocator/hmac';
import {
  assertNoGrossMarginLeak,
  type ProductDurabilityKind,
} from '../../revenue/ec-catalog';
import type { EcMemberSummary, EcMemberSummaryStore } from '../../revenue/ec-member-store';
import {
  computePlackettLuceMarginalInclusionProbs,
  sampleFullPlackettLuceOrdering,
} from './recommender';

export type EcPlacement = 'product_page' | 'cart' | 'home' | 'post_purchase' | 'article';

export type EcExclusionReason =
  | 'in_cart_or_sibling_variant'
  | 'recent_durable_or_substitute'
  | 'freshly_purchased_consumable'
  | 'sold_out_unavailable'
  | 'stale_inventory_state'
  | 'sensitive_category';

export interface EcCandidateProduct {
  readonly product_id: string;
  readonly parent_family_id: string; // groups color/size siblings
  readonly title: string;
  readonly product_url_key_v2: string;
  readonly image_url: string | null;
  readonly available: boolean;
  readonly stale: boolean;
  readonly hide_price: boolean;
  readonly price: number | null;
  readonly currency: string | null;
  readonly category: string;
  readonly brand: string | null;
  readonly durability: ProductDurabilityKind;
  readonly repurchase_cycle_days: number | null;
  readonly sensitive_category: boolean;
  /** Server-only confidential margin in (0, 1] — NEVER returned to browser! */
  readonly server_only_gross_margin?: number | null;
  /** Base relevance / expected-value weight before Plackett-Luce ordering. */
  readonly base_score_weight: number;
  readonly expected_return_rate?: number;
  readonly substitute_of_product_ids?: readonly string[];
  readonly complement_of_product_ids?: readonly string[];
}

export interface EcMemberProofToken {
  readonly tenant_id: string;
  readonly site_id: string;
  readonly member_key: string;
  readonly session_id: string;
  readonly purpose: 'recommend';
  readonly expires_at_ms: number;
  readonly signature_hex: string;
}

export function signEcMemberProofToken(
  payload: Omit<EcMemberProofToken, 'signature_hex'>,
  ecServerSharedSecret: string
): EcMemberProofToken {
  const msg = `ec_member_proof/1|${payload.tenant_id}|${payload.site_id}|${payload.member_key}|${payload.session_id}|${payload.purpose}|${payload.expires_at_ms}`;
  return {
    ...payload,
    signature_hex: hmacSha256Hex(ecServerSharedSecret, msg).slice(0, 32),
  };
}

export function verifyEcMemberProofToken(
  token: EcMemberProofToken | null | undefined,
  expected: { readonly tenant_id: string; readonly site_id: string; readonly session_id: string },
  ecServerSharedSecret: string,
  nowMs: number
): boolean {
  if (!token) return false;
  if (
    token.tenant_id !== expected.tenant_id ||
    token.site_id !== expected.site_id ||
    token.session_id !== expected.session_id ||
    token.purpose !== 'recommend' ||
    nowMs > token.expires_at_ms
  ) {
    return false;
  }
  const recomputed = signEcMemberProofToken(
    {
      tenant_id: token.tenant_id,
      site_id: token.site_id,
      member_key: token.member_key,
      session_id: token.session_id,
      purpose: token.purpose,
      expires_at_ms: token.expires_at_ms,
    },
    ecServerSharedSecret
  );
  return token.signature_hex === recomputed.signature_hex;
}

export class MemberProofRequiredError extends Error {
  constructor() {
    super(
      '§8.13-6 Security Violation: Browser recommendation requests cannot pass a raw member_key/hash without an EC-server-signed session/purpose/expiry proof token.'
    );
    this.name = 'MemberProofRequiredError';
  }
}

const FORBIDDEN_BROWSER_EC_KEYS = new Set([
  'gross_margin',
  'server_only_gross_margin',
  'margin_rate',
  'cost_price',
  'score_delta',
  'member_boost',
  'exclusion_reasons',
  'excluded_items',
  'recent_purchased_product_ids',
  'category_affinity',
  'member_summary',
]);

/**
 * Hard runtime firewall enforcing §8.13-1 & §8.13-6: browser recommendation responses
 * contain ONLY final public product items — ZERO gross margin, member history, boost deltas,
 * or per-item exclusion reasons!
 */
export function assertNoEcConfidentialLeak(browserResponsePayload: unknown): void {
  assertNoGrossMarginLeak(browserResponsePayload);
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_BROWSER_EC_KEYS.has(k.toLowerCase())) {
        throw new Error(
          `§8.13-6 Confidential EC field "${k}" leaked into browser response at ${path}.${k}`
        );
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(browserResponsePayload, '$');
}

export interface EcBrowserSafeRecommendedItem {
  readonly product_id: string;
  readonly title: string;
  readonly product_url_key_v2: string;
  readonly image_url: string | null;
  readonly hide_price: boolean;
  readonly price: number | null;
  readonly currency: string | null;
  readonly category: string;
  readonly brand: string | null;
  readonly rank: number;
}

export interface EcServerDecisionLog {
  readonly exclusion_rule_ver: string;
  readonly candidate_pool_ids: readonly string[];
  readonly excluded_by_item: Readonly<Record<string, readonly EcExclusionReason[]>>;
  readonly surviving_ids: readonly string[];
  readonly full_plackett_luce_ordering_ids: readonly string[];
  readonly last_second_dropped_ids: readonly string[];
  readonly displayed_items: readonly {
    readonly product_id: string;
    readonly position: number;
    readonly conditional_display_prob: number;
    readonly slot_cond_prob: number;
    readonly display_prob: number;
  }[];
  readonly marginal_display_probs_by_item: Readonly<Record<string, number>>;
  readonly member_history_joined: boolean;
  readonly member_fallback_reason: string | null;
}

export interface EcRecommendOutput {
  /** Safe DTO for browser / public rendering (0 confidential fields!). */
  readonly browser_items: readonly EcBrowserSafeRecommendedItem[];
  /** Server-side audit & OPE decision log (NEVER sent to browser!). */
  readonly server_decision_log: EcServerDecisionLog;
}

/**
 * Full §8.13-3, 4, 6 E-Commerce Recommendation Engine:
 * 1. Resolves optional logged-in member summary (EC server direct OR verified proof token +
 *    dual consent `member_link` & `personalisation` + `suppression_epoch` + deadline fallback).
 * 2. Applies pre-draw exclusions (cart + siblings, durables + substitutes, fresh consumables,
 *    sold-out, stale, sensitive) BEFORE sampling.
 * 3. Runs FULL-SET Plackett-Luce permutation over ALL surviving candidates (server-side gross
 *    margin & category affinity stay strictly inside server weights!).
 * 4. Drops any `lastSecondSoldOutIds` from the FULL ordering so remaining probabilities match
 *    the exact conditional Plackett-Luce distribution over surviving products (zero 7/18 bias!).
 */
export function runEcRecommendation(params: {
  readonly tenant_id: string;
  readonly site_id: string;
  readonly placement: EcPlacement;
  readonly caller_channel: 'ec_server_direct' | 'browser';
  readonly candidates: readonly EcCandidateProduct[];
  readonly top_k: number;
  readonly cart_product_ids: readonly string[];
  readonly seed_key: string;
  readonly temperature?: number;
  readonly exclusion_rule_ver?: string;
  readonly now_iso: string;
  /** Optional last-second sold-out product IDs discovered right before display (§8.13-4). */
  readonly last_second_sold_out_ids?: readonly string[];
  /** Optional logged-in member context. */
  readonly member_store?: EcMemberSummaryStore;
  readonly direct_server_member_key?: string | null;
  readonly browser_member_proof?: EcMemberProofToken | null;
  readonly browser_session_id?: string;
  readonly ec_server_proof_secret?: string;
  /** Poison check: browser passing raw member_key without proof MUST throw! */
  readonly raw_browser_member_hash?: string | null;
  readonly consent_member_link?: boolean;
  readonly consent_personalisation?: boolean;
  /** Simulates member summary store exceeding initial context deadline -> falls back to session-only! */
  readonly member_lookup_timed_out?: boolean;
}): EcRecommendOutput {
  const nowMs = Date.parse(params.now_iso);
  const ruleVer = params.exclusion_rule_ver ?? 'ec_excl_v1';

  // 1. Resolve member summary securely (§8.13-6)
  let memberSummary: EcMemberSummary | null = null;
  let memberFallbackReason: string | null = null;

  if (params.caller_channel === 'browser' && params.raw_browser_member_hash && !params.browser_member_proof) {
    throw new MemberProofRequiredError();
  }

  let verifiedMemberKey: string | null = null;
  if (params.caller_channel === 'ec_server_direct') {
    verifiedMemberKey = params.direct_server_member_key ?? null;
  } else if (params.browser_member_proof) {
    const ok = verifyEcMemberProofToken(
      params.browser_member_proof,
      {
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        session_id: params.browser_session_id ?? '',
      },
      params.ec_server_proof_secret ?? '',
      nowMs
    );
    if (ok) {
      verifiedMemberKey = params.browser_member_proof.member_key;
    } else {
      memberFallbackReason = 'invalid_or_expired_member_proof';
    }
  }

  if (verifiedMemberKey && params.member_store) {
    if (params.member_lookup_timed_out) {
      memberFallbackReason = 'member_summary_deadline_exceeded_session_only';
    } else {
      const readRes = params.member_store.readSummaryForRecommendation({
        tenant_id: params.tenant_id,
        site_id: params.site_id,
        member_key: verifiedMemberKey,
        consent_member_link: params.consent_member_link === true,
        consent_personalisation: params.consent_personalisation === true,
        now_iso: params.now_iso,
      });
      memberSummary = readRes.summary;
      memberFallbackReason = readRes.fallback_reason;
    }
  }

  // 2. Pre-draw exclusions (§8.13-3 & 4) — cart exclusion works WITHOUT personalisation consent!
  const cartIdSet = new Set(params.cart_product_ids);
  const cartFamilies = new Set<string>();
  for (const c of params.candidates) {
    if (cartIdSet.has(c.product_id)) cartFamilies.add(c.parent_family_id);
  }

  const recentPurchasedSet = new Set(memberSummary?.recent_purchased_product_ids ?? []);
  const upcomingRepurchaseSet = new Set(memberSummary?.upcoming_repurchase_product_ids ?? []);
  const memberExcludedSet = new Set(memberSummary?.excluded_product_ids ?? []);

  const excludedByItem: Record<string, EcExclusionReason[]> = {};
  const surviving: EcCandidateProduct[] = [];

  for (const prod of params.candidates) {
    const reasons: EcExclusionReason[] = [];
    if (!prod.available) reasons.push('sold_out_unavailable');
    if (prod.stale) reasons.push('stale_inventory_state');
    if (prod.sensitive_category && (memberSummary !== null || params.placement !== 'product_page')) {
      // Sensitive categories are excluded from history-based and unsolicited cross-surface recommendations (§8.13-3)
      reasons.push('sensitive_category');
    }
    if (cartIdSet.has(prod.product_id) || cartFamilies.has(prod.parent_family_id)) {
      reasons.push('in_cart_or_sibling_variant');
    }
    if (memberSummary !== null) {
      const isRecent = recentPurchasedSet.has(prod.product_id) || memberExcludedSet.has(prod.product_id);
      const isSubOfRecent = (prod.substitute_of_product_ids ?? []).some((id) =>
        recentPurchasedSet.has(id)
      );
      if (prod.durability === 'durable' && (isRecent || isSubOfRecent)) {
        reasons.push('recent_durable_or_substitute');
      } else if (
        prod.durability === 'consumable' &&
        isRecent &&
        !upcomingRepurchaseSet.has(prod.product_id)
      ) {
        reasons.push('freshly_purchased_consumable');
      }
    }

    if (reasons.length > 0) {
      excludedByItem[prod.product_id] = reasons;
    } else {
      surviving.push(prod);
    }
  }

  // 3. Server-side weight calculation (incorporating confidential gross margin, cart complements,
  //    member category affinity & upcoming repurchase boost — NEVER exposed to browser!)
  const weightedSurvivors = surviving.map((prod) => {
    let w = Math.max(1e-4, prod.base_score_weight);
    // Gross margin & net-of-return value multiplier strictly server-side
    const marginMult =
      prod.server_only_gross_margin !== undefined && prod.server_only_gross_margin !== null
        ? Math.max(0.05, prod.server_only_gross_margin)
        : 1.0;
    const netReturnMult = 1 - Math.max(0, Math.min(0.95, prod.expected_return_rate ?? 0));
    w *= marginMult * netReturnMult;

    // Cart placement: boost verified complements, suppress verified substitutes (§8.13-5)
    if (params.placement === 'cart') {
      const isComp = (prod.complement_of_product_ids ?? []).some((id) => cartIdSet.has(id));
      const isSub = (prod.substitute_of_product_ids ?? []).some((id) => cartIdSet.has(id));
      if (isComp) w *= 1.8;
      if (isSub) w *= 0.15;
    }

    if (memberSummary) {
      const catAff = memberSummary.category_affinity[prod.category] ?? 0;
      w *= 1 + Math.max(0, Math.min(2, catAff));
      if (upcomingRepurchaseSet.has(prod.product_id)) {
        w *= 1.5;
      }
    }

    return { id: prod.product_id, weight: w, product: prod };
  });

  // 4. FULL-SET Plackett-Luce ordering over ALL surviving items (§8.13-4)
  const fullOrdering = sampleFullPlackettLuceOrdering(
    weightedSurvivors,
    params.seed_key,
    params.temperature ?? 1.0
  );

  // 5. Last-second sold-out filter applied to the FULL ordering -> preserves exact Plackett-Luce
  //    conditional probabilities over surviving products (zero 7/18 truncation bias!)
  const lastSecSet = new Set(params.last_second_sold_out_ids ?? []);
  const postDrop = fullOrdering.filter((entry) => !lastSecSet.has(entry.item.id));
  const shown = postDrop.slice(0, Math.max(0, params.top_k));

  // Compute BOTH conditional step probability `slot_cond_prob` AND true marginal top-K
  // inclusion probability `display_prob` on the post-drop surviving set ([M-13])
  const postDropMarginalProbs = computePlackettLuceMarginalInclusionProbs(
    postDrop.map((e) => e.weight),
    Math.max(0, params.top_k),
    params.seed_key
  );
  const marginalByItem: Record<string, number> = {};
  for (let i = 0; i < postDrop.length; i += 1) {
    marginalByItem[postDrop[i].item.id] = Number((postDropMarginalProbs[i] ?? 0).toFixed(6));
  }

  let remWeight = postDrop.reduce((s, e) => s + e.weight, 0);
  const displayedLog: Array<{
    readonly product_id: string;
    readonly position: number;
    readonly conditional_display_prob: number;
    readonly slot_cond_prob: number;
    readonly display_prob: number;
  }> = [];

  const browserItems: EcBrowserSafeRecommendedItem[] = [];
  for (let i = 0; i < shown.length; i++) {
    const entry = shown[i];
    const condProb = remWeight > 0 ? entry.weight / remWeight : 0;
    remWeight = Math.max(0, remWeight - entry.weight);
    const roundedCond = Number(condProb.toFixed(6));
    const roundedMarginal = Number((postDropMarginalProbs[i] ?? 0).toFixed(6));

    displayedLog.push({
      product_id: entry.item.id,
      position: i + 1,
      conditional_display_prob: roundedCond,
      slot_cond_prob: roundedCond,
      display_prob: roundedMarginal,
    });

    const p = entry.item.product;
    browserItems.push({
      product_id: p.product_id,
      title: p.title,
      product_url_key_v2: p.product_url_key_v2,
      image_url: p.image_url,
      hide_price: p.hide_price,
      price: p.hide_price ? null : p.price,
      currency: p.hide_price ? null : p.currency,
      category: p.category,
      brand: p.brand,
      rank: i + 1,
    });
  }

  // Runtime leak guard before returning browser payload!
  assertNoEcConfidentialLeak(browserItems);

  return {
    browser_items: browserItems,
    server_decision_log: {
      exclusion_rule_ver: ruleVer,
      candidate_pool_ids: params.candidates.map((c) => c.product_id),
      excluded_by_item: excludedByItem,
      surviving_ids: surviving.map((s) => s.product_id),
      full_plackett_luce_ordering_ids: fullOrdering.map((e) => e.item.id),
      last_second_dropped_ids: fullOrdering
        .filter((e) => lastSecSet.has(e.item.id))
        .map((e) => e.item.id),
      displayed_items: displayedLog,
      marginal_display_probs_by_item: marginalByItem,
      member_history_joined: memberSummary !== null,
      member_fallback_reason: memberFallbackReason,
    },
  };
}

// =========================================================================
// Directed Co-Purchase & Substitute / Complement / Unknown Classifier (§8.13-5)
// =========================================================================

export interface DirectedCoPurchaseInput {
  readonly source_product_id: string;
  readonly target_product_id: string;
  readonly source_category: string;
  readonly target_category: string;
  /** Denominator: opportunities where BOTH source & target were available/in-stock (§8.13-5). */
  readonly opportunities_both_available: number;
  /** Number of times target was bought given source was in cart/order (directional A -> B!). */
  readonly co_purchase_count_a_to_b: number;
  /** Baseline probability of buying target unconditionally when available. */
  readonly target_base_rate: number;
  /** Category-level shrinkage prior co-purchase rate `P(cat_B | cat_A)`. */
  readonly category_prior_rate: number;
  /** True if both products were frequently viewed together in the same session. */
  readonly high_co_view_rate: boolean;
  /** Shrinkage strength pseudo-count (default 20). */
  readonly prior_strength_m?: number;
}

export interface DirectedCoPurchaseResult {
  readonly direction: string;
  readonly shrunk_prob_b_given_a: number;
  readonly directed_lift: number;
  readonly relationship: 'complement' | 'substitute' | 'unknown';
  readonly evidence_level: 'observed' | 'inferred';
}

/**
 * Computes directional co-purchase lift (`A -> B != B -> A`) with product -> category hierarchical
 * shrinkage and 3-way classification (`complement | substitute | unknown`, §8.13-5).
 * Guards against sparse false-substitute calls (e.g. 0 hits in 10 opportunities -> `'unknown'`).
 */
export function evaluateDirectedCoPurchase(
  input: DirectedCoPurchaseInput
): DirectedCoPurchaseResult {
  const n = Math.max(0, input.opportunities_both_available);
  const k = Math.max(0, Math.min(n, input.co_purchase_count_a_to_b));
  const m = input.prior_strength_m ?? 20;

  // Hierarchical Empirical-Bayes shrinkage toward category-pair prior
  const shrunkRate = (k + m * input.category_prior_rate) / (n + m);
  const lift = shrunkRate / Math.max(1e-6, input.target_base_rate);

  // Require sufficient opportunities before calling substitute (prevents 5% * 10 trials false zero!)
  const expectedIfIndependent = n * input.target_base_rate;
  let relationship: 'complement' | 'substitute' | 'unknown' = 'unknown';

  if (n >= 30 && lift >= 1.5 && k >= 5) {
    relationship = 'complement';
  } else if (
    input.high_co_view_rate &&
    expectedIfIndependent >= 5 && // P(0 hits) <= e^-5 ≈ 0.0067
    lift <= 0.4 &&
    input.source_category === input.target_category
  ) {
    relationship = 'substitute';
  }

  return {
    direction: `${input.source_product_id}->${input.target_product_id}`,
    shrunk_prob_b_given_a: Number(shrunkRate.toFixed(6)),
    directed_lift: Number(lift.toFixed(4)),
    relationship,
    evidence_level: n >= 30 ? 'observed' : 'inferred',
  };
}

// =========================================================================
// Censored + Return-Aware Repurchase Hazard Model (§8.13-5)
// =========================================================================

export interface RepurchaseSubjectHistory {
  readonly days_observed: number;
  readonly repurchased: boolean;
  readonly returned_or_cancelled: boolean;
  readonly right_censored: boolean;
}

export interface RepurchaseHazardEstimate {
  readonly status: 'ok' | 'fallback_feed_cycle';
  readonly evidence_level: 'observed' | 'inferred';
  readonly effective_buyers: number;
  readonly confirmed_repurchases: number;
  readonly cumulative_repurchase_prob_by_day: number;
  readonly estimated_cycle_days: number | null;
  readonly inferred_durability: ProductDurabilityKind;
  readonly durability_evidence_level: 'observed' | 'inferred';
}

/**
 * Estimates repurchase probability by target day `T` using Kaplan-Meier / Nelson-Aalen
 * accounting for non-repurchasers, right-censoring, and returned/cancelled initial orders (§8.13-5).
 */
export function estimateRepurchaseHazard(params: {
  readonly histories: readonly RepurchaseSubjectHistory[];
  readonly target_day: number;
  readonly feed_durability: ProductDurabilityKind;
  readonly feed_repurchase_cycle_days: number | null;
  readonly min_effective_buyers?: number;
}): RepurchaseHazardEstimate {
  // Exclude returned/cancelled initial purchases from repurchase risk set (§8.13-5)
  const valid = params.histories.filter((h) => !h.returned_or_cancelled);
  const minBuyers = params.min_effective_buyers ?? 30;

  if (valid.length < minBuyers) {
    return {
      status: 'fallback_feed_cycle',
      evidence_level: 'inferred',
      effective_buyers: valid.length,
      confirmed_repurchases: valid.filter((h) => h.repurchased).length,
      cumulative_repurchase_prob_by_day: 0,
      estimated_cycle_days: params.feed_repurchase_cycle_days,
      inferred_durability: params.feed_durability,
      durability_evidence_level: params.feed_durability === 'unknown' ? 'inferred' : 'observed',
    };
  }

  // Exact discrete Kaplan-Meier survival S(t) for NOT yet repurchasing by day t
  const eventDays = Array.from(
    new Set(
      valid
        .filter((h) => h.repurchased && h.days_observed <= params.target_day)
        .map((h) => h.days_observed)
    )
  ).sort((a, b) => a - b);

  let survivalNotRepurchased = 1.0;
  let medianCycleDay: number | null = null;

  for (const day of eventDays) {
    let atRisk = 0;
    let events = 0;
    for (const h of valid) {
      if (h.days_observed >= day) {
        atRisk += 1;
        if (h.repurchased && h.days_observed === day) {
          events += 1;
        }
      }
    }
    if (atRisk > 0) {
      survivalNotRepurchased *= 1 - events / atRisk;
      if (medianCycleDay === null && 1 - survivalNotRepurchased >= 0.5) {
        medianCycleDay = day;
      }
    }
  }

  const cumProb = Number((1 - survivalNotRepurchased).toFixed(4));
  const inferredDurability: ProductDurabilityKind =
    params.feed_durability !== 'unknown'
      ? params.feed_durability
      : cumProb >= 0.25
        ? 'consumable'
        : 'durable';

  return {
    status: 'ok',
    evidence_level: 'observed',
    effective_buyers: valid.length,
    confirmed_repurchases: valid.filter((h) => h.repurchased).length,
    cumulative_repurchase_prob_by_day: cumProb,
    estimated_cycle_days: medianCycleDay ?? params.feed_repurchase_cycle_days,
    inferred_durability: inferredDurability,
    durability_evidence_level: params.feed_durability === 'unknown' ? 'inferred' : 'observed',
  };
}

// =========================================================================
// EC Recommendation Guardrails (§8.13-5)
// =========================================================================

export interface EcGuardrailEvaluation {
  readonly passed: boolean;
  readonly breaches: readonly string[];
}

export function evaluateEcRecommendationGuardrails(params: {
  readonly cart_abandonment_delta: number; // +0.02 max allowed
  readonly aov_relative_delta: number; // -0.05 max allowed drop
  readonly return_rate_delta: number; // +0.015 max allowed spike ("sold more but returns spiked")
}): EcGuardrailEvaluation {
  const breaches: string[] = [];
  if (params.cart_abandonment_delta > 0.02) breaches.push('ec.guardrail_cart_abandonment_spike');
  if (params.aov_relative_delta < -0.05) breaches.push('ec.guardrail_aov_drop');
  if (params.return_rate_delta > 0.015) breaches.push('ec.guardrail_return_rate_spike');
  return { passed: breaches.length === 0, breaches };
}
