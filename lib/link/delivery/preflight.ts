/**
 * UGOKI LINK v2 — Preflight Stratified Inspection, Broken-Patch Defect Gate (>=59 broken / >=100 valid),
 * Live-PV Pre-Write & Post-Write Probes, First-Exposure Rollout & iOS 2-Stage Verification (§10.7)
 */

import { sha256Hex } from '@/packages/contract/response';

// =========================================================================
// 1. Stratified Preflight Report Key & Visit-Weighted Coverage (§10.7)
// =========================================================================

export interface PreflightReportKey {
  readonly campaignId: string;
  readonly runtimeAndSegmenterHash: string;
  readonly templateId: string;
  readonly slotContext: string;
  readonly viewportClass: 'mobile' | 'tablet' | 'desktop';
  readonly engine: 'chromium' | 'webkit' | 'gecko';
}

export function serializePreflightReportKey(key: PreflightReportKey): string {
  return [
    key.campaignId,
    key.runtimeAndSegmenterHash,
    key.templateId,
    key.slotContext,
    key.viewportClass,
    key.engine,
  ].join('|');
}

export interface PreflightPageInput {
  readonly pageId: string;
  readonly visitWeight: number;
  readonly targetMatchCount: number; // must be === 1
  readonly targetInProtectedRegion: boolean;
  readonly clsDelta: number; // must be <= 0.01
  readonly consoleErrors: number; // must be 0
  readonly cspViolations: number; // must be 0
  readonly overlapsPrimaryCta: boolean; // must be false
  readonly breaksLayoutOverflow: boolean; // must be false
  readonly affiliateByteHashMatches: boolean; // must be true
}

export interface PreflightInspectionResult {
  readonly reportKey: string;
  readonly pagesInspected: number;
  readonly cleanPages: number;
  readonly defectivePages: number;
  /** Rule-of-Three 95% upper defect rate bound: `3 / n` when 0 defects (60 clean pages -> 5%). */
  readonly defectRateUpper95: number;
  readonly visitWeightedCoverage: number;
  readonly iosConfirmationLabel: 'ios_real_device_verified' | 'ios_verified_in_live_visits_only';
  readonly passed: boolean;
  readonly defects: ReadonlyArray<{ readonly pageId: string; readonly reasons: ReadonlyArray<string> }>;
}

export function inspectSinglePagePreflight(page: PreflightPageInput): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (page.targetMatchCount === 0) reasons.push('TARGET_NOT_FOUND');
  if (page.targetMatchCount > 1) reasons.push('TARGET_AMBIGUOUS_MULTI_MATCH');
  if (page.targetInProtectedRegion) reasons.push('TARGET_IN_PROTECTED_REGION');
  if (page.clsDelta > 0.01) reasons.push(`CLS_EXCEEDED:${page.clsDelta}`);
  if (page.consoleErrors > 0) reasons.push(`CONSOLE_ERRORS:${page.consoleErrors}`);
  if (page.cspViolations > 0) reasons.push(`CSP_VIOLATIONS:${page.cspViolations}`);
  if (page.overlapsPrimaryCta) reasons.push('OVERLAPS_PRIMARY_CTA');
  if (page.breaksLayoutOverflow) reasons.push('LAYOUT_OVERFLOW');
  if (!page.affiliateByteHashMatches) reasons.push('AFFILIATE_BYTE_HASH_MISMATCH');
  return reasons;
}

export function runStratifiedPreflight(params: {
  readonly key: PreflightReportKey;
  readonly pages: ReadonlyArray<PreflightPageInput>;
  readonly totalSiteVisitWeight: number;
  readonly iosRealDeviceProbed?: boolean;
  readonly changesLayoutOrOverlay?: boolean;
}): PreflightInspectionResult {
  const defects: Array<{ pageId: string; reasons: ReadonlyArray<string> }> = [];
  let coveredWeight = 0;

  for (const p of params.pages) {
    coveredWeight += Math.max(0, p.visitWeight);
    const reasons = inspectSinglePagePreflight(p);
    if (reasons.length > 0) {
      defects.push({ pageId: p.pageId, reasons });
    }
  }

  const n = params.pages.length;
  const cleanPages = n - defects.length;
  const defectRateUpper95 = n > 0 ? (defects.length === 0 ? 3 / n : (defects.length + 3) / n) : 1;
  const visitWeightedCoverage =
    params.totalSiteVisitWeight > 0
      ? Math.min(1, coveredWeight / params.totalSiteVisitWeight)
      : 0;

  const iosConfirmationLabel = params.iosRealDeviceProbed
    ? 'ios_real_device_verified'
    : 'ios_verified_in_live_visits_only';

  // §10.7: Layout/overlay campaigns on WebKit/iOS should run real-device probe before full pass
  const iosGateOk = !params.changesLayoutOrOverlay || params.key.engine !== 'webkit' || Boolean(params.iosRealDeviceProbed);

  return {
    reportKey: serializePreflightReportKey(params.key),
    pagesInspected: n,
    cleanPages,
    defectivePages: defects.length,
    defectRateUpper95,
    visitWeightedCoverage,
    iosConfirmationLabel,
    passed: n >= 60 && defects.length === 0 && iosGateOk,
    defects,
  };
}

// =========================================================================
// 2. Preflight Defect Detection Benchmark Gate (§10.7: >=59 broken 0 missed, >=100 valid <=4 FP)
// =========================================================================

export interface PreflightBenchmarkReport {
  readonly brokenCasesTested: number;
  readonly brokenDetected: number;
  readonly brokenMissed: number;
  readonly validCasesTested: number;
  readonly falsePositives: number;
  readonly passed: boolean;
}

/**
 * Runs >= 59 intentionally broken mutations and >= 100 valid mutations through the preflight
 * detector, enforcing §10.7 gate: 0 missed broken patches (100% detection) and <= 4 false positives.
 */
export function runPreflightDefectBenchmark(
  brokenCount = 60,
  validCount = 100
): PreflightBenchmarkReport {
  const brokenN = Math.max(59, brokenCount);
  const validN = Math.max(100, validCount);

  let brokenDetected = 0;
  for (let i = 0; i < brokenN; i++) {
    const mode = i % 9;
    const page: PreflightPageInput = {
      pageId: `broken_${i}`,
      visitWeight: 10,
      targetMatchCount: mode === 0 ? 0 : mode === 1 ? 3 : 1,
      targetInProtectedRegion: mode === 2,
      clsDelta: mode === 3 ? 0.045 : 0.002,
      consoleErrors: mode === 4 ? 1 : 0,
      cspViolations: mode === 5 ? 1 : 0,
      overlapsPrimaryCta: mode === 6,
      breaksLayoutOverflow: mode === 7,
      affiliateByteHashMatches: mode !== 8,
    };
    if (inspectSinglePagePreflight(page).length > 0) {
      brokenDetected += 1;
    }
  }

  let falsePositives = 0;
  for (let i = 0; i < validN; i++) {
    const page: PreflightPageInput = {
      pageId: `valid_${i}`,
      visitWeight: 10,
      targetMatchCount: 1,
      targetInProtectedRegion: false,
      clsDelta: (i % 10) * 0.001, // 0.000 .. 0.009 <= 0.01
      consoleErrors: 0,
      cspViolations: 0,
      overlapsPrimaryCta: false,
      breaksLayoutOverflow: false,
      affiliateByteHashMatches: true,
    };
    if (inspectSinglePagePreflight(page).length > 0) {
      falsePositives += 1;
    }
  }

  const brokenMissed = brokenN - brokenDetected;
  return {
    brokenCasesTested: brokenN,
    brokenDetected,
    brokenMissed,
    validCasesTested: validN,
    falsePositives,
    passed: brokenMissed === 0 && falsePositives <= 4,
  };
}

// =========================================================================
// 3. Live-PV Pre-Write Guard & Post-Write Probe + Instant Rollback (§10.7)
// =========================================================================

export interface LiveProbeInput {
  readonly urlId: string;
  readonly deviceClass: 'mobile' | 'tablet' | 'desktop';
  readonly targetMatchCount: number;
  readonly preconditionMatches: boolean;
  readonly targetProtected: boolean;
  readonly postWriteIntact: boolean;
  readonly postWriteClsDelta: number;
}

export interface LiveProbeOutcome {
  readonly applied: boolean;
  readonly rolledBack: boolean;
  readonly disabledScopeKey: string | null;
  readonly notifyAutoBreaker: boolean;
  readonly reason: string;
}

export function runLiveWriteGuardAndProbe(input: LiveProbeInput): LiveProbeOutcome {
  // Pre-write check
  if (input.targetMatchCount !== 1 || !input.preconditionMatches || input.targetProtected) {
    return {
      applied: false,
      rolledBack: false,
      disabledScopeKey: null,
      notifyAutoBreaker: false,
      reason: 'PRE_WRITE_GUARD_SKIPPED',
    };
  }

  // Post-write probe: if broken, immediately roll back + disable (url, deviceClass) + alert auto-breaker!
  if (!input.postWriteIntact || input.postWriteClsDelta > 0.01) {
    return {
      applied: false,
      rolledBack: true,
      disabledScopeKey: sha256Hex(`${input.urlId}:${input.deviceClass}`).slice(0, 16),
      notifyAutoBreaker: true,
      reason: !input.postWriteIntact ? 'POST_WRITE_PROBE_FAILED' : 'POST_WRITE_CLS_EXCEEDED',
    };
  }

  return {
    applied: true,
    rolledBack: false,
    disabledScopeKey: null,
    notifyAutoBreaker: false,
    reason: 'LIVE_PROBE_PASSED',
  };
}

// =========================================================================
// 4. First-Exposure Rollout Gate (`max(300, 20% daily)` per stratum, NO exemptions)
// =========================================================================

export interface StratumFirstExposureInput {
  readonly templateId: string;
  readonly browserEngine: 'chromium' | 'webkit' | 'gecko';
  readonly dailyExposedUnits: number;
  readonly observedSmokeUnits: number;
  readonly probeFailures: number;
}

export interface StratumFirstExposureStatus {
  readonly stratumKey: string;
  readonly requiredUnits: number;
  readonly observedUnits: number;
  readonly probeFailures: number;
  readonly daysRemaining: number;
  readonly state: 'passed' | 'hold_at_smoke_share' | 'halted_probe_failure';
}

export function evaluateFirstExposureRollout(
  strata: ReadonlyArray<StratumFirstExposureInput>
): {
  readonly canPromoteFullRollout: boolean;
  readonly anyHalted: boolean;
  readonly strataStatuses: ReadonlyArray<StratumFirstExposureStatus>;
} {
  const statuses: StratumFirstExposureStatus[] = [];
  let anyHalted = false;
  let allPassed = strata.length > 0;

  for (const s of strata) {
    const stratumKey = `${s.templateId}:${s.browserEngine}`;
    const requiredUnits = Math.max(300, Math.ceil(s.dailyExposedUnits * 0.2));

    if (s.probeFailures > 0) {
      anyHalted = true;
      allPassed = false;
      statuses.push({
        stratumKey,
        requiredUnits,
        observedUnits: s.observedSmokeUnits,
        probeFailures: s.probeFailures,
        daysRemaining: Infinity,
        state: 'halted_probe_failure',
      });
      continue;
    }

    if (s.observedSmokeUnits < requiredUnits) {
      allPassed = false;
      const remaining = requiredUnits - s.observedSmokeUnits;
      const dailyRate = Math.max(1, s.dailyExposedUnits * 0.2);
      statuses.push({
        stratumKey,
        requiredUnits,
        observedUnits: s.observedSmokeUnits,
        probeFailures: 0,
        daysRemaining: Math.ceil(remaining / dailyRate),
        state: 'hold_at_smoke_share', // NEVER exempted (§10.7)
      });
      continue;
    }

    statuses.push({
      stratumKey,
      requiredUnits,
      observedUnits: s.observedSmokeUnits,
      probeFailures: 0,
      daysRemaining: 0,
      state: 'passed',
    });
  }

  return {
    canPromoteFullRollout: allPassed && !anyHalted,
    anyHalted,
    strataStatuses: statuses,
  };
}
