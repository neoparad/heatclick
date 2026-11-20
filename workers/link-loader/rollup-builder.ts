/**
 * UGOKI LINK v2 — 1-Hour Sealed Rollup Builder & "Today" Seam Composition
 *
 * Replaces insert-time Materialized Views (`[ch 2, 4]`) with immutable
 * `build_seq`-versioned 1-hour rollups:
 * - Seals `(tenant_id, site_id, pv_hour)` once `hourEnd + 30 min <= now`
 * - Rebuilds any `dirty_cell` (late frame, deletion, alias update) under a new
 *   monotonically increasing `build_seq` and atomically flips `rollup_manifest`
 * - Composes "Today" queries from sealed rollups (`pv_hour < seam`) + exact
 *   unsealed tail (`pv_hour >= seam`), refusing with `insufficient_data`
 *   (`unmet_gates: ['builder_lag']`) whenever unsealed tail lag exceeds 120 min
 */

import { makeCellCompositeKey, type ShardLoader } from './loader';
import { floorUtcHourMs } from './merger';
import type {
  MergedPvState,
  PageHourRollupRow,
  RollupManifestEntry,
  RollupMetrics,
  SiteHourRollupRow,
  TodayQueryResult,
} from './types';

export const HOUR_MS = 3_600_000;
export const DEFAULT_SEAL_DELAY_MS = 30 * 60 * 1000; // 30 minutes past hour end
export const MAX_UNSEALED_TAIL_LAG_MS = 120 * 60 * 1000; // 120 minutes hard ceiling (store-final M3)
export const ENGAGED_VIS_THRESHOLD_MS = 10_000; // 10s visible dwell or >=1 event

export interface SealRunResult {
  readonly sealedCells: readonly RollupManifestEntry[];
  readonly rebuiltDirtyCells: number;
  readonly skippedIneligibleCells: number;
  readonly highestBuildSeq: number;
}

function createEmptyMetrics(): {
  pvCount: number;
  sumScrollMaxPx: number;
  sumVisMs: number;
  engagedPvCount: number;
  eventCount: number;
  sumReversals: number;
  lcpCount: number;
  lcpSumMs: number;
} {
  return {
    pvCount: 0,
    sumScrollMaxPx: 0,
    sumVisMs: 0,
    engagedPvCount: 0,
    eventCount: 0,
    sumReversals: 0,
    lcpCount: 0,
    lcpSumMs: 0,
  };
}

function addPvStateToMetrics(
  acc: ReturnType<typeof createEmptyMetrics>,
  pv: MergedPvState
): void {
  acc.pvCount += 1;
  acc.sumScrollMaxPx += pv.scrollMaxPx;
  acc.sumVisMs += pv.visMs;
  if (pv.visMs >= ENGAGED_VIS_THRESHOLD_MS || pv.events.size > 0) {
    acc.engagedPvCount += 1;
  }
  acc.eventCount += pv.events.size;
  acc.sumReversals += pv.reversals;
  if (pv.vitals.lcp_ms !== null) {
    acc.lcpCount += 1;
    acc.lcpSumMs += pv.vitals.lcp_ms.value;
  }
}

function addMetrics(
  acc: ReturnType<typeof createEmptyMetrics>,
  m: RollupMetrics
): void {
  acc.pvCount += m.pvCount;
  acc.sumScrollMaxPx += m.sumScrollMaxPx;
  acc.sumVisMs += m.sumVisMs;
  acc.engagedPvCount += m.engagedPvCount;
  acc.eventCount += m.eventCount;
  acc.sumReversals += m.sumReversals;
  acc.lcpCount += m.lcpCount;
  acc.lcpSumMs += m.lcpSumMs;
}

function makeVersionedKey(cellKey: string, buildSeq: number): string {
  return `${cellKey}\u0000${buildSeq}`;
}

export class SealedRollupBuilder {
  private buildSeqCounter = 0;
  private readonly manifest = new Map<string, RollupManifestEntry>();
  private readonly siteHourHistory = new Map<string, SiteHourRollupRow>();
  private readonly pageHourHistory = new Map<string, readonly PageHourRollupRow[]>();
  private readonly sealDelayMs: number;
  private readonly maxUnsealedTailLagMs: number;

  public constructor(options?: {
    readonly sealDelayMs?: number;
    readonly maxUnsealedTailLagMs?: number;
  }) {
    this.sealDelayMs = options?.sealDelayMs ?? DEFAULT_SEAL_DELAY_MS;
    this.maxUnsealedTailLagMs =
      options?.maxUnsealedTailLagMs ?? MAX_UNSEALED_TAIL_LAG_MS;
  }

  /**
   * Seals every eligible unsealed hour (`pvHourMs + 1h + 30m <= nowMs`) and
   * rebuilds any dirty cells (late frames, deletions, alias changes) under a
   * fresh monotonic `build_seq`, atomically switching `rollup_manifest`.
   */
  public sealEligibleHours(
    loader: ShardLoader,
    nowMs = Date.now(),
    options?: { readonly forceSealAll?: boolean }
  ): SealRunResult {
    const forceSealAll = options?.forceSealAll ?? false;

    // Group all live PV states by (tenantId, siteId, pvHourMs)
    const pvsByCell = new Map<
      string,
      { tenantId: string; siteId: string; pvHourMs: number; pvs: MergedPvState[] }
    >();

    for (const pv of loader.getAllPvStates()) {
      const ck = makeCellCompositeKey(
        pv.placement.tenantId,
        pv.placement.siteId,
        pv.placement.pvHourMs
      );
      let bucket = pvsByCell.get(ck);
      if (!bucket) {
        bucket = {
          tenantId: pv.placement.tenantId,
          siteId: pv.placement.siteId,
          pvHourMs: pv.placement.pvHourMs,
          pvs: [],
        };
        pvsByCell.set(ck, bucket);
      }
      bucket.pvs.push(pv);
    }

    // Ensure dirty cells whose PVs were completely deleted are still rebuilt to zero!
    const dirtyMap = new Map<string, { tenantId: string; siteId: string; pvHourMs: number }>();
    for (const dc of loader.getDirtyCells()) {
      const ck = makeCellCompositeKey(dc.tenantId, dc.siteId, dc.pvHourMs);
      dirtyMap.set(ck, {
        tenantId: dc.tenantId,
        siteId: dc.siteId,
        pvHourMs: dc.pvHourMs,
      });
      if (!pvsByCell.has(ck)) {
        pvsByCell.set(ck, {
          tenantId: dc.tenantId,
          siteId: dc.siteId,
          pvHourMs: dc.pvHourMs,
          pvs: [],
        });
      }
    }

    const sealedCells: RollupManifestEntry[] = [];
    let rebuiltDirtyCells = 0;
    let skippedIneligibleCells = 0;

    // Sort deterministically by (tenantId, siteId, pvHourMs)
    const sortedEntries = Array.from(pvsByCell.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    for (const [cellKey, cellData] of sortedEntries) {
      const existingManifest = this.manifest.get(cellKey);
      const isDirty = dirtyMap.has(cellKey);
      const eligible =
        forceSealAll || cellData.pvHourMs + HOUR_MS + this.sealDelayMs <= nowMs;

      if (!eligible) {
        skippedIneligibleCells += 1;
        continue;
      }

      if (existingManifest && !isDirty && existingManifest.state === 'valid') {
        continue;
      }

      const wasPreviouslySealed = existingManifest !== undefined;
      const nextBuildSeq = (this.buildSeqCounter += 1);

      const siteAcc = createEmptyMetrics();
      const byUrl = new Map<string, ReturnType<typeof createEmptyMetrics>>();

      for (const pv of cellData.pvs) {
        addPvStateToMetrics(siteAcc, pv);
        let urlAcc = byUrl.get(pv.placement.urlId);
        if (!urlAcc) {
          urlAcc = createEmptyMetrics();
          byUrl.set(pv.placement.urlId, urlAcc);
        }
        addPvStateToMetrics(urlAcc, pv);
      }

      const pageRows: PageHourRollupRow[] = Array.from(byUrl.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([urlId, m]) => ({
          tenantId: cellData.tenantId,
          siteId: cellData.siteId,
          pvHourMs: cellData.pvHourMs,
          urlId,
          buildSeq: nextBuildSeq,
          ...m,
        }));

      const siteRow: SiteHourRollupRow = {
        tenantId: cellData.tenantId,
        siteId: cellData.siteId,
        pvHourMs: cellData.pvHourMs,
        buildSeq: nextBuildSeq,
        distinctUrlCount: pageRows.length,
        ...siteAcc,
      };

      // Write immutable versioned rollup rows FIRST, then switch manifest pointer atomically
      const verKey = makeVersionedKey(cellKey, nextBuildSeq);
      this.siteHourHistory.set(verKey, siteRow);
      this.pageHourHistory.set(verKey, pageRows);

      const manifestEntry: RollupManifestEntry = {
        tenantId: cellData.tenantId,
        siteId: cellData.siteId,
        pvHourMs: cellData.pvHourMs,
        currentBuildSeq: nextBuildSeq,
        sealedAtMs: nowMs,
        sourcePvCount: siteRow.pvCount,
        sourceEventCount: siteRow.eventCount,
        state: 'valid',
      };
      this.manifest.set(cellKey, manifestEntry);
      loader.clearDirtyCell(cellData.tenantId, cellData.siteId, cellData.pvHourMs);

      sealedCells.push(manifestEntry);
      if (wasPreviouslySealed && isDirty) {
        rebuiltDirtyCells += 1;
      }
    }

    return {
      sealedCells,
      rebuiltDirtyCells,
      skippedIneligibleCells,
      highestBuildSeq: this.buildSeqCounter,
    };
  }

  /**
   * Returns current sealed `SiteHourRollupRow` via the active `rollup_manifest` pointer.
   */
  public getCurrentSiteHourRollup(
    tenantId: string,
    siteId: string,
    pvHourMs: number
  ): SiteHourRollupRow | undefined {
    const ck = makeCellCompositeKey(tenantId, siteId, pvHourMs);
    const entry = this.manifest.get(ck);
    if (!entry || entry.state !== 'valid') return undefined;
    return this.siteHourHistory.get(makeVersionedKey(ck, entry.currentBuildSeq));
  }

  /**
   * Returns current sealed `PageHourRollupRow[]` via the active `rollup_manifest` pointer.
   */
  public getCurrentPageHourRollups(
    tenantId: string,
    siteId: string,
    pvHourMs: number
  ): readonly PageHourRollupRow[] {
    const ck = makeCellCompositeKey(tenantId, siteId, pvHourMs);
    const entry = this.manifest.get(ck);
    if (!entry || entry.state !== 'valid') return [];
    return this.pageHourHistory.get(makeVersionedKey(ck, entry.currentBuildSeq)) ?? [];
  }

  public getManifestEntry(
    tenantId: string,
    siteId: string,
    pvHourMs: number
  ): RollupManifestEntry | undefined {
    return this.manifest.get(makeCellCompositeKey(tenantId, siteId, pvHourMs));
  }

  public getAllManifestEntries(): readonly RollupManifestEntry[] {
    return Array.from(this.manifest.values()).sort((a, b) => {
      if (a.tenantId !== b.tenantId) return a.tenantId.localeCompare(b.tenantId);
      if (a.siteId !== b.siteId) return a.siteId.localeCompare(b.siteId);
      return a.pvHourMs - b.pvHourMs;
    });
  }

  public getSealedCellKeySet(): Set<string> {
    const out = new Set<string>();
    for (const [k, v] of this.manifest.entries()) {
      if (v.state === 'valid') out.add(k);
    }
    return out;
  }

  /**
   * Marks a sealed cell as `invalid` when independent reconciliation detects
   * a persistent discrepancy (`store.M13` / §5.9).
   */
  public markCellInvalid(
    tenantId: string,
    siteId: string,
    pvHourMs: number
  ): boolean {
    const ck = makeCellCompositeKey(tenantId, siteId, pvHourMs);
    const entry = this.manifest.get(ck);
    if (!entry) return false;
    this.manifest.set(ck, { ...entry, state: 'invalid' });
    return true;
  }

  /**
   * "Today" seam composition (`store-final.md` M3):
   * - Reads immutable sealed 1-hour cells (`pv_hour < seamHourMs`)
   * - Reads exact unsealed tail (`pv_hour >= seamHourMs` and `pv_hour <= currentHourMs`)
   *   directly from `page_view_state`
   * - If unsealed tail span exceeds 120 minutes (`maxUnsealedTailLagMs`), refuses
   *   with `status: 'insufficient_data'` and `unmet_gates: ['builder_lag']`
   *   (never emits degraded or synthetic numbers).
   */
  public queryTodayWithSeam(
    loader: ShardLoader,
    args: {
      readonly tenantId: string;
      readonly siteId: string;
      readonly windowStartMs: number;
      readonly nowMs: number;
    }
  ): TodayQueryResult {
    const startHourMs = floorUtcHourMs(args.windowStartMs);
    const currentHourMs = floorUtcHourMs(args.nowMs);

    let seamHourMs = startHourMs;
    let sealedHoursIncluded = 0;
    let invalidCellsExcluded = 0;

    // Walk forward hour-by-hour from window start to determine contiguous sealed prefix
    for (let h = startHourMs; h <= currentHourMs; h += HOUR_MS) {
      const ck = makeCellCompositeKey(args.tenantId, args.siteId, h);
      const entry = this.manifest.get(ck);
      if (entry && entry.state === 'valid') {
        seamHourMs = h + HOUR_MS;
        sealedHoursIncluded += 1;
      } else {
        if (entry && entry.state === 'invalid') {
          invalidCellsExcluded += 1;
        }
        break;
      }
    }

    const tailSpanMs = Math.max(0, args.nowMs - seamHourMs);
    const builderLagMs = tailSpanMs;
    const doublePlacementCount = loader.getDoublePlacementCount();

    const quality = {
      seamHourMs,
      builderLagMs,
      maxAllowedLagMs: this.maxUnsealedTailLagMs,
      sealedHoursIncluded,
      tailSpanMs,
      invalidCellsExcluded,
      doublePlacementCount,
    };

    if (builderLagMs > this.maxUnsealedTailLagMs) {
      return {
        status: 'insufficient_data',
        unmet_gates: ['builder_lag'],
        tenantId: args.tenantId,
        siteId: args.siteId,
        windowStartMs: startHourMs,
        windowEndMs: args.nowMs,
        totals: null,
        byUrlId: null,
        quality,
      };
    }

    const totalAcc = createEmptyMetrics();
    const urlMap = new Map<string, ReturnType<typeof createEmptyMetrics>>();

    // 1. Sealed prefix (`startHourMs <= h < seamHourMs`)
    for (let h = startHourMs; h < seamHourMs; h += HOUR_MS) {
      const siteRow = this.getCurrentSiteHourRollup(args.tenantId, args.siteId, h);
      if (siteRow) {
        addMetrics(totalAcc, siteRow);
      }
      const pageRows = this.getCurrentPageHourRollups(args.tenantId, args.siteId, h);
      for (const pr of pageRows) {
        let u = urlMap.get(pr.urlId);
        if (!u) {
          u = createEmptyMetrics();
          urlMap.set(pr.urlId, u);
        }
        addMetrics(u, pr);
      }
    }

    // 2. Exact unsealed tail (`seamHourMs <= pv_hour <= currentHourMs`)
    for (const pv of loader.getAllPvStates()) {
      if (
        pv.placement.tenantId !== args.tenantId ||
        pv.placement.siteId !== args.siteId
      ) {
        continue;
      }
      const h = pv.placement.pvHourMs;
      if (h < seamHourMs || h > currentHourMs) {
        continue;
      }
      addPvStateToMetrics(totalAcc, pv);
      let u = urlMap.get(pv.placement.urlId);
      if (!u) {
        u = createEmptyMetrics();
        urlMap.set(pv.placement.urlId, u);
      }
      addPvStateToMetrics(u, pv);
    }

    const byUrlId = new Map<string, RollupMetrics>();
    for (const [urlId, metrics] of urlMap.entries()) {
      byUrlId.set(urlId, { ...metrics });
    }

    return {
      status: 'ok',
      unmet_gates: [],
      tenantId: args.tenantId,
      siteId: args.siteId,
      windowStartMs: startHourMs,
      windowEndMs: args.nowMs,
      totals: { ...totalAcc },
      byUrlId,
      quality,
    };
  }
}
