import { generateEd25519KeyPair } from '@/lib/link/auth';
import {
  KillSwitchController,
  ServerFeatureFlagEvaluator,
  TriggerCompileError,
  auditServerFlagDecisionBatch,
  checkFlagExperimentCollision,
  classifyFeatureFlagChangeRisk,
  compileTriggerAst,
  convertLegacySanitizedHtmlToA1c,
  drawStatelessUrlDayArm,
  evaluateBrowserFeatureFlag,
  evaluateCompiledTrigger,
  evaluateDecisionCompleteness,
  evaluateFirstExposureRollout,
  evaluateSdkWeightEquivalence,
  evaluateSealedTrigger,
  resolveDeliveryConsentGate,
  resolveDeliveryConsentMode,
  runKillSwitch300Drills,
  runLiveWriteGuardAndProbe,
  runPreflightDefectBenchmark,
  runStratifiedPreflight,
  signServerFlagObject,
  validateExpressionSpec,
  validateKillPolicyConfig,
  validateSection106Invariants,
  type DurableKillStore,
  type RegisteredFeatureFlag,
  type TriggerExposureEvent,
} from './index';

describe('lib/link/delivery — Wave 5-A & 5-B: Shadow/Weight, Trigger Lang, Expressions A0–A3, Kill K1–K4, Preflight & Feature Flags', () => {
  test('5-A: A0 sealed triggering logs identical arm-blind exposure with 0 DOM writes, ev.G-3 completeness, and tel.G16 TOST equivalence', () => {
    const queueA: TriggerExposureEvent[] = [];
    const queueB: TriggerExposureEvent[] = [];
    const baseDecision = {
      decision_id: 'dec_001',
      experiment_id: 'exp_1',
      pv_id: 'pv_1',
      unit_id: 'u_1',
      holdout_bits: 0,
    };

    const resControl = evaluateSealedTrigger({
      decision: { ...baseDecision, arm_id: 'control' },
      expressionTier: 'A0',
      evaluateTriggerArmBlind: () => true,
      exposureQueue: queueA,
      nowMs: 1000,
    });
    const resTreat = evaluateSealedTrigger({
      decision: { ...baseDecision, arm_id: 'variant_b' },
      expressionTier: 'A0',
      evaluateTriggerArmBlind: () => true,
      exposureQueue: queueB,
      nowMs: 1000,
    });

    // Identical trigger log before arm inspection & 0 DOM writes in A0 shadow
    expect(resControl.domWrites).toBe(0);
    expect(resTreat.domWrites).toBe(0);
    expect(resControl.renderMode).toBe('a0_shadow_no_write');
    expect(resTreat.renderMode).toBe('a0_shadow_no_write');
    expect(queueA[0]).toEqual(queueB[0]);

    // ev.G-3 decision completeness gate
    const compPass = evaluateDecisionCompleteness({
      totalDecisionsLogged: 10000,
      matchedExposures: 9850,
      recomputeCheckedRows: 10000,
      recomputeExactMatches: 9980,
      observedAllocationBias: 0.001,
      targetAbsoluteMde: 0.01, // 1/4 = 0.0025 -> 0.001 <= 0.0025
    });
    expect(compPass.passed).toBe(true);

    // tel.G16 SDK weight TOST equivalence: < 30,000 PVs -> insufficient_data with remaining count
    const shortWeight = evaluateSdkWeightEquivalence({
      stubArm: { arm: 'stub', inpBearingPvs: 12000, inpBadShare: 0.08, lcpP75Ms: 2100, lcpP75SeMs: 10, clsP95: 0.005, bounceRate: 0.42, outboundClickRate: 0.02 },
      fullArm: { arm: 'full', inpBearingPvs: 12000, inpBadShare: 0.081, lcpP75Ms: 2108, lcpP75SeMs: 10, clsP95: 0.006, bounceRate: 0.421, outboundClickRate: 0.02 },
      budgets: { snippetBytes: 1500, deliveryCoreGzipBytes: 9000, mainThreadP95Ms: 25, clsDeltaP95: 0.004 },
    });
    expect(shortWeight.status).toBe('insufficient_data');
    expect(shortWeight.remainingInpPvsNeeded).toBe(18000);

    // >= 30,000 INP PVs/arm inside TOST bounds + budgets -> passed
    const passWeight = evaluateSdkWeightEquivalence({
      stubArm: { arm: 'stub', inpBearingPvs: 30000, inpBadShare: 0.08, lcpP75Ms: 2100, lcpP75SeMs: 8, clsP95: 0.005, bounceRate: 0.42, outboundClickRate: 0.02 },
      fullArm: { arm: 'full', inpBearingPvs: 30000, inpBadShare: 0.081, lcpP75Ms: 2105, lcpP75SeMs: 8, clsP95: 0.006, bounceRate: 0.421, outboundClickRate: 0.02 },
      budgets: { snippetBytes: 1800, deliveryCoreGzipBytes: 10240, mainThreadP95Ms: 32, clsDeltaP95: 0.004 },
    });
    expect(passWeight.status).toBe('ok');
    expect(passWeight.passed).toBe(true);
  });

  test('5-B Trigger language: identical across SDK/edge/replay, rejects UA/IP/actor at compile time, preserves 3-valued unknown', () => {
    // Rejects UA / IP / actor_class at compile time
    expect(() =>
      compileTriggerAst({ type: 'signal', signal: 'user_agent', op: 'eq', value: 'Googlebot' })
    ).toThrow(TriggerCompileError);
    expect(() =>
      compileTriggerAst({ type: 'signal', signal: 'actor_class', op: 'eq', value: 'human' })
    ).toThrow(TriggerCompileError);

    const prog = compileTriggerAst({
      type: 'and',
      children: [
        { type: 'signal', signal: 'section_reach', op: 'gte', value: 0.5 },
        { type: 'signal', signal: 'focal_dwell_ms', op: 'gte', value: 10000 },
      ],
    });

    const signals = { section_reach: 0.7, focal_dwell_ms: 12000 };
    expect(evaluateCompiledTrigger(prog, signals, 'sdk')).toBe(true);
    expect(evaluateCompiledTrigger(prog, signals, 'edge')).toBe(true);
    expect(evaluateCompiledTrigger(prog, signals, 'replay')).toBe(true);

    // `unknown` is NOT conflated with `false`
    expect(evaluateCompiledTrigger(prog, { section_reach: 0.7, focal_dwell_ms: undefined }, 'sdk')).toBe(
      'unknown'
    );
  });

  test('5-B Expressions A1/A1c/A2/A3, legal notice runtime ban, affiliate byte immutability, and §10.6 non-overridable invariants', () => {
    // Legacy sanitized HTML converts 1:1 to declarative A1c
    const a1c = convertLegacySanitizedHtmlToA1c('<h2>Special Guide</h2><a href="https://example.jp/go">Read</a>');
    expect(a1c.tier).toBe('A1c');
    expect(a1c.shadowDomMode).toBe('closed');
    expect(a1c.root.children?.length).toBe(2);

    // Legal mandatory notice in runtime is REJECTED (§10.1)
    const legalReject = validateExpressionSpec(a1c, {
      semanticCategory: 'legal_advertising_disclosure',
      protectedMatchKeys: [],
    });
    expect(legalReject.valid).toBe(false);

    // A2 protected region & affiliate byte hash mismatch rejected
    const badA2 = validateExpressionSpec(
      {
        tier: 'A2',
        operations: [
          {
            opId: 'op1',
            kind: 'clone_affiliate_unit',
            targetMatchKey: 'sec_aff_1',
            payload: {},
            inverseOp: { kind: 'remove', restoreKey: 'sec_aff_1' },
            affiliateRegistryUnitId: 'aff_unit_1',
            affiliateByteSha256: 'WRONG_HASH',
          },
        ],
      },
      {
        semanticCategory: 'cro_layout',
        protectedMatchKeys: ['sec_protected'],
        registeredAffiliateUnits: { aff_unit_1: { byteSha256: 'EXACT_SHA_123' } },
      }
    );
    expect(badA2.valid).toBe(false);

    // A3 forbidden on password/payment page
    const badA3 = validateExpressionSpec(
      {
        tier: 'A3',
        isolatedOrigin: 'https://sandbox.ugokilink.invalid',
        bundleHash: 'sha256_abc',
        humanApprovalId: 'apr_1',
        hostOwnedCloseButton: true,
        hostOwnedNavigation: true,
        monitorHistoryLength: true,
        disclosableDataKeys: ['page_category'],
      },
      {
        semanticCategory: 'cro_layout',
        protectedMatchKeys: [],
        pageHasPasswordOrPaymentField: true,
      }
    );
    expect(badA3.valid).toBe(false);

    // §10.6 invariants: major indexable on visitor lane -> rejected; auto modal on search landing -> rejected; bottom bar <=15vh -> allowed!
    expect(
      validateSection106Invariants({
        indexabilityImpact: 'indexable_major',
        isMajorOrganicLandingPage: true,
        lane: 'visitor_randomised',
        plannedDurationDays: 28,
        existingIndexableSourcesOnUrl: 0,
        isSystemAutoOverlay: false,
        isIndexableUrl: true,
      }).allowed
    ).toBe(false);

    expect(
      validateSection106Invariants({
        indexabilityImpact: 'non_indexable',
        isMajorOrganicLandingPage: false,
        lane: 'visitor_randomised',
        plannedDurationDays: 28,
        existingIndexableSourcesOnUrl: 0,
        isSystemAutoOverlay: true,
        isIndexableUrl: true,
        overlayKind: 'modal',
        landingSignals: { fromSearchEngine: true, hasPositiveNonSearchEvidence: false },
      }).allowed
    ).toBe(false);

    expect(
      validateSection106Invariants({
        indexabilityImpact: 'non_indexable',
        isMajorOrganicLandingPage: false,
        lane: 'visitor_randomised',
        plannedDurationDays: 28,
        existingIndexableSourcesOnUrl: 0,
        isSystemAutoOverlay: true,
        isIndexableUrl: true,
        overlayKind: 'bottom_bar',
        bottomBarViewportHeightPct: 12,
        landingSignals: { fromSearchEngine: true, hasPositiveNonSearchEvidence: false },
      }).allowed
    ).toBe(true);

    // Stateless URL × day deterministic draw
    const d1 = drawStatelessUrlDayArm({
      secret: 'sec_1',
      experimentId: 'exp_seo',
      urlId: 'url_42',
      utcDayIso: '2026-11-20',
      statelessPolicy: 'randomise',
      arms: [{ armId: 'control', weight: 50 }, { armId: 'b', weight: 50 }],
    });
    const d2 = drawStatelessUrlDayArm({
      secret: 'sec_1',
      experimentId: 'exp_seo',
      urlId: 'url_42',
      utcDayIso: '2026-11-20',
      statelessPolicy: 'randomise',
      arms: [{ armId: 'control', weight: 50 }, { armId: 'b', weight: 50 }],
    });
    expect(d1).toEqual(d2);
  });

  test('5-B Kill switch K1–K4: legal recheck enforcement, strong commit 200/503, 5s unreachable fail-closed, auto-breaker, and 300-run drill del.D3 with 0 violations', () => {
    expect(
      validateKillPolicyConfig({ path: 'K2', legalRiskKind: 'price', consentMode: 'full', recheckIntervalSec: null })
        .valid
    ).toBe(false);
    expect(
      validateKillPolicyConfig({ path: 'K2p', legalRiskKind: 'standard', consentMode: 'cookieless' }).valid
    ).toBe(false);

    let killed = false;
    let reachable = true;
    let commitWorks = true;
    let version = 1;
    const store: DurableKillStore = {
      commitKillStamp: () => {
        if (!commitWorks) return { committed: false };
        killed = true;
        version += 1;
        return { committed: true, stampVersion: version };
      },
      readKillState: () => ({
        reachable,
        readLatencyMs: reachable ? 12 : 6000,
        killed,
        stampVersion: version,
      }),
    };

    const ctrl = new KillSwitchController(store);
    // Durable failure -> 503
    commitWorks = false;
    expect(ctrl.triggerKill({ tenantId: 't1', siteId: 's1', campaignId: 'c1', reason: 'emergency' }).httpStatus).toBe(
      503
    );

    // Durable commit -> 200 and lease withheld
    commitWorks = true;
    expect(ctrl.triggerKill({ tenantId: 't1', siteId: 's1', campaignId: 'c1', reason: 'emergency' }).httpStatus).toBe(
      200
    );
    expect(ctrl.canIssueDisplayLease({ tenantId: 't1', siteId: 's1', campaignId: 'c1' }).allowLease).toBe(false);

    // 5s unreachable -> fail-closed
    killed = false;
    reachable = false;
    expect(ctrl.canIssueDisplayLease({ tenantId: 't1', siteId: 's1', campaignId: 'c1' }).allowLease).toBe(false);

    // Auto-breaker trips on >= 5% failure rate across 20 SDK reports
    reachable = true;
    let tripped = false;
    for (let i = 0; i < 20; i++) {
      const r = ctrl.recordSdkHealthTelemetry({
        tenantId: 't1',
        siteId: 's1',
        campaignId: 'c2',
        browserEngine: 'webkit',
        ok: i >= 2, // 2/20 = 10% failures
        reportDeliveryLatencyMs: 500,
      });
      if (r.breakerTripped) tripped = true;
    }
    expect(tripped).toBe(true);

    // Mandatory 300-run stop drill per path (K1..K4) -> 0 violations!
    const drill = runKillSwitch300Drills({ runsPerPath: 300 });
    expect(drill.gateId).toBe('del.D3');
    expect(drill.totalViolations).toBe(0);
    expect(drill.passed).toBe(true);
    expect(drill.reports).toHaveLength(5);
  });

  test('5-B Preflight: >=59 broken patches 0 missed, >=100 valid <=4 FP, 60-page stratified check, live probe rollback, and first-exposure max(300, 20%) with no exemption', () => {
    const bench = runPreflightDefectBenchmark(60, 100);
    expect(bench.brokenCasesTested).toBe(60);
    expect(bench.brokenMissed).toBe(0);
    expect(bench.validCasesTested).toBe(100);
    expect(bench.falsePositives).toBeLessThanOrEqual(4);
    expect(bench.passed).toBe(true);

    // 60 clean stratified pages -> defectRateUpper95 = 3/60 = 5%
    const clean60 = Array.from({ length: 60 }, (_, i) => ({
      pageId: `p_${i}`,
      visitWeight: 100,
      targetMatchCount: 1,
      targetInProtectedRegion: false,
      clsDelta: 0.003,
      consoleErrors: 0,
      cspViolations: 0,
      overlapsPrimaryCta: false,
      breaksLayoutOverflow: false,
      affiliateByteHashMatches: true,
    }));
    const pf = runStratifiedPreflight({
      key: {
        campaignId: 'cmp_1',
        runtimeAndSegmenterHash: 'rt_seg_v1',
        templateId: 'article',
        slotContext: 'after_intro',
        viewportClass: 'mobile',
        engine: 'webkit',
      },
      pages: clean60,
      totalSiteVisitWeight: 6000,
      iosRealDeviceProbed: true,
      changesLayoutOrOverlay: true,
    });
    expect(pf.passed).toBe(true);
    expect(pf.defectRateUpper95).toBeCloseTo(0.05, 5);
    expect(pf.iosConfirmationLabel).toBe('ios_real_device_verified');

    // Live post-write probe failure triggers instant rollback + auto-breaker
    const probeFail = runLiveWriteGuardAndProbe({
      urlId: 'url_9',
      deviceClass: 'mobile',
      targetMatchCount: 1,
      preconditionMatches: true,
      targetProtected: false,
      postWriteIntact: false,
      postWriteClsDelta: 0.002,
    });
    expect(probeFail.rolledBack).toBe(true);
    expect(probeFail.notifyAutoBreaker).toBe(true);

    // First exposure rollout holds low-traffic stratum at smoke share (never exempt!)
    const rollout = evaluateFirstExposureRollout([
      { templateId: 'article', browserEngine: 'chromium', dailyExposedUnits: 2000, observedSmokeUnits: 450, probeFailures: 0 },
      { templateId: 'article', browserEngine: 'webkit', dailyExposedUnits: 500, observedSmokeUnits: 120, probeFailures: 0 },
    ]);
    expect(rollout.canPromoteFullRollout).toBe(false);
    expect(rollout.strataStatuses[1].state).toBe('hold_at_smoke_share');
    expect(rollout.strataStatuses[1].daysRemaining).toBeGreaterThan(0);
  });

  test('5-B Feature flags (2 modes): browser lease fallback, server local signed-bundle + pre-apply persistence, collision guard, R1 vs R2 risk, and gap -> invalid', () => {
    const flag: RegisteredFeatureFlag = {
      flagKey: 'fraud_shield_v2',
      tenantId: 'tenant_a',
      siteId: 'site_1',
      layerId: 'layer_checkout',
      region: 'checkout_cta',
      saltKey: 'salt_fraud_v2',
      safeValue: 'strict_on', // safe value isn't always "off"!
      arms: [
        { value: 'strict_on', weight: 50 },
        { value: 'adaptive_v2', weight: 50 },
      ],
      enabled: true,
    };

    // Allocator layer collision detected before preflight
    expect(
      checkFlagExperimentCollision(flag, [
        { experimentId: 'exp_1', layerId: 'layer_checkout', region: 'other' },
      ]).collision
    ).toBe(true);

    // Risk classification: revert to safeValue = R1, other change = R2
    expect(classifyFeatureFlagChangeRisk({ flag, targetValue: 'strict_on', isRevertToSafeValue: true })).toBe('R1');
    expect(classifyFeatureFlagChangeRisk({ flag, targetValue: 'adaptive_v2', isRevertToSafeValue: false })).toBe('R2');

    // Mode 1: Browser evaluation falls back to safeValue when lease expired
    expect(
      evaluateBrowserFeatureFlag({
        flag,
        lease: {
          leaseId: 'l1',
          siteId: 'site_1',
          issuedAtMs: 1000,
          expiresAtMs: 5000,
          assignedArmValue: 'adaptive_v2',
          controlReachable: true,
        },
        nowMs: 6000,
      })
    ).toMatchObject({ value: 'strict_on', fallbackToSafe: true, reason: 'lease_expired' });

    // Mode 2: Customer Server local signed-bundle evaluation + pre-apply seq log + LINK gap detector
    const pair = generateEd25519KeyPair('flag_k1');
    const bUnsigned = { bundleId: 'b1', tenantId: 'tenant_a', siteId: 'site_1', flags: [flag], issuedAtMs: 1000 };
    const lUnsigned = { leaseId: 'l1', siteId: 'site_1', issuedAtMs: 1000, expiresAtMs: 100_000 };
    const evaluator = new ServerFeatureFlagEvaluator({
      publicKeyPem: pair.publicKeyPem,
      bundle: { ...bUnsigned, signatureBase64Url: signServerFlagObject(bUnsigned, pair.privateKeyPem) },
      lease: { ...lUnsigned, signatureBase64Url: signServerFlagObject(lUnsigned, pair.privateKeyPem) },
    });

    const d1 = evaluator.evaluateLocal('fraud_shield_v2', 'u_1', 2000);
    const d2 = evaluator.evaluateLocal('fraud_shield_v2', 'u_2', 3000);
    const d3 = evaluator.evaluateLocal('fraud_shield_v2', 'u_3', 4000);
    expect(d1.persistedBeforeApply).toBe(true);
    expect(d3.seq).toBe(3);

    // Expired lease on server falls back strictly to safeValue
    const expiredEval = evaluator.evaluateLocal('fraud_shield_v2', 'u_4', 200_000);
    expect(expiredEval.value).toBe('strict_on');
    expect(expiredEval.fallbackToSafe).toBe(true);

    // Contiguous batch passes audit
    expect(
      auditServerFlagDecisionBatch({ flag, receivedRecords: [d1, d2, d3] }).status
    ).toBe('ok');

    // Missing decision seq #2 -> NEVER silently dropped; window marked `invalid` & resend requested!
    const gapped = auditServerFlagDecisionBatch({ flag, receivedRecords: [d1, d3] });
    expect(gapped.status).toBe('invalid');
    expect(gapped.missingSeqNumbers).toEqual([2]);
    expect(gapped.resendRequested).toBe(true);
  });

  test('[H-09] validateExpressionSpec enforces closed grammar on A1c and A2, blocks affiliate/script/CSS injection, and locks siteDefault=off against CMP escalation', () => {
    // 1. Valid A1c passes closed grammar validation
    const cleanA1c = convertLegacySanitizedHtmlToA1c(
      '<h2>Special Guide</h2><a href="https://example.jp/go">Read</a>'
    );
    const validRes = validateExpressionSpec(cleanA1c, {
      semanticCategory: 'cro_layout',
      protectedMatchKeys: [],
      registeredDestinationUrls: ['https://example.jp/go'],
    });
    expect(validRes.valid).toBe(true);

    // 2. Malicious A1c with disallowed tag, affiliate hrefSlot, dangerous CSS url(), and undeclared state transition -> REJECTED!
    const poisonedA1c = validateExpressionSpec(
      {
        tier: 'A1c',
        shadowDomMode: 'closed',
        root: {
          tag: 'div',
          styles: {
            color: '#111111',
            backgroundImage: 'url(https://evil.example/beacon)',
          } as unknown as Record<string, string>,
          children: [
            {
              tag: 'script' as unknown as 'div',
              textSlot: 's_xss',
            },
            {
              tag: 'a',
              textSlot: 's_label',
              hrefSlot: 's_aff',
              actionEvent: 'undeclared_evt',
            },
          ],
        },
        states: ['open'],
        transitions: [{ from: 'open', on: 'close', to: 'ghost_state' }],
        values: {
          s_xss: '<script>alert(1)</script>',
          s_label: 'Buy now',
          s_aff: 'https://www.amazon.co.jp/dp/B0001?tag=rogue-22',
        },
      },
      {
        semanticCategory: 'cro_layout',
        protectedMatchKeys: [],
        registeredDestinationUrls: ['https://example.jp/go'],
      }
    );
    expect(poisonedA1c.valid).toBe(false);
    expect(poisonedA1c.violations.some((v) => v.includes('A1C_TAG_NOT_ALLOWLISTED'))).toBe(true);
    expect(poisonedA1c.violations.some((v) => v.includes('A1C_AFFILIATE_VALUE_FORBIDDEN'))).toBe(true);
    expect(poisonedA1c.violations.some((v) => v.includes('A1C_EXECUTABLE_VALUE_FORBIDDEN'))).toBe(true);
    expect(poisonedA1c.violations.some((v) => v.includes('A1C_STYLE_PROPERTY_NOT_ALLOWLISTED'))).toBe(true);
    expect(poisonedA1c.violations.some((v) => v.includes('A1C_UNDECLARED_TRANSITION_STATE'))).toBe(true);
    expect(poisonedA1c.violations.some((v) => v.includes('A1C_UNDECLARED_ACTION_EVENT'))).toBe(true);

    // 3. Malicious A2 with insert_element affiliate injection, onclick attribute, built-in protected region, and missing restoreKey -> REJECTED!
    const poisonedA2 = validateExpressionSpec(
      {
        tier: 'A2',
        operations: [
          {
            opId: 'op_aff_insert',
            kind: 'insert_element',
            targetMatchKey: 'sec_hero',
            payload: {
              tag: 'a',
              href: 'https://px.a8.net/svt/ejp?a8mat=3Z999',
              onclick: 'steal()',
            },
            inverseOp: { kind: 'remove', restoreKey: '' },
          },
          {
            opId: 'op_pw_touch',
            kind: 'replace_text',
            targetMatchKey: 'password',
            payload: { text: 'Enter credentials' },
            inverseOp: { kind: 'replace_text', restoreKey: 'rk_pw' },
          },
        ],
      },
      {
        semanticCategory: 'cro_layout',
        protectedMatchKeys: [],
        registeredDestinationUrls: ['https://example.jp/go'],
      }
    );
    expect(poisonedA2.valid).toBe(false);
    expect(poisonedA2.violations.some((v) => v.includes('A2_INVERSE_OP_REQUIRED'))).toBe(true);
    expect(poisonedA2.violations.some((v) => v.includes('A2_AFFILIATE_MUTATION_FORBIDDEN'))).toBe(true);
    expect(poisonedA2.violations.some((v) => v.includes('A2_INSERT_ATTR_NOT_ALLOWLISTED'))).toBe(true);
    expect(poisonedA2.violations.some((v) => v.includes('A2_PROTECTED_REGION_FORBIDDEN'))).toBe(true);

    // 4. Consent gate: siteDefault === 'off' NEVER escalates above 'off' via CMP unless allowCmpOptInFromDefaultOff === true
    expect(resolveDeliveryConsentMode('off', 'full')).toBe('off');
    expect(resolveDeliveryConsentMode('off', 'essential_1p')).toBe('off');
    const lockedGate = resolveDeliveryConsentGate({
      siteDefault: 'off',
      cmpResolved: 'full',
      requestedExpressionTier: 'A1',
    });
    expect(lockedGate.effectiveConsentMode).toBe('off');
    expect(lockedGate.allowDelivery).toBe(false);
    expect(lockedGate.maxAllowedTier).toBe('A0');
    expect(lockedGate.reason).toBe('site_default_off_locked');

    // Explicit signed opt-in permission allows controlled escalation (still bounded by loaderDataCap)
    const permittedGate = resolveDeliveryConsentGate({
      siteDefault: 'off',
      cmpResolved: 'full',
      loaderDataCap: 'essential_1p',
      allowCmpOptInFromDefaultOff: true,
      requestedExpressionTier: 'A2',
    });
    expect(permittedGate.effectiveConsentMode).toBe('essential_1p');
    expect(permittedGate.allowDelivery).toBe(true);
    expect(permittedGate.escalatedFromDefaultOff).toBe(true);
  });
});
