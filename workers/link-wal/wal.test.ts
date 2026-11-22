/**
 * UGOKI LINK v2 — WAL Consumer, Bisect Quarantine, Post-Ack Loss & Tier 1/2/3 Tests
 */

import {
  CODEC_VERSION,
  computeFrameChecksum,
  type TelemetryFrame,
} from '../../packages/contract/schema';
import {
  CrossTenantWalViolationError,
  CustomerSorStorageAdapter,
  DEFAULT_POST_ACK_GRACE_MS,
  DEFAULT_QUARANTINE_RETENTION_DAYS,
  handleWalQueueBatch,
  InMemoryExportSink,
  InMemoryR2Bucket,
  LinkPlusExportStorageAdapter,
  PostAckLossDetector,
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

    // Residency mismatch rejected into quarantine rather than crossing regions
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
    expect(crossRegionRes.quarantinedCount).toBe(1);
    expect(jpBucket.keys('wal/')).toHaveLength(0);

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
});
