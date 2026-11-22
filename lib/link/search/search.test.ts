import { NotEntitledError } from '@/packages/contract/ledgers'

import {
  authorizeMajorDirectoryWave2,
  computeCitationBracketing,
  computeQueryReachOutputs,
  computeReferrerlessAiTrafficLift,
  createEligibilitySnapshot,
  DEFAULT_JP_EMBEDDING_CANDIDATES,
  detectCrawlerTrafficSpike,
  DeterministicAssistantApiStub,
  DeterministicJapaneseTestEmbedder,
  DeterministicSerpProbeStub,
  evaluateCanaryCompliance,
  evaluateEligibilityRandomizationOutcome,
  evaluateRevisionProbe,
  evaluateTrainingCrawlerValue,
  Ga4SyncService,
  GscIngestStore,
  mapQueryToAnswerSection,
  mintCanaryConfirmationUrl,
  planEligibilityDirectoryRandomization,
  rejectUnknowablePerVisitQueryMetric,
  runJapaneseEmbeddingSelectionBenchmark,
  sampleQueriesByGscImpressions,
  storeProbeAnswerRecord,
  type JapaneseEmbeddingEvalSuite,
} from './index'

const APPROVED_D13 = () =>
  ({
    entitled: true,
    status: 'ok' as const,
    decisionId: 'D-13' as const,
    outcome: 'approved' as const,
    decidedAt: '2026-11-20',
  })

// ===========================================================================
// 1. GSC Ingest & GA4 Page × Day Sync (§6.6, §11.10)
// ===========================================================================

describe('GSC Ingest & GA4 Page × Day Sync (§6.6, §11.10)', () => {
  test('upserts GSC rows idempotently keyed by computeUrlKeyV2 url_id and preserves nulls', () => {
    const store = new GscIngestStore()
    const first = store.upsertBatch([
      {
        tenant_id: 't1',
        site_id: 's1',
        page_url: 'https://www.example.jp/guide/?utm_source=google',
        query: '料金 比較',
        date: '2026-11-20',
        device: 'MOBILE',
        country: 'jpn',
        clicks: 42,
        impressions: 500,
        ctr: 0.084,
        position: null, // unmeasured remains null
      },
    ])
    expect(first.inserted).toBe(1)
    expect(first.updated).toBe(0)
    expect(first.rows[0].url_key_v2).toBe('example.jp/guide')
    expect(first.rows[0].position).toBeNull()

    // Re-ingest same logical URL without www and without utm_source -> idempotent update!
    const second = store.upsertBatch([
      {
        tenant_id: 't1',
        site_id: 's1',
        page_url: 'https://example.jp/guide',
        query: '料金 比較',
        date: '2026-11-20',
        device: 'MOBILE',
        country: 'JPN',
        clicks: 45,
        impressions: 520,
        ctr: 0.0865,
        position: 2.3,
      },
    ])
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(1)
    expect(store.listByPage('t1', 's1', first.rows[0].url_id)).toHaveLength(1)
  })

  test('GA4 sync requires owner authorization, rejects visitor-level ID columns, tags external_ga4, and ingests pre-migration AI history', () => {
    const ga4 = new Ga4SyncService()

    // Unapproved connection -> NotEntitledError
    expect(() =>
      ga4.ingestPageDayAggregates(
        {
          tenant_id: 't1',
          site_id: 's1',
          property_id: 'properties/123',
          owner_connection_approved: false,
          connection_token: null,
          approved_at: null,
        },
        [{ page_url: 'https://example.jp/guide', date: '2026-11-20', screen_page_views: 100, conversions: 5 }],
      ),
    ).toThrow(NotEntitledError)

    const auth = {
      tenant_id: 't1',
      site_id: 's1',
      property_id: 'properties/123',
      owner_connection_approved: true,
      connection_token: 'oauth_tok_valid',
      approved_at: '2026-11-20T00:00:00Z',
    }

    // Visitor-level column (`client_id` / `user_pseudo_id`) MUST be rejected!
    expect(() =>
      ga4.ingestPageDayAggregates(auth, [
        {
          page_url: 'https://example.jp/guide',
          date: '2026-11-20',
          screen_page_views: 1,
          conversions: 0,
          client_id: '12345.67890',
        },
      ]),
    ).toThrow(/visitor-level column/i)

    const res = ga4.ingestPageDayAggregates(auth, [
      {
        page_url: 'https://example.jp/guide',
        date: '2026-11-20',
        screen_page_views: 200,
        conversions: 10,
      },
    ])
    expect(res.ingested).toBe(1)
    expect(res.rows[0].evidence).toBe('observed')
    expect(res.rows[0].source).toBe('external_ga4')

    const recon = ga4.reconcileWithInternalMetrics({
      tenant_id: 't1',
      site_id: 's1',
      url_id: res.rows[0].url_id,
      date: '2026-11-20',
      internal_pvs: 204,
      internal_conversions: 10,
    })
    expect(recon.matched).toBe(true)
    expect(recon.pv_ratio_internal_over_ga4).toBeCloseTo(1.02, 4)

    // Pre-migration AI referrer history
    const aiHist = ga4.ingestPreMigrationAiReferrerHistory(auth, [
      {
        page_url: 'https://example.jp/guide',
        date: '2026-10-01',
        referrer_host: 'chatgpt.com',
        sessions: 35,
        conversions: 2,
      },
    ])
    expect(aiHist).toHaveLength(1)
    expect(aiHist[0].source).toBe('external_ga4')
    expect(aiHist[0].historical_pre_migration).toBe(true)
  })
})

// ===========================================================================
// 2. Query -> Answer Section Hybrid Ranker & Fréchet/Manski Bounds (§6.6)
// ===========================================================================

describe('Query -> Answer Section Mapper & Assumption-Free Bounds (§6.6)', () => {
  test('ranks clear answer section via hybrid embedding + Japanese n-gram lexical score, returns no_clear_answer_section on tight margin', () => {
    const clear = mapQueryToAnswerSection({
      query: '解約方法 違約金',
      query_embedding: [0, 1, 0],
      candidates: [
        {
          section_uid: 'sec_price',
          sec_fp: 'fp_1',
          body_fp: 'b1',
          heading_text: '料金プラン',
          body_text: '月額3,300円から始められます。',
          embedding: [1, 0, 0],
        },
        {
          section_uid: 'sec_cancel',
          sec_fp: 'fp_2',
          body_fp: 'b2',
          heading_text: '解約方法と違約金について',
          body_text: '解約は管理画面から1分で完了し、違約金は一切かかりません。',
          embedding: [0.05, 0.99, 0],
        },
      ],
    })
    expect(clear.status).toBe('matched')
    expect(clear.best_section_uid).toBe('sec_cancel')

    // Ambiguous tied candidates -> margin below threshold -> no_clear_answer_section
    const ambiguous = mapQueryToAnswerSection({
      query: '特徴',
      query_embedding: [0.7, 0.7, 0],
      candidates: [
        {
          section_uid: 'sec_a',
          sec_fp: 'fp_a',
          body_fp: 'ba',
          heading_text: '特徴1',
          body_text: '便利な特徴があります。',
          embedding: [0.71, 0.7, 0],
        },
        {
          section_uid: 'sec_b',
          sec_fp: 'fp_b',
          body_fp: 'bb',
          heading_text: '特徴2',
          body_text: '便利な特徴があります。',
          embedding: [0.7, 0.71, 0],
        },
      ],
    })
    expect(ambiguous.status).toBe('no_clear_answer_section')
    expect(ambiguous.best_section_uid).toBeNull()
  })

  test('computes exact Fréchet/Manski bounds (tight ONLY when query dominates) and rejects unknowable per-visit query metrics (tel.U4)', () => {
    // Dominant query (90% of landings), overall reach = 0.70 -> lower = (0.7 - 0.1)/0.9 = 0.6667, upper = 0.7/0.9 = 0.7778, width = 0.1111 <= 0.30!
    const dominant = computeQueryReachOutputs({
      query: 'メイン検索語',
      section_uid: 'sec_1',
      page_google_reach_rate: 0.7,
      page_google_landing_pvs: 1000,
      query_gsc_clicks: 900,
      total_page_gsc_clicks: 1000,
      model_estimate: { point: 0.72, uninformative_prior_lower: 0.64, uninformative_prior_upper: 0.8 },
    })
    expect(dominant.page_google_reach.evidence).toBe('observed')
    expect(dominant.assumption_free_bounds.evidence).toBe('inferred')
    expect(dominant.assumption_free_bounds.point_lower).toBeCloseTo(0.6 / 0.9, 5)
    expect(dominant.assumption_free_bounds.point_upper).toBeCloseTo(0.7 / 0.9, 5)
    // Finite-sample simultaneous Wilson outer Fréchet bounds strictly contain the plug-in bounds while staying narrow at N=1000!
    expect(dominant.assumption_free_bounds.lower).toBeLessThan(dominant.assumption_free_bounds.point_lower)
    expect(dominant.assumption_free_bounds.upper).toBeGreaterThan(dominant.assumption_free_bounds.point_upper)
    expect(dominant.assumption_free_bounds.is_narrow).toBe(true)
    expect(dominant.statistical_model_estimate.status).toBe('ok')

    // Small-share query (20% of landings) -> wide uninformative bounds [0, 1] + wide model interval suppressed
    const minor = computeQueryReachOutputs({
      query: 'ロングテール語',
      section_uid: 'sec_1',
      page_google_reach_rate: 0.5,
      page_google_landing_pvs: 1000,
      query_gsc_clicks: 200,
      total_page_gsc_clicks: 1000,
      model_estimate: { point: 0.52, uninformative_prior_lower: 0.2, uninformative_prior_upper: 0.85 },
    })
    expect(minor.assumption_free_bounds.lower).toBe(0)
    expect(minor.assumption_free_bounds.upper).toBe(1)
    expect(minor.assumption_free_bounds.is_narrow).toBe(false)
    expect(minor.statistical_model_estimate.status).toBe('insufficient_data')
    expect(minor.statistical_model_estimate.estimate).toBeNull()

    // Unknowables ledger (tel.U4) refusal for per-visit query / bounce / CVR
    for (const metric of ['per_visit_search_query', 'query_bounce_rate', 'query_cvr'] as const) {
      const ref = rejectUnknowablePerVisitQueryMetric(metric)
      expect(ref.status).toBe('not_collected')
      expect(ref.unknowable_by_design).toBe(true)
      expect(ref.limit_id).toBe('tel.U4')
      expect(ref.value).toBeNull()
    }
  })
})

// ===========================================================================
// 3. Japanese Open Embedding Model Selection Harness (§8.7)
// ===========================================================================

describe('Japanese Commercial Open Embedding Selection Harness (§8.7)', () => {
  test('disqualifies non-commercial/unverified models and selects top-scoring licensed model on 3 JP tasks', async () => {
    const suite: JapaneseEmbeddingEvalSuite = {
      suite_version: 'jp-emb-eval/1',
      retrieval_cases: [
        {
          query: '月額コストはいくらですか',
          relevant_section_id: 'sec_price',
          sections: [
            { id: 'sec_price', text: '料金プランと月額費用のご案内。税込3,300円です。' },
            { id: 'sec_cancel', text: '退会・解約の手続きとキャンセル方法。' },
          ],
        },
        {
          query: '返品や発送の送料について',
          relevant_section_id: 'sec_ship',
          sections: [
            { id: 'sec_review', text: '利用者の口コミと評判・体験談まとめ。' },
            { id: 'sec_ship', text: '在庫あり商品の発送日数と送料・お届け目安。' },
          ],
        },
      ],
      synonym_clusters: [
        {
          cluster_id: 'pricing',
          texts: ['月額料金の案内', 'プランの価格と費用', '税込コスト一覧'],
        },
        {
          cluster_id: 'cancellation',
          texts: ['解約の手続き方法', '退会とキャンセル規約', '停止と違約金の確認'],
        },
      ],
      page_type_prototypes: [
        { page_type: 'comparison', text: 'おすすめ製品の比較ランキングとスペック違い一覧' },
        { page_type: 'faq', text: 'よくある質問と疑問・問い合わせサポートFAQ' },
      ],
      page_type_test_cases: [
        { page_type: 'comparison', text: '人気モデル3社のスペック比較とおすすめ違い' },
        { page_type: 'faq', text: 'よくある質問FAQとサポートへの問い合わせ' },
      ],
    }

    const nonCommercialSpec = {
      model_id: 'research/non-commercial-giant',
      family: 'research',
      dimensions: 1024,
      license_spdx: 'CC-BY-NC-4.0',
      commercial_use_allowed: false,
      license_verified: true,
      release_ref: 'hf:research/non-commercial-giant',
    }

    const providers = [
      new DeterministicJapaneseTestEmbedder(nonCommercialSpec, { semantic_weight: 5.0, noise_level: 0 }),
      new DeterministicJapaneseTestEmbedder(DEFAULT_JP_EMBEDDING_CANDIDATES[0], { semantic_weight: 0.5, noise_level: 2.0 }),
      new DeterministicJapaneseTestEmbedder(DEFAULT_JP_EMBEDDING_CANDIDATES[2], { semantic_weight: 4.0, noise_level: 0.0 }),
      new DeterministicJapaneseTestEmbedder(DEFAULT_JP_EMBEDDING_CANDIDATES[3], { semantic_weight: 1.5, noise_level: 0.8 }),
    ]

    const artifact = await runJapaneseEmbeddingSelectionBenchmark({
      providers,
      suite,
      evaluated_at: '2026-11-20T12:00:00Z',
    })

    // Non-commercial model MUST be disqualified even with strong semantic weight
    const nonCommResult = artifact.candidates.find((c) => c.model_id === 'research/non-commercial-giant')!
    expect(nonCommResult.eligible).toBe(false)
    expect(nonCommResult.disqualification_reason).toBe('non_commercial_license')

    // Strongest licensed candidate (`cl-nagoya/ruri-v3-310m`) wins!
    expect(artifact.selected_model_id).toBe('cl-nagoya/ruri-v3-310m')
    expect(artifact.selected_license_spdx).toBe('Apache-2.0')
    expect(artifact.selected_composite_score).toBeGreaterThan(0.8)
    expect(artifact.content_sha256).toHaveLength(64)
  })
})

// ===========================================================================
// 4. AI Search Probing, D-13 Answer Guard, Bracketing, Canary & Eligibility Randomization (§7.7–§7.8)
// ===========================================================================

describe('AI Search Probe, Eligibility Ledger, D-13 Guard, Citation Bracketing & Randomization (§7.7–§7.8)', () => {
  test('records Stage 0 eligibility, samples GSC queries proportionally, probes SERP/API, enforces D-13 raw text guard, and checks revision/canary', async () => {
    const elig = createEligibilitySnapshot({
      tenant_id: 't1',
      site_id: 's1',
      captured_at: '2026-11-20T00:00:00Z',
      robots_txt_body: 'User-agent: Google-Extended\nDisallow: /\n',
      cdn_policy: { ai_crawl_challenge: false, waf_bot_fight_mode: false, note: null },
      token_policies: { 'Google-Extended': 'disallow', GPTBot: 'allow' },
    })
    expect(elig.stage).toBe(0)
    expect(elig.evidence).toBe('observed')

    // GSC impression-proportional sampling
    const sampled = sampleQueriesByGscImpressions({
      gsc_rows: [
        { query: '人気クエリA', impressions: 10000 },
        { query: '中規模クエリB', impressions: 2000 },
        { query: '極小クエリC', impressions: 5 },
      ],
      sample_size: 2,
      seed: 'seed_2026_11',
    })
    expect(sampled).toHaveLength(2)
    expect(sampled.some((s) => s.query === '人気クエリA')).toBe(true)

    // SERP AI Overview + Official Assistant API probes
    const serpStub = new DeterministicSerpProbeStub({
      '人気クエリA': {
        cited_urls: ['https://example.jp/guide?utm_source=ai'],
        answer_text: '新料金は月額3,980円に改定されました。詳細は公式ガイドをご確認ください。',
      },
    })
    const apiStub = new DeterministicAssistantApiStub('openai_api', 'chatgpt_api', {
      '人気クエリA': {
        cited_urls: ['https://example.jp/guide'],
        answer_text: '旧料金は月額3,300円です。',
      },
    })

    const serpRaw = await serpStub.probeAiOverview('人気クエリA', 'jp_mobile_v1', '2026-11-20T12:00:00Z')
    const apiRaw = await apiStub.probeAssistant('人気クエリA', 'gpt5_search_v1', '2026-11-20T12:00:00Z')

    // Default storage: structured extraction + hashes ONLY (no raw text!)
    const defaultRec = storeProbeAnswerRecord({
      tenant_id: 't1',
      site_id: 's1',
      raw: serpRaw,
    })
    expect(defaultRec.evidence).toBe('observed')
    expect(defaultRec.scope).toBe('surface_and_configuration_only')
    expect(defaultRec.raw_answer_stored).toBe(false)
    expect(defaultRec.encrypted_raw_answer_envelope).toBeNull()
    expect(defaultRec.cited_url_keys_v2).toEqual(['example.jp/guide'])
    expect(defaultRec.span_sha256_hashes.length).toBeGreaterThan(0)

    // Raw text retention fails closed when D-13 is pending
    expect(() =>
      storeProbeAnswerRecord({
        tenant_id: 't1',
        site_id: 's1',
        raw: apiRaw,
        request_raw_text_retention: true,
        provider_legal_signoffs: { openai_api: true },
      }),
    ).toThrow(NotEntitledError)

    // Even with D-13 approved, missing per-provider sign-off fails closed!
    expect(() =>
      storeProbeAnswerRecord({
        tenant_id: 't1',
        site_id: 's1',
        raw: apiRaw,
        request_raw_text_retention: true,
        provider_legal_signoffs: { openai_api: false },
        decisionCheckOverride: APPROVED_D13,
      }),
    ).toThrow(NotEntitledError)

    // With BOTH D-13 + per-provider sign-off -> encrypted TTL envelope stored
    const rawOk = storeProbeAnswerRecord({
      tenant_id: 't1',
      site_id: 's1',
      raw: apiRaw,
      request_raw_text_retention: true,
      provider_legal_signoffs: { openai_api: true },
      raw_retention_ttl_days: 30,
      decisionCheckOverride: APPROVED_D13,
    })
    expect(rawOk.raw_answer_stored).toBe(true)
    expect(rawOk.encrypted_raw_answer_envelope).not.toBeNull()

    // Revision probe distinguishes post-revision vs pre-revision cached edition
    expect(
      evaluateRevisionProbe({
        answer_text: serpRaw.answer_text,
        pre_revision_marker: '3,300円',
        post_revision_marker: '3,980円',
      }).detected_version,
    ).toBe('post_revision')
    expect(
      evaluateRevisionProbe({
        answer_text: apiRaw.answer_text,
        pre_revision_marker: '3,300円',
        post_revision_marker: '3,980円',
      }).detected_version,
    ).toBe('pre_revision')

    // Canary URL checks real fetcher & detects robots.txt violation
    const canary = mintCanaryConfirmationUrl({
      host: 'example.jp',
      tenant_id: 't1',
      site_id: 's1',
      surface: 'chatgpt_api',
      nonce: 'n_123',
      secret: 'canary-secret',
      robots_disallowed: true,
    })
    const canaryEval = evaluateCanaryCompliance({
      canary,
      server_observations: [
        {
          path: canary.path,
          raw_ua: 'ChatGPT-User/1.0',
          ua_family_version: 'ChatGPT-User/1',
          observed_at: '2026-11-20T12:01:00Z',
        },
      ],
    })
    expect(canaryEval.fetched).toBe(true)
    expect(canaryEval.robots_violated).toBe(true)
  })

  test('computes two-sided citation bracketing, referrerless 30m lift, unknowable training value, spike detection & eligibility randomization', () => {
    const bracket = computeCitationBracketing({
      wild_server_fetches: 1000,
      probe_cited_count: 50,
      probe_cited_and_fetched_count: 25, // P(fetched|cited) = 0.50
      probe_fetched_count: 100,
      probe_fetched_and_cited_count: 25, // P(cited|fetched) = 0.25
    })
    expect(bracket.evidence).toBe('inferred')
    expect(bracket.upper_identifiable).toBe(true)
    expect(bracket.point_wild_citations_lower).toBeCloseTo(250, 4)
    expect(bracket.point_wild_citations_upper).toBeCloseTo(500, 4)
    // Conservative simultaneous Wilson CIs widen [lower, upper] strictly around [250, 500]
    expect(bracket.wild_citations_lower).toBeLessThan(250)
    expect(bracket.wild_citations_upper!).toBeGreaterThan(500)

    const lift = computeReferrerlessAiTrafficLift({
      visits_in_30m_after_fetch: 120,
      visits_in_matched_control_30m: 85,
      event_count: 20,
    })
    expect(lift.evidence).toBe('inferred')
    expect(lift.point_lift_visits).toBe(35)

    // Training crawler economic value is ALWAYS unknowable_by_design
    const trainVal = evaluateTrainingCrawlerValue()
    expect(trainVal.unknowable_by_design).toBe(true)
    expect(trainVal.value_jpy).toBeNull()

    // 4-week spike detection (act.G34)
    expect(
      detectCrawlerTrafficSpike({
        current_hour_requests: 400,
        historical_same_slot_weeks: [80, 90, 85, 95],
      }).spike_detected,
    ).toBe(true)
    expect(
      detectCrawlerTrafficSpike({
        current_hour_requests: 400,
        historical_same_slot_weeks: [80, 90], // < 4 weeks -> baseline not ready
      }).baseline_ready,
    ).toBe(false)

    // Eligibility randomization: MUST reject experiment-only change without owner independent intent!
    const pairs = Array.from({ length: 6 }, (_, i) => ({
      pair_id: `pair_${i + 1}`,
      dir_a: `/cat-${i + 1}a/`,
      dir_b: `/cat-${i + 1}b/`,
      is_major_search_directory: i === 5,
      baseline_weekly_search_visits: 100,
    }))

    expect(() =>
      planEligibilityDirectoryRandomization({
        experiment_id: 'exp_elig_1',
        tenant_id: 't1',
        site_id: 's1',
        owner_intended_change_independently: false,
        human_initial_approval: true,
        pairs,
        search_traffic_risk_budget: 500,
        seed: 's1',
      }),
    ).toThrow(NotEntitledError)

    const plan = planEligibilityDirectoryRandomization({
      experiment_id: 'exp_elig_1',
      tenant_id: 't1',
      site_id: 's1',
      owner_intended_change_independently: true,
      human_initial_approval: true,
      pairs,
      search_traffic_risk_budget: 500,
      seed: 's1',
    })
    expect(plan.total_pairs).toBe(6)
    expect(plan.within_risk_budget).toBe(true)
    expect(plan.assignments[5].wave).toBe(2)
    expect(plan.assignments[5].requires_second_human_approval).toBe(true)

    // Wave 2 major directories blocked until second human approval
    expect(
      authorizeMajorDirectoryWave2({ plan, second_human_approval: false }).authorized,
    ).toBe(false)
    expect(
      authorizeMajorDirectoryWave2({ plan, second_human_approval: true }).authorized,
    ).toBe(true)

    // Outcome evaluation: < 6 pairs -> observed with shortfall; >= 6 pairs & units -> proven; guardrail breach -> auto_rollback!
    const underpowered = evaluateEligibilityRandomizationOutcome({
      paired_directories: 4,
      observed_units: 300,
      planner_required_units: 500,
      search_traffic_change_ratio: 0.02,
      indexed_pages_change_ratio: 0.0,
    })
    expect(underpowered.evidence_level).toBe('observed')
    expect(underpowered.additional_pairs_needed).toBe(2)
    expect(underpowered.additional_units_needed).toBe(200)

    const proven = evaluateEligibilityRandomizationOutcome({
      paired_directories: 6,
      observed_units: 600,
      planner_required_units: 500,
      search_traffic_change_ratio: 0.01,
      indexed_pages_change_ratio: -0.02,
    })
    expect(proven.evidence_level).toBe('proven')
    expect(proven.auto_rollback_triggered).toBe(false)

    const rolledBack = evaluateEligibilityRandomizationOutcome({
      paired_directories: 6,
      observed_units: 600,
      planner_required_units: 500,
      search_traffic_change_ratio: -0.15, // > 10% search drop!
      indexed_pages_change_ratio: -0.02,
    })
    expect(rolledBack.auto_rollback_triggered).toBe(true)
    expect(rolledBack.evidence_level).toBe('observed')
  })
})

// ===========================================================================
// Wave 8 Adversarial Regression Tests: [M-10] Finite-Sample Fréchet Bounds, Conservative Citation CIs & join.G14/act.G25 Gates
// ===========================================================================

describe('Wave 8 Adversarial Regressions: [M-10] Finite-Sample Search & Citation Statistical Rigor', () => {
  test('[M-10] n=1 PV/click never produces zero-width Fréchet bounds, and join.G14=false blocks answer-section claims & model estimates', () => {
    const tinySample = computeQueryReachOutputs({
      query: '単発流入語',
      section_uid: 'sec_1',
      page_google_reach_rate: 1.0,
      page_google_landing_pvs: 1,
      query_gsc_clicks: 1,
      total_page_gsc_clicks: 1,
      model_estimate: { point: 0.99, uninformative_prior_lower: 0.95, uninformative_prior_upper: 1.0 },
    })
    // Point plug-in would give [1, 1] (width 0), whereas finite-sample outer Wilson Fréchet bounds MUST stay wide!
    expect(tinySample.assumption_free_bounds.width).toBeGreaterThan(0.7)
    expect(tinySample.assumption_free_bounds.is_narrow).toBe(false)
    expect(tinySample.statistical_model_estimate.status).toBe('insufficient_data')

    // join.G14 unmet blocks mapQueryToAnswerSection and computeQueryReachOutputs
    const g14BlockedMap = mapQueryToAnswerSection({
      query: '解約方法',
      query_embedding: [0, 1, 0],
      gate_join_g14_passed: false,
      candidates: [
        {
          section_uid: 'sec_cancel',
          sec_fp: 'fp_2',
          body_fp: 'b2',
          heading_text: '解約方法',
          body_text: '解約方法のご案内',
          embedding: [0, 1, 0],
        },
      ],
    })
    expect(g14BlockedMap.status).toBe('no_clear_answer_section')
    expect(g14BlockedMap.best_section_uid).toBeNull()
    expect(g14BlockedMap.gate_blocked_reason).toBe('join.G14_unmet')

    const g14BlockedReach = computeQueryReachOutputs({
      query: 'メイン検索語',
      section_uid: 'sec_1',
      page_google_reach_rate: 0.7,
      page_google_landing_pvs: 5000,
      query_gsc_clicks: 4800,
      total_page_gsc_clicks: 5000,
      gate_join_g14_passed: false,
      model_estimate: { point: 0.7, uninformative_prior_lower: 0.65, uninformative_prior_upper: 0.75 },
    })
    expect(g14BlockedReach.assumption_free_bounds.is_narrow).toBe(false)
    expect(g14BlockedReach.statistical_model_estimate.status).toBe('insufficient_data')
    expect(g14BlockedReach.statistical_model_estimate.suppression_reason).toBe('join.G14_unmet')
  })

  test('[M-10] computeCitationBracketing returns wild_citations_upper=null (never 0.05 floor) when P(fetched|cited) CI includes 0 or act.G25 fails', () => {
    // 0 fetched among 30 cited probes -> lower CI of P(fetched|cited) is 0 -> upper bound is UNIDENTIFIABLE (null, NOT 20x!)
    const zeroFetchCited = computeCitationBracketing({
      wild_server_fetches: 500,
      probe_cited_count: 30,
      probe_cited_and_fetched_count: 0,
      probe_fetched_count: 100,
      probe_fetched_and_cited_count: 20,
    })
    expect(zeroFetchCited.upper_identifiable).toBe(false)
    expect(zeroFetchCited.wild_citations_upper).toBeNull()

    // act.G25=false blocks both citation bracketing and 'proven' randomization upgrade
    const g25BlockedBracket = computeCitationBracketing({
      wild_server_fetches: 500,
      probe_cited_count: 50,
      probe_cited_and_fetched_count: 30,
      probe_fetched_count: 100,
      probe_fetched_and_cited_count: 30,
      gate_act_g25_passed: false,
    })
    expect(g25BlockedBracket.upper_identifiable).toBe(false)
    expect(g25BlockedBracket.wild_citations_upper).toBeNull()

    // Vacuous 0/0 units or act.G25=false cannot yield 'proven'
    expect(
      evaluateEligibilityRandomizationOutcome({
        paired_directories: 6,
        observed_units: 0,
        planner_required_units: 0,
        search_traffic_change_ratio: 0,
        indexed_pages_change_ratio: 0,
      }).evidence_level,
    ).toBe('observed')
    expect(
      evaluateEligibilityRandomizationOutcome({
        paired_directories: 6,
        observed_units: 600,
        planner_required_units: 500,
        search_traffic_change_ratio: 0,
        indexed_pages_change_ratio: 0,
        gate_act_g25_passed: false,
      }).evidence_level,
    ).toBe('observed')
  })
})
