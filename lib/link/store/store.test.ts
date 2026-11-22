/**
 * UGOKI LINK v2 — Step 3 & Step 4 Storage Foundation Test Suite (`lib/link/store`)
 *
 * Covers:
 * 1. Migration DDL zero-diff vs `packages/contract/schema` + zero MV/Projection check
 * 2. URL parameter 59-pair agreeing probe classifier (§6.4 / join.G11)
 * 3. Dedicated 8 GiB ClickHouse memory budget sheet & forbidden-query checker (store.M6 / D-05)
 * 4. 14-day subject deletion engine, multi-key-version guard & certificate (§5.7 / §5.12 / store.G-8)
 * 5. Independent reconciliation closures ①–④ (store.M13 / §5.9 / store.G-10)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CANONICAL_SCHEMA,
  CODEC_VERSION,
  computeFrameChecksum,
  generateClickHouseDdl,
  generatePostgresDdl,
  type TelemetryFrame,
} from '../../../packages/contract/schema';
import { computeUrlKeyV2 } from '../../../packages/contract/urlkey';
import { InMemoryR2Bucket, WalWriter } from '../../../workers/link-wal';
import {
  HOUR_MS,
  SealedRollupBuilder,
  ShardLoader,
} from '../../../workers/link-loader';
import {
  buildSiteUrlKeyRules,
  classifyUrlParameter,
  computeTenantSubjectHmac,
  DEFAULT_8GIB_MEMORY_BUDGET,
  DeletionExecutionEngine,
  inspectQueryPolicy,
  MemoryLaneAdmissionController,
  runAllReconciliationClosures,
  runClosure4SecondImplementationRederivation,
  TenantKeyVersionRegistry,
  validateMemoryBudgetSheet,
  type DeletionStoreAdapter,
  type PageProbeSnapshot,
  type ParamProbePair,
} from './index';

function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function makeSnapshot(overrides: Partial<PageProbeSnapshot> = {}): PageProbeSnapshot {
  return {
    httpStatus: 200,
    finalUrl: 'https://shop.example.com/item/123',
    canonicalUrl: 'https://shop.example.com/item/123',
    skelFp: 'skel-aaa',
    headFp: 'head-bbb',
    bodyFp: 'body-ccc',
    productId: 'sku-123',
    priceSignature: 'JPY:4980',
    linksFp: 'links-ddd',
    ...overrides,
  };
}

function makeAgreeingPairs(count: number, paramName: string): ParamProbePair[] {
  const out: ParamProbePair[] = [];
  for (let i = 0; i < count; i += 1) {
    const snap = makeSnapshot({
      finalUrl: `https://shop.example.com/item/${i}`,
      canonicalUrl: `https://shop.example.com/item/${i}`,
      productId: `sku-${i}`,
    });
    out.push({
      pairId: `pair-${i}`,
      baseUrl: `https://shop.example.com/item/${i}`,
      paramName,
      sampleParamValueLength: 8,
      withParam: snap,
      withoutParam: snap,
      probedAtMs: Date.UTC(2026, 10, 20, 10, 0, i),
    });
  }
  return out;
}

function makeSimpleFrame(args: {
  readonly pvId: string;
  readonly seq: number;
  readonly urlId: string;
  readonly scrollMaxPx: number;
  readonly visMs: number;
  readonly tWall: number;
}): TelemetryFrame {
  const base = {
    codec_ver: CODEC_VERSION,
    schema_ver: 1,
    sdk_build: 'a1b2c3d4e5f60708',
    pv_id: args.pvId,
    seq: args.seq,
    frame_class: args.seq === 0 ? ('first' as const) : ('heartbeat' as const),
    transport: 'fetch' as const,
    full: true,
    vis_episode: 1,
    t_mono: 500 + args.seq * 2000,
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
    live_word: 0b11,
    key_degraded: false,
    state: {
      page_url_key: `example.com/p/${args.urlId}`,
      nav_type: 'navigate' as const,
      started_hidden: false,
      scroll_max_px: args.scrollMaxPx,
      doc_h_first: 2400,
      doc_h_max: 2400,
      doc_h_last: { value: 2400, seq: args.seq },
      vis_ms: args.visMs,
      reversals: 1,
      js_error_n: 0,
      degrade_level: 0,
      dom_state: 'ok' as const,
      skel_fp: '1234',
      variant_key: '5678',
      sample_pi: 1,
    },
    sections: [
      {
        sec_fp: '10',
        vis_ms: args.visMs,
        t_first_ms: 100,
        entries: 1,
        max_frac_permille: 1000,
      },
    ],
    log_items: [{ i: args.seq, kind: 'activation' as const, t_mono: 400 + args.seq * 2000, el_fp: '99' }],
  };
  return {
    ...base,
    chk: computeFrameChecksum(base),
  };
}

describe('migrations/link DDL zero-diff & safety invariants', () => {
  const migrationsDir = path.resolve(process.cwd(), 'migrations', 'link');

  test('001_clickhouse_v2.sql matches generateClickHouseDdl(CANONICAL_SCHEMA) with zero diff and zero MVs/Projections', () => {
    const fileSql = normalizeLf(
      fs.readFileSync(path.join(migrationsDir, '001_clickhouse_v2.sql'), 'utf8')
    );
    const expected = generateClickHouseDdl(CANONICAL_SCHEMA);

    expect(fileSql).toBe(normalizeLf(expected.sql));
    expect(fileSql).not.toMatch(/\bCREATE\s+MATERIALIZED\s+VIEW\b/i);
    expect(fileSql).not.toMatch(/\bPROJECTION\s+\w+\s*\(/i);

    // Every ClickHouse table (27) has both PERMISSIVE and RESTRICTIVE row policies
    const permissivePolicies = fileSql.match(/CREATE ROW POLICY IF NOT EXISTS .* AS PERMISSIVE/g) ?? [];
    const restrictivePolicies = fileSql.match(/CREATE ROW POLICY IF NOT EXISTS .* AS RESTRICTIVE/g) ?? [];
    expect(permissivePolicies).toHaveLength(expected.tableCount);
    expect(restrictivePolicies).toHaveLength(expected.tableCount);
  });

  test('002_postgres_v2.sql matches generatePostgresDdl(CANONICAL_SCHEMA) with zero diff and FORCE RLS', () => {
    const fileSql = normalizeLf(
      fs.readFileSync(path.join(migrationsDir, '002_postgres_v2.sql'), 'utf8')
    );
    const expected = generatePostgresDdl(CANONICAL_SCHEMA);

    expect(fileSql).toBe(normalizeLf(expected.sql));
    const forceRls = fileSql.match(/ALTER TABLE \w+ FORCE ROW LEVEL SECURITY;/g) ?? [];
    const restrictivePolicies = fileSql.match(/CREATE POLICY .* AS RESTRICTIVE/g) ?? [];
    expect(forceRls).toHaveLength(expected.tableCount);
    expect(restrictivePolicies).toHaveLength(expected.tableCount);
  });
});

describe('lib/link/store/url-param-classifier (§6.4 / join.G11)', () => {
  test('promotes parameter to noise ONLY at >= 59 unique agreeing pairs with 0 disagreements', () => {
    const at58 = classifyUrlParameter({
      paramName: 'ref_banner',
      pairs: makeAgreeingPairs(58, 'ref_banner'),
    });
    expect(at58.classification).toBe('unknown');
    expect(at58.keyDegraded).toBe(true);
    expect(at58.secondaryBucketStrategy).toBe('url_id_plus_head_fp');

    // Duplicate pairIds must NOT inflate 58 unique pairs to 59
    const duped58 = makeAgreeingPairs(58, 'ref_banner');
    duped58.push(duped58[0]!);
    const resDuped = classifyUrlParameter({
      paramName: 'ref_banner',
      pairs: duped58,
    });
    expect(resDuped.classification).toBe('unknown');
    expect(resDuped.agreeingPairs).toBe(58);

    // 59 unique agreeing pairs -> noise!
    const at59 = classifyUrlParameter({
      paramName: 'ref_banner',
      pairs: makeAgreeingPairs(59, 'ref_banner'),
    });
    expect(at59.classification).toBe('noise');
    expect(at59.keyDegraded).toBe(false);
    expect(at59.agreeingPairs).toBe(59);
  });

  test('classifies parameter as content if even 1 pair differs on body, price, product, links, redirect, canonical, skeleton, or head', () => {
    const dimensions: Array<Partial<PageProbeSnapshot>> = [
      { finalUrl: 'https://shop.example.com/other' },
      { canonicalUrl: 'https://shop.example.com/item/other' },
      { skelFp: 'skel-changed' },
      { headFp: 'head-changed' },
      { bodyFp: 'body-changed' },
      { productId: 'sku-different' },
      { priceSignature: 'JPY:5980' },
      { linksFp: 'links-changed' },
    ];

    for (const diffOverride of dimensions) {
      const pairs = makeAgreeingPairs(58, 'color');
      pairs.push({
        pairId: 'pair-58',
        baseUrl: 'https://shop.example.com/item/58',
        paramName: 'color',
        sampleParamValueLength: 4,
        withParam: makeSnapshot(diffOverride),
        withoutParam: makeSnapshot(),
        probedAtMs: Date.UTC(2026, 10, 20, 10, 1, 0),
      });

      const res = classifyUrlParameter({ paramName: 'color', pairs });
      expect(res.classification).toBe('content');
      expect(res.disagreeingPairs).toBe(1);
      expect(res.firstDisagreementPairId).toBe('pair-58');
      expect(res.diffDimensionsObserved.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('classifies GET-form/search inventory parameters as user_input and compiles into valid UrlKeyV2Rules', () => {
    const userInputRes = classifyUrlParameter({
      paramName: 'q',
      pairs: makeAgreeingPairs(60, 'q'),
      userInputInventory: ['q', 'keyword'],
    });
    expect(userInputRes.classification).toBe('user_input');

    const noiseRes = classifyUrlParameter({
      paramName: 'promo_track',
      pairs: makeAgreeingPairs(59, 'promo_track'),
    });
    const contentRes = classifyUrlParameter({
      paramName: 'sku',
      pairs: [
        {
          pairId: 'p0',
          baseUrl: 'https://shop.example.com/item',
          paramName: 'sku',
          sampleParamValueLength: 6,
          withParam: makeSnapshot({ productId: 'sku-A' }),
          withoutParam: makeSnapshot({ productId: 'sku-B' }),
          probedAtMs: 1,
        },
      ],
    });
    const unknownRes = classifyUrlParameter({
      paramName: 'mystery',
      pairs: makeAgreeingPairs(12, 'mystery'),
    });

    const rules = buildSiteUrlKeyRules({
      profileRev: 'site-shop/rev-4',
      classifications: [userInputRes, noiseRes, contentRes, unknownRes],
    });

    const canonical = computeUrlKeyV2(
      'https://shop.example.com/item?sku=A100&promo_track=xyz&q=tokyo&mystery=secret123',
      rules
    );
    expect(canonical.key_degraded).toBe(true);
    expect(canonical.url_key_v2).toContain('sku=A100');
    expect(canonical.url_key_v2).not.toContain('promo_track');
    expect(canonical.url_key_v2).not.toContain('tokyo');
    expect(canonical.url_key_v2).not.toContain('secret123');
    expect(canonical.unclassified_param_names).toEqual(['mystery']);
  });
});

describe('lib/link/store/memory-budget (8 GiB ClickHouse budget & forbidden queries)', () => {
  test('validates 8 GiB budget sheet totals (~5.74 GiB <= 6.12 GiB 85% cap) and rejects over-budget sheets', () => {
    const res = validateMemoryBudgetSheet(DEFAULT_8GIB_MEMORY_BUDGET);
    expect(res.valid).toBe(true);
    expect(res.workingCapGib).toBeCloseTo(6.12, 2);
    expect(res.totalBudgetedGib).toBeCloseTo(5.7375, 4);
    expect(res.headroomGib).toBeGreaterThan(0.35);

    const overBudget = {
      ...DEFAULT_8GIB_MEMORY_BUDGET,
      backgroundMergesAndMutationsGib: 2.5,
    };
    const badRes = validateMemoryBudgetSheet(overBudget);
    expect(badRes.valid).toBe(false);
    expect(badRes.violations[0]).toMatch(/exceeds 85% working cap/i);
  });

  test('enforces lane semaphores (6 live, 1 maintenance) and returns 429 Retry-After or 202 chunked job', () => {
    const controller = new MemoryLaneAdmissionController();
    const leases = [];

    for (let i = 0; i < 6; i += 1) {
      const adm = controller.tryAcquire({ lane: 'api_live', estimatedMib: 120 });
      expect(adm.admitted).toBe(true);
      if (adm.admitted) leases.push(adm.lease);
    }

    // 7th concurrent live query rejected with 429 + Retry-After
    const seventh = controller.tryAcquire({ lane: 'api_live', estimatedMib: 120 });
    expect(seventh.admitted).toBe(false);
    if (!seventh.admitted) {
      expect(seventh.httpStatus).toBe(429);
      expect(seventh.retryAfterSec).toBeGreaterThan(0);
    }

    // Releasing one slot admits the next query
    leases[0]!.release();
    const afterRelease = controller.tryAcquire({ lane: 'api_live', estimatedMib: 120 });
    expect(afterRelease.admitted).toBe(true);

    // Oversized live query (>160 MiB) routes to 202 chunked async job when allowed
    const oversized = controller.tryAcquire({
      lane: 'api_live',
      estimatedMib: 220,
      allowAsyncChunkedJob: true,
    });
    expect(oversized.admitted).toBe(false);
    if (!oversized.admitted) {
      expect(oversized.httpStatus).toBe(202);
      expect(oversized.action).toBe('route_chunked_job');
    }

    // Maintenance priority rank: builder < deletion < rebuild < extract < backfill
    expect(controller.getMaintenancePriorityRank('builder')).toBeLessThan(
      controller.getMaintenancePriorityRank('deletion')
    );
    expect(controller.getMaintenancePriorityRank('deletion')).toBeLessThan(
      controller.getMaintenancePriorityRank('backfill')
    );
  });

  test('inspectQueryPolicy catches all forbidden ClickHouse query shapes', () => {
    const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);
    const t1 = Date.UTC(2026, 10, 8, 0, 0, 0);

    // Valid scoped bounded query
    const ok = inspectQueryPolicy({
      lane: 'api_live',
      targetTable: 'page_view_state',
      tenantId: 't1',
      siteId: 's1',
      startTimeMs: t0,
      endTimeMs: t1,
      groupByColumns: ['pv_hour', 'url_id'],
    });
    expect(ok.allowed).toBe(true);
    expect(ok.httpStatus).toBe(200);

    // Missing tenant_id -> 403
    expect(
      inspectQueryPolicy({
        lane: 'api_live',
        targetTable: 'page_view_state',
        siteId: 's1',
        startTimeMs: t0,
        endTimeMs: t1,
      }).httpStatus
    ).toBe(403);

    // Missing site_id -> 400
    expect(
      inspectQueryPolicy({
        lane: 'api_live',
        targetTable: 'page_view_state',
        tenantId: 't1',
        startTimeMs: t0,
        endTimeMs: t1,
      }).httpStatus
    ).toBe(400);

    // Unbounded time range -> 429
    expect(
      inspectQueryPolicy({
        lane: 'api_live',
        targetTable: 'page_view_state',
        tenantId: 't1',
        siteId: 's1',
      }).httpStatus
    ).toBe(429);

    // Base table on right-hand side of JOIN -> 429
    const badJoin = inspectQueryPolicy({
      lane: 'api_heavy',
      targetTable: 'pv_fact',
      tenantId: 't1',
      siteId: 's1',
      startTimeMs: t0,
      endTimeMs: t1,
      rightJoinTables: ['events_v2'],
    });
    expect(badJoin.allowed).toBe(false);
    expect(badJoin.httpStatus).toBe(429);
    expect(badJoin.violations[0]).toMatch(/forbidden_right_side_base_join/);

    // Grouping by identity column not in table sort key -> 202 chunked job
    const badGroup = inspectQueryPolicy({
      lane: 'api_live',
      targetTable: 'page_view_state',
      tenantId: 't1',
      siteId: 's1',
      startTimeMs: t0,
      endTimeMs: t1,
      groupByColumns: ['visitor_key'],
    });
    expect(badGroup.allowed).toBe(false);
    expect(badGroup.httpStatus).toBe(202);
    expect(badGroup.action).toBe('route_chunked_job');

    // Exact-distinct / groupArray in api_live -> 202 chunked job (or 429 when async disabled)
    const liveExact = inspectQueryPolicy({
      lane: 'api_live',
      targetTable: 'pv_by_visitor',
      tenantId: 't1',
      siteId: 's1',
      startTimeMs: t0,
      endTimeMs: t1,
      rawSql: 'SELECT uniqExact(visitor_key), groupArray(pv_id) FROM pv_by_visitor',
      allowAsyncFallback: false,
    });
    expect(liveExact.allowed).toBe(false);
    expect(liveExact.httpStatus).toBe(429);
    expect(liveExact.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('lib/link/store/deletion-engine (14-day erasure SLA & key-version guard)', () => {
  test('refuses key-version destruction while rows > 0 and executes full 24h mask -> 5d purge -> 14d certificate with unreachable classes & §5.12 export statuses', async () => {
    const keyRegistry = new TenantKeyVersionRegistry();
    const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);

    keyRegistry.registerKeyVersion({
      tenantId: 'tenant-1',
      keyVersion: 1,
      secretSalt: 'salt-v1',
      status: 'draining',
      activeRowCount: 3,
      createdAtMs: t0 - 90 * 86_400_000,
    });
    keyRegistry.registerKeyVersion({
      tenantId: 'tenant-1',
      keyVersion: 2,
      secretSalt: 'salt-v2',
      status: 'active',
      activeRowCount: 5,
      createdAtMs: t0,
    });

    // Cannot destroy v1 while 3 rows still reference it!
    const blocked = keyRegistry.tryDestroyKeyVersion('tenant-1', 1, t0);
    expect(blocked.destroyed).toBe(false);
    expect(blocked.remainingRows).toBe(3);

    const dirtyMarkedHours: number[] = [];
    const purgedTableNames: string[] = [];

    const mockAdapter: DeletionStoreAdapter = {
      async resolveSubjectKeys({ keyedDigests }) {
        // Confirm lookup received digests for BOTH key versions v1 and v2
        expect(keyedDigests.map((d) => d.keyVersion)).toEqual([1, 2]);
        return {
          visitorKeys: ['vis-abc'],
          sessionKeys: ['sess-1'],
          pvIds: ['pv-1', 'pv-2'],
          reqUids: ['req-1'],
          unitIds: ['unit-1'],
          touchedPvHoursMs: [t0 - HOUR_MS],
          matchedKeyVersions: [1, 2],
        };
      },
      async maskSubjectImmediate() {
        return { ecMemberSummaryDeleted: 1, edgeCacheKeysPurged: 4 };
      },
      async purgeTable({ table }) {
        purgedTableNames.push(table.tableName);
        return { matchedRows: 2, deletedRows: 2 };
      },
      async purgeExternalStore({ storeSpec }) {
        return {
          deletedObjects: 1,
          status:
            storeSpec.storeKind === 'ml_extract'
              ? 'invalidated_by_epoch'
              : 'deleted',
        };
      },
      async markRollupHoursDirty({ pvHoursMs }) {
        dirtyMarkedHours.push(...pvHoursMs);
      },
      async notifyCustomerExportSinks({ deletionEpoch, nowMs }) {
        return [
          {
            sinkId: 'link-managed-r2',
            status: 'link_deleted_confirmed',
            notifiedAtMs: nowMs,
            ackedAtMs: nowMs,
            deletionEpoch,
            note: 'LINK-managed store purged directly',
          },
          {
            sinkId: 'customer-gcs-tier2',
            status: 'customer_notified_ack',
            notifiedAtMs: nowMs,
            ackedAtMs: nowMs + 500,
            deletionEpoch,
            note: 'Customer webhook returned 200 ACK',
          },
          {
            sinkId: 'customer-s3-tier2-slow',
            status: 'customer_notified_unconfirmed',
            notifiedAtMs: nowMs,
            ackedAtMs: null,
            deletionEpoch,
            note: 'Notification delivered; awaiting customer confirmation',
          },
          {
            sinkId: 'manual-csv-download',
            status: 'outside_management',
            notifiedAtMs: null,
            ackedAtMs: null,
            deletionEpoch,
            note: 'Manual historical download outside LINK lifecycle control',
          },
        ];
      },
    };

    const engine = new DeletionExecutionEngine(mockAdapter, keyRegistry);

    const scheduled = engine.scheduleRequest({
      requestId: 'del-req-001',
      tenantId: 'tenant-1',
      siteId: 'site-1',
      subjectKind: 'member_hash',
      rawSubjectValue: 'a'.repeat(64),
      requestedAtMs: t0,
    });
    expect(scheduled.state).toBe('scheduled');
    expect(scheduled.deletionEpoch).toBe(1);

    // Mask within 12h (<=24h SLA)
    const masked = await engine.executeMaskPhase('del-req-001', t0 + 12 * HOUR_MS);
    expect(masked.state).toBe('masked');

    // Physical purge at day 3 (<=5d SLA)
    const purged = await engine.executePhysicalPurgePhase(
      'del-req-001',
      t0 + 3 * 86_400_000
    );
    expect(purged.state).toBe('purged');
    expect(purgedTableNames.length).toBeGreaterThan(10);
    expect(dirtyMarkedHours).toEqual([t0 - HOUR_MS]);

    // Issue certificate at day 9 (<=14d SLA)
    const cert = engine.issueCertificate('del-req-001', t0 + 9 * 86_400_000);
    expect(cert.sla).toEqual({
      maskedWithin24h: true,
      purgedWithin5d: true,
      certifiedWithin14d: true,
    });
    expect(cert.keyVersionsSearched).toEqual([1, 2]);
    expect(cert.totalDeletedRows).toBe(cert.totalMatchedRows);
    expect(cert.exportNotifications.map((e) => e.status)).toEqual([
      'link_deleted_confirmed',
      'customer_notified_ack',
      'customer_notified_unconfirmed',
      'outside_management',
    ]);
    const unreachableCodes = cert.unreachableClasses.map((u) => u.code);
    expect(unreachableCodes).toContain('cookieless_pvs');
    expect(unreachableCodes).toContain('expired_identifiers');
    expect(unreachableCodes).toContain('sealed_address_key_destroyed');
    expect(unreachableCodes).toContain('generalised_k_statistics');

    // Subject raw value redacted after certificate
    expect(engine.getRequest('del-req-001')?.subjectDigestRedacted).toBe(true);

    // Once all v1 rows reach 0, v1 can safely be destroyed
    keyRegistry.setActiveRowCount('tenant-1', 1, 0);
    const destroyed = keyRegistry.tryDestroyKeyVersion('tenant-1', 1, t0 + 10 * 86_400_000);
    expect(destroyed.destroyed).toBe(true);

    // Overdue alert raised at day 10 for uncertified request
    engine.scheduleRequest({
      requestId: 'del-req-002',
      tenantId: 'tenant-1',
      siteId: 'site-1',
      subjectKind: 'visitor_id',
      rawSubjectValue: 'vis-late',
      requestedAtMs: t0,
    });
    const day9Status = engine.evaluateSlaStatus('del-req-002', t0 + 9 * 86_400_000);
    expect(day9Status.overdueAlertRaised).toBe(false);
    const day10Status = engine.evaluateSlaStatus('del-req-002', t0 + 10 * 86_400_000);
    expect(day10Status.overdueAlertRaised).toBe(true);
    expect(day10Status.state).toBe('overdue');
  });
});

describe('lib/link/store/reconciliation (Independent Closures ①–④)', () => {
  test('all 4 independent closures pass with abs_diff === 0 on clean pipeline and detect/invalidate discrepant cells', async () => {
    const bucket = new InMemoryR2Bucket();
    const writer = new WalWriter({ region: 'jp', bucket });
    const loader = new ShardLoader({ region: 'jp', shardId: 0, bucket });
    const builder = new SealedRollupBuilder();

    const h0 = Date.UTC(2026, 10, 20, 6, 0, 0);
    const pvA = '10000000000000000000000000000001';
    const pvB = '10000000000000000000000000000002';

    await writer.consumeBatch(
      [
        {
          tenant_id: 't-rec',
          site_id: 's-rec',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: h0 + 60_000,
          raw_frame: makeSimpleFrame({
            pvId: pvA,
            seq: 0,
            urlId: '701',
            scrollMaxPx: 1200,
            visMs: 12_000,
            tWall: h0 + 60_000,
          }),
        },
        {
          tenant_id: 't-rec',
          site_id: 's-rec',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: h0 + 120_000,
          raw_frame: makeSimpleFrame({
            pvId: pvB,
            seq: 0,
            urlId: '702',
            scrollMaxPx: 800,
            visMs: 5_000,
            tWall: h0 + 120_000,
          }),
        },
      ],
      h0 + 125_000
    );

    await loader.loadPendingWalObjects(h0 + 130_000);
    builder.sealEligibleHours(loader, h0 + HOUR_MS + 35 * 60_000);

    const cleanReport = await runAllReconciliationClosures({
      region: 'jp',
      shardId: 0,
      walBucket: bucket,
      loader,
      builder,
      nowMs: h0 + HOUR_MS + 40 * 60_000,
    });

    expect(cleanReport.allPassed).toBe(true);
    expect(cleanReport.closure1.passed).toBe(true);
    expect(cleanReport.closure1.controlTotalFrameDiff).toBe(0);
    expect(cleanReport.closure2.passed).toBe(true);
    expect(cleanReport.closure2.doublePlacementCount).toBe(0);
    expect(cleanReport.closure3.passed).toBe(true);
    expect(cleanReport.closure4.passed).toBe(true);
    expect(cleanReport.closure4.maxAbsDiff).toBe(0);

    // Inject discrepancy: write a 3rd PV into R2 WAL for h0 WITHOUT rebuilding the sealed rollup
    const pvDrifted = '10000000000000000000000000000003';
    await writer.consumeBatch(
      [
        {
          tenant_id: 't-rec',
          site_id: 's-rec',
          storage_region: 'jp',
          shard_id: 0,
          received_at_ms: h0 + 180_000,
          raw_frame: makeSimpleFrame({
            pvId: pvDrifted,
            seq: 0,
            urlId: '701',
            scrollMaxPx: 900,
            visMs: 7_000,
            tWall: h0 + 180_000,
          }),
        },
      ],
      h0 + 185_000
    );

    const driftedClosure4 = await runClosure4SecondImplementationRederivation({
      region: 'jp',
      shardId: 0,
      walBucket: bucket,
      builder,
      markInvalidOnDiscrepancy: true,
    });

    expect(driftedClosure4.passed).toBe(false);
    expect(driftedClosure4.maxAbsDiff).toBeGreaterThan(0);
    expect(driftedClosure4.invalidatedCellKeys).toHaveLength(1);

    // Invalidated cell is now flagged invalid in rollup_manifest and refused on read!
    expect(builder.getManifestEntry('t-rec', 's-rec', h0)?.state).toBe('invalid');
    expect(builder.getCurrentSiteHourRollup('t-rec', 's-rec', h0)).toBeUndefined();
  });

  test('Wave 8 Regressions (H-19, H-21): RFC 2104 computeTenantSubjectHmac matches TenantKeyVersionRegistry and DownstreamDeletionSinks execute across mask + purge + WAL tombstones', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
    const expectedRfc2104 = nodeCrypto
      .createHmac('sha256', 'secret-salt-v3')
      .update('tenant-hmac:visitor_id:vis-raw-999', 'utf8')
      .digest('hex');

    const reg = new TenantKeyVersionRegistry();
    reg.registerKeyVersion({
      tenantId: 'tenant-hmac',
      keyVersion: 3,
      secretSalt: 'secret-salt-v3',
      status: 'active',
      activeRowCount: 1,
      createdAtMs: 1000,
    });
    expect(
      reg.computeSubjectDigestsAcrossAllVersions('tenant-hmac', 'visitor_id', 'vis-raw-999')
    ).toEqual([{ keyVersion: 3, hmacHex: expectedRfc2104 }]);
    expect(
      computeTenantSubjectHmac('secret-salt-v3', 'tenant-hmac', 'visitor_id', 'vis-raw-999')
    ).toBe(expectedRfc2104);

    let tombstoneRegistered = false;
    const adapter: DeletionStoreAdapter = {
      async resolveSubjectKeys() {
        return {
          visitorKeys: [expectedRfc2104],
          sessionKeys: ['s1'],
          pvIds: ['pv-del-1'],
          reqUids: [],
          unitIds: ['pv-del-1'],
          touchedPvHoursMs: [Date.UTC(2026, 10, 20, 6, 0, 0)],
          matchedKeyVersions: [3],
        };
      },
      async maskSubjectImmediate() {
        return { ecMemberSummaryDeleted: 1, edgeCacheKeysPurged: 2 };
      },
      async purgeTable() {
        return { matchedRows: 1, deletedRows: 1 };
      },
      async purgeExternalStore() {
        return { deletedObjects: 1, status: 'deleted' };
      },
      async markRollupHoursDirty() {},
      async notifyCustomerExportSinks() {
        return [];
      },
    };

    const engine = new DeletionExecutionEngine(adapter, reg, {
      purgeLiveDurableObject: () => 1,
      purgeContinuousStreams: () => 2,
      purgeEcOrderSummary: () => 1,
      purgeHeatmapCache: () => 3,
      purgeAskAndMlFeatureCache: () => 4,
      registerWalReplayTombstones: () => {
        tombstoneRegistered = true;
      },
    });

    const t0 = Date.UTC(2026, 10, 20, 8, 0, 0);
    engine.scheduleRequest({
      requestId: 'req-sinks-1',
      tenantId: 'tenant-hmac',
      siteId: 'site-1',
      subjectKind: 'visitor_id',
      rawSubjectValue: 'vis-raw-999',
      requestedAtMs: t0,
    });
    await engine.executeMaskPhase('req-sinks-1', t0 + 1000);
    await engine.executePhysicalPurgePhase('req-sinks-1', t0 + 2000);
    const cert = engine.issueCertificate('req-sinks-1', t0 + 3000);

    expect(tombstoneRegistered).toBe(true);
    expect(cert.downstreamPurgeSummary).toEqual({
      liveDoUnitsPurged: 2,
      continuousStreamItemsPurged: 2,
      ecOrderSummariesPurged: 1,
      heatmapCacheEntriesPurged: 3,
      askAndMlCacheEntriesPurged: 4,
      walReplayTombstonesRegistered: true,
    });
  });
});
