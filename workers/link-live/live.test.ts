/**
 * UGOKI LINK v2 — 30-Minute Edge Live Durable Object Tests (`workers/link-live`)
 */

import { validateSerializedEnvelope } from '../../packages/contract/response';
import {
  EDGE_LIVE_P95_BUDGET_MS,
  InMemoryDurableObjectState,
  LIVE_WINDOW_MINUTES,
  MINUTE_MS,
  SiteLiveDurableObject,
} from './index';

describe('workers/link-live (30-min Edge Live DO)', () => {
  const baseMs = Date.UTC(2026, 10, 20, 10, 0, 0);

  test('tracks 1-minute buckets across a 30-minute sliding window with idempotent PV merging and pruning', () => {
    const live = new SiteLiveDurableObject({
      tenantId: 'tenant-live',
      siteId: 'site-1',
      storageRegion: 'jp',
    });

    // Event at t = 0 min (will age out once we advance to t = 31 min)
    const oldReceipt = live.ingest(
      {
        tenantId: 'tenant-live',
        siteId: 'site-1',
        storageRegion: 'jp',
        processingRegion: 'jp',
        lane: 'standard_telemetry',
        unitId: 'pv-old',
        receivedAtMs: baseMs,
        visMs: 5000,
        scrollMaxPx: 400,
        trust: 'continuity',
        consentMode: 'cookieless',
      },
      baseMs
    );
    expect(oldReceipt.accepted).toBe(true);
    expect(oldReceipt.deduplicated).toBe(false);

    // Event at t = 25 min, then WAL heal update for same PV at t = 26 min
    const r1 = live.ingest(
      {
        tenantId: 'tenant-live',
        siteId: 'site-1',
        storageRegion: 'jp',
        processingRegion: 'jp',
        lane: 'standard_telemetry',
        unitId: 'pv-active',
        receivedAtMs: baseMs + 25 * MINUTE_MS,
        visMs: 3000,
        scrollMaxPx: 300,
        trust: 'none', // initially none -> not billable yet
        consentMode: 'cookieless',
        ingestSource: 'collector',
      },
      baseMs + 25 * MINUTE_MS
    );
    expect(r1.excludedFromBillablePvs).toBe(true);

    const r2 = live.ingest(
      {
        tenantId: 'tenant-live',
        siteId: 'site-1',
        storageRegion: 'jp',
        processingRegion: 'jp',
        lane: 'standard_telemetry',
        unitId: 'pv-active',
        receivedAtMs: baseMs + 26 * MINUTE_MS,
        visMs: 12_000,
        scrollMaxPx: 1400,
        trust: 'edge_attested', // upgraded -> now billable!
        consentMode: 'cookieless',
        ingestSource: 'wal_heal',
      },
      baseMs + 26 * MINUTE_MS
    );
    expect(r2.deduplicated).toBe(true);
    expect(r2.excludedFromBillablePvs).toBe(false);

    // Query at t = 31 min: pv-old (t=0) MUST be pruned; pv-active counted once with visMs=12000
    const q = live.queryLiveEnvelope({ nowMs: baseMs + 31 * MINUTE_MS });
    expect(q.buckets).toHaveLength(LIVE_WINDOW_MINUTES);
    expect(q.envelope.status).toBe('ok');
    expect(q.envelope.measures.standard_live_pvs?.value).toBe(1);
    expect(q.envelope.measures.standard_live_billable_pvs?.value).toBe(1);
    expect(q.envelope.measures.standard_live_sum_vis_ms?.value).toBe(12_000);
    expect(q.envelope.quality?.source).toBe('edge_live');
    expect(q.envelope.residency).toEqual({
      storage_region: 'jp',
      processing_region: 'jp',
    });

    const validation = validateSerializedEnvelope(q.envelope);
    expect(validation.valid).toBe(true);
  });

  test('routes onboarding_verify (lab_token) into dedicated <=60s lane and excludes 100% from human & billable totals', () => {
    const live = new SiteLiveDurableObject({
      tenantId: 'tenant-onboard',
      siteId: 'site-onboard',
      storageRegion: 'jp',
    });

    const visitTs = baseMs + 10_000;
    const observedTs = visitTs + 2_500; // 2.5s visibility latency (<< 60s SLA)

    const receipt = live.ingest(
      {
        tenantId: 'tenant-onboard',
        siteId: 'site-onboard',
        storageRegion: 'jp',
        processingRegion: 'jp',
        lane: 'standard_telemetry',
        unitId: 'pv-onboarding-verify-1',
        occurredAtMs: visitTs,
        receivedAtMs: visitTs + 500,
        visMs: 9000,
        trust: 'edge_attested',
        consentMode: 'cookieless',
        labToken: {
          tokenId: 'tok_verify_001',
          tenantId: 'tenant-onboard',
          siteId: 'site-onboard',
          purpose: 'onboarding_verify',
          runId: 'run_001',
          issuedAtMs: baseMs,
          expiresAtMs: baseMs + 15 * MINUTE_MS,
        },
      },
      observedTs
    );

    expect(receipt.accepted).toBe(true);
    expect(receipt.routedTo).toBe('onboarding_verify_lane');
    expect(receipt.excludedFromHumanTotals).toBe(true);
    expect(receipt.excludedFromBillablePvs).toBe(true);

    const status = live.getOnboardingVerificationStatus(observedTs, 'tok_verify_001');
    expect(status.verified).toBe(true);
    expect(status.within60sSla).toBe(true);
    expect(status.latestVisit?.visibilityLatencyMs).toBe(2500);
    expect(status.latestVisit?.excludedFromHumanTotals).toBe(true);
    expect(status.latestVisit?.excludedFromBillablePvs).toBe(true);

    // Human & billable counts MUST remain 0 (100% excluded)
    const liveQuery = live.queryLiveEnvelope({ nowMs: observedTs });
    expect(liveQuery.envelope.measures.standard_live_pvs?.value).toBe(0);
    expect(liveQuery.envelope.measures.standard_live_billable_pvs?.value).toBe(0);
    expect(liveQuery.envelope.measures.customer_events_live_count?.value).toBe(0);
    expect(liveQuery.envelope.measures.visual_replay_live_count?.value).toBe(0);
    expect((liveQuery.envelope.data as { lab_excluded_events: number }).lab_excluded_events).toBe(1);
  });

  test('enforces strict 3-lane separation, D-29 region/tenant isolation, DO persistence, and <=20ms p95 latency', async () => {
    const doState = new InMemoryDurableObjectState('do-site-multi');
    const live = new SiteLiveDurableObject({
      tenantId: 't-multi',
      siteId: 's-multi',
      storageRegion: 'jp',
      state: doState,
    });

    // Reject foreign tenant and mismatched storage region
    expect(
      live.ingest({
        tenantId: 't-other',
        siteId: 's-multi',
        storageRegion: 'jp',
        processingRegion: 'jp',
        lane: 'standard_telemetry',
        unitId: 'pv-foreign',
        receivedAtMs: baseMs,
        trust: 'edge_attested',
        consentMode: 'cookieless',
      }).accepted
    ).toBe(false);

    expect(
      live.ingest({
        tenantId: 't-multi',
        siteId: 's-multi',
        storageRegion: 'eu',
        processingRegion: 'eu',
        lane: 'standard_telemetry',
        unitId: 'pv-wrong-region',
        receivedAtMs: baseMs,
        trust: 'edge_attested',
        consentMode: 'cookieless',
      }).accepted
    ).toBe(false);

    // Ingest cleanly across all 3 separate lanes
    live.ingest({
      tenantId: 't-multi',
      siteId: 's-multi',
      storageRegion: 'jp',
      processingRegion: 'jp',
      lane: 'standard_telemetry',
      unitId: 'pv-1',
      receivedAtMs: baseMs,
      trust: 'origin_attested',
      consentMode: 'cookieless',
    });
    live.ingest({
      tenantId: 't-multi',
      siteId: 's-multi',
      storageRegion: 'jp',
      processingRegion: 'jp',
      lane: 'customer_events',
      unitId: 'evt-1',
      receivedAtMs: baseMs + 1000,
      trust: 'continuity',
      consentMode: 'session',
    });
    live.ingest({
      tenantId: 't-multi',
      siteId: 's-multi',
      storageRegion: 'jp',
      processingRegion: 'jp',
      lane: 'customer_events',
      unitId: 'evt-2',
      receivedAtMs: baseMs + 2000,
      trust: 'continuity',
      consentMode: 'session',
    });
    live.ingest({
      tenantId: 't-multi',
      siteId: 's-multi',
      storageRegion: 'jp',
      processingRegion: 'jp',
      lane: 'visual_replay',
      unitId: 'rep-1',
      receivedAtMs: baseMs + 3000,
      trust: 'continuity',
      consentMode: 'full',
    });

    // Checkpoint & restore from DO storage
    await live.checkpointToStorage(baseMs + 5000);
    const restored = new SiteLiveDurableObject({
      tenantId: 't-multi',
      siteId: 's-multi',
      storageRegion: 'jp',
      state: doState,
    });
    expect(await restored.restoreFromStorage()).toBe(true);

    // Measure 100 consecutive queries for p95 <= 20ms gate (store.G-6)
    let lastOut = restored.queryLiveEnvelope({ nowMs: baseMs + 5000 });
    for (let i = 0; i < 99; i += 1) {
      lastOut = restored.queryLiveEnvelope({ nowMs: baseMs + 5000 + i });
    }

    expect(lastOut.envelope.measures.standard_live_pvs?.value).toBe(1);
    expect(lastOut.envelope.measures.standard_live_billable_pvs?.value).toBe(1);
    expect(lastOut.envelope.measures.customer_events_live_count?.value).toBe(2);
    expect(lastOut.envelope.measures.visual_replay_live_count?.value).toBe(1);
    expect(restored.getObservedQueryP95Ms()).toBeLessThanOrEqual(EDGE_LIVE_P95_BUDGET_MS);
  });
});
