/**
 * UGOKI LINK v2 — Bundle 7-A Test Suite (`lib/link/oem`)
 *
 * Covers:
 * 1. External tenant acceptance gate (`surf.G1`..`G4` + 30d 2-tenant canary 0-leak +
 *    §5.11 replica condition ③ + D-17 `not_entitled` guard)
 * 2. OEM partner add-on (`D-15` default `not_entitled`, R3 child provisioning, <=15m
 *    `act`-claim exchange, CRAWL non-sharing enforcement, OEM visual replay ban,
 *    and external-party `<10` + complementary suppression on OEM exports)
 * 3. Full-lane billing guards, 1,000,000-event single-network public-key flood
 *    resilience (0 invoice delta, 0 sampling delta), and 30-day ledger-vs-recount gate
 */

import { IdentityKeyRegistry } from '../auth';
import type { IsolationGatesSummary } from '../isolation';
import {
  CrawlOemSeparationError,
  evaluateBillingReconciliationGate,
  evaluateExternalTenantReadiness,
  evaluateUsageQuotaBehavior,
  LaneBillingGuard,
  OemPartnerManager,
  SHARED_DAILY_CONTINUITY_PREFIX_CAP,
  simulatePublicKeyFlood,
  type CanaryIsolationDayRecord,
  type DailyBillingReconciliationEntry,
} from './index';

function makePassingIsolationSummary(): IsolationGatesSummary {
  return {
    g1: { gateId: 'surf.G1', legacyAlias: 'sur.G1', ledgerRegistered: true, passed: true, failures: [] },
    g2: { gateId: 'surf.G2', legacyAlias: 'sur.G2', ledgerRegistered: true, passed: true, failures: [] },
    g3: { gateId: 'surf.G3', legacyAlias: 'sur.G3', ledgerRegistered: true, passed: true, failures: [] },
    g4: { gateId: 'surf.G4', legacyAlias: 'sur.G4', ledgerRegistered: true, passed: true, failures: [] },
    matrix: {
      totalCases: 672,
      passedCases: 672,
      leakedCases: 0,
      non404Cases: 0,
      missingAuditCases: 0,
      auditChainValid: true,
      allPassed: true,
      failures: [],
    },
    allPassed: true,
  };
}

function makeCleanCanaryDays(count: number): CanaryIsolationDayRecord[] {
  const out: CanaryIsolationDayRecord[] = [];
  const startMs = Date.UTC(2026, 9, 1, 0, 0, 0);
  for (let i = 0; i < count; i += 1) {
    const dayUtc = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10);
    out.push({
      dayUtc,
      canaryTenantA: 'canary-ten-a',
      canaryTenantB: 'canary-ten-b',
      matrixTotalCases: 672,
      leakedCases: 0,
      non404Cases: 0,
      auditChainValid: true,
    });
  }
  return out;
}

describe('lib/link/oem/external-tenant-gate (§11.9 / §5.11)', () => {
  test('blocks external tenants when canary <30d or single incident exceeds availability budget without replica, and keeps D-17 personalisation not_entitled', () => {
    const gates = makePassingIsolationSummary();

    // Only 29 clean days + RTO 3600s > 99.9% 30-day error budget (2592s) without replica -> BLOCKED!
    const blocked = evaluateExternalTenantReadiness({
      isolationGates: gates,
      canaryHistory: makeCleanCanaryDays(29),
      availability: {
        publishedAvailabilityTarget: 0.999, // 30d error budget = 2592s (43.2m)
        measuredRtoSec: 3600,
        replicaProvisioned: false,
      },
    });
    expect(blocked.readyToAdmitExternalTenants).toBe(false);
    expect(blocked.canary30DayGatePassed).toBe(false);
    expect(blocked.replicaCondition3Triggered).toBe(true);
    expect(blocked.replicaRequirementMet).toBe(false);
    expect(blocked.realtimePersonalisationStatus).toBe('not_entitled');
    expect(blocked.unmetGates.map((g) => g.id)).toContain('surf.canary_30d_zero_leak');
    expect(blocked.unmetGates.map((g) => g.id)).toContain('store.replica_condition_3');

    // 30 consecutive clean days + replica provisioned -> READY (while D-17 stays not_entitled until approved!)
    const ready = evaluateExternalTenantReadiness({
      isolationGates: gates,
      canaryHistory: makeCleanCanaryDays(30),
      availability: {
        publishedAvailabilityTarget: 0.999,
        measuredRtoSec: 3600,
        replicaProvisioned: true,
      },
    });
    expect(ready.readyToAdmitExternalTenants).toBe(true);
    expect(ready.canaryConsecutiveCleanDays).toBe(30);
    expect(ready.unmetGates).toHaveLength(0);
    expect(ready.realtimePersonalisationStatus).toBe('not_entitled');
  });
});

describe('lib/link/oem/oem-manager (D-15 / <=15m act exchange / CRAWL isolation / replay ban)', () => {
  test('defaults to not_entitled while D-15 pending, blocks CRAWL OEM sharing, exchanges <=15m act token, bans OEM visual replay, and applies <10 suppression on OEM export', async () => {
    const regLocked = new IdentityKeyRegistry({
      pepperVersion: 'p1',
      pepperSecret: 'secret-pepper-test',
    });
    const lockedMgr = new OemPartnerManager(regLocked);

    // Default D-15 pending -> not_entitled
    const lockedRes = lockedMgr.registerOemPartner({
      orgId: 'org-oem-1',
      name: 'Partner Agency',
      managementTenantId: 'ten-oem-mgmt',
      oemLegalSignoffRef: 'legal-dpa-001',
      delegableScopes: ['analytics:read', 'analytics:export'],
    });
    expect(lockedRes.ok).toBe(false);
    if (!lockedRes.ok) {
      expect(lockedRes.status).toBe('not_entitled');
    }

    // Attempting to share CRAWL OEM account or credits throws CrawlOemSeparationError
    expect(() =>
      lockedMgr.registerOemPartner({
        orgId: 'org-crawl-shared',
        name: 'Bad Shared OEM',
        managementTenantId: 'ten-bad',
        oemLegalSignoffRef: 'ref',
        delegableScopes: ['analytics:read'],
        shareCrawlOemAccount: true,
      })
    ).toThrow(CrawlOemSeparationError);

    // With D-15 + legal sign-off enabled
    const reg = new IdentityKeyRegistry({
      pepperVersion: 'p1',
      pepperSecret: 'secret-pepper-test',
    });
    const mgr = new OemPartnerManager(reg, undefined, {
      decision15ApprovedOverride: true,
      legalSignOffOverride: true,
    });

    const partner = mgr.registerOemPartner({
      orgId: 'org-oem-jp',
      name: 'Tokyo Agency OEM',
      managementTenantId: 'ten-oem-mgmt',
      oemLegalSignoffRef: 'legal-dpa-2026',
      delegableScopes: ['analytics:read', 'analytics:export'],
    });
    expect(partner.ok).toBe(true);
    if (!partner.ok) return;
    expect(partner.data.crawlOemShared).toBe(false);
    expect(partner.data.crawlCreditsShared).toBe(false);

    // Provision R3 child tenant
    const child = mgr.provisionChildTenant({
      rawOemKey: partner.data.rawOemKey,
      childTenantId: 'ten-child-001',
      childName: 'Client Brand A',
      planScopes: ['analytics:read', 'analytics:export', 'sites:manage'],
      delegationPolicy: {
        allowedOemScopes: ['analytics:read', 'analytics:export'],
        maxExchangedTokenTtlSec: 1800, // will be hard-clamped to 900s (15 min)!
        allowOemAccess: true,
      },
      actorSub: 'agency-op-1',
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.data.delegationPolicy.maxExchangedTokenTtlSec).toBe(900);

    // Exchange for <=15 min `act`-claim child token
    const exchanged = mgr.exchangeForChildToken({
      rawOemKey: partner.data.rawOemKey,
      childTenantId: 'ten-child-001',
      actorSub: 'agency-op-1',
      requestedScopes: ['analytics:read', 'analytics:export', 'sites:manage'],
      requestedTtlSec: 3600,
    });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    const ttlMs =
      Date.parse(exchanged.data.claims.expiresAt) -
      Date.parse(exchanged.data.claims.issuedAt);
    expect(ttlMs).toBeLessThanOrEqual(900_000);
    expect(exchanged.data.claims.act.sub).toBe('agency-op-1');
    expect(exchanged.data.principal.effectiveScopes.has('sites:manage')).toBe(false);

    // OEM parent is STRICTLY forbidden from viewing visual replays (§11.11 #8)
    const replayAuth = mgr.authorizeVisualReplayAccess(
      exchanged.data.principal,
      'ten-child-001'
    );
    expect(replayAuth.allowed).toBe(false);
    expect(replayAuth.status).toBe('not_entitled');

    // OEM parent export MUST enforce external-party <10 + complementary suppression!
    const exportRes = await mgr.exportChildDataForOemParent({
      principal: exchanged.data.principal,
      exportId: 'oem-exp-1',
      childTenantId: 'ten-child-001',
      siteId: 'site-c1',
      target: 'bigquery',
      storageRegion: 'jp',
      destinationRegion: 'jp',
      deletionEpoch: 1,
      sourceEventCutoffMs: Date.UTC(2026, 10, 20, 9, 0, 0),
      nowMs: Date.UTC(2026, 10, 20, 9, 5, 0),
      rows: [
        {
          rowId: 'r-small',
          tenantId: 'ten-child-001',
          siteId: 'site-c1',
          windowStartIso: '2026-11-20T08:00:00.000Z',
          windowEndIso: '2026-11-20T09:00:00.000Z',
          collectionGen: 'v3',
          schemaVersion: '2.0.0',
          consentMode: 'cookieless',
          purposesAllowed: [],
          revocationEpoch: 1,
          retentionExpiresAtIso: '2027-12-20T00:00:00.000Z',
          trustLevel: 'edge_attested',
          missingFlags: [],
          lane: 'standard_telemetry',
          evidenceLevel: 'observed',
          cellUnitCount: 5,
          metrics: { pvs: 5 },
        },
        {
          rowId: 'r-next',
          tenantId: 'ten-child-001',
          siteId: 'site-c1',
          windowStartIso: '2026-11-20T08:00:00.000Z',
          windowEndIso: '2026-11-20T09:00:00.000Z',
          collectionGen: 'v3',
          schemaVersion: '2.0.0',
          consentMode: 'cookieless',
          purposesAllowed: [],
          revocationEpoch: 1,
          retentionExpiresAtIso: '2027-12-20T00:00:00.000Z',
          trustLevel: 'edge_attested',
          missingFlags: [],
          lane: 'standard_telemetry',
          evidenceLevel: 'observed',
          cellUnitCount: 20,
          metrics: { pvs: 20 },
        },
      ],
    });
    expect(exportRes.ok).toBe(true);
    if (exportRes.ok) {
      expect(exportRes.data.suppressedCellsCount).toBe(1);
      expect(exportRes.data.complementarySuppressedCount).toBe(1);
    }

    // Usage isolated per child with 0 shared CRAWL credits
    const usage = mgr.recordChildUsage('ten-child-001', { billableStandardPvs: 1000 });
    expect(usage.crawlCreditsShared).toBe(0);
    expect(mgr.getAuditLog().verifyChain().valid).toBe(true);
  });
});

describe('lib/link/oem/billing-guard (1M public-key flood & 30d ledger reconciliation)', () => {
  test('1,000,000 single-network public-key flood events across all 4 lanes cause $0 invoice delta, 0 sampling delta, and 0 drops of attested traffic', () => {
    const sim = simulatePublicKeyFlood({
      floodEventsPerLane: 250_000, // 250k * 4 lanes = 1,000,000 flood events!
      genuineAttestedEvents: 200,
    });
    expect(sim.totalFloodEventsSent).toBe(1_000_000);
    expect(sim.passed).toBe(true);
    expect(sim.invoiceDeltaUsd).toBe(0);
    expect(sim.samplingRateDelta).toBe(0);
    expect(sim.attestedGenuineEventsBilled).toBe(200);
    expect(sim.attestedGenuineEventsHeld).toBe(0);

    // Failed destination deliveries & retries & lab tokens are never billed
    const guard = new LaneBillingGuard();
    expect(
      guard.evaluateUnit({
        tenantId: 't1',
        siteId: 's1',
        lane: 'destination_delivery',
        dedupeId: 'del-fail-1',
        networkPrefix: '198.51.100.0/24',
        credentialKind: 'ugk_sec',
        trust: 'edge_attested',
        stored: true,
        deliverySucceeded: false,
      }).billable
    ).toBe(false);

    // Over-quota degrades to over_quota_count_only (HTTP 200, NEVER 402, distinct from stub arm)
    const quotaOver = evaluateUsageQuotaBehavior(2_500_000, 2_000_000);
    expect(quotaOver.browserHttpStatus).toBe(200);
    expect(quotaOver.measurementDegradeMode).toBe('over_quota_count_only');
    expect(quotaOver.distinctFromWeightTestStubArm).toBe(true);
    expect(quotaOver.triggeredThresholdsPct).toEqual([80, 100, 120]);
  });

  test('blocks overage billing until 30 consecutive days satisfy abs(ledger - recount) <= max(0.1%, 5 units)', () => {
    const startMs = Date.UTC(2026, 9, 1, 0, 0, 0);
    const entries: DailyBillingReconciliationEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      entries.push({
        dayUtc: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
        ledgerUnits: 100_000 + (i % 50), // <= 0.05% diff (inside 0.1% = 100 units)
        recountUnits: 100_000,
      });
    }

    const passReport = evaluateBillingReconciliationGate(entries);
    expect(passReport.overageBillingUnlocked).toBe(true);
    expect(passReport.consecutivePassingDays).toBe(30);
    expect(passReport.failedDays).toHaveLength(0);

    // Inject 1 single day exceeding 0.1% (diff = 150 > 100) on day 20 -> resets streak to 10 -> LOCKED!
    const drifted = entries.map((e, idx) =>
      idx === 19 ? { ...e, ledgerUnits: 100_150 } : e
    );
    const blockedReport = evaluateBillingReconciliationGate(drifted);
    expect(blockedReport.overageBillingUnlocked).toBe(false);
    expect(blockedReport.consecutivePassingDays).toBe(10);
    expect(blockedReport.failedDays).toHaveLength(1);
  });

  test('Wave 8 Regressions (H-24, M-04): OEM export requires analytics:export scope, revoking partner/delegation invalidates child tokens, and LaneBillingGuard enforces dayUtc reset + shared cross-lane prefix cap', async () => {
    const reg = new IdentityKeyRegistry({ pepperVersion: 'p1', pepperSecret: 'pep-oem' });
    const mgr = new OemPartnerManager(reg, undefined, {
      decision15ApprovedOverride: true,
      legalSignOffOverride: true,
    });
    const partner = mgr.registerOemPartner({
      orgId: 'org-h24',
      name: 'H24 OEM',
      managementTenantId: 'ten-mgmt-h24',
      oemLegalSignoffRef: 'dpa-h24',
      delegableScopes: ['analytics:read', 'analytics:export'],
    });
    expect(partner.ok).toBe(true);
    if (!partner.ok) return;

    mgr.provisionChildTenant({
      rawOemKey: partner.data.rawOemKey,
      childTenantId: 'ten-child-h24',
      childName: 'Child H24',
      planScopes: ['analytics:read', 'analytics:export'],
      delegationPolicy: {
        allowedOemScopes: ['analytics:read', 'analytics:export'],
        maxExchangedTokenTtlSec: 900,
        allowOemAccess: true,
      },
      actorSub: 'op-1',
    });

    // Token with ONLY analytics:read MUST be rejected by exportChildDataForOemParent
    const readOnlyEx = mgr.exchangeForChildToken({
      rawOemKey: partner.data.rawOemKey,
      childTenantId: 'ten-child-h24',
      actorSub: 'op-1',
      requestedScopes: ['analytics:read'],
    });
    expect(readOnlyEx.ok).toBe(true);
    if (!readOnlyEx.ok) return;

    const deniedExport = await mgr.exportChildDataForOemParent({
      principal: readOnlyEx.data.principal,
      exportId: 'exp-denied',
      childTenantId: 'ten-child-h24',
      siteId: 's1',
      target: 'bigquery',
      storageRegion: 'jp',
      destinationRegion: 'jp',
      deletionEpoch: 1,
      rows: [],
      sourceEventCutoffMs: 1000,
      nowMs: 2000,
    });
    expect(deniedExport.ok).toBe(false);

    // Revoking child delegation immediately invalidates already-exchanged token
    expect(mgr.revokeChildDelegation('ten-child-h24').revoked).toBe(true);
    expect(reg.verifyOemExchangedToken(readOnlyEx.data.token).ok).toBe(false);

    // M-04: Cross-lane continuity prefix cap (SHARED_DAILY_CONTINUITY_PREFIX_CAP = 500) + dayUtc reset
    const guard = new LaneBillingGuard();
    expect(
      guard.evaluateUnit({
        tenantId: 't1',
        siteId: 's1',
        lane: 'destination_delivery',
        dedupeId: 'pub-dest-1',
        networkPrefix: '192.0.2.0/24',
        credentialKind: 'ugk_pub',
        trust: 'continuity',
        stored: true,
        deliverySucceeded: true,
        dayUtc: '2026-11-20',
      }).billable
    ).toBe(false);

    let billedDay1 = 0;
    for (let i = 0; i < SHARED_DAILY_CONTINUITY_PREFIX_CAP + 50; i += 1) {
      const lane = i % 2 === 0 ? 'standard_telemetry_pv' : 'customer_event';
      if (
        guard.evaluateUnit({
          tenantId: 't1',
          siteId: 's1',
          lane,
          dedupeId: `d1-${i}`,
          networkPrefix: '198.51.100.0/24',
          credentialKind: 'ugk_pub',
          trust: 'continuity',
          stored: true,
          dayUtc: '2026-11-20',
        }).billable
      ) {
        billedDay1 += 1;
      }
    }
    expect(billedDay1).toBe(SHARED_DAILY_CONTINUITY_PREFIX_CAP);

    // Next UTC day resets daily prefix budget cleanly!
    expect(
      guard.evaluateUnit({
        tenantId: 't1',
        siteId: 's1',
        lane: 'standard_telemetry_pv',
        dedupeId: 'd2-0',
        networkPrefix: '198.51.100.0/24',
        credentialKind: 'ugk_pub',
        trust: 'continuity',
        stored: true,
        dayUtc: '2026-11-21',
      }).billable
    ).toBe(true);
  });
});
