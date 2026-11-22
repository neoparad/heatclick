/**
 * UGOKI LINK v2 — Migration Tools Test Suite (`lib/link/migration`)
 *
 * Covers:
 * 1. Randomized 3-arm parallel run + 2s audit arm + SRM detection + anti-double-count
 * 2. Exact 11-class telemetry loss ledger (L0..L10) + Wilson 95% CI + ceiling alerts
 * 3. Legacy data bridge (§5.10): k=50 fold-before-drop, click-string conversion-before-strip
 *    ordering enforcement, recoverable (`inferred`) vs unrecoverable (`not_collected`),
 *    observed-cap & fingerprint/training exclusions
 * 4. ±5% legacy-vs-v3 calibration gate (`tel.G18`) + conversion parity (`tel.G17`)
 */

import {
  ARM_BIT_AUDIT_2S,
  assertNoLegacyV3Mix,
  calibrateLegacySeries,
  detectParallelRunSrm,
  DoubleCountGuardError,
  evaluateCalibrationGate,
  evaluateCalibrationSlice,
  evaluateConversionParityG17,
  LegacyBridgeOrderError,
  LegacyBridgePipeline,
  LOSS_CLASSES,
  ParallelRunController,
  runLegacyBridge,
  TelemetryLossLedger,
  type LegacyClickRow,
  type LegacyScrollRow,
  type PairedCalibrationSample,
} from './index';

describe('lib/link/migration/parallel-run (§4.11)', () => {
  test('assigns balanced 3-arm split with deterministic idempotence, 2s audit sub-arm, and SRM detection', () => {
    const ctrl = new ParallelRunController({
      tenantId: 't1',
      siteId: 's1',
      salt: 'parallel-2026',
      audit2sShare: 0.13,
    });

    let audit2sCount = 0;
    let v3ActiveCount = 0;

    for (let i = 0; i < 6000; i += 1) {
      const a = ctrl.assign(`pv-unit-${i}`);
      // Deterministic repeat returns exact same assignment without double counting
      const repeat = ctrl.assign(`pv-unit-${i}`);
      expect(repeat).toEqual(a);

      if (a.shouldLoadV3) {
        v3ActiveCount += 1;
        if (a.audit2s) {
          audit2sCount += 1;
          expect((a.armBits & ARM_BIT_AUDIT_2S) !== 0).toBe(true);
          expect(a.heartbeatFloorSec).toBe(2);
        }
      } else {
        expect(a.audit2s).toBe(false);
      }
    }

    const srm = ctrl.checkSrm();
    expect(srm.totalObserved).toBe(6000);
    expect(srm.srmDetected).toBe(false);
    expect(srm.pValue).toBeGreaterThan(0.01);

    // ~13% audit share on v3-active PVs (~4000 PVs -> ~520 ± 80)
    const observedAuditShare = audit2sCount / v3ActiveCount;
    expect(observedAuditShare).toBeGreaterThan(0.1);
    expect(observedAuditShare).toBeLessThan(0.16);

    // Skewed counts trigger SRM immediately
    const brokenSrm = detectParallelRunSrm({ v2_only: 2500, v3_only: 1800, both: 1700 });
    expect(brokenSrm.srmDetected).toBe(true);
    expect(brokenSrm.pValue).toBeLessThan(0.001);
  });

  test('prevents double counting on `both` arm and throws when mixing legacy + v3 rows', () => {
    const ctrl = new ParallelRunController({
      tenantId: 't1',
      siteId: 's1',
      salt: 'dedup',
    });

    const first = ctrl.recordObservation({
      tenantId: 't1',
      siteId: 's1',
      arm: 'both',
      collectionGen: 'legacy',
      unitKey: 'pair-1',
      v2SessionKey: 'sess-v2-1',
      v2PageLoadOrdinal: 1,
    });
    expect(first.accepted).toBe(true);
    expect(first.countTowardCanonicalPv).toBe(true);
    expect(first.pairedComplete).toBe(false);

    const second = ctrl.recordObservation({
      tenantId: 't1',
      siteId: 's1',
      arm: 'both',
      collectionGen: 'v3',
      unitKey: 'pair-1',
      v3PvId: 'pv-v3-1',
    });
    expect(second.accepted).toBe(true);
    expect(second.countTowardCanonicalPv).toBe(false); // Never double-counted!
    expect(second.pairedComplete).toBe(true);

    // Mixing legacy and v3 rows in a single sum throws DoubleCountGuardError
    expect(() =>
      assertNoLegacyV3Mix([{ collectionGen: 'legacy' }, { collectionGen: 'v3' }])
    ).toThrow(DoubleCountGuardError);
  });
});

describe('lib/link/migration/loss-ledger (11 loss classes L0..L10)', () => {
  test('classifies all 11 loss classes per site×day×device×browserFamily and raises ceiling breach alerts', () => {
    expect(LOSS_CLASSES).toHaveLength(11);

    const ledger = new TelemetryLossLedger();
    const slice = {
      tenantId: 't1',
      siteId: 's1',
      dayUtc: '2026-11-20',
      deviceClass: 'mobile' as const,
      browserFamily: 'line_inapp', // In-app browser kept as distinct family (§4.4)
    };

    ledger.addDenominators(slice, {
      serverDocumentRequests: 1000,
      loaderFetches: 900,
      pvs: 850,
      frames: 4000,
      ackedFrames: 3800,
      fieldsExpected: 1000,
      stateIncompletePvs: 0,
      heartbeatIntervalMs: 10_000,
    });

    ledger.recordLoss(slice, 'L0_loader_never_fetched', 100);
    ledger.recordLoss(slice, 'L1_loader_fetched_no_frame', 40);
    ledger.recordLoss(slice, 'L2_ended_before_sdk_start', 10);
    ledger.recordLoss(slice, 'L3_intermediate_unacked_gap', 20);
    ledger.recordLoss(slice, 'L4_terminal_frame_unconfirmed', 170);
    ledger.recordLoss(slice, 'L5_post_ack_loss', 2); // 2/3800 = 0.000526 > 0.0001 -> SEV-1!
    ledger.recordLoss(slice, 'L6_quarantine_and_field_drop', 4);
    ledger.recordLoss(slice, 'L7_coarsening_cap_hit', 15);
    ledger.recordLoss(slice, 'L8_degrade_ladder', 60); // 60/850 = 7.06% > 5% -> SEV-2!
    ledger.recordLoss(slice, 'L9_field_dark', 0);
    ledger.recordLoss(slice, 'L10_consent_optout_privacy', 50);

    const report = ledger.evaluateSlice(slice);
    expect(Object.keys(report.classes)).toHaveLength(11);
    expect(report.classes.L4_terminal_frame_unconfirmed.rate).toBeCloseTo(0.2, 4);
    expect(report.classes.L4_terminal_frame_unconfirmed.wilson95).not.toBeNull();
    expect(report.classes.L5_post_ack_loss.breached).toBe(true);
    expect(report.classes.L8_degrade_ladder.breached).toBe(true);
    expect(report.classes.L10_consent_optout_privacy.breached).toBe(false);

    const alertCodes = report.alerts.map((a) => a.code);
    expect(alertCodes).toContain('L5');
    expect(alertCodes).toContain('L8');
    expect(report.measurementBlock.tail_bound_ms).toBe(10_000);
    expect(report.measurementBlock.terminal_unconfirmed).toHaveLength(2);
  });
});

describe('lib/link/migration/legacy-bridge (§5.10)', () => {
  const cutoffMs = Date.UTC(2025, 10, 1, 0, 0, 0);

  test('enforces strict irreversible order: refuses dropping expired rows before fold or stripping click strings before conversion rules', () => {
    const pipeline = new LegacyBridgePipeline({
      scrollRows: [],
      clickRows: [
        {
          legacyEventId: 'clk-1',
          tenantId: 't1',
          siteId: 's1',
          sessionId: 'sess-1',
          urlKey: 'example.com/lp',
          occurredAtMs: cutoffMs + 1000,
          elementSelector: '#cta-buy-now',
          elementText: '今すぐ申し込む',
          href: 'https://example.com/checkout',
        },
      ],
    });

    // Attempting to drop expired rows before folding throws
    expect(() => pipeline.dropExpiredRawRows(cutoffMs)).toThrow(LegacyBridgeOrderError);

    // Attempting to strip click strings before running conversion rules throws!
    expect(() => pipeline.stripClickStrings()).toThrow(LegacyBridgeOrderError);
  });

  test('folds expired rows with k=50, extracts conversions before stripping strings, marks recoverable=inferred & unrecoverable=not_collected', () => {
    const scrollRows: LegacyScrollRow[] = [];
    // 55 distinct expired sessions on /popular (passes k=50) + 10 on /rare (suppressed <50)
    for (let i = 0; i < 55; i += 1) {
      scrollRows.push({
        legacyEventId: `exp-pop-${i}`,
        tenantId: 't1',
        siteId: 's1',
        sessionId: `old-sess-${i}`,
        urlKey: 'example.com/popular',
        occurredAtMs: cutoffMs - 86_400_000,
        sequenceId: 1,
        scrollY: 500,
        scrollPercentage: 50,
        viewportHeight: 800,
        dwellDeltaMs: 1000,
      });
    }
    for (let i = 0; i < 10; i += 1) {
      scrollRows.push({
        legacyEventId: `exp-rare-${i}`,
        tenantId: 't1',
        siteId: 's1',
        sessionId: `rare-sess-${i}`,
        urlKey: 'example.com/rare',
        occurredAtMs: cutoffMs - 86_400_000,
        sequenceId: 1,
        scrollY: 300,
        scrollPercentage: 30,
        viewportHeight: 800,
        dwellDeltaMs: 1000,
      });
    }

    // Active (within retention) scroll sequence with 1 reversal (down -> up -> down = 2 direction changes, let's check: 400->1200 (+1), 1200->600 (-1, rev 1), 600->1800 (+1, rev 2))
    const activeStart = cutoffMs + 3_600_000;
    scrollRows.push(
      {
        legacyEventId: 'act-1',
        tenantId: 't1',
        siteId: 's1',
        sessionId: 'sess-active',
        urlKey: 'example.com/lp',
        occurredAtMs: activeStart,
        sequenceId: 1,
        scrollY: 400,
        scrollPercentage: 20,
        viewportHeight: 800,
        dwellDeltaMs: 2500,
      },
      {
        legacyEventId: 'act-2',
        tenantId: 't1',
        siteId: 's1',
        sessionId: 'sess-active',
        urlKey: 'example.com/lp',
        occurredAtMs: activeStart + 3000,
        sequenceId: 2,
        scrollY: 1200,
        scrollPercentage: 60,
        viewportHeight: 800,
        dwellDeltaMs: 4000,
      },
      {
        legacyEventId: 'act-3',
        tenantId: 't1',
        siteId: 's1',
        sessionId: 'sess-active',
        urlKey: 'example.com/lp',
        occurredAtMs: activeStart + 7000,
        sequenceId: 3,
        scrollY: 600,
        scrollPercentage: 30,
        viewportHeight: 800,
        dwellDeltaMs: 2000,
      },
      {
        legacyEventId: 'act-4',
        tenantId: 't1',
        siteId: 's1',
        sessionId: 'sess-active',
        urlKey: 'example.com/lp',
        occurredAtMs: activeStart + 10_000,
        sequenceId: 4,
        scrollY: 1800,
        scrollPercentage: 90,
        viewportHeight: 800,
        dwellDeltaMs: 3000,
      }
    );

    const clickRows: LegacyClickRow[] = [
      {
        legacyEventId: 'clk-active-1',
        tenantId: 't1',
        siteId: 's1',
        sessionId: 'sess-active',
        urlKey: 'example.com/lp',
        occurredAtMs: activeStart + 11_000,
        elementSelector: '.cta-primary',
        elementText: '無料で試す',
        href: 'https://example.com/signup',
      },
    ];

    const res = runLegacyBridge({
      scrollRows,
      clickRows,
      vitalRows: [
        {
          tenantId: 't1',
          siteId: 's1',
          sessionId: 'sess-active',
          urlKey: 'example.com/lp',
          occurredAtMs: activeStart + 1000,
          lcpMs: 1850,
          inpMs: 110,
        },
      ],
      conversionRules: [
        { cvKey: 'signup_cta', ruleVersion: 1, selectorIncludes: '.cta-primary' },
      ],
      retentionCutoffMs: cutoffMs,
      kThreshold: 50,
    });

    // Fold check: /popular kept (>=50), /rare suppressed (<50)
    const popularCell = res.foldedExpiredCells.find((c) => c.urlKey === 'example.com/popular')!;
    const rareCell = res.foldedExpiredCells.find((c) => c.urlKey === 'example.com/rare')!;
    expect(popularCell.suppressed).toBe(false);
    expect(popularCell.distinctSessions).toBe(55);
    expect(rareCell.suppressed).toBe(true);
    expect(rareCell.distinctSessions).toBe(0);
    expect(res.droppedExpiredScrollRows).toBe(65);

    // Conversion extracted BEFORE strings stripped; sanitized clicks carry null strings
    expect(res.extractedConversions).toHaveLength(1);
    expect(res.extractedConversions[0]?.cvKey).toBe('signup_cta');
    expect(res.sanitizedClicks[0]?.elementSelector).toBeNull();
    expect(res.sanitizedClicks[0]?.elementText).toBeNull();

    // Reconstructed bridged PV checks
    expect(res.bridgedPvs).toHaveLength(1);
    const pv = res.bridgedPvs[0]!;
    expect(pv.collectionGen).toBe('legacy');
    expect(pv.directMeasured.evidenceLevel).toBe('observed');
    expect(pv.directMeasured.canBeProven).toBe(false);
    expect(pv.directMeasured.conversionCount).toBe(1);
    expect(pv.recovered.evidenceLevel).toBe('inferred');
    expect(pv.recovered.scrollReversals).toBe(2);
    expect(pv.recovered.pageHeightRangePx).not.toBeNull();
    expect(pv.recovered.webVitals.lcpMs).toBe(1850);

    // Unrecoverable fields are ALWAYS not_collected / null
    expect(pv.unrecoverable.pv_id.status).toBe('not_collected');
    expect(pv.unrecoverable.section_id.status).toBe('not_collected');
    expect(pv.unrecoverable.element_coordinates.status).toBe('not_collected');
    expect(pv.unrecoverable.form_field_duration_ms.status).toBe('not_collected');

    // Strict exclusions from fingerprint joins and default training sets
    expect(pv.excludeFromFingerprintJoin).toBe(true);
    expect(pv.excludeFromDefaultTraining).toBe(true);
  });
});

describe('lib/link/migration/calibration (±5% tel.G18 & tel.G17)', () => {
  test('passes tel.G18 when relative 95% half-width <= 5% and returns exact remaining pairs when unconverged', () => {
    // Tightly clustered ratio ~1.04 over 120 pairs -> converges well inside ±5%
    const tightSamples: PairedCalibrationSample[] = [];
    for (let i = 0; i < 120; i += 1) {
      const base = 1000 + (i % 10) * 50;
      const noise = ((i % 5) - 2) * 0.015; // ±3% per-PV jitter
      tightSamples.push({
        pairId: `p-${i}`,
        v2Value: base,
        v3Value: base * (1.04 + noise),
      });
    }

    const convergedNormal = evaluateCalibrationSlice({
      metric: 'scroll_max_px',
      deviceClass: 'desktop',
      browserFamily: 'chrome',
      samples: tightSamples,
      method: 'delta_normal',
    });
    expect(convergedNormal.converged).toBe(true);
    expect(convergedNormal.relativeHalfWidth!).toBeLessThanOrEqual(0.05);
    expect(convergedNormal.unmetGate).toBeNull();

    // Bootstrap method also agrees
    const convergedBoot = evaluateCalibrationSlice({
      metric: 'scroll_max_px',
      deviceClass: 'desktop',
      browserFamily: 'chrome',
      samples: tightSamples,
      method: 'bootstrap',
      bootstrapIterations: 400,
    });
    expect(convergedBoot.converged).toBe(true);
    expect(convergedBoot.ratio!).toBeCloseTo(convergedNormal.ratio!, 2);

    // Calibrated legacy series MUST be marked `inferred` and `cannotSumWithV3: true`
    const calibrated = calibrateLegacySeries(convergedNormal, [
      { bucketIso: '2026-10-01T00:00:00Z', rawLegacyValue: 1000 },
    ]);
    expect(calibrated[0]?.evidenceLevel).toBe('inferred');
    expect(calibrated[0]?.cannotSumWithV3).toBe(true);

    // Noisy small sample (n=35) fails ±5% and computes remaining pairs + UnmetGate
    const noisySamples: PairedCalibrationSample[] = [];
    for (let i = 0; i < 35; i += 1) {
      const base = 100;
      const swing = i % 2 === 0 ? 1.45 : 0.65;
      noisySamples.push({ pairId: `n-${i}`, v2Value: base, v3Value: base * swing });
    }
    const gateReport = evaluateCalibrationGate([
      {
        metric: 'conversions',
        deviceClass: 'mobile',
        browserFamily: 'safari',
        samples: noisySamples,
        dailyPairsRate: 25,
      },
    ]);
    expect(gateReport.allConverged).toBe(false);
    expect(gateReport.slices[0]?.remainingPairsEstimate).toBeGreaterThan(0);
    expect(gateReport.unmetGates).toHaveLength(1);
    expect(gateReport.unmetGates[0]?.id).toBe('tel.G18');
    expect(gateReport.unmetGates[0]?.eta).not.toBeNull();
  });

  test('tel.G17 verifies v3 conversions are non-inferior to v2 on both arm', () => {
    const pass = evaluateConversionParityG17({
      cvKey: 'purchase',
      bothArmPvs: 2000,
      v2Conversions: 100,
      v3Conversions: 104,
    });
    expect(pass.passed).toBe(true);

    const fail = evaluateConversionParityG17({
      cvKey: 'purchase',
      bothArmPvs: 2000,
      v2Conversions: 120,
      v3Conversions: 60,
    });
    expect(fail.passed).toBe(false);
  });

  test('Wave 8 Regressions (M-05): tel.G17 two-sided TOST rejects spurious v3 conversion inflation, and runLegacyBridge preserves 0-scroll bounce/click/vital PVs', () => {
    // Inflated v3 conversions (220 vs 100 on 2000 PVs) MUST fail two-sided equivalence!
    const inflated = evaluateConversionParityG17({
      cvKey: 'purchase',
      bothArmPvs: 2000,
      v2Conversions: 100,
      v3Conversions: 220,
    });
    expect(inflated.passed).toBe(false);
    expect(inflated.reason).toContain('outside equivalence margin');

    // 0-scroll session with click + conversion + vital MUST NOT be dropped from bridgedPvs!
    const cutoffMs = Date.UTC(2025, 10, 1, 0, 0, 0);
    const bounceRes = runLegacyBridge({
      scrollRows: [],
      clickRows: [
        {
          legacyEventId: 'clk-bounce-1',
          tenantId: 't1',
          siteId: 's1',
          sessionId: 'sess-zero-scroll',
          urlKey: 'example.com/instant-cta',
          occurredAtMs: cutoffMs + 5000,
          elementSelector: '#instant-buy',
          elementText: 'Buy',
          href: 'https://example.com/pay',
        },
      ],
      vitalRows: [
        {
          tenantId: 't1',
          siteId: 's1',
          sessionId: 'sess-zero-scroll',
          urlKey: 'example.com/instant-cta',
          occurredAtMs: cutoffMs + 1000,
          lcpMs: 950,
        },
      ],
      conversionRules: [
        { cvKey: 'instant_buy', ruleVersion: 1, selectorIncludes: '#instant-buy' },
      ],
      retentionCutoffMs: cutoffMs,
    });
    expect(bounceRes.bridgedPvs).toHaveLength(1);
    expect(bounceRes.bridgedPvs[0]?.directMeasured.maxScrollY).toBe(0);
    expect(bounceRes.bridgedPvs[0]?.directMeasured.conversionCount).toBe(1);
    expect(bounceRes.bridgedPvs[0]?.recovered.webVitals.lcpMs).toBe(950);
  });
});
