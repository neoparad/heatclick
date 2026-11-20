/**
 * UGOKI LINK v2 — Wave 6 (Bundle 6-F) Tests
 *
 * Covers:
 *   1. Pop-up "When" 3-tier ladder (`S0_rule`, `S1_int8_hazard_tree`, `S2_int8_seq_nn` <= 50KB
 *      registered as challengers in 4-F `MlModelRegistry`)
 *   2. Counterfactual Timing Randomization over pre-registered threshold grid + `no_show`,
 *      recording `first_crossing_ms` for non-rendering controls and comparing strictly inside
 *      the common lower-threshold triggered cohort.
 *   3. Pop-up "Whether / Which" 5-tier ladder (`P0`, `P1 <= 3 segments`, `P2` Thompson/UCB with
 *      4-G creative-attribute priors, `P2.5` depth <= 3 int8 policy tree, `P3` CATE uplift
 *      showing iff `LCB > cost && guardrails ok` else abstaining `no_show`).
 *   4. Unified Adaptive Allocator Constants (`floor = max(0.10, 1/(2K))`, `static = 0.10`,
 *      start `>= 310` expected CV/arm, update freeze when smallest arm `< 50` matured CV,
 *      7-day check cadence, 10k IPS full-unit replay verification).
 */

import {
  packageInt8ModelArtifact,
  type Int8ModelArtifactPayload,
} from '../ml/foundation/int8-tree-runtime';
import { MlModelRegistry } from '../ml/foundation/registry';
import {
  compareTimingArmsInCommonTriggeredSet,
  computeAdaptiveBanditAllocation,
  computeBanditMinArmFloor,
  drawTimingThresholdArm,
  POPUP_BANDIT_CONSTANTS,
  recordCounterfactualTimingCrossings,
  registerPopupSelectionChallengers,
  registerPopupTimingChallengers,
  scoreS0RuleTiming,
  scoreS1Int8HazardTree,
  scoreS2Int8SequentialNn,
  selectP1PreregisteredSegmentArm,
  selectP25ShallowPolicyTreeArm,
  selectP3CateUpliftArm,
  verifyBanditPolicyByFullUnitReplay,
  type TimingGridCandidate,
  type TimingUnitTrace,
} from './popup';

function makeValidInt8TreePayload(modelId: string): Int8ModelArtifactPayload {
  return {
    abi_version: 1,
    model_id: modelId,
    version: 'v1',
    license_id: 'Proprietary-UGOKI-LINK',
    license_notice: 'UGOKI LINK v2 int8 test tree',
    feature_ids: ['scroll_depth_pct', 'dwell_sec', 'reversals', 'exit_intent'],
    base_logit_q8: 0,
    trees: [
      [
        { feature_idx: 0, threshold_int: 50, left_idx: 1, right_idx: 2, leaf_logit_q8: 0 },
        { feature_idx: -1, threshold_int: 0, left_idx: -1, right_idx: -1, leaf_logit_q8: -120 },
        { feature_idx: -1, threshold_int: 0, left_idx: -1, right_idx: -1, leaf_logit_q8: 220 },
      ],
    ],
  };
}

describe('Wave 6 Bundle 6-F: Pop-up "When" Timing Ladder & Counterfactual Randomization', () => {
  test('scores S0 rule, S1 int8 hazard tree, and S2 int8 sequential NN (<=50KB) and registers challengers', () => {
    const registry = new MlModelRegistry();
    const s1Payload = makeValidInt8TreePayload('popup_s1_hazard');
    const s2Weights = {
      vocab_size: 8,
      hidden_dim: 4,
      token_emb_i8: Array.from({ length: 32 }, (_, i) => ((i * 19) % 100) - 40),
      rec_weight_i8: [64, 64, 64, 64],
      out_weight_i8: [30, 20, -10, 40],
      out_bias_q8: 16,
    };

    const { s1Artifact, s2Sha256 } = registerPopupTimingChallengers({
      registry,
      tenantScope: 'tenant_1',
      s1Payload,
      s2Weights,
      nowIso: '2026-11-20T00:00:00Z',
    });

    expect(s1Artifact.compressed_bytes).toBeLessThanOrEqual(50 * 1024);
    expect(s2Sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.getModelVersion('popup_timing_s1_v1')?.status).toBe('challenger');
    expect(registry.getModelVersion('popup_timing_s2_int8_seq_v1')?.status).toBe('challenger');

    const deepObs = {
      t_mono_ms: 18_000,
      tick_kind: 'tick_5s' as const,
      scroll_depth_pct: 75,
      dwell_ms: 18_000,
      reversals: 2,
      exit_intent_signal: false,
      event_tokens: [1, 2, 5, 3],
    };

    const s0 = scoreS0RuleTiming(deepObs, {
      min_dwell_ms: 15_000,
      min_scroll_pct: 60,
      trigger_on_exit_intent: true,
    });
    expect(s0.triggered).toBe(true);
    expect(s0.score_permille).toBe(650);

    const s1 = scoreS1Int8HazardTree({
      artifact: s1Artifact,
      expectedSha256: s1Artifact.artifact_sha256,
      obs: deepObs,
    });
    expect(s1.used_fallback).toBe(false);
    expect(s1.score_permille).toBeGreaterThan(500);

    const s2a = scoreS2Int8SequentialNn([1, 2, 5, 3], s2Weights);
    const s2b = scoreS2Int8SequentialNn([1, 2, 5, 3], s2Weights);
    expect(s2a.score_permille).toBe(s2b.score_permille); // Bit-identical integer arithmetic
    expect(s2a.score_permille).toBeGreaterThanOrEqual(0);
    expect(s2a.score_permille).toBeLessThanOrEqual(1000);
  });

  test('counterfactual timing randomization logs crossings for no_show controls and compares inside common triggered cohort', () => {
    const grid: TimingGridCandidate[] = [
      { arm_id: 'thr_500', kind: 'score_quantile', threshold_permille: 500, weight: 1 },
      { arm_id: 'thr_700', kind: 'score_quantile', threshold_permille: 700, weight: 1 },
      { arm_id: 'no_show', kind: 'no_show', threshold_permille: null, weight: 1 },
    ];

    const draw1 = drawTimingThresholdArm({
      hmacSecret: 'sec_timing_test',
      experimentId: 'exp_t1',
      unitId: 'u_001',
      grid,
    });
    const draw2 = drawTimingThresholdArm({
      hmacSecret: 'sec_timing_test',
      experimentId: 'exp_t1',
      unitId: 'u_001',
      grid,
    });
    expect(draw1.candidate.arm_id).toBe(draw2.candidate.arm_id);

    // Record counterfactual crossings for a `no_show` unit that crosses 500 at 10s and 700 at 20s
    const controlTrace = recordCounterfactualTimingCrossings({
      unitId: 'u_ctrl_1',
      assignedCandidate: grid[2],
      gridThresholdsPermille: [500, 700],
      tickScores: [
        { t_mono_ms: 5_000, score_permille: 300 },
        { t_mono_ms: 10_000, score_permille: 540 },
        { t_mono_ms: 20_000, score_permille: 760 },
      ],
      outcomeConverted: 0,
    });
    expect(controlTrace.rendered_popup).toBe(false);
    expect(controlTrace.first_crossing_ms_by_threshold[500]).toBe(10_000);
    expect(controlTrace.first_crossing_ms_by_threshold[700]).toBe(20_000);

    // A unit that never reaches 500 MUST be excluded from the common triggered cohort
    const traces: TimingUnitTrace[] = [
      controlTrace,
      recordCounterfactualTimingCrossings({
        unitId: 'u_ctrl_never',
        assignedCandidate: grid[2],
        gridThresholdsPermille: [500, 700],
        tickScores: [{ t_mono_ms: 5_000, score_permille: 200 }],
        outcomeConverted: 1,
      }),
      recordCounterfactualTimingCrossings({
        unitId: 'u_trt_1',
        assignedCandidate: grid[0],
        gridThresholdsPermille: [500, 700],
        tickScores: [{ t_mono_ms: 10_000, score_permille: 550 }],
        outcomeConverted: 1,
      }),
    ];

    const cmp = compareTimingArmsInCommonTriggeredSet({
      traces,
      armAId: 'thr_500',
      thresholdAPermille: 500,
      armBId: 'no_show',
      thresholdBPermille: null,
    });
    expect(cmp.common_filter_threshold_permille).toBe(500);
    expect(cmp.arm_a_n).toBe(1);
    expect(cmp.arm_b_n).toBe(1); // u_ctrl_never excluded!
    expect(cmp.arm_a_rate).toBe(1);
    expect(cmp.arm_b_rate).toBe(0);
    expect(cmp.diff_a_minus_b).toBe(1);
  });
});

describe('Wave 6 Bundle 6-F: Pop-up "Whether / Which" 5-Tier Ladder & Unified Bandit Constants', () => {
  test('enforces exact §8.3 unified constants: floor=max(0.10, 1/(2K)), static=0.10, start>=310, update>=50 smallest arm', () => {
    expect(POPUP_BANDIT_CONSTANTS.staticUniformSlice).toBe(0.1);
    expect(POPUP_BANDIT_CONSTANTS.startMinExpectedConversionsPerArm).toBe(310);
    expect(POPUP_BANDIT_CONSTANTS.updateMinMaturedConversionsSmallestArm).toBe(50);
    expect(POPUP_BANDIT_CONSTANTS.updateCheckCadenceDays).toBe(7);
    expect(POPUP_BANDIT_CONSTANTS.replayVerificationIterations).toBe(10_000);

    // K = 3 -> 1/(2*3) = 0.1667 > 0.10
    expect(computeBanditMinArmFloor(3)).toBeCloseTo(1 / 6, 6);
    // K = 6 -> 1/(2*6) = 0.0833 < 0.10 -> clamped to 0.10
    expect(computeBanditMinArmFloor(6)).toBe(0.1);

    // Missing `no_show` arm MUST throw
    expect(() =>
      computeAdaptiveBanditAllocation({
        arms: [
          { arm_id: 'v1', matured_trials: 1000, matured_conversions: 60, expected_conversions_at_start: 350 },
          { arm_id: 'v2', matured_trials: 1000, matured_conversions: 70, expected_conversions_at_start: 350 },
        ],
        seedKey: 'test_missing_noshow',
      })
    ).toThrow(/no_show/);

    // Expected CV/arm < 310 -> stays uniform P0
    const notStarted = computeAdaptiveBanditAllocation({
      arms: [
        { arm_id: 'no_show', is_no_show: true, matured_trials: 800, matured_conversions: 60, expected_conversions_at_start: 250 },
        { arm_id: 'v1', matured_trials: 800, matured_conversions: 90, expected_conversions_at_start: 350 },
      ],
      seedKey: 'test_start_gate',
    });
    expect(notStarted.status).toBe('not_started_insufficient_expected_cv');
    expect(notStarted.probabilities['no_show']).toBeCloseTo(0.5, 4);

    // Smallest arm matured CV < 50 -> freezes previous probabilities!
    const prev = { no_show: 0.25, v1: 0.45, v2: 0.3 };
    const frozen = computeAdaptiveBanditAllocation({
      arms: [
        { arm_id: 'no_show', is_no_show: true, matured_trials: 1000, matured_conversions: 42, expected_conversions_at_start: 350 },
        { arm_id: 'v1', matured_trials: 1000, matured_conversions: 120, expected_conversions_at_start: 350 },
        { arm_id: 'v2', matured_trials: 1000, matured_conversions: 85, expected_conversions_at_start: 350 },
      ],
      previousProbabilities: prev,
      seedKey: 'test_freeze_gate',
    });
    expect(frozen.status).toBe('frozen_insufficient_matured_cv');
    expect(frozen.smallest_arm_matured_cv).toBe(42);
    expect(frozen.probabilities).toEqual(prev);

    // All arms >= 50 matured CV & >= 310 expected CV -> updates with 4-G priors & respects floor max(0.10, 1/(2K))!
    const updated = computeAdaptiveBanditAllocation({
      arms: [
        { arm_id: 'no_show', is_no_show: true, matured_trials: 2000, matured_conversions: 55, expected_conversions_at_start: 400 },
        {
          arm_id: 'v_winner',
          attributes: { appeal_kind: 'price_discount', tone: 'neutral', length_bucket: 'short', offer_kind: 'coupon' },
          class_prior_alpha: 15,
          class_prior_beta: 185,
          matured_trials: 2000,
          matured_conversions: 145,
          expected_conversions_at_start: 400,
        },
        {
          arm_id: 'v_weak',
          attributes: { appeal_kind: 'urgency', tone: 'urgent', length_bucket: 'long', offer_kind: 'none' },
          class_prior_alpha: 4,
          class_prior_beta: 196,
          matured_trials: 2000,
          matured_conversions: 52,
          expected_conversions_at_start: 400,
        },
      ],
      seedKey: 'test_update_ok',
    });
    expect(updated.status).toBe('updated');
    expect(updated.probabilities['v_winner']).toBeGreaterThan(0.5);
    // Floor for K=3 is 1/6 ≈ 0.166667
    expect(updated.probabilities['no_show']).toBeGreaterThanOrEqual(1 / 6 - 1e-4);
    expect(updated.probabilities['v_weak']).toBeGreaterThanOrEqual(1 / 6 - 1e-4);
    const probSum =
      updated.probabilities['no_show'] +
      updated.probabilities['v_winner'] +
      updated.probabilities['v_weak'];
    expect(probSum).toBeCloseTo(1, 4);
  });

  test('enforces P1 <= 3 segments, P2.5 depth <= 3 int8 tree, P3 CATE LCB abstention, 10k IPS replay, and 4-F challenger registration', () => {
    // P1 rejects > 3 segments
    const p1Invalid = selectP1PreregisteredSegmentArm({
      segmentId: 'seg1',
      preregisteredSegmentPolicy: { seg1: 'v1', seg2: 'v2', seg3: 'v1', seg4: 'v3' },
    });
    expect(p1Invalid.valid).toBe(false);
    expect(p1Invalid.arm_id).toBe('no_show');

    const p1Valid = selectP1PreregisteredSegmentArm({
      segmentId: 'seg2',
      preregisteredSegmentPolicy: { seg1: 'v1', seg2: 'v2', seg3: 'no_show' },
    });
    expect(p1Valid.valid).toBe(true);
    expect(p1Valid.arm_id).toBe('v2');

    // P2.5 rejects depth > 3 -> safe fallback to no_show
    const treeArtifact = packageInt8ModelArtifact(makeValidInt8TreePayload('popup_p25_tree'));
    const tooDeep = selectP25ShallowPolicyTreeArm({
      treeArtifact,
      expectedSha256: treeArtifact.artifact_sha256,
      declaredTreeDepth: 4,
      integerFeatures: { scroll_depth_pct: 80, dwell_sec: 20, reversals: 1, exit_intent: 0 },
      armIds: ['no_show', 'v_coupon'],
      serverUniformU: 0.5,
    });
    expect(tooDeep.used_fallback).toBe(true);
    expect(tooDeep.arm_id).toBe('no_show');

    const okDepth = selectP25ShallowPolicyTreeArm({
      treeArtifact,
      expectedSha256: treeArtifact.artifact_sha256,
      declaredTreeDepth: 3,
      integerFeatures: { scroll_depth_pct: 80, dwell_sec: 20, reversals: 1, exit_intent: 0 },
      armIds: ['no_show', 'v_coupon'],
      serverUniformU: 0.5,
    });
    expect(okDepth.used_fallback).toBe(false);

    // P3 CATE: abstains to no_show if LCB <= cost OR guardrail violated
    const p3Abstain = selectP3CateUpliftArm({
      candidates: [
        { arm_id: 'v_harmful', cate_point: 0.05, cate_lcb: 0.03, venn_abers_width: 0.01, guardrail_harm_ucb: 0.04 },
        { arm_id: 'v_uncertain', cate_point: 0.015, cate_lcb: 0.004, venn_abers_width: 0.02, guardrail_harm_ucb: 0.001 },
      ],
      tenant_cost_threshold: 0.01,
      guardrail_margin: 0.02,
    });
    expect(p3Abstain.decision).toBe('abstain_no_show');
    expect(p3Abstain.arm_id).toBe('no_show');

    const p3Show = selectP3CateUpliftArm({
      candidates: [
        { arm_id: 'v_strong', cate_point: 0.05, cate_lcb: 0.028, venn_abers_width: 0.015, guardrail_harm_ucb: 0.005 },
      ],
      tenant_cost_threshold: 0.01,
      guardrail_margin: 0.02,
    });
    expect(p3Show.decision).toBe('show');
    expect(p3Show.arm_id).toBe('v_strong');

    // Full-unit IPS replay verification
    const loggedUnits = Array.from({ length: 400 }, (_, i) => ({
      logged_arm_id: i % 2 === 0 ? 'v_winner' : 'no_show',
      logged_propensity: 0.5,
      reward: i % 2 === 0 ? (i % 5 === 0 ? 1 : 0) : i % 20 === 0 ? 1 : 0,
    }));
    const replay = verifyBanditPolicyByFullUnitReplay({
      loggedUnits,
      newPolicyProbs: { v_winner: 0.8, no_show: 0.2 },
      championIpsValue: 0.08,
    });
    expect(replay.replay_iterations).toBe(10_000);
    expect(replay.ips_estimate).toBeGreaterThan(0.14);
    expect(replay.beats_champion).toBe(true);

    // 4-F challenger registration
    const registry = new MlModelRegistry();
    const ids = registerPopupSelectionChallengers(registry, 'tenant_1', '2026-11-20T00:00:00Z');
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(registry.getModelVersion(id)?.status).toBe('challenger');
    }
  });
});
