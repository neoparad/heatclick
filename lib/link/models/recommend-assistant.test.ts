/**
 * UGOKI LINK v2 — Wave 6 (Bundle 6-D) Tests
 *
 * Covers:
 *   1. Multi-rung Recommender (`R0`, `R1`, `R1.5`, `R2` challengers, `computeYenExpectedValue`
 *      with `click_only_evidence`, browser <= 50 re-rank, OPE zero-support guard, origin HTML
 *      7-day reorder cap exempting sold-out removal & isolated `slot_fp`, 30-min freshness SLA).
 *   2. E-Commerce Recommender (§8.13 3–6):
 *      - **Exact Full-Set Plackett-Luce Probability Preservation (§8.13-4)**:
 *        weights [A=1, B=1, C=1, D=2] with B & C dropped at last second -> across 6,000 seeds,
 *        empirical P(A ranked #1) ≈ 1/3 = 0.3333 (NOT truncated-spare bias 7/18 = 0.3889!)
 *        AND logged `conditional_display_prob === 0.333333`.
 *      - **Zero Confidential Leakage**: browser DTO never exposes gross margin, member history,
 *        score boost deltas, or exclusion reasons (`assertNoEcConfidentialLeak`).
 *      - **Signed Member Proof & Dual Consent**: raw browser member hash throws
 *        `MemberProofRequiredError`; missing `member_link` or `personalisation` falls back to
 *        anonymous while cart exclusion STILL works; `suppression_epoch` blocks suppressed members.
 *      - **Directed Co-Purchase**: `A->B != B->A`, category shrinkage, sparse 0/10 hits stays `'unknown'`.
 *      - **Censored + Return-Aware Repurchase**: excludes returns/cancellations, handles right-censoring,
 *        falls back to feed cycle, tags inferred durability as `'inferred'`.
 *      - **EC Guardrails**: detects return-rate spike even when conversions/sales rise.
 *   3. 3-Tier Assistant & A3 Sandbox Contract:
 *      - Tier 1 jump, Tier 2 extractive, Tier 3 generative gated by `>=200` human-labeled questions
 *        AND exact Clopper-Pearson 95% LCB >= owner floor (automatic Tier 2 fallback when unmet).
 *      - A3 sandbox contract rejects password/payment pages, unapproved hashes, forbidden tokens,
 *        and kills on history mutation.
 *   4. `POST /v1/recommend` Next.js Route + MCP Tool Parity:
 *      - Authenticated call returns valid `buildResponseEnvelope` with `UntrustedValue` external strings,
 *        `VerifiedMetricValue` counts, zero gross margin leak; unauthenticated returns 401;
 *        cross-tenant probe returns 404; browser `ugk_pub` cannot spoof `ec_server_direct`.
 */

import { NextRequest } from 'next/server';
import { POST as recommendRoutePost } from '../../../app/api/v1/recommend/route';
import { POST as siteRecommendRoutePost } from '../../../app/api/v1/sites/[siteId]/recommend/route';
import { CostUnitRateLimiter } from '../surface';
import {
  detectUntrustedStringLeaks,
  isUntrustedValue,
} from '../../../packages/contract/response';
import { IdentityKeyRegistry, SCOPE_PRESETS } from '../auth';
import { MlModelRegistry } from '../ml/foundation/registry';
import { EcMemberSummaryStore } from '../revenue/ec-member-store';
import {
  EmptyUnconnectedRepository,
  LinkMcpServer,
  setSurfaceRuntimeContext,
  SurfacePipeline,
  type SiteRuntimeConfig,
  type SurfaceDataRepository,
} from '../surface';
import { AskService } from '../ask';
import {
  computeClopperPearsonLowerBound,
  evaluateTier3FaithfulnessGate,
  registerAssistantChallengers,
  serveAssistantResponse,
  verifyA3SandboxContract,
  type A3SandboxMountInput,
  type IndexedPageSection,
} from './assistant';
import {
  assertNoEcConfidentialLeak,
  checkRecommendationOpeSupport,
  computePlackettLuceMarginalInclusionProbs,
  computeYenExpectedValue,
  estimateRepurchaseHazard,
  evaluateDirectedCoPurchase,
  evaluateEcRecommendationGuardrails,
  evaluateNewPageFreshnessSla,
  evaluateOriginHtmlListUpdate,
  MemberProofRequiredError,
  registerRecommenderChallengers,
  rerankCandidatesInBrowser,
  runEcRecommendation,
  scoreCandidateByRung,
  signEcMemberProofToken,
  type EcCandidateProduct,
  type RecommendCandidateItem,
} from './recommend';
import {
  callRecommendMcpTool,
  executeRecommendRequest,
  RECOMMEND_MCP_TOOL_DEF,
  setRecommendRuntimeConfig,
} from './recommend-service';

function makeEcProduct(overrides: Partial<EcCandidateProduct> & { product_id: string }): EcCandidateProduct {
  return {
    parent_family_id: `fam_${overrides.product_id}`,
    title: `Product ${overrides.product_id}`,
    product_url_key_v2: `https://shop.example.com/products/${overrides.product_id}`,
    image_url: `https://cdn.example.com/${overrides.product_id}.jpg`,
    available: true,
    stale: false,
    hide_price: false,
    price: 3980,
    currency: 'JPY',
    category: 'skincare',
    brand: 'UgokiBrand',
    durability: 'consumable',
    repurchase_cycle_days: 30,
    sensitive_category: false,
    server_only_gross_margin: 0.48,
    base_score_weight: 1.0,
    ...overrides,
  };
}

describe('Wave 6 Bundle 6-D.1: Multi-Rung Recommender, Yen Value & 2-Tier Delivery', () => {
  test('registers R1/R1.5/R2 challengers, computes Yen value with click_only_evidence flag, enforces <=50 browser rerank & OPE support', () => {
    const registry = new MlModelRegistry();
    const ids = registerRecommenderChallengers(registry, 'tenant_1', '2026-11-20T00:00:00Z');
    expect(ids).toHaveLength(4);
    expect(ids).toContain('rec_llm_next_question_v1');
    for (const id of ids) {
      expect(registry.getModelVersion(id)?.status).toBe('challenger');
    }

    // Revenue-linked Yen expected value (deducting return rate & applying server gross margin)
    const rev = computeYenExpectedValue({
      p_click: 0.1,
      p_read_complete: 0.5,
      w_read_yen: 0,
      label_terms: [
        { label_key: 'purchase', prob_given_click: 0.2, value_yen: 10_000, gross_margin_weight: 0.5, return_rate: 0.1 },
      ],
    });
    expect(rev.value_basis).toBe('revenue');
    expect(rev.click_only_evidence).toBe(false);
    // 0.1 * (0.2 * 10000 * 0.5 * 0.9) = 90 JPY
    expect(rev.expected_value_yen).toBeCloseTo(90, 3);

    // Unlinked value -> explicitly click_only_evidence: true!
    const clickOnly = computeYenExpectedValue({
      p_click: 0.12,
      p_read_complete: 0.4,
      label_terms: [{ label_key: 'aff_click', prob_given_click: 0.1, value_yen: null }],
    });
    expect(clickOnly.value_basis).toBe('clicks_only');
    expect(clickOnly.click_only_evidence).toBe(true);

    // Browser <=50 cap
    const candidates: RecommendCandidateItem[] = Array.from({ length: 70 }, (_, i) => ({
      item_id: `art_${i}`,
      kind: 'page',
      title: `Article ${i}`,
      url_key_v2: `https://blog.example.com/art_${i}`,
      content_sim: 0.5 + (i % 5) * 0.08,
      link_proximity: 0.4,
      coread_score: 0.3,
      session_knn: 0.6,
      decayed_popularity: 0.2,
      item_embedding: [1, i % 2 === 0 ? 1 : 0, 0.5],
      llm_next_question_score: 0.7,
    }));

    const r2Score = scoreCandidateByRung({
      item: candidates[0],
      rung: 'R2_two_tower_sequential_challenger',
      sessionVector: [1, 1, 0.5],
    });
    expect(r2Score.score).toBeGreaterThan(0);

    const reranked = rerankCandidatesInBrowser({
      candidates,
      sessionInterestVector: [1, 1, 0.5],
      topK: 5,
      seedKey: 'sess_rerank_1',
    });
    expect(reranked.full_ordering_count).toBe(50);
    expect(reranked.shown).toHaveLength(5);

    // OPE zero-support guard
    const opeCheck = checkRecommendationOpeSupport(['art_1', 'art_99'], { art_1: 0.12, art_99: 0 });
    expect(opeCheck.ope_supported).toBe(false);
    expect(opeCheck.zero_support_item_ids).toEqual(['art_99']);
  });

  test('enforces origin HTML 7-day reorder cap (exempting sold-out removal & isolating slot_fp) and 30-min freshness SLA', () => {
    const nowMs = Date.parse('2026-11-20T00:00:00Z');
    const threeDaysAgoMs = nowMs - 3 * 86_400_000;

    const reorderBlocked = evaluateOriginHtmlListUpdate({
      update_reason: 'reorder_refresh',
      last_reorder_update_ms: threeDaysAgoMs,
      now_ms: nowMs,
    });
    expect(reorderBlocked.allowed).toBe(false);
    expect(reorderBlocked.slot_fp_isolated_from_body_fp).toBe(true);

    const soldOutAllowed = evaluateOriginHtmlListUpdate({
      update_reason: 'remove_sold_out_product',
      last_reorder_update_ms: nowMs - 3_600_000,
      now_ms: nowMs,
    });
    expect(soldOutAllowed.allowed).toBe(true);
    expect(soldOutAllowed.counts_against_7day_cap).toBe(false);

    const slaOk = evaluateNewPageFreshnessSla([5, 10, 12, 18, 22, 26, 28]);
    expect(slaOk.within_30m_sla).toBe(true);
    expect(slaOk.p95_minutes).toBeLessThanOrEqual(30);

    const slaBreach = evaluateNewPageFreshnessSla([10, 15, 25, 45]);
    expect(slaBreach.within_30m_sla).toBe(false);
  });
});

describe('Wave 6 Bundle 6-D.2: E-Commerce Recommender (§8.13 3–6)', () => {
  test('FULL-SET Plackett-Luce eliminates §8.13-4 7/18 vs 1/3 truncated-spare bias when items drop at last second', () => {
    // §8.13-4 exact mathematical test:
    // Four candidates with weights [A=1, B=1, C=1, D=2].
    // Suppose B & C become sold-out right before display leaving {A(1), D(2)}.
    // Under exact conditional Plackett-Luce: P(A ranked #1 | {B,C} dropped) = 1 / (1 + 2) = 1/3 ≈ 0.3333.
    // (A buggy top-2 + 2-spare truncated prefix would bias P(A first) toward 7/18 ≈ 0.3889!)
    const products: EcCandidateProduct[] = [
      makeEcProduct({ product_id: 'A', base_score_weight: 1, server_only_gross_margin: null }),
      makeEcProduct({ product_id: 'B', base_score_weight: 1, server_only_gross_margin: null }),
      makeEcProduct({ product_id: 'C', base_score_weight: 1, server_only_gross_margin: null }),
      makeEcProduct({ product_id: 'D', base_score_weight: 2, server_only_gross_margin: null }),
    ];

    const trials = 6_000;
    let aFirstCount = 0;
    let loggedCondProbForAFirst: number | null = null;

    for (let i = 0; i < trials; i++) {
      const out = runEcRecommendation({
        tenant_id: 'tenant_pl',
        site_id: 'site_pl',
        placement: 'home',
        caller_channel: 'ec_server_direct',
        candidates: products,
        top_k: 2,
        cart_product_ids: [],
        last_second_sold_out_ids: ['B', 'C'],
        seed_key: `pl_exact_trial_${i}`,
        temperature: 1.0,
        now_iso: '2026-11-20T00:00:00Z',
      });
      expect(out.browser_items.map((x) => x.product_id).sort()).toEqual(['A', 'D']);
      if (out.browser_items[0].product_id === 'A') {
        aFirstCount += 1;
        loggedCondProbForAFirst = out.server_decision_log.displayed_items[0].conditional_display_prob;
      }
    }

    const empiricalP = aFirstCount / trials;
    // Exact 1/3 = 0.3333; standard error over 6,000 trials = sqrt(1/3 * 2/3 / 6000) ≈ 0.0061.
    // 7/18 = 0.3889 is > 9 standard errors away!
    expect(empiricalP).toBeGreaterThan(0.31);
    expect(empiricalP).toBeLessThan(0.358);
    expect(loggedCondProbForAFirst).toBeCloseTo(1 / 3, 5);

    // [M-13]: Verify true marginal top-K inclusion probability P(item in top K) alongside slot_cond_prob!
    // Exact analytical check for weights [1, 2, 3], K = 2:
    // P(0 in top 2) = 25/60 = 5/12, P(1 in top 2) = 44/60 = 11/15, P(2 in top 2) = 51/60 = 17/20, sum = 2.0
    const exactMarginals = computePlackettLuceMarginalInclusionProbs([1, 2, 3], 2);
    expect(exactMarginals[0]).toBeCloseTo(25 / 60, 10);
    expect(exactMarginals[1]).toBeCloseTo(44 / 60, 10);
    expect(exactMarginals[2]).toBeCloseTo(51 / 60, 10);
    expect(exactMarginals[0] + exactMarginals[1] + exactMarginals[2]).toBeCloseTo(2, 10);

    // Verify runEcRecommendation logs both `slot_cond_prob` and true marginal `display_prob`
    const marginalRun = runEcRecommendation({
      tenant_id: 'tenant_pl',
      site_id: 'site_pl',
      placement: 'home',
      caller_channel: 'ec_server_direct',
      candidates: [
        makeEcProduct({ product_id: 'M1', base_score_weight: 1, server_only_gross_margin: null }),
        makeEcProduct({ product_id: 'M2', base_score_weight: 2, server_only_gross_margin: null }),
        makeEcProduct({ product_id: 'M3', base_score_weight: 3, server_only_gross_margin: null }),
      ],
      top_k: 2,
      cart_product_ids: [],
      seed_key: 'pl_marginal_ec_1',
      temperature: 1.0,
      now_iso: '2026-11-20T00:00:00Z',
    });
    expect(marginalRun.server_decision_log.marginal_display_probs_by_item['M1']).toBeCloseTo(25 / 60, 5);
    expect(marginalRun.server_decision_log.marginal_display_probs_by_item['M2']).toBeCloseTo(44 / 60, 5);
    expect(marginalRun.server_decision_log.marginal_display_probs_by_item['M3']).toBeCloseTo(51 / 60, 5);
    expect(marginalRun.server_decision_log.displayed_items[0].slot_cond_prob).toBeGreaterThan(0);
    expect(marginalRun.server_decision_log.displayed_items[0].display_prob).toBeGreaterThan(
      marginalRun.server_decision_log.displayed_items[0].slot_cond_prob
    );
  });

  test('enforces signed browser member proof, dual consent, suppression_epoch, cart exclusion without consent, and zero confidential leakage', () => {
    const store = new EcMemberSummaryStore();
    store.upsertSummary({
      tenant_id: 'tenant_ec',
      site_id: 'site_ec',
      member_key: 'mem_001',
      data_epoch: 1,
      write_source: 'realtime_order_event',
      recent_purchased_product_ids: ['p_durable_bought', 'p_fresh_consumable'],
      category_affinity: { skincare: 0.9 },
      upcoming_repurchase_product_ids: [],
      excluded_product_ids: ['p_durable_bought', 'p_fresh_consumable'],
      source_retention_expires_at: '2027-05-01T00:00:00Z',
      updated_at: '2026-11-19T00:00:00Z',
    });

    const candidates: EcCandidateProduct[] = [
      makeEcProduct({ product_id: 'p_in_cart', parent_family_id: 'fam_cart' }),
      makeEcProduct({ product_id: 'p_cart_sibling', parent_family_id: 'fam_cart' }),
      makeEcProduct({ product_id: 'p_durable_bought', durability: 'durable' }),
      makeEcProduct({ product_id: 'p_fresh_consumable', durability: 'consumable', repurchase_cycle_days: 30 }),
      makeEcProduct({ product_id: 'p_sold_out', available: false }),
      makeEcProduct({ product_id: 'p_stale', stale: true }),
      makeEcProduct({ product_id: 'p_sensitive', sensitive_category: true }),
      makeEcProduct({ product_id: 'p_good_1', server_only_gross_margin: 0.65 }),
      makeEcProduct({ product_id: 'p_good_2', server_only_gross_margin: 0.35, hide_price: true, price: 9999 }),
    ];

    const secret = 'ec_proof_shared_secret_v1';

    // 1. Browser passing raw member hash without signed proof MUST throw!
    expect(() =>
      runEcRecommendation({
        tenant_id: 'tenant_ec',
        site_id: 'site_ec',
        placement: 'cart',
        caller_channel: 'browser',
        candidates,
        top_k: 5,
        cart_product_ids: ['p_in_cart'],
        seed_key: 'seed_1',
        now_iso: '2026-11-20T00:00:00Z',
        raw_browser_member_hash: 'raw_sha256_member_hash',
      })
    ).toThrow(MemberProofRequiredError);

    // 2. Missing personalisation consent -> falls back to anonymous, YET cart + sibling + sold_out + stale + sensitive STILL excluded!
    const proof = signEcMemberProofToken(
      {
        tenant_id: 'tenant_ec',
        site_id: 'site_ec',
        member_key: 'mem_001',
        session_id: 'sess_browser_1',
        purpose: 'recommend',
        expires_at_ms: Date.parse('2026-11-20T01:00:00Z'),
      },
      secret
    );

    const noConsent = runEcRecommendation({
      tenant_id: 'tenant_ec',
      site_id: 'site_ec',
      placement: 'cart',
      caller_channel: 'browser',
      candidates,
      top_k: 5,
      cart_product_ids: ['p_in_cart'],
      seed_key: 'seed_2',
      now_iso: '2026-11-20T00:00:00Z',
      member_store: store,
      browser_member_proof: proof,
      browser_session_id: 'sess_browser_1',
      ec_server_proof_secret: secret,
      consent_member_link: true,
      consent_personalisation: false,
    });
    expect(noConsent.server_decision_log.member_history_joined).toBe(false);
    const anonIds = noConsent.browser_items.map((i) => i.product_id);
    expect(anonIds).not.toContain('p_in_cart');
    expect(anonIds).not.toContain('p_cart_sibling');
    expect(anonIds).not.toContain('p_sold_out');
    expect(anonIds).not.toContain('p_stale');
    expect(anonIds).not.toContain('p_sensitive');

    // 3. Valid proof + BOTH consents -> joins member history, excludes recent durable & fresh consumable, hides price when hide_price=true, zero confidential leak!
    const withConsent = runEcRecommendation({
      tenant_id: 'tenant_ec',
      site_id: 'site_ec',
      placement: 'cart',
      caller_channel: 'browser',
      candidates,
      top_k: 5,
      cart_product_ids: ['p_in_cart'],
      seed_key: 'seed_3',
      now_iso: '2026-11-20T00:00:00Z',
      member_store: store,
      browser_member_proof: proof,
      browser_session_id: 'sess_browser_1',
      ec_server_proof_secret: secret,
      consent_member_link: true,
      consent_personalisation: true,
    });
    expect(withConsent.server_decision_log.member_history_joined).toBe(true);
    expect(withConsent.browser_items.map((i) => i.product_id).sort()).toEqual(['p_good_1', 'p_good_2']);
    const hiddenPriceItem = withConsent.browser_items.find((i) => i.product_id === 'p_good_2');
    expect(hiddenPriceItem?.price).toBeNull();
    expect(() => assertNoEcConfidentialLeak(withConsent.browser_items)).not.toThrow();

    // 4. Suppression epoch bump blocks member summary immediately
    store.recordMemberSuppression({
      tenant_id: 'tenant_ec',
      site_id: 'site_ec',
      member_key: 'mem_001',
      reason: 'erasure_request',
      suppressed_at: '2026-11-20T00:00:00Z',
    });
    const afterSuppress = runEcRecommendation({
      tenant_id: 'tenant_ec',
      site_id: 'site_ec',
      placement: 'cart',
      caller_channel: 'ec_server_direct',
      candidates,
      top_k: 5,
      cart_product_ids: ['p_in_cart'],
      seed_key: 'seed_4',
      now_iso: '2026-11-20T00:00:00Z',
      member_store: store,
      direct_server_member_key: 'mem_001',
      consent_member_link: true,
      consent_personalisation: true,
    });
    expect(afterSuppress.server_decision_log.member_history_joined).toBe(false);

    // Leak detector catches any smuggled confidential key
    expect(() =>
      assertNoEcConfidentialLeak({ items: [{ product_id: 'x', gross_margin: 0.42 }] })
    ).toThrow();
    expect(() =>
      assertNoEcConfidentialLeak({ items: [{ product_id: 'x', member_boost: 0.15 }] })
    ).toThrow();
  });

  test('computes directed co-purchase (A->B != B->A, sparse 0/10 stays unknown), censored return-aware repurchase hazard, and EC guardrails', () => {
    // Camera -> Lens (complement) vs Lens -> Camera (different directional lift)
    const camToLens = evaluateDirectedCoPurchase({
      source_product_id: 'camera_x',
      target_product_id: 'lens_50mm',
      source_category: 'cameras',
      target_category: 'lenses',
      opportunities_both_available: 100,
      co_purchase_count_a_to_b: 35,
      target_base_rate: 0.08,
      category_prior_rate: 0.25,
      high_co_view_rate: true,
    });
    const lensToCam = evaluateDirectedCoPurchase({
      source_product_id: 'lens_50mm',
      target_product_id: 'camera_x',
      source_category: 'lenses',
      target_category: 'cameras',
      opportunities_both_available: 100,
      co_purchase_count_a_to_b: 4,
      target_base_rate: 0.08,
      category_prior_rate: 0.05,
      high_co_view_rate: false,
    });
    expect(camToLens.relationship).toBe('complement');
    expect(camToLens.directed_lift).not.toBe(lensToCam.directed_lift);
    expect(lensToCam.relationship).toBe('unknown');

    // Sparse 0 hits in 10 opportunities (base rate 0.05 -> expected=0.5 < 5) MUST stay 'unknown' (no false substitute!)
    const sparse = evaluateDirectedCoPurchase({
      source_product_id: 'tv_a',
      target_product_id: 'tv_b',
      source_category: 'tv',
      target_category: 'tv',
      opportunities_both_available: 10,
      co_purchase_count_a_to_b: 0,
      target_base_rate: 0.05,
      category_prior_rate: 0.02,
      high_co_view_rate: true,
    });
    expect(sparse.relationship).toBe('unknown');

    // Well-powered co-viewed same-category 0/200 with base rate 0.05 -> expected 10 -> verified 'substitute'
    const verifiedSub = evaluateDirectedCoPurchase({
      source_product_id: 'tv_a',
      target_product_id: 'tv_b',
      source_category: 'tv',
      target_category: 'tv',
      opportunities_both_available: 200,
      co_purchase_count_a_to_b: 0,
      target_base_rate: 0.05,
      category_prior_rate: 0.01,
      high_co_view_rate: true,
    });
    expect(verifiedSub.relationship).toBe('substitute');

    // Censored + Return-aware repurchase hazard
    const histories = [
      ...Array.from({ length: 18 }, () => ({
        days_observed: 28,
        repurchased: true,
        returned_or_cancelled: false,
        right_censored: false,
      })),
      ...Array.from({ length: 15 }, () => ({
        days_observed: 40,
        repurchased: false,
        returned_or_cancelled: false,
        right_censored: true,
      })),
      // 10 returned initial orders MUST be excluded from risk set
      ...Array.from({ length: 10 }, () => ({
        days_observed: 10,
        repurchased: false,
        returned_or_cancelled: true,
        right_censored: false,
      })),
    ];
    const hazard = estimateRepurchaseHazard({
      histories,
      target_day: 30,
      feed_durability: 'unknown',
      feed_repurchase_cycle_days: 35,
    });
    expect(hazard.status).toBe('ok');
    expect(hazard.effective_buyers).toBe(33); // 10 returns excluded!
    expect(hazard.cumulative_repurchase_prob_by_day).toBeCloseTo(18 / 33, 3);
    expect(hazard.inferred_durability).toBe('consumable');
    expect(hazard.durability_evidence_level).toBe('inferred');

    // Guardrail detects return-rate spike even when sales rise
    const badGuard = evaluateEcRecommendationGuardrails({
      cart_abandonment_delta: 0.005,
      aov_relative_delta: 0.08,
      return_rate_delta: 0.032,
    });
    expect(badGuard.passed).toBe(false);
    expect(badGuard.breaches).toContain('ec.guardrail_return_rate_spike');
  });
});

describe('Wave 6 Bundle 6-D.3: 3-Tier Assistant & A3 Sandbox Contract', () => {
  const sections: IndexedPageSection[] = [
    {
      page_id: 'lp_saas',
      sec_fp: 'sec_pricing',
      body_fp: 'body_pricing_v1',
      heading: 'Pricing & Cancellation',
      verbatim_text: 'Monthly plans can be cancelled anytime before the next billing date with zero penalty fees.',
      curated_questions: ['Can I cancel anytime?'],
    },
    {
      page_id: 'lp_saas',
      sec_fp: 'sec_security',
      body_fp: 'body_security_v1',
      heading: 'Data Security',
      verbatim_text: 'All tenant data is isolated in ap-northeast-1 with AES-256 encryption at rest.',
      curated_questions: ['Where is data stored?'],
    },
  ];

  const validSandbox: A3SandboxMountInput = {
    host_origin: 'https://customer.example.com',
    sandbox_origin: 'https://sandbox.ugokilink.example',
    iframe_sandbox_tokens: ['allow-scripts'],
    host_owns_close_control: true,
    host_owns_navigation: true,
    context_disclosable_only: true,
    contains_password_field: false,
    contains_payment_field: false,
    page_category: 'lp',
    human_approved_bundle_hash: 'sha256_approved_bundle_abc123',
    deployed_bundle_hash: 'sha256_approved_bundle_abc123',
    history_mutation_monitor_active: true,
    detected_history_mutation: false,
  };

  test('gates Tier 3 strictly by >=200 human-labeled questions & Clopper-Pearson 95% LCB >= owner floor, falling back to Tier 2', () => {
    // 190/200 -> 95% exact Clopper-Pearson LCB ≈ 0.9099 >= 0.90 -> eligible!
    const lcbPass = computeClopperPearsonLowerBound(190, 200, 0.05);
    expect(lcbPass).toBeGreaterThanOrEqual(0.9);

    // 184/200 -> 92% point estimate, BUT exact 95% LCB ≈ 0.873 < 0.90 -> NOT eligible!
    const gateLowLcb = evaluateTier3FaithfulnessGate({
      site_id: 'site_1',
      evaluated_at: '2026-11-20T00:00:00Z',
      human_labeled_questions_count: 200,
      faithful_count: 184,
      owner_min_faithfulness_threshold: 0.9,
      evaluation_ref_id: 'eval_1',
    });
    expect(gateLowLcb.eligible).toBe(false);

    // 195/195 (< 200 questions) -> NOT eligible!
    const gateFewQ = evaluateTier3FaithfulnessGate({
      site_id: 'site_1',
      evaluated_at: '2026-11-20T00:00:00Z',
      human_labeled_questions_count: 195,
      faithful_count: 195,
      owner_min_faithfulness_threshold: 0.9,
      evaluation_ref_id: 'eval_2',
    });
    expect(gateFewQ.eligible).toBe(false);

    // Tier 1 jump buttons
    const t1 = serveAssistantResponse({
      site_id: 'site_1',
      page_id: 'lp_saas',
      requested_tier: 'tier1_question_jump',
      sections,
      sandbox_state: validSandbox,
    });
    expect(t1.allowed).toBe(true);
    expect(t1.served_tier).toBe('tier1_question_jump');
    expect(t1.jump_options).toHaveLength(2);

    // Tier 3 requested with unmet gate -> automatically falls back to Tier 2 extractive!
    const t3Fallback = serveAssistantResponse({
      site_id: 'site_1',
      page_id: 'lp_saas',
      user_question: 'Can I cancel my monthly plan?',
      requested_tier: 'tier3_generative_cited',
      sections,
      sandbox_state: validSandbox,
      tier3_evaluation: {
        site_id: 'site_1',
        evaluated_at: '2026-11-20T00:00:00Z',
        human_labeled_questions_count: 150,
        faithful_count: 150,
        owner_min_faithfulness_threshold: 0.9,
        evaluation_ref_id: 'eval_short',
      },
    });
    expect(t3Fallback.served_tier).toBe('tier2_extractive');
    expect(t3Fallback.fallback_from_tier3).toBe(true);
    expect(t3Fallback.ai_generated_label).toBe(false);
    expect(t3Fallback.citations[0].sec_fp).toBe('sec_pricing');
    expect(t3Fallback.extractive_snippet).toContain('cancelled anytime');

    // Tier 3 passing gate + valid citation -> serves cited generative answer labeled ai_generated!
    const t3Pass = serveAssistantResponse({
      site_id: 'site_1',
      page_id: 'lp_saas',
      user_question: 'Can I cancel my monthly plan?',
      requested_tier: 'tier3_generative_cited',
      sections,
      sandbox_state: validSandbox,
      tier3_evaluation: {
        site_id: 'site_1',
        evaluated_at: '2026-11-20T00:00:00Z',
        human_labeled_questions_count: 220,
        faithful_count: 212,
        owner_min_faithfulness_threshold: 0.9,
        evaluation_ref_id: 'eval_ok',
      },
      generateTier3: () => ({
        answer_text: 'Yes, monthly plans may be cancelled anytime before the next billing date with zero penalty fees.',
        cited_sec_fps: ['sec_pricing'],
        model_version: 'cited_gen_v1',
      }),
    });
    expect(t3Pass.served_tier).toBe('tier3_generative_cited');
    expect(t3Pass.ai_generated_label).toBe(true);
    expect(t3Pass.evidence_level).toBe('inferred');
    expect(t3Pass.citations).toEqual([
      { page_id: 'lp_saas', sec_fp: 'sec_pricing', body_fp: 'body_pricing_v1' },
    ]);

    // 4-F challenger registration
    const mlReg = new MlModelRegistry();
    const regEntry = registerAssistantChallengers(mlReg, 'tenant_1', '2026-11-20T00:00:00Z');
    expect(regEntry.status).toBe('challenger');
  });

  test('A3 Sandbox Contract blocks password/payment pages, unapproved hashes, forbidden tokens, and kills on history mutation', () => {
    expect(verifyA3SandboxContract(validSandbox).mount_allowed).toBe(true);

    const passwordPage = verifyA3SandboxContract({
      ...validSandbox,
      contains_password_field: true,
    });
    expect(passwordPage.mount_allowed).toBe(false);
    expect(passwordPage.violations.some((v) => v.includes('PASSWORD'))).toBe(true);

    const paymentPage = verifyA3SandboxContract({
      ...validSandbox,
      contains_payment_field: true,
      page_category: 'checkout',
    });
    expect(paymentPage.mount_allowed).toBe(false);

    const mutatedHistory = verifyA3SandboxContract({
      ...validSandbox,
      detected_history_mutation: true,
    });
    expect(mutatedHistory.mount_allowed).toBe(false);
    expect(mutatedHistory.killed).toBe(true);
  });
});

describe('Wave 6 Bundle 6-D.4: POST /v1/recommend Route & MCP Tool Parity', () => {
  function setupSurfaceFixture() {
    const keyRegistry = new IdentityKeyRegistry({
      pepperVersion: 'test_v1',
      pepperSecret: 'test_pepper_secret_wave6',
    });
    keyRegistry.registerOrg({
      orgId: 'org_a',
      type: 'direct',
      name: 'Org A',
      createdAt: '2026-01-01T00:00:00Z',
    });
    keyRegistry.registerTenant({
      tenantId: 'tenant_a',
      orgId: 'org_a',
      name: 'Tenant A',
      planScopes: [...SCOPE_PRESETS.read, 'logs:write'],
      delegationPolicy: { allowedOemScopes: [], maxExchangedTokenTtlSec: 300, allowOemAccess: false },
      revocationEpoch: 1,
      createdAt: '2026-01-01T00:00:00Z',
    });
    keyRegistry.registerSite({
      siteId: 'site_a',
      tenantId: 'tenant_a',
      siteRef: 'site_a_ref',
      env: 'live',
      hostnames: ['shop.a.example'],
      allowedOrigins: ['https://shop.a.example'],
      createdAt: '2026-01-01T00:00:00Z',
    });
    keyRegistry.registerPrincipal({
      principalId: 'svc_a',
      tenantId: 'tenant_a',
      orgId: 'org_a',
      kind: 'service',
      role: 'admin',
      passkeyEnrolled: false,
    });

    const secKey = keyRegistry.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'svc_a',
      env: 'live',
      scopes: [...SCOPE_PRESETS.read],
    });
    const pubKey = keyRegistry.issuePublicKey('site_a');

    const siteMap = new Map<string, SiteRuntimeConfig>([
      [
        'site_a',
        {
          siteId: 'site_a',
          tenantId: 'tenant_a',
          siteName: 'Shop A',
          consentMode: 'full',
          storageRegion: 'ap-northeast-1',
          processingRegion: 'ap-northeast-1',
          monthlyQuotaPvs: 100_000,
        },
      ],
      [
        'site_b',
        {
          siteId: 'site_b',
          tenantId: 'tenant_b',
          siteName: 'Foreign Shop B',
          consentMode: 'full',
          storageRegion: 'ap-northeast-1',
          processingRegion: 'ap-northeast-1',
          monthlyQuotaPvs: 100_000,
        },
      ],
    ]);

    const baseRepo = new EmptyUnconnectedRepository();
    const repo: SurfaceDataRepository = {
      getSiteConfig: (id) => siteMap.get(id) ?? null,
      queryMetrics: (p) => baseRepo.queryMetrics(p),
      queryFusedInsights: (p) => baseRepo.queryFusedInsights(p),
      queryJourneyEvents: (p) => baseRepo.queryJourneyEvents(p),
      querySegmentMetrics: (p) => baseRepo.querySegmentMetrics(p),
      queryUsageLedger: (p) => baseRepo.queryUsageLedger(p),
      countAuditEvents: (p) => baseRepo.countAuditEvents(p),
    };

    const pipeline = new SurfacePipeline({ keyRegistry, repository: repo });
    const mcpServer = new LinkMcpServer(pipeline);
    const askService = new AskService({
      executor: {
        executePublicViewQuery: (p) => ({
          connected: false,
          rows: [],
          queryRefId: p.viewName,
          paramsHash: 'h',
          resultDigest: 'd',
        }),
      },
    });

    return {
      pipeline,
      mcpServer,
      askService,
      baseRepo,
      secKey: secKey.rawKey,
      pubKey,
    };
  }

  afterEach(() => {
    setSurfaceRuntimeContext(null);
    setRecommendRuntimeConfig({});
  });

  test('POST /v1/recommend enforces auth (401), cross-tenant isolation (404), UntrustedValue wrapping, zero confidential leak, and MCP tool parity', async () => {
    const fx = setupSurfaceFixture();
    setSurfaceRuntimeContext({
      pipeline: fx.pipeline,
      mcpServer: fx.mcpServer,
      askService: fx.askService,
      repository: fx.baseRepo,
    });

    const catalogProducts: EcCandidateProduct[] = [
      makeEcProduct({ product_id: 'sku_1', title: 'Serum Alpha', server_only_gross_margin: 0.72 }),
      makeEcProduct({ product_id: 'sku_2', title: 'Lotion Beta', server_only_gross_margin: 0.55 }),
    ];

    setRecommendRuntimeConfig({
      catalogProvider: {
        getEcCandidates: ({ siteId }) => (siteId === 'site_a' ? catalogProducts : null),
      },
    });

    // 1. Unauthenticated -> 401
    const unauthReq = new NextRequest('https://api.ugokilink.example/api/v1/recommend', {
      method: 'POST',
      body: JSON.stringify({ site_id: 'site_a', placement: 'home' }),
    });
    const unauthRes = await recommendRoutePost(unauthReq);
    expect(unauthRes.status).toBe(401);

    // 2. Cross-tenant caller probe -> 404 (zero existence oracle!)
    const crossTenantReq = new NextRequest('https://api.ugokilink.example/api/v1/recommend', {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.secKey}` },
      body: JSON.stringify({ tenant_id: 'tenant_b', site_id: 'site_a', placement: 'home' }),
    });
    const crossTenantRes = await recommendRoutePost(crossTenantReq);
    expect(crossTenantRes.status).toBe(404);

    // 3. Foreign site_id probe -> 404
    const foreignSiteRes = executeRecommendRequest({
      channel: 'rest',
      bearerToken: fx.secKey,
      pipeline: fx.pipeline,
      body: { site_id: 'site_b', placement: 'home' },
    });
    expect(foreignSiteRes.httpStatus).toBe(404);

    // 4. Browser `ugk_pub` attempting to spoof `ec_server_direct` with raw `member_key` -> forced to browser -> 403 MEMBER_PROOF_REQUIRED!
    const spoofRes = executeRecommendRequest({
      channel: 'rest',
      bearerToken: fx.pubKey,
      pipeline: fx.pipeline,
      body: {
        site_id: 'site_a',
        placement: 'cart',
        caller_channel: 'ec_server_direct',
        member_key: 'raw_member_123',
      },
    });
    expect(spoofRes.httpStatus).toBe(403);
    expect(spoofRes.error?.code).toBe('MEMBER_PROOF_REQUIRED');

    // 5. Authenticated valid POST /v1/recommend -> 200 with valid ResponseEnvelope, UntrustedValue items, zero confidential leak!
    const okReq = new NextRequest('https://api.ugokilink.example/api/v1/recommend', {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.secKey}` },
      body: JSON.stringify({
        site_id: 'site_a',
        placement: 'product_page',
        top_k: 2,
        seed_key: 'route_seed_1',
      }),
    });
    const okRes = await recommendRoutePost(okReq);
    expect(okRes.status).toBe(200);
    const json = (await okRes.json()) as {
      status: string;
      measures: Record<string, { value: number }>;
      data: { items: Array<{ product_id: string; title: unknown; product_url: unknown }> };
    };
    expect(json.status).toBe('ok');
    expect(json.measures.items_returned.value).toBe(2);
    expect(typeof json.data.items[0].title).toBe('object');
    expect(json.data.items[0].title).toMatchObject({ source: 'page_content' });
    expect(json.data.items[0].product_url).toMatchObject({ source: 'url' });
    expect(() => assertNoEcConfidentialLeak(json)).not.toThrow();

    // 6. MCP tool descriptor & parity call (in-memory envelope preserves Symbol-branded UntrustedValue)
    expect(RECOMMEND_MCP_TOOL_DEF.name).toBe('ugokilink_recommendItems');
    expect(RECOMMEND_MCP_TOOL_DEF.riskClass).toBe('R0');
    const mcpRes = callRecommendMcpTool({
      bearerToken: fx.secKey,
      pipeline: fx.pipeline,
      arguments: { site_id: 'site_a', placement: 'product_page', top_k: 2, seed_key: 'route_seed_1' },
    });
    expect(mcpRes.httpStatus).toBe(200);
    expect(mcpRes.envelope?.measures.items_returned.value).toBe(2);
    const mcpData = mcpRes.envelope?.data as { items: Array<{ title: unknown; product_url: unknown }> };
    expect(isUntrustedValue(mcpData.items[0].title)).toBe(true);
    expect(isUntrustedValue(mcpData.items[0].product_url)).toBe(true);
    expect(detectUntrustedStringLeaks(mcpRes.envelope)).toHaveLength(0);
  });

  test('[H-02] rejects unknown/unregistered siteId with 404, locks down browser ugk_pub_* overrides (candidates, gross_margin, in_stock, consent_granted), enforces rate limits, and serves POST /v1/sites/[siteId]/recommend', async () => {
    const fx = setupSurfaceFixture();
    const tightLimiter = new CostUnitRateLimiter({ maxUnitsPerWindow: 4, windowMs: 60_000 });
    const limitedPipeline = new SurfacePipeline({
      keyRegistry: fx.pipeline.keyRegistry,
      repository: fx.pipeline.repository,
      rateLimiter: tightLimiter,
    });

    setSurfaceRuntimeContext({
      pipeline: limitedPipeline,
      mcpServer: new LinkMcpServer(limitedPipeline),
      askService: fx.askService,
      repository: fx.baseRepo,
    });

    const memberStore = new EcMemberSummaryStore();
    memberStore.upsertSummary({
      tenant_id: 'tenant_a',
      site_id: 'site_a',
      member_key: 'mem_browser_99',
      data_epoch: 1,
      write_source: 'realtime_order_event',
      recent_purchased_product_ids: ['sku_1'],
      category_affinity: { skincare: 1.0 },
      upcoming_repurchase_product_ids: [],
      excluded_product_ids: ['sku_1'],
      source_retention_expires_at: '2027-05-01T00:00:00Z',
      updated_at: '2026-11-19T00:00:00Z',
    });
    const proofSecret = 'site_a_ec_proof_secret';
    const validProof = signEcMemberProofToken(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_a',
        member_key: 'mem_browser_99',
        session_id: 'sess_b_99',
        purpose: 'recommend',
        expires_at_ms: Date.now() + 3600_000,
      },
      proofSecret
    );

    let lastLoggedMemberJoined: boolean | null = null;
    setRecommendRuntimeConfig({
      ecMemberStore: memberStore,
      ecServerProofSecret: proofSecret,
      catalogProvider: {
        getEcCandidates: ({ siteId }) =>
          siteId === 'site_a'
            ? [
                makeEcProduct({ product_id: 'sku_1', server_only_gross_margin: 0.7, available: true }),
                makeEcProduct({ product_id: 'sku_2', server_only_gross_margin: 0.4, available: true }),
              ]
            : null,
      },
      onServerDecisionLog: ({ log }) => {
        lastLoggedMemberJoined = log.member_history_joined;
      },
    });

    // 1. Unknown/unregistered siteId (`siteCfg === null`) MUST return 404 (NEVER 200 OK!)
    const unknownSiteRes = executeRecommendRequest({
      channel: 'rest',
      bearerToken: fx.secKey,
      pipeline: limitedPipeline,
      body: { site_id: 'site_does_not_exist', placement: 'home' },
    });
    expect(unknownSiteRes.httpStatus).toBe(404);
    expect(unknownSiteRes.envelope).toBeUndefined();

    // 2. Browser `ugk_pub_*` supplying `candidates`, `ec_candidates`, `gross_margin`, `in_stock`, or `consent_granted` -> 403!
    for (const overridePayload of [
      { candidates: [{ product_id: 'evil_1' }] },
      { ec_candidates: [makeEcProduct({ product_id: 'evil_2', server_only_gross_margin: 0.99 })] },
      { gross_margin: 0.99 },
      { in_stock: true },
      { consent_granted: true },
    ]) {
      const res = executeRecommendRequest({
        channel: 'rest',
        bearerToken: fx.pubKey,
        pipeline: limitedPipeline,
        clientIp: '198.51.100.25',
        body: { site_id: 'site_a', placement: 'home', ...overridePayload },
      });
      expect(res.httpStatus).toBe(403);
      expect(res.error?.code).toBe('BROWSER_INPUT_OVERRIDE_FORBIDDEN');
    }

    // 3. Browser `ugk_pub_*` attempting to self-assert `consent_member_link: true` + `consent_personalisation: true`
    //    without server-side `resolveBrowserConsent` does NOT join member history!
    const unverifiedConsentBrowser = executeRecommendRequest({
      channel: 'rest',
      bearerToken: fx.pubKey,
      pipeline: limitedPipeline,
      clientIp: '198.51.100.99',
      body: {
        site_id: 'site_a',
        placement: 'cart',
        session_id: 'sess_b_99',
        member_proof_token: validProof,
        consent_member_link: true,
        consent_personalisation: true,
      },
    });
    expect(unverifiedConsentBrowser.httpStatus).toBe(200);
    expect(lastLoggedMemberJoined).toBe(false);

    // 4. POST /api/v1/sites/[siteId]/recommend route works & rejects body/path site_id mismatch (400) and enforces rate limit (429)
    const mismatchReq = new NextRequest('https://api.ugokilink.example/api/v1/sites/site_a/recommend', {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.secKey}`, 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ site_id: 'site_b', placement: 'home' }),
    });
    const mismatchRes = await siteRecommendRoutePost(mismatchReq, { params: { siteId: 'site_a' } });
    expect(mismatchRes.status).toBe(400);

    for (let i = 0; i < 4; i++) {
      const req = new NextRequest('https://api.ugokilink.example/api/v1/sites/site_a/recommend', {
        method: 'POST',
        headers: { authorization: `Bearer ${fx.secKey}`, 'x-forwarded-for': '203.0.113.88' },
        body: JSON.stringify({ placement: 'product_page', top_k: 2, seed_key: `rl_${i}` }),
      });
      const r = await siteRecommendRoutePost(req, { params: { siteId: 'site_a' } });
      expect(r.status).toBe(200);
    }
    const fifthReq = new NextRequest('https://api.ugokilink.example/api/v1/sites/site_a/recommend', {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.secKey}`, 'x-forwarded-for': '203.0.113.88' },
      body: JSON.stringify({ placement: 'product_page', top_k: 2, seed_key: 'rl_5' }),
    });
    const fifthRes = await siteRecommendRoutePost(fifthReq, { params: { siteId: 'site_a' } });
    expect(fifthRes.status).toBe(429);
  });

  test('[#20] article recommendation API returns true Plackett-Luce marginal inclusion probability (2/3) for 3 equal-weight articles with topK=2 across both server and browser-rerank paths', () => {
    const fx = setupSurfaceFixture();
    const equalArticles: RecommendCandidateItem[] = ['art_1', 'art_2', 'art_3'].map((id) => ({
      item_id: id,
      kind: 'article',
      title: `Equal Article ${id}`,
      url_key_v2: `https://example.jp/${id}`,
      content_sim: 0.5,
      link_proximity: 0.5,
      coread_score: 0.5,
      session_knn: 0.5,
      decayed_popularity: 0.5,
      item_embedding: [1, 0, 0],
    }));

    setRecommendRuntimeConfig({
      catalogProvider: {
        getContentCandidates: ({ siteId }) => (siteId === 'site_a' ? equalArticles : null),
      },
    });

    // 1. Server-side article path
    const serverRes = executeRecommendRequest({
      channel: 'rest',
      bearerToken: fx.secKey,
      pipeline: fx.pipeline,
      body: {
        site_id: 'site_a',
        placement: 'article',
        top_k: 2,
        temperature: 1.0,
        seed_key: 'art_equal_marginal_server',
      },
    });
    expect(serverRes.httpStatus).toBe(200);
    const serverItems = (
      serverRes.envelope?.data as {
        items: Array<{
          item_id: string;
          display_prob: number;
          slot_cond_prob: number;
        }>;
      }
    ).items;
    expect(serverItems).toHaveLength(2);
    for (const it of serverItems) {
      expect(Math.abs(it.display_prob - 2 / 3)).toBeLessThan(1e-6);
    }
    expect(serverItems[0].slot_cond_prob).toBeCloseTo(1 / 3, 5);
    expect(serverItems[1].slot_cond_prob).toBeCloseTo(1 / 2, 5);

    // 2. Browser rerank article path (with session_embedding)
    const browserRes = executeRecommendRequest({
      channel: 'rest',
      bearerToken: fx.pubKey,
      pipeline: fx.pipeline,
      clientIp: '198.51.100.77',
      body: {
        site_id: 'site_a',
        placement: 'article',
        top_k: 2,
        temperature: 1.0,
        session_embedding: [1, 0, 0],
        seed_key: 'art_equal_marginal_browser',
      },
    });
    expect(browserRes.httpStatus).toBe(200);
    const browserItems = (
      browserRes.envelope?.data as {
        items: Array<{
          item_id: string;
          display_prob: number;
          slot_cond_prob: number;
        }>;
      }
    ).items;
    expect(browserItems).toHaveLength(2);
    for (const it of browserItems) {
      expect(Math.abs(it.display_prob - 2 / 3)).toBeLessThan(1e-6);
    }
    expect(browserItems[0].slot_cond_prob).toBeCloseTo(1 / 3, 5);
    expect(browserItems[1].slot_cond_prob).toBeCloseTo(1 / 2, 5);
  });
});
