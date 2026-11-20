/**
 * UGOKI LINK v2 — 4-Bit Holdout Cumulative Claims & Expiry Lifecycle (§9.8)
 *
 * Implements:
 * 1. Cumulative effect aggregation across the 4 independent holdout bits (`global`, `overlay`,
 *    `patch`, `recs`; default 5% each -> unheld-out share (0.95)^4 ≈ 81.45%; 26-week epoch rotation)
 *    connected directly to `lib/link/allocator`.
 * 2. Explicit 26-week statistical power limits (§9.8: ~24% MDE on 1 site, ~11% MDE across 5 sites;
 *    explicitly declares `holdoutAloneCompletesMeasurement: false`).
 * 3. Claim validity & automatic expiry (§9.8):
 *    - Extended while reverse holdback matches within validity window.
 *    - Auto-expires after 180 days OR when tested body fingerprint `body_fp` changes.
 *    - Upon expiry: preserves `evidenceLevel` (e.g., `proven`), unconditionally STRIPS
 *      `point_estimate` (`null`), and emits a `packages/contract/response`-validated envelope!
 */

import { getConstant } from '../../../packages/contract/ledgers';
import {
  buildResponseEnvelope,
  createDataLayerMetric,
  type ActiveEvidenceRef,
  type EvidenceLevel,
  type ProvenPredicateResult,
  type SerializedResponseEnvelope,
} from '../../../packages/contract/response';
import {
  HOLDOUT_BITS,
  computeHoldoutEpoch,
  type HoldoutBitName,
  type HoldoutBitsConfig,
} from '../allocator';

const holdoutShareConst = getConstant('ev.holdout_share_per_bit')?.value;
export const DEFAULT_HOLDOUT_SHARE_PER_BIT =
  typeof holdoutShareConst === 'number' ? holdoutShareConst : 0.05;

const holdoutEpochWeeksConst = getConstant('ev.holdout_epoch_weeks')?.value;
export const DEFAULT_HOLDOUT_EPOCH_WEEKS =
  typeof holdoutEpochWeeksConst === 'number' ? holdoutEpochWeeksConst : 26;

export const CLAIM_EXPIRY_DAYS = 180;

/** §9.8 baseline 26-week cumulative MDE reference at current traffic scale. */
export const HOLDOUT_26W_POWER_BASELINE = Object.freeze({
  singleSiteDetectableLiftPct: 24,
  fiveSiteDetectableLiftPct: 11,
  epochWeeks: DEFAULT_HOLDOUT_EPOCH_WEEKS,
  holdoutAloneCompletesMeasurement: false as const,
});

export interface HoldoutBitSliceStats {
  readonly bit: HoldoutBitName;
  readonly exposedUnits: number;
  readonly exposedConversions: number;
  readonly heldOutUnits: number;
  readonly heldOutConversions: number;
}

export interface HoldoutCumulativeReport {
  readonly epochId: number;
  readonly epochWeeks: number;
  readonly unheldOutShare: number; // (1 - 0.05)^4 ≈ 0.81450625
  readonly siteCount: number;
  readonly perBitEffects: Readonly<
    Record<
      HoldoutBitName,
      {
        readonly relativeLift: number;
        readonly standardError: number;
        readonly ciLower95: number;
        readonly ciUpper95: number;
        readonly detectableMde95: number;
      }
    >
  >;
  readonly powerLimitations: {
    readonly singleSite26wMdePct: number;
    readonly fiveSite26wMdePct: number;
    readonly observedSiteCount: number;
    readonly holdoutAloneCompletesMeasurement: false;
    readonly disclosure: string;
  };
}

/**
 * Computes cumulative effects across the 4 independent holdout bits (`global`, `overlay`, `patch`, `recs`)
 * with 26-week epoch metadata and explicit 1-site / 5-site statistical power limitations (§9.8).
 */
export function evaluateHoldoutCumulativeEffects(params: {
  readonly holdoutConfig: HoldoutBitsConfig;
  readonly nowMs: number;
  readonly siteCount: number;
  readonly slices: readonly HoldoutBitSliceStats[];
}): HoldoutCumulativeReport {
  const epochId = computeHoldoutEpoch(
    params.nowMs,
    params.holdoutConfig.epochOriginMs,
    params.holdoutConfig.epochWeeks
  );
  const unheldOutShare = Number(
    (
      (1 - params.holdoutConfig.global) *
      (1 - params.holdoutConfig.overlay) *
      (1 - params.holdoutConfig.patch) *
      (1 - params.holdoutConfig.recs)
    ).toFixed(6)
  );

  const byBit = new Map<HoldoutBitName, HoldoutBitSliceStats>();
  for (const s of params.slices) byBit.set(s.bit, s);

  const perBitEffects = {} as Record<
    HoldoutBitName,
    {
      readonly relativeLift: number;
      readonly standardError: number;
      readonly ciLower95: number;
      readonly ciUpper95: number;
      readonly detectableMde95: number;
    }
  >;

  for (const bit of HOLDOUT_BITS) {
    const s = byBit.get(bit);
    if (!s || s.exposedUnits <= 0 || s.heldOutUnits <= 0 || s.heldOutConversions <= 0) {
      perBitEffects[bit] = {
        relativeLift: 0,
        standardError: Number.POSITIVE_INFINITY,
        ciLower95: Number.NEGATIVE_INFINITY,
        ciUpper95: Number.POSITIVE_INFINITY,
        detectableMde95: Number.POSITIVE_INFINITY,
      };
      continue;
    }

    const pExp = s.exposedConversions / s.exposedUnits;
    const pHold = s.heldOutConversions / s.heldOutUnits;
    const relLift = (pExp - pHold) / Math.max(1e-9, pHold);
    const varExp = (pExp * (1 - pExp)) / s.exposedUnits;
    const varHold = (pHold * (1 - pHold)) / s.heldOutUnits;
    const absSe = Math.sqrt(varExp + varHold);
    const relSe = absSe / Math.max(1e-9, pHold);
    const z95 = 1.959964;
    // 80% power two-sided MDE = 2.8 * SE
    const mde80 = 2.8 * relSe;

    perBitEffects[bit] = {
      relativeLift: Number(relLift.toFixed(6)),
      standardError: Number(relSe.toFixed(6)),
      ciLower95: Number((relLift - z95 * relSe).toFixed(6)),
      ciUpper95: Number((relLift + z95 * relSe).toFixed(6)),
      detectableMde95: Number(mde80.toFixed(6)),
    };
  }

  return {
    epochId,
    epochWeeks: params.holdoutConfig.epochWeeks,
    unheldOutShare,
    siteCount: params.siteCount,
    perBitEffects,
    powerLimitations: {
      singleSite26wMdePct: HOLDOUT_26W_POWER_BASELINE.singleSiteDetectableLiftPct,
      fiveSite26wMdePct: HOLDOUT_26W_POWER_BASELINE.fiveSiteDetectableLiftPct,
      observedSiteCount: params.siteCount,
      holdoutAloneCompletesMeasurement: false,
      disclosure:
        '§9.8 Power Disclosure: At current scale, 26-week holdouts detect ~24% cumulative lift on 1 site and ~11% across 5 sites. Holdouts are a cumulative drift check and do not by themselves complete causal measurement.',
    },
  };
}

// =========================================================================
// 2. Claim Validity, 180-Day / body_fp Expiry & Point-Estimate Stripping (§9.8)
// =========================================================================

export interface RegisteredHoldoutClaim {
  readonly claimId: string;
  readonly interventionRef: ActiveEvidenceRef;
  readonly evidenceLevel: EvidenceLevel;
  readonly provenPredicate?: ProvenPredicateResult;
  readonly testedBodyFp: string;
  readonly establishedAtIso: string;
  readonly lastHoldbackVerifiedAtIso: string;
  readonly holdbackConsistent: boolean;
  readonly rawObservedLift: number;
  readonly ciLower95: number;
  readonly ciUpper95: number;
  readonly sampleN: number;
  readonly skepticalLowerBound: number;
  readonly plannedNReached: boolean;
  readonly guardrailsVerified: boolean;
  /** Projected point estimate (allowed ONLY when proven + valid + all §9.10 conditions met). */
  readonly projectedPointEstimate: number | null;
}

export interface EvaluatedHoldoutClaim {
  readonly claimId: string;
  /** Evidence level is PRESERVED even after expiry (§9.8). */
  readonly evidenceLevel: EvidenceLevel;
  readonly validity: 'valid' | 'expired';
  readonly validUntilIso: string;
  readonly expiryReasons: readonly string[];
  readonly pointEstimate: number | null;
  readonly pointEstimateStripped: boolean;
  readonly envelope: SerializedResponseEnvelope;
}

/**
 * Evaluates claim validity against BOTH the 180-day TTL and `body_fp` equality (§9.8),
 * preserving `evidenceLevel` upon expiry while unconditionally stripping `point_estimate`,
 * and returning a `packages/contract/response`-validated envelope.
 */
export function evaluateHoldoutClaimValidity(params: {
  readonly claim: RegisteredHoldoutClaim;
  readonly currentBodyFp: string;
  readonly nowIso: string;
  readonly storageRegion?: string;
  readonly processingRegion?: string;
}): EvaluatedHoldoutClaim {
  const { claim } = params;
  const expiryReasons: string[] = [];

  // Reference baseline: extended when reverse holdback is verified consistent, otherwise establishedAtIso
  const anchorIso = claim.holdbackConsistent
    ? claim.lastHoldbackVerifiedAtIso
    : claim.establishedAtIso;
  const anchorMs = Date.parse(anchorIso);
  const validUntilMs = anchorMs + CLAIM_EXPIRY_DAYS * 86_400_000;
  const validUntilIso = new Date(validUntilMs).toISOString();
  const nowMs = Date.parse(params.nowIso);

  if (nowMs >= validUntilMs) {
    expiryReasons.push('expired_180_day_ttl');
  }
  if (params.currentBodyFp !== claim.testedBodyFp) {
    expiryReasons.push(
      `tested_body_fp_changed(tested=${claim.testedBodyFp},current=${params.currentBodyFp})`
    );
  }

  const validity: 'valid' | 'expired' =
    expiryReasons.length === 0 ? 'valid' : 'expired';

  // §9.8 + §9.10: Point estimate is STRICTLY stripped on expiry OR when < proven OR §9.10 conditions unmet
  const allPointEstimateConditionsMet =
    validity === 'valid' &&
    claim.evidenceLevel === 'proven' &&
    claim.projectedPointEstimate !== null &&
    claim.skepticalLowerBound > 0 &&
    claim.plannedNReached &&
    claim.holdbackConsistent &&
    claim.guardrailsVerified;

  const finalPointEstimate = allPointEstimateConditionsMet
    ? claim.projectedPointEstimate
    : null;
  const pointEstimateStripped =
    claim.projectedPointEstimate !== null && finalPointEstimate === null;

  const measureValue = createDataLayerMetric(
    claim.rawObservedLift,
    claim.interventionRef.ref_id,
    { createdAt: params.nowIso }
  );

  const envelope = buildResponseEnvelope({
    window: {
      start: claim.establishedAtIso,
      end: params.nowIso,
    },
    freshness: {
      data_through: params.nowIso,
      lag_s: 0,
      sources: { holdout_claims: params.nowIso },
      stale: false,
    },
    coverage: {
      ratio: 1,
      denominator_n: claim.sampleN,
    },
    lineage: {
      schema_version: '2.0.0',
      def_ver: 1,
      collection_gen: 'v3',
    },
    residency: {
      storage_region: params.storageRegion ?? 'ap-northeast-1',
      processing_region: params.processingRegion ?? 'ap-northeast-1',
    },
    measures: {
      holdout_cumulative_lift: {
        value: measureValue,
        unit: 'relative_lift',
        status: 'ok',
        evidence: {
          level: claim.evidenceLevel, // Preserved even when validity === 'expired'!
          exactness: 'exact',
          criteria: claim.provenPredicate ? [claim.provenPredicate] : [],
          refs: [claim.interventionRef],
          validity,
          valid_until: validUntilIso,
          scope: `claim:${claim.claimId}`,
        },
        sample: { n: claim.sampleN, unit_kind: 'visitor' },
        interval: {
          level: 0.95,
          lower: claim.ciLower95,
          upper: claim.ciUpper95,
          method: 'holdout_wald',
        },
        ...(finalPointEstimate !== null
          ? {
              projection: {
                point_estimate: createDataLayerMetric(
                  finalPointEstimate,
                  claim.interventionRef.ref_id,
                  { createdAt: params.nowIso }
                ),
                point_estimate_conditions: {
                  skeptical_lower_bound: claim.skepticalLowerBound,
                  planned_n_reached: claim.plannedNReached,
                  holdback_confirmed: claim.holdbackConsistent,
                  guardrails_verified: claim.guardrailsVerified,
                },
              },
            }
          : {
              projection: {
                point_estimate: null,
              },
            }),
      },
    },
  });

  return {
    claimId: claim.claimId,
    evidenceLevel: claim.evidenceLevel,
    validity,
    validUntilIso,
    expiryReasons,
    pointEstimate: finalPointEstimate,
    pointEstimateStripped,
    envelope,
  };
}
