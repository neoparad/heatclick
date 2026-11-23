import {
  DEVICE_PROFILES,
  DeterministicHtmlRenderDriver,
  SecondaryLabRenderer,
} from '@/lib/link/lab'
import { computeCitationBracketing, createEligibilitySnapshot } from '@/lib/link/search'

import {
  assertNoCrossInstrumentMixing,
  assertNoPosteriorAiProbability,
  BEHAVIORAL_STAT_COUNT,
  boundWildAiPrevalenceAndLift,
  buildAiSearchLedger,
  buildInstrumentCHttpCrawlerFriction,
  buildInstrumentDWildBrowserAi,
  buildLocalAiModelCertificate,
  compressBehavioralStats60,
  computeFprUpperBound95,
  computeGaussianLogDensity60,
  computeSimultaneousWilsonIntervals,
  decompressBehavioralStats60,
  divideConfidenceIntervalsConservative,
  evaluateInstrumentBLabTaskRun,
  LocalAiLikelihoodScorer,
  MAX_COMPRESSED_BEHAVIORAL_BYTES,
  runInstrumentAOperability,
  UNDETECTABLE_LOCAL_AI_CLASSES,
} from './index'

// ===========================================================================
// 1. Local In-Browser AI Likelihood Ratio Scorer & Model Certificate (§7.5)
// ===========================================================================

describe('Local In-Browser AI Scorer & Model Certificate (§7.5)', () => {
  test('compresses 60 behavioral stats to <= 400 bytes with zero device fingerprints and round-trips accurately', () => {
    const stats60 = Array.from({ length: BEHAVIORAL_STAT_COUNT }, (_, i) => i / 60)
    const compressed = compressBehavioralStats60({ stats_60: stats60 })
    expect(compressed.byteLength).toBeLessThanOrEqual(MAX_COMPRESSED_BEHAVIORAL_BYTES)
    expect(compressed.byteLength).toBe(122)

    const roundTrip = decompressBehavioralStats60(compressed)
    expect(roundTrip).toHaveLength(60)
    expect(roundTrip[30]).toBeCloseTo(0.5, 4)

    // Device fingerprint field MUST throw!
    expect(() =>
      compressBehavioralStats60({
        stats_60: stats60,
        extra_fields: { webgl_renderer: 'ANGLE (Intel)' },
      }),
    ).toThrow(/Device fingerprint/)
  })

  test('validates Model Certificate (>=8 families, 300/1000 panel, 3/N FPR bound, pi_max=0.20, panel vs wild AUC ~0.50)', () => {
    // Exact 3/N rule-of-three checks (300 -> 1.0%, 1000 -> 0.3%)
    expect(computeFprUpperBound95(0, 300)).toBeCloseTo(0.01, 6)
    expect(computeFprUpperBound95(0, 1000)).toBeCloseTo(0.003, 6)

    const eightFamilies = {
      playwright_cdp: 0.94,
      puppeteer_stealth: 0.89,
      selenium_wd: 0.96,
      browser_use: 0.91,
      computer_use: 0.86,
      skyvern: 0.88,
      stagehand: 0.9,
      openai_operator_local: 0.84,
    }

    const validCert = buildLocalAiModelCertificate({
      certificate_id: 'cert_v1',
      model_version: 'local-ai/1',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: eightFamilies,
      unseen_framework_recalls: { unseen_agent_x: 0.72 },
      threshold_panel_n: 320,
      test_panel_n: 1000,
      test_panel_false_positives: 0,
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.016,
      panel_vs_wild_auc: 0.51,
    })
    expect(validCert.valid).toBe(true)
    expect(validCert.human_fpr_upper_bound_95).toBeCloseTo(0.003, 6)
    expect(validCert.disclosed_pi_max).toBe(0.2)
    expect(validCert.wild_implied_fpr_upper_bound).toBeCloseTo(0.02, 6)
    expect(validCert.panel_wild_indistinguishable).toBe(true)
    expect(validCert.undetectable_classes).toEqual(UNDETECTABLE_LOCAL_AI_CLASSES)

    // Lab leakage (panel vs wild AUC = 0.78) invalidates certificate!
    const leakyCert = buildLocalAiModelCertificate({
      certificate_id: 'cert_leaky',
      model_version: 'local-ai/bad',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: eightFamilies,
      unseen_framework_recalls: {},
      threshold_panel_n: 320,
      test_panel_n: 1000,
      test_panel_false_positives: 0,
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.02,
      panel_vs_wild_auc: 0.78,
    })
    expect(leakyCert.valid).toBe(false)
    expect(leakyCert.panel_wild_indistinguishable).toBe(false)
    expect(leakyCert.gate_failures.some((f) => f.includes('panel_vs_wild_leakage'))).toBe(true)
  })

  test('scores only fine-pointer + sufficient-interaction PVs, outputs LR + novelty (NEVER P(AI|session)), and reports unscorable_share', () => {
    const cert = buildLocalAiModelCertificate({
      certificate_id: 'cert_v1',
      model_version: 'local-ai/1',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: {
        f1: 0.9, f2: 0.9, f3: 0.9, f4: 0.9, f5: 0.9, f6: 0.9, f7: 0.9, f8: 0.9,
      },
      unseen_framework_recalls: { f_unseen: 0.7 },
      threshold_panel_n: 300,
      test_panel_n: 1000,
      test_panel_false_positives: 0,
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.01,
      panel_vs_wild_auc: 0.5,
    })

    const humanCentroid = new Array<number>(60).fill(0.2)
    const botCentroid = new Array<number>(60).fill(0.9)

    const scorer = new LocalAiLikelihoodScorer({
      certificate: cert,
      human_centroid_60: humanCentroid,
      human_scale: 0.25,
      family_profiles: [{ family_id: 'playwright_cdp', centroid_60: botCentroid, scale: 0.25 }],
    })

    const botBytes = compressBehavioralStats60({ stats_60: new Array<number>(60).fill(0.88) })
    const humanBytes = compressBehavioralStats60({ stats_60: new Array<number>(60).fill(0.21) })

    const batch = scorer.scoreBatch([
      // Automated fine-pointer PV
      { pv_id: 'pv_bot', pointer_type: 'fine', interaction_event_count: 25, compressed_stats_60: botBytes },
      // Human fine-pointer PV
      { pv_id: 'pv_human', pointer_type: 'fine', interaction_event_count: 25, compressed_stats_60: humanBytes },
      // Touch-only mobile PV -> unscorable!
      { pv_id: 'pv_touch', pointer_type: 'coarse', interaction_event_count: 25, compressed_stats_60: humanBytes },
      // Read-only zero-interaction PV -> unscorable!
      { pv_id: 'pv_read_only', pointer_type: 'fine', interaction_event_count: 2, compressed_stats_60: humanBytes },
    ])

    expect(batch.total_pvs).toBe(4)
    expect(batch.scorable_pvs).toBe(2)
    expect(batch.unscorable_pvs).toBe(2)
    expect(batch.unscorable_share).toBeCloseTo(0.5, 6)
    expect(batch.automated_count).toBe(1)
    expect(batch.human_like_count).toBe(1)

    const botRes = batch.results[0]
    expect(botRes.status).toBe('automated')
    expect(botRes.max_likelihood_ratio!).toBeGreaterThan(10)
    expect('ai_probability' in botRes).toBe(false)
    expect(() => assertNoPosteriorAiProbability(botRes)).not.toThrow()
    expect(() => assertNoPosteriorAiProbability({ ...botRes, p_ai: 0.99 })).toThrow(/Posterior AI probability/)
  })
})

// ===========================================================================
// 2. AI Friction 4 Non-Mixable Instruments (§7.6)
// ===========================================================================

describe('AI Friction 4 Instruments — Strictly Non-Mixable (§7.6)', () => {
  test('Instrument A (zero-traffic operability), B (scoped proven + affiliate sink), C (HTTP-only), D (no input values / no stuck / no classifier features) & anti-mixing guard', async () => {
    // Instrument A: Operability Audit connected to lib/link/lab (valid at 0 traffic PVs!)
    const driver = new DeterministicHtmlRenderDriver()
    const planUrl = 'https://example.jp/plan'
    driver.registerPage(planUrl, {
      html: '<html><body><main><h2>Plan</h2><button>Sign Up</button></main></body></html>',
    })
    const renderer = new SecondaryLabRenderer({ driver })
    const render = await renderer.renderPage({
      tenant_id: 't1',
      site_id: 's1',
      url: planUrl,
      job_class: 'full',
      profile: DEVICE_PROFILES.desktop_chromium,
    })
    const instA = runInstrumentAOperability(render)
    expect(instA.instrument).toBe('A_operability_audit')
    expect(instA.evidence).toBe('observed')
    expect(instA.valid_with_zero_traffic).toBe(true)

    // Instrument B: Lab task run — controlled executor yields scoped `proven` and zero-request guarantees; NEVER visitor projection!
    const instB = evaluateInstrumentBLabTaskRun({
      framework: 'playwright_agent',
      model_version: 'model_v2',
      page_version: 'skel_v1',
      task_id: 'task_signup',
      execution_environment: 'controlled_executor',
      affiliate_sink_replaced: true,
      has_server_side_sink_route: true,
      page_has_affiliate_slots: true,
      randomized_simultaneous_comparison: true,
      statistical_test_passed: true,
      trials: [
        { trial_id: 't1', arm: 'control', succeeded: false, blocking_el_fp: 'el_btn_1', affiliate_requests_observed: 0, human_data_contaminated: false, multi_page_task: true },
        { trial_id: 't2', arm: 'treatment', succeeded: true, blocking_el_fp: null, affiliate_requests_observed: 0, human_data_contaminated: false, multi_page_task: true },
      ],
    })
    expect(instB.evidence).toBe('proven')
    expect(instB.usable_for_visitor_projection).toBe(false)
    expect(instB.zero_guarantee_applicable).toBe(true)
    expect(instB.affiliate_requests_zero_gate_passed).toBe(true)
    expect(instB.top_blocking_el_fp).toBe('el_btn_1')

    // Uncontrolled agent on affiliate page WITHOUT server-side sink MUST throw!
    expect(() =>
      evaluateInstrumentBLabTaskRun({
        framework: 'cloud_agent',
        model_version: 'v1',
        page_version: 'p1',
        task_id: 't1',
        execution_environment: 'uncontrolled_cloud_or_panel',
        affiliate_sink_replaced: false,
        has_server_side_sink_route: false,
        page_has_affiliate_slots: true,
        randomized_simultaneous_comparison: false,
        statistical_test_passed: false,
        trials: [],
      }),
    ).toThrow(/server-side sink/)

    // Instrument C: HTTP Crawler Friction (no screen!)
    const instC = buildInstrumentCHttpCrawlerFriction({
      actor_id: 'openai:oai-searchbot',
      status_distribution: { '200': 90, '403': 10 },
      redirect_count: 4,
      disallowed_robots_requests: 1,
      blocked_403_429_count: 10,
      truncated_response_count: 2,
      raw_html_missing_section_count: 12,
    })
    expect(instC.has_screen).toBe(false)
    expect(instC.total_requests).toBe(100)

    // Instrument D: Wild Browser AI
    const instD = buildInstrumentDWildBrowserAi({
      sub_tier: 'verified_hosted_agent',
      action_trace: [
        { el_fp: 'el_1', sec_fp: 'sec_1', action_kind: 'click', duration_ms: 420, outcome: 'no_effect' },
      ],
      behavioral_metrics: { section_reach_rate: 0.75 },
      behavioral_summary_note: 'Repeated click on el_1 produced no DOM change',
    })
    expect(instD.intent_known).toBe(false)
    expect(instD.action_trace).toHaveLength(1)

    // Instrument D rejects "詰まった" / "stuck" wording!
    expect(() =>
      buildInstrumentDWildBrowserAi({
        sub_tier: 'explicit_evidence',
        behavioral_metrics: { exit_rate: 0.4 },
        behavioral_summary_note: 'ユーザーはボタンで詰まった',
      }),
    ).toThrow(/Prohibited wild-intent wording/)

    // Instrument D rejects classifier features on model_inferred!
    expect(() =>
      buildInstrumentDWildBrowserAi({
        sub_tier: 'model_inferred',
        behavioral_metrics: { pointer_velocity_mean: 4.2 },
        behavioral_summary_note: 'Observed scroll depth distribution',
      }),
    ).toThrow(/Classifier feature/)

    // Instrument D rejects raw input_value inside action trace!
    expect(() =>
      buildInstrumentDWildBrowserAi({
        sub_tier: 'verified_hosted_agent',
        action_trace: [
          {
            el_fp: 'el_input',
            sec_fp: 'sec_1',
            action_kind: 'submit',
            duration_ms: 100,
            outcome: 'dom_changed',
            input_value: 'secret@example.jp',
          } as never,
        ],
        behavioral_metrics: {},
        behavioral_summary_note: 'Form submitted',
      }),
    ).toThrow(/Input value field/)

    // Anti-mixing guard rejects combining different instruments!
    expect(() => assertNoCrossInstrumentMixing([instA, instB])).toThrow(/Cross-instrument mixing prohibited/)
    expect(() => assertNoCrossInstrumentMixing([instC, instD])).toThrow(/Cross-instrument mixing prohibited/)
    expect(assertNoCrossInstrumentMixing([instA, instA])).toBe('A_operability_audit')
  })
})

// ===========================================================================
// 3. AI Search 8-Stage Integrated Ledger (§7.7)
// ===========================================================================

describe('AI Search 8-Stage Integrated Ledger (§7.7)', () => {
  test('builds complete Stage 0..7 ledger with fixed evidence levels, shared-crawler caveat, unknowable training value & spike alert', () => {
    const elig = createEligibilitySnapshot({
      tenant_id: 't1',
      site_id: 's1',
      captured_at: '2026-11-20T00:00:00Z',
      robots_txt_body: 'User-agent: *\nAllow: /\n',
      cdn_policy: { ai_crawl_challenge: false, waf_bot_fight_mode: false, note: null },
      token_policies: { 'Google-Extended': 'disallow', GPTBot: 'allow' },
    })

    const wildBracket = computeCitationBracketing({
      wild_server_fetches: 500,
      probe_cited_count: 40,
      probe_cited_and_fetched_count: 20,
      probe_fetched_count: 80,
      probe_fetched_and_cited_count: 20,
    })

    const ledger = buildAiSearchLedger({
      tenant_id: 't1',
      site_id: 's1',
      generated_at: '2026-11-20T12:00:00Z',
      entries: [
        {
          eligibility: elig,
          fetches: {
            surface_id: 'google_search_ai',
            operator: 'google',
            shared_search_and_ai_crawler: true,
            training_fetches: 0,
            indexing_fetches: 1000,
            user_triggered_fetches: 200,
            total_transfer_bytes: 120_000_000,
            estimated_bandwidth_cost_jpy: 800,
            current_hour_requests: 450,
            historical_same_slot_weeks: [100, 110, 95, 105],
          },
          citations: {
            probe_cited_queries: 18,
            probe_total_queries: 50,
            probe_configuration_id: 'jp_mobile_aio_v1',
            wild_citation_bracket: wildBracket,
          },
          traffic: {
            attributed_referrer_sessions: 300,
            visits_in_30m_after_fetch: 90,
            visits_in_matched_control_30m: 50,
            fetch_event_count_for_30m_window: 20,
            serp_ai_click_three_estimates: [40, 75, 130],
            engaged_section_sessions: 210,
            attributed_conversions: 15,
            observed_revenue_jpy: 45000,
            value_per_session_jpy: 150,
          },
        },
      ],
    })

    const surf = ledger.surfaces[0]
    expect(surf.stages_separable).toBe(false)
    expect(surf.shared_crawler_caveat).toContain('Googlebot')

    // Fixed evidence per stage (§7.7)
    expect(surf.stages.stage_0_eligibility.evidence).toBe('observed')
    expect(surf.stages.stage_1_training_fetch.evidence).toBe('observed')
    expect(surf.stages.stage_1_training_fetch.economic_value.unknowable_by_design).toBe(true)
    expect(surf.stages.stage_4_citation.probe_config.evidence).toBe('observed')
    expect(surf.stages.stage_4_citation.wild_estimate.evidence).toBe('inferred')
    expect(surf.stages.stage_5_ai_traffic.attributed_referrer_lower_bound.evidence).toBe('observed')
    expect(surf.stages.stage_5_ai_traffic.referrerless_30m_lift.evidence).toBe('inferred')
    expect(surf.stages.stage_5_ai_traffic.serp_ai_clicks_three_estimator_band.evidence).toBe('inferred')
    expect(surf.stages.stage_6_engagement.evidence).toBe('observed')
    expect(surf.stages.stage_7_conversions.evidence).toBe('observed')

    // Per-surface economics & spike alert (act.G34)
    expect(surf.economics.traffic_bytes_per_attributed_session).toBe(400_000)
    expect(surf.economics.value_vs_cost_range.lower_observed_value_jpy).toBe(45000)
    expect(surf.economics.value_vs_cost_range.upper_inferred_value_jpy).toBeGreaterThan(45000)
    expect(surf.spike_alert.spike_detected).toBe(true)
  })
})

// ===========================================================================
// Wave 8 Adversarial Regression Tests: [H-30] Hard Certification, Simultaneous CIs, Conservative Division & 60D Log-Normalizer
// ===========================================================================

describe('Wave 8 Adversarial Regressions: [H-30] Local AI Scorer Rigor & Feature Provenance Ban', () => {
  const validEightFamilies = {
    f1: 0.92,
    f2: 0.9,
    f3: 0.95,
    f4: 0.89,
    f5: 0.88,
    f6: 0.91,
    f7: 0.93,
    f8: 0.87,
  }

  test('[H-30] hard certification gates reject high FPR / low recall / poor ECE, and scorer refuses automated promotion on uncertified cert', () => {
    const highFprCert = buildLocalAiModelCertificate({
      certificate_id: 'cert_high_fpr',
      model_version: 'local-ai/bad-fpr',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: validEightFamilies,
      unseen_framework_recalls: {},
      threshold_panel_n: 300,
      test_panel_n: 1000,
      test_panel_false_positives: 25, // > 1% FPR cap!
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.03,
      panel_vs_wild_auc: 0.5,
      expected_calibration_error: 0.12,
      roc_auc: 0.65,
    })
    expect(highFprCert.valid).toBe(false)
    expect(highFprCert.certified).toBe(false)
    expect(highFprCert.gate_failures.some((f) => f.includes('human_fpr_upper_bound_exceeds_cap'))).toBe(true)
    expect(highFprCert.gate_failures.some((f) => f.includes('calibration_ece_exceeds_cap'))).toBe(true)
    expect(highFprCert.gate_failures.some((f) => f.includes('roc_auc_below_floor'))).toBe(true)

    const scorerWithBadCert = new LocalAiLikelihoodScorer({
      certificate: highFprCert,
      human_centroid_60: new Array<number>(60).fill(0.2),
      human_scale: 0.2,
      family_profiles: [{ family_id: 'f1', centroid_60: new Array<number>(60).fill(0.9), scale: 0.2 }],
    })
    const botVec = compressBehavioralStats60({ stats_60: new Array<number>(60).fill(0.9) })
    const refused = scorerWithBadCert.scorePv({
      pv_id: 'pv_must_refuse',
      pointer_type: 'fine',
      interaction_event_count: 30,
      compressed_stats_60: botVec,
    })
    expect(refused.scorable).toBe(false)
    expect(refused.status).toBe('unscorable')
    expect(refused.unscorable_reason).toBe('uncertified_model_certificate')
  })

  test('[H-30] conservative CI division returns unidentifiable when denominator CI touches/contains 0, and simultaneous Wilson CIs adjust for k buckets', () => {
    const unid = divideConfidenceIntervalsConservative(
      { lower: 0.02, upper: 0.08 },
      { lower: 0, upper: 0.15 },
    )
    expect(unid.identifiable).toBe(false)
    expect(unid.upper).toBeNull()

    // Small recall trial (1 hit out of 4) vs high FPR -> tpr_L - fpr_U <= 0 -> unidentifiable!
    const unidPrev = boundWildAiPrevalenceAndLift({
      wild_flagged_count: 5,
      wild_scorable_n: 100,
      panel_false_positives: 10,
      panel_n: 50,
      positive_recall_hits: 1,
      positive_recall_trials: 4,
    })
    expect(unidPrev.identifiable).toBe(false)
    expect(unidPrev.status).toBe('unidentifiable')
    expect(unidPrev.prevalence_upper).toBeNull()

    // Well-powered panel & recall -> identifiable conservative prevalence bounds
    const okPrev = boundWildAiPrevalenceAndLift({
      wild_flagged_count: 50,
      wild_scorable_n: 1000,
      panel_false_positives: 0,
      panel_n: 1000,
      positive_recall_hits: 190,
      positive_recall_trials: 200,
    })
    expect(okPrev.identifiable).toBe(true)
    expect(okPrev.prevalence_upper!).toBeGreaterThan(okPrev.prevalence_lower)
    expect(okPrev.prevalence_upper!).toBeLessThanOrEqual(0.2)

    // Simultaneous Wilson intervals: k=4 buckets yields strictly wider CI than unadjusted k=1
    const single = computeSimultaneousWilsonIntervals([
      { bucket_id: 'b1', successes: 20, trials: 100 },
    ])[0]
    const quad = computeSimultaneousWilsonIntervals([
      { bucket_id: 'b1', successes: 20, trials: 100 },
      { bucket_id: 'b2', successes: 30, trials: 100 },
      { bucket_id: 'b3', successes: 10, trials: 100 },
      { bucket_id: 'b4', successes: 40, trials: 100 },
    ])[0]
    expect(quad.upper - quad.lower).toBeGreaterThan(single.upper - single.lower)
  })

  test('[H-30] includes full 60D Gaussian log-determinant normalizer and bans provenance=model_inferred input features', () => {
    const center = new Array<number>(60).fill(0.5)
    const tight = computeGaussianLogDensity60(center, center, 0.1)
    const wide = computeGaussianLogDensity60(center, center, 0.5)
    // At x === mu, tighter covariance (0.1 vs 0.5) MUST have strictly higher log-density by 60 * ln(5)!
    expect(tight.logDensity - wide.logDensity).toBeCloseTo(60 * Math.log(5), 5)

    // Rejects model_inferred provenance in behavioral input/retraining and Instrument D
    expect(() =>
      compressBehavioralStats60({
        stats_60: center,
        feature_provenances: [{ key: 'prior_session_ai_flag', provenance: 'model_inferred' }],
      }),
    ).toThrow(/Model-inferred feature provenance/)

    expect(() =>
      buildInstrumentDWildBrowserAi({
        sub_tier: 'model_inferred',
        behavioral_metrics: { behavioral_stat_0: 0.4 },
        behavioral_summary_note: 'Observed scroll distribution',
      }),
    ).toThrow(/Classifier feature/)
  })
})

// ===========================================================================
// Wave 9 Codex Remediation Regression Tests: [#28], [#29]
// ===========================================================================

describe('Wave 9 Codex Remediation Regressions: [#28] Empty Intersection & [#29] 60D Parity', () => {
  test('[#28] flags assumption_inconsistent / empty intersection when Wilson dataLower > disclosed priorUpper (0.20) instead of clamping to [0.20, 0.20]', () => {
    // High wild flagged rate (~45%) with tight FPR (~0%) and high TPR (~95%) yields dataLower > 0.35 > priorUpper (0.20)
    const res = boundWildAiPrevalenceAndLift({
      wild_flagged_count: 450,
      wild_scorable_n: 1000,
      panel_false_positives: 0,
      panel_n: 1000,
      positive_recall_hits: 950,
      positive_recall_trials: 1000,
      disclosed_pi_max: 0.2,
    })

    expect(res.data_lower).not.toBeNull()
    expect(res.data_lower!).toBeGreaterThan(0.35)
    expect(res.disclosed_pi_max).toBe(0.2)

    expect(res.status).toBe('assumption_inconsistent')
    expect(res.identifiable).toBe(false)
    expect(res.consistent).toBe(false)
    expect(res.assumption_mismatch).toBe(true)
    expect(res.intersection_empty).toBe(true)
    expect(res.lower).toBeNull()
    expect(res.upper).toBeNull()
    expect(res.prevalence_lower).toBeNull()
    expect(res.prevalence_upper).toBeNull()
  })

  test('[#29] enforces exact 60D dimensional parity before Gaussian log-likelihood ratio (rejects 57D human vs 60D AI profile)', () => {
    const x60 = new Array<number>(60).fill(0.5)
    const mean57 = new Array<number>(57).fill(0.5)
    const mean60 = new Array<number>(60).fill(0.5)

    // Direct Gaussian log-density rejects 57D centroid, 57D observation, 57D diagonalVars, or non-positive scale
    expect(() => computeGaussianLogDensity60(x60, mean57, 1)).toThrow(/dimension_mismatch/)
    expect(() => computeGaussianLogDensity60(mean57, mean60, 1)).toThrow(/60D dimensional parity/)
    expect(() => computeGaussianLogDensity60(x60, mean60, 1, new Array<number>(57).fill(1))).toThrow(
      /dimension_mismatch/,
    )
    expect(() => computeGaussianLogDensity60(x60, mean60, 0)).toThrow(/invalid_scale/)
    expect(() => computeGaussianLogDensity60(x60, mean60, -1)).toThrow(/invalid_scale/)

    // Scorer with 57D human profile vs 60D AI profile (identical means=0.5, unit std=1) MUST mark unscorable,
    // NOT return the ~15.75x normalization-constant bias!
    const validCert = buildLocalAiModelCertificate({
      certificate_id: 'cert_29',
      model_version: 'local-ai/1',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: {
        f1: 0.9, f2: 0.9, f3: 0.9, f4: 0.9, f5: 0.9, f6: 0.9, f7: 0.9, f8: 0.9,
      },
      unseen_framework_recalls: { f_unseen: 0.7 },
      threshold_panel_n: 300,
      test_panel_n: 1000,
      test_panel_false_positives: 0,
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.01,
      panel_vs_wild_auc: 0.5,
    })

    const mismatchedScorer = new LocalAiLikelihoodScorer({
      certificate: validCert,
      human_centroid_60: mean57, // 57D!
      human_scale: 1,
      family_profiles: [{ family_id: 'f1', centroid_60: mean60, scale: 1 }], // 60D!
    })
    const obsBytes = compressBehavioralStats60({ stats_60: x60 })
    const scored = mismatchedScorer.scorePv({
      pv_id: 'pv_dim_mismatch_29',
      pointer_type: 'fine',
      interaction_event_count: 25,
      compressed_stats_60: obsBytes,
    })

    expect(scored.scorable).toBe(false)
    expect(scored.status).toBe('unscorable')
    expect(scored.max_likelihood_ratio).toBeNull()
    expect(scored.unscorable_reason).toMatch(/dimension_mismatch/)
  })

  test('[#28] preserves signed numerator bounds before [0, piMax] clamp so obsUpper < fprLower with tpr > fpr returns assumption_inconsistent (NOT [0, 0])', () => {
    // wild_flagged ~ 0.5% (upper CI ~ 1.4%), panel_fpr = 10% (lower CI ~ 7.9%), positive_tpr = 90% (lower CI ~ 87.5%)
    // Here tpr > fpr (denom > 0) AND obsUpper < fprLower -> rawUpper < 0 (impossible under non-negative prevalence!)
    const res = boundWildAiPrevalenceAndLift({
      wild_flagged_count: 5,
      wild_scorable_n: 1000,
      panel_false_positives: 100,
      panel_n: 1000,
      positive_recall_hits: 900,
      positive_recall_trials: 1000,
      disclosed_pi_max: 0.2,
    })

    expect(res.status).toBe('assumption_inconsistent')
    expect(res.identifiable).toBe(false)
    expect(res.consistent).toBe(false)
    expect(res.assumption_mismatch).toBe(true)
    expect(res.intersection_empty).toBe(true)
    expect(res.lower).toBeNull()
    expect(res.upper).toBeNull()
    expect(res.prevalence_lower).toBeNull()
    expect(res.prevalence_upper).toBeNull()
    expect(res.data_upper).not.toBeNull()
    expect(res.data_upper!).toBeLessThan(0)
  })

  test('[#29] fails closed on derived Gaussian variance underflow (scale=1e-200) and overflow (scale=1e200) without NaN or Infinity', () => {
    const center = new Array<number>(60).fill(0.5)

    // Direct density calculation throws cleanly on scale underflow (1e-200 -> var=0) and overflow (1e200 -> var=Infinity)
    expect(() => computeGaussianLogDensity60(center, center, 1e-200)).toThrow(
      /invalid_derived_variance/,
    )
    expect(() => computeGaussianLogDensity60(center, center, 1e200)).toThrow(
      /invalid_derived_variance/,
    )

    const validCert = buildLocalAiModelCertificate({
      certificate_id: 'cert_29_scale',
      model_version: 'local-ai/1',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: {
        f1: 0.9, f2: 0.9, f3: 0.9, f4: 0.9, f5: 0.9, f6: 0.9, f7: 0.9, f8: 0.9,
      },
      unseen_framework_recalls: { f_unseen: 0.7 },
      threshold_panel_n: 300,
      test_panel_n: 1000,
      test_panel_false_positives: 0,
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.01,
      panel_vs_wild_auc: 0.5,
    })

    const obsBytes = compressBehavioralStats60({ stats_60: center })

    for (const badScale of [1e-200, 1e200]) {
      const scorer = new LocalAiLikelihoodScorer({
        certificate: validCert,
        human_centroid_60: center,
        human_scale: badScale,
        family_profiles: [{ family_id: 'f1', centroid_60: center, scale: 1 }],
      })
      const scored = scorer.scorePv({
        pv_id: `pv_bad_scale_${badScale}`,
        pointer_type: 'fine',
        interaction_event_count: 25,
        compressed_stats_60: obsBytes,
      })

      expect(scored.scorable).toBe(false)
      expect(scored.status).toBe('unscorable')
      expect(scored.max_likelihood_ratio).toBeNull()
      expect(scored.novelty_score).toBeNull()
      expect(scored.unscorable_reason).toMatch(/invalid_derived_variance/)
      expect(JSON.stringify(scored)).not.toContain('NaN')
      expect(JSON.stringify(scored)).not.toContain('Infinity')
    }
  })

  test('[#29 Round 3] guards per-observation (diff*diff)/variance overflow (scale=1e-160) so scoreBatch does not throw and marks overflowing PV unscorable while scoring normal PVs', () => {
    const center = new Array<number>(60).fill(0)
    const residualOne = new Array<number>(60).fill(1) // diff = 1.0 -> (1.0)^2 / 1e-320 = Infinity

    // scale = 1e-160 has scale*scale = 1e-320 (positive finite subnormal), so direct density overflows on residual-1
    expect(() => computeGaussianLogDensity60(residualOne, center, 1e-160)).toThrow(/overflow\/NaN/)

    const validCert = buildLocalAiModelCertificate({
      certificate_id: 'cert_29_subnormal_overflow',
      model_version: 'local-ai/1',
      issued_at: '2026-11-20T00:00:00Z',
      positive_family_recalls: {
        f1: 0.9, f2: 0.9, f3: 0.9, f4: 0.9, f5: 0.9, f6: 0.9, f7: 0.9, f8: 0.9,
      },
      unseen_framework_recalls: { f_unseen: 0.7 },
      threshold_panel_n: 300,
      test_panel_n: 1000,
      test_panel_false_positives: 0,
      panel_cohort_coverage: {
        assistive_tech_included: true,
        input_methods_included: true,
        ad_blockers_included: true,
      },
      wild_flagged_rate: 0.01,
      panel_vs_wild_auc: 0.5,
    })

    const scorer = new LocalAiLikelihoodScorer({
      certificate: validCert,
      human_centroid_60: center,
      human_scale: 1e-160,
      family_profiles: [{ family_id: 'f1', centroid_60: center, scale: 1 }],
    })

    const overflowBytes = compressBehavioralStats60({ stats_60: residualOne })
    const normalBytes = compressBehavioralStats60({ stats_60: center })

    const batch = scorer.scoreBatch([
      {
        pv_id: 'pv_overflow_residual_1',
        pointer_type: 'fine',
        interaction_event_count: 25,
        compressed_stats_60: overflowBytes,
      },
      {
        pv_id: 'pv_normal_at_center',
        pointer_type: 'fine',
        interaction_event_count: 25,
        compressed_stats_60: normalBytes,
      },
    ])

    expect(batch.total_pvs).toBe(2)
    expect(batch.unscorable_pvs).toBe(1)
    expect(batch.scorable_pvs).toBe(1)

    const overflowRes = batch.results.find((r) => r.pv_id === 'pv_overflow_residual_1')!
    expect(overflowRes.scorable).toBe(false)
    expect(overflowRes.status).toBe('unscorable')
    expect(overflowRes.unscorable_reason).toMatch(/gaussian_density_overflow/)
    expect(overflowRes.max_likelihood_ratio).toBeNull()
    expect(overflowRes.novelty_score).toBeNull()

    const normalRes = batch.results.find((r) => r.pv_id === 'pv_normal_at_center')!
    expect(normalRes.scorable).toBe(true)
    expect(normalRes.status).not.toBe('unscorable')
    expect(JSON.stringify(batch)).not.toContain('NaN')
    expect(JSON.stringify(batch)).not.toContain('Infinity')
  })
})
