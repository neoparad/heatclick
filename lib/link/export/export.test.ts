/**
 * UGOKI LINK v2 — Bundle 4-B Test Suite (`lib/link/export`)
 *
 * Covers:
 * 1. 5 Warehouses + Parquet open contract, zero cross-tenant/pooled leakage,
 *    recipient-aware suppression (Tier 2 no <10 vs external <10 + non-overlap + complementary), 15m SLA
 * 2. 4 Continuous Streams (webhook/pubsub/kafka/kinesis), 72h retry, per-retry revocation/deletion
 *    re-check, post-delivery deletion & `deletion_unconfirmed`, loss ledger, auto-pause
 * 3. 3-Category Destination Governance (D-30 + legal + approved exceptions + relay propagation)
 *    & fixed 50 declarative destinations dry-run validation
 * 4. Sandboxed customer destination functions (no net/creds/timeout/size cap) + LINK sender
 *    (host allowlist, DNS SSRF private/loopback/metadata block, redirect check, field filter, creds binding)
 * 5. §5.12 3-tier storage self-diagnostics & 4-state deletion proof
 * 6. §11.11 #7 Tenant-scoped RO SQL interface (`lib/link/isolation` AST + view/fn whitelists + response envelope)
 * 7. §11.11 #1/#7 Unmanned self-serve onboarding + public pricing & monthly cost calculator
 */

import { IdentityKeyRegistry, verifyPublicKeyStateless, type VerifiedPrincipal } from '../auth';
import { perTenantRoUsername } from '../isolation';
import { validateSerializedEnvelope } from '../../../packages/contract/response';
import {
  buildFourStateDeletionProof,
  calculateMonthlyCostEstimate,
  ContinuousStreamDispatcher,
  DESTINATION_CATALOG_50,
  dryRunValidateDestination,
  evaluateDestinationEntitlement,
  executeDestinationFunctionSandboxed,
  getDestinationSpec,
  getPublicPricingSchedule,
  isForbiddenInternalIp,
  LinkControlledDestinationSender,
  runStorageTierSelfDiagnostic,
  SelfServeOnboardingOrchestrator,
  STREAM_RETRY_WINDOW_MS,
  STREAM_TARGETS,
  TenantSqlInterface,
  WAREHOUSE_BATCH_P95_SLA_MS,
  WAREHOUSE_TARGETS,
  WarehouseBatchExporter,
  type ExportableAnalyticsRow,
  type StreamEventEnvelope,
  type StreamPolicyState,
  type StreamTransportPort,
} from './index';

function makeAnalyticsRow(
  overrides: Partial<ExportableAnalyticsRow> = {}
): ExportableAnalyticsRow {
  return {
    rowId: 'row-1',
    tenantId: 'ten-a',
    siteId: 'site-1',
    windowStartIso: '2026-11-20T08:00:00.000Z',
    windowEndIso: '2026-11-20T09:00:00.000Z',
    collectionGen: 'v3',
    schemaVersion: '2.0.0',
    consentMode: 'cookieless',
    purposesAllowed: ['automation_detection', 'experiment'],
    revocationEpoch: 1,
    retentionExpiresAtIso: '2027-12-20T00:00:00.000Z',
    trustLevel: 'edge_attested',
    missingFlags: [],
    lane: 'standard_telemetry',
    evidenceLevel: 'observed',
    cellUnitCount: 25,
    metrics: { pvs: 25, sum_vis_ms: 250_000 },
    ...overrides,
  };
}

function makePrincipal(overrides: Partial<VerifiedPrincipal> = {}): VerifiedPrincipal {
  return {
    principalId: 'usr-analyst-1',
    tenantId: 'ten-a',
    orgId: 'org-a',
    principalKind: 'human',
    role: 'admin',
    credentialKind: 'ugk_sec',
    credentialId: 'key_001',
    effectiveScopes: new Set(['analytics:read', 'analytics:export']),
    allowedSiteIds: ['site-1'],
    senderConstrained: false,
    passkeyVerified: true,
    ...overrides,
  };
}

describe('lib/link/export/warehouses (5 warehouses + Parquet contract)', () => {
  test('exports across all 5 warehouses + Parquet, blocks foreign/pooled rows, keeps Tier 2 unsuppressed, enforces external <10 + complementary + non-overlap', async () => {
    expect(WAREHOUSE_TARGETS).toEqual([
      'bigquery',
      'snowflake',
      'redshift',
      'databricks',
      'clickhouse',
      'object_parquet',
    ]);

    const exporter = new WarehouseBatchExporter();
    const cutoffMs = Date.UTC(2026, 10, 20, 9, 0, 0);

    // Tier 2 customer_own_site: <10 cell (count=4) MUST NOT be suppressed; foreign & pooled rows MUST be blocked
    const tier2Res = await exporter.exportBatch({
      config: {
        exportId: 'exp-bq-1',
        tenantId: 'ten-a',
        siteId: 'site-1',
        target: 'bigquery',
        recipientClass: 'customer_own_site',
        storageRegion: 'jp',
        destinationRegion: 'jp',
        deletionEpoch: 3,
      },
      rows: [
        makeAnalyticsRow({ rowId: 'own-small', cellUnitCount: 4 }),
        makeAnalyticsRow({ rowId: 'foreign-row', tenantId: 'ten-b' }),
        makeAnalyticsRow({ rowId: 'pooled-row', isPooledResult: true }),
      ],
      sourceEventCutoffMs: cutoffMs,
      nowMs: cutoffMs + 5 * 60_000, // 5 min <= 15 min SLA
    });

    expect(tier2Res.status).toBe('ok');
    expect(tier2Res.exportedRowCount).toBe(1);
    expect(tier2Res.foreignTenantRowsBlocked).toBe(1);
    expect(tier2Res.pooledRowsExcluded).toBe(1);
    expect(tier2Res.suppressedCellsCount).toBe(0);
    expect(tier2Res.within15mSla).toBe(true);
    expect(tier2Res.artifact?.rows[0]?.suppressed).toBe(false);
    expect(tier2Res.artifact?.rows[0]?.consent_mode).toBe('cookieless');
    expect(tier2Res.artifact?.rows[0]?.lane).toBe('standard_telemetry');

    // External party (CRAWL / OEM): 1 cell < 10 triggers BOTH primary suppression AND complementary suppression!
    const extRes = await exporter.exportBatch({
      config: {
        exportId: 'exp-ext-1',
        tenantId: 'ten-a',
        siteId: 'site-1',
        target: 'snowflake',
        recipientClass: 'external_party',
        storageRegion: 'jp',
        destinationRegion: 'jp',
        deletionEpoch: 3,
      },
      rows: [
        makeAnalyticsRow({ rowId: 'cell-small', cellUnitCount: 3 }),
        makeAnalyticsRow({ rowId: 'cell-mid', cellUnitCount: 14 }),
        makeAnalyticsRow({ rowId: 'cell-big', cellUnitCount: 120 }),
      ],
      sourceEventCutoffMs: cutoffMs,
      nowMs: cutoffMs + WAREHOUSE_BATCH_P95_SLA_MS + 60_000, // 16 min -> breaches 15m SLA!
    });

    expect(extRes.status).toBe('ok');
    expect(extRes.suppressedCellsCount).toBe(1);
    expect(extRes.complementarySuppressedCount).toBe(1);
    expect(extRes.within15mSla).toBe(false);
    expect(extRes.lossNotices.some((n) => n.reason === 'sla_15m_breached')).toBe(true);

    // Overlapping external window MUST be rejected against differencing attacks
    const overlapRes = await exporter.exportBatch({
      config: {
        exportId: 'exp-ext-overlap',
        tenantId: 'ten-a',
        siteId: 'site-1',
        target: 'snowflake',
        recipientClass: 'external_party',
        storageRegion: 'jp',
        destinationRegion: 'jp',
        deletionEpoch: 3,
      },
      rows: [
        makeAnalyticsRow({
          rowId: 'overlap-row',
          windowStartIso: '2026-11-20T08:00:00.000Z',
          windowEndIso: '2026-11-20T10:00:00.000Z', // overlaps 08:00-09:00!
          cellUnitCount: 50,
        }),
      ],
      sourceEventCutoffMs: cutoffMs,
      nowMs: cutoffMs + 1000,
    });
    expect(overlapRes.status).toBe('rejected_window_overlap');

    // Cross-region export without explicit transfer grant MUST be rejected (D-29)
    const crossRegionRes = await exporter.exportBatch({
      config: {
        exportId: 'exp-cross-region',
        tenantId: 'ten-a',
        siteId: 'site-1',
        target: 'redshift',
        recipientClass: 'customer_own_site',
        storageRegion: 'jp',
        destinationRegion: 'us',
        deletionEpoch: 3,
      },
      rows: [makeAnalyticsRow()],
      sourceEventCutoffMs: cutoffMs,
      nowMs: cutoffMs + 1000,
    });
    expect(crossRegionRes.status).toBe('rejected_cross_region_grant');
  });
});

describe('lib/link/export/streams (4 continuous streams & per-retry deletion guard)', () => {
  test('re-checks deletion/revocation on retry, records post-delivery deletion_unconfirmed, expires >72h to loss ledger, and auto-pauses on auth failure', async () => {
    expect(STREAM_TARGETS).toEqual(['webhook', 'pubsub', 'kafka', 'kinesis']);

    const sentEvents: string[] = [];
    let mode: 'ok' | 'fail_500' | 'fail_401' = 'fail_500';
    const transport: StreamTransportPort = {
      async send(_cfg, ev) {
        if (mode === 'ok') {
          sentEvents.push(ev.eventId);
          return { ok: true, httpStatus: 200, deliveredAtMs: ev.occurredAtMs + 5000 };
        }
        if (mode === 'fail_401') {
          return { ok: false, httpStatus: 401, errorReason: 'unauthorized', deliveredAtMs: 0 };
        }
        return { ok: false, httpStatus: 503, errorReason: 'unavailable', deliveredAtMs: 0 };
      },
    };

    const dispatcher = new ContinuousStreamDispatcher(
      {
        sinkId: 'sink-kafka-1',
        tenantId: 'ten-a',
        siteId: 'site-1',
        target: 'kafka',
        requiredPurposes: ['experiment'],
        supportsDeletionCallback: false, // cannot confirm deletion -> deletion_unconfirmed!
      },
      transport
    );

    const t0 = Date.UTC(2026, 10, 20, 10, 0, 0);
    const makeEvt = (id: string, subjectKey: string, occurredAtMs = t0): StreamEventEnvelope => ({
      eventId: id,
      tenantId: 'ten-a',
      siteId: 'site-1',
      subjectKey,
      occurredAtMs,
      enqueuedAtMs: occurredAtMs,
      schemaVersion: '2.0.0',
      consentMode: 'session',
      purposesAllowed: ['experiment'],
      revocationEpoch: 1,
      deletionEpoch: 1,
      lane: 'standard_telemetry',
      payload: { metric: 1 },
    });

    const basePolicy: StreamPolicyState = {
      tenantId: 'ten-a',
      siteId: 'site-1',
      currentRevocationEpoch: 1,
      currentDeletionEpoch: 1,
      deletedSubjectsCutoffMs: new Map(),
      activePurposes: new Set(['experiment']),
    };

    // Enqueue 2 events: e1 (will fail once then get deleted before retry), e2 (will deliver on retry)
    dispatcher.enqueue(makeEvt('e-del-before-retry', 'subj-1', t0));
    dispatcher.enqueue(makeEvt('e-deliver', 'subj-2', t0));
    // Duplicate eventId rejected immediately
    expect(dispatcher.enqueue(makeEvt('e-deliver', 'subj-2', t0)).queued).toBe(false);

    // Attempt 1 fails with 503 -> both queued for retry
    const firstTry = await dispatcher.flush(basePolicy, t0 + 1000);
    expect(firstTry.retriedCount).toBe(2);
    expect(sentEvents).toEqual([]);

    // Before Attempt 2: deletion notice arrives for subj-1!
    mode = 'ok';
    const policyWithDeletion: StreamPolicyState = {
      ...basePolicy,
      deletedSubjectsCutoffMs: new Map([['subj-1', t0 + 10_000]]),
    };
    const secondTry = await dispatcher.flush(policyWithDeletion, t0 + 10_000);
    expect(secondTry.abortedPolicyOrDeletionCount).toBe(1); // e-del-before-retry aborted!
    expect(secondTry.deliveredCount).toBe(1); // only e-deliver sent
    expect(sentEvents).toEqual(['e-deliver']);

    // Post-delivery deletion for already-sent subj-2 on non-confirming sink -> deletion_unconfirmed!
    const delRec = await dispatcher.handlePostDeliveryDeletion({
      subjectKey: 'subj-2',
      deletedBeforeMs: t0 + 20_000,
      deletionEpoch: 2,
      nowMs: t0 + 20_000,
    });
    expect(delRec.status).toBe('deletion_unconfirmed');
    expect(delRec.affectedEventIds).toEqual(['e-deliver']);

    // Event exceeding 72-hour retry ceiling evicted to loss ledger
    dispatcher.enqueue(makeEvt('e-expired-72h', 'subj-3', t0));
    const expiredFlush = await dispatcher.flush(
      basePolicy,
      t0 + STREAM_RETRY_WINDOW_MS + 1000
    );
    expect(expiredFlush.expiredToLossLedgerCount).toBe(1);
    expect(
      dispatcher.getLossLedgerEntries().some((e) => e.reason === 'retry_72h_expired')
    ).toBe(true);

    // 401 auth error auto-pauses stream immediately with reason
    mode = 'fail_401';
    dispatcher.enqueue(makeEvt('e-auth-fail', 'subj-4', t0 + 1000));
    const authFailFlush = await dispatcher.flush(basePolicy, t0 + 2000);
    expect(authFailFlush.autoPaused).toBe(true);
    expect(authFailFlush.pauseReason).toMatch(/auto_paused_auth_expired:401/);
    expect(dispatcher.isPaused()).toBe(true);
  });
});

describe('lib/link/export/destinations-catalog (3 categories & 50 declarative destinations)', () => {
  test('catalog contains exactly 50 unique declarative connectors and all pass dry-run validation', () => {
    expect(DESTINATION_CATALOG_50).toHaveLength(50);
    const ids = new Set(DESTINATION_CATALOG_50.map((d) => d.id));
    expect(ids.size).toBe(50);

    const sampleEvent = {
      event_id: 'evt-001',
      occurred_at: '2026-11-20T10:00:00.000Z',
      event_name: 'purchase',
    };

    for (const spec of DESTINATION_CATALOG_50) {
      const dry = dryRunValidateDestination(spec, sampleEvent);
      expect(dry.valid).toBe(true);
      expect(dry.mappedPayload).not.toBeNull();
    }
  });

  test('blocks categories (ii) and (iii) as not_entitled until D-30 + legal + approved exception, and propagates across relays', () => {
    const ownStorage = getDestinationSpec('stor_bigquery')!;
    const processor = getDestinationSpec('jp_karte')!;
    const thirdParty = getDestinationSpec('jp_line_ads_capi')!;
    const segmentRelay = getDestinationSpec('relay_segment_http')!;

    // (i) Customer-owned storage works without D-30
    expect(
      evaluateDestinationEntitlement(ownStorage, {
        tenantId: 'ten-a',
        consentMode: 'cookieless',
        grantedPurposes: [],
        approvedExceptions: new Set(),
      }).entitled
    ).toBe(true);

    // (ii) & (iii) default to not_entitled while D-30 is pending in ledger
    const procDefault = evaluateDestinationEntitlement(processor, {
      tenantId: 'ten-a',
      consentMode: 'full',
      grantedPurposes: ['member_link'],
      approvedExceptions: new Set(['jp_karte']),
    });
    expect(procDefault.status).toBe('not_entitled');
    expect(procDefault.reason).toBe('decision_30_and_legal_signoff_required');

    // Even with D-30 + legal approved, missing from Approved Exceptions Ledger => not_entitled!
    const tpNotInLedger = evaluateDestinationEntitlement(thirdParty, {
      tenantId: 'ten-a',
      consentMode: 'full',
      grantedPurposes: ['ads'],
      approvedExceptions: new Set(),
      decision30ApprovedOverride: true,
      legalSignOffOverride: true,
    });
    expect(tpNotInLedger.status).toBe('not_entitled');
    expect(tpNotInLedger.reason).toBe('missing_approved_exception_ledger_entry');

    // Relay propagation: Segment relay approved, but downstream Meta CAPI NOT in approvedExceptions -> BLOCKED!
    const relayBlocked = evaluateDestinationEntitlement(segmentRelay, {
      tenantId: 'ten-a',
      consentMode: 'full',
      grantedPurposes: ['ads'],
      approvedExceptions: new Set(['relay_segment_http']),
      downstreamRelayDestinationIds: ['ad_meta_capi'],
      decision30ApprovedOverride: true,
      legalSignOffOverride: true,
    });
    expect(relayBlocked.status).toBe('not_entitled');
    expect(relayBlocked.blockedByDownstreamId).toBe('ad_meta_capi');

    // Once BOTH relay and downstream Meta CAPI are approved & purpose granted -> OK!
    const relayOk = evaluateDestinationEntitlement(segmentRelay, {
      tenantId: 'ten-a',
      consentMode: 'full',
      grantedPurposes: ['ads'],
      approvedExceptions: new Set(['relay_segment_http', 'ad_meta_capi']),
      downstreamRelayDestinationIds: ['ad_meta_capi'],
      decision30ApprovedOverride: true,
      legalSignOffOverride: true,
    });
    expect(relayOk.entitled).toBe(true);
  });
});

describe('lib/link/export/destination-functions (sandboxed transform + LINK-controlled sender)', () => {
  test('sandbox blocks network, process, require, infinite loops, and oversized outputs', () => {
    // Attempt to access fetch/process/require inside sandbox
    const noCapRes = executeDestinationFunctionSandboxed({
      code: `
        function transform(event) {
          return {
            method: 'POST',
            url: 'https://hooks.customer.invalid/ugokilink/events',
            headers: {},
            body: {
              hasFetch: typeof fetch !== 'undefined',
              hasProcess: typeof process !== 'undefined',
              hasRequire: typeof require !== 'undefined',
              id: event.id,
            }
          };
        }
      `,
      eventInput: { id: 'e1' },
    });
    expect(noCapRes.ok).toBe(true);
    expect(noCapRes.proposed?.body).toEqual({
      hasFetch: false,
      hasProcess: false,
      hasRequire: false,
      id: 'e1',
    });

    // Infinite loop terminated by hard CPU timeout
    const timeoutRes = executeDestinationFunctionSandboxed({
      code: `function transform() { while (true) {} }`,
      eventInput: {},
      timeoutMs: 25,
    });
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.error).toMatch(/timed out/i);

    // Oversized output rejected
    const bigRes = executeDestinationFunctionSandboxed({
      code: `function transform() { return { method: 'POST', url: 'https://hooks.customer.invalid/ugokilink/events', headers: {}, body: { blob: 'x'.repeat(50000) } }; }`,
      eventInput: {},
      maxOutputBytes: 4096,
    });
    expect(bigRes.ok).toBe(false);
    expect(bigRes.error).toMatch(/exceeded maxOutputBytes/);
  });

  test('LINK sender enforces SSRF IP blocking, redirect verification, allowed-field filtering, revocation check, and tenant credential binding', async () => {
    expect(isForbiddenInternalIp('127.0.0.1')).toBe(true);
    expect(isForbiddenInternalIp('169.254.169.254')).toBe(true);
    expect(isForbiddenInternalIp('10.20.30.40')).toBe(true);
    expect(isForbiddenInternalIp('192.168.1.1')).toBe(true);
    expect(isForbiddenInternalIp('::1')).toBe(true);
    expect(isForbiddenInternalIp('198.51.100.1')).toBe(true);
    expect(isForbiddenInternalIp('203.0.113.42')).toBe(true);
    expect(isForbiddenInternalIp('93.184.216.34')).toBe(false);

    const dest = getDestinationSpec('stor_webhook_direct')!;
    let dnsMap: Record<string, readonly string[]> = {
      'hooks.customer.invalid': ['93.184.216.34'],
    };
    let transportResp: { status: number; locationHeader?: string } = { status: 200 };
    let lastSentHeaders: Readonly<Record<string, string>> = {};
    let lastSentBody = '';

    const sender = new LinkControlledDestinationSender(
      {
        async resolveAll(host) {
          return dnsMap[host] ?? [];
        },
      },
      {
        async getBoundAuthHeaders(tenantId, destId) {
          return { authorization: `Bearer secret_${tenantId}_${destId}` };
        },
      },
      {
        async send(args) {
          lastSentHeaders = args.headers;
          lastSentBody = args.bodyJson;
          return transportResp;
        },
      }
    );

    const baseReq = {
      tenantId: 'ten-a',
      destination: dest,
      transformCode: `
        function transform(ev) {
          return {
            method: 'POST',
            url: 'https://hooks.customer.invalid/ugokilink/events',
            headers: { authorization: 'Bearer forged_token', 'x-custom': 'ok' },
            body: { event_id: ev.event_id, metric: 42, secret_pii: 'must-be-stripped' }
          };
        }
      `,
      eventInput: { event_id: 'e-100' },
      eventRevocationEpoch: 2,
      currentRevocationEpoch: 2,
      allowedOutboundFields: ['event_id', 'metric'],
      entitlementContext: {
        tenantId: 'ten-a',
        consentMode: 'cookieless' as const,
        grantedPurposes: [],
        approvedExceptions: new Set<string>(),
      },
    };

    // 1. Clean delivery: strips undeclared `secret_pii`, overrides forged Authorization with tenant-bound secret!
    const okRes = await sender.executeAndSend(baseReq);
    expect(okRes.delivered).toBe(true);
    expect(okRes.strippedFields).toEqual(['secret_pii']);
    expect(JSON.parse(lastSentBody)).toEqual({ event_id: 'e-100', metric: 42 });
    expect(lastSentHeaders.authorization).toBe('Bearer secret_ten-a_stor_webhook_direct');

    // 2. DNS resolves to AWS/GCP cloud metadata IP -> SSRF blocked!
    dnsMap = { 'hooks.customer.invalid': ['169.254.169.254'] };
    const ssrfRes = await sender.executeAndSend(baseReq);
    expect(ssrfRes.delivered).toBe(false);
    expect(ssrfRes.status).toBe('ssrf_blocked');

    // 3. Redirect to evil host / metadata IP -> redirect blocked!
    dnsMap = { 'hooks.customer.invalid': ['93.184.216.34'] };
    transportResp = {
      status: 302,
      locationHeader: 'http://169.254.169.254/latest/meta-data/',
    };
    const redirectRes = await sender.executeAndSend(baseReq);
    expect(redirectRes.delivered).toBe(false);
    expect(redirectRes.status).toBe('redirect_blocked');

    // 4. Superseded revocation epoch -> aborted before sandbox even executes!
    transportResp = { status: 200 };
    const revokedRes = await sender.executeAndSend({
      ...baseReq,
      eventRevocationEpoch: 1,
      currentRevocationEpoch: 2,
    });
    expect(revokedRes.delivered).toBe(false);
    expect(revokedRes.status).toBe('aborted_revoked');
  });
});

describe('lib/link/export/storage-tiers (§5.12 3-tier self-diagnostics & 4-state deletion proof)', () => {
  test('marks ML/join/experiment capabilities not_entitled on Tier 3 without valid read grant and classifies 4 deletion states', () => {
    const tier3NoGrant = runStorageTierSelfDiagnostic({
      tenantId: 'ten-a',
      siteId: 'site-1',
      tier: 'tier3_customer_sor',
      storageRegion: 'jp',
      configValid: true,
      runtimeHealthy: true,
      writePermissionOk: true,
      capacityFreePct: 45,
      linkReadGrantActive: false,
      decision24ApprovedOverride: true,
    });

    expect(tier3NoGrant.overallHealthy).toBe(false);
    expect(
      tier3NoGrant.capabilities.find((c) => c.capability === 'ml_training_and_inference')?.status
    ).toBe('not_entitled');
    expect(
      tier3NoGrant.capabilities.find((c) => c.capability === 'crawl_structural_join')?.status
    ).toBe('not_entitled');
    expect(
      tier3NoGrant.capabilities.find((c) => c.capability === 'experiment_verdicts')?.status
    ).toBe('not_entitled');

    const proof = buildFourStateDeletionProof({
      requestId: 'del-512',
      tenantId: 'ten-a',
      deletionEpoch: 4,
      copies: [
        { copyId: 'c1', copyLabel: 'LINK ClickHouse + R2', managedBy: 'link', linkDeletionVerified: true },
        { copyId: 'c2', copyLabel: 'Customer BigQuery', managedBy: 'customer_sink', notificationSent: true, customerAckReceived: true },
        { copyId: 'c3', copyLabel: 'Customer Kafka Stream', managedBy: 'customer_sink', notificationSent: true, customerAckReceived: false },
        { copyId: 'c4', copyLabel: 'Historical CSV Export', managedBy: 'external_manual_export' },
      ],
    });

    expect(proof.allLinkCopiesConfirmed).toBe(true);
    expect(proof.countsByState).toEqual({
      confirmed_link: 1,
      notified_customer_confirmed: 1,
      notified_unconfirmed: 1,
      outside_control: 1,
    });
  });
});

describe('lib/link/export/sql-interface (§11.11 #7 RO tenant SQL interface)', () => {
  test('executes safe whitelisted public-view SQL under ugk_ro_<tenant>, stamps ad-hoc not-authoritative warning, and rejects forbidden SQL', async () => {
    const sqlApi = new TenantSqlInterface({
      async execute(query) {
        return {
          rows: [{ page_id: 101, total_pvs: 250 }],
          scannedRows: 250,
          costUnitsUsed: 12,
          durationMs: 14,
        };
      },
    });

    const principal = makePrincipal();
    const ok = await sqlApi.executeQuery({
      principal,
      siteId: 'site-1',
      sql: `
        SELECT page_id, sum(pvs) AS total_pvs
        FROM rollup_page_hourly
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND pv_hour >= {start_ts:DateTime}
          AND pv_hour < {end_ts:DateTime}
        GROUP BY page_id
      `,
      params: {
        start_ts: '2026-11-19 00:00:00',
        end_ts: '2026-11-20 00:00:00',
      },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
    });

    expect(ok.allowed).toBe(true);
    expect(ok.httpStatus).toBe(200);
    expect(ok.clickhouseUser).toBe(perTenantRoUsername('ten-a'));
    expect(ok.authoritativeTruthProhibited).toBe(true);
    expect(ok.envelope?.warnings[0]).toMatch(/ad_hoc_sql_cannot_serve_as_authoritative_truth/);
    expect(validateSerializedEnvelope(ok.envelope).valid).toBe(true);

    // Reject external connection function `url(...)`
    const extFn = sqlApi.validateQuery({
      principal,
      siteId: 'site-1',
      sql: `SELECT url('http://evil.invalid', 'JSON') FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start_ts:DateTime}`,
      params: { start_ts: '2026-11-19 00:00:00' },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
    });
    expect(extFn.allowed).toBe(false);
    expect(extFn.violations.some((v) => v.includes('forbidden_external_or_system_function'))).toBe(true);

    // Reject system.tables & non-whitelisted internal tables
    const sysTbl = sqlApi.validateQuery({
      principal,
      siteId: 'site-1',
      sql: `SELECT name FROM system.tables WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start_ts:DateTime}`,
      params: { start_ts: '2026-11-19 00:00:00' },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
    });
    expect(sysTbl.allowed).toBe(false);
    expect(sysTbl.violations.some((v) => v.includes('forbidden_system_table'))).toBe(true);

    // Reject multi-statement smuggling
    const multiStmt = sqlApi.validateQuery({
      principal,
      siteId: 'site-1',
      sql: `SELECT page_id FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start_ts:DateTime}; DROP TABLE events_v2`,
      params: { start_ts: '2026-11-19 00:00:00' },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
    });
    expect(multiStmt.allowed).toBe(false);

    // Reject over-budget query with HTTP 429
    const overCost = sqlApi.validateQuery({
      principal,
      siteId: 'site-1',
      sql: `SELECT page_id FROM rollup_page_hourly WHERE tenant_id = {tenant_id:String} AND pv_hour >= {start_ts:DateTime}`,
      params: { start_ts: '2026-11-19 00:00:00' },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
      estimatedCostUnits: 250,
    });
    expect(overCost.allowed).toBe(false);
    expect(overCost.httpStatus).toBe(429);
  });
});

describe('lib/link/export/self-serve-billing (§11.11 #1 & #7)', () => {
  test('automates unmanned signup -> Ed25519 key -> snippet + disclosure -> <=60s verification visit without polluting human traffic', () => {
    const orchestrator = new SelfServeOnboardingOrchestrator();
    const t0 = Date.UTC(2026, 10, 20, 12, 0, 0);

    const ws = orchestrator.provisionWorkspace({
      organizationName: 'Acme Japan Inc.',
      siteName: 'Acme Store',
      hostname: 'store.acme.jp',
      policyUrl: 'https://store.acme.jp/privacy',
      nowMs: t0,
    });

    // Public key verifies statelessly with Ed25519
    const pubVerify = verifyPublicKeyStateless(ws.publicKey, {
      v1: orchestrator.getPublicSigningKeyPem(),
    });
    expect(pubVerify.valid).toBe(true);
    expect(ws.installSnippetHtml).toContain(ws.publicKey);
    expect(ws.disclosureRecord.legalFramework).toBe('JP_TELECOMMUNICATIONS_BUSINESS_ACT_ART_27_12');
    // General traffic remains `off` until disclosure hash is verified on policy URL!
    expect(ws.generalTrafficEffectiveConsentMode).toBe('off');

    // Verify disclosure hash -> unlocks cookieless for general traffic
    const verifiedWs = orchestrator.verifyDisclosureOnPolicyPage(
      ws.siteId,
      ws.disclosureRecord.contentSha256
    );
    expect(verifiedWs.disclosureVerificationState).toBe('verified');
    expect(verifiedWs.generalTrafficEffectiveConsentMode).toBe('cookieless');

    // Confirmation visit arrives 4 minutes after signup and appears live in 3 seconds
    const receipt = orchestrator.recordAndConfirmOnboardingVisit({
      siteId: ws.siteId,
      pvId: 'pv-verify-001',
      visitOccurredAtMs: t0 + 4 * 60_000,
      observedAtMs: t0 + 4 * 60_000 + 3_000,
    });
    expect(receipt.onboardingVerified).toBe(true);
    expect(receipt.visitVisibleWithin60s).toBe(true);
    expect(receipt.within10MinEndToEndSla).toBe(true);
    expect(receipt.humanTrafficContaminationCount).toBe(0);
  });

  test('publishes transparent pricing with zero contact-sales-only tiers, 2M events + 50k replays free tier, and full-lane monthly calculator', () => {
    const schedule = getPublicPricingSchedule();
    expect(schedule.hasContactSalesOnlyFoundationalTier).toBe(false);
    expect(schedule.tiers.every((t) => t.contactSalesOnly === false)).toBe(true);
    expect(schedule.freeTierBenchmark.freeEventEquivalentsMonthly).toBe(2_000_000);
    expect(schedule.freeTierBenchmark.freeVisualReplaysMonthly).toBe(50_000);
    expect(schedule.cumulativeToEventFormula.multiplier).toBe(5);

    // Usage inside free tier: 300k standard PVs (1.5M equiv) + 500k custom events = 2.0M + 50k replays -> $0!
    const freeCalc = calculateMonthlyCostEstimate({
      standardBillablePvsMonthly: 300_000,
      compatAndCustomEventsMonthly: 500_000,
      destinationDeliveriesMonthly: 2_000_000,
      visualReplaysMonthly: 50_000,
      subjectDeletionRequestsMonthly: 10,
    });
    expect(freeCalc.recommended.tierId).toBe('free');
    expect(freeCalc.recommended.totalEventEquivalents).toBe(2_000_000);
    expect(freeCalc.recommended.estimatedMonthlyUsd).toBe(0);
    expect(freeCalc.recommended.lineItemsUsd.subjectDeletions).toBe(0);

    // Higher volume automatically recommends cheaper tier + calculates Tier 3 infra credit
    const highCalc = calculateMonthlyCostEstimate({
      standardBillablePvsMonthly: 4_000_000, // 20M equiv
      compatAndCustomEventsMonthly: 5_000_000, // +5M = 25M equiv
      destinationDeliveriesMonthly: 25_000_000,
      visualReplaysMonthly: 250_000,
      subjectDeletionRequestsMonthly: 50,
      storageTier: 'tier3_customer_sor',
    });
    expect(highCalc.recommended.totalEventEquivalents).toBe(25_000_000);
    expect(highCalc.recommended.tierId).not.toBe('free');
    expect(highCalc.recommended.estimatedMonthlyUsd).toBeGreaterThan(0);
    expect(highCalc.recommended.estimatedMonthlyJpy).toBeGreaterThan(0);
  });

  test('Wave 8 Regressions (C-10, C-11, C-12, H-17, H-20, M-06): Worker escape/prototype defense, cross-origin redirect & hex IPv6 SSRF defense, SRI + redacted secretKey, and per-slice complementary suppression', async () => {
    const escapeAttempt = executeDestinationFunctionSandboxed({
      code: `function transform() { const p = ({}).constructor.constructor('return process')(); return { method: 'POST', url: 'https://hooks.customer.invalid/ugokilink/events', headers: {}, body: { env: p.env } }; }`,
      eventInput: {},
    });
    expect(escapeAttempt.ok).toBe(false);

    const protoAttempt = executeDestinationFunctionSandboxed({
      code: `function transform() { Object.prototype.ugkPolluted = 'pwned'; return { method: 'POST', url: 'https://hooks.customer.invalid/ugokilink/events', headers: {}, body: {} }; }`,
      eventInput: {},
    });
    expect(protoAttempt.ok).toBe(false);
    expect((Object.prototype as Record<string, unknown>).ugkPolluted).toBeUndefined();

    expect(isForbiddenInternalIp('::ffff:a9fe:a9fe')).toBe(true);
    expect(isForbiddenInternalIp('0177.0.0.1')).toBe(true);

    const dest = getDestinationSpec('stor_webhook_direct')!;
    const sender = new LinkControlledDestinationSender(
      { async resolveAll() { return ['93.184.216.34']; } },
      { async getBoundAuthHeaders() { return { authorization: 'Bearer vault_secret' }; } },
      { async send() { return { status: 307, locationHeader: 'https://other.customer.invalid/x' }; } }
    );
    const crossRedirect = await sender.executeAndSend({
      tenantId: 'ten-a',
      destination: dest,
      transformCode: `function transform() { return { method: 'POST', url: 'https://hooks.customer.invalid/ugokilink/events', headers: {}, body: { a: 1 } }; }`,
      eventInput: {},
      eventRevocationEpoch: 1,
      currentRevocationEpoch: 1,
      allowedOutboundFields: ['a'],
      entitlementContext: {
        tenantId: 'ten-a',
        consentMode: 'cookieless',
        grantedPurposes: [],
        approvedExceptions: new Set(),
      },
    });
    expect(crossRedirect.status).toBe('redirect_blocked');

    const keyReg = new IdentityKeyRegistry({ pepperVersion: 'p1', pepperSecret: 'pep-h20' });
    const orch = new SelfServeOnboardingOrchestrator({ identityRegistry: keyReg });
    const ws = orch.provisionWorkspace({
      organizationName: 'SRI Corp',
      siteName: 'SRI Site',
      hostname: 'sri.example.jp',
      policyUrl: 'https://sri.example.jp/privacy',
    });
    expect(ws.installSnippetHtml).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(orch.getStoredWorkspace(ws.siteId)?.secretKey).toBe('[REDACTED_ONE_TIME_ISSUED]');
    expect(keyReg.verifySecretKey(ws.secretKey).ok).toBe(true);

    const exporter = new WarehouseBatchExporter();
    const cutoffMs = Date.UTC(2026, 10, 22, 10, 0, 0);
    const multiSlice = await exporter.exportBatch({
      config: {
        exportId: 'exp-m06',
        tenantId: 'ten-a',
        siteId: 'site-1',
        target: 'snowflake',
        recipientClass: 'external_party',
        storageRegion: 'jp',
        destinationRegion: 'jp',
        deletionEpoch: 1,
      },
      rows: [
        makeAnalyticsRow({ rowId: 'd1-s', windowStartIso: '2026-11-20T00:00:00.000Z', windowEndIso: '2026-11-21T00:00:00.000Z', cellUnitCount: 4 }),
        makeAnalyticsRow({ rowId: 'd1-b', windowStartIso: '2026-11-20T00:00:00.000Z', windowEndIso: '2026-11-21T00:00:00.000Z', cellUnitCount: 25 }),
        makeAnalyticsRow({ rowId: 'd2-s', windowStartIso: '2026-11-21T00:00:00.000Z', windowEndIso: '2026-11-22T00:00:00.000Z', cellUnitCount: 6 }),
        makeAnalyticsRow({ rowId: 'd2-b', windowStartIso: '2026-11-21T00:00:00.000Z', windowEndIso: '2026-11-22T00:00:00.000Z', cellUnitCount: 30 }),
      ],
      sourceEventCutoffMs: cutoffMs,
      nowMs: cutoffMs + 1000,
    });
    expect(multiSlice.suppressedCellsCount).toBe(2);
    expect(multiSlice.complementarySuppressedCount).toBe(2);
  });

  test('Wave 9 Regressions (#1, #26): SQL interface enforces site_id predicate for site-scoped credentials on 2-site dataset, and worker caps >32 KiB output & 200 KiB errors before IPC', async () => {
    // #1: 2-site dataset (`site_a`, `site_b`) — Site-A-only principal CANNOT run unscoped tenant-wide aggregate
    const twoSiteTable = [
      { tenant_id: 'ten-a', site_id: 'site_a', page_id: '/a', pvs: 120 },
      { tenant_id: 'ten-a', site_id: 'site_b', page_id: '/b', pvs: 880 },
    ];
    let executedCount = 0;
    const sqlApi = new TenantSqlInterface({
      async execute(q) {
        executedCount += 1;
        const filtered = twoSiteTable.filter((r) => {
          if (r.tenant_id !== q.query_params.tenant_id) return false;
          if (typeof q.query_params.site_id === 'string') {
            return r.site_id === q.query_params.site_id;
          }
          if (Array.isArray(q.query_params.allowed_site_ids)) {
            return (q.query_params.allowed_site_ids as readonly string[]).includes(r.site_id);
          }
          return true;
        });
        return { rows: filtered, scannedRows: filtered.length, costUnitsUsed: 1, durationMs: 5 };
      },
    });

    const siteAOnly = makePrincipal({ allowedSiteIds: ['site_a'] });
    const unscopedAttempt = await sqlApi.executeQuery({
      principal: siteAOnly,
      siteId: 'site_a',
      sql: `
        SELECT sum(pvs) AS total_pvs
        FROM rollup_page_hourly
        WHERE tenant_id = {tenant_id:String}
          AND pv_hour >= {start_ts:DateTime}
      `,
      params: { start_ts: '2026-11-19 00:00:00' },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
    });
    expect(unscopedAttempt.allowed).toBe(false);
    expect(unscopedAttempt.httpStatus).toBe(403);
    expect(unscopedAttempt.violations.some((v) => v.includes('MISSING_SITE_BIND_PREDICATE'))).toBe(true);
    expect(executedCount).toBe(0);

    // Properly site-scoped query executes and ONLY ever returns site_a rows (never site_b)
    const scopedOk = await sqlApi.executeQuery({
      principal: siteAOnly,
      siteId: 'site_a',
      sql: `
        SELECT page_id, sum(pvs) AS total_pvs
        FROM rollup_page_hourly
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND pv_hour >= {start_ts:DateTime}
        GROUP BY page_id
      `,
      params: { start_ts: '2026-11-19 00:00:00' },
      windowStartIso: '2026-11-19T00:00:00.000Z',
      windowEndIso: '2026-11-20T00:00:00.000Z',
      storageRegion: 'jp',
    });
    expect(scopedOk.allowed).toBe(true);
    expect(scopedOk.httpStatus).toBe(200);
    expect(executedCount).toBe(1);
    const dataRows = (scopedOk.envelope?.data as { rows: Array<{ site_id: string }> }).rows;
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]?.site_id).toBe('site_a');

    // #26: Oversized >32 KiB output (500 KiB) rejected cleanly inside worker BEFORE IPC
    const hugeOut = executeDestinationFunctionSandboxed({
      code: `function transform() { return { method: 'POST', url: 'https://hooks.customer.invalid/ugokilink/events', headers: {}, body: { blob: 'A'.repeat(500 * 1024) } }; }`,
      eventInput: {},
    });
    expect(hugeOut.ok).toBe(false);
    expect(hugeOut.error).toMatch(/OUTPUT_SIZE_LIMIT_EXCEEDED/);
    expect(hugeOut.outputBytes).toBeGreaterThan(32 * 1024);

    // #26: Oversized 200 KiB thrown error message truncated to <= 512 bytes inside worker BEFORE IPC
    const hugeErr = executeDestinationFunctionSandboxed({
      code: `function transform() { throw new Error('E'.repeat(200 * 1024)); }`,
      eventInput: {},
    });
    expect(hugeErr.ok).toBe(false);
    expect(hugeErr.error).toBeDefined();
    expect(Buffer.byteLength(hugeErr.error!, 'utf8')).toBeLessThanOrEqual(512);
  });

  test('Wave 10 Regression (#26): strict UTF-8 code-point boundary error truncation inside worker never exceeds 512 bytes and never emits U+FFFD', () => {
    const payloads = [
      // Exact 2-byte char at 510..511 (512 bytes) + trailing ASCII
      `'a'.repeat(510) + '\\u00e9' + 'x'.repeat(20)`,
      // Orphan 2-byte lead byte 0xC3 at byte 511
      `'a'.repeat(511) + '\\u00e9' + 'x'.repeat(20)`,
      // 3-byte CJK char split across 510..512
      `'a'.repeat(510) + '\\u3042' + 'x'.repeat(20)`,
      // 4-byte emoji split across 509..512
      `'a'.repeat(509) + '\\uD83D\\uDE80' + 'x'.repeat(20)`,
    ];

    for (const expr of payloads) {
      const res = executeDestinationFunctionSandboxed({
        code: `function transform() { throw new Error(${expr}); }`,
        eventInput: {},
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
      expect(Buffer.byteLength(res.error!, 'utf8')).toBeLessThanOrEqual(512);
      expect(res.error!).not.toContain('\uFFFD');
    }
  });
});
