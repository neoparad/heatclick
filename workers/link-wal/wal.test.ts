/**
 * UGOKI LINK v2 — WAL Consumer, Bisect Quarantine, Post-Ack Loss & Tier 1/2/3 Tests
 */

import {
  CODEC_VERSION,
  computeFrameChecksum,
  sha256Hex,
  type TelemetryFrame,
} from '../../packages/contract/schema';
import {
  computeExportIdempotencyKey,
  CrossTenantWalViolationError,
  CustomerSorStorageAdapter,
  DEFAULT_POST_ACK_GRACE_MS,
  DEFAULT_QUARANTINE_RETENTION_DAYS,
  handleWalQueueBatch,
  InMemoryExportSink,
  InMemoryR2Bucket,
  LinkPlusExportStorageAdapter,
  PostAckLossDetector,
  R2_MAX_DELETE_BATCH,
  WalWriter,
  type DataRegion,
  type QuarantineObject,
  type QueueBatchLike,
  type WalObject,
  type WalQueuePayload,
} from './index';

function makeValidFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  const seq = overrides.seq ?? 0;
  const baseWithoutChk = {
    codec_ver: CODEC_VERSION,
    schema_ver: 1,
    sdk_build: 'a1b2c3d4e5f60708',
    pv_id: '0123456789abcdef0123456789abcdef',
    seq,
    frame_class: seq === 0 ? ('first' as const) : ('heartbeat' as const),
    transport: 'fetch' as const,
    full: true,
    vis_episode: 1,
    t_mono: 1000 + seq * 5000,
    t_wall: 1732000000000 + seq * 5000,
    ack_echo_seq: seq > 0 ? seq - 1 : -1,
    consent_mode: 'cookieless' as const,
    purposes: ['automation_detection', 'experiment'] as const,
    arm_bits: 1,
    def_ver: 1,
    url_id: '9007199254740993',
    key_ver: 2,
    profile_rev: 1,
    dim_tuple_code: 42,
    live_word: 0b101,
    key_degraded: false,
    state: {
      page_url_key: 'example.com/pricing',
      nav_type: 'navigate' as const,
      started_hidden: false,
      scroll_max_px: 400 + seq * 200,
      doc_h_first: 2400,
      doc_h_max: 2400,
      doc_h_last: { value: 2400, seq },
      vis_ms: 800 + seq * 4000,
      reversals: seq,
      js_error_n: 0,
      degrade_level: 0,
      dom_state: 'ok' as const,
      skel_fp: '1234567890123456',
      variant_key: '9876543210',
      sample_pi: 1,
    },
    sections: [
      {
        sec_fp: '1001',
        vis_ms: 500 + seq * 1000,
        t_first_ms: 200,
        entries: 1,
        max_frac_permille: 850,
      },
    ],
    log_items: [
      {
        i: seq,
        kind: 'activation' as const,
        t_mono: 900 + seq * 5000,
        el_fp: '55555',
      },
    ],
    ...overrides,
  };

  const chk = computeFrameChecksum(baseWithoutChk);
  return {
    ...baseWithoutChk,
    chk,
  };
}

function makeQueuePayload(
  frame: unknown,
  overrides: Partial<WalQueuePayload> = {}
): WalQueuePayload {
  return {
    tenant_id: 'tenant-alpha',
    site_id: 'site-main',
    storage_region: 'jp',
    shard_id: 0,
    received_at_ms: 1732000060000,
    age_ms: 0,
    retention_days: 395,
    raw_frame: frame,
    ...overrides,
  };
}

describe('workers/link-wal', () => {
  test('writes immutable content-addressed WAL objects and deduplicates identical retries', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });

    const payload0 = makeQueuePayload(makeValidFrame({ seq: 0 }), {
      received_at_ms: Date.UTC(2026, 10, 20, 10, 15, 12),
    });
    const payload1 = makeQueuePayload(makeValidFrame({ seq: 1 }), {
      received_at_ms: Date.UTC(2026, 10, 20, 10, 15, 25),
    });

    const first = await writer.consumeBatch(
      [payload0, payload1],
      Date.UTC(2026, 10, 20, 10, 15, 30)
    );
    expect(first.acceptedCount).toBe(2);
    expect(first.quarantinedCount).toBe(0);
    expect(first.bisectSplits).toBe(0);
    expect(first.walKeys).toHaveLength(1);
    expect(first.walKeys[0]).toMatch(
      /^wal\/jp\/0000\/tenant-alpha\/site-main\/20261120T1015Z\/[0-9a-f]{64}\.json$/
    );
    expect(first.dedupedObjectsCount).toBe(0);

    // Exact retry produces identical content hash -> conditional put deduplicates cleanly
    const retry = await writer.consumeBatch(
      [payload0, payload1],
      Date.UTC(2026, 10, 20, 10, 15, 35)
    );
    expect(retry.walKeys[0]).toBe(first.walKeys[0]);
    expect(retry.dedupedObjectsCount).toBe(1);
    expect(bucket.keys('wal/jp/')).toHaveLength(1);

    const stored = await bucket.get(first.walKeys[0]!);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(await stored!.text()) as WalObject;
    expect(parsed.wal_version).toBe(1);
    expect(parsed.region).toBe('jp');
    expect(parsed.record_count).toBe(2);
  });

  test('binary-search (bisect) quarantine isolates poison frames while committing all valid frames', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);

    const batch: WalQueuePayload[] = [];
    for (let i = 0; i < 16; i += 1) {
      if (i === 3) {
        // Poison #1: malformed JSON string
        batch.push(
          makeQueuePayload('{"pv_id":"not-closed', {
            received_at_ms: nowMs + i * 100,
          })
        );
      } else if (i === 11) {
        // Poison #2: invalid envelope (bad pv_id + raw secret text inside payload)
        batch.push(
          makeQueuePayload(
            {
              codec_ver: CODEC_VERSION,
              schema_ver: 1,
              pv_id: 'deadbeefdeadbeefdeadbeefdeadbeef',
              seq: 'secret-raw-user-input-should-not-leak',
              frame_class: 'first',
            },
            {
              received_at_ms: nowMs + i * 100,
            }
          )
        );
      } else {
        batch.push(
          makeQueuePayload(
            makeValidFrame({
              pv_id: `${i.toString(16).padStart(32, '0')}`,
              seq: 0,
            }),
            { received_at_ms: nowMs + i * 100 }
          )
        );
      }
    }

    const res = await writer.consumeBatch(batch, nowMs);
    expect(res.acceptedCount).toBe(14);
    expect(res.quarantinedCount).toBe(2);
    expect(res.bisectSplits).toBeGreaterThanOrEqual(2);
    expect(res.quarantineKeys).toHaveLength(2);

    // Inspect quarantine object #2: stored encrypted in R2 (AES-256-GCM), raw string sanitized, 7-day retention set
    const qObj2Raw = await bucket.get(res.quarantineKeys[1]!);
    expect(qObj2Raw).not.toBeNull();
    const qText = await qObj2Raw!.text();
    expect(qText).not.toContain('secret-raw-user-input-should-not-leak');
    expect(qText).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef');
    const qEnvelope = JSON.parse(qText) as { encrypted?: boolean; alg?: string };
    expect(qEnvelope.encrypted).toBe(true);
    expect(qEnvelope.alg).toBe('AES-256-GCM');
    const qObj2 = (await writer.readQuarantineObject(
      res.quarantineKeys[1]!,
      'tenant-alpha',
      'site-main'
    ))!;
    expect(qObj2).not.toBeNull();
    expect(qObj2.pv_id).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    expect(qObj2.expires_at_ms - qObj2.received_at_ms).toBe(
      DEFAULT_QUARANTINE_RETENTION_DAYS * 86_400_000
    );

    // Deletion coverage on quarantine by pv_id
    const delRes = await writer.deleteQuarantineByPvIds(
      'tenant-alpha',
      'site-main',
      ['deadbeefdeadbeefdeadbeefdeadbeef']
    );
    expect(delRes.deletedKeys).toHaveLength(1);
    expect(await bucket.get(res.quarantineKeys[1]!)).toBeNull();

    // Remaining quarantine object is re-ingestable before 7d expiry
    const reingest = await writer.reingestQuarantine({
      tenantId: 'tenant-alpha',
      siteId: 'site-main',
      nowMs: nowMs + 60_000,
      repair: (entry) =>
        makeQueuePayload(
          makeValidFrame({
            pv_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            seq: 0,
          }),
          {
            tenant_id: entry.tenant_id,
            site_id: entry.site_id,
            storage_region: entry.region,
            shard_id: entry.shard_id,
            received_at_ms: entry.received_at_ms,
          }
        ),
    });
    expect(reingest.reingestedCount).toBe(1);
    expect(reingest.deletedQuarantineKeys).toHaveLength(1);
    expect(bucket.keys('quarantine/jp/')).toHaveLength(0);
  });

  test('purges expired quarantine entries after 7-day retention ceiling', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);

    await writer.consumeBatch(
      [makeQueuePayload({ broken: true }, { received_at_ms: t0 })],
      t0
    );
    expect(bucket.keys('quarantine/jp/')).toHaveLength(1);

    // At day 6 -> still retained
    const day6 = await writer.purgeExpiredQuarantine(t0 + 6 * 86_400_000);
    expect(day6.purgedKeys).toHaveLength(0);

    // At day 7 -> purged
    const day7 = await writer.purgeExpiredQuarantine(t0 + 7 * 86_400_000);
    expect(day7.purgedKeys).toHaveLength(1);
    expect(bucket.keys('quarantine/jp/')).toHaveLength(0);
  });

  test('detects post-ack loss via ack_echo_seq after 10-minute grace window', async () => {
    const bucket = new InMemoryR2Bucket();
    const detector = new PostAckLossDetector();
    const writer = new WalWriter({
      region: 'jp',
      bucket,
      postAckDetector: detector,
    });

    const t0 = Date.UTC(2026, 10, 20, 14, 0, 0);
    const pvId = '11111111111111111111111111111111';

    // Frame seq=0 was ACKed at edge, then lost before WAL!
    // Frame seq=1 arrives echoing ack_echo_seq=0.
    const frame1 = makeValidFrame({ pv_id: pvId, seq: 1, ack_echo_seq: 0 });
    await writer.consumeBatch(
      [makeQueuePayload(frame1, { received_at_ms: t0 })],
      t0
    );

    // Before 10 minutes: pending within grace, 0 confirmed missing
    const reportAt9m = detector.evaluate(t0 + DEFAULT_POST_ACK_GRACE_MS - 60_000);
    expect(reportAt9m.pendingWithinGraceCount).toBe(1);
    expect(reportAt9m.confirmedMissingCount).toBe(0);
    expect(reportAt9m.gatePassed).toBe(true);

    // At 10 minutes: confirmed post-ack loss of seq=0
    const reportAt10m = detector.evaluate(t0 + DEFAULT_POST_ACK_GRACE_MS);
    expect(reportAt10m.confirmedMissingCount).toBe(1);
    expect(reportAt10m.confirmedMissing[0]?.pvId).toBe(pvId);
    expect(reportAt10m.confirmedMissing[0]?.seq).toBe(0);
    expect(reportAt10m.confirmedMissing[0]?.proofSource).toBe('ack_echo_seq');
    expect(reportAt10m.postAckLossRate).toBe(1);
    expect(reportAt10m.gatePassed).toBe(false);

    // Once seq=0 commits, post-ack loss drops to 0
    const frame0 = makeValidFrame({ pv_id: pvId, seq: 0, ack_echo_seq: -1 });
    await writer.consumeBatch(
      [makeQueuePayload(frame0, { received_at_ms: t0 + 1000 })],
      t0 + 1000
    );
    const reportRecovered = detector.evaluate(t0 + DEFAULT_POST_ACK_GRACE_MS);
    expect(reportRecovered.confirmedMissingCount).toBe(0);
    expect(reportRecovered.confirmedPresentCount).toBe(1);
    expect(reportRecovered.postAckLossRate).toBe(0);
    expect(reportRecovered.gatePassed).toBe(true);
  });

  test('enforces Decision 29 data residency region pinning and §5.12 storage tiers 1/2/3', async () => {
    const t0 = Date.UTC(2026, 10, 20, 15, 0, 0);

    // Residency mismatch rejected WITHOUT writing to local WAL or local quarantine (Codex #11 / §11.11.13)
    const jpBucket = new InMemoryR2Bucket();
    const jpWriter = new WalWriter({ region: 'jp', bucket: jpBucket });
    const crossRegionRes = await jpWriter.consumeBatch(
      [
        makeQueuePayload(makeValidFrame({ seq: 0 }), {
          storage_region: 'eu' as DataRegion,
          received_at_ms: t0,
        }),
      ],
      t0
    );
    expect(crossRegionRes.acceptedCount).toBe(0);
    expect(crossRegionRes.quarantinedCount).toBe(0);
    expect(crossRegionRes.regionMismatchCount).toBe(1);
    expect(crossRegionRes.rejectedRegionMismatch).toHaveLength(1);
    expect(jpBucket.keys('wal/')).toHaveLength(0);
    expect(jpBucket.keys('quarantine/')).toHaveLength(0);

    // Tier 2: LINK-hosted primary + continuous export sink
    const primaryBucket = new InMemoryR2Bucket();
    const exportSink = new InMemoryExportSink('customer-gcs-jp', 'jp');
    const tier2Adapter = new LinkPlusExportStorageAdapter(
      primaryBucket,
      exportSink,
      'jp'
    );
    const tier2Writer = new WalWriter({
      region: 'jp',
      adapter: tier2Adapter,
      deletionEpoch: 7,
    });
    const tier2Res = await tier2Writer.consumeBatch(
      [makeQueuePayload(makeValidFrame({ seq: 0 }), { received_at_ms: t0 })],
      t0
    );
    expect(tier2Res.acceptedCount).toBe(1);
    expect(tier2Res.exportReceipts).toHaveLength(1);
    expect(tier2Res.exportReceipts[0]?.deletionEpoch).toBe(7);
    expect(exportSink.receipts).toHaveLength(1);
    expect(primaryBucket.keys('wal/jp/')).toHaveLength(1);

    // Tier 3: Customer-hosted System of Record (LINK retains zero primary copy)
    const linkBucket = new InMemoryR2Bucket();
    const customerBucket = new InMemoryR2Bucket();
    const tier3Adapter = new CustomerSorStorageAdapter(
      customerBucket,
      'cust-sor-eu-01',
      'eu'
    );
    expect(tier3Adapter.descriptor.linkRetainsPrimaryCopy).toBe(false);
    const tier3Writer = new WalWriter({ region: 'eu', adapter: tier3Adapter });
    const tier3Res = await tier3Writer.consumeBatch(
      [
        makeQueuePayload(makeValidFrame({ seq: 0 }), {
          storage_region: 'eu',
          received_at_ms: t0,
        }),
      ],
      t0
    );
    expect(tier3Res.acceptedCount).toBe(1);
    expect(customerBucket.keys('wal/eu/')).toHaveLength(1);
    expect(linkBucket.keys()).toHaveLength(0);
  });

  test('handleWalQueueBatch processes queue messages and acks every message', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const ackedIds: string[] = [];

    const batch: QueueBatchLike<WalQueuePayload> = {
      queue: 'ugokilink-wal-jp',
      messages: [
        {
          id: 'msg-1',
          timestamp: new Date(Date.UTC(2026, 10, 20, 16, 0, 0)),
          body: makeQueuePayload(makeValidFrame({ seq: 0 })),
          ack: () => ackedIds.push('msg-1'),
          retry: () => {
            throw new Error('should not retry');
          },
        },
        {
          id: 'msg-2',
          timestamp: new Date(Date.UTC(2026, 10, 20, 16, 0, 1)),
          body: makeQueuePayload(makeValidFrame({ seq: 1 })),
          ack: () => ackedIds.push('msg-2'),
          retry: () => {
            throw new Error('should not retry');
          },
        },
      ],
    };

    const res = await handleWalQueueBatch(batch, writer);
    expect(res.acceptedCount).toBe(2);
    expect(ackedIds).toEqual(['msg-1', 'msg-2']);
  });

  test('Wave 8 Regressions (C-05, C-15): accepts CanonicalWalQueueEnvelope (frame + lane + lab_exclusion), splits mixed-tenant batches per (tenant, site), blocks cross-tenant Tier 2/3 WAL objects, and enforces tenant AAD on encrypted quarantine', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 20, 17, 0, 0);

    const res = await writer.consumeBatch(
      [
        {
          tenant_id: 'tenant-one',
          site_id: 'site-a',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0,
          lane: 'standard',
          lab_exclusion: true,
          frame: makeValidFrame({ pv_id: '11111111111111111111111111111111', seq: 0 }),
        },
        {
          tenant_id: 'tenant-two',
          site_id: 'site-b',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0,
          lane: 'customer_defined',
          frame: makeValidFrame({ pv_id: '22222222222222222222222222222222', seq: 0 }),
        },
        {
          tenant_id: 'tenant-one',
          site_id: 'site-a',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0,
          frame: '{corrupt-quarantine',
        },
      ],
      t0
    );

    expect(res.acceptedCount).toBe(2);
    expect(res.walKeys).toHaveLength(2);
    expect(res.walKeys.some((k) => k.includes('/tenant-one/site-a/'))).toBe(true);
    expect(res.walKeys.some((k) => k.includes('/tenant-two/site-b/'))).toBe(true);

    for (const wk of res.walKeys) {
      const obj = JSON.parse(await (await bucket.get(wk))!.text()) as WalObject;
      expect(new Set(obj.records.map((r) => r.tenant_id)).size).toBe(1);
    }

    expect(res.quarantineKeys).toHaveLength(1);
    expect(
      await writer.readQuarantineObject(res.quarantineKeys[0]!, 'tenant-two', 'site-b')
    ).toBeNull();
    expect(
      await writer.readQuarantineObject(res.quarantineKeys[0]!, 'tenant-one', 'site-a')
    ).not.toBeNull();

    const tier2 = new LinkPlusExportStorageAdapter(
      new InMemoryR2Bucket(),
      new InMemoryExportSink('sink-1', 'jp'),
      'jp'
    );
    const mixedWal: WalObject = {
      wal_version: 1,
      region: 'jp',
      shard_id: 0,
      tenant_id: 'tenant-one',
      site_id: 'site-a',
      minute_utc: '20261120T1700Z',
      created_at_ms: t0,
      content_sha256: 'a'.repeat(64),
      record_count: 2,
      records: [
        {
          tenant_id: 'tenant-one',
          site_id: 'site-a',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0,
          age_ms: 0,
          retention_days: 395,
          frame_hash: 'h1',
          frame: makeValidFrame({ seq: 0 }),
        },
        {
          tenant_id: 'tenant-two',
          site_id: 'site-b',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: t0,
          age_ms: 0,
          retention_days: 395,
          frame_hash: 'h2',
          frame: makeValidFrame({ seq: 1 }),
        },
      ],
    };
    await expect(
      tier2.putWalImmutable({
        key: 'wal/jp/0000/test.json',
        body: JSON.stringify(mixedWal),
        tenantIds: ['tenant-one', 'tenant-two'],
        deletionEpoch: 1,
        nowMs: t0,
      })
    ).rejects.toThrow(CrossTenantWalViolationError);
  });

  test('Wave 9 Codex #11: wrong-region delivery NEVER writes to local region WAL or quarantine, reroutes via sink when configured, and retries when un-rerouted', async () => {
    const t0 = Date.UTC(2026, 10, 23, 6, 0, 0);
    const euPayload = makeQueuePayload(makeValidFrame({ seq: 0 }), {
      storage_region: 'eu',
      received_at_ms: t0,
    });

    // 1. Without reroute sink: 0 objects in JP WAL and JP quarantine; queue message is retried (not acked)
    const jpBucket1 = new InMemoryR2Bucket();
    const jpWriter1 = new WalWriter({ region: 'jp', bucket: jpBucket1 });
    let acked = 0;
    let retried = 0;
    const res1 = await handleWalQueueBatch(
      {
        queue: 'ugokilink-wal-jp',
        messages: [
          {
            id: 'eu-misrouted-1',
            timestamp: new Date(t0),
            body: euPayload,
            ack: () => {
              acked += 1;
            },
            retry: () => {
              retried += 1;
            },
          },
        ],
      },
      jpWriter1,
      t0
    );
    expect(res1.acceptedCount).toBe(0);
    expect(res1.quarantinedCount).toBe(0);
    expect(res1.regionMismatchCount).toBe(1);
    expect(res1.rejectedRegionMismatch).toHaveLength(1);
    expect(jpBucket1.keys('wal/')).toHaveLength(0);
    expect(jpBucket1.keys('quarantine/')).toHaveLength(0);
    expect(jpBucket1.size()).toBe(0);
    expect(acked).toBe(0);
    expect(retried).toBe(1);

    // 2. With regionRerouteSink: forwarded to reroute sink with 0 local storage
    const jpBucket2 = new InMemoryR2Bucket();
    const rerouted: Array<{ expected: DataRegion; actual: string; payload: WalQueuePayload }> = [];
    const jpWriter2 = new WalWriter({
      region: 'jp',
      bucket: jpBucket2,
      regionRerouteSink: {
        reroute: (item, expected, actual) => {
          rerouted.push({ expected, actual, payload: item });
        },
      },
    });
    const res2 = await jpWriter2.consumeBatch([euPayload], t0);
    expect(res2.acceptedCount).toBe(0);
    expect(res2.quarantinedCount).toBe(0);
    expect(res2.regionMismatchCount).toBe(1);
    expect(res2.reroutedPayloads).toHaveLength(1);
    expect(res2.rejectedRegionMismatch).toHaveLength(0);
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0]).toMatchObject({ expected: 'jp', actual: 'eu' });
    expect(jpBucket2.size()).toBe(0);
  });

  test('Wave 9 Codex #12: Tier 2 customer export recovers on retry after primary write succeeds and export fails, then becomes an idempotent no-op on attempt 3', async () => {
    const t0 = Date.UTC(2026, 10, 23, 6, 10, 0);
    const primaryBucket = new InMemoryR2Bucket();
    const innerSink = new InMemoryExportSink('customer-gcs-jp-recovery', 'jp');
    let failNextExport = true;
    let exportCalls = 0;

    const flakySink = {
      sinkId: innerSink.sinkId,
      region: innerSink.region,
      async writeExportBatch(args: Parameters<InMemoryExportSink['writeExportBatch']>[0]) {
        exportCalls += 1;
        if (failNextExport) {
          failNextExport = false;
          throw new Error('Customer export sink 503 transient failure');
        }
        return innerSink.writeExportBatch(args);
      },
    };

    const tier2Adapter = new LinkPlusExportStorageAdapter(primaryBucket, flakySink, 'jp');
    const writer = new WalWriter({ region: 'jp', adapter: tier2Adapter, deletionEpoch: 9 });
    const payload = makeQueuePayload(makeValidFrame({ seq: 0 }), { received_at_ms: t0 });

    // Attempt 1: Primary R2 WAL write succeeds, customer export fails -> throws so queue does NOT ACK
    await expect(writer.consumeBatch([payload], t0)).rejects.toThrow(/503 transient failure/);
    expect(primaryBucket.keys('wal/jp/')).toHaveLength(1);
    expect(primaryBucket.keys('export-receipts/jp/')).toHaveLength(0);
    expect(innerSink.receipts).toHaveLength(0);
    expect(exportCalls).toBe(1);

    // Attempt 2: Retry same WAL object -> primary is deduped (written === false), YET customer export IS delivered + receipt recorded!
    const attempt2 = await writer.consumeBatch([payload], t0 + 1000);
    expect(attempt2.dedupedObjectsCount).toBe(1);
    expect(attempt2.exportReceipts).toHaveLength(1);
    expect(innerSink.receipts).toHaveLength(1);
    expect(primaryBucket.keys('export-receipts/jp/')).toHaveLength(1);
    expect(exportCalls).toBe(2);

    // Attempt 3: Duplicate retry -> receipt already exists -> clean idempotent no-op (exportSink NOT called again!)
    const attempt3 = await writer.consumeBatch([payload], t0 + 2000);
    expect(attempt3.dedupedObjectsCount).toBe(1);
    expect(attempt3.exportReceipts).toHaveLength(0);
    expect(innerSink.receipts).toHaveLength(1);
    expect(exportCalls).toBe(2);
  });

  test('Wave 9 Codex #13: quarantine subject deletion and expired cleanup paginate beyond 1,000 objects (page 2)', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);
    const TOTAL_OBJECTS = 1050;
    const TARGET_PV_ID = 'ffffffffffffffffffffffffffffffff';

    // Populate 1,050 quarantine objects directly under quarantine/jp/tenant-page/site-page/
    // Keys are sorted lexicographically, so index 1020 and 1040 are guaranteed to land on page 2 (> 1,000)!
    for (let i = 0; i < TOTAL_OBJECTS; i += 1) {
      const idxStr = String(i).padStart(4, '0');
      const key = `quarantine/jp/tenant-page/site-page/2026-11-01/obj_${idxStr}.json`;
      const isExpiredOnPage2 = i === 1040;
      const expiresAtMs = isExpiredOnPage2 ? t0 - 1000 : t0 + 14 * 86_400_000;
      await bucket.put(
        key,
        JSON.stringify({ expires_at_ms: expiresAtMs }),
        {
          customMetadata: {
            tenant_id: 'tenant-page',
            site_id: 'site-page',
            expires_at_ms: String(expiresAtMs),
          },
        }
      );
    }

    // Write one real encrypted quarantine entry for TARGET_PV_ID on a later day so it sorts onto page 2 (> 1,000)!
    const targetRes = await writer.consumeBatch(
      [
        makeQueuePayload(
          {
            codec_ver: CODEC_VERSION,
            schema_ver: 1,
            pv_id: TARGET_PV_ID,
            seq: 'invalid-seq-triggers-quarantine',
            frame_class: 'first',
          },
          {
            tenant_id: 'tenant-page',
            site_id: 'site-page',
            storage_region: 'jp',
            received_at_ms: t0 + 2 * 86_400_000, // 2026-11-03 sorts after all 1,050 2026-11-01 keys!
          }
        ),
      ],
      t0 + 2 * 86_400_000
    );
    expect(targetRes.quarantinedCount).toBe(1);
    const targetKey = targetRes.quarantineKeys[0]!;
    const allBefore = bucket.keys('quarantine/jp/tenant-page/site-page/');
    expect(allBefore).toHaveLength(TOTAL_OBJECTS + 1);
    expect(allBefore.indexOf(targetKey)).toBeGreaterThanOrEqual(1000);

    // 1. Subject deletion scans ALL pages (> 1,000) and deletes page-2 target PV!
    const delRes = await writer.deleteQuarantineByPvIds(
      'tenant-page',
      'site-page',
      [TARGET_PV_ID]
    );
    expect(delRes.scannedCount).toBe(TOTAL_OBJECTS + 1);
    expect(delRes.deletedKeys).toEqual([targetKey]);
    expect(await bucket.get(targetKey)).toBeNull();

    // 2. Expired quarantine sweep scans ALL pages (> 1,000) and purges page-2 expired entry!
    const purgeRes = await writer.purgeExpiredQuarantine(t0);
    expect(purgeRes.scannedCount).toBe(TOTAL_OBJECTS);
    expect(purgeRes.purgedKeys).toEqual([
      'quarantine/jp/tenant-page/site-page/2026-11-01/obj_1040.json',
    ]);
    expect(
      await bucket.get('quarantine/jp/tenant-page/site-page/2026-11-01/obj_1040.json')
    ).toBeNull();
  });

  test('Wave 10 Codex R2 #11: region pinning is checked BEFORE missing site_id / tenant_id so wrong-region malformed payloads write 0 local WAL or quarantine objects', async () => {
    const jpBucket = new InMemoryR2Bucket();
    const jpWriter = new WalWriter({ region: 'jp', bucket: jpBucket });
    const t0 = Date.UTC(2026, 10, 23, 11, 0, 0);

    const euMissingSite = makeQueuePayload(makeValidFrame({ seq: 0 }), {
      tenant_id: 'tenant-eu-01',
      site_id: '',
      storage_region: 'eu',
      received_at_ms: t0,
    });
    const euMissingTenant = makeQueuePayload(makeValidFrame({ seq: 1 }), {
      tenant_id: '',
      site_id: '',
      storage_region: 'eu',
      received_at_ms: t0,
    });

    const res = await jpWriter.consumeBatch([euMissingSite, euMissingTenant], t0);
    expect(res.acceptedCount).toBe(0);
    expect(res.quarantinedCount).toBe(0);
    expect(res.regionMismatchCount).toBe(2);
    expect(res.rejectedRegionMismatch).toHaveLength(2);
    expect(jpBucket.keys('wal/')).toHaveLength(0);
    expect(jpBucket.keys('quarantine/')).toHaveLength(0);
    expect(jpBucket.size()).toBe(0);
  });

  test('Wave 10 Codex R2 #12: Tier 2 export uses deterministic (sinkId, walKey) idempotencyKey so receipt-write failure + retry produces strictly 1 exported batch', async () => {
    const t0 = Date.UTC(2026, 10, 23, 12, 0, 0);
    const primaryBucket = new InMemoryR2Bucket();
    const innerReceiptBucket = new InMemoryR2Bucket();
    const innerSink = new InMemoryExportSink('customer-gcs-jp-idem', 'jp');
    let failReceiptPutOnce = true;

    const flakyReceiptBucket = {
      put: async (
        key: string,
        value: string | Uint8Array | ArrayBuffer,
        options?: Parameters<InMemoryR2Bucket['put']>[2]
      ) => {
        if (failReceiptPutOnce) {
          failReceiptPutOnce = false;
          throw new Error('Transient R2 receipt put failure');
        }
        return innerReceiptBucket.put(key, value, options);
      },
      get: (key: string) => innerReceiptBucket.get(key),
      head: (key: string) => innerReceiptBucket.head(key),
      list: (options?: Parameters<InMemoryR2Bucket['list']>[0]) =>
        innerReceiptBucket.list(options),
      delete: (keys: string | readonly string[]) => innerReceiptBucket.delete(keys),
    };

    const tier2Adapter = new LinkPlusExportStorageAdapter(
      primaryBucket,
      innerSink,
      'jp',
      undefined,
      flakyReceiptBucket
    );
    const writer = new WalWriter({ region: 'jp', adapter: tier2Adapter, deletionEpoch: 4 });
    const payload = makeQueuePayload(makeValidFrame({ seq: 0 }), { received_at_ms: t0 });

    // Attempt 1: Export sink succeeds, ONLY receipt persistence fails -> throws for retry
    await expect(writer.consumeBatch([payload], t0)).rejects.toThrow(
      /Transient R2 receipt put failure/
    );
    expect(innerSink.receipts).toHaveLength(1);
    expect(innerReceiptBucket.keys('export-receipts/jp/')).toHaveLength(0);

    // Attempt 2: Retry sends the EXACT same deterministic idempotencyKey -> sink deduplicates, strictly 1 batch stored!
    const attempt2 = await writer.consumeBatch([payload], t0 + 1000);
    expect(attempt2.dedupedObjectsCount).toBe(1);
    expect(attempt2.exportReceipts).toHaveLength(1);
    expect(innerSink.receipts).toHaveLength(1);
    expect(innerSink.seenIdempotencyKeys).toHaveLength(2);
    expect(innerSink.seenIdempotencyKeys[0]).toBe(innerSink.seenIdempotencyKeys[1]);

    const walKey = primaryBucket.keys('wal/jp/')[0]!;
    const expectedIdemKey = sha256Hex(`${innerSink.sinkId}\u0000${walKey}`);
    expect(expectedIdemKey).toBe(computeExportIdempotencyKey(innerSink.sinkId, walKey));
    expect(innerSink.seenIdempotencyKeys[0]).toBe(expectedIdemKey);
    expect(innerSink.receipts[0]!.idempotencyKey).toBe(expectedIdemKey);
    expect(innerReceiptBucket.keys('export-receipts/jp/')).toHaveLength(1);
  });

  test('Wave 10 Codex R2 #13: bulk quarantine deletion chunks bucket.delete calls to at most 1,000 keys per call and deletes all 1,050 matching objects', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const t0 = Date.UTC(2026, 10, 23, 13, 0, 0);
    const TOTAL_MATCHING = 1050;

    // Populate 1,050 expired quarantine objects all matching the expired sweep window
    for (let i = 0; i < TOTAL_MATCHING; i += 1) {
      const idxStr = String(i).padStart(4, '0');
      const key = `quarantine/jp/tenant-chunk/site-chunk/2026-11-01/exp_${idxStr}.json`;
      await bucket.put(key, JSON.stringify({ expires_at_ms: t0 - 5000 }), {
        customMetadata: {
          tenant_id: 'tenant-chunk',
          site_id: 'site-chunk',
          expires_at_ms: String(t0 - 5000),
        },
      });
    }
    expect(bucket.keys('quarantine/jp/tenant-chunk/site-chunk/')).toHaveLength(TOTAL_MATCHING);

    const deleteBatchSizes: number[] = [];
    const origDelete = bucket.delete.bind(bucket);
    const deleteSpy = jest
      .spyOn(bucket, 'delete')
      .mockImplementation(async (keys: string | readonly string[]) => {
        const size = typeof keys === 'string' ? 1 : keys.length;
        deleteBatchSizes.push(size);
        return origDelete(keys);
      });

    const purgeRes = await writer.purgeExpiredQuarantine(t0);
    expect(purgeRes.scannedCount).toBe(TOTAL_MATCHING);
    expect(purgeRes.purgedKeys).toHaveLength(TOTAL_MATCHING);
    expect(bucket.keys('quarantine/jp/tenant-chunk/site-chunk/')).toHaveLength(0);

    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteBatchSizes).toEqual([R2_MAX_DELETE_BATCH, TOTAL_MATCHING - R2_MAX_DELETE_BATCH]);
    for (const sz of deleteBatchSizes) {
      expect(sz).toBeLessThanOrEqual(R2_MAX_DELETE_BATCH);
    }
    deleteSpy.mockRestore();
  });
});
