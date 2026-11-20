/**
 * UGOKI LINK v2 — Independent Reconciliation Closures ①–④ (store.M13 / §5.9 / store.G-10)
 *
 * Four independent verification closures ensuring silent metric drift is impossible:
 *   ① Manifest-to-base anti-join & control-total check (`LoadManifest` vs `frame_log`)
 *   ② Cross-table invariants (PV count equality across independently maintained tables,
 *     `sum(page_hour) === site_hour`, monotone ladders, 0 double placements)
 *   ③ Canary-tenant scripted hourly oracle replay (duplicates, reordering, late arrival,
 *     subject deletion) against an independently computed ground-truth oracle
 *   ④ Second-implementation independent re-derivation from raw R2 WAL objects compared
 *     cell-by-cell against sealed rollups (`abs_diff === 0`; persistent mismatch marks
 *     the affected cell `invalid`)
 */

import {
  CODEC_VERSION,
  computeFrameChecksum,
  type TelemetryFrame,
} from '../../../packages/contract/schema';
import {
  InMemoryR2Bucket,
  WalWriter,
  type DataRegion,
  type R2BucketLike,
  type WalObject,
} from '../../../workers/link-wal';
import {
  computeInitialPlacement,
  ENGAGED_VIS_THRESHOLD_MS,
  formatWalShardPrefix,
  HOUR_MS,
  listAllKeysWithPrefix,
  makeCellCompositeKey,
  makeFrameLogCompositeKey,
  SealedRollupBuilder,
  ShardLoader,
} from '../../../workers/link-loader';

export interface Closure1Result {
  readonly closure: 'closure_1_manifest_vs_base';
  readonly passed: boolean;
  readonly manifestsChecked: number;
  readonly expectedManifestFrameKeys: number;
  readonly baseFrameLogRows: number;
  readonly missingInBase: readonly string[];
  readonly unexpectedInBase: readonly string[];
  readonly controlTotalFrameDiff: number;
}

export interface Closure2Result {
  readonly closure: 'closure_2_cross_table_invariants';
  readonly passed: boolean;
  readonly pvIndexCount: number;
  readonly pvStateCount: number;
  readonly distinctFrameLogPvCount: number;
  readonly doublePlacementCount: number;
  readonly sealedCellsChecked: number;
  readonly violations: readonly string[];
}

export interface Closure3CanaryResult {
  readonly closure: 'closure_3_canary_oracle_replay';
  readonly passed: boolean;
  readonly expectedPvCount: number;
  readonly actualPvCount: number;
  readonly expectedSumScrollMaxPx: number;
  readonly actualSumScrollMaxPx: number;
  readonly expectedSumVisMs: number;
  readonly actualSumVisMs: number;
  readonly expectedEventCount: number;
  readonly actualEventCount: number;
  readonly doublePlacementCount: number;
  readonly violations: readonly string[];
}

export interface CellDiscrepancy {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvHourMs: number;
  readonly metric: string;
  readonly sealedValue: number;
  readonly rederivedValue: number;
  readonly absDiff: number;
  readonly markedInvalid: boolean;
}

export interface Closure4Result {
  readonly closure: 'closure_4_second_impl_rederivation';
  readonly passed: boolean;
  readonly walObjectsScanned: number;
  readonly sealedCellsCompared: number;
  readonly maxAbsDiff: number;
  readonly discrepancies: readonly CellDiscrepancy[];
  readonly invalidatedCellKeys: readonly string[];
}

export interface FullReconciliationReport {
  readonly evaluatedAtMs: number;
  readonly allPassed: boolean;
  readonly closure1: Closure1Result;
  readonly closure2: Closure2Result;
  readonly closure3: Closure3CanaryResult;
  readonly closure4: Closure4Result;
}

/**
 * Closure ①: Manifest-to-base anti-join and control-total reconciliation.
 * Checks that every frame key committed in `LoadManifest` exists in `frame_log`
 * (minus any explicitly deleted PVs) and no rogue unmanifested frame exists in `frame_log`.
 */
export function runClosure1ManifestVsBase(
  loader: ShardLoader,
  options?: { readonly deletedPvKeys?: ReadonlySet<string> }
): Closure1Result {
  const deletedPvKeys = options?.deletedPvKeys ?? new Set<string>();
  const manifests = loader.getCommittedManifests();

  const manifestKeySet = new Set<string>();
  for (const m of manifests) {
    for (const fk of m.frame_keys) {
      const parts = fk.split('\u0000');
      const pvComposite = `${parts[0] ?? ''}\u0000${parts[1] ?? ''}\u0000${parts[2] ?? ''}`;
      if (!deletedPvKeys.has(pvComposite)) {
        manifestKeySet.add(fk);
      }
    }
  }

  const baseKeySet = new Set<string>();
  for (const row of loader.getAllFrameLogRows()) {
    baseKeySet.add(
      makeFrameLogCompositeKey(
        row.tenantId,
        row.siteId,
        row.pvId,
        row.seq,
        row.frameHash
      )
    );
  }

  const missingInBase: string[] = [];
  for (const k of manifestKeySet) {
    if (!baseKeySet.has(k)) missingInBase.push(k);
  }

  const unexpectedInBase: string[] = [];
  for (const k of baseKeySet) {
    if (!manifestKeySet.has(k)) unexpectedInBase.push(k);
  }

  const controlTotalFrameDiff = Math.abs(manifestKeySet.size - baseKeySet.size);
  const passed =
    missingInBase.length === 0 &&
    unexpectedInBase.length === 0 &&
    controlTotalFrameDiff === 0;

  return {
    closure: 'closure_1_manifest_vs_base',
    passed,
    manifestsChecked: manifests.length,
    expectedManifestFrameKeys: manifestKeySet.size,
    baseFrameLogRows: baseKeySet.size,
    missingInBase,
    unexpectedInBase,
    controlTotalFrameDiff,
  };
}

/**
 * Closure ②: Cross-table invariants across `pv_index`, `page_view_state`,
 * `frame_log`, `site_hour_rollup`, and `page_hour_rollup`.
 */
export function runClosure2CrossTableInvariants(
  loader: ShardLoader,
  builder: SealedRollupBuilder
): Closure2Result {
  const violations: string[] = [];

  const pvIndexRows = loader.getAllPvIndexRows();
  const pvStates = loader.getAllPvStates();
  const frameLogRows = loader.getAllFrameLogRows();

  const distinctFramePvs = new Set<string>();
  for (const fr of frameLogRows) {
    distinctFramePvs.add(`${fr.tenantId}\u0000${fr.siteId}\u0000${fr.pvId}`);
  }

  if (pvIndexRows.length !== pvStates.length) {
    violations.push(
      `pv_index count (${pvIndexRows.length}) !== page_view_state count (${pvStates.length})`
    );
  }
  if (distinctFramePvs.size !== pvIndexRows.length) {
    violations.push(
      `distinct PVs in frame_log (${distinctFramePvs.size}) !== pv_index count (${pvIndexRows.length})`
    );
  }

  const doublePlacementCount = loader.getDoublePlacementCount();
  if (doublePlacementCount > 0) {
    violations.push(`doublePlacementCount === ${doublePlacementCount} (must be 0)`);
  }

  // Monotone register ladder checks on every PV
  for (const pv of pvStates) {
    if (pv.docHMax < pv.docHFirst) {
      violations.push(
        `Monotone violation on pv ${pv.placement.pvId}: docHMax (${pv.docHMax}) < docHFirst (${pv.docHFirst})`
      );
    }
    if (pv.maxTMono < pv.minTMono) {
      violations.push(
        `Monotone violation on pv ${pv.placement.pvId}: maxTMono (${pv.maxTMono}) < minTMono (${pv.minTMono})`
      );
    }
    if (pv.scrollMaxPx < 0 || pv.visMs < 0) {
      violations.push(
        `Negative counter on pv ${pv.placement.pvId}: scrollMaxPx=${pv.scrollMaxPx}, visMs=${pv.visMs}`
      );
    }
  }

  // Count base PVs per cell to compare against sealed site_hour rollups
  const basePvCountByCell = new Map<string, number>();
  for (const pv of pvStates) {
    const ck = makeCellCompositeKey(
      pv.placement.tenantId,
      pv.placement.siteId,
      pv.placement.pvHourMs
    );
    basePvCountByCell.set(ck, (basePvCountByCell.get(ck) ?? 0) + 1);
  }

  // Verify sum(page_hour) === site_hour AND site_hour.pvCount === base PV count for every valid sealed cell
  const manifests = builder.getAllManifestEntries();
  let sealedCellsChecked = 0;

  for (const entry of manifests) {
    if (entry.state !== 'valid') continue;
    sealedCellsChecked += 1;

    const siteRow = builder.getCurrentSiteHourRollup(
      entry.tenantId,
      entry.siteId,
      entry.pvHourMs
    );
    const pageRows = builder.getCurrentPageHourRollups(
      entry.tenantId,
      entry.siteId,
      entry.pvHourMs
    );

    if (!siteRow) {
      violations.push(
        `Valid manifest for (${entry.tenantId}, ${entry.siteId}, ${entry.pvHourMs}) missing site_hour_rollup`
      );
      continue;
    }

    const ck = makeCellCompositeKey(entry.tenantId, entry.siteId, entry.pvHourMs);
    const basePvCount = basePvCountByCell.get(ck) ?? 0;
    if (siteRow.pvCount !== basePvCount) {
      violations.push(
        `Cell (${entry.tenantId}, ${entry.siteId}, ${entry.pvHourMs}): sealed pvCount (${siteRow.pvCount}) !== base pvCount (${basePvCount})`
      );
    }

    let sumPv = 0;
    let sumScroll = 0;
    let sumVis = 0;
    let sumEngaged = 0;
    let sumEvents = 0;
    let sumReversals = 0;
    let sumLcpCount = 0;
    let sumLcpMs = 0;

    for (const pr of pageRows) {
      sumPv += pr.pvCount;
      sumScroll += pr.sumScrollMaxPx;
      sumVis += pr.sumVisMs;
      sumEngaged += pr.engagedPvCount;
      sumEvents += pr.eventCount;
      sumReversals += pr.sumReversals;
      sumLcpCount += pr.lcpCount;
      sumLcpMs += pr.lcpSumMs;
    }

    if (
      sumPv !== siteRow.pvCount ||
      sumScroll !== siteRow.sumScrollMaxPx ||
      sumVis !== siteRow.sumVisMs ||
      sumEngaged !== siteRow.engagedPvCount ||
      sumEvents !== siteRow.eventCount ||
      sumReversals !== siteRow.sumReversals ||
      sumLcpCount !== siteRow.lcpCount ||
      sumLcpMs !== siteRow.lcpSumMs
    ) {
      violations.push(
        `Cell (${entry.tenantId}, ${entry.siteId}, ${entry.pvHourMs}): sum(page_hour) !== site_hour`
      );
    }
  }

  return {
    closure: 'closure_2_cross_table_invariants',
    passed: violations.length === 0,
    pvIndexCount: pvIndexRows.length,
    pvStateCount: pvStates.length,
    distinctFrameLogPvCount: distinctFramePvs.size,
    doublePlacementCount,
    sealedCellsChecked,
    violations,
  };
}

function makeCanaryFrame(args: {
  readonly pvId: string;
  readonly seq: number;
  readonly urlId: string;
  readonly tMono: number;
  readonly tWall: number;
  readonly scrollMaxPx: number;
  readonly visMs: number;
  readonly logIndices: readonly number[];
}): TelemetryFrame {
  const base = {
    codec_ver: CODEC_VERSION,
    schema_ver: 1,
    sdk_build: 'cafe0000beef0001',
    pv_id: args.pvId,
    seq: args.seq,
    frame_class: args.seq === 0 ? ('first' as const) : ('heartbeat' as const),
    transport: 'fetch' as const,
    full: true,
    vis_episode: 1,
    t_mono: args.tMono,
    t_wall: args.tWall,
    ack_echo_seq: args.seq > 0 ? args.seq - 1 : -1,
    consent_mode: 'cookieless' as const,
    purposes: ['automation_detection', 'experiment'] as const,
    arm_bits: 1,
    def_ver: 1,
    url_id: args.urlId,
    key_ver: 2,
    profile_rev: 1,
    dim_tuple_code: 1,
    live_word: 1,
    key_degraded: false,
    state: {
      page_url_key: `canary.example.com/${args.urlId}`,
      nav_type: 'navigate' as const,
      started_hidden: false,
      scroll_max_px: args.scrollMaxPx,
      doc_h_first: 3000,
      doc_h_max: 3000,
      doc_h_last: { value: 3000, seq: args.seq },
      vis_ms: args.visMs,
      reversals: args.seq,
      js_error_n: 0,
      degrade_level: 0,
      dom_state: 'ok' as const,
      skel_fp: '10001',
      variant_key: '20002',
      sample_pi: 1,
    },
    sections: [
      {
        sec_fp: '1',
        vis_ms: args.visMs,
        t_first_ms: 100,
        entries: 1,
        max_frac_permille: 1000,
      },
    ],
    log_items: args.logIndices.map((i) => ({
      i,
      kind: 'activation' as const,
      t_mono: 100 + i * 500,
      el_fp: String(1000 + i),
    })),
  };
  return {
    ...base,
    chk: computeFrameChecksum(base),
  };
}

/**
 * Closure ③: Canary-tenant scripted hourly workload replay against an
 * independent mathematical oracle, exercising duplicates, out-of-order
 * delivery, late arrival after hour seal, and post-seal subject deletion.
 */
export async function runClosure3CanaryOracleReplay(
  baseHourMs = Date.UTC(2026, 10, 20, 8, 0, 0)
): Promise<Closure3CanaryResult> {
  const bucket = new InMemoryR2Bucket();
  const writer = new WalWriter({ region: 'jp', bucket });
  const loader = new ShardLoader({ region: 'jp', shardId: 0, bucket });
  const builder = new SealedRollupBuilder();

  const tenantId = 'canary-tenant';
  const siteId = 'canary-site';
  const pvKeep1 = 'c0000000000000000000000000000001';
  const pvKeep2 = 'c0000000000000000000000000000002';
  const pvDelete = 'c0000000000000000000000000000003';

  // Step 1: Send reordered & duplicated frames for pvKeep1, pvKeep2, pvDelete
  const f1s1 = makeCanaryFrame({
    pvId: pvKeep1,
    seq: 1,
    urlId: '901',
    tMono: 5000,
    tWall: baseHourMs + 65_000,
    scrollMaxPx: 1200,
    visMs: 11_000,
    logIndices: [0, 1],
  });
  const f1s0 = makeCanaryFrame({
    pvId: pvKeep1,
    seq: 0,
    urlId: '901',
    tMono: 500,
    tWall: baseHourMs + 60_500,
    scrollMaxPx: 300,
    visMs: 400,
    logIndices: [0],
  });
  const f2s0 = makeCanaryFrame({
    pvId: pvKeep2,
    seq: 0,
    urlId: '902',
    tMono: 1000,
    tWall: baseHourMs + 120_000,
    scrollMaxPx: 500,
    visMs: 2000,
    logIndices: [0],
  });
  const fDel = makeCanaryFrame({
    pvId: pvDelete,
    seq: 0,
    urlId: '901',
    tMono: 1000,
    tWall: baseHourMs + 180_000,
    scrollMaxPx: 999,
    visMs: 8888,
    logIndices: [0, 1, 2],
  });

  // Intentionally reorder (seq=1 before seq=0) and duplicate f1s1!
  await writer.consumeBatch(
    [
      {
        tenant_id: tenantId,
        site_id: siteId,
        storage_region: 'jp',
        shard_id: 0,
        received_at_ms: baseHourMs + 65_000,
        raw_frame: f1s1,
      },
      {
        tenant_id: tenantId,
        site_id: siteId,
        storage_region: 'jp',
        shard_id: 0,
        received_at_ms: baseHourMs + 60_500,
        raw_frame: f1s0,
      },
      {
        tenant_id: tenantId,
        site_id: siteId,
        storage_region: 'jp',
        shard_id: 0,
        received_at_ms: baseHourMs + 65_100,
        raw_frame: f1s1, // duplicate
      },
      {
        tenant_id: tenantId,
        site_id: siteId,
        storage_region: 'jp',
        shard_id: 0,
        received_at_ms: baseHourMs + 120_000,
        raw_frame: f2s0,
      },
      {
        tenant_id: tenantId,
        site_id: siteId,
        storage_region: 'jp',
        shard_id: 0,
        received_at_ms: baseHourMs + 180_000,
        raw_frame: fDel,
      },
    ],
    baseHourMs + 200_000
  );

  await loader.loadPendingWalObjects(baseHourMs + 210_000);
  // Seal hour at +95 min
  builder.sealEligibleHours(loader, baseHourMs + HOUR_MS + 35 * 60_000);

  // Step 2: Late frame arrives for pvKeep2 AFTER seal (higher scroll & vis & new log item)
  const f2Late = makeCanaryFrame({
    pvId: pvKeep2,
    seq: 2,
    urlId: '902',
    tMono: 15_000,
    tWall: baseHourMs + 135_000,
    scrollMaxPx: 2100,
    visMs: 14_000,
    logIndices: [0, 1, 2],
  });
  await writer.consumeBatch(
    [
      {
        tenant_id: tenantId,
        site_id: siteId,
        storage_region: 'jp',
        shard_id: 0,
        received_at_ms: baseHourMs + HOUR_MS + 40 * 60_000,
        raw_frame: f2Late,
      },
    ],
    baseHourMs + HOUR_MS + 40 * 60_000
  );
  await loader.loadPendingWalObjects(baseHourMs + HOUR_MS + 41 * 60_000, {
    sealedHours: builder.getSealedCellKeySet(),
  });

  // Step 3: Subject erasure deletes pvDelete AFTER seal
  loader.deletePvs(tenantId, siteId, [pvDelete], baseHourMs + HOUR_MS + 42 * 60_000);

  // Re-seal dirty cell after late frame + deletion
  builder.sealEligibleHours(loader, baseHourMs + HOUR_MS + 45 * 60_000);

  const sealed = builder.getCurrentSiteHourRollup(tenantId, siteId, baseHourMs);
  // Independent oracle expectations:
  // pvKeep1: scroll=1200, vis=11000, events=2 ({0,1})
  // pvKeep2: scroll=2100, vis=14000, events=3 ({0,1,2})
  // pvDelete: deleted -> 0
  const expectedPvCount = 2;
  const expectedSumScrollMaxPx = 1200 + 2100;
  const expectedSumVisMs = 11_000 + 14_000;
  const expectedEventCount = 2 + 3;

  const actualPvCount = sealed?.pvCount ?? -1;
  const actualSumScrollMaxPx = sealed?.sumScrollMaxPx ?? -1;
  const actualSumVisMs = sealed?.sumVisMs ?? -1;
  const actualEventCount = sealed?.eventCount ?? -1;
  const doublePlacementCount = loader.getDoublePlacementCount();

  const violations: string[] = [];
  if (actualPvCount !== expectedPvCount) {
    violations.push(`pvCount mismatch: expected ${expectedPvCount}, got ${actualPvCount}`);
  }
  if (actualSumScrollMaxPx !== expectedSumScrollMaxPx) {
    violations.push(
      `sumScrollMaxPx mismatch: expected ${expectedSumScrollMaxPx}, got ${actualSumScrollMaxPx}`
    );
  }
  if (actualSumVisMs !== expectedSumVisMs) {
    violations.push(
      `sumVisMs mismatch: expected ${expectedSumVisMs}, got ${actualSumVisMs}`
    );
  }
  if (actualEventCount !== expectedEventCount) {
    violations.push(
      `eventCount mismatch: expected ${expectedEventCount}, got ${actualEventCount}`
    );
  }
  if (doublePlacementCount !== 0) {
    violations.push(`doublePlacementCount=${doublePlacementCount} (must be 0)`);
  }

  return {
    closure: 'closure_3_canary_oracle_replay',
    passed: violations.length === 0,
    expectedPvCount,
    actualPvCount,
    expectedSumScrollMaxPx,
    actualSumScrollMaxPx,
    expectedSumVisMs,
    actualSumVisMs,
    expectedEventCount,
    actualEventCount,
    doublePlacementCount,
    violations,
  };
}

/**
 * Closure ④: Completely independent second-implementation re-derivation directly
 * from immutable R2 WAL objects compared against sealed rollups (`abs_diff === 0`).
 *
 * When `markInvalidOnDiscrepancy` is true (default), any cell exhibiting a
 * non-zero discrepancy is immediately marked `invalid` in `rollup_manifest`.
 */
export async function runClosure4SecondImplementationRederivation(args: {
  readonly region: DataRegion;
  readonly shardId: number;
  readonly walBucket: R2BucketLike;
  readonly builder: SealedRollupBuilder;
  readonly deletedPvKeys?: ReadonlySet<string>;
  readonly markInvalidOnDiscrepancy?: boolean;
}): Promise<Closure4Result> {
  const deletedPvKeys = args.deletedPvKeys ?? new Set<string>();
  const markInvalid = args.markInvalidOnDiscrepancy ?? true;

  // Independent raw-WAL reducer (separate algorithm from ShardLoader / SealedRollupBuilder)
  const prefix = formatWalShardPrefix(args.region, args.shardId);
  const walKeys = await listAllKeysWithPrefix(args.walBucket, prefix);

  interface IndependentPvAcc {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvHourMs: number;
    readonly urlId: string;
    scrollMaxPx: number;
    visMs: number;
    reversals: number;
    lcpBestSeq: number;
    lcpBestHash: string;
    lcpValue: number | null;
    readonly eventIndices: Set<number>;
  }

  const pvMap = new Map<string, IndependentPvAcc>();

  for (const key of walKeys) {
    const obj = await args.walBucket.get(key);
    if (!obj) continue;
    const walObj = JSON.parse(await obj.text()) as WalObject;
    for (const rec of walObj.records) {
      const pvComposite = `${rec.tenant_id}\u0000${rec.site_id}\u0000${rec.frame.pv_id}`;
      if (deletedPvKeys.has(pvComposite)) continue;

      let acc = pvMap.get(pvComposite);
      if (!acc) {
        const placement = computeInitialPlacement({
          tenantId: rec.tenant_id,
          siteId: rec.site_id,
          pvId: rec.frame.pv_id,
          urlId: rec.frame.url_id,
          keyVer: rec.frame.key_ver,
          profileRev: rec.frame.profile_rev,
          receivedAtMs: rec.received_at_ms,
          tMonoMs: rec.frame.t_mono,
          ageMs: rec.age_ms,
          retentionDays: rec.retention_days,
        });
        acc = {
          tenantId: rec.tenant_id,
          siteId: rec.site_id,
          pvHourMs: placement.pvHourMs,
          urlId: rec.frame.url_id,
          scrollMaxPx: rec.frame.state.scroll_max_px,
          visMs: rec.frame.state.vis_ms,
          reversals: rec.frame.state.reversals,
          lcpBestSeq: -1,
          lcpBestHash: '',
          lcpValue: null,
          eventIndices: new Set<number>(),
        };
        pvMap.set(pvComposite, acc);
      } else {
        if (rec.frame.state.scroll_max_px > acc.scrollMaxPx) {
          acc.scrollMaxPx = rec.frame.state.scroll_max_px;
        }
        if (rec.frame.state.vis_ms > acc.visMs) {
          acc.visMs = rec.frame.state.vis_ms;
        }
        if (rec.frame.state.reversals > acc.reversals) {
          acc.reversals = rec.frame.state.reversals;
        }
      }

      const lcp = rec.frame.vitals?.lcp_ms;
      if (lcp !== undefined) {
        if (
          lcp.seq > acc.lcpBestSeq ||
          (lcp.seq === acc.lcpBestSeq && rec.frame_hash >= acc.lcpBestHash)
        ) {
          acc.lcpBestSeq = lcp.seq;
          acc.lcpBestHash = rec.frame_hash;
          acc.lcpValue = lcp.value;
        }
      }

      for (const item of rec.frame.log_items) {
        acc.eventIndices.add(item.i);
      }
    }
  }

  // Group independent PVs by (tenantId, siteId, pvHourMs)
  const rederivedByCell = new Map<
    string,
    {
      pvCount: number;
      sumScrollMaxPx: number;
      sumVisMs: number;
      engagedPvCount: number;
      eventCount: number;
      sumReversals: number;
      lcpCount: number;
      lcpSumMs: number;
    }
  >();

  for (const pv of pvMap.values()) {
    const ck = makeCellCompositeKey(pv.tenantId, pv.siteId, pv.pvHourMs);
    let cell = rederivedByCell.get(ck);
    if (!cell) {
      cell = {
        pvCount: 0,
        sumScrollMaxPx: 0,
        sumVisMs: 0,
        engagedPvCount: 0,
        eventCount: 0,
        sumReversals: 0,
        lcpCount: 0,
        lcpSumMs: 0,
      };
      rederivedByCell.set(ck, cell);
    }
    cell.pvCount += 1;
    cell.sumScrollMaxPx += pv.scrollMaxPx;
    cell.sumVisMs += pv.visMs;
    if (pv.visMs >= ENGAGED_VIS_THRESHOLD_MS || pv.eventIndices.size > 0) {
      cell.engagedPvCount += 1;
    }
    cell.eventCount += pv.eventIndices.size;
    cell.sumReversals += pv.reversals;
    if (pv.lcpValue !== null) {
      cell.lcpCount += 1;
      cell.lcpSumMs += pv.lcpValue;
    }
  }

  const discrepancies: CellDiscrepancy[] = [];
  const invalidatedCellKeys = new Set<string>();
  let sealedCellsCompared = 0;
  let maxAbsDiff = 0;

  for (const entry of args.builder.getAllManifestEntries()) {
    if (entry.state !== 'valid') continue;
    sealedCellsCompared += 1;

    const ck = makeCellCompositeKey(entry.tenantId, entry.siteId, entry.pvHourMs);
    const sealed = args.builder.getCurrentSiteHourRollup(
      entry.tenantId,
      entry.siteId,
      entry.pvHourMs
    );
    const rederived = rederivedByCell.get(ck) ?? {
      pvCount: 0,
      sumScrollMaxPx: 0,
      sumVisMs: 0,
      engagedPvCount: 0,
      eventCount: 0,
      sumReversals: 0,
      lcpCount: 0,
      lcpSumMs: 0,
    };

    const pairs: Array<[string, number, number]> = [
      ['pvCount', sealed?.pvCount ?? 0, rederived.pvCount],
      ['sumScrollMaxPx', sealed?.sumScrollMaxPx ?? 0, rederived.sumScrollMaxPx],
      ['sumVisMs', sealed?.sumVisMs ?? 0, rederived.sumVisMs],
      ['engagedPvCount', sealed?.engagedPvCount ?? 0, rederived.engagedPvCount],
      ['eventCount', sealed?.eventCount ?? 0, rederived.eventCount],
      ['sumReversals', sealed?.sumReversals ?? 0, rederived.sumReversals],
      ['lcpCount', sealed?.lcpCount ?? 0, rederived.lcpCount],
      ['lcpSumMs', sealed?.lcpSumMs ?? 0, rederived.lcpSumMs],
    ];

    let cellHasMismatch = false;
    for (const [metric, sVal, rVal] of pairs) {
      const diff = Math.abs(sVal - rVal);
      if (diff > 0) {
        cellHasMismatch = true;
        if (diff > maxAbsDiff) maxAbsDiff = diff;
        discrepancies.push({
          tenantId: entry.tenantId,
          siteId: entry.siteId,
          pvHourMs: entry.pvHourMs,
          metric,
          sealedValue: sVal,
          rederivedValue: rVal,
          absDiff: diff,
          markedInvalid: markInvalid,
        });
      }
    }

    if (cellHasMismatch && markInvalid) {
      args.builder.markCellInvalid(entry.tenantId, entry.siteId, entry.pvHourMs);
      invalidatedCellKeys.add(ck);
    }
  }

  return {
    closure: 'closure_4_second_impl_rederivation',
    passed: discrepancies.length === 0,
    walObjectsScanned: walKeys.length,
    sealedCellsCompared,
    maxAbsDiff,
    discrepancies,
    invalidatedCellKeys: Array.from(invalidatedCellKeys).sort(),
  };
}

/**
 * Executes all 4 independent reconciliation closures (①–④) and returns an
 * aggregated audit report.
 */
export async function runAllReconciliationClosures(args: {
  readonly region: DataRegion;
  readonly shardId: number;
  readonly walBucket: R2BucketLike;
  readonly loader: ShardLoader;
  readonly builder: SealedRollupBuilder;
  readonly deletedPvKeys?: ReadonlySet<string>;
  readonly markInvalidOnDiscrepancy?: boolean;
  readonly nowMs?: number;
}): Promise<FullReconciliationReport> {
  const closure1 = runClosure1ManifestVsBase(args.loader, {
    deletedPvKeys: args.deletedPvKeys,
  });
  const closure2 = runClosure2CrossTableInvariants(args.loader, args.builder);
  const closure3 = await runClosure3CanaryOracleReplay();
  const closure4 = await runClosure4SecondImplementationRederivation({
    region: args.region,
    shardId: args.shardId,
    walBucket: args.walBucket,
    builder: args.builder,
    deletedPvKeys: args.deletedPvKeys,
    markInvalidOnDiscrepancy: args.markInvalidOnDiscrepancy,
  });

  return {
    evaluatedAtMs: args.nowMs ?? Date.now(),
    allPassed:
      closure1.passed &&
      closure2.passed &&
      closure3.passed &&
      closure4.passed,
    closure1,
    closure2,
    closure3,
    closure4,
  };
}
