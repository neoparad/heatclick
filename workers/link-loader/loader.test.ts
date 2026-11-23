/**
 * UGOKI LINK v2 — Loader, Idempotent Merge, 100k-Schedule Exit Gate (`tel.G1` / `store.G-1`)
 * and 1-Week R2 WAL Replay Exit Gate (`store.G-4`) Tests
 */

import {
  CODEC_VERSION,
  computeFrameChecksum,
  type TelemetryFrame,
  type TelemetryLogItem,
} from '../../packages/contract/schema';
import {
  DEFAULT_POST_ACK_GRACE_MS,
  InMemoryR2Bucket,
  PostAckLossDetector,
  WalWriter,
  type WalQueuePayload,
} from '../link-wal';
import {
  areMergedStatesEquivalent,
  computeFastFrameHash,
  computeInitialPlacement,
  formatTombstonesObjectKey,
  HOUR_MS,
  mergeFrameIntoPvState,
  MissingManifestWalError,
  replayAllFromWal,
  runPurePvSchedule,
  SealedRollupBuilder,
  ShardLoader,
  type MergedPvState,
} from './index';

/**
 * Deterministic Mulberry32 PRNG for reproducible 100,000-schedule runs.
 */
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SessionStepSpec {
  readonly seq: number;
  readonly tMono: number;
  readonly scrollMaxPx: number;
  readonly docHMax: number;
  readonly docHLastVal: number;
  readonly visMs: number;
  readonly reversals: number;
  readonly jsErrorN: number;
  readonly liveWord: number;
  readonly domState: 'degraded' | 'ok';
  readonly secVisMs: number;
  readonly secEntries: number;
  readonly lcpMs?: number;
  readonly inpMs?: number;
  readonly newLogItem?: TelemetryLogItem;
}

const GROUND_TRUTH_STEPS: readonly SessionStepSpec[] = [
  {
    seq: 0,
    tMono: 200,
    scrollMaxPx: 0,
    docHMax: 2400,
    docHLastVal: 2400,
    visMs: 150,
    reversals: 0,
    jsErrorN: 0,
    liveWord: 0b000001,
    domState: 'degraded',
    secVisMs: 150,
    secEntries: 1,
    newLogItem: { i: 0, kind: 'exposure', t_mono: 180, exposure_kind: 'render' },
  },
  {
    seq: 1,
    tMono: 2200,
    scrollMaxPx: 600,
    docHMax: 2800,
    docHLastVal: 2800,
    visMs: 1900,
    reversals: 0,
    jsErrorN: 0,
    liveWord: 0b000011,
    domState: 'ok',
    secVisMs: 1200,
    secEntries: 1,
    lcpMs: 1450,
    newLogItem: { i: 1, kind: 'activation', t_mono: 2000, el_fp: '9001' },
  },
  {
    seq: 2,
    tMono: 7500,
    scrollMaxPx: 1450,
    docHMax: 2800,
    docHLastVal: 2650, // non-monotone argMax_seq test (dynamic accordion collapse)
    visMs: 6800,
    reversals: 1,
    jsErrorN: 0,
    liveWord: 0b000111,
    domState: 'ok',
    secVisMs: 3200,
    secEntries: 2,
    lcpMs: 1450,
    inpMs: 88,
    newLogItem: { i: 2, kind: 'activation', t_mono: 7100, el_fp: '9002' },
  },
  {
    seq: 3,
    tMono: 14000,
    scrollMaxPx: 2200,
    docHMax: 3100,
    docHLastVal: 3100,
    visMs: 12900,
    reversals: 2,
    jsErrorN: 1,
    liveWord: 0b001111,
    domState: 'ok',
    secVisMs: 5100,
    secEntries: 2,
    lcpMs: 1450,
    inpMs: 132,
    newLogItem: { i: 3, kind: 'conversion', t_mono: 13500, cv_key: 'lead_form' },
  },
  {
    seq: 4,
    tMono: 22000,
    scrollMaxPx: 2600,
    docHMax: 3100,
    docHLastVal: 2950,
    visMs: 20100,
    reversals: 3,
    jsErrorN: 1,
    liveWord: 0b011111,
    domState: 'ok',
    secVisMs: 7400,
    secEntries: 3,
    lcpMs: 1450,
    inpMs: 132,
    newLogItem: { i: 4, kind: 'activation', t_mono: 21500, el_fp: '9005' },
  },
  {
    seq: 5,
    tMono: 31000,
    scrollMaxPx: 3050,
    docHMax: 3100,
    docHLastVal: 3080,
    visMs: 28500,
    reversals: 4,
    jsErrorN: 1,
    liveWord: 0b111111,
    domState: 'ok',
    secVisMs: 9800,
    secEntries: 3,
    lcpMs: 1450,
    inpMs: 164,
    newLogItem: { i: 5, kind: 'conversion', t_mono: 30400, cv_key: 'purchase_complete' },
  },
];

function buildFrameFromStep(
  step: SessionStepSpec,
  ackEchoSeq: number,
  unackedItems: readonly TelemetryLogItem[],
  pvId = 'abcdef0123456789abcdef0123456789',
  urlId = '4200001',
  tWallBase = Date.UTC(2026, 10, 20, 9, 0, 0),
  skipChecksum = false
): TelemetryFrame {
  const base = {
    codec_ver: CODEC_VERSION,
    schema_ver: 1,
    sdk_build: 'a1b2c3d4e5f60708',
    pv_id: pvId,
    seq: step.seq,
    frame_class: step.seq === 0 ? ('first' as const) : ('heartbeat' as const),
    transport: 'fetch' as const,
    full: true,
    vis_episode: 1,
    t_mono: step.tMono,
    t_wall: tWallBase + step.tMono,
    ack_echo_seq: ackEchoSeq,
    consent_mode: 'cookieless' as const,
    purposes: ['automation_detection', 'experiment'] as const,
    arm_bits: 1,
    def_ver: 1,
    url_id: urlId,
    key_ver: 2,
    profile_rev: 1,
    dim_tuple_code: 7,
    live_word: step.liveWord,
    key_degraded: false,
    state: {
      page_url_key: `example.com/p/${urlId}`,
      nav_type: 'navigate' as const,
      started_hidden: false,
      scroll_max_px: step.scrollMaxPx,
      doc_h_first: 2400,
      doc_h_max: step.docHMax,
      doc_h_last: { value: step.docHLastVal, seq: step.seq },
      vis_ms: step.visMs,
      reversals: step.reversals,
      js_error_n: step.jsErrorN,
      degrade_level: 0,
      dom_state: step.domState,
      skel_fp: '88888888',
      variant_key: '77777777',
      sample_pi: 1,
    },
    sections: [
      {
        sec_fp: '101',
        vis_ms: step.secVisMs,
        t_first_ms: 150,
        entries: step.secEntries,
        max_frac_permille: 900,
      },
    ],
    blocks: [{ blk_fp: '201', vis_ms: step.secVisMs, copy_n: step.reversals }],
    fields: [{ el_fp: '301', focus_ms: step.visMs, invalid_n: step.jsErrorN }],
    forms: [{ form_fp: '401', submit_attempts: step.seq >= 3 ? 1 : 0 }],
    media: [{ blk_fp: '501', played_ms: step.seq * 500 }],
    vitals: {
      ...(step.lcpMs !== undefined
        ? { lcp_ms: { value: step.lcpMs, seq: 1 } }
        : {}),
      ...(step.inpMs !== undefined
        ? { inp_ms: { value: step.inpMs, seq: step.seq } }
        : {}),
    },
    log_items: unackedItems,
  };

  const chk = skipChecksum
    ? { nonZeroRegisters: 1, sumTimeMs: 1, sumCounts: 1, logHighWater: step.seq }
    : computeFrameChecksum(base);

  return {
    ...base,
    chk,
  };
}

describe('workers/link-loader', () => {
  test('tel.G1 / store.G-1 exit gate: 100,000 randomized drop/dup/reorder/regroup schedules converge 100% with 0 double placements and 100% post-ack loss detection', () => {
    const TOTAL_SCHEDULES = 100_000;
    const rng = createPrng(20261120);
    const baseReceivedMs = Date.UTC(2026, 10, 20, 9, 0, 0);
    const tenantId = 'tenant-stress';
    const siteId = 'site-stress';
    const pvId = 'abcdef0123456789abcdef0123456789';

    // Precompute exact ground-truth browser oracle state at each maxDeliveredSeq (0..5)
    const oracleByMaxSeq: MergedPvState[] = [];
    let cumulativeOracle: MergedPvState | null = null;
    const allLogItemsSoFar: TelemetryLogItem[] = [];
    const oraclePlacement = computeInitialPlacement({
      tenantId,
      siteId,
      pvId,
      urlId: '4200001',
      keyVer: 2,
      profileRev: 1,
      receivedAtMs: baseReceivedMs,
      tMonoMs: 200,
      retentionDays: 395,
    });

    for (const step of GROUND_TRUTH_STEPS) {
      if (step.newLogItem) allLogItemsSoFar.push(step.newLogItem);
      const fullBrowserFrame = buildFrameFromStep(
        step,
        step.seq - 1,
        [...allLogItemsSoFar],
        pvId,
        '4200001',
        baseReceivedMs,
        true
      );
      cumulativeOracle = mergeFrameIntoPvState(
        cumulativeOracle,
        fullBrowserFrame,
        computeFastFrameHash(fullBrowserFrame),
        oraclePlacement,
        false
      );
      oracleByMaxSeq.push(cumulativeOracle);
    }

    // Pre-build base template per step to avoid 600,000 identical nested allocations
    const stepTemplates: TelemetryFrame[] = GROUND_TRUTH_STEPS.map((step) =>
      buildFrameFromStep(step, -1, [], pvId, '4200001', baseReceivedMs, true)
    );

    let convergedSchedules = 0;
    let totalDoublePlacements = 0;
    let placementCountMismatches = 0;
    let nullStateCount = 0;
    let immutablePathMismatches = 0;
    let postAckRegisterMismatches = 0;
    let injectedPostAckLosses = 0;
    let detectedPostAckLosses = 0;
    let falsePositivePostAckLosses = 0;

    for (let s = 0; s < TOTAL_SCHEDULES; s += 1) {
      // Simulate browser session emitting seq 0..5 with realistic unacked log_items buffer
      let ackEchoSeq = -1;
      let iHw = -1;
      const unackedBuffer: TelemetryLogItem[] = [];
      const deliveredFrames: TelemetryFrame[] = [];
      const ackedButLostSeqs: number[] = [];

      // Inject post-ack loss in 1 out of every 50 schedules (2,000 injected losses across 100k runs)
      const injectPostAckLoss = s % 50 === 17;
      const lossTargetSeq = injectPostAckLoss ? Math.floor(rng() * 5) : -1; // 0..4 so a later frame echoes it

      for (let idx = 0; idx < GROUND_TRUTH_STEPS.length; idx += 1) {
        const step = GROUND_TRUTH_STEPS[idx]!;
        if (step.newLogItem) {
          unackedBuffer.push(step.newLogItem);
        }

        const frame: TelemetryFrame = {
          ...stepTemplates[idx]!,
          ack_echo_seq: ackEchoSeq,
          log_items: unackedBuffer.slice(),
        };

        // Decide transport delivery outcome:
        // - If this is the injected post-ack loss frame: edge ACKed it, then lost it before WAL!
        // - Otherwise, 75% delivered (always guarantee at least final frame if injecting loss so echo arrives)
        const mustDeliverAfterLoss =
          injectPostAckLoss && step.seq === lossTargetSeq + 1;
        const isPostAckLost = injectPostAckLoss && step.seq === lossTargetSeq;
        const delivered = isPostAckLost
          ? false
          : mustDeliverAfterLoss || step.seq === GROUND_TRUTH_STEPS.length - 1 || rng() < 0.72;

        if (isPostAckLost) {
          // Edge returned 200 ACK (browser advances ack_echo_seq & i_hw), but frame never persisted!
          ackEchoSeq = step.seq;
          iHw = step.newLogItem ? step.newLogItem.i : iHw;
          unackedBuffer.length = 0;
          ackedButLostSeqs.push(step.seq);
          injectedPostAckLosses += 1;
        } else if (delivered) {
          // Duplicate 1x..3x randomly
          const copies = rng() < 0.35 ? (rng() < 0.5 ? 2 : 3) : 1;
          for (let c = 0; c < copies; c += 1) {
            deliveredFrames.push(frame);
          }
          // Edge ACKs 85% of delivered frames (unacked frames keep items in browser buffer)
          if (rng() < 0.85) {
            ackEchoSeq = step.seq;
            if (step.newLogItem) iHw = step.newLogItem.i;
            unackedBuffer.length = 0;
          }
        }
      }

      // Fisher-Yates shuffle to simulate arbitrary network/queue reordering & regrouping
      for (let i = deliveredFrames.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = deliveredFrames[i]!;
        deliveredFrames[i] = deliveredFrames[j]!;
        deliveredFrames[j] = tmp;
      }

      // Run pure loader placement + idempotent merge across the shuffled/duplicated schedule
      const run = runPurePvSchedule(deliveredFrames, {
        tenantId,
        siteId,
        baseReceivedAtMs: baseReceivedMs,
        retentionDays: 395,
      });

      // Cross-verify immutable step-by-step mergeFrameIntoPvState matches batch merger identically
      if (s < 250 && deliveredFrames.length > 0 && run.state !== null) {
        let immState: MergedPvState | null = null;
        for (let i = 0; i < deliveredFrames.length; i += 1) {
          const f = deliveredFrames[i]!;
          immState = mergeFrameIntoPvState(
            immState,
            f,
            computeFastFrameHash(f),
            run.state.placement,
            false
          );
        }
        if (!areMergedStatesEquivalent(immState!, run.state)) {
          immutablePathMismatches += 1;
        }
      }

      if (run.doublePlacement) {
        totalDoublePlacements += 1;
      }

      if (deliveredFrames.length > 0) {
        if (run.placementCount !== 1) placementCountMismatches += 1;
        if (run.state === null) {
          nullStateCount += 1;
          continue;
        }

        let maxDeliveredSeq = -1;
        for (let i = 0; i < deliveredFrames.length; i += 1) {
          const sq = deliveredFrames[i]!.seq;
          if (sq > maxDeliveredSeq) maxDeliveredSeq = sq;
        }

        if (!injectPostAckLoss) {
          const oracle = oracleByMaxSeq[maxDeliveredSeq]!;
          if (areMergedStatesEquivalent(run.state, oracle)) {
            convergedSchedules += 1;
          }
        } else {
          // Even when an intermediate frame suffered post-ack loss, verify detector catches it 100%!
          const detector = new PostAckLossDetector();
          for (let i = 0; i < deliveredFrames.length; i += 1) {
            const f = deliveredFrames[i]!;
            detector.recordCommittedFrame(tenantId, siteId, pvId, f.seq);
            if (f.ack_echo_seq >= 0) {
              detector.recordAckEcho(
                tenantId,
                siteId,
                pvId,
                f.ack_echo_seq,
                baseReceivedMs + f.t_mono,
                f.seq
              );
            }
          }
          const report = detector.evaluate(
            baseReceivedMs + 60_000 + DEFAULT_POST_ACK_GRACE_MS
          );
          const missingSeqs = new Set(report.confirmedMissing.map((m) => m.seq));
          for (const lost of ackedButLostSeqs) {
            if (missingSeqs.has(lost)) {
              detectedPostAckLosses += 1;
            }
          }
          for (const found of missingSeqs) {
            if (!ackedButLostSeqs.includes(found)) {
              falsePositivePostAckLosses += 1;
            }
          }
          // Non-lost cumulative registers still match oracle at maxDeliveredSeq!
          const oracle = oracleByMaxSeq[maxDeliveredSeq]!;
          if (
            run.state.scrollMaxPx !== oracle.scrollMaxPx ||
            run.state.visMs !== oracle.visMs ||
            run.state.docHLast.value !== oracle.docHLast.value ||
            run.state.liveWord !== oracle.liveWord
          ) {
            postAckRegisterMismatches += 1;
          }
          convergedSchedules += 1;
        }
      } else {
        convergedSchedules += 1;
      }
    }

    expect(convergedSchedules).toBe(TOTAL_SCHEDULES);
    expect(totalDoublePlacements).toBe(0);
    expect(placementCountMismatches).toBe(0);
    expect(nullStateCount).toBe(0);
    expect(immutablePathMismatches).toBe(0);
    expect(postAckRegisterMismatches).toBe(0);
    expect(injectedPostAckLosses).toBe(2000);
    expect(detectedPostAckLosses).toBe(injectedPostAckLosses);
    expect(falsePositivePostAckLosses).toBe(0);
  });

  test('conditional manifest put fences racing/zombie loaders and guarantees 0 double placements', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 20, 10, 0, 0);

    const f0 = buildFrameFromStep(
      GROUND_TRUTH_STEPS[0]!,
      -1,
      [GROUND_TRUTH_STEPS[0]!.newLogItem!],
      '11112222333344445555666677778888',
      '100',
      t0
    );
    await writer.consumeBatch(
      [
        {
          tenant_id: 'tenant-race',
          site_id: 'site-1',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0,
          raw_frame: f0,
        },
      ],
      t0
    );

    const loaderA = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const loaderB = new ShardLoader({ region: 'jp', shardId: 0, bucket });

    // Loader A wins conditional put for manifest_seq = 1
    const resA = await loaderA.loadPendingWalObjects(t0 + 1000);
    expect(resA.committed).toBe(true);
    expect(resA.abortedDueToRace).toBe(false);
    expect(resA.manifestSeq).toBe(1);
    expect(resA.doublePlacementCount).toBe(0);

    // Stale/zombie Loader B tries to commit manifest_seq = 1 -> fenced cleanly!
    const resB = await loaderB.loadPendingWalObjects(t0 + 2000);
    expect(resB.committed).toBe(false);
    expect(resB.abortedDueToRace).toBe(true);
    expect(loaderB.getAllPvStates()).toHaveLength(0);
    expect(loaderB.getDoublePlacementCount()).toBe(0);

    // After syncing manifests from R2, Loader B seamlessly advances past manifest_seq = 1
    const syncedSeq = await loaderB.syncManifestsFromBucket();
    expect(syncedSeq).toBe(1);
    expect(loaderB.getNextManifestSeq()).toBe(2);
    const resBAfterSync = await loaderB.loadPendingWalObjects(t0 + 3000);
    expect(resBAfterSync.committed).toBe(true);
    expect(resBAfterSync.recordsProcessed).toBe(0);
  });

  test('store.G-4 exit gate: full 1-week (168-hour) R2 WAL replay reconstructs byte/total-identical state and sealed rollups', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const liveLoader = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const liveBuilder = new SealedRollupBuilder();

    const weekStartMs = Date.UTC(2026, 10, 9, 0, 0, 0); // Monday 00:00 UTC
    const TOTAL_HOURS = 168; // 7 full days

    // Emit 2 PVs per hour across 2 URLs for all 168 hours (336 PVs, 672 frames)
    for (let h = 0; h < TOTAL_HOURS; h += 1) {
      const hourBaseMs = weekStartMs + h * HOUR_MS;
      const payloads: WalQueuePayload[] = [];

      for (let p = 0; p < 2; p += 1) {
        const pvIdx = h * 2 + p;
        const pvId = pvIdx.toString(16).padStart(32, '0');
        const urlId = p === 0 ? '10001' : '10002';

        const frame0 = buildFrameFromStep(
          GROUND_TRUTH_STEPS[0]!,
          -1,
          [GROUND_TRUTH_STEPS[0]!.newLogItem!],
          pvId,
          urlId,
          hourBaseMs + 60_000
        );
        const frame1 = buildFrameFromStep(
          GROUND_TRUTH_STEPS[3]!,
          0,
          [GROUND_TRUTH_STEPS[0]!.newLogItem!, GROUND_TRUTH_STEPS[3]!.newLogItem!],
          pvId,
          urlId,
          hourBaseMs + 60_000
        );

        payloads.push(
          {
            tenant_id: 'tenant-week',
            site_id: 'site-week',
            storage_region: 'jp',
            shard_id: 0,
            received_at_ms: hourBaseMs + 60_200,
            raw_frame: frame0,
          },
          {
            tenant_id: 'tenant-week',
            site_id: 'site-week',
            storage_region: 'jp',
            shard_id: 0,
            received_at_ms: hourBaseMs + 74_000,
            raw_frame: frame1,
          }
        );
      }

      const walRes = await writer.consumeBatch(payloads, hourBaseMs + 75_000);
      expect(walRes.acceptedCount).toBe(4);
      expect(walRes.quarantinedCount).toBe(0);
    }

    // Load live incrementally & seal all 168 hours
    const loadRes = await liveLoader.loadPendingWalObjects(
      weekStartMs + TOTAL_HOURS * HOUR_MS + HOUR_MS
    );
    expect(loadRes.committed).toBe(true);
    expect(loadRes.doublePlacementCount).toBe(0);

    const sealNowMs = weekStartMs + (TOTAL_HOURS + 2) * HOUR_MS;
    const liveSeal = liveBuilder.sealEligibleHours(liveLoader, sealNowMs);
    expect(liveSeal.sealedCells).toHaveLength(TOTAL_HOURS);

    // Full 1-week R2 WAL replay into brand-new loader & rollup builder
    const replay = await replayAllFromWal({
      region: 'jp',
      shardId: 0,
      walBucket: bucket,
      nowMs: sealNowMs,
      chunkSize: 50,
    });
    expect(replay.walObjectsReplayed).toBe(TOTAL_HOURS);
    expect(replay.totalRecordsReplayed).toBe(TOTAL_HOURS * 4);
    expect(replay.doublePlacementCount).toBe(0);
    expect(replay.controlTotals).toEqual(liveLoader.getControlTotals());

    const replayBuilder = new SealedRollupBuilder();
    const replaySeal = replayBuilder.sealEligibleHours(replay.loader, sealNowMs);
    expect(replaySeal.sealedCells).toHaveLength(TOTAL_HOURS);

    // Verify every single hour's sealed site & page rollups match identically
    for (let h = 0; h < TOTAL_HOURS; h += 1) {
      const hourMs = weekStartMs + h * HOUR_MS;
      const liveSite = liveBuilder.getCurrentSiteHourRollup(
        'tenant-week',
        'site-week',
        hourMs
      );
      const replaySite = replayBuilder.getCurrentSiteHourRollup(
        'tenant-week',
        'site-week',
        hourMs
      );
      expect(liveSite).toBeDefined();
      expect(replaySite).toEqual(liveSite);

      const livePages = liveBuilder.getCurrentPageHourRollups(
        'tenant-week',
        'site-week',
        hourMs
      );
      const replayPages = replayBuilder.getCurrentPageHourRollups(
        'tenant-week',
        'site-week',
        hourMs
      );
      expect(replayPages).toEqual(livePages);
    }
  });

  test('1-hour sealed rollups switch build_seq atomically on dirty-cell rebuilds and enforce Today seam 120-min lag ceiling', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const loader = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const builder = new SealedRollupBuilder();

    const dayStart = Date.UTC(2026, 10, 20, 0, 0, 0);
    const pv0 = '00000000000000000000000000000001';
    const pv1 = '00000000000000000000000000000002';
    const pvTail = '00000000000000000000000000000003';

    // Hour 00:00 (pv0) and Hour 01:00 (pv1)
    await writer.consumeBatch(
      [
        {
          tenant_id: 't1',
          site_id: 's1',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + 10 * 60_000,
          raw_frame: buildFrameFromStep(
            GROUND_TRUTH_STEPS[1]!,
            0,
            [GROUND_TRUTH_STEPS[1]!.newLogItem!],
            pv0,
            '501',
            dayStart + 10 * 60_000
          ),
        },
        {
          tenant_id: 't1',
          site_id: 's1',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + HOUR_MS + 10 * 60_000,
          raw_frame: buildFrameFromStep(
            GROUND_TRUTH_STEPS[1]!,
            0,
            [GROUND_TRUTH_STEPS[1]!.newLogItem!],
            pv1,
            '502',
            dayStart + HOUR_MS + 10 * 60_000
          ),
        },
      ],
      dayStart + HOUR_MS + 10 * 60_000
    );

    await loader.loadPendingWalObjects(dayStart + 2 * HOUR_MS + 35 * 60_000);

    // Seal at 02:35 UTC -> both 00:00 and 01:00 are eligible (hourEnd + 30m <= 02:35)
    const firstSeal = builder.sealEligibleHours(
      loader,
      dayStart + 2 * HOUR_MS + 35 * 60_000
    );
    expect(firstSeal.sealedCells).toHaveLength(2);
    const h0Before = builder.getManifestEntry('t1', 's1', dayStart)!;
    expect(h0Before.currentBuildSeq).toBe(1);

    // Late frame arrives for pv0 in already-sealed Hour 00:00 (higher scroll/vis)
    // Plus a new live-tail PV in unsealed Hour 02:00
    await writer.consumeBatch(
      [
        {
          tenant_id: 't1',
          site_id: 's1',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + 2 * HOUR_MS + 40 * 60_000,
          raw_frame: buildFrameFromStep(
            GROUND_TRUTH_STEPS[5]!,
            1,
            [GROUND_TRUTH_STEPS[1]!.newLogItem!, GROUND_TRUTH_STEPS[5]!.newLogItem!],
            pv0,
            '501',
            dayStart + 10 * 60_000
          ),
        },
        {
          tenant_id: 't1',
          site_id: 's1',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + 2 * HOUR_MS + 40 * 60_000,
          raw_frame: buildFrameFromStep(
            GROUND_TRUTH_STEPS[2]!,
            1,
            [GROUND_TRUTH_STEPS[2]!.newLogItem!],
            pvTail,
            '501',
            dayStart + 2 * HOUR_MS + 40 * 60_000
          ),
        },
      ],
      dayStart + 2 * HOUR_MS + 40 * 60_000
    );

    await loader.loadPendingWalObjects(dayStart + 2 * HOUR_MS + 41 * 60_000, {
      sealedHours: builder.getSealedCellKeySet(),
    });

    // Hour 00:00 should be flagged dirty with reason = late_frame
    const dirtyH0 = loader
      .getDirtyCells()
      .find((d) => d.pvHourMs === dayStart);
    expect(dirtyH0?.reason).toBe('late_frame');

    // Rebuild dirty cell -> monotonic build_seq advances atomically
    const rebuildSeal = builder.sealEligibleHours(
      loader,
      dayStart + 2 * HOUR_MS + 42 * 60_000
    );
    expect(rebuildSeal.rebuiltDirtyCells).toBe(1);
    const h0After = builder.getManifestEntry('t1', 's1', dayStart)!;
    expect(h0After.currentBuildSeq).toBeGreaterThan(h0Before.currentBuildSeq);
    const h0SiteAfter = builder.getCurrentSiteHourRollup('t1', 's1', dayStart)!;
    expect(h0SiteAfter.sumScrollMaxPx).toBe(GROUND_TRUTH_STEPS[5]!.scrollMaxPx);

    // Today seam query at 02:45 UTC (seam = 02:00, tail = 45 min <= 120 min) -> OK
    const todayOk = builder.queryTodayWithSeam(loader, {
      tenantId: 't1',
      siteId: 's1',
      windowStartMs: dayStart,
      nowMs: dayStart + 2 * HOUR_MS + 45 * 60_000,
    });
    expect(todayOk.status).toBe('ok');
    expect(todayOk.unmet_gates).toEqual([]);
    expect(todayOk.quality.sealedHoursIncluded).toBe(2);
    expect(todayOk.quality.seamHourMs).toBe(dayStart + 2 * HOUR_MS);
    expect(todayOk.totals?.pvCount).toBe(3); // pv0 + pv1 (sealed) + pvTail (unsealed tail)
    expect(todayOk.totals?.sumScrollMaxPx).toBe(
      GROUND_TRUTH_STEPS[5]!.scrollMaxPx +
        GROUND_TRUTH_STEPS[1]!.scrollMaxPx +
        GROUND_TRUTH_STEPS[2]!.scrollMaxPx
    );

    // Today seam query at 04:05 UTC when hours 02:00 & 03:00 are STILL unsealed
    // (seam = 02:00, builderLag = 125 min > 120 min) -> insufficient_data
    const todayLagged = builder.queryTodayWithSeam(loader, {
      tenantId: 't1',
      siteId: 's1',
      windowStartMs: dayStart,
      nowMs: dayStart + 4 * HOUR_MS + 5 * 60_000,
    });
    expect(todayLagged.status).toBe('insufficient_data');
    expect(todayLagged.unmet_gates).toEqual(['builder_lag']);
    expect(todayLagged.totals).toBeNull();
    expect(todayLagged.quality.builderLagMs).toBe(125 * 60_000);
  });

  test('Wave 8 Regressions (H-19, H-21): excludes lab_run_id / lab_exclusion PVs from human rollups, advances Today seam across quiet 0-PV hours, and blocks deleted subject resurrection on WAL replay', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const loader = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const builder = new SealedRollupBuilder();

    const dayStart = Date.UTC(2026, 10, 21, 0, 0, 0);
    const pvHuman = 'a0000000000000000000000000000001';
    const pvLab = 'b0000000000000000000000000000002';
    const pvDeleted = 'c0000000000000000000000000000003';

    const humanFrame = buildFrameFromStep(
      GROUND_TRUTH_STEPS[1]!,
      0,
      [GROUND_TRUTH_STEPS[1]!.newLogItem!],
      pvHuman,
      '501',
      dayStart + 5 * 60_000
    );
    const labBase = {
      ...buildFrameFromStep(
        GROUND_TRUTH_STEPS[2]!,
        0,
        [GROUND_TRUTH_STEPS[2]!.newLogItem!],
        pvLab,
        '501',
        dayStart + 10 * 60_000
      ),
      lab_run_id: 'lab_synthetic_001',
    };
    const { chk: _oldChk, ...labWithoutChk } = labBase;
    const labFrame: TelemetryFrame = {
      ...labWithoutChk,
      chk: computeFrameChecksum(labWithoutChk),
    };
    const deletedFrame = buildFrameFromStep(
      GROUND_TRUTH_STEPS[1]!,
      0,
      [GROUND_TRUTH_STEPS[1]!.newLogItem!],
      pvDeleted,
      '502',
      dayStart + 15 * 60_000
    );

    await writer.consumeBatch(
      [
        {
          tenant_id: 't-quiet',
          site_id: 's-quiet',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + 5 * 60_000,
          raw_frame: humanFrame,
        },
        {
          tenant_id: 't-quiet',
          site_id: 's-quiet',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + 10 * 60_000,
          lab_exclusion: true,
          raw_frame: labFrame,
        },
        {
          tenant_id: 't-quiet',
          site_id: 's-quiet',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: dayStart + 15 * 60_000,
          raw_frame: deletedFrame,
        },
      ],
      dayStart + 20 * 60_000
    );

    await loader.loadPendingWalObjects(dayStart + 25 * 60_000);
    loader.deletePvs('t-quiet', 's-quiet', [pvDeleted], dayStart + 30 * 60_000);
    builder.sealEligibleHours(loader, dayStart + 4 * HOUR_MS + 35 * 60_000);

    expect(builder.getCurrentSiteHourRollup('t-quiet', 's-quiet', dayStart)?.pvCount).toBe(1);

    const todayQuiet = builder.queryTodayWithSeam(loader, {
      tenantId: 't-quiet',
      siteId: 's-quiet',
      windowStartMs: dayStart,
      nowMs: dayStart + 4 * HOUR_MS + 40 * 60_000,
    });
    expect(todayQuiet.status).toBe('ok');
    expect(todayQuiet.quality.seamHourMs).toBe(dayStart + 4 * HOUR_MS);
    expect(todayQuiet.totals?.pvCount).toBe(1);

    const replay = await replayAllFromWal({
      region: 'jp',
      shardId: 0,
      walBucket: bucket,
      nowMs: dayStart + 5 * HOUR_MS,
      deletionTombstones: [{ tenantId: 't-quiet', siteId: 's-quiet', pvIds: [pvDeleted] }],
    });
    const replayedPvIds = replay.loader.getAllPvIndexRows().map((r) => r.pvId);
    expect(replayedPvIds).not.toContain(pvDeleted);
    expect(replayedPvIds).toContain(pvHuman);
  });

  test('Wave 9 Codex #10: ShardLoader handover restores committed PV state from manifest WAL keys so subsequent frames merge with newlyPlacedPvs === 0', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 23, 8, 55, 0); // 08:55 UTC
    const pvId = '1234567890abcdef1234567890abcdef';

    // 1. Loader A commits frame seq=0 for pv_1 (placed in 08:00 UTC hour)
    const frame0 = buildFrameFromStep(
      GROUND_TRUTH_STEPS[0]!,
      -1,
      [GROUND_TRUTH_STEPS[0]!.newLogItem!],
      pvId,
      '90001',
      t0
    );
    await writer.consumeBatch(
      [
        {
          tenant_id: 't-handover',
          site_id: 's-handover',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0 + 200,
          raw_frame: frame0,
        },
      ],
      t0 + 200
    );

    const loaderA = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const commitA = await loaderA.loadPendingWalObjects(t0 + 1000);
    expect(commitA.committed).toBe(true);
    expect(commitA.newlyPlacedPvs).toBe(1);
    const pv0Placement = loaderA.getPvIndexRow('t-handover', 's-handover', pvId);
    expect(pv0Placement).toBeDefined();

    // 2. Loader B takes over the same shard via syncManifestsFromBucket()
    const loaderB = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const syncedSeq = await loaderB.syncManifestsFromBucket();
    expect(syncedSeq).toBe(1);
    expect(loaderB.getControlTotals()).toEqual(loaderA.getControlTotals());
    expect(loaderB.getPvIndexRow('t-handover', 's-handover', pvId)).toEqual(pv0Placement);

    // 3. New frame seq=1 arrives in the NEXT hour (09:05 UTC) in a new WAL object
    const t1 = Date.UTC(2026, 10, 23, 9, 5, 0);
    const frame1 = buildFrameFromStep(
      GROUND_TRUTH_STEPS[3]!,
      0,
      [GROUND_TRUTH_STEPS[0]!.newLogItem!, GROUND_TRUTH_STEPS[3]!.newLogItem!],
      pvId,
      '90001',
      t0
    );
    await writer.consumeBatch(
      [
        {
          tenant_id: 't-handover',
          site_id: 's-handover',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t1,
          raw_frame: frame1,
        },
      ],
      t1
    );

    const commitB = await loaderB.loadPendingWalObjects(t1 + 1000);
    expect(commitB.committed).toBe(true);
    expect(commitB.manifestSeq).toBe(2);
    // CRITICAL: pv_1 MUST NOT be treated as a brand-new PV after handover!
    expect(commitB.newlyPlacedPvs).toBe(0);
    expect(commitB.doublePlacementCount).toBe(0);

    // Verify Loader B preserved seq=0 placement and merged seq=1 state identically to a fresh replay
    const pvIndexB = loaderB.getPvIndexRow('t-handover', 's-handover', pvId)!;
    const pvStateB = loaderB.getPvState('t-handover', 's-handover', pvId)!;
    expect(pvIndexB.pvStartSrvMs).toBe(pv0Placement!.pvStartSrvMs);
    expect(pvIndexB.pvHourMinMs).toBe(pv0Placement!.pvHourMinMs);
    expect(pvIndexB.pvHourMaxMs).toBe(pv0Placement!.pvHourMaxMs);
    expect(pvStateB.scrollMaxPx).toBe(GROUND_TRUTH_STEPS[3]!.scrollMaxPx);
    expect(pvStateB.visMs).toBe(GROUND_TRUTH_STEPS[3]!.visMs);
    expect(pvStateB.events.size).toBe(2);

    const fullReplay = await replayAllFromWal({
      region: 'jp',
      shardId: 0,
      walBucket: bucket,
      nowMs: t1 + 2000,
    });
    expect(loaderB.getControlTotals()).toEqual(fullReplay.controlTotals);
  });

  test('Wave 9 Codex #14: Monday-rounded exp_week boundary expires on exp_week without +7d lag', () => {
    // 2026-11-04 is Wednesday; + 30 days = 2026-12-04 (Friday) -> floored to Monday 2026-11-30
    const pvStartMs = Date.UTC(2026, 10, 4, 12, 0, 0);
    const placement = computeInitialPlacement({
      tenantId: 't-ttl',
      siteId: 's-ttl',
      pvId: 'aaaa1111222233334444555566667777',
      urlId: '100',
      keyVer: 1,
      profileRev: 1,
      receivedAtMs: pvStartMs,
      tMonoMs: 0,
      retentionDays: 30,
    });
    expect(placement.expWeek).toBe('2026-11-30');
    const expWeekUtcMs = Date.parse(`${placement.expWeek}T00:00:00.000Z`);
    const exactExpiryMs = pvStartMs + 30 * 86_400_000;
    // Monday floor is <= exact expiry and within 6 days prior, so TTL exp_week DELETE expires on Monday 2026-11-30 (0 extra +7d lag!)
    expect(expWeekUtcMs).toBeLessThanOrEqual(exactExpiryMs);
    expect(exactExpiryMs - expWeekUtcMs).toBeLessThan(7 * 86_400_000);
  });

  test('Wave 10 Codex R2 #10: syncManifestsFromBucket restores persisted tombstones BEFORE manifest replay (no PV resurrection) and throws MissingManifestWalError on unexplained missing WAL without advancing progress', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 23, 10, 0, 0);
    const pvDeleted = 'dddd0000111122223333444455556666';
    const pvKept = 'eeee0000111122223333444455556666';

    // 1. Write WAL containing two PVs and ingest on Loader A
    const frameDeleted = buildFrameFromStep(
      GROUND_TRUTH_STEPS[0]!,
      -1,
      [GROUND_TRUTH_STEPS[0]!.newLogItem!],
      pvDeleted,
      '91001',
      t0
    );
    const frameKept = buildFrameFromStep(
      GROUND_TRUTH_STEPS[0]!,
      -1,
      [GROUND_TRUTH_STEPS[0]!.newLogItem!],
      pvKept,
      '91002',
      t0
    );
    const walRes = await writer.consumeBatch(
      [
        {
          tenant_id: 't-r2-10',
          site_id: 's-r2-10',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0 + 100,
          raw_frame: frameDeleted,
        },
        {
          tenant_id: 't-r2-10',
          site_id: 's-r2-10',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0 + 200,
          raw_frame: frameKept,
        },
      ],
      t0 + 200
    );
    expect(walRes.walKeys).toHaveLength(1);
    const committedWalKey = walRes.walKeys[0]!;

    const loaderA = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const commitA = await loaderA.loadPendingWalObjects(t0 + 500);
    expect(commitA.committed).toBe(true);
    expect(commitA.manifestSeq).toBe(1);
    expect(loaderA.getPvIndexRow('t-r2-10', 's-r2-10', pvDeleted)).toBeDefined();

    // 2. Register deletion tombstone on Loader A -> persisted to tombstones/jp/0000/tombstones.json
    await loaderA.registerDeletionTombstones({
      tenantId: 't-r2-10',
      siteId: 's-r2-10',
      pvIds: [pvDeleted],
    });
    expect(await bucket.get(formatTombstonesObjectKey('jp', 0))).not.toBeNull();

    // 3. Loader B takes over while the old WAL STILL EXISTS in bucket -> deleted PV MUST NOT be resurrected!
    const loaderB = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const syncedSeq = await loaderB.syncManifestsFromBucket();
    expect(syncedSeq).toBe(1);
    expect(loaderB.getPvIndexRow('t-r2-10', 's-r2-10', pvDeleted)).toBeUndefined();
    expect(loaderB.getPvState('t-r2-10', 's-r2-10', pvDeleted)).toBeUndefined();
    expect(loaderB.getPvIndexRow('t-r2-10', 's-r2-10', pvKept)).toBeDefined();

    // 4. Delete the WAL object referenced by manifest 1 WITHOUT marking it intentionally purged/expired
    await bucket.delete(committedWalKey);
    const loaderC = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    await expect(loaderC.syncManifestsFromBucket()).rejects.toThrow(MissingManifestWalError);
    // Progress MUST NOT advance when manifest sync fails on missing WAL!
    expect(loaderC.getCommittedManifests()).toHaveLength(0);
    expect(loaderC.getNextManifestSeq()).toBe(1);
  });
});
