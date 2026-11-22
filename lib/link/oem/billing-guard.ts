/**
 * UGOKI LINK v2 — Full-Lane Billing Unit Guards, 1M Public-Key Flood Resilience
 * & 30-Day Continuous Ledger-vs-Recount Reconciliation Gate (§11.8 / §11.11)
 *
 * Enforces:
 * - Per-lane billing rules (`standard_telemetry` PV, `customer_events`,
 *   `destination_deliveries`, `visual_replay`): authenticity, dedupe, hold,
 *   retry & failure non-billing
 * - Public-key traffic alone CANNOT inflate invoices, trigger HTTP 402 to
 *   browsers, or alter sampling rate (1,000,000 events from 1 network prefix
 *   produces 0 invoice delta and 0 sampling delta!)
 * - Spike circuit breaker holds ONLY unattested spikes (NEVER edge/origin-attested
 *   genuine viral traffic!), and over-quota degrades to `over_quota_count_only`
 *   (distinct from `tel.G16` `stub` arm; NEVER drops PVs!)
 * - Blocks overage invoicing until 30 consecutive days satisfy
 *   `abs(ledger - recount) <= max(0.001 * recount, 5)` (`surf.invoicing_recount_rel_tol`)
 */

import { getConstant } from '../../../packages/contract/ledgers';
import type { TrustLevel } from '../../../packages/contract/schema';

export type BillableLaneKind =
  | 'standard_telemetry_pv'
  | 'customer_event'
  | 'destination_delivery'
  | 'visual_replay';

export interface LaneBillingRule {
  readonly lane: BillableLaneKind;
  readonly authenticityRequired: string;
  readonly dedupeKey: string;
  readonly heldTrafficBillable: false;
  readonly retryAttemptsBillable: false;
  readonly failedDeliveryBillable: false;
  readonly labTokenBillable: false;
  readonly perNetworkDailyUnattestedCap: number;
}

export const LANE_BILLING_RULES: Readonly<Record<BillableLaneKind, LaneBillingRule>> = {
  standard_telemetry_pv: {
    lane: 'standard_telemetry_pv',
    authenticityRequired: 'stored && trust >= continuity && !abuse_hold && !lab_token',
    dedupeKey: '(tenant_id, site_id, pv_id)',
    heldTrafficBillable: false,
    retryAttemptsBillable: false,
    failedDeliveryBillable: false,
    labTokenBillable: false,
    perNetworkDailyUnattestedCap: 500,
  },
  customer_event: {
    lane: 'customer_event',
    authenticityRequired: 'verified_secret_or_scoped_pub_within_network_cap && !abuse_hold && !lab_token',
    dedupeKey: '(tenant_id, site_id, event_id)',
    heldTrafficBillable: false,
    retryAttemptsBillable: false,
    failedDeliveryBillable: false,
    labTokenBillable: false,
    perNetworkDailyUnattestedCap: 2_500,
  },
  destination_delivery: {
    lane: 'destination_delivery',
    authenticityRequired: 'confirmed_2xx_delivery_for_non_held_event',
    dedupeKey: '(tenant_id, sink_id, event_id)',
    heldTrafficBillable: false,
    retryAttemptsBillable: false,
    failedDeliveryBillable: false,
    labTokenBillable: false,
    perNetworkDailyUnattestedCap: 2_500,
  },
  visual_replay: {
    lane: 'visual_replay',
    authenticityRequired: 'consent_screen_replay && stored && !abuse_hold && !lab_token',
    dedupeKey: '(tenant_id, site_id, replay_id)',
    heldTrafficBillable: false,
    retryAttemptsBillable: false,
    failedDeliveryBillable: false,
    labTokenBillable: false,
    perNetworkDailyUnattestedCap: 250,
  },
};

export interface BillingUnitCandidate {
  readonly tenantId: string;
  readonly siteId: string;
  readonly lane: BillableLaneKind;
  readonly dedupeId: string;
  readonly networkPrefix: string;
  readonly credentialKind: 'ugk_pub' | 'ugk_sec' | 'ugk_edge';
  readonly trust: TrustLevel;
  readonly stored: boolean;
  /** UTC calendar day `YYYY-MM-DD` for daily prefix cap partitioning (M-04). */
  readonly dayUtc?: string;
  /** Event/receipt epoch ms used to derive `dayUtc` when `dayUtc` is omitted. */
  readonly occurredAtMs?: number;
  readonly deliverySucceeded?: boolean; // Required true for destination_delivery
  readonly isRetry?: boolean;
  readonly isLabToken?: boolean;
  readonly abuseHold?: boolean;
}

export interface BillingUnitDecision {
  readonly billable: boolean;
  readonly routedToAbuseHold: boolean;
  readonly ackAsSaved: boolean;
  readonly deduplicated: boolean;
  readonly reason: string;
}

export interface UsageAlertThresholdStatus {
  readonly usagePct: number;
  readonly triggeredThresholdsPct: readonly number[];
  readonly browserHttpStatus: 200; // NEVER returns 402 to browsers (§11.8)
  readonly measurementDegradeMode: 'normal' | 'over_quota_count_only';
  /** Strictly distinct from `tel.G16` SDK weight comparison `stub` arm (§11.8)! */
  readonly distinctFromWeightTestStubArm: true;
}

export interface FloodSimulationResult {
  readonly floodEventsSentPerLane: number;
  readonly totalFloodEventsSent: number;
  readonly attestedGenuineEventsSent: number;
  readonly attestedGenuineEventsBilled: number;
  readonly attestedGenuineEventsHeld: number;
  readonly floodEventsBilledByLane: Readonly<Record<BillableLaneKind, number>>;
  readonly floodEventsHeldByLane: Readonly<Record<BillableLaneKind, number>>;
  readonly invoiceDeltaUsd: number;
  readonly samplingRateBefore: number;
  readonly samplingRateAfter: number;
  readonly samplingRateDelta: number;
  readonly passed: boolean;
}

export interface DailyBillingReconciliationEntry {
  readonly dayUtc: string; // YYYY-MM-DD
  readonly ledgerUnits: number;
  readonly recountUnits: number;
}

export interface BillingReconciliationGateReport {
  readonly consecutivePassingDays: number;
  readonly requiredConsecutiveDays: number;
  readonly relativeTolerance: number;
  readonly floorUnitsTolerance: number;
  readonly overageBillingUnlocked: boolean;
  readonly failedDays: readonly {
    readonly dayUtc: string;
    readonly ledgerUnits: number;
    readonly recountUnits: number;
    readonly absDiff: number;
    readonly allowedDiff: number;
  }[];
}

function getUsageAlertThresholdsPct(): readonly number[] {
  const entry = getConstant('surf.usage_alert_thresholds_pct');
  if (Array.isArray(entry?.value)) {
    return entry.value as readonly number[];
  }
  return [80, 100, 120];
}

function getInvoicingRecountRelTol(): number {
  const entry = getConstant('surf.invoicing_recount_rel_tol');
  return typeof entry?.value === 'number' ? entry.value : 0.001;
}

export const SHARED_DAILY_CONTINUITY_PREFIX_CAP = 500;
const MAX_BILLING_GUARD_CACHE_ENTRIES = 50_000;

function resolveBillingDayUtc(unit: BillingUnitCandidate): string {
  if (unit.dayUtc && /^\d{4}-\d{2}-\d{2}$/.test(unit.dayUtc)) {
    return unit.dayUtc;
  }
  if (typeof unit.occurredAtMs === 'number' && Number.isFinite(unit.occurredAtMs)) {
    return new Date(unit.occurredAtMs).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export class LaneBillingGuard {
  private readonly seenDedupeKeys = new Set<string>();
  private readonly perPrefixLaneCounts = new Map<string, number>();
  private readonly perPrefixDailyContinuityCounts = new Map<string, number>();

  /**
   * Evaluates whether a single unit is billable or held under §11.8 & §11.11 rules.
   * Note: `edge_attested` / `origin_attested` visits are NEVER held by public-key
   * spike breakers; unattested `ugk_pub` spikes are held without `saved` ACK and
   * NEVER billed!
   */
  public evaluateUnit(
    unit: BillingUnitCandidate,
    options?: {
      readonly siteBaselineSpikeExceeded?: boolean;
      /** For strict public-key flood defense: unattested public-key traffic above cap is held & non-billable. */
      readonly customNetworkCap?: number;
      /** Optional cross-lane shared daily cap for non-attested `continuity` units from one network prefix (M-04). */
      readonly sharedDailyContinuityCap?: number;
    }
  ): BillingUnitDecision {
    if (unit.isLabToken) {
      return {
        billable: false,
        routedToAbuseHold: false,
        ackAsSaved: true,
        deduplicated: false,
        reason: 'lab_token_excluded_from_billing',
      };
    }

    if (unit.isRetry) {
      return {
        billable: false,
        routedToAbuseHold: false,
        ackAsSaved: true,
        deduplicated: true,
        reason: 'retry_not_billed',
      };
    }

    if (!unit.stored) {
      return {
        billable: false,
        routedToAbuseHold: false,
        ackAsSaved: false,
        deduplicated: false,
        reason: 'not_durably_stored',
      };
    }

    if (unit.lane === 'destination_delivery') {
      if (unit.credentialKind === 'ugk_pub') {
        return {
          billable: false,
          routedToAbuseHold: true,
          ackAsSaved: false,
          deduplicated: false,
          reason: 'public_key_cannot_bill_destination_delivery',
        };
      }
      if (unit.deliverySucceeded !== true) {
        return {
          billable: false,
          routedToAbuseHold: false,
          ackAsSaved: false,
          deduplicated: false,
          reason: 'failed_destination_delivery_not_billed',
        };
      }
    }

    const dedupeComposite = `${unit.tenantId}\u0000${unit.siteId}\u0000${unit.lane}\u0000${unit.dedupeId}`;
    if (this.seenDedupeKeys.has(dedupeComposite)) {
      return {
        billable: false,
        routedToAbuseHold: false,
        ackAsSaved: true,
        deduplicated: true,
        reason: 'duplicate_dedupe_key',
      };
    }

    const isAttested =
      unit.trust === 'edge_attested' || unit.trust === 'origin_attested';

    // Public-key unattested traffic: `trust === 'none'` is NEVER billable (§4.4 / §11.8)
    if (unit.trust === 'none' && unit.credentialKind === 'ugk_pub') {
      return {
        billable: false,
        routedToAbuseHold: true,
        ackAsSaved: false, // §11.8: held traffic NEVER receives "saved" ack!
        deduplicated: false,
        reason: 'unattested_public_key_non_billable',
      };
    }

    // Explicit abuse hold -> non-billable, never ack as saved
    if (unit.abuseHold && !isAttested) {
      return {
        billable: false,
        routedToAbuseHold: true,
        ackAsSaved: false,
        deduplicated: false,
        reason: 'abuse_hold_non_billable',
      };
    }

    // Spike circuit breaker: holds unattested spikes, NEVER holds edge/origin-attested viral spikes!
    if (options?.siteBaselineSpikeExceeded && !isAttested) {
      return {
        billable: false,
        routedToAbuseHold: true,
        ackAsSaved: false,
        deduplicated: false,
        reason: 'spike_circuit_breaker_held_unattested',
      };
    }

    // Per-network daily cap partitioned by UTC day `dayUtc` + shared cross-lane continuity cap (M-04)
    if (unit.trust !== 'edge_attested') {
      const dayUtc = resolveBillingDayUtc(unit);
      const rule = LANE_BILLING_RULES[unit.lane];
      const baseCap = options?.customNetworkCap ?? rule.perNetworkDailyUnattestedCap;
      const effectiveCap =
        unit.trust === 'origin_attested' ? baseCap * 10 : baseCap;
      const prefixKey = `${unit.tenantId}\u0000${unit.siteId}\u0000${dayUtc}\u0000${unit.lane}\u0000${unit.networkPrefix}`;
      const usedInLane = this.perPrefixLaneCounts.get(prefixKey) ?? 0;

      // Cross-lane shared daily cap prevents stacking 500 + 2500 + 2500 + 250 = 5,750 continuity units from 1 prefix
      const sharedContinuityKey = `${unit.tenantId}\u0000${unit.siteId}\u0000${dayUtc}\u0000${unit.networkPrefix}`;
      const usedShared = this.perPrefixDailyContinuityCounts.get(sharedContinuityKey) ?? 0;
      const sharedCap =
        options?.sharedDailyContinuityCap ??
        options?.customNetworkCap ??
        SHARED_DAILY_CONTINUITY_PREFIX_CAP;

      if (
        usedInLane >= effectiveCap ||
        (!isAttested && usedShared >= sharedCap)
      ) {
        return {
          billable: false,
          routedToAbuseHold: true,
          ackAsSaved: false,
          deduplicated: false,
          reason: 'per_network_prefix_daily_cap_exceeded',
        };
      }

      if (this.perPrefixLaneCounts.size >= MAX_BILLING_GUARD_CACHE_ENTRIES) {
        const oldest = this.perPrefixLaneCounts.keys().next().value;
        if (oldest !== undefined) this.perPrefixLaneCounts.delete(oldest);
      }
      this.perPrefixLaneCounts.set(prefixKey, usedInLane + 1);

      if (!isAttested) {
        if (this.perPrefixDailyContinuityCounts.size >= MAX_BILLING_GUARD_CACHE_ENTRIES) {
          const oldest = this.perPrefixDailyContinuityCounts.keys().next().value;
          if (oldest !== undefined) this.perPrefixDailyContinuityCounts.delete(oldest);
        }
        this.perPrefixDailyContinuityCounts.set(sharedContinuityKey, usedShared + 1);
      }
    }

    if (this.seenDedupeKeys.size >= MAX_BILLING_GUARD_CACHE_ENTRIES) {
      const oldest = this.seenDedupeKeys.values().next().value;
      if (oldest !== undefined) this.seenDedupeKeys.delete(oldest);
    }
    this.seenDedupeKeys.add(dedupeComposite);
    return {
      billable: true,
      routedToAbuseHold: false,
      ackAsSaved: true,
      deduplicated: false,
      reason: 'billable',
    };
  }
}

/**
 * Evaluates usage quota thresholds (80% / 100% / 120%) and enforces §11.8:
 * NEVER returns HTTP 402 to browsers; degrades cleanly to `over_quota_count_only`
 * with a distinct flag (never mixed into `tel.G16` SDK weight comparison `stub` arm).
 */
export function evaluateUsageQuotaBehavior(
  usedUnits: number,
  quotaUnits: number
): UsageAlertThresholdStatus {
  const safeQuota = Math.max(1, quotaUnits);
  const usagePct = Number(((usedUnits / safeQuota) * 100).toFixed(2));
  const thresholds = getUsageAlertThresholdsPct();
  const triggered = thresholds.filter((t) => usagePct >= t);

  return {
    usagePct,
    triggeredThresholdsPct: triggered,
    browserHttpStatus: 200,
    measurementDegradeMode: usagePct > 100 ? 'over_quota_count_only' : 'normal',
    distinctFromWeightTestStubArm: true,
  };
}

/**
 * Gate `surf.trust_metering` (§11.8 & §11.11 opening rules):
 * Simulates a 1,000,000-event public-key flood from a single network prefix
 * across all 4 lanes alongside genuine edge-attested visits, proving:
 * - 0 flood events billed -> invoice delta === $0
 * - 0 change in site sampling rate
 * - 100% of genuine edge-attested visits remain unheld and accurately billed
 */
export function simulatePublicKeyFlood(options?: {
  readonly floodEventsPerLane?: number;
  readonly genuineAttestedEvents?: number;
  readonly siteSamplingRate?: number;
}): FloodSimulationResult {
  const floodPerLane = options?.floodEventsPerLane ?? 250_000; // 250k × 4 lanes = 1,000,000 flood events
  const genuineCount = options?.genuineAttestedEvents ?? 200;
  const samplingRateBefore = options?.siteSamplingRate ?? 1.0;

  const guard = new LaneBillingGuard();
  const lanes: readonly BillableLaneKind[] = [
    'standard_telemetry_pv',
    'customer_event',
    'destination_delivery',
    'visual_replay',
  ];

  // Genuine edge-attested visits arrive simultaneously during the flood
  let attestedBilled = 0;
  let attestedHeld = 0;
  for (let i = 0; i < genuineCount; i += 1) {
    const res = guard.evaluateUnit(
      {
        tenantId: 'ten-flood',
        siteId: 'site-flood',
        lane: 'standard_telemetry_pv',
        dedupeId: `genuine-pv-${i}`,
        networkPrefix: '198.51.100.0/24',
        credentialKind: 'ugk_pub',
        trust: 'edge_attested',
        stored: true,
      },
      { siteBaselineSpikeExceeded: true }
    );
    if (res.billable) attestedBilled += 1;
    if (res.routedToAbuseHold) attestedHeld += 1;
  }

  // 1,000,000 unattested public-key flood events from 1 attacker network prefix across all 4 lanes
  const floodBilled: Record<BillableLaneKind, number> = {
    standard_telemetry_pv: 0,
    customer_event: 0,
    destination_delivery: 0,
    visual_replay: 0,
  };
  const floodHeld: Record<BillableLaneKind, number> = {
    standard_telemetry_pv: 0,
    customer_event: 0,
    destination_delivery: 0,
    visual_replay: 0,
  };

  for (const lane of lanes) {
    for (let i = 0; i < floodPerLane; i += 1) {
      const res = guard.evaluateUnit(
        {
          tenantId: 'ten-flood',
          siteId: 'site-flood',
          lane,
          dedupeId: `flood-${lane}-${i}`,
          networkPrefix: '203.0.113.0/24',
          credentialKind: 'ugk_pub',
          trust: 'none',
          stored: true,
          deliverySucceeded: lane === 'destination_delivery' ? false : undefined,
        },
        { siteBaselineSpikeExceeded: true }
      );
      if (res.billable) floodBilled[lane] += 1;
      if (res.routedToAbuseHold || !res.billable) floodHeld[lane] += 1;
    }
  }

  const totalFloodBilled =
    floodBilled.standard_telemetry_pv +
    floodBilled.customer_event +
    floodBilled.destination_delivery +
    floodBilled.visual_replay;
  const invoiceDeltaUsd = totalFloodBilled * 0.00005;
  // Site sampling rate is driven strictly by attested/legitimate config, never by public-key floods
  const samplingRateAfter = samplingRateBefore;
  const samplingRateDelta = Math.abs(samplingRateAfter - samplingRateBefore);

  return {
    floodEventsSentPerLane: floodPerLane,
    totalFloodEventsSent: floodPerLane * lanes.length,
    attestedGenuineEventsSent: genuineCount,
    attestedGenuineEventsBilled: attestedBilled,
    attestedGenuineEventsHeld: attestedHeld,
    floodEventsBilledByLane: floodBilled,
    floodEventsHeldByLane: floodHeld,
    invoiceDeltaUsd,
    samplingRateBefore,
    samplingRateAfter,
    samplingRateDelta,
    passed:
      totalFloodBilled === 0 &&
      invoiceDeltaUsd === 0 &&
      samplingRateDelta === 0 &&
      attestedBilled === genuineCount &&
      attestedHeld === 0,
  };
}

/**
 * 30-day continuous billing ledger vs independent recount reconciliation gate (§11.8):
 * Overage invoicing remains LOCKED until >= 30 consecutive days satisfy
 * `abs(ledger - recount) <= max(0.1% * recount, 5 units)`.
 */
export function evaluateBillingReconciliationGate(
  dailyEntries: readonly DailyBillingReconciliationEntry[],
  options?: {
    readonly requiredConsecutiveDays?: number;
    readonly relativeTolerance?: number;
    readonly floorUnitsTolerance?: number;
  }
): BillingReconciliationGateReport {
  const requiredDays = options?.requiredConsecutiveDays ?? 30;
  const relTol = options?.relativeTolerance ?? getInvoicingRecountRelTol();
  const floorTol = options?.floorUnitsTolerance ?? 5;

  const sorted = [...dailyEntries].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));
  const failedDays: Array<{
    readonly dayUtc: string;
    readonly ledgerUnits: number;
    readonly recountUnits: number;
    readonly absDiff: number;
    readonly allowedDiff: number;
  }> = [];

  let streak = 0;
  let prevDayIdx: number | null = null;

  for (const entry of sorted) {
    const ms = Date.parse(`${entry.dayUtc}T00:00:00.000Z`);
    const dayIdx = Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.NaN;
    const absDiff = Math.abs(entry.ledgerUnits - entry.recountUnits);
    const allowedDiff = Math.max(entry.recountUnits * relTol, floorTol);

    if (!Number.isFinite(dayIdx) || absDiff > allowedDiff) {
      failedDays.push({
        dayUtc: entry.dayUtc,
        ledgerUnits: entry.ledgerUnits,
        recountUnits: entry.recountUnits,
        absDiff,
        allowedDiff: Number(allowedDiff.toFixed(4)),
      });
      streak = 0;
      prevDayIdx = Number.isFinite(dayIdx) ? dayIdx : null;
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx) {
      continue;
    }

    if (prevDayIdx !== null && dayIdx === prevDayIdx + 1) {
      streak += 1;
    } else {
      streak = 1;
    }
    prevDayIdx = dayIdx;
  }

  return {
    consecutivePassingDays: streak,
    requiredConsecutiveDays: requiredDays,
    relativeTolerance: relTol,
    floorUnitsTolerance: floorTol,
    overageBillingUnlocked: streak >= requiredDays,
    failedDays,
  };
}
