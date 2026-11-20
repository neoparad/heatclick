/**
 * UGOKI LINK v2 — Stratified Page-Unit Randomized Rollout & Post-Win Promotion Lifecycle (§9.8, §9.9)
 *
 * Implements:
 * 1. Stratified (`template × traffic × pre_trend`) Page-Unit Randomized Rollout (>= 3 waves):
 *    - The ONLY path that can prove search ranking effects (`proven` via `page_randomised`)
 *    - Required page-pair calculator incorporating minimum floor (6 pairs) and fake-wave variance inflation
 * 2. Post-Win Lifecycle (§9.8):
 *    - `proven` -> `browser_bridge` (max 14 days) -> `origin_baked` -> `verified_crawl_and_rum_fp` -> `browser_retired`
 * 3. Reverse Holdback Bundle (§9.8):
 *    - Shows previous version for max 56 days, designed in bundles of ~10 promotions to report bundle durability
 * 4. Weekly Fixed-Slot Promotion Scheduler (§9.8):
 *    - Batches routine promotions into 1 fixed weekly slot; delays promotions disrupting running confirmatory tests;
 *      ONLY harm-removal promotions execute immediately.
 */

import { drawUniformU } from '../allocator';
import type { ProvenPredicateResult } from '../../../packages/contract/response';
import {
  verifyRequiredFingerprintChanged,
  type OriginStandardOp,
  type PageFingerprintSnapshot,
} from './origin-adapter';

// =========================================================================
// 1. Stratified Page-Unit Randomized Rollout (>= 3 Waves, §9.9)
// =========================================================================

export const PAGE_ROLLOUT_MIN_WAVES = 3;
export const PAGE_ROLLOUT_MIN_PAIRS = 6;
export const MAX_BROWSER_BRIDGE_DAYS = 14;
export const MAX_REVERSE_HOLDBACK_DAYS = 56;
export const DEFAULT_REVERSE_HOLDBACK_BUNDLE_SIZE = 10;

export interface RolloutPageCandidate {
  readonly pageId: string;
  readonly template: string;
  readonly trafficBand: 'low' | 'mid' | 'high';
  readonly preTrendBand: 'down' | 'flat' | 'up';
}

export interface PageWaveAssignment {
  readonly pageId: string;
  readonly stratumKey: string;
  readonly waveIndex: number; // 1..numWaves
}

export interface PageRolloutPlan {
  readonly rolloutId: string;
  readonly numWaves: number;
  readonly assignments: readonly PageWaveAssignment[];
  readonly waveCounts: Readonly<Record<number, number>>;
  readonly strataCount: number;
}

/**
 * Calculates minimum required page pairs for +20% MDE under count noise & fake-wave variance (§9.9):
 * - 100 outcomes/page/period -> 10 pairs
 * -  25 outcomes/page/period -> 38 pairs
 * -   6 outcomes/page/period -> 160 pairs
 * Scaled by empirical fake-wave variance ratio (>= 1.0), never below 6 pairs.
 */
export function computeRequiredPagePairs(params: {
  readonly outcomesPerPagePerPeriod: number;
  readonly mdeRelative?: number; // default 0.20 (+20%)
  /** Ratio of empirical fake-wave variance to theoretical Poisson count variance (>= 1.0). */
  readonly placeboWaveVarianceInflation?: number;
}): {
  readonly theoreticalMinPairs: number;
  readonly requiredPairs: number;
  readonly placeboWaveVarianceInflation: number;
} {
  const mde = Math.max(0.01, params.mdeRelative ?? 0.2);
  const outcomes = Math.max(0.5, params.outcomesPerPagePerPeriod);
  const inflation = Math.max(1, params.placeboWaveVarianceInflation ?? 1);

  // Calibrated to §9.9 table at MDE=0.20: 100 -> 10, 25 -> 38, 6 -> 160 (approx 960 / outcomes * (0.2/mde)^2)
  const rawTheoretical = Math.ceil((950 / outcomes) * Math.pow(0.2 / mde, 2));
  const theoreticalMinPairs = Math.max(PAGE_ROLLOUT_MIN_PAIRS, rawTheoretical);
  const requiredPairs = Math.max(
    PAGE_ROLLOUT_MIN_PAIRS,
    Math.ceil(theoreticalMinPairs * inflation)
  );

  return {
    theoreticalMinPairs,
    requiredPairs,
    placeboWaveVarianceInflation: inflation,
  };
}

/**
 * Creates a stratified (`template × traffic × pre_trend`) randomized rollout plan across >= 3 waves.
 */
export function planStratifiedPageRollout(params: {
  readonly rolloutId: string;
  readonly secret: string;
  readonly pages: readonly RolloutPageCandidate[];
  readonly numWaves: number;
}): PageRolloutPlan {
  if (!Number.isInteger(params.numWaves) || params.numWaves < PAGE_ROLLOUT_MIN_WAVES) {
    throw new Error(
      `§9.9 Page-unit rollout requires at least ${PAGE_ROLLOUT_MIN_WAVES} waves (received ${params.numWaves})`
    );
  }

  const strataMap = new Map<string, RolloutPageCandidate[]>();
  for (const p of params.pages) {
    const key = `${p.template}|${p.trafficBand}|${p.preTrendBand}`;
    const arr = strataMap.get(key) ?? [];
    arr.push(p);
    strataMap.set(key, arr);
  }

  const assignments: PageWaveAssignment[] = [];
  const waveCounts: Record<number, number> = {};
  for (let w = 1; w <= params.numWaves; w++) waveCounts[w] = 0;

  // Deterministic permutation within each stratum, then round-robin wave assignment for balance
  for (const [stratumKey, members] of strataMap.entries()) {
    const ordered = [...members]
      .map((m) => ({
        page: m,
        u: drawUniformU(`${params.secret}:page_rollout:${params.rolloutId}:${stratumKey}`, m.pageId),
      }))
      .sort((a, b) => a.u - b.u);

    ordered.forEach((item, idx) => {
      const waveIndex = (idx % params.numWaves) + 1;
      assignments.push({
        pageId: item.page.pageId,
        stratumKey,
        waveIndex,
      });
      waveCounts[waveIndex] += 1;
    });
  }

  return {
    rolloutId: params.rolloutId,
    numWaves: params.numWaves,
    assignments,
    waveCounts,
    strataCount: strataMap.size,
  };
}

export interface PageRolloutVerdictInput {
  readonly numWaves: number;
  readonly observedPairs: number;
  readonly requiredPairs: number;
  readonly allocatorLoggedBeforeOutcomes: boolean;
  readonly preregLocked: boolean;
  readonly integrityStatus: 'pass' | 'unverified' | 'fail';
  readonly platformCanaryPassed: boolean;
  readonly durationDays: number;
  readonly randomizationPValue: number;
  readonly alpha?: number;
  readonly evaluatedAtIso: string;
}

export interface PageRolloutVerdictResult {
  readonly evidenceLevel: 'observed' | 'proven';
  readonly searchRankClaimPermitted: boolean;
  readonly predicate: ProvenPredicateResult | null;
  readonly unmetReasons: readonly string[];
}

/**
 * Evaluates whether a stratified >=3-wave page-unit rollout reaches `proven` (`page_randomised`)
 * — the ONLY valid path to claim causal search ranking lift (§9.9).
 */
export function evaluatePageRolloutVerdict(
  input: PageRolloutVerdictInput
): PageRolloutVerdictResult {
  const alpha = input.alpha ?? 0.05;
  const unmet: string[] = [];

  if (input.numWaves < PAGE_ROLLOUT_MIN_WAVES) unmet.push('fewer_than_3_waves');
  if (input.observedPairs < Math.max(PAGE_ROLLOUT_MIN_PAIRS, input.requiredPairs)) {
    unmet.push('insufficient_page_pairs');
  }
  if (!input.allocatorLoggedBeforeOutcomes) unmet.push('allocator_not_logged_before_outcomes');
  if (!input.preregLocked) unmet.push('prereg_not_locked');
  if (input.integrityStatus !== 'pass') unmet.push('integrity_not_pass');
  if (!input.platformCanaryPassed) unmet.push('platform_canary_failed');
  if (input.durationDays < 14) unmet.push('duration_lt_14d');
  if (input.randomizationPValue > alpha) unmet.push('randomization_p_exceeds_alpha');

  if (unmet.length > 0) {
    return {
      evidenceLevel: 'observed',
      searchRankClaimPermitted: false,
      predicate: null,
      unmetReasons: unmet,
    };
  }

  return {
    evidenceLevel: 'proven',
    searchRankClaimPermitted: true,
    predicate: {
      predicate: 'page_randomised',
      passed: true,
      allocator_logged_before_outcomes: true,
      prereg_locked: true,
      integrity_status: 'pass',
      decision_rule_passed: true,
      randomisation_audit_p: input.randomizationPValue,
      alpha,
      duration_days: input.durationDays,
      platform_canary_passed: true,
      evaluated_at: input.evaluatedAtIso,
    },
    unmetReasons: [],
  };
}

// =========================================================================
// 2. Post-Win Promotion Lifecycle (§9.8)
// =========================================================================

export type PromotionLifecycleStage =
  | 'proven'
  | 'browser_bridge'
  | 'origin_baked'
  | 'verified_crawl_and_rum_fp'
  | 'browser_retired';

export interface PostWinPromotionRecord {
  readonly promotionId: string;
  readonly opKind: OriginStandardOp;
  readonly stage: PromotionLifecycleStage;
  readonly browserBridgeStartedAtIso: string | null;
  readonly browserBridgeMaxDays: number;
  readonly originBakedAtIso: string | null;
  readonly crawlFpVerified: boolean;
  readonly rumFpVerified: boolean;
  readonly browserRetiredAtIso: string | null;
}

export class PostWinPromotionLifecycle {
  private record: PostWinPromotionRecord;

  constructor(params: {
    readonly promotionId: string;
    readonly opKind: OriginStandardOp;
    readonly guardrailsVerifiedOrNamedApprover: boolean;
  }) {
    if (!params.guardrailsVerifiedOrNamedApprover) {
      throw new Error(
        '§9.8: Post-win promotion requires proven verdict with verified guardrails or named human approver'
      );
    }
    this.record = {
      promotionId: params.promotionId,
      opKind: params.opKind,
      stage: 'proven',
      browserBridgeStartedAtIso: null,
      browserBridgeMaxDays: MAX_BROWSER_BRIDGE_DAYS,
      originBakedAtIso: null,
      crawlFpVerified: false,
      rumFpVerified: false,
      browserRetiredAtIso: null,
    };
  }

  getState(): PostWinPromotionRecord {
    return { ...this.record };
  }

  startBrowserBridge(nowIso: string): PostWinPromotionRecord {
    if (this.record.stage !== 'proven') {
      throw new Error(`Cannot start browser_bridge from stage "${this.record.stage}"`);
    }
    this.record = {
      ...this.record,
      stage: 'browser_bridge',
      browserBridgeStartedAtIso: nowIso,
    };
    return this.getState();
  }

  isBrowserBridgeExpired(nowIso: string): boolean {
    if (!this.record.browserBridgeStartedAtIso) return false;
    const elapsedDays =
      (Date.parse(nowIso) - Date.parse(this.record.browserBridgeStartedAtIso)) /
      86_400_000;
    return elapsedDays > MAX_BROWSER_BRIDGE_DAYS;
  }

  markOriginBaked(nowIso: string): PostWinPromotionRecord {
    if (this.record.stage !== 'browser_bridge' && this.record.stage !== 'proven') {
      throw new Error(`Cannot mark origin_baked from stage "${this.record.stage}"`);
    }
    if (this.record.stage === 'browser_bridge' && this.isBrowserBridgeExpired(nowIso)) {
      throw new Error(
        `§9.8: Browser bridge exceeded maximum ${MAX_BROWSER_BRIDGE_DAYS} days before origin bake`
      );
    }
    this.record = {
      ...this.record,
      stage: 'origin_baked',
      originBakedAtIso: nowIso,
    };
    return this.getState();
  }

  /**
   * Verifies BOTH CRAWL snapshot fingerprint AND real-visit (RUM) fingerprint changed
   * on the op-required fingerprint key before allowing browser patch retirement (§9.8 / §10.9).
   */
  verifyCrawlAndRumFingerprints(params: {
    readonly beforeFps: PageFingerprintSnapshot;
    readonly crawlAfterFps: PageFingerprintSnapshot;
    readonly rumAfterFps: PageFingerprintSnapshot;
  }): { readonly ok: boolean; readonly reason: string; readonly state: PostWinPromotionRecord } {
    if (this.record.stage !== 'origin_baked') {
      return {
        ok: false,
        reason: `invalid_stage(${this.record.stage})`,
        state: this.getState(),
      };
    }

    const crawlCheck = verifyRequiredFingerprintChanged(
      this.record.opKind,
      params.beforeFps,
      params.crawlAfterFps
    );
    const rumCheck = verifyRequiredFingerprintChanged(
      this.record.opKind,
      params.beforeFps,
      params.rumAfterFps
    );

    if (!crawlCheck.ok || !rumCheck.ok) {
      return {
        ok: false,
        reason: `fp_verification_failed(crawl=${crawlCheck.ok},rum=${rumCheck.ok})`,
        state: this.getState(),
      };
    }

    this.record = {
      ...this.record,
      stage: 'verified_crawl_and_rum_fp',
      crawlFpVerified: true,
      rumFpVerified: true,
    };
    return { ok: true, reason: 'both_crawl_and_rum_verified', state: this.getState() };
  }

  retireBrowserPatch(nowIso: string): PostWinPromotionRecord {
    if (this.record.stage !== 'verified_crawl_and_rum_fp') {
      throw new Error(
        `§9.8: Cannot retire browser patch before CRAWL & RUM fingerprint verification (current stage: ${this.record.stage})`
      );
    }
    this.record = {
      ...this.record,
      stage: 'browser_retired',
      browserRetiredAtIso: nowIso,
    };
    return this.getState();
  }
}

// =========================================================================
// 3. Reverse Holdback Bundle (Max 56d, ~10 Promotions per Bundle, §9.8)
// =========================================================================

export interface ReverseHoldbackMemberOutcome {
  readonly promotionId: string;
  readonly initialLift: number;
  readonly holdbackLift: number;
  readonly holdbackSe: number;
  readonly holdbackDurationDays: number;
}

export interface ReverseHoldbackBundleReport {
  readonly bundleId: string;
  readonly memberCount: number;
  readonly durationWithin56Days: boolean;
  readonly bundleMeanLift: number;
  readonly bundleSe: number;
  readonly bundleCiLower95: number;
  readonly bundleCiUpper95: number;
  readonly durabilityVerdict: 'sustained' | 'novelty_decayed' | 'inconclusive';
  readonly underbundledWarning: boolean;
}

export function evaluateReverseHoldbackBundle(
  bundleId: string,
  members: readonly ReverseHoldbackMemberOutcome[]
): ReverseHoldbackBundleReport {
  if (members.length === 0) {
    return {
      bundleId,
      memberCount: 0,
      durationWithin56Days: true,
      bundleMeanLift: 0,
      bundleSe: Number.POSITIVE_INFINITY,
      bundleCiLower95: Number.NEGATIVE_INFINITY,
      bundleCiUpper95: Number.POSITIVE_INFINITY,
      durabilityVerdict: 'inconclusive',
      underbundledWarning: true,
    };
  }

  const durationWithin56Days = members.every(
    (m) => m.holdbackDurationDays > 0 && m.holdbackDurationDays <= MAX_REVERSE_HOLDBACK_DAYS
  );
  const k = members.length;
  const meanInitial = members.reduce((s, m) => s + m.initialLift, 0) / k;
  const meanHoldback = members.reduce((s, m) => s + m.holdbackLift, 0) / k;
  const bundleSe = Math.sqrt(
    members.reduce((s, m) => s + m.holdbackSe * m.holdbackSe, 0) / (k * k)
  );
  const ciLo = meanHoldback - 1.959964 * bundleSe;
  const ciHi = meanHoldback + 1.959964 * bundleSe;

  let durabilityVerdict: 'sustained' | 'novelty_decayed' | 'inconclusive' = 'inconclusive';
  if (ciLo > 0 && meanHoldback >= 0.5 * meanInitial) {
    durabilityVerdict = 'sustained';
  } else if (meanInitial > 0 && ciHi < 0.25 * meanInitial) {
    durabilityVerdict = 'novelty_decayed';
  }

  return {
    bundleId,
    memberCount: k,
    durationWithin56Days,
    bundleMeanLift: meanHoldback,
    bundleSe,
    bundleCiLower95: ciLo,
    bundleCiUpper95: ciHi,
    durabilityVerdict,
    underbundledWarning: k < DEFAULT_REVERSE_HOLDBACK_BUNDLE_SIZE,
  };
}

// =========================================================================
// 4. Weekly Fixed-Slot Promotion Scheduler (§9.8)
// =========================================================================

export interface ScheduledPromotionCandidate {
  readonly promotionId: string;
  readonly pageIds: readonly string[];
  readonly isHarmRemoval: boolean;
  readonly overlappingConfirmatoryExperimentIds: readonly string[];
}

export interface PromotionScheduleDecision {
  readonly promotionId: string;
  readonly action: 'execute_immediately' | 'batch_to_weekly_window' | 'defer_for_running_experiment';
  readonly scheduledWindowIso: string;
  readonly reason: string;
}

/**
 * Schedules promotions per §9.8:
 * - Harm removal executes IMMEDIATELY (never waits for weekly batch or running tests).
 * - Routine promotions that disrupt active confirmatory experiments on the same pages are deferred.
 * - All other routine promotions are batched into the fixed weekly release window.
 */
export function schedulePromotionsWeekly(params: {
  readonly candidates: readonly ScheduledPromotionCandidate[];
  readonly nowIso: string;
  readonly nextWeeklyWindowIso: string;
}): readonly PromotionScheduleDecision[] {
  return params.candidates.map((c) => {
    if (c.isHarmRemoval) {
      return {
        promotionId: c.promotionId,
        action: 'execute_immediately',
        scheduledWindowIso: params.nowIso,
        reason: 'harm_removal_bypass_weekly_batch',
      };
    }

    if (c.overlappingConfirmatoryExperimentIds.length > 0) {
      return {
        promotionId: c.promotionId,
        action: 'defer_for_running_experiment',
        scheduledWindowIso: params.nextWeeklyWindowIso,
        reason: `deferred_active_confirmatory_experiments(${c.overlappingConfirmatoryExperimentIds.join(',')})`,
      };
    }

    return {
      promotionId: c.promotionId,
      action: 'batch_to_weekly_window',
      scheduledWindowIso: params.nextWeeklyWindowIso,
      reason: 'batched_into_weekly_fixed_window',
    };
  });
}
