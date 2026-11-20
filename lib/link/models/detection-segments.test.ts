/**
 * UGOKI LINK v2 — Wave 6 (Bundle 6-A) Tests
 *
 * Covers:
 *   1. LP Excess-Loss Detector (H0 KM survival, H1a/H1b Gamma-Poisson P(O/E>1.25)>=0.95,
 *      BH FDR <= 10%, page->template->site backoff, TreeSHAP expectation-only + forbidding
 *      projected lift claims below `proven`, 5 proposal sources ranked by effect*traffic/days)
 *   2. Learned Segments (`centroid_ml` & `density_ml` plugged into Wave 4-A `SegmentRegistry`
 *      and 4-F `MlModelRegistry`, outcome-feature prohibition, Jaccard >= 0.50 ID inheritance,
 *      exact ARI >= 0.75, min size max(500, 3%), cross-period replication gate)
 *   3. Aggregate Replay (Tier 0 transition matrix, re-reads, hesitation hotspots, quorum >=50 PV & >=3 prefixes)
 *      & Long-term k>=50 identifier-free sequence store with legal sign-off gate.
 */

import { MlModelRegistry } from '../ml/foundation/registry';
import { SegmentRegistry } from '../surface/segments';
import {
  buildAggregateReplaySummary,
  buildLongTermGeneralizedSequences,
  computeGammaPoissonExceedanceProb,
  computeReadProgressSurvivalCurve,
  detectExcessLossSections,
  ProjectedLiftBelowProvenError,
  rankLpProposals,
  registerLpDetectionChallengers,
  type SectionSequenceVisitInput,
} from './detection';
import {
  assertNoOutcomeFeaturesInSegment,
  computeAdjustedRandIndex,
  evaluateLearnedSegmentGates,
  fitCentroidSegments,
  fitDensitySegments,
  matchSegmentLineage,
  OutcomeFeatureInSegmentError,
  registerLearnedSegmentsAsChallengers,
  type SessionFeaturePoint,
} from './segments';

describe('Wave 6 Bundle 6-A: LP Excess-Loss Detection & Proposals', () => {
  test('registers H1a and H1b LP detection models strictly as challengers in 4-F MlModelRegistry', () => {
    const registry = new MlModelRegistry();
    const ids = registerLpDetectionChallengers(registry, 'tenant_a', '2026-11-20T00:00:00Z');
    expect(ids).toEqual(['lp_detect_h1a_hazard_v1', 'lp_detect_h1b_cross_site_crawl_llm_v1']);
    for (const id of ids) {
      const entry = registry.getModelVersion(id);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('challenger');
    }
  });

  test('H0 computes exact Kaplan-Meier read-progress survival curve with right-censored visits', () => {
    const obs = [
      { max_section_idx: 0, censored: false }, // exits at sec 0 (1/4 => S0=0.75)
      { max_section_idx: 1, censored: true },  // censored at sec 1 (not an exit)
      { max_section_idx: 1, censored: false }, // exits at sec 1 (1/3 => S1=0.75*(2/3)=0.50)
      { max_section_idx: 2, censored: false }, // reaches sec 2 and exits (1/1 => S2=0)
    ];
    const curve = computeReadProgressSurvivalCurve(obs, 3);
    expect(curve).toHaveLength(3);
    expect(curve[0]).toMatchObject({ at_risk: 4, exits: 1, censored: 0, survival_prob: 0.75 });
    expect(curve[1]).toMatchObject({ at_risk: 3, exits: 1, censored: 1, survival_prob: 0.5 });
    expect(curve[2]).toMatchObject({ at_risk: 1, exits: 1, censored: 0, survival_prob: 0 });
  });

  test('H1a/H1b flags severe excess-loss section via Gamma-Poisson P(O/E>1.25)>=0.95 + BH FDR<=10% and backs off sparse cells', () => {
    // High-power anomalous section: E = 100, O = 175 -> O/E = 1.75
    const highProb = computeGammaPoissonExceedanceProb(175, 100, 1.25, 1.0);
    expect(highProb).toBeGreaterThanOrEqual(0.95);

    // Normal section: E = 100, O = 102 -> O/E = 1.02
    const normalProb = computeGammaPoissonExceedanceProb(102, 100, 1.25, 1.0);
    expect(normalProb).toBeLessThan(0.2);

    const results = detectExcessLossSections(
      [
        {
          page_id: 'lp_1',
          template_id: 'tmpl_sales',
          sec_fp: 'sec_pricing',
          section_role: 'pricing',
          position_frac: 0.6,
          exposures_n: 1000,
          observed_exits: 185,
          expected_exit_rate: 0.1, // E = 100 >= 20 -> stays page_x_section
          expectation_feature_shap: { table_column_count: 0.31, word_density: 0.18 },
        },
        {
          page_id: 'lp_1',
          template_id: 'tmpl_sales',
          sec_fp: 'sec_hero',
          section_role: 'hero',
          position_frac: 0.1,
          exposures_n: 1000,
          observed_exits: 98,
          expected_exit_rate: 0.1, // E = 100 -> normal
        },
        // Two sparse pages sharing tmpl_blog:faq (E = 12 each -> pooled E = 24 >= 20 -> backs off to template_x_role!)
        {
          page_id: 'blog_1',
          template_id: 'tmpl_blog',
          sec_fp: 'sec_faq_1',
          section_role: 'faq',
          position_frac: 0.8,
          exposures_n: 120,
          observed_exits: 13,
          expected_exit_rate: 0.1,
        },
        {
          page_id: 'blog_2',
          template_id: 'tmpl_blog',
          sec_fp: 'sec_faq_2',
          section_role: 'faq',
          position_frac: 0.8,
          exposures_n: 120,
          observed_exits: 11,
          expected_exit_rate: 0.1,
        },
        // Ultra-sparse single page -> backs off to site_x_role (and stays insufficient_data)
        {
          page_id: 'misc_1',
          template_id: 'tmpl_misc',
          sec_fp: 'sec_footer',
          section_role: 'footer_note',
          position_frac: 0.95,
          exposures_n: 50,
          observed_exits: 8,
          expected_exit_rate: 0.1, // E = 5 < 20
        },
      ],
      { rung: 'H1b_cross_site_challenger', fdrAlpha: 0.1, minExpectedForCell: 20 }
    );

    const pricing = results.find((r) => r.key === 'lp_1:sec_pricing');
    const hero = results.find((r) => r.key === 'lp_1:sec_hero');
    const faqPooled = results.find((r) => r.key === 'template:tmpl_blog:faq');
    const siteRole = results.find((r) => r.key === 'site_role:footer_note');

    expect(pricing).toBeDefined();
    expect(pricing?.aggregation_level).toBe('page_x_section');
    expect(pricing?.evidence_level).toBe('inferred');
    expect(pricing?.flagged).toBe(true);
    expect(pricing?.fdr_q_value).toBeLessThanOrEqual(0.1);
    expect(pricing?.expectation_treeshap[0].feature).toBe('table_column_count');

    expect(hero?.flagged).toBe(false);
    expect(faqPooled?.aggregation_level).toBe('template_x_role');
    expect(faqPooled?.status).toBe('ok');
    expect(siteRole?.aggregation_level).toBe('site_x_role');
    expect(siteRole?.status).toBe('insufficient_data');
    expect(siteRole?.flagged).toBe(false);
  });

  test('ranks all 5 proposal sources + 4-G hypothesis at evidence=planned and forbids projected lift below proven', () => {
    const ranked = rankLpProposals([
      {
        proposal_id: 'p_rule',
        source: 'rule_hit',
        target_page_id: 'lp_1',
        target_sec_fp: 'sec_hero',
        typed_patch_op: 'add_above_fold_cta',
        hypothesis_text: 'CTA missing above fold',
        prior_class_effect_band: 0.08,
        daily_eligible_traffic: 1000,
        days_to_power: 16, // score = 5.0
      },
      {
        proposal_id: 'p_probe',
        source: 'targeted_probe',
        target_page_id: 'lp_1',
        target_sec_fp: 'sec_price',
        typed_patch_op: 'simplify_plan_table',
        hypothesis_text: 'High hesitation on pricing grid',
        prior_class_effect_band: 0.12,
        daily_eligible_traffic: 1000,
        days_to_power: 10, // score = 12.0 -> rank 1
      },
      {
        proposal_id: 'p_exemplar',
        source: 'exemplar_contrast',
        target_page_id: 'lp_1',
        target_sec_fp: 'sec_proof',
        typed_patch_op: 'insert_case_metrics',
        hypothesis_text: 'Top exemplar includes quantified proof',
        prior_class_effect_band: 0.06,
        daily_eligible_traffic: 800,
        days_to_power: 12, // score = 4.0
      },
      {
        proposal_id: 'p_search',
        source: 'search_gap',
        target_page_id: 'lp_1',
        target_sec_fp: 'sec_faq',
        typed_patch_op: 'add_shipping_faq',
        hypothesis_text: 'Unanswered site search query: shipping fees',
        prior_class_effect_band: 0.05,
        daily_eligible_traffic: 500,
        days_to_power: 10, // score = 2.5
      },
      {
        proposal_id: 'p_rec',
        source: 'recommender_to_link',
        target_page_id: 'lp_1',
        target_sec_fp: 'sec_compare',
        typed_patch_op: 'insert_inline_comparison_link',
        hypothesis_text: 'Readers jump to comparison guide from here',
        prior_class_effect_band: 0.09,
        daily_eligible_traffic: 900,
        days_to_power: 9, // score = 9.0 -> rank 2
      },
      {
        proposal_id: 'p_llm',
        source: 'llm_hypothesis_challenger',
        target_page_id: 'lp_1',
        target_sec_fp: 'sec_price',
        typed_patch_op: 'clarify_cancel_policy',
        hypothesis_text: 'LLM contrast flags hidden cancellation terms',
        prior_class_effect_band: 0.07,
        daily_eligible_traffic: 1000,
        days_to_power: 14, // score = 5.0
      },
    ]);

    expect(ranked).toHaveLength(6);
    expect(ranked[0].proposal_id).toBe('p_probe');
    expect(ranked[1].proposal_id).toBe('p_rec');
    expect(ranked.every((p) => p.evidence_level === 'planned')).toBe(true);

    // Poison guard: projected lift claim below `proven` MUST throw!
    expect(() =>
      rankLpProposals([
        {
          proposal_id: 'p_bad',
          source: 'rule_hit',
          target_page_id: 'lp_1',
          target_sec_fp: 'sec_hero',
          typed_patch_op: 'rewrite_h1',
          hypothesis_text: 'Illegal lift projection',
          prior_class_effect_band: 0.1,
          daily_eligible_traffic: 500,
          days_to_power: 10,
          projected_lift_pct: 14.5,
          evidence_level: 'inferred',
        },
      ])
    ).toThrow(ProjectedLiftBelowProvenError);
  });
});

describe('Wave 6 Bundle 6-A: Learned Segments (centroid_ml & density_ml)', () => {
  const safeFeatures = ['scroll_velocity_norm', 'dwell_ratio_pricing', 're_read_count'];

  function makeTwoClusterPoints(countPerCluster: number): SessionFeaturePoint[] {
    const pts: SessionFeaturePoint[] = [];
    for (let i = 0; i < countPerCluster; i++) {
      const jitter = (i % 7) * 0.01;
      pts.push({
        session_id: `sess_a_${i}`,
        features: [0.1 + jitter, 0.15 + jitter, 0.05],
      });
      pts.push({
        session_id: `sess_b_${i}`,
        features: [0.9 - jitter, 0.85 - jitter, 0.95],
      });
    }
    return pts;
  }

  test('prohibits outcome-coupled features (cvr, revenue, aff_click, purchase) in segment clustering', () => {
    expect(() =>
      assertNoOutcomeFeaturesInSegment(['scroll_velocity', 'session_cvr', 'order_revenue'])
    ).toThrow(OutcomeFeatureInSegmentError);

    expect(() =>
      fitCentroidSegments({
        featureNames: ['scroll_velocity', 'aff_click_flag'],
        points: [{ session_id: 's1', features: [0.2, 1] }],
        k: 1,
      })
    ).toThrow(OutcomeFeatureInSegmentError);
  });

  test('fits centroid_ml & density_ml, computes exact ARI, inherits lineage ID at Jaccard >= 0.50, and registers in 4-A SegmentRegistry + 4-F MlModelRegistry', () => {
    const pts = makeTwoClusterPoints(30);
    const centroidFit = fitCentroidSegments({ featureNames: safeFeatures, points: pts, k: 2 });
    const densityFit = fitDensitySegments({
      featureNames: safeFeatures,
      points: [...pts, { session_id: 'sess_outlier', features: [5.0, 5.0, 5.0] }],
      eps: 0.25,
      minPts: 4,
    });

    expect(centroidFit.clusters).toHaveLength(2);
    expect(densityFit.clusters).toHaveLength(2);
    expect(densityFit.noise_count).toBe(1);
    expect(densityFit.noise_share).toBeLessThan(0.2);

    // ARI between centroid and density assignments on the 60 core points should be 1.0
    const ari = computeAdjustedRandIndex(centroidFit.assignments, densityFit.assignments.slice(0, 60));
    expect(ari).toBe(1);

    // Lineage inheritance: cluster with >= 0.50 Jaccard inherits 'seg_returning_evaluators',
    // while unrelated previous cluster does NOT match -> fresh ID minted
    const prevMembers = [
      {
        segmentId: 'seg_returning_evaluators',
        member_session_ids: centroidFit.clusters[0].member_session_ids.slice(0, 22), // 22/30 = 0.733 >= 0.50
      },
      {
        segmentId: 'seg_stale_old',
        member_session_ids: ['other_1', 'other_2', 'other_3'], // 0 overlap
      },
    ];
    const lineage = matchSegmentLineage(prevMembers, centroidFit.clusters);
    expect(lineage[0].assigned_segment_id).toBe('seg_returning_evaluators');
    expect(lineage[0].inherited_from_segment_id).toBe('seg_returning_evaluators');
    expect(lineage[0].jaccard_overlap).toBeGreaterThanOrEqual(0.5);
    expect(lineage[1].inherited_from_segment_id).toBeNull();
    expect(lineage[1].assigned_segment_id).toMatch(/^seg_ml_/);

    // Quality gate: min size = max(500, 3%), ARI >= 0.75, cross-period replication required for outcome claim
    const gateFailSmall = evaluateLearnedSegmentGates({
      kind: 'centroid_ml',
      totalSessions: 60,
      clusters: centroidFit.clusters,
      bootstrapAri: 0.88,
      outcomeDifferenceReplicatedInSecondPeriod: false,
    });
    expect(gateFailSmall.passed).toBe(false);
    expect(gateFailSmall.min_cluster_size_required).toBe(500);
    expect(gateFailSmall.outcome_diff_claim_allowed).toBe(false);

    // Large well-separated clusters passing all gates
    const bigClusters = centroidFit.clusters.map((c) => ({ ...c, size: 650, share: 0.5 }));
    const gatePassNoRepl = evaluateLearnedSegmentGates({
      kind: 'centroid_ml',
      totalSessions: 1300,
      clusters: bigClusters,
      bootstrapAri: 0.86,
      outcomeDifferenceReplicatedInSecondPeriod: false,
    });
    expect(gatePassNoRepl.passed).toBe(true);
    expect(gatePassNoRepl.outcome_diff_claim_allowed).toBe(false);

    const gatePassReplicated = evaluateLearnedSegmentGates({
      kind: 'density_ml',
      totalSessions: 1300,
      clusters: bigClusters,
      bootstrapAri: 0.91,
      centroidReferenceAri: 0.86,
      noiseShare: 0.08,
      outcomeDifferenceReplicatedInSecondPeriod: true,
    });
    expect(gatePassReplicated.passed).toBe(true);
    expect(gatePassReplicated.outcome_diff_claim_allowed).toBe(true);

    // Plugs directly into Wave 4-A SegmentRegistry AND 4-F MlModelRegistry
    const segRegistry = new SegmentRegistry();
    const mlRegistry = new MlModelRegistry();
    const registered = registerLearnedSegmentsAsChallengers({
      segmentRegistry: segRegistry,
      mlRegistry,
      tenantId: 'tenant_1',
      siteId: 'site_1',
      kind: 'centroid_ml',
      modelId: 'seg_kmeans_v1',
      modelVersion: '2026-11-20',
      featureNames: safeFeatures,
      clusters: centroidFit.clusters,
      lineage,
      llmClusterNames: {
        0: { name: 'Deep Price Comparers', description: 'High pricing dwell & re-read count' },
      },
      createdByPrincipalId: 'ml_pipeline',
      nowIso: '2026-11-20T00:00:00Z',
    });

    expect(registered).toHaveLength(2);
    expect(registered[0].segmentId).toBe('seg_returning_evaluators');
    expect(registered[0].name).toBe('Deep Price Comparers');
    expect(segRegistry.getLatest('tenant_1', 'site_1', 'seg_returning_evaluators')?.kind).toBe('centroid_ml');
    expect(mlRegistry.getModelVersion('seg_kmeans_v1@2026-11-20')?.status).toBe('challenger');
  });
});

describe('Wave 6 Bundle 6-A: Aggregate Replay (Tier 0) & k>=50 Long-Term Sequences', () => {
  function makeVisit(idx: number, prefix: string, tokens: readonly string[]): SectionSequenceVisitInput {
    return {
      network_prefix_hash: prefix,
      device_class: 'mobile',
      page_id: 'lp_1',
      variant_key: 'control',
      skel_fp: 'skel_v1',
      section_tokens: tokens,
      section_hesitation_ms: { sec_price: 4200 + (idx % 5) * 100, sec_hero: 1200 },
    };
  }

  test('enforces >=50 PVs AND >=3 distinct network prefixes quorum on Tier 0 Aggregate Replay', () => {
    // 50 PVs but only 2 distinct prefixes -> MUST return insufficient_data!
    const lowPrefixVisits = Array.from({ length: 50 }, (_, i) =>
      makeVisit(i, i % 2 === 0 ? 'net_a' : 'net_b', ['sec_hero', 'sec_price', 'sec_cta'])
    );
    const denied = buildAggregateReplaySummary(lowPrefixVisits);
    expect(denied.status).toBe('insufficient_data');
    expect(denied.distinct_prefixes).toBe(2);

    // 55 PVs across 4 prefixes with backward re-reads (sec_cta -> sec_price) -> ok!
    const validVisits = Array.from({ length: 55 }, (_, i) =>
      makeVisit(
        i,
        `net_${i % 4}`,
        i % 3 === 0 ? ['sec_hero', 'sec_price', 'sec_cta', 'sec_price'] : ['sec_hero', 'sec_price', 'sec_cta']
      )
    );
    const ok = buildAggregateReplaySummary(validVisits, {
      sectionOrder: ['sec_hero', 'sec_price', 'sec_cta'],
    });
    expect(ok.status).toBe('ok');
    expect(ok.tier).toBe(0);
    expect(ok.transition_matrix['sec_hero']['sec_price']).toBe(1);
    expect(ok.reread_patterns[0]).toMatchObject({ from_sec: 'sec_cta', to_sec: 'sec_price' });
    expect(ok.hesitation_hotspots[0].sec_fp).toBe('sec_price');
    expect(ok.window_notice).toContain('30-day');
  });

  test('enforces legal sign-off and k>=50 suppression on identifier-free long-term sequence store', () => {
    const frequentRows = Array.from({ length: 55 }, () => ({
      week_bucket: '2026-W47',
      device_class: 'mobile' as const,
      role_tokens: ['hero', 'price', 'cta'],
    }));
    const rareRows = Array.from({ length: 12 }, () => ({
      week_bucket: '2026-W47',
      device_class: 'desktop' as const,
      role_tokens: ['hero', 'faq', 'legal', 'exit'],
    }));

    const unsigned = buildLongTermGeneralizedSequences({
      rawRows: [...frequentRows, ...rareRows],
      legalSignOffRecorded: false,
    });
    expect(unsigned.status).toBe('not_entitled');
    expect(unsigned.kept_rows).toHaveLength(0);

    const signed = buildLongTermGeneralizedSequences({
      rawRows: [...frequentRows, ...rareRows],
      legalSignOffRecorded: true,
    });
    expect(signed.status).toBe('ok');
    expect(signed.contains_any_identifier).toBe(false);
    expect(signed.kept_rows).toHaveLength(1);
    expect(signed.kept_rows[0].occurrence_count).toBe(55);
    expect(signed.suppressed_below_k_count).toBe(12);
  });
});
