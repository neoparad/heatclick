import crypto from 'node:crypto';
import {
  DEFAULT_VISUAL_FEATURE_FAMILY,
  MlModelRegistry,
  PointInTimeLeakageError,
  ProhibitedComputeTargetError,
  buildPointInTimeFeatureSnapshot,
  computeDecisionGapRate,
  evaluateAutomaticRollback,
  evaluateFeatureLifecycleTransition,
  evaluateInt8ModelArtifact,
  evaluateModelPromotion,
  filterTokenValidTrainingRows,
  issueDecisionToken,
  packageInt8ModelArtifact,
  validateInt8ModelArtifact,
  validateTrainingJobContract,
  verifyDecisionToken,
  type FeatureDefinition,
  type Int8ModelArtifactPayload,
} from './index';

describe('Bundle 4-F: ML Foundation (Contracts, Decision Tokens, Registry, §8.8 Promotion & §8.9 Int8 Tree)', () => {
  test('Feature contracts: Log Wide / Serve Narrow, point-in-time leakage firewall, visual family & automatic admission/retirement', () => {
    const registry: FeatureDefinition[] = [
      ...DEFAULT_VISUAL_FEATURE_FAMILY,
      {
        feature_id: 'tel.scroll_max_bin',
        version: 1,
        family: 'telemetry_behaviour',
        known_at: 'trigger',
        encoding: 'int_bin',
        pii_class: 'none',
        consent_min: 'cookieless',
        state: 'active',
        standard_lane_only: true,
      },
      {
        feature_id: 'tel.vitals_lcp_bin',
        version: 1,
        family: 'telemetry_vitals',
        known_at: 'context',
        encoding: 'int_bin',
        pii_class: 'none',
        consent_min: 'cookieless',
        state: 'recording',
        standard_lane_only: true,
      },
    ];

    const decisionTime = 1_795_000_010_000;
    const snap = buildPointInTimeFeatureSnapshot({
      decisionId: 'dec_01',
      decisionTimeMs: decisionTime,
      featureSetVersion: 'fs_v1',
      batchSnapshotId: 'batch_2026_11_20',
      structFp: 'sec_abc123',
      registry,
      observations: [
        { feature_id: 'tel.scroll_max_bin', raw_value: 4, known_at_ms: decisionTime - 100 },
        { feature_id: 'tel.vitals_lcp_bin', raw_value: 1800, known_at_ms: decisionTime - 500 },
        { feature_id: 'vis.above_fold_layout_v1', raw_value: 72, known_at_ms: decisionTime - 1000 },
        {
          feature_id: 'vis.section_image_embedding_challenger_v1',
          raw_value: 15,
          known_at_ms: decisionTime - 1000,
        },
      ],
    });

    // Log wide: recording + active features logged; Serve narrow: ONLY active features served!
    expect(snap.logged_raw_features['tel.scroll_max_bin']).toBe(4);
    expect(snap.logged_raw_features['tel.vitals_lcp_bin']).toBe(1800);
    expect(snap.logged_raw_features['vis.above_fold_layout_v1']).toBe(72);
    expect(snap.active_serving_features).toEqual({ 'tel.scroll_max_bin': 4 });
    expect(snap.omitted_candidate_ids).toEqual(['vis.section_image_embedding_challenger_v1']);

    // Point-in-time leakage guard: any feature known AFTER decision_time_ms MUST throw!
    expect(() =>
      buildPointInTimeFeatureSnapshot({
        decisionId: 'dec_leak',
        decisionTimeMs: decisionTime,
        featureSetVersion: 'fs_v1',
        batchSnapshotId: 'batch_2026_11_20',
        structFp: 'sec_abc123',
        registry,
        observations: [
          { feature_id: 'tel.scroll_max_bin', raw_value: 9, known_at_ms: decisionTime + 1 },
        ],
      })
    ).toThrow(PointInTimeLeakageError);

    // Automatic admission: 14d fill >= 0.95 + 2 consecutive splits adjusted LCB > 0 -> active
    const admit = evaluateFeatureLifecycleTransition({
      feature: registry.find((f) => f.feature_id === 'tel.vitals_lcp_bin')!,
      fill_rate_14d: 0.97,
      fill_days_observed: 14,
      sdk_canary_clean: true,
      split_evaluations: [
        { split_id: 'w1', adjusted_delta_lcb: 0.004, permutation_importance_ucb: 0.01 },
        { split_id: 'w2', adjusted_delta_lcb: 0.003, permutation_importance_ucb: 0.01 },
      ],
    });
    expect(admit.next_state).toBe('active');

    // Automatic retirement: 3 consecutive zero-contribution cycles -> retired
    const retire = evaluateFeatureLifecycleTransition({
      feature: registry.find((f) => f.feature_id === 'tel.scroll_max_bin')!,
      fill_rate_14d: 0.99,
      fill_days_observed: 30,
      sdk_canary_clean: true,
      split_evaluations: [
        { split_id: 'c1', adjusted_delta_lcb: -0.001, permutation_importance_ucb: 0 },
        { split_id: 'c2', adjusted_delta_lcb: -0.002, permutation_importance_ucb: -0.001 },
        { split_id: 'c3', adjusted_delta_lcb: 0, permutation_importance_ucb: 0 },
      ],
    });
    expect(retire.next_state).toBe('retired');
    expect(retire.triggered_retirement).toBe(true);
  });

  test('Signed decision_token: verifies HMAC, enforces (token,label) & unit/day caps, preserves counterfactuals & tracks gap rate', () => {
    const secret = 'dtk_secret_2026';
    const day0 = Date.UTC(2026, 10, 20, 10, 0, 0);

    const t1 = issueDecisionToken(
      {
        tenant_id: 'ten_1',
        site_id: 'site_1',
        pv_id: 'pv_aaa',
        unit_id: 'vis_1',
        decision_no: 1,
        issued_at_ms: day0,
        arm_id: 'treatment',
        propensity: 0.5,
        bundle_hash: 'bh_1',
        is_counterfactual_no_show: false,
      },
      secret
    );
    const t2SameUnit = issueDecisionToken(
      {
        tenant_id: 'ten_1',
        site_id: 'site_1',
        pv_id: 'pv_bbb',
        unit_id: 'vis_1',
        decision_no: 1,
        issued_at_ms: day0 + 60_000,
        arm_id: 'treatment',
        propensity: 0.5,
        bundle_hash: 'bh_1',
        is_counterfactual_no_show: false,
      },
      secret
    );
    const tCounterfactual = issueDecisionToken(
      {
        tenant_id: 'ten_1',
        site_id: 'site_1',
        pv_id: 'pv_ccc',
        unit_id: 'vis_2',
        decision_no: 1,
        issued_at_ms: day0,
        arm_id: 'holdout',
        propensity: 0.05,
        bundle_hash: 'bh_1',
        is_counterfactual_no_show: true,
      },
      secret
    );

    expect(verifyDecisionToken(t1, secret)).toBe(true);
    const forged = { ...t1, token: 'dtk1.00000000000000000000000000000000' };
    expect(verifyDecisionToken(forged, secret)).toBe(false);

    const filtered = filterTokenValidTrainingRows(
      [
        { signed_token: forged, label_key: 'aff_click', outcome_value: 1, occurred_at_ms: day0 },
        { signed_token: t1, label_key: 'aff_click', outcome_value: 1, occurred_at_ms: day0 },
        // Duplicate (token, label) -> rejected
        { signed_token: t1, label_key: 'aff_click', outcome_value: 1, occurred_at_ms: day0 + 1000 },
        // Second rewarded outcome for SAME unit on SAME UTC day -> rejected by daily cap!
        { signed_token: t2SameUnit, label_key: 'aff_click', outcome_value: 1, occurred_at_ms: day0 + 70_000 },
        // Counterfactual holdout trigger row -> preserved!
        { signed_token: tCounterfactual, label_key: 'aff_click', outcome_value: 0, occurred_at_ms: day0 },
      ],
      secret
    );

    expect(filtered.valid_rows).toHaveLength(2);
    expect(filtered.rejected_invalid_token_count).toBe(1);
    expect(filtered.rejected_duplicate_token_label_count).toBe(1);
    expect(filtered.rejected_unit_daily_cap_count).toBe(1);
    expect(filtered.counterfactual_row_count).toBe(1);

    // Decision sequence gap rate: pv_1 has [1, 3] (missing 2 -> 1/3), pv_2 has [1, 2] (0 missing) => 1/5 = 0.2
    const gap = computeDecisionGapRate([
      { pv_id: 'pv_1', decision_no: 1 },
      { pv_id: 'pv_1', decision_no: 3 },
      { pv_id: 'pv_2', decision_no: 1 },
      { pv_id: 'pv_2', decision_no: 2 },
    ]);
    expect(gap.missing_decisions).toBe(1);
    expect(gap.gap_rate).toBeCloseTo(0.2, 5);
  });

  test('Model Registry, 8d/14d deletion propagation, Inngest compute isolation & §8.8 2-entry promotion + auto rollback', () => {
    // Compute isolation blocks CRAWL VPS and production ClickHouse (§8.10)
    expect(() =>
      validateTrainingJobContract({
        job_id: 'job_bad_vps',
        inngest_event_name: 'ml/train.requested',
        tenant_concurrency_key: 'ten_1',
        compute_target: 'crawl_vps',
        dataset_id: 'ds_1',
        feature_set_version: 'fs_1',
        label_contract_version: 'lc_1',
        deletion_generation: 1,
        seed: 42,
        max_cost_usd: 10,
        challenger_only: true,
        region: 'ap-northeast-1',
      })
    ).toThrow(ProhibitedComputeTargetError);

    expect(() =>
      validateTrainingJobContract({
        job_id: 'job_bad_ch',
        inngest_event_name: 'ml/recompute.requested',
        tenant_concurrency_key: 'ten_1',
        compute_target: 'clickhouse_prod',
        dataset_id: 'ds_1',
        feature_set_version: 'fs_1',
        label_contract_version: 'lc_1',
        deletion_generation: 1,
        seed: 42,
        max_cost_usd: 10,
        challenger_only: true,
        region: 'ap-northeast-1',
      })
    ).toThrow(ProhibitedComputeTargetError);

    expect(
      validateTrainingJobContract({
        job_id: 'job_gpu_ok',
        inngest_event_name: 'ml/train.requested',
        tenant_concurrency_key: 'ten_1',
        compute_target: 'external_gpu_container',
        dataset_id: 'ds_1',
        feature_set_version: 'fs_1',
        label_contract_version: 'lc_1',
        deletion_generation: 1,
        seed: 42,
        max_cost_usd: 25,
        challenger_only: true,
        region: 'ap-northeast-1',
      }).valid
    ).toBe(true);

    // Registry + deletion propagation
    const registry = new MlModelRegistry();
    const now = Date.UTC(2026, 10, 20);
    registry.registerModelVersion({
      model_version_id: 'm_v1',
      model_family: 'hazard_s1',
      tenant_scope: 'ten_1',
      artifact_sha256: 'a'.repeat(64),
      abi_version: 1,
      feature_set_version: 'fs_1',
      label_contract_version: 'lc_1',
      dataset_id: 'ds_1',
      deletion_generation: 1,
      code_version: 'sha_code',
      runtime_env: 'node24',
      seed: 7,
      license_bundle: {
        license_id: 'Apache-2.0',
        notice_text: 'Licensed under Apache 2.0',
        distribution_scope: 'edge_and_browser_classifier',
      },
      created_at_iso: new Date(now).toISOString(),
      status: 'challenger',
      contributing_subject_ids: ['subj_del_1'],
    });
    registry.setAlias('prod_hazard', 'm_v1');
    registry.registerExtraction({
      extraction_id: 'ext_1',
      tenant_id: 'ten_1',
      dataset_id: 'ds_1',
      created_at_ms: now,
      encryption_key_version: 'k_v1',
      subject_ids: ['subj_del_1'],
    });

    const delSummary = registry.propagateDeletion('subj_del_1', now + 3600_000);
    expect(delSummary.excluded_model_versions).toEqual(['m_v1']);
    expect(delSummary.rewritten_extractions).toEqual(['ext_1']);
    expect(registry.resolveAlias('prod_hazard')).toBeUndefined();

    // §8.8 Promotion: superior + non_inferior tracks
    const supPass = evaluateModelPromotion({
      challenger_version_id: 'c_2',
      champion_version_id: 'c_1',
      track: 'superior',
      scope: 'delivery_policy',
      offline_delta_lcb: 0.015,
      shadow_days_completed: 14,
      shadow_clean: true,
      ope_delta_lcb: 0.008,
      static_slice_consistent: true,
      policy_test_passed: true,
      ev_proven_predicate_passed: true,
      platform_canary_passed: true,
    });
    expect(supPass.promoted).toBe(true);
    expect(supPass.evidence_level).toBe('proven');

    const niPass = evaluateModelPromotion({
      challenger_version_id: 'c_fast',
      champion_version_id: 'c_1',
      track: 'non_inferior',
      scope: 'analytics_only',
      offline_delta_lcb: -0.004,
      shadow_days_completed: 14,
      shadow_clean: true,
      platform_canary_passed: true,
      non_inferiority: {
        max_degradation_margin: 0.01,
        adoption_gain_met: true,
        adoption_gain_basis: 'latency_reduced_45pct',
      },
    });
    expect(niPass.promoted).toBe(true);
    expect(niPass.evidence_level).toBe('observed');

    // Auto rollback selects safe candidate or base fallback
    const rb = evaluateAutomaticRollback(
      {
        guardrail_breached: false,
        calibration_slope: 1.35, // breached!
        token_verification_rate: 0.995,
        null_feature_rate_spike: false,
      },
      [
        { version_id: 'old_bad_del', passes_safety_checks: true, passes_deletion_generation: false, passes_quality_floor: true },
        { version_id: 'old_safe', passes_safety_checks: true, passes_deletion_generation: true, passes_quality_floor: true },
      ]
    );
    expect(rb.should_rollback).toBe(true);
    expect(rb.target_alias_version_id).toBe('old_safe');
  });

  test('§8.9 <=50KB int8 tree table: bit-exact browser vs server parity, 50KB cap rejection & hash-mismatch fallback', () => {
    const payload: Int8ModelArtifactPayload = {
      abi_version: 1,
      model_id: 'hazard_tree_int8',
      version: '1.0.0',
      feature_ids: ['scroll_depth_bin', 'dwell_sec_bin', 'reversals'],
      base_logit_q8: -128,
      trees: [
        [
          { feature_idx: 0, threshold_int: 50, left_idx: 1, right_idx: 2, leaf_logit_q8: 0 },
          { feature_idx: -1, threshold_int: 0, left_idx: -1, right_idx: -1, leaf_logit_q8: -96 },
          { feature_idx: 1, threshold_int: 20, left_idx: 3, right_idx: 4, leaf_logit_q8: 0 },
          { feature_idx: -1, threshold_int: 0, left_idx: -1, right_idx: -1, leaf_logit_q8: 64 },
          { feature_idx: -1, threshold_int: 0, left_idx: -1, right_idx: -1, leaf_logit_q8: 224 },
        ],
      ],
      dense_layer: {
        in_dim: 3,
        out_dim: 2,
        weights_i8: [2, -1, 4, 1, 3, -2],
        bias_q8: [16, -8],
        shift_bits: 1,
      },
      license_id: 'Apache-2.0',
      license_notice: 'Copyright LINKTH Inc. Apache License 2.0.',
    };

    const artifact = packageInt8ModelArtifact(payload);
    expect(artifact.compressed_bytes).toBeLessThanOrEqual(50 * 1024);
    expect(validateInt8ModelArtifact(artifact, artifact.artifact_sha256).valid).toBe(true);

    // Oversized (>50 KB) artifact MUST be rejected!
    expect(() => packageInt8ModelArtifact(payload, 52 * 1024)).toThrow(/50 KB/);

    // Bit-exact parity across 200 feature vectors (browser eval === server eval)
    for (let i = 0; i < 200; i++) {
      const features = {
        scroll_depth_bin: (i * 7) % 100,
        dwell_sec_bin: (i * 13) % 60,
        reversals: i % 5,
      };
      const u = (i % 100) / 100;
      const browserEval = evaluateInt8ModelArtifact({
        artifact,
        expectedSha256: artifact.artifact_sha256,
        integerFeatures: features,
        serverUniformU: u,
      });
      const serverEval = evaluateInt8ModelArtifact({
        artifact: JSON.parse(JSON.stringify(artifact)),
        expectedSha256: artifact.artifact_sha256,
        integerFeatures: features,
        serverUniformU: u,
      });
      expect(browserEval).toEqual(serverEval);
      expect(browserEval.ok).toBe(true);
    }

    // Tampered hash -> falls back cleanly to uniform/rule default with fallback_reason!
    const fallbackRes = evaluateInt8ModelArtifact({
      artifact,
      expectedSha256: 'f'.repeat(64),
      integerFeatures: { scroll_depth_bin: 80, dwell_sec_bin: 30, reversals: 2 },
      serverUniformU: 0.25,
      ruleDefaultArmIndex: 0,
    });
    expect(fallbackRes.ok).toBe(false);
    expect(fallbackRes.used_fallback).toBe(true);
    expect(fallbackRes.fallback_reason).toContain('SHA-256');
    expect(fallbackRes.chosen_arm_index).toBe(0);

    // [M-14]: 1) Multi-arm (numArms = 4) inverse-CDF uses serverUniformU across ALL 4 arms!
    const seenArms4 = new Set<number>();
    for (let uStep = 0; uStep < 100; uStep += 1) {
      const r4 = evaluateInt8ModelArtifact({
        artifact,
        expectedSha256: artifact.artifact_sha256,
        integerFeatures: { scroll_depth_bin: 50, dwell_sec_bin: 20, reversals: 1 },
        serverUniformU: uStep / 100,
        numArms: 4,
      });
      expect(r4.ok).toBe(true);
      expect(r4.chosen_arm_index).toBeGreaterThanOrEqual(0);
      expect(r4.chosen_arm_index).toBeLessThan(4);
      seenArms4.add(r4.chosen_arm_index);
    }
    expect(seenArms4.size).toBe(4); // Every arm 0..3 is reachable via serverUniformU CDF inversion!

    // [M-14]: 2) Actual zlib.gzipSync byte measurement rejects >50KB gzipped payload even when caller lies with measuredGzipBytes=100!
    const uncompressibleNotice = crypto.randomBytes(56_000).toString('base64'); // >56 KB true entropy (> 50 KB even after gzip!)
    const hugePayload: Int8ModelArtifactPayload = {
      ...payload,
      license_notice: uncompressibleNotice,
    };
    expect(() => packageInt8ModelArtifact(hugePayload, 100)).toThrow(/50 KB/);
    expect(
      validateInt8ModelArtifact({
        payload: hugePayload,
        artifact_sha256: artifact.artifact_sha256,
        uncompressed_bytes: 60_000,
        compressed_bytes: 100,
      }).valid
    ).toBe(false);

    // [M-14]: 3) verifyDecisionToken uses constant-time comparison and rejects length-mismatched tokens cleanly
    const dtk = issueDecisionToken(
      {
        tenant_id: 'ten_1',
        site_id: 'site_1',
        pv_id: 'pv_m14',
        unit_id: 'u_m14',
        decision_no: 1,
        issued_at_ms: 1_750_000_000_000,
        arm_id: 'arm_a',
        propensity: 0.25,
        bundle_hash: 'bh_m14',
        is_counterfactual_no_show: false,
      },
      'secret_m14'
    );
    expect(verifyDecisionToken(dtk, 'secret_m14')).toBe(true);
    expect(verifyDecisionToken({ ...dtk, token: 'dtk1.short' }, 'secret_m14')).toBe(false);
    expect(verifyDecisionToken({ ...dtk, token: `${dtk.token}extra` }, 'secret_m14')).toBe(false);
  });
});
