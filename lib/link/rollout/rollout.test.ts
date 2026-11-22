import { webcrypto } from 'node:crypto';
import { sha256Hex } from '../../../packages/contract/response';
import { WpPluginEngine } from '../../../packages/wp-plugin';
import {
  ProhibitedCausalClaimError,
  REQUIRED_CHANGED_FP_BY_OP,
  WpPluginOriginAdapter,
  WpRestOriginAdapter,
  assertLedgerNeverClaimsCausal,
  checkOriginOpEntitlement,
  computeRequiredPagePairs,
  defaultBatchedAdaptivePolicy,
  evaluateAutonomousPromotionRollbackBound,
  evaluateCatePersonalisation,
  evaluateGeneratorActivationGate,
  evaluatePageRolloutVerdict,
  evaluateProspectiveMetaAnalysis,
  evaluateReverseHoldbackBundle,
  normalizeProbsWithFloor,
  planStratifiedPageRollout,
  recordChangeEffectObservation,
  runGeneratorWithPreflightRepair,
  runLedgerPlaceboCalibration,
  schedulePromotionsWeekly,
  selectHighestCertaintySource,
  verifyAdaptiveAllocationPolicy,
  verifyRequiredFingerprintChanged,
  PostWinPromotionLifecycle,
  type AdaptiveArrivalObservation,
  type PageFingerprintSnapshot,
} from './index';

function makeFps(overrides: Partial<PageFingerprintSnapshot> = {}): PageFingerprintSnapshot {
  return {
    body_fp: 'body_v1',
    skel_fp: 'skel_v1',
    links_fp: 'links_v1',
    el_fp: 'el_v1',
    head_fp: 'head_v1',
    css_fp: 'css_v1',
    ...overrides,
  };
}

describe('lib/link/rollout/change-effect-ledger (§9.7, §9.9)', () => {
  test('ranks timestamp sources, enforces no_baseline, compares DiD vs weighted control, and strictly caps evidence at observed', () => {
    expect(
      selectHighestCertaintySource(['crawl_issue_event', 'real_visit_fp_change', 'applied_or_wp_revision'])
    ).toBe('applied_or_wp_revision');

    // Missing pre-record => no_baseline
    const noBase = recordChangeEffectObservation({
      changeId: 'chg_nobase',
      tenantId: 'ten_1',
      siteId: 'site_1',
      pageId: 'page_1',
      sectionId: 'sec_hero',
      detectedAtMs: 1_000,
      windowStartMs: 0,
      windowEndMs: 2_000,
      sources: ['scheduled_lab_snapshot'],
      changeCauseDescription: 'Unknown edit',
      controlSelectionLockedAtMs: 500,
      treatedPreValues: [],
      treatedPostValues: [10, 11, 12],
      controls: [{ pageId: 'ctrl_1', preValues: [10, 10], postValues: [10, 10] }],
    });
    expect(noBase.status).toBe('no_baseline');
    expect(noBase.evidenceLevel).toBe('observed');

    // Clear positive change matching across DiD & weighted control => observed_difference (still `observed`!)
    const observed = recordChangeEffectObservation({
      changeId: 'chg_pos',
      tenantId: 'ten_1',
      siteId: 'site_1',
      pageId: 'page_1',
      sectionId: 'sec_cta',
      detectedAtMs: 2_000,
      windowStartMs: 1_000,
      windowEndMs: 3_000,
      sources: ['real_visit_fp_change', 'crawl_issue_event'],
      changeCauseDescription: 'CTA copy updated',
      controlSelectionLockedAtMs: 1_500,
      treatedPreValues: [100, 102, 98, 101, 99, 100, 101, 99],
      treatedPostValues: [140, 142, 139, 141, 143, 138, 140, 142],
      controls: [
        {
          pageId: 'ctrl_a',
          preValues: [100, 101, 99, 100, 100, 101, 99, 100],
          postValues: [101, 100, 99, 100, 101, 100, 99, 100],
        },
        {
          pageId: 'ctrl_b',
          preValues: [50, 51, 49, 50, 50, 51, 49, 50],
          postValues: [50, 50, 50, 51, 49, 50, 50, 50],
        },
      ],
    });
    expect(observed.status).toBe('observed_difference');
    expect(observed.evidenceLevel).toBe('observed');
    expect(observed.primarySource).toBe('real_visit_fp_change');

    // Disagreement between DiD (equal weights) and weighted synthetic control (pre-MSE weighted) => inconclusive
    const disagree = recordChangeEffectObservation({
      changeId: 'chg_disagree',
      tenantId: 'ten_1',
      siteId: 'site_1',
      pageId: 'page_2',
      sectionId: 'sec_cta',
      detectedAtMs: 2_000,
      windowStartMs: 1_000,
      windowEndMs: 3_000,
      sources: ['applied_or_wp_revision'],
      changeCauseDescription: 'Disagreeing controls',
      controlSelectionLockedAtMs: 1_000,
      treatedPreValues: [100, 100, 100, 100, 100, 100],
      treatedPostValues: [110, 110, 110, 110, 110, 110],
      controls: [
        // Exact pre-match => dominates synthetic control -> synth says 110 - 130 = -20 (negative)
        {
          pageId: 'ctrl_match',
          preValues: [100, 100, 100, 100, 100, 100],
          postValues: [130, 130, 130, 130, 130, 130],
        },
        // Poor pre-match => equal weight in DiD pulls DiD up to +25 (positive)
        {
          pageId: 'ctrl_far',
          preValues: [200, 200, 200, 200, 200, 200],
          postValues: [140, 140, 140, 140, 140, 140],
        },
      ],
    });
    expect(disagree.status).toBe('inconclusive');
    expect(disagree.estimatorsAgree).toBe(false);

    // Runtime prohibition against `proven`, `caused`, or `原因`
    expect(() =>
      assertLedgerNeverClaimsCausal({ evidenceLevel: 'proven' })
    ).toThrow(ProhibitedCausalClaimError);
    expect(() =>
      assertLedgerNeverClaimsCausal({
        evidenceLevel: 'observed',
        summaryText: 'この変更が原因でCVが上昇',
      })
    ).toThrow(ProhibitedCausalClaimError);

    // Placebo calibration on unchanged pages
    const placebo = runLedgerPlaceboCalibration([
      {
        placeboId: 'p1',
        treatedPreValues: [10, 11, 9, 10, 11, 9],
        treatedPostValues: [10, 10, 11, 9, 10, 10],
        controls: [{ pageId: 'c1', preValues: [10, 10, 10, 10, 10, 10], postValues: [10, 10, 10, 10, 10, 10] }],
      },
      {
        placeboId: 'p2',
        treatedPreValues: [20, 19, 21, 20, 19, 21],
        treatedPostValues: [20, 21, 19, 20, 20, 20],
        controls: [{ pageId: 'c2', preValues: [20, 20, 20, 20, 20, 20], postValues: [20, 20, 20, 20, 20, 20] }],
      },
    ]);
    expect(placebo.calibrated).toBe(true);
    expect(placebo.falsePositiveCount).toBe(0);
  });

  test('prospective meta-analysis reaches class×tenant proven on >=2 sites and gates new-site extrapolation on all 3 prior scales', () => {
    // Low heterogeneity across 5 consistent sites -> class×tenant proven AND new-site extrapolation allowed
    const consistent = evaluateProspectiveMetaAnalysis({
      metaId: 'meta_cta_01',
      tenantId: 'ten_own',
      interventionClass: 'cta_clarity_v1',
      evaluatedAtIso: '2026-11-20T00:00:00Z',
      sites: [1, 2, 3, 4, 5].map((i) => ({
        siteId: `site_${i}`,
        preregWeight: 1,
        effect: 0.14 + (i - 3) * 0.005,
        standardError: 0.025,
        units: 4000,
        durationDays: 21,
        allocatorLoggedBeforeOutcomes: true,
        preregLocked: true,
        integrityStatus: 'pass',
        platformCanaryPassed: true,
      })),
    });
    expect(consistent.registeredSitesAverageValid).toBe(true);
    expect(consistent.classTenantEvidenceLevel).toBe('proven');
    expect(consistent.provenPredicate?.predicate).toBe('multi_site');
    expect(consistent.newSitePredictionIntervals).toHaveLength(3);
    expect(consistent.canExtrapolateToNewSite).toBe(true);

    // High between-site heterogeneity across 5 sites -> average still proven, but new-site prediction crosses 0!
    const heterogeneous = evaluateProspectiveMetaAnalysis({
      metaId: 'meta_het_02',
      tenantId: 'ten_own',
      interventionClass: 'banner_copy_v1',
      evaluatedAtIso: '2026-11-20T00:00:00Z',
      sites: [-0.05, 0.35, 0.02, 0.42, 0.08].map((eff, i) => ({
        siteId: `site_${i + 1}`,
        preregWeight: 1,
        effect: eff,
        standardError: 0.02,
        units: 5000,
        durationDays: 21,
        allocatorLoggedBeforeOutcomes: true,
        preregLocked: true,
        integrityStatus: 'pass',
        platformCanaryPassed: true,
      })),
    });
    expect(heterogeneous.classTenantEvidenceLevel).toBe('proven');
    expect(heterogeneous.betweenSiteTauSquared).toBeGreaterThan(0.01);
    expect(heterogeneous.canExtrapolateToNewSite).toBe(false);
  });
});

describe('lib/link/rollout/origin-adapter (§10.8, §10.9, del.D20)', () => {
  test('locks json_ld/llms_txt/canonical/robots as not_entitled, verifies REQUIRED_CHANGED_FP_BY_OP, max-3 repair, and 28/30 activation', () => {
    expect(checkOriginOpEntitlement('json_ld').status).toBe('not_entitled');
    expect(checkOriginOpEntitlement('llms_txt').status).toBe('not_entitled');
    expect(checkOriginOpEntitlement('canonical').status).toBe('not_entitled');
    expect(checkOriginOpEntitlement('robots').status).toBe('not_entitled');
    expect(checkOriginOpEntitlement('title').status).toBe('ok');
    expect(() =>
      checkOriginOpEntitlement('body', { executionSurface: 'browser' })
    ).toThrow();

    // Operation-specific fingerprint map check
    expect(REQUIRED_CHANGED_FP_BY_OP.body).toBe('body_fp');
    expect(REQUIRED_CHANGED_FP_BY_OP.heading_hierarchy).toBe('skel_fp');
    expect(REQUIRED_CHANGED_FP_BY_OP.internal_link).toBe('links_fp');
    expect(REQUIRED_CHANGED_FP_BY_OP.alt).toBe('el_fp');
    expect(REQUIRED_CHANGED_FP_BY_OP.title).toBe('head_fp');
    expect(REQUIRED_CHANGED_FP_BY_OP.style).toBe('css_fp');

    // `alt` changed body_fp ONLY but left el_fp unchanged => REJECTED!
    const badAlt = verifyRequiredFingerprintChanged(
      'alt',
      makeFps(),
      makeFps({ body_fp: 'body_v2' })
    );
    expect(badAlt.ok).toBe(false);
    expect(badAlt.reason).toContain('el_fp');

    const goodAlt = verifyRequiredFingerprintChanged(
      'alt',
      makeFps(),
      makeFps({ el_fp: 'el_v2' })
    );
    expect(goodAlt.ok).toBe(true);

    // Auto-repair capped at max 3 attempts
    const repaired = runGeneratorWithPreflightRepair({
      entry: {
        generatorId: 'gen_alt_v1',
        version: '1.0.0',
        issueSource: 'crawl_a11y_rule',
        lane: 'origin_seo',
        opKind: 'alt',
        targetPlacementRule: 'img[alt=""]',
        verificationRule: 'el_fp_changed',
        browserExecutable: false,
      },
      pageType: 'article',
      generateInitial: () => ({ replacementHtml: '<img alt="">', summary: 'initial' }),
      repairDraft: (_prev, _issues, attempt) => ({
        replacementHtml: attempt >= 3 ? '<img alt="商品比較図">' : '<img alt="">',
        summary: `repair_${attempt}`,
      }),
      runPreflight: (d) => ({
        passed: d.replacementHtml.includes('商品比較図'),
        issues: d.replacementHtml.includes('商品比較図') ? [] : ['empty_alt'],
      }),
    });
    expect(repaired.passed).toBe(true);
    expect(repaired.repairAttemptsUsed).toBe(3);

    // 28/30 activation gate
    expect(
      evaluateGeneratorActivationGate(
        'gen_alt_v1',
        '1.0.0',
        Array.from({ length: 30 }, (_, i) => ({ pageId: `p${i}`, passed: i < 27 }))
      ).activated
    ).toBe(false);
    expect(
      evaluateGeneratorActivationGate(
        'gen_alt_v1',
        '1.0.0',
        Array.from({ length: 30 }, (_, i) => ({ pageId: `p${i}`, passed: i < 28 }))
      ).activated
    ).toBe(true);

    // Autonomous promotion n = 59 clean applies => <= 5% UB95
    expect(evaluateAutonomousPromotionRollbackBound(58, 0).eligibleForAutonomousPromotion).toBe(false);
    expect(evaluateAutonomousPromotionRollbackBound(59, 0).eligibleForAutonomousPromotion).toBe(true);
  });

  test('WpPluginOriginAdapter rejects unchanged required fp, returns 3-way merge + browser fallback on conflict, and WpRestOriginAdapter blocks script-capable unapproved apply', async () => {
    const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]);
    const engine = new WpPluginEngine({
      pinnedPubKeys: new Map([['kid_origin_1', kp.publicKey]]),
      ownerPolicy: {
        local_stop: false,
        allowed_auto_classes: ['copy_minor'],
        daily_apply_cap: 100,
        require_admin_confirmation_classes: ['price'],
      },
    });

    const initialHtml = '<p>Original copy</p><a href="/old">Old</a>';
    engine.seedPost({
      post_id: 42,
      permalink: 'https://example.jp/p/42',
      content: initialHtml,
      modified_gmt: '2026-11-20T00:00:00Z',
      edit_lock_user_id: null,
    });

    const adapter = new WpPluginOriginAdapter(engine, kp.privateKey, 'kid_origin_1');

    // Reject promotion if required fp for `internal_link` (`links_fp`) did NOT change
    const rejectedNoFpChange = await adapter.applyWithVersionCheck({
      promotionId: 'promo_bad_fp',
      postId: 42,
      opKind: 'internal_link',
      changeClass: 'copy_minor',
      expectedContentSha256: sha256Hex(initialHtml),
      expectedModifiedGmt: '2026-11-20T00:00:00Z',
      byteStart: 0,
      byteEnd: 20,
      replacementHtml: '<p>Updated copy</p>',
      beforeFingerprints: makeFps(),
      computeAfterFingerprints: () => makeFps({ body_fp: 'body_v2' }), // links_fp unchanged!
    });
    expect(rejectedNoFpChange.ok).toBe(false);
    expect(rejectedNoFpChange.status).toBe(422);
    expect(rejectedNoFpChange.error).toContain('links_fp');

    // Valid apply changing links_fp
    const applied = await adapter.applyWithVersionCheck({
      promotionId: 'promo_good_link',
      postId: 42,
      opKind: 'internal_link',
      changeClass: 'copy_minor',
      expectedContentSha256: sha256Hex(initialHtml),
      expectedModifiedGmt: '2026-11-20T00:00:00Z',
      byteStart: 20,
      byteEnd: initialHtml.length,
      replacementHtml: '<a href="/new">New</a>',
      beforeFingerprints: makeFps(),
      computeAfterFingerprints: () => makeFps({ links_fp: 'links_v2' }),
    });
    expect(applied.ok).toBe(true);

    // Human edits post afterwards -> revert returns 409 + 3-way merge + browser inverse patch fallback
    await engine.humanEditPost(
      42,
      '<p>Human revised copy</p><a href="/new">New</a>',
      '2026-11-20T01:00:00Z'
    );
    const conflictRevert = await adapter.revert({
      postId: 42,
      promotionId: 'promo_good_link',
    });
    expect(conflictRevert.ok).toBe(false);
    expect(conflictRevert.status).toBe(409);
    expect(conflictRevert.threeWayMergeProposal?.preImage).toBe(initialHtml);
    expect(conflictRevert.browserInverseFallback?.restorePreImageHtml).toBe(initialHtml);

    // Script-capable WP REST adapter MUST reject unapproved apply
    const rest = new WpRestOriginAdapter({ scriptCapableCredential: true });
    rest.seedPost(7, initialHtml, '2026-11-20T00:00:00Z');
    const unapprovedRest = await rest.applyWithVersionCheck({
      promotionId: 'promo_rest_1',
      postId: 7,
      opKind: 'body',
      changeClass: 'copy_minor',
      expectedContentSha256: sha256Hex(initialHtml),
      expectedModifiedGmt: '2026-11-20T00:00:00Z',
      byteStart: 0,
      byteEnd: 20,
      replacementHtml: '<p>Changed</p>',
      beforeFingerprints: makeFps(),
      computeAfterFingerprints: () => makeFps({ body_fp: 'body_v2' }),
    });
    expect(unapprovedRest.ok).toBe(false);
    expect(unapprovedRest.status).toBe(403);
    expect(unapprovedRest.error).toBe('script_capable_rest_requires_human_approval');
  });
});

describe('lib/link/rollout/page-rollout & adaptive-allocation (§9.6, §9.8, §9.9, §8.3)', () => {
  test('plans >=3-wave stratified page rollout, verifies post-win lifecycle + reverse holdback + weekly batching', () => {
    expect(computeRequiredPagePairs({ outcomesPerPagePerPeriod: 100 }).requiredPairs).toBe(10);
    expect(computeRequiredPagePairs({ outcomesPerPagePerPeriod: 25 }).requiredPairs).toBe(38);
    expect(computeRequiredPagePairs({ outcomesPerPagePerPeriod: 6 }).requiredPairs).toBe(159);
    expect(computeRequiredPagePairs({ outcomesPerPagePerPeriod: 500 }).requiredPairs).toBe(6);

    const pages = Array.from({ length: 18 }, (_, i) => ({
      pageId: `pg_${i}`,
      template: i % 2 === 0 ? 'article' : 'comparison',
      trafficBand: (i % 3 === 0 ? 'high' : 'mid') as 'high' | 'mid',
      preTrendBand: 'flat' as const,
    }));
    const plan = planStratifiedPageRollout({
      rolloutId: 'roll_seo_1',
      secret: 'secret_seed',
      pages,
      numWaves: 3,
    });
    expect(plan.waveCounts[1]).toBe(6);
    expect(plan.waveCounts[2]).toBe(6);
    expect(plan.waveCounts[3]).toBe(6);

    const verdict = evaluatePageRolloutVerdict({
      numWaves: 3,
      observedPairs: 12,
      requiredPairs: 10,
      allocatorLoggedBeforeOutcomes: true,
      preregLocked: true,
      integrityStatus: 'pass',
      platformCanaryPassed: true,
      durationDays: 28,
      randomizationPValue: 0.012,
      evaluatedAtIso: '2026-11-20T00:00:00Z',
    });
    expect(verdict.evidenceLevel).toBe('proven');
    expect(verdict.searchRankClaimPermitted).toBe(true);
    expect(verdict.predicate?.predicate).toBe('page_randomised');

    // Post-win lifecycle requires both CRAWL & RUM fp verification before retiring browser patch
    const lc = new PostWinPromotionLifecycle({
      promotionId: 'promo_win_1',
      opKind: 'heading_hierarchy',
      guardrailsVerifiedOrNamedApprover: true,
    });
    lc.startBrowserBridge('2026-11-01T00:00:00Z');
    lc.markOriginBaked('2026-11-10T00:00:00Z');
    const fpVerify = lc.verifyCrawlAndRumFingerprints({
      beforeFps: makeFps(),
      crawlAfterFps: makeFps({ skel_fp: 'skel_v2' }),
      rumAfterFps: makeFps({ skel_fp: 'skel_v2' }),
    });
    expect(fpVerify.ok).toBe(true);
    expect(lc.retireBrowserPatch('2026-11-11T00:00:00Z').stage).toBe('browser_retired');

    // Reverse holdback bundle (10 promotions, <= 56 days)
    const holdback = evaluateReverseHoldbackBundle(
      'hb_bundle_1',
      Array.from({ length: 10 }, (_, i) => ({
        promotionId: `p_${i}`,
        initialLift: 0.12,
        holdbackLift: 0.1,
        holdbackSe: 0.05,
        holdbackDurationDays: 42,
      }))
    );
    expect(holdback.durationWithin56Days).toBe(true);
    expect(holdback.durabilityVerdict).toBe('sustained');
    expect(holdback.underbundledWarning).toBe(false);

    // Weekly batching: harm removal immediate, overlapping confirmatory test deferred, normal batched
    const sched = schedulePromotionsWeekly({
      nowIso: '2026-11-20T09:00:00Z',
      nextWeeklyWindowIso: '2026-11-24T03:00:00Z',
      candidates: [
        { promotionId: 'harm_fix', pageIds: ['p1'], isHarmRemoval: true, overlappingConfirmatoryExperimentIds: ['exp_1'] },
        { promotionId: 'conflict_fix', pageIds: ['p2'], isHarmRemoval: false, overlappingConfirmatoryExperimentIds: ['exp_2'] },
        { promotionId: 'routine_fix', pageIds: ['p3'], isHarmRemoval: false, overlappingConfirmatoryExperimentIds: [] },
      ],
    });
    expect(sched[0].action).toBe('execute_immediately');
    expect(sched[1].action).toBe('defer_for_running_experiment');
    expect(sched[2].action).toBe('batch_to_weekly_window');
  });

  test('executes 10,000-replay adaptive allocation verification, demotes unlogged policies to observed, and enforces D-17 on external CATE', () => {
    // Build realistic 2-arm 4-batch arrival sequence with strong true lift on arm 1 (0.45 vs 0.10)
    const arrivals: AdaptiveArrivalObservation[] = [];
    for (let i = 0; i < 160; i++) {
      const batchIndex = Math.floor(i / 40);
      const inUniformSlice = i % 10 === 0; // 10% uniform slice
      const armIndex = i % 2 === 0 ? 1 : 0;
      const outcome =
        armIndex === 1 ? (i % 4 === 0 ? 0 : 1) : i % 8 === 0 ? 1 : 0;
      arrivals.push({
        arrivalIndex: i,
        batchIndex,
        armIndex,
        propensity: 0.5,
        outcome,
        inUniformSlice,
      });
    }

    const verified = verifyAdaptiveAllocationPolicy({
      experimentId: 'exp_bandit_10k',
      numArms: 2,
      targetArmIndex: 1,
      arrivals,
      loggedPolicy: defaultBatchedAdaptivePolicy,
      preregLocked: true,
      allocatorLoggedBeforeOutcomes: true,
      integrityStatus: 'pass',
      platformCanaryPassed: true,
      durationDays: 21,
      replayCount: 10_000,
      evaluatedAtIso: '2026-11-20T00:00:00Z',
    });
    expect(verified.replayCountExecuted).toBe(10_000);
    expect(verified.verifiable).toBe(true);
    expect(verified.evidenceLevel).toBe('proven');
    expect(verified.predicate?.predicate).toBe('bandit_replay');
    expect(verified.randomizationPValue).not.toBeNull();
    expect(verified.randomizationPValue!).toBeLessThan(0.05);

    // Unlogged / unverifiable policy => strictly demoted to `observed` delivery tool
    const demoted = verifyAdaptiveAllocationPolicy({
      experimentId: 'exp_bandit_unlogged',
      numArms: 2,
      targetArmIndex: 1,
      arrivals,
      loggedPolicy: null,
      preregLocked: true,
      allocatorLoggedBeforeOutcomes: true,
      integrityStatus: 'pass',
      platformCanaryPassed: true,
      durationDays: 21,
      evaluatedAtIso: '2026-11-20T00:00:00Z',
    });
    expect(demoted.verifiable).toBe(false);
    expect(demoted.evidenceLevel).toBe('observed');
    expect(demoted.role).toBe('observed_delivery_tool');
    expect(demoted.predicate).toBeNull();

    // CATE personalisation: internal serves when lower bound > cost; external locked until D-17
    const internalServe = evaluateCatePersonalisation({
      tenantId: 'ten_internal',
      isExternalTenant: false,
      candidateTreatmentId: 'trt_personal_a',
      catePointEstimate: 0.08,
      cateLowerBound: 0.03,
      displayCost: 0.01,
      withinGuardrails: true,
    });
    expect(internalServe.status).toBe('ok');
    expect(internalServe.decision).toBe('serve_personalized');

    const externalLocked = evaluateCatePersonalisation({
      tenantId: 'ten_external',
      isExternalTenant: true,
      candidateTreatmentId: 'trt_personal_a',
      catePointEstimate: 0.08,
      cateLowerBound: 0.03,
      displayCost: 0.01,
      withinGuardrails: true,
    });
    expect(externalLocked.status).toBe('not_entitled');
    expect(externalLocked.decision).toBe('fallback_default');
  });

  test('[H-07] normalizeProbsWithFloor is strictly idempotent via simplex water-filling so 10,000 replay draws match exact logged propensities without shrinkage', () => {
    // 1. Strict idempotency on 2-arm and multi-arm inputs
    const p2Once = normalizeProbsWithFloor([1, 9], 2, 0.25);
    expect(p2Once[0]).toBeCloseTo(0.25, 12);
    expect(p2Once[1]).toBeCloseTo(0.75, 12);
    const p2Twice = normalizeProbsWithFloor(p2Once, 2, 0.25);
    expect(Math.abs(p2Twice[0] - p2Once[0])).toBeLessThan(1e-15);
    expect(Math.abs(p2Twice[1] - p2Once[1])).toBeLessThan(1e-15);

    // Already-valid interior propensity [0.30, 0.70] with floor 0.25 MUST NOT shrink to [0.40, 0.60]!
    const interior = normalizeProbsWithFloor([0.3, 0.7], 2, 0.25);
    expect(interior[0]).toBeCloseTo(0.3, 12);
    expect(interior[1]).toBeCloseTo(0.7, 12);

    // 3-arm active-set water-filling: [0.05, 0.35, 0.60] with floor 0.20 -> [0.20, 0.2947368..., 0.5052631...]
    const p3Once = normalizeProbsWithFloor([0.05, 0.35, 0.6], 3, 0.2);
    const p3Twice = normalizeProbsWithFloor(p3Once, 3, 0.2);
    for (let k = 0; k < 3; k += 1) {
      expect(p3Once[k]).toBeGreaterThanOrEqual(0.2 - 1e-15);
      expect(Math.abs(p3Twice[k] - p3Once[k])).toBeLessThan(1e-15);
    }

    // 2. Policy returning already-floored [0.30, 0.70] retains exact propensity inside 10,000-replay verifier
    const policyCalls: number[][] = [];
    const fixedLoggedPolicy = () => {
      const p = normalizeProbsWithFloor([0.3, 0.7], 2, 0.25);
      policyCalls.push(p);
      return p;
    };
    const arrivals: AdaptiveArrivalObservation[] = Array.from({ length: 40 }, (_, i) => ({
      arrivalIndex: i,
      batchIndex: 0,
      armIndex: i % 10 < 7 ? 1 : 0,
      propensity: i % 10 < 7 ? 0.7 : 0.3,
      outcome: i % 3 === 0 ? 1 : 0,
      inUniformSlice: i % 10 === 0,
    }));
    const res = verifyAdaptiveAllocationPolicy({
      experimentId: 'exp_h07_idempotent',
      numArms: 2,
      targetArmIndex: 1,
      arrivals,
      loggedPolicy: fixedLoggedPolicy,
      preregLocked: true,
      allocatorLoggedBeforeOutcomes: true,
      integrityStatus: 'pass',
      platformCanaryPassed: true,
      durationDays: 14,
      replayCount: 10_000,
      evaluatedAtIso: '2026-11-20T00:00:00Z',
    });
    expect(res.replayCountExecuted).toBe(10_000);
    expect(policyCalls.length).toBe(10_000);
    expect(normalizeProbsWithFloor(policyCalls[0], 2, 0.25)[1]).toBeCloseTo(0.7, 12);
  });
});
