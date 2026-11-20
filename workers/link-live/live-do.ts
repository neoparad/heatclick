/**
 * UGOKI LINK v2 — 30-Minute Edge Live Durable Object (`workers/link-live/live-do.ts`)
 *
 * Implements Master Spec §5.3, §11.11 opening lane separation, and §11.11 #1:
 * - Site-scoped 1-minute buckets × 30-minute sliding window (`WINDOW_MINUTES = 30`)
 * - Sub-20 ms p95 server-side query processing (`store.G-6`)
 * - Strict lane separation (`standard_telemetry` / `customer_events` / `visual_replay`)
 * - Dedicated `onboarding_verify` (`lab_token`) lane visible within <= 60 seconds
 *   and 100% excluded from human aggregates & billable PVs
 * - Unified `packages/contract/response` serialization (`buildResponseEnvelope`)
 */

import {
  buildResponseEnvelope,
  createDataLayerMetric,
  sha256Hex,
  type ActiveEvidenceRef,
  type MeasureInput,
  type SerializedResponseEnvelope,
  type VerifiedNumericLeaf,
} from '../../packages/contract/response';
import { CANONICAL_SCHEMA } from '../../packages/contract/schema';
import type { DataRegion } from '../link-wal';
import {
  InMemoryDurableObjectState,
  type DurableObjectStateLike,
  type LiveIngestEvent,
  type LiveMinuteBucketSnapshot,
  type LiveTrustLevel,
  type OnboardingVerifyStatus,
  type OnboardingVerifyVisitRecord,
  type TelemetryLane,
} from './types';

export const LIVE_WINDOW_MINUTES = 30;
export const MINUTE_MS = 60_000;
export const LIVE_WINDOW_MS = LIVE_WINDOW_MINUTES * MINUTE_MS;
export const ONBOARDING_VISIBILITY_SLA_MS = 60_000;
export const EDGE_LIVE_P95_BUDGET_MS = 20;

interface PvMinuteState {
  readonly pvId: string;
  readonly firstMinuteMs: number;
  liveWord: number;
  scrollMaxPx: number;
  visMs: number;
  billable: boolean;
  trust: LiveTrustLevel;
}

interface MinuteBucketInternal {
  readonly minuteStartMs: number;
  readonly standardPvIds: Set<string>;
  readonly standardBillablePvIds: Set<string>;
  readonly customerEventIds: Set<string>;
  readonly visualReplayIds: Set<string>;
  readonly labExcludedIds: Set<string>;
}

export interface SiteLiveDurableObjectConfig {
  readonly tenantId: string;
  readonly siteId: string;
  readonly storageRegion: DataRegion;
  readonly processingRegion?: string;
  readonly state?: DurableObjectStateLike;
}

export interface LiveIngestReceipt {
  readonly accepted: boolean;
  readonly routedTo: 'human_lane' | 'onboarding_verify_lane' | 'lab_lane' | 'rejected_scope';
  readonly lane: TelemetryLane;
  readonly minuteStartMs: number;
  readonly deduplicated: boolean;
  readonly excludedFromHumanTotals: boolean;
  readonly excludedFromBillablePvs: boolean;
  readonly reason?: string;
}

export interface LiveQueryOptions {
  readonly nowMs?: number;
  readonly laneFilter?: TelemetryLane;
  readonly includePerMinuteSeries?: boolean;
}

export interface LiveQueryOutput {
  readonly envelope: SerializedResponseEnvelope;
  readonly serverProcessingMs: number;
  readonly buckets: readonly LiveMinuteBucketSnapshot[];
}

function floorMinuteMs(tsMs: number): number {
  return Math.floor(tsMs / MINUTE_MS) * MINUTE_MS;
}

function isBillableTrust(trust: LiveTrustLevel): boolean {
  return (
    trust === 'edge_attested' ||
    trust === 'origin_attested' ||
    trust === 'continuity'
  );
}

function trustRank(trust: LiveTrustLevel): number {
  switch (trust) {
    case 'edge_attested':
      return 3;
    case 'origin_attested':
      return 2;
    case 'continuity':
      return 1;
    case 'none':
      return 0;
  }
}

function nowPerfMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export class SiteLiveDurableObject {
  public readonly tenantId: string;
  public readonly siteId: string;
  public readonly storageRegion: DataRegion;
  public readonly processingRegion: string;
  private readonly state: DurableObjectStateLike;

  private readonly buckets = new Map<number, MinuteBucketInternal>();
  private readonly pvStates = new Map<string, PvMinuteState>();
  private readonly onboardingVisits = new Map<string, OnboardingVerifyVisitRecord>();
  private readonly labVisits = new Map<string, { readonly observedAtMs: number; readonly purpose: string }>();
  private readonly queryLatenciesMs: number[] = [];
  private lastIngestAtMs = 0;

  public constructor(config: SiteLiveDurableObjectConfig) {
    this.tenantId = config.tenantId;
    this.siteId = config.siteId;
    this.storageRegion = config.storageRegion;
    this.processingRegion = config.processingRegion ?? config.storageRegion;
    this.state = config.state ?? new InMemoryDurableObjectState(
      `link-live:${config.storageRegion}:${config.tenantId}:${config.siteId}`
    );
  }

  private getOrCreateBucket(minuteStartMs: number): MinuteBucketInternal {
    let bucket = this.buckets.get(minuteStartMs);
    if (!bucket) {
      bucket = {
        minuteStartMs,
        standardPvIds: new Set<string>(),
        standardBillablePvIds: new Set<string>(),
        customerEventIds: new Set<string>(),
        visualReplayIds: new Set<string>(),
        labExcludedIds: new Set<string>(),
      };
      this.buckets.set(minuteStartMs, bucket);
    }
    return bucket;
  }

  /**
   * Prunes minute buckets and PV states older than the 30-minute sliding window.
   */
  public pruneExpired(nowMs: number): number {
    const cutoffMinuteMs = floorMinuteMs(nowMs) - (LIVE_WINDOW_MINUTES - 1) * MINUTE_MS;
    let prunedBuckets = 0;

    for (const [minMs, bucket] of this.buckets.entries()) {
      if (minMs < cutoffMinuteMs) {
        for (const pvId of bucket.standardPvIds) {
          const pv = this.pvStates.get(pvId);
          if (pv && pv.firstMinuteMs < cutoffMinuteMs) {
            this.pvStates.delete(pvId);
          }
        }
        this.buckets.delete(minMs);
        prunedBuckets += 1;
      }
    }

    for (const [k, v] of this.onboardingVisits.entries()) {
      if (v.observedAtMs < cutoffMinuteMs) {
        this.onboardingVisits.delete(k);
      }
    }
    for (const [k, v] of this.labVisits.entries()) {
      if (v.observedAtMs < cutoffMinuteMs) {
        this.labVisits.delete(k);
      }
    }

    return prunedBuckets;
  }

  /**
   * Ingests a live event from either the collector or WAL heal path (§5.3).
   * Enforces strict tenant/site/region isolation, lane separation, and 100%
   * exclusion of `lab_token` / `onboarding_verify` visits from human & billable counts.
   */
  public ingest(event: LiveIngestEvent, nowMs = event.receivedAtMs): LiveIngestReceipt {
    const minuteStartMs = floorMinuteMs(event.receivedAtMs);

    if (event.tenantId !== this.tenantId || event.siteId !== this.siteId) {
      return {
        accepted: false,
        routedTo: 'rejected_scope',
        lane: event.lane,
        minuteStartMs,
        deduplicated: false,
        excludedFromHumanTotals: true,
        excludedFromBillablePvs: true,
        reason: `Scope mismatch: DO serves (${this.tenantId}, ${this.siteId})`,
      };
    }

    if (event.storageRegion !== this.storageRegion) {
      return {
        accepted: false,
        routedTo: 'rejected_scope',
        lane: event.lane,
        minuteStartMs,
        deduplicated: false,
        excludedFromHumanTotals: true,
        excludedFromBillablePvs: true,
        reason: `Region mismatch (D-29): DO pinned to ${this.storageRegion}, got ${event.storageRegion}`,
      };
    }

    this.pruneExpired(Math.max(nowMs, event.receivedAtMs));
    this.lastIngestAtMs = Math.max(this.lastIngestAtMs, event.receivedAtMs);

    const bucket = this.getOrCreateBucket(minuteStartMs);

    // 1. Check for `lab_token` or `labRunId` -> 100% excluded from human aggregates & billing!
    const hasLabMarker = Boolean(event.labToken) || Boolean(event.labRunId);
    if (hasLabMarker) {
      const token = event.labToken;
      const isOnboarding = token?.purpose === 'onboarding_verify';
      const dedupeKey = `${token?.tokenId ?? event.labRunId ?? 'lab'}:${event.unitId}`;
      const alreadySeen = bucket.labExcludedIds.has(dedupeKey);
      bucket.labExcludedIds.add(dedupeKey);

      if (isOnboarding && token) {
        const occurredAtMs = event.occurredAtMs ?? event.receivedAtMs;
        const visibilityLatencyMs = Math.max(0, nowMs - occurredAtMs);
        const visitRecord: OnboardingVerifyVisitRecord = {
          tokenId: token.tokenId,
          runId: token.runId,
          tenantId: this.tenantId,
          siteId: this.siteId,
          unitId: event.unitId,
          lane: event.lane,
          consentMode: event.consentMode,
          occurredAtMs,
          observedAtMs: nowMs,
          visibilityLatencyMs,
          within60sSla: visibilityLatencyMs <= ONBOARDING_VISIBILITY_SLA_MS,
          excludedFromHumanTotals: true,
          excludedFromBillablePvs: true,
        };
        this.onboardingVisits.set(dedupeKey, visitRecord);
        return {
          accepted: true,
          routedTo: 'onboarding_verify_lane',
          lane: event.lane,
          minuteStartMs,
          deduplicated: alreadySeen,
          excludedFromHumanTotals: true,
          excludedFromBillablePvs: true,
        };
      }

      this.labVisits.set(dedupeKey, {
        observedAtMs: nowMs,
        purpose: token?.purpose ?? 'qa_instrument',
      });
      return {
        accepted: true,
        routedTo: 'lab_lane',
        lane: event.lane,
        minuteStartMs,
        deduplicated: alreadySeen,
        excludedFromHumanTotals: true,
        excludedFromBillablePvs: true,
      };
    }

    // 2. Reject `off` consent mode from human counts
    if (event.consentMode === 'off') {
      return {
        accepted: false,
        routedTo: 'rejected_scope',
        lane: event.lane,
        minuteStartMs,
        deduplicated: false,
        excludedFromHumanTotals: true,
        excludedFromBillablePvs: true,
        reason: 'consent_mode_off',
      };
    }

    // 3. Route strictly by lane (never mix lanes!)
    if (event.lane === 'standard_telemetry') {
      const existingPv = this.pvStates.get(event.unitId);
      const billableNow = isBillableTrust(event.trust) && !event.abuseHold;

      if (!existingPv) {
        const pvState: PvMinuteState = {
          pvId: event.unitId,
          firstMinuteMs: minuteStartMs,
          liveWord: (event.liveWord ?? 0) >>> 0,
          scrollMaxPx: Math.max(0, event.scrollMaxPx ?? 0),
          visMs: Math.max(0, event.visMs ?? 0),
          billable: billableNow,
          trust: event.trust,
        };
        this.pvStates.set(event.unitId, pvState);
        bucket.standardPvIds.add(event.unitId);
        if (billableNow) {
          bucket.standardBillablePvIds.add(event.unitId);
        }
        return {
          accepted: true,
          routedTo: 'human_lane',
          lane: event.lane,
          minuteStartMs,
          deduplicated: false,
          excludedFromHumanTotals: false,
          excludedFromBillablePvs: !billableNow,
        };
      }

      // Idempotent merge for repeated / WAL-healed updates to same PV
      existingPv.liveWord = (existingPv.liveWord | ((event.liveWord ?? 0) >>> 0)) >>> 0;
      if ((event.scrollMaxPx ?? 0) > existingPv.scrollMaxPx) {
        existingPv.scrollMaxPx = event.scrollMaxPx ?? 0;
      }
      if ((event.visMs ?? 0) > existingPv.visMs) {
        existingPv.visMs = event.visMs ?? 0;
      }
      if (trustRank(event.trust) > trustRank(existingPv.trust)) {
        existingPv.trust = event.trust;
      }
      if (!event.abuseHold && isBillableTrust(existingPv.trust) && !existingPv.billable) {
        existingPv.billable = true;
        const origBucket = this.buckets.get(existingPv.firstMinuteMs);
        origBucket?.standardBillablePvIds.add(event.unitId);
      }

      return {
        accepted: true,
        routedTo: 'human_lane',
        lane: event.lane,
        minuteStartMs: existingPv.firstMinuteMs,
        deduplicated: true,
        excludedFromHumanTotals: false,
        excludedFromBillablePvs: !existingPv.billable,
      };
    }

    if (event.lane === 'customer_events') {
      const seen = bucket.customerEventIds.has(event.unitId);
      bucket.customerEventIds.add(event.unitId);
      return {
        accepted: true,
        routedTo: 'human_lane',
        lane: event.lane,
        minuteStartMs,
        deduplicated: seen,
        excludedFromHumanTotals: false,
        excludedFromBillablePvs: true, // Only standard_telemetry counts toward billable PVs (§11.11)
      };
    }

    // visual_replay lane
    const seen = bucket.visualReplayIds.has(event.unitId);
    bucket.visualReplayIds.add(event.unitId);
    return {
      accepted: true,
      routedTo: 'human_lane',
      lane: event.lane,
      minuteStartMs,
      deduplicated: seen,
      excludedFromHumanTotals: false,
      excludedFromBillablePvs: true,
    };
  }

  /**
   * Returns onboarding verification status for §11.11 #1 (target visibility <= 60s).
   */
  public getOnboardingVerificationStatus(
    nowMs = Date.now(),
    tokenIdFilter?: string
  ): OnboardingVerifyStatus {
    this.pruneExpired(nowMs);
    const visits = Array.from(this.onboardingVisits.values())
      .filter((v) => !tokenIdFilter || v.tokenId === tokenIdFilter)
      .sort((a, b) => b.observedAtMs - a.observedAtMs);

    const latest = visits[0] ?? null;
    return {
      tenantId: this.tenantId,
      siteId: this.siteId,
      verified: visits.length > 0,
      within60sSla: latest !== null && latest.within60sSla,
      visitCount: visits.length,
      latestVisit: latest,
      visits,
    };
  }

  /**
   * Queries the 30-minute sliding window and serializes through `packages/contract/response`
   * (`buildResponseEnvelope`) with strict per-lane measures (never summing across lanes).
   */
  public queryLiveEnvelope(options: LiveQueryOptions = {}): LiveQueryOutput {
    const tStart = nowPerfMs();
    const nowMs = options.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    const endMinuteMs = floorMinuteMs(nowMs);
    const startMinuteMs = endMinuteMs - (LIVE_WINDOW_MINUTES - 1) * MINUTE_MS;

    const bucketSnapshots: LiveMinuteBucketSnapshot[] = [];
    let totalStandardPvs = 0;
    let totalBillablePvs = 0;
    let totalStandardVisMs = 0;
    let totalCustomerEvents = 0;
    let totalVisualReplays = 0;
    let totalLabExcluded = 0;

    for (let m = startMinuteMs; m <= endMinuteMs; m += MINUTE_MS) {
      const b = this.buckets.get(m);
      let bucketVisMs = 0;
      if (b) {
        for (const pvId of b.standardPvIds) {
          bucketVisMs += this.pvStates.get(pvId)?.visMs ?? 0;
        }
      }
      const stdCount = b?.standardPvIds.size ?? 0;
      const billCount = b?.standardBillablePvIds.size ?? 0;
      const custCount = b?.customerEventIds.size ?? 0;
      const replayCount = b?.visualReplayIds.size ?? 0;
      const labCount = b?.labExcludedIds.size ?? 0;

      totalStandardPvs += stdCount;
      totalBillablePvs += billCount;
      totalStandardVisMs += bucketVisMs;
      totalCustomerEvents += custCount;
      totalVisualReplays += replayCount;
      totalLabExcluded += labCount;

      bucketSnapshots.push({
        minuteStartMs: m,
        minuteIso: new Date(m).toISOString(),
        standardPvs: stdCount,
        standardBillablePvs: billCount,
        standardActiveSumVisMs: bucketVisMs,
        customerEventsCount: custCount,
        visualReplaysCount: replayCount,
        labExcludedCount: labCount,
      });
    }

    const windowStartIso = new Date(startMinuteMs).toISOString();
    const windowEndIso = new Date(nowMs).toISOString();
    const dataThroughIso =
      this.lastIngestAtMs > 0 ? new Date(this.lastIngestAtMs).toISOString() : windowEndIso;
    const lagSec =
      this.lastIngestAtMs > 0
        ? Math.max(0, Number(((nowMs - this.lastIngestAtMs) / 1000).toFixed(3)))
        : 0;

    const makeEvidenceRef = (measureKey: string, val: number): ActiveEvidenceRef => ({
      ref_id: `edge_live:${this.tenantId}:${this.siteId}:${measureKey}:${endMinuteMs}`,
      kind: 'query',
      params_hash: sha256Hex(`${this.tenantId}:${this.siteId}:${startMinuteMs}:${endMinuteMs}:${measureKey}`),
      watermarks: { edge_live_through: dataThroughIso },
      result_digest: sha256Hex(`${measureKey}:${val}`),
      issued_at: windowEndIso,
      valid_until: new Date(nowMs + MINUTE_MS).toISOString(),
      kid: `edge_live_${this.storageRegion}`,
    });

    const laneFilter = options.laneFilter;
    const measures: Record<string, MeasureInput<VerifiedNumericLeaf>> = {};

    if (!laneFilter || laneFilter === 'standard_telemetry') {
      const refStd = makeEvidenceRef('standard_live_pvs', totalStandardPvs);
      const refBill = makeEvidenceRef('standard_live_billable_pvs', totalBillablePvs);
      const refVis = makeEvidenceRef('standard_live_sum_vis_ms', totalStandardVisMs);

      measures.standard_live_pvs = {
        value: createDataLayerMetric(totalStandardPvs, refStd.ref_id, {
          createdAt: windowEndIso,
        }),
        unit: 'page_views',
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [refStd],
          scope: `site:${this.siteId}:lane:standard_telemetry`,
        },
        sample: { n: totalStandardPvs, unit_kind: 'page_view' },
        interval: null,
      };
      measures.standard_live_billable_pvs = {
        value: createDataLayerMetric(totalBillablePvs, refBill.ref_id, {
          createdAt: windowEndIso,
        }),
        unit: 'page_views',
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [refBill],
          scope: `site:${this.siteId}:lane:standard_telemetry`,
        },
        sample: { n: totalBillablePvs, unit_kind: 'page_view' },
        interval: null,
      };
      measures.standard_live_sum_vis_ms = {
        value: createDataLayerMetric(totalStandardVisMs, refVis.ref_id, {
          createdAt: windowEndIso,
        }),
        unit: 'ms',
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [refVis],
          scope: `site:${this.siteId}:lane:standard_telemetry`,
        },
        sample: { n: totalStandardPvs, unit_kind: 'page_view' },
        interval: null,
      };
    }

    if (!laneFilter || laneFilter === 'customer_events') {
      const refCust = makeEvidenceRef('customer_events_live_count', totalCustomerEvents);
      measures.customer_events_live_count = {
        value: createDataLayerMetric(totalCustomerEvents, refCust.ref_id, {
          createdAt: windowEndIso,
        }),
        unit: 'events',
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [refCust],
          scope: `site:${this.siteId}:lane:customer_events`,
        },
        sample: { n: totalCustomerEvents, unit_kind: 'event' },
        interval: null,
      };
    }

    if (!laneFilter || laneFilter === 'visual_replay') {
      const refRep = makeEvidenceRef('visual_replay_live_count', totalVisualReplays);
      measures.visual_replay_live_count = {
        value: createDataLayerMetric(totalVisualReplays, refRep.ref_id, {
          createdAt: windowEndIso,
        }),
        unit: 'replays',
        status: 'ok',
        evidence: {
          level: 'observed',
          exactness: 'exact',
          criteria: [],
          refs: [refRep],
          scope: `site:${this.siteId}:lane:visual_replay`,
        },
        sample: { n: totalVisualReplays, unit_kind: 'replay' },
        interval: null,
      };
    }

    const totalHumanDenominator =
      totalStandardPvs + totalCustomerEvents + totalVisualReplays;
    const excludedShare =
      totalHumanDenominator + totalLabExcluded === 0
        ? 0
        : totalLabExcluded / (totalHumanDenominator + totalLabExcluded);

    const envelope = buildResponseEnvelope({
      window: {
        start: windowStartIso,
        end: windowEndIso,
        timezone: 'UTC',
      },
      freshness: {
        data_through: dataThroughIso,
        lag_s: lagSec,
        sources: { edge_live: dataThroughIso },
        stale: lagSec > 120,
      },
      coverage: {
        ratio: 1,
        denominator_n: totalStandardPvs,
        excluded_share: excludedShare,
      },
      lineage: {
        schema_version: CANONICAL_SCHEMA.meta.schemaVersion,
        def_ver: 1,
        collection_gen: 'v3',
      },
      residency: {
        storage_region: this.storageRegion,
        processing_region: this.processingRegion,
      },
      quality: {
        source: 'edge_live',
        exactness: 'exact',
        lag_s: lagSec,
        collection_gen: 'v3',
      },
      measures,
      data: {
        window_minutes: LIVE_WINDOW_MINUTES,
        lane_separation_enforced: true,
        lab_excluded_events: totalLabExcluded,
        ...(options.includePerMinuteSeries !== false
          ? { per_minute: bucketSnapshots }
          : {}),
      },
    });

    const serverProcessingMs = Number((nowPerfMs() - tStart).toFixed(3));
    this.queryLatenciesMs.push(serverProcessingMs);
    if (this.queryLatenciesMs.length > 1000) {
      this.queryLatenciesMs.shift();
    }

    return {
      envelope,
      serverProcessingMs,
      buckets: bucketSnapshots,
    };
  }

  /**
   * Computes measured server-side p95 latency across recent queries (target <= 20 ms).
   */
  public getObservedQueryP95Ms(): number {
    if (this.queryLatenciesMs.length === 0) return 0;
    const sorted = [...this.queryLatenciesMs].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx] ?? 0;
  }

  /**
   * Persists compact bucket counts and onboarding records into Durable Object
   * storage for hibernation/eviction resilience.
   */
  public async checkpointToStorage(nowMs = Date.now()): Promise<void> {
    this.pruneExpired(nowMs);
    const snapshot = {
      tenantId: this.tenantId,
      siteId: this.siteId,
      storageRegion: this.storageRegion,
      lastIngestAtMs: this.lastIngestAtMs,
      buckets: Array.from(this.buckets.values()).map((b) => ({
        minuteStartMs: b.minuteStartMs,
        standardPvIds: Array.from(b.standardPvIds),
        standardBillablePvIds: Array.from(b.standardBillablePvIds),
        customerEventIds: Array.from(b.customerEventIds),
        visualReplayIds: Array.from(b.visualReplayIds),
        labExcludedIds: Array.from(b.labExcludedIds),
      })),
      pvStates: Array.from(this.pvStates.values()),
      onboardingVisits: Array.from(this.onboardingVisits.entries()),
    };
    await this.state.storage.put('live_checkpoint_v1', snapshot);
  }

  public async restoreFromStorage(): Promise<boolean> {
    const saved = await this.state.storage.get<{
      readonly lastIngestAtMs: number;
      readonly buckets: ReadonlyArray<{
        readonly minuteStartMs: number;
        readonly standardPvIds: readonly string[];
        readonly standardBillablePvIds: readonly string[];
        readonly customerEventIds: readonly string[];
        readonly visualReplayIds: readonly string[];
        readonly labExcludedIds: readonly string[];
      }>;
      readonly pvStates: readonly PvMinuteState[];
      readonly onboardingVisits: readonly [string, OnboardingVerifyVisitRecord][];
    }>('live_checkpoint_v1');

    if (!saved) return false;
    this.buckets.clear();
    this.pvStates.clear();
    this.onboardingVisits.clear();

    this.lastIngestAtMs = saved.lastIngestAtMs;
    for (const b of saved.buckets) {
      this.buckets.set(b.minuteStartMs, {
        minuteStartMs: b.minuteStartMs,
        standardPvIds: new Set(b.standardPvIds),
        standardBillablePvIds: new Set(b.standardBillablePvIds),
        customerEventIds: new Set(b.customerEventIds),
        visualReplayIds: new Set(b.visualReplayIds),
        labExcludedIds: new Set(b.labExcludedIds),
      });
    }
    for (const pv of saved.pvStates) {
      this.pvStates.set(pv.pvId, { ...pv });
    }
    for (const [k, v] of saved.onboardingVisits) {
      this.onboardingVisits.set(k, v);
    }
    return true;
  }
}
