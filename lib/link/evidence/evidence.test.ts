import { validateSerializedEnvelope } from '@/packages/contract/response';
import {
  DualExperimentLedger,
  buildProvenVerdictEnvelope,
  evaluateCupedVarianceReduction,
  evaluateD07RCalibration,
  evaluateInterimLook,
  evaluatePostWinLifecycle,
  evaluateProvenVerdict,
  lockPreregistration,
  runPlacebo1000Test,
  verifyAlphaSplitSumsToOne,
  type PlaceboUnitOutcome,
} from './index';

describe('lib/link/evidence — Wave 5-C: Prereg Lock, Alpha Split, CUPED, ev.G-6 1000x Placebo, LORD++ FDR, 5-Pathway proven & D-07R', () => {
  test('Pre-registration locks before allocation, interim alpha sums to 1.0, CUPED gate requires >1.05 speedup LB, and DualExperimentLedger enforces LORD++ FDR <= 10%', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const locked = lockPreregistration(
      {
        experimentId: 'exp_hero_1',
        siteId: 'site_1',
        tenantId: 'tenant_a',
        registerKind: 'human_approved',
        hypothesis: 'Clearer CTA increases affiliate outbound clicks',
        primaryMetric: 'outbound_click_rate',
        secondaryMetrics: ['focal_dwell_ms'],
        guardrailMetrics: ['cls_p95', 'inp_bad_share'],
        plannedNPerArm: 4000,
        alpha: 0.05,
        targetMdeRelative: 0.15,
        cupedTheta: 0.42,
        cupedCovariateName: 'prior_28d_clicks',
        firstAllocationAtIso: null,
      },
      now
    );
    expect(locked.locked).toBe(true);
    expect(locked.preregHash).toMatch(/^[0-9a-f]{64}$/);

    // Locking AFTER first allocation throws!
    expect(() =>
      lockPreregistration(
        {
          ...locked,
          firstAllocationAtIso: '2026-11-19T00:00:00Z',
        },
        now
      )
    ).toThrow(/PREREG_LOCK_AFTER_ALLOCATION_FORBIDDEN/);

    // Alpha spending sums strictly to 1.0 (0.10 + 0.05 + 0.05 + 0.80)
    expect(verifyAlphaSplitSumsToOne()).toBe(true);
    expect(evaluateInterimLook({ totalAlpha: 0.05, stage: 'info_50', zStatistic: 3.2 }).crossesBoundary).toBe(
      true
    );
    expect(evaluateInterimLook({ totalAlpha: 0.05, stage: 'info_50', zStatistic: 1.96 }).crossesBoundary).toBe(
      false
    );

    // CUPED variance reduction with strong pre-covariate correlation passes > 1.05 LB
    const cupedRows = Array.from({ length: 400 }, (_, i) => {
      const pre = ((i * 37) % 100) / 10;
      const noise = (((i * 13) % 11) - 5) * 0.2;
      return { preCovariate: pre, outcome: 0.7 * pre + noise };
    });
    const cupedRes = evaluateCupedVarianceReduction(cupedRows);
    expect(cupedRes.speedupLower95).toBeGreaterThan(1.05);
    expect(cupedRes.eligibleForPlannerReduction).toBe(true);

    // Dual register separates human vs autonomy LORD++ stream
    const ledger = new DualExperimentLedger(0.1);
    const h = ledger.recordHumanExperiment({ experimentId: 'exp_h1', pValue: 0.02, now });
    const a1 = ledger.recordAutonomyExperiment({ experimentId: 'exp_a1', pValue: 0.001, now });
    const a2 = ledger.recordAutonomyExperiment({ experimentId: 'exp_a2', pValue: 0.09, now });
    expect(h.rejectedNull).toBe(true);
    expect(a1.rejectedNull).toBe(true);
    expect(a2.rejectedNull).toBe(false);
    expect(ledger.getRegisters().autonomyTargetFdr).toBe(0.1);
  });

  test('ev.G-6 1,000-run placebo test rejection rate stays strictly inside [0.037, 0.064] at nominal α=0.05', () => {
    // Realistic 28-day unit outcomes (n = 600 units, skewed binary/count outcome)
    const units: PlaceboUnitOutcome[] = Array.from({ length: 600 }, (_, i) => ({
      unitId: `unit_28d_${i}`,
      outcome: (i * 2654435761) % 100 < 15 ? 1 : 0,
    }));

    const report = runPlacebo1000Test({
      units,
      runs: 1000,
      alpha: 0.05,
      baseSeed: 'ugokilink_placebo_g6_v1',
    });

    expect(report.gateId).toBe('ev.G-6');
    expect(report.runs).toBe(1000);
    expect(report.allowedBand).toEqual([0.037, 0.064]);
    expect(report.rejectionRate).toBeGreaterThanOrEqual(0.037);
    expect(report.rejectionRate).toBeLessThanOrEqual(0.064);
    expect(report.passed).toBe(true);
  });

  test('5-pathway proven verdict: 3 skeptical priors, Type-M, A/A canary invalidation, lab_randomised no visitor projection, D-07R calibration, I1–I7 envelope & post-win lifecycle', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const strongProvenInput = {
      experimentId: 'exp_win_1',
      interventionRefId: 'intv_win_1',
      predicate: 'visitor_randomised' as const,
      collectionGen: 'v3' as const,
      allocatorLoggedBeforeOutcomes: true,
      preregLocked: true,
      integrityStatus: 'pass' as const,
      decisionRulePassed: true,
      robustnessPassed: true,
      platformCanaryPassed: true,
      durationDays: 21,
      randomisationAuditP: 0.0005,
      alpha: 0.05,
      rawLogRr: 0.22,
      rawSeLogRr: 0.035,
      targetMdeLogRr: 0.15,
      detectableMdeAtCurrentN: 0.08,
      plannedNReached: true,
      holdbackConfirmed: false,
      guardrailsVerified: true,
      claimAgeDays: 10,
      bodyFingerprintChanged: false,
      expectedMonthlyBaselineUnits: 1000,
      sampleN: 12000,
      now,
    };

    const win = evaluateProvenVerdict(strongProvenInput);
    expect(win.evidenceLevel).toBe('proven');
    expect(win.verdict).toBe('superior');
    expect(win.stats.skepticalPosteriors).toHaveLength(3);
    expect(win.stats.typeMExaggerationRatio).toBeGreaterThanOrEqual(1);
    expect(win.pointEstimateUnlocked).toBe(true);
    expect(win.pointEstimateMonthlyDeltaUnits).toBeGreaterThan(0);

    // Serialized envelope passes ALL I1–I7 invariants!
    const env = buildProvenVerdictEnvelope({
      input: strongProvenInput,
      verdict: win,
      windowStart: '2026-10-30T00:00:00Z',
      windowEnd: '2026-11-20T00:00:00Z',
      now,
    });
    expect(validateSerializedEnvelope(env).valid).toBe(true);

    // Platform A/A canary failure invalidates concurrent experiment!
    const canaryFailed = evaluateProvenVerdict({
      ...strongProvenInput,
      platformCanaryPassed: false,
    });
    expect(canaryFailed.verdict).toBe('invalid');
    expect(canaryFailed.pointEstimateUnlocked).toBe(false);

    // `lab_randomised` can reach `proven` for lab scope, but NEVER unlocks visitor point estimate!
    const labRes = evaluateProvenVerdict({
      ...strongProvenInput,
      predicate: 'lab_randomised',
    });
    expect(labRes.evidenceLevel).toBe('proven');
    expect(labRes.pointEstimateUnlocked).toBe(false);

    // `bandit_replay` requires >= 10,000 replays
    expect(
      evaluateProvenVerdict({
        ...strongProvenInput,
        predicate: 'bandit_replay',
        banditReplayRuns: 5000,
      }).evidenceLevel
    ).toBe('observed');

    // Inconclusive NEVER says "no effect" — reports visible MDE
    const inconc = evaluateProvenVerdict({
      ...strongProvenInput,
      decisionRulePassed: false,
      randomisationAuditP: 0.32,
      rawLogRr: 0.04,
      rawSeLogRr: 0.05,
    });
    expect(inconc.verdict).toBe('inconclusive');
    expect(inconc.verdictSummary).toMatch(/minimum detectable effect/i);
    expect(inconc.verdictSummary).not.toMatch(/no effect|効果なし/i);

    // D-07R calibration: 25/30 fails (< 0.70 Clopper-Pearson 95% LB), 26/30 across 3 sites passes!
    const calFail = evaluateD07RCalibration({ resolvedInterventions: 30, coveredInterventions: 24, distinctSites: 3 });
    expect(calFail.gatePassed).toBe(false);
    expect(calFail.presentationMode).toBe('band_only');

    const calPass = evaluateD07RCalibration({ resolvedInterventions: 30, coveredInterventions: 26, distinctSites: 3 });
    expect(calPass.gatePassed).toBe(true);
    expect(calPass.clopperPearsonLower95).toBeGreaterThanOrEqual(0.7);
    expect(calPass.presentationMode).toBe('interval');

    // Post-win lifecycle: weekly batch for normal wins, immediate for harm removal, expired > 180d
    const normalWin = evaluatePostWinLifecycle({
      adoptionId: 'adp_1',
      experimentId: 'exp_win_1',
      isHarmRemoval: false,
      browserBridgeDaysElapsed: 7,
      originBaked: true,
      originFingerprintVerified: true,
      reverseHoldbackDaysElapsed: 20,
      claimDaysElapsed: 30,
      bodyFingerprintChanged: false,
    });
    expect(normalWin.deploymentCadence).toBe('weekly_batch');
    expect(normalWin.stage).toBe('browser_retired_reverse_holdback');
    expect(normalWin.browserPatchRetired).toBe(true);

    const harmRemoval = evaluatePostWinLifecycle({
      adoptionId: 'adp_2',
      experimentId: 'exp_harm_1',
      isHarmRemoval: true,
      browserBridgeDaysElapsed: 0,
      originBaked: false,
      originFingerprintVerified: false,
      reverseHoldbackDaysElapsed: 0,
      claimDaysElapsed: 1,
      bodyFingerprintChanged: false,
    });
    expect(harmRemoval.deploymentCadence).toBe('immediate_harm_removal');
  });
});
