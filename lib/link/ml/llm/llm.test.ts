import { createDataLayerMetric } from '../../../../packages/contract/response';
import {
  DirectOutcomePredictionProhibitedError,
  HypothesisLedger,
  JevProhibitedPayloadError,
  JevPublicPageClient,
  LlmCostBudgetGuard,
  OutcomeLeakageInClassifierError,
  ProhibitedRuntimeEnvironmentError,
  VisitorRowProhibitedError,
  analyzePromiseVsContentGap,
  assertNotDirectOutcomePrediction,
  buildWeeklyDriverBrief,
  classifyChangeSemantics,
  computeWilson95Interval,
  createDeterministicGenerativeProvider,
  estimateGenerativeInferenceResources,
  nameAndExplainCluster,
  readSectionMeaning,
  verifyExplanationNumbers,
  wrapPublicPageTextForLlm,
} from './index';

describe('Bundle 4-G: Generative Model Thin Layer (Muse Glimmer 30B / Gemma 4), Jev Guard, Verifier & Tasks', () => {
  test('Provider-agnostic thin layer supports BOTH Muse Glimmer 30B & Gemma 4, enforces server-only, visitor-row firewall, cost caps & no-fabrication fallback', async () => {
    const costGuard = new LlmCostBudgetGuard({
      inference_max_usd: 0.01,
      jev_max_usd: 0.01,
      retry_max_usd: 0.005,
    });

    const muse = createDeterministicGenerativeProvider({
      model_id: 'muse-glimmer-30b',
      model_version: 'muse-glimmer-30b-2026-10',
      costGuard,
    });
    const gemma = createDeterministicGenerativeProvider({
      model_id: 'gemma-4-26b',
      model_version: 'gemma-4-26b-2026-10',
      costGuard,
    });

    // Both providers execute the exact same section-reading contract cleanly
    const rMuse = await readSectionMeaning({
      provider: muse,
      runtime: 'server_ci_stub',
      sec_fp: 'sec_price',
      body_fp: 'body_111',
      raw_public_section_text: '月額9,800円（税込）で全プランを比較できます。',
      taxonomy_version: 'tax_v1',
      prompt_version: 'prompt_v1',
      preprocess_version: 'prep_v1',
    });
    const rGemma = await readSectionMeaning({
      provider: gemma,
      runtime: 'server_ci_stub',
      sec_fp: 'sec_price',
      body_fp: 'body_111',
      raw_public_section_text: '月額9,800円（税込）で全プランを比較できます。',
      taxonomy_version: 'tax_v1',
      prompt_version: 'prompt_v1',
      preprocess_version: 'prep_v1',
    });

    expect(rMuse.status).toBe('ok');
    expect(rGemma.status).toBe('ok');
    expect(rMuse.evidence_level).toBe('inferred');
    expect(rMuse.meaning?.has_price).toBe(true);
    expect(rGemma.meaning?.has_comparison).toBe(true);

    // Server-only enforcement: browser and edge_worker MUST throw!
    await expect(
      muse.invoke({
        task: 'section_reading',
        runtime: 'browser',
        prompt_version: 'p1',
        taxonomy_version: 't1',
        preprocess_version: 'pr1',
      })
    ).rejects.toThrow(ProhibitedRuntimeEnvironmentError);

    await expect(
      gemma.invoke({
        task: 'section_reading',
        runtime: 'edge_worker',
        prompt_version: 'p1',
        taxonomy_version: 't1',
        preprocess_version: 'pr1',
      })
    ).rejects.toThrow(ProhibitedRuntimeEnvironmentError);

    // Visitor-row firewall: passing visitor_id / pv_id inside aggregate_context MUST throw!
    await expect(
      muse.invoke({
        task: 'cluster_naming',
        runtime: 'server_gpu',
        prompt_version: 'p1',
        taxonomy_version: 't1',
        preprocess_version: 'pr1',
        aggregate_context: { nested: { visitor_id: 'vis_secret_1' } },
      })
    ).rejects.toThrow(VisitorRowProhibitedError);

    // Failure fallback: returns not_collected without fabricating explanations!
    const failing = createDeterministicGenerativeProvider({
      model_id: 'muse-glimmer-30b',
      model_version: 'muse-glimmer-30b-2026-10',
      costGuard: new LlmCostBudgetGuard({ inference_max_usd: 1, jev_max_usd: 1, retry_max_usd: 1 }),
      simulateFailure: true,
    });
    const failedSec = await readSectionMeaning({
      provider: failing,
      runtime: 'server_gpu',
      sec_fp: 'sec_1',
      body_fp: 'b1',
      raw_public_section_text: '公開文',
      taxonomy_version: 't1',
      prompt_version: 'p1',
      preprocess_version: 'pr1',
    });
    expect(failedSec.status).toBe('not_collected');
    expect(failedSec.meaning).toBeNull();
    expect(failedSec.fallback_reason).toBe('provider_unavailable');
  });

  test('30B Inference VRAM, latency & cost estimator produces realistic GPU sizing across BF16 / FP8 / INT4', () => {
    const bf16 = estimateGenerativeInferenceResources({
      model_id: 'muse-glimmer-30b',
      quantization: 'bf16',
      max_input_tokens: 4096,
      max_output_tokens: 512,
      max_concurrency: 4,
      active_lora_adapters: 3,
    });
    const fp8 = estimateGenerativeInferenceResources({
      model_id: 'muse-glimmer-30b',
      quantization: 'fp8',
      max_input_tokens: 4096,
      max_output_tokens: 512,
      max_concurrency: 4,
      active_lora_adapters: 3,
    });
    const int4 = estimateGenerativeInferenceResources({
      model_id: 'muse-glimmer-30b',
      quantization: 'int4_awq',
      max_input_tokens: 4096,
      max_output_tokens: 512,
      max_concurrency: 4,
      active_lora_adapters: 3,
    });

    expect(bf16.weights_vram_gib).toBeGreaterThan(50);
    expect(bf16.total_vram_gib).toBeGreaterThan(65);
    expect(fp8.total_vram_gib).toBeGreaterThan(35);
    expect(fp8.total_vram_gib).toBeLessThan(bf16.total_vram_gib);
    expect(int4.total_vram_gib).toBeGreaterThan(20);
    expect(int4.total_vram_gib).toBeLessThan(fp8.total_vram_gib);
    expect(int4.recommended_gpu_profile).toContain('48GB');
    expect(bf16.estimated_cost_per_1k_requests_usd).toBeGreaterThan(0);
  });

  test('Jev client blocks visitor data, search queries, aggregates & aliases; stays closed (not_entitled) until contract+region+300 eval gates pass; shuffles & replays', async () => {
    const costGuard = new LlmCostBudgetGuard({ inference_max_usd: 1, jev_max_usd: 1, retry_max_usd: 1 });
    const publicText = wrapPublicPageTextForLlm('料金表: 月額3,980円（税込）');
    const options = [
      { option_id: 'pricing', label_ja: '料金・価格' },
      { option_id: 'faq', label_ja: 'よくある質問' },
      { option_id: 'review', label_ja: '口コミ・レビュー' },
    ] as const;

    // 1. Default closed gates -> not_entitled!
    const closedJev = new JevPublicPageClient({
      gates: {
        contractRetentionDeletionSigned: false,
        crossBorderRegionApproved: false,
        japaneseHumanEvalPassed300: false,
      },
      costGuard,
    });
    const blockedRes = await closedJev.judgePublicPageText({
      request_id: 'req_1',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options,
    });
    expect(blockedRes.status).toBe('not_entitled');
    if (blockedRes.status === 'not_entitled') {
      expect(blockedRes.unmet_gates).toHaveLength(3);
    }

    // 2. Payload prohibitions MUST throw JevProhibitedPayloadError immediately!
    const poisonedVisitor = {
      request_id: 'req_v',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options,
      visitor_id: 'vis_999',
    } as unknown as Parameters<JevPublicPageClient['judgePublicPageText']>[0];
    await expect(closedJev.judgePublicPageText(poisonedVisitor)).rejects.toThrow(
      JevProhibitedPayloadError
    );

    const poisonedQuery = {
      request_id: 'req_q',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options,
      search_query: '格安SIM おすすめ',
    } as unknown as Parameters<JevPublicPageClient['judgePublicPageText']>[0];
    await expect(closedJev.judgePublicPageText(poisonedQuery)).rejects.toThrow(
      JevProhibitedPayloadError
    );

    const poisonedAgg = {
      request_id: 'req_a',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options,
      conversion_rate: 0.025,
    } as unknown as Parameters<JevPublicPageClient['judgePublicPageText']>[0];
    await expect(closedJev.judgePublicPageText(poisonedAgg)).rejects.toThrow(
      JevProhibitedPayloadError
    );

    // 3. Mutable alias rejected
    await expect(
      closedJev.judgePublicPageText({
        request_id: 'req_alias',
        pinned_model_version: 'jev-latest',
        question_category: 'section_role',
        public_section_text: publicText,
        options,
      })
    ).rejects.toThrow(/dated model version/);

    // 4. Open gates with CI stub transport: shuffles options, maps back, persists & replays deterministically!
    let transportCalls = 0;
    const openJev = new JevPublicPageClient({
      gates: {
        contractRetentionDeletionSigned: true,
        crossBorderRegionApproved: true,
        japaneseHumanEvalPassed300: true,
      },
      costGuard,
      transport: async ({ shuffled_options }) => {
        transportCalls += 1;
        const pricingIdx = shuffled_options.findIndex((o) => o.option_id === 'pricing');
        return { chosen_shuffled_index: pricingIdx, probability: 0.91 };
      },
    });

    const liveRes = await openJev.judgePublicPageText({
      request_id: 'req_open_1',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options,
    });
    expect(liveRes.status).toBe('ok');
    if (liveRes.status === 'ok') {
      expect(liveRes.chosen_option_id).toBe('pricing');
      expect(liveRes.from_replay_cache).toBe(false);
      expect(liveRes.recorded.prohibited_for_training).toBe(true);
      expect(liveRes.recorded.origin_source).toBe('jev_external_service');
    }

    // Second call replays from recorded store without hitting transport again
    const replayRes = await openJev.judgePublicPageText({
      request_id: 'req_open_2',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options,
    });
    expect(replayRes.status).toBe('ok');
    if (replayRes.status === 'ok') {
      expect(replayRes.from_replay_cache).toBe(true);
      expect(replayRes.chosen_option_id).toBe('pricing');
    }
    expect(transportCalls).toBe(1);
  });

  test('In-house Number Verifier (never Jev), §8.12 Tasks, Hypothesis Ledger Wilson CI & Weekly Driver', async () => {
    expect(() => assertNotDirectOutcomePrediction('predict_cvr_for_variant')).toThrow(
      DirectOutcomePredictionProhibitedError
    );

    const exitMetric = createDataLayerMetric(30.2, 'clickhouse_sealed_hourly');
    const groundTruth = [
      {
        ref_id: 'ref_exit_sec1',
        metric: exitMetric,
        unit: '%' as const,
        period_label: '2026-10-21..2026-11-19',
        subject_id: 'site_1:sec_price',
      },
    ];

    // Valid grounded explanation with hypothesis label passes
    const okVerify = verifyExplanationNumbers({
      prose: '料金区画の離脱率は30.2%であり、価格比較根拠の不足が仮説として挙げられます。',
      citations: [
        {
          ref_id: 'ref_exit_sec1',
          stated_value: 30.2,
          stated_unit: '%',
          stated_period_label: '2026-10-21..2026-11-19',
          stated_subject_id: 'site_1:sec_price',
        },
      ],
      groundTruthRefs: groundTruth,
      includesReasonOrPersona: true,
      explicitHypothesisLabel: 'hypothesis',
    });
    expect(okVerify.passed).toBe(true);
    expect(okVerify.uses_jev).toBe(false);

    // Ungrounded hallucinated number (99%) or missing hypothesis label MUST fail!
    const badVerify = verifyExplanationNumbers({
      prose: '離脱率は30.2%で、改善すれば99%向上します。',
      citations: [
        {
          ref_id: 'ref_exit_sec1',
          stated_value: 30.2,
          stated_unit: '%',
          stated_period_label: '2026-10-21..2026-11-19',
          stated_subject_id: 'site_1:sec_price',
        },
      ],
      groundTruthRefs: groundTruth,
      includesReasonOrPersona: true,
      explicitHypothesisLabel: null,
    });
    expect(badVerify.passed).toBe(false);
    expect(badVerify.violations.some((v) => v.code === 'UNGROUNDED_LITERAL_NUMBER')).toBe(true);
    expect(badVerify.violations.some((v) => v.code === 'MISSING_HYPOTHESIS_LABEL')).toBe(true);

    // Promise vs Content Gap: in-house only, 3 strictly separated views
    const provider = createDeterministicGenerativeProvider({
      model_id: 'muse-glimmer-30b',
      model_version: 'muse-30b-v1',
      costGuard: new LlmCostBudgetGuard({ inference_max_usd: 1, jev_max_usd: 1, retry_max_usd: 1 }),
      customResponder: () => ({
        output_json: {
          name: '価格比較重視層',
          explanation: '離脱率は30.2%です（仮説: 料金比較不足）。',
          claim: '価格の約束と一致',
          role: 'pricing_table_move_up',
        },
        confidence: 0.85,
      }),
    });

    const gapRes = await analyzePromiseVsContentGap({
      provider,
      runtime: 'server_ci_stub',
      promise_kind: 'search_query',
      promise_text: '格安SIM 料金 比較',
      section_text: '月額プラン比較表',
      page_reach_rate: createDataLayerMetric(0.74, 'clickhouse_sealed_hourly'),
      page_exit_rate: exitMetric,
      query_bound_lo: 0.22,
      query_bound_hi: 0.41,
    });
    expect(gapRes.uses_jev).toBe(false);
    expect(gapRes.semantic_alignment.evidence_level).toBe('inferred');
    expect(gapRes.page_observed_behaviour.evidence_level).toBe('observed');
    expect(gapRes.query_behaviour_bounds.evidence_level).toBe('inferred');

    // Change semantic classification rejects post-assignment timestamp or outcome leakage!
    await expect(
      classifyChangeSemantics({
        provider,
        runtime: 'server_ci_stub',
        before_public_text: '旧見出し',
        after_public_text: '新見出し',
        is_confirmatory_experiment: true,
        classified_at_ms: 2000,
        first_assignment_at_ms: 1000,
      })
    ).rejects.toThrow(OutcomeLeakageInClassifierError);

    await expect(
      classifyChangeSemantics({
        provider,
        runtime: 'server_ci_stub',
        before_public_text: '旧',
        after_public_text: '新',
        is_confirmatory_experiment: true,
        classified_at_ms: 500,
        first_assignment_at_ms: 1000,
        outcome_metrics_attached: { cvr: 0.03 },
      })
    ).rejects.toThrow(OutcomeLeakageInClassifierError);

    // Cluster explanation verified cleanly with grounded numbers
    const clusterRes = await nameAndExplainCluster({
      provider,
      runtime: 'server_ci_stub',
      cluster_id: 'clu_price_seekers',
      aggregate_profile: { session_count: 850, avg_dwell_ms: 24000 },
      ground_truth_refs: groundTruth,
      citations: [
        {
          ref_id: 'ref_exit_sec1',
          stated_value: 30.2,
          stated_unit: '%',
          stated_period_label: '2026-10-21..2026-11-19',
          stated_subject_id: 'site_1:sec_price',
        },
      ],
    });
    expect(clusterRes.status).toBe('ok');
    expect(clusterRes.label_kind).toBe('hypothesis');

    // Hypothesis Ledger: 5/5 successes -> Wilson 95% CI [~56.6%, 100%]; inconclusive NOT counted as failure;
    // fine-tuning labels return ONLY randomised_experiment rows!
    const ledger = new HypothesisLedger();
    for (let i = 1; i <= 5; i++) {
      ledger.registerHypothesis({
        hypothesis_id: `hyp_${i}`,
        target_sec_fp: `sec_${i}`,
        cluster_id: 'clu_1',
        rationale: 'Move pricing table above fold',
        expected_direction: 'increase',
        patch_proposal_id: `patch_${i}`,
        selection_provenance: 'top_rank_driver',
        created_at_iso: '2026-11-01T00:00:00Z',
      });
      ledger.recordOutcome(`hyp_${i}`, {
        status: 'success',
        source: 'randomised_experiment',
        experiment_id: `exp_${i}`,
        effect_point: 0.18,
        ci_lower: 0.04,
        ci_upper: 0.32,
        recorded_at_iso: '2026-11-19T00:00:00Z',
      });
    }
    ledger.registerHypothesis({
      hypothesis_id: 'hyp_inc',
      target_sec_fp: 'sec_6',
      cluster_id: 'clu_1',
      rationale: 'Underpowered test',
      expected_direction: 'increase',
      patch_proposal_id: 'patch_6',
      selection_provenance: 'exploratory',
      created_at_iso: '2026-11-01T00:00:00Z',
    });
    ledger.recordOutcome('hyp_inc', {
      status: 'inconclusive',
      source: 'randomised_experiment',
      experiment_id: 'exp_6',
      effect_point: null,
      ci_lower: null,
      ci_upper: null,
      recorded_at_iso: '2026-11-19T00:00:00Z',
    });
    ledger.registerHypothesis({
      hypothesis_id: 'hyp_obs',
      target_sec_fp: 'sec_7',
      cluster_id: 'clu_1',
      rationale: 'Before/after observed change only',
      expected_direction: 'increase',
      patch_proposal_id: 'patch_7',
      selection_provenance: 'post_hoc',
      created_at_iso: '2026-11-01T00:00:00Z',
    });
    ledger.recordOutcome('hyp_obs', {
      status: 'success',
      source: 'before_after_observed',
      experiment_id: 'obs_1',
      effect_point: null,
      ci_lower: null,
      ci_upper: null,
      recorded_at_iso: '2026-11-19T00:00:00Z',
    });

    const w5 = computeWilson95Interval(5, 5);
    expect(w5.lower).toBeCloseTo(0.5655, 3);
    expect(w5.upper).toBe(1);

    const hr = ledger.getHitRateReport();
    expect(hr.inconclusive_count).toBe(1);
    expect(hr.failure_count).toBe(0);
    // Randomised training labels MUST exclude `before_after_observed`!
    const randLabels = ledger.getRandomisedTrainingLabels();
    expect(randLabels.every((h) => h.outcome?.source === 'randomised_experiment')).toBe(true);
    expect(randLabels.some((h) => h.hypothesis_id === 'hyp_obs')).toBe(false);

    const brief = buildWeeklyDriverBrief({
      generated_at_iso: '2026-11-20T00:00:00Z',
      actions: [
        {
          action_title: '比較表をファーストビュー直下へ配置テスト',
          evidence_level: 'planned',
          days_to_verdict: 21,
          hypothesis_id: 'hyp_1',
        },
      ],
      last_week_learnings: ['5/5件の実験で改善確認（95% Wilson幅 56.6%〜100%）'],
      cannot_say: ['訪問ごとの自然検索クエリは原理的に取得不可（U4）'],
    });
    expect(brief.ranked_next_actions[0].rank).toBe(1);
    expect(brief.cannot_say).toHaveLength(1);
  });

  test('[M-18] iterative stack scanners in jev-client and provider reject forbidden payloads nested at depth 25 and handle cyclic graphs safely', async () => {
    const costGuard = new LlmCostBudgetGuard({ inference_max_usd: 1, jev_max_usd: 1, retry_max_usd: 1 });
    const publicText = wrapPublicPageTextForLlm('公開ページ本文テキスト');
    const jev = new JevPublicPageClient({
      gates: {
        contractRetentionDeletionSigned: true,
        crossBorderRegionApproved: true,
        japaneseHumanEvalPassed300: true,
      },
      costGuard,
    });

    // Build depth-25 nested object with a cycle AND forbidden `visitor_id` / `search_query` at depth 25
    const makeDeepNested = (leaf: Record<string, unknown>, depth = 25): Record<string, unknown> => {
      let cur: Record<string, unknown> = { ...leaf };
      for (let d = 0; d < depth; d += 1) {
        cur = { [`level_${d}`]: cur };
      }
      cur.self_cycle = cur; // cyclic reference -> WeakSet prevents infinite loop!
      return cur;
    };

    const deepJevReq = {
      request_id: 'req_deep_25',
      pinned_model_version: 'jev-judge-2026-10-01',
      question_category: 'section_role',
      public_section_text: publicText,
      options: [
        { option_id: 'a', label_ja: 'A' },
        { option_id: 'b', label_ja: 'B' },
      ],
      extra_meta: makeDeepNested({ search_query: '格安SIM 比較' }, 25),
    } as unknown as Parameters<JevPublicPageClient['judgePublicPageText']>[0];

    await expect(jev.judgePublicPageText(deepJevReq)).rejects.toThrow(JevProhibitedPayloadError);

    const provider = createDeterministicGenerativeProvider({
      model_id: 'muse-glimmer-30b',
      model_version: 'muse-30b-v1',
      costGuard,
    });
    await expect(
      provider.invoke({
        task: 'cluster_naming',
        runtime: 'server_gpu',
        prompt_version: 'p1',
        taxonomy_version: 't1',
        preprocess_version: 'pr1',
        aggregate_context: makeDeepNested({ visitor_id: 'vis_deep_25' }, 25),
      })
    ).rejects.toThrow(VisitorRowProhibitedError);
  });
});
