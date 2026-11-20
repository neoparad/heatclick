import {
  ActorBlindViolationError,
  MAX_SITE_CONVERSION_RULES,
  PLANNER_CONSTANTS,
  allocateDecision,
  assertActorBlindInput,
  chiSquareSurvivalPValue,
  computeHoldoutEpoch,
  computeTwoProportionNPerArm,
  createLockedMetricDefinition,
  drawUniformU,
  evaluateHoldoutBits,
  evaluateSrmIntegrity,
  getMeasurementStageUsableShare,
  planExperiment,
  planSdkWeightTest,
  validateMetricContractHierarchy,
  type AllocationInput,
  type AllocatorConfig,
  type LabelContract,
  type SiteConversionRule,
} from './index';

const EPOCH_ORIGIN_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeBaseInput(index: number, overrides?: Partial<AllocationInput>): AllocationInput {
  return {
    tenant_id: 'ten_01',
    site_id: 'site_jp_01',
    pv_id: `pv_${index}`,
    available_units: {
      visitor: `vis_${index}`,
      session: `ses_${index}`,
      page_view: `pv_${index}`,
    },
    identity_quality: 'A',
    consent_mode: 'stats_exempt',
    purposes: ['experiment'],
    traffic_class: 'public',
    url_id: 'url_guide_1',
    page_id: 'page_guide_1',
    viewport_class: 'mobile',
    pointer_type: 'coarse',
    now_ms: EPOCH_ORIGIN_MS + 10 * 86_400_000,
    ...overrides,
  };
}

function makeBaseConfig(overrides?: Partial<AllocatorConfig>): AllocatorConfig {
  return {
    hmacSecret: 'ugk-test-allocator-secret-2026',
    holdout: {
      global: 0.05,
      overlay: 0.05,
      patch: 0.05,
      recs: 0.05,
      epochWeeks: 26,
      epochOriginMs: EPOCH_ORIGIN_MS,
    },
    measurement: {
      stage: 'stage_c_steady',
      fullSplitMode: 'half_verify_half_deliver',
      steadyStubShare: 0.05,
      steadyAuditShare: 0.13,
    },
    layers: [
      {
        layer_id: 'overlay:modal',
        mechanism: 'overlay',
        region: 'modal',
        salt: 'salt_overlay_modal_v1',
        experiments: [
          {
            experiment_id: 'exp_modal_a',
            policy_version: 'pv1',
            alloc_epoch: 1,
            prereg_hash: 'prereg_modal_a',
            preferred_unit_kind: 'visitor',
            allow_unit_fallback: true,
            stateless_policy: 'randomise',
            slot_share: 0.5,
            arms: [
              { arm_id: 'control', weight: 1, is_control: true },
              { arm_id: 'treatment', weight: 1 },
            ],
          },
          {
            experiment_id: 'exp_modal_b',
            policy_version: 'pv1',
            alloc_epoch: 1,
            prereg_hash: 'prereg_modal_b',
            preferred_unit_kind: 'visitor',
            allow_unit_fallback: true,
            stateless_policy: 'randomise',
            slot_share: 0.5,
            arms: [
              { arm_id: 'control', weight: 1, is_control: true },
              { arm_id: 'treatment_b', weight: 1 },
            ],
          },
        ],
      },
      {
        layer_id: 'patch:sec_cta',
        mechanism: 'patch',
        region: 'sec_cta',
        salt: 'salt_patch_cta_v1',
        experiments: [
          {
            experiment_id: 'exp_cta_copy',
            policy_version: 'pv1',
            alloc_epoch: 1,
            prereg_hash: 'prereg_cta_copy',
            preferred_unit_kind: 'visitor',
            allow_unit_fallback: false, // copy test: visitor only!
            stateless_policy: 'default_only',
            slot_share: 1.0,
            arms: [
              { arm_id: 'control', weight: 1, is_control: true },
              { arm_id: 'cta_v2', weight: 1 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('lib/link/allocator — Actor-Blind Allocator, SRM, Holdouts, Planner & 3-Tier Contracts', () => {
  test('HMAC-SHA256 draws are deterministic, in [0, 1), and pass SRM across 10,000 units', () => {
    const u1 = drawUniformU('key-a', 'vis_123');
    const u2 = drawUniformU('key-a', 'vis_123');
    const u3 = drawUniformU('key-b', 'vis_123');
    expect(u1).toBe(u2);
    expect(u1).toBeGreaterThanOrEqual(0);
    expect(u1).toBeLessThan(1);
    expect(u1).not.toBe(u3);

    const cfg = makeBaseConfig();
    const canaryCounts: Record<string, number> = { aa_control_a: 0, aa_control_b: 0 };
    const ctaArmCounts: Record<string, number> = { control: 0, cta_v2: 0 };

    for (let i = 0; i < 10_000; i++) {
      const out = allocateDecision(makeBaseInput(i), cfg);
      canaryCounts[out.canary_arm] = (canaryCounts[out.canary_arm] ?? 0) + 1;
      const ctaDec = out.decisions.find(
        (d) => d.experiment_id === 'exp_cta_copy' && (d.arm_id === 'control' || d.arm_id === 'cta_v2')
      );
      if (ctaDec) {
        ctaArmCounts[ctaDec.arm_id] += 1;
      }
    }

    // Permanent A/A canary must pass SRM (EV G-1)
    const canarySrm = evaluateSrmIntegrity(canaryCounts, { aa_control_a: 1, aa_control_b: 1 });
    expect(canarySrm.status).toBe('pass');
    expect(canarySrm.p_value).toBeGreaterThan(0.01);
    expect(canarySrm.max_ci999_bound).toBeLessThanOrEqual(canarySrm.epsilon_tol);

    // Experiment arm split must pass SRM
    const ctaSrm = evaluateSrmIntegrity(ctaArmCounts, { control: 1, cta_v2: 1 });
    expect(ctaSrm.status).toBe('pass');
    expect(ctaSrm.p_value).toBeGreaterThan(0.01);

    // Biased 55/45 split MUST FAIL SRM
    const biasedSrm = evaluateSrmIntegrity({ control: 5500, treatment: 4500 }, { control: 1, treatment: 1 });
    expect(biasedSrm.status).toBe('fail');
    expect(biasedSrm.p_value).toBeLessThan(0.001);

    // Tiny sample cannot claim pass -> 'unverified'
    const tinySrm = evaluateSrmIntegrity({ control: 20, treatment: 20 }, { control: 1, treatment: 1 });
    expect(tinySrm.status).toBe('unverified');
  });

  test('enforces strict intra-layer mutual exclusion and cross-layer factorial independence (chi-square)', () => {
    const cfg = makeBaseConfig();
    // 2x2 contingency table for (overlay:modal selected experiment) x (patch:sec_cta arm)
    const table = {
      a_ctrl: 0,
      a_treat: 0,
      b_ctrl: 0,
      b_treat: 0,
    };

    for (let i = 0; i < 10_000; i++) {
      const out = allocateDecision(makeBaseInput(i), cfg);
      const modalDecs = out.decisions.filter((d) => d.layer_id === 'overlay:modal');
      // Intra-layer mutual exclusion: NEVER more than 1 experiment assigned in the same layer
      expect(modalDecs.length).toBeLessThanOrEqual(1);

      const modalExp = modalDecs[0]?.experiment_id;
      const ctaDec = out.decisions.find((d) => d.experiment_id === 'exp_cta_copy');
      if (modalExp && ctaDec && (ctaDec.arm_id === 'control' || ctaDec.arm_id === 'cta_v2')) {
        if (modalExp === 'exp_modal_a' && ctaDec.arm_id === 'control') table.a_ctrl++;
        if (modalExp === 'exp_modal_a' && ctaDec.arm_id === 'cta_v2') table.a_treat++;
        if (modalExp === 'exp_modal_b' && ctaDec.arm_id === 'control') table.b_ctrl++;
        if (modalExp === 'exp_modal_b' && ctaDec.arm_id === 'cta_v2') table.b_treat++;
      }
    }

    const total = table.a_ctrl + table.a_treat + table.b_ctrl + table.b_treat;
    expect(total).toBeGreaterThan(7_000);
    const rowA = table.a_ctrl + table.a_treat;
    const rowB = table.b_ctrl + table.b_treat;
    const colCtrl = table.a_ctrl + table.b_ctrl;
    const colTreat = table.a_treat + table.b_treat;

    const expAC = (rowA * colCtrl) / total;
    const expAT = (rowA * colTreat) / total;
    const expBC = (rowB * colCtrl) / total;
    const expBT = (rowB * colTreat) / total;

    const chiSq =
      (table.a_ctrl - expAC) ** 2 / expAC +
      (table.a_treat - expAT) ** 2 / expAT +
      (table.b_ctrl - expBC) ** 2 / expBC +
      (table.b_treat - expBT) ** 2 / expBT;

    const pVal = chiSquareSurvivalPValue(chiSq, 1);
    expect(pVal).toBeGreaterThan(0.01);
  });

  test('4 independent holdout bits (5% each, ~81.45% all-exposed) rotate cleanly every 26 weeks', () => {
    const holdoutCfg = makeBaseConfig().holdout;
    expect(computeHoldoutEpoch(EPOCH_ORIGIN_MS, EPOCH_ORIGIN_MS, 26)).toBe(0);
    expect(
      computeHoldoutEpoch(EPOCH_ORIGIN_MS + 26 * 7 * 86_400_000, EPOCH_ORIGIN_MS, 26)
    ).toBe(1);

    let globalHeld = 0;
    let overlayHeld = 0;
    let patchHeld = 0;
    let recsHeld = 0;
    let allExposed = 0;
    let rotatedGlobalFlips = 0;

    const ep0Ms = EPOCH_ORIGIN_MS + 1000;
    const ep1Ms = EPOCH_ORIGIN_MS + 26 * 7 * 86_400_000 + 1000;

    for (let i = 0; i < 10_000; i++) {
      const h0 = evaluateHoldoutBits('secret-h', 'ten_1', 'site_1', `vis_${i}`, ep0Ms, holdoutCfg);
      const h1 = evaluateHoldoutBits('secret-h', 'ten_1', 'site_1', `vis_${i}`, ep1Ms, holdoutCfg);
      expect(h0.epoch_id).toBe(0);
      expect(h1.epoch_id).toBe(1);
      if (h0.global) globalHeld++;
      if (h0.overlay) overlayHeld++;
      if (h0.patch) patchHeld++;
      if (h0.recs) recsHeld++;
      if (!h0.any_held_out) allExposed++;
      if (h0.global !== h1.global) rotatedGlobalFlips++;
    }

    // Each bit ~5% (±1%)
    expect(globalHeld / 10_000).toBeGreaterThan(0.04);
    expect(globalHeld / 10_000).toBeLessThan(0.06);
    expect(overlayHeld / 10_000).toBeGreaterThan(0.04);
    expect(patchHeld / 10_000).toBeGreaterThan(0.04);
    expect(recsHeld / 10_000).toBeGreaterThan(0.04);

    // 0.95^4 = 0.81450625
    expect(allExposed / 10_000).toBeGreaterThan(0.8);
    expect(allExposed / 10_000).toBeLessThan(0.83);

    // Independent re-draw across 26-week epoch: flip probability = 2*0.05*0.95 = 0.095
    expect(rotatedGlobalFlips / 10_000).toBeGreaterThan(0.08);
    expect(rotatedGlobalFlips / 10_000).toBeLessThan(0.11);
  });

  test('actor-blind runtime guard rejects UA, IP, actor_class, is_agent, is_bot, and automation_flags', () => {
    const cfg = makeBaseConfig();
    const forbiddenFields = [
      { user_agent: 'Googlebot/2.1' },
      { ip: '66.249.66.1' },
      { actor_class: 'search_crawler' },
      { is_agent: true },
      { is_bot: true },
      { automation_flags: ['webdriver'] },
    ];

    for (const poisoned of forbiddenFields) {
      const badInput = { ...makeBaseInput(1), ...poisoned } as unknown as AllocationInput;
      expect(() => assertActorBlindInput(badInput)).toThrow(ActorBlindViolationError);
      expect(() => allocateDecision(badInput, cfg)).toThrow(ActorBlindViolationError);
    }
  });

  test('respects consent tiers (T0 off = zero rows, T1 cookieless = page_view only), stateless policy & over-quota sampling', () => {
    const cfg = makeBaseConfig();

    // T0 `off` -> zero decision rows, delivery forbidden
    const offOut = allocateDecision(makeBaseInput(1, { consent_mode: 'off', purposes: [] }), cfg);
    expect(offOut.consent_tier).toBe('T0');
    expect(offOut.decisions).toHaveLength(0);
    expect(offOut.delivery_permitted).toBe(false);
    expect(offOut.measurement_arm).toBe('off');

    // T1 `cookieless`: overlay allows fallback -> uses page_view; patch copy test forbids fallback -> suppressed
    const cookielessOut = allocateDecision(
      makeBaseInput(2, {
        consent_mode: 'cookieless',
        identity_quality: 'C',
        purposes: ['experiment'],
      }),
      cfg
    );
    expect(cookielessOut.consent_tier).toBe('T1');
    const modalDec = cookielessOut.decisions.find((d) => d.layer_id === 'overlay:modal');
    const ctaDec = cookielessOut.decisions.find((d) => d.layer_id === 'patch:sec_cta');
    expect(modalDec?.unit_kind).toBe('page_view');
    expect(ctaDec?.eligible).toBe(false);
    expect(ctaDec?.suppressed_reason).toBe('suppressed_consent_unit');

    // `stateless_policy: 'default_only'` with `identity_quality: 'C'` in stats_exempt -> suppressed
    const statelessOut = allocateDecision(
      makeBaseInput(3, { identity_quality: 'C', consent_mode: 'stats_exempt' }),
      cfg
    );
    const statelessCta = statelessOut.decisions.find((d) => d.layer_id === 'patch:sec_cta');
    expect(statelessCta?.eligible).toBe(false);
    expect(statelessCta?.suppressed_reason).toBe('suppressed_stateless_default_only');

    // Over-quota sampling rate = 0.0 -> all units move to over_quota_stub before assignment
    const quotaOut = allocateDecision(makeBaseInput(4, { over_quota_sampling_rate: 0 }), cfg);
    expect(quotaOut.over_quota_sampled_out).toBe(true);
    expect(quotaOut.measurement_arm).toBe('over_quota_stub');
    expect(quotaOut.decisions).toHaveLength(0);
  });

  test('measurement comparison layers allocate Stage A, Stage B (both split modes), and Stage C accurately', () => {
    // Stage A dual run: v2 / v3 / both ~ 1/3 each, delivery_permitted = false
    // Use n=10000 so |p_hat - w| + z999*SE sits reliably inside EV G-1 ε_tol (0.025)
    const stageACfg = makeBaseConfig({
      measurement: { stage: 'stage_a_dual_run', fullSplitMode: 'all_verify_only' },
    });
    const aCounts: Record<string, number> = { v2: 0, v3: 0, both: 0 };
    for (let i = 0; i < 10_000; i++) {
      const out = allocateDecision(makeBaseInput(i), stageACfg);
      expect(out.delivery_permitted).toBe(false);
      aCounts[out.measurement_arm] = (aCounts[out.measurement_arm] ?? 0) + 1;
    }
    expect(evaluateSrmIntegrity(aCounts, { v2: 1, v3: 1, both: 1 }).status).toBe('pass');

    // Stage B weight test with `all_verify_only`: 1/3 stub, 1/3 lite, 1/3 full_verify_only (0 delivery)
    const stageBFastCfg = makeBaseConfig({
      measurement: { stage: 'stage_b_weight_test', fullSplitMode: 'all_verify_only' },
    });
    const bFastCounts: Record<string, number> = { stub: 0, lite: 0, full_verify_only: 0 };
    for (let i = 0; i < 10_000; i++) {
      const out = allocateDecision(makeBaseInput(i), stageBFastCfg);
      expect(out.delivery_permitted).toBe(false);
      bFastCounts[out.measurement_arm] = (bFastCounts[out.measurement_arm] ?? 0) + 1;
    }
    expect(evaluateSrmIntegrity(bFastCounts, { stub: 1, lite: 1, full_verify_only: 1 }).status).toBe(
      'pass'
    );

    // Stage B weight test with `half_verify_half_deliver` (判断 2 推奨): 1/3 stub, 1/3 lite, 1/6 verify, 1/6 deliver
    const stageBCfg = makeBaseConfig({
      measurement: { stage: 'stage_b_weight_test', fullSplitMode: 'half_verify_half_deliver' },
    });
    const bCounts: Record<string, number> = {
      stub: 0,
      lite: 0,
      full_verify_only: 0,
      full_deliver_eligible: 0,
    };
    for (let i = 0; i < 10_000; i++) {
      const out = allocateDecision(makeBaseInput(i), stageBCfg);
      bCounts[out.measurement_arm] = (bCounts[out.measurement_arm] ?? 0) + 1;
      if (out.measurement_arm === 'full_deliver_eligible') {
        expect(out.delivery_permitted).toBe(true);
      } else {
        expect(out.delivery_permitted).toBe(false);
      }
    }
    expect(
      evaluateSrmIntegrity(bCounts, {
        stub: 2,
        lite: 2,
        full_verify_only: 1,
        full_deliver_eligible: 1,
      }).status
    ).toBe('pass');

    // Stage C steady state: 5% stub (no delivery), 13% audit (delivery ok), 82% full_deliver_eligible
    const stageCCfg = makeBaseConfig({
      measurement: {
        stage: 'stage_c_steady',
        fullSplitMode: 'half_verify_half_deliver',
        steadyStubShare: 0.05,
        steadyAuditShare: 0.13,
      },
    });
    const cCounts: Record<string, number> = { stub: 0, audit: 0, full_deliver_eligible: 0 };
    for (let i = 0; i < 10_000; i++) {
      const out = allocateDecision(makeBaseInput(i), stageCCfg);
      cCounts[out.measurement_arm] = (cCounts[out.measurement_arm] ?? 0) + 1;
      expect(out.delivery_permitted).toBe(out.measurement_arm !== 'stub');
    }
    expect(
      evaluateSrmIntegrity(cCounts, { stub: 5, audit: 13, full_deliver_eligible: 82 }).status
    ).toBe('pass');
  });

  test('Single Unified Planning Sheet matches EV G-0 benchmarks, prints dual schedules, and handles Stage B split', () => {
    expect(PLANNER_CONSTANTS.inflationF).toBeCloseTo(1.068, 4);
    expect(PLANNER_CONSTANTS.minExperimentDays).toBe(14);

    // EV G-0 benchmark: baseline 2%, MDE +20%, two-sided confirm -> 21,109 per arm
    const nPerArm = computeTwoProportionNPerArm(0.02, 0.2, 'confirm');
    expect(nPerArm).toBe(21109);

    // 1 site (780 eligible visitor units/day, q=0.90) -> ~64.2 raw days; 5 sites (3900/day) -> 14d minimum
    const oneSite = planExperiment({
      baseline_rate: 0.02,
      mde_relative: 0.2,
      arms: 2,
      mode: 'confirm',
      is_indexable_variant: true,
      eligible_units_per_day: 780,
      analysable_share_q: 0.9,
    });
    expect(oneSite.visitor_schedule.raw_days_required).toBeCloseTo(64.2, 0);
    expect(oneSite.visitor_schedule.feasible_within_horizon).toBe(false); // > 56d
    expect(oneSite.page_view_schedule.effective_units_per_day).toBeCloseTo(
      oneSite.visitor_schedule.effective_units_per_day * 1.4,
      1
    );
    expect(oneSite.page_view_schedule.feasible_within_horizon).toBe(true); // ~45.9d <= 56d

    const fiveSites = planExperiment({
      baseline_rate: 0.02,
      mde_relative: 0.2,
      arms: 2,
      mode: 'confirm',
      is_indexable_variant: true,
      eligible_units_per_day: 3900,
      analysable_share_q: 0.9,
      accrued_units: 20000,
    });
    expect(fiveSites.visitor_schedule.planned_days_whole_weeks).toBe(14);
    expect(fiveSites.visitor_schedule.feasible_within_horizon).toBe(true);
    expect(fiveSites.visitor_schedule.status_recommendation).toBe('ok');
    expect(fiveSites.visitor_schedule.days_remaining).toBeLessThan(14);
    expect(fiveSites.visitor_schedule.days_remaining).toBeGreaterThan(0);

    // EV G-0 infeasible test: +10% MDE on 1 site within 8 weeks -> insufficient_data + traffic_multiple + detectable MDE
    const infeasible = planExperiment({
      baseline_rate: 0.02,
      mde_relative: 0.1,
      arms: 2,
      mode: 'confirm',
      is_indexable_variant: true,
      eligible_units_per_day: 780,
      analysable_share_q: 0.9,
    });
    expect(infeasible.visitor_schedule.feasible_within_horizon).toBe(false);
    expect(infeasible.visitor_schedule.status_recommendation).toBe('insufficient_data');
    expect(infeasible.visitor_schedule.traffic_multiple_to_unlock).toBeGreaterThan(4);
    expect(infeasible.visitor_schedule.mde_at_horizon_relative).toBeGreaterThan(0.2);

    // Stage B SDK weight test (判断 2): 164k PVs/month = 5466.7/day, 40% INP share
    expect(getMeasurementStageUsableShare('stage_b_weight_test', 'all_verify_only')).toBe(0);
    expect(getMeasurementStageUsableShare('stage_b_weight_test', 'half_verify_half_deliver')).toBeCloseTo(
      1 / 6,
      5
    );

    const fastWeight = planSdkWeightTest({
      daily_pvs: 164_000 / 30,
      full_split_mode: 'all_verify_only',
    });
    const parallelWeight = planSdkWeightTest({
      daily_pvs: 164_000 / 30,
      full_split_mode: 'half_verify_half_deliver',
      accrued_inp_pvs_in_smallest_arm: 15_000,
    });
    expect(fastWeight.days_required).toBeGreaterThanOrEqual(40);
    expect(fastWeight.days_required).toBeLessThanOrEqual(43);
    expect(fastWeight.parallel_delivery_arm_share).toBe(0);

    expect(parallelWeight.days_required).toBeGreaterThanOrEqual(80);
    expect(parallelWeight.days_required).toBeLessThanOrEqual(85);
    expect(parallelWeight.parallel_delivery_arm_share).toBeCloseTo(1 / 6, 5);
    expect(parallelWeight.days_remaining).toBeLessThan(parallelWeight.days_required);
  });

  test('3-Tier Metric & Label Contract enforces containment (site_rule ⊂ label ⊂ metric) and D-18 invariants', () => {
    const siteRules: SiteConversionRule[] = [
      {
        site_id: 'site_1',
        cv_key: 'aff_main_cta',
        rule_ver: 1,
        predicate_kind: 'selector',
        predicate_value: 'a.cta-affiliate',
        activation_kinds: ['click', 'auxclick', 'keyboard', 'new_tab_inferred'],
        retro_evaluable_in_lab: true,
      },
    ];

    const validLabel: LabelContract = {
      label_key: 'aff_click',
      contract_version: 1,
      site_rule_refs: ['aff_main_cta@1'],
      value_grain: 'click_nonce',
      not_slot_metric: false,
      not_training_label: false,
      requires_click_reconciliation_gate: 'join.G13',
    };

    const validMetric = createLockedMetricDefinition(
      {
        metric_definition_id: 'aff_revenue_per_visitor',
        version: 1,
        level: 'ev.L3',
        label_ref: 'aff_click@1',
        unit_kind: 'visitor',
        window_days: 7,
        aggregation: 'sum_per_unit',
      },
      '2026-11-20T00:00:00.000Z'
    );

    expect(
      validateMetricContractHierarchy({
        siteRules,
        labelContract: validLabel,
        metricDefinition: validMetric,
      })
    ).toEqual({ valid: true, errors: [] });

    // > 50 site rules rejected
    const tooManyRules: SiteConversionRule[] = Array.from(
      { length: MAX_SITE_CONVERSION_RULES + 1 },
      (_, idx) => ({
        ...siteRules[0],
        cv_key: `rule_${idx}`,
      })
    );
    const capFail = validateMetricContractHierarchy({
      siteRules: tooManyRules,
      labelContract: { ...validLabel, site_rule_refs: ['rule_0@1'] },
      metricDefinition: validMetric,
    });
    expect(capFail.valid).toBe(false);
    expect(capFail.errors.some((e) => e.includes('exceeding maximum 50'))).toBe(true);

    // Dangling site rule ref violates containment
    const danglingFail = validateMetricContractHierarchy({
      siteRules,
      labelContract: { ...validLabel, site_rule_refs: ['missing_rule@9'] },
      metricDefinition: validMetric,
    });
    expect(danglingFail.valid).toBe(false);
    expect(danglingFail.errors.some((e) => e.includes('containment violation'))).toBe(true);

    // D-18: program_split without not_slot_metric=true & not_training_label=true rejected
    const programSplitFail = validateMetricContractHierarchy({
      siteRules,
      labelContract: {
        ...validLabel,
        value_grain: 'program_split',
        not_slot_metric: false,
        not_training_label: false,
      },
      metricDefinition: validMetric,
    });
    expect(programSplitFail.valid).toBe(false);
    expect(programSplitFail.errors.some((e) => e.includes('program_split'))).toBe(true);

    // ev.L3 without join.G13 rejected
    const l3NoGate = validateMetricContractHierarchy({
      siteRules,
      labelContract: { ...validLabel, requires_click_reconciliation_gate: null },
      metricDefinition: validMetric,
    });
    expect(l3NoGate.valid).toBe(false);
    expect(l3NoGate.errors.some((e) => e.includes('join.G13'))).toBe(true);

    // Tampered content_hash rejected
    const tamperedMetric = { ...validMetric, window_days: 14 };
    const hashFail = validateMetricContractHierarchy({
      siteRules,
      labelContract: validLabel,
      metricDefinition: tamperedMetric,
    });
    expect(hashFail.valid).toBe(false);
    expect(hashFail.errors.some((e) => e.includes('content_hash mismatch'))).toBe(true);
  });
});
