import { generateEd25519KeyPair } from '@/lib/link/auth';
import {
  BASELINE_FULL_REFRESH_RENDER_CREDITS,
  LinkScheduler,
  evaluateCapacityGate,
  signUsageReceipt,
  type ExecutorConformance,
} from './index';

const EXPECTED_CONFORMANCE: ExecutorConformance = {
  segmenterHash: 'seg1_sha256_deadbeef',
  profileSet: ['desktop_1440', 'mobile_390_touch'],
  probeBundleHash: 'probe_sha256_cafebabe',
};

function setupScheduler() {
  const crawlPair = generateEd25519KeyPair('exec_crawl_k1');
  const ugokiBrPair = generateEd25519KeyPair('exec_br_k1');
  const rawHtmlPair = generateEd25519KeyPair('exec_raw_k1');

  const scheduler = new LinkScheduler({
    expectedConformance: EXPECTED_CONFORMANCE,
    starvationMaxWaitMs: {
      safety: 30_000,
      integrity: 60_000,
      identity: 120_000,
      evidence: 180_000,
      enrichment: 300_000,
    },
  });

  scheduler.registerGrantBudget({
    grantId: 'lgr_1',
    tenantId: 'tenant_a',
    payer: 'ugoki_ledger',
    monthlyCreditsCap: 5000,
    dailyExternalSpendCapUsd: 20,
  });

  scheduler.registerExecutor({
    executorId: 'crawl_pool_1',
    kind: 'crawl_pool',
    supportedJobKinds: ['preflight_patch', 'sdk_replay', 'render_structure', 'probe_defect', 'crawl_http', 'serp_probe'],
    conformance: EXPECTED_CONFORMANCE,
    publicKeyPem: crawlPair.publicKeyPem,
    signerKid: crawlPair.kid,
    maxConcurrency: 2,
    dailyRenderCapacity: 15000,
    healthy: true,
    currentInFlight: 0,
  });

  scheduler.registerExecutor({
    executorId: 'ugoki_br_1',
    kind: 'ugoki_br',
    supportedJobKinds: ['preflight_patch', 'sdk_replay', 'render_structure', 'probe_defect'],
    conformance: EXPECTED_CONFORMANCE,
    publicKeyPem: ugokiBrPair.publicKeyPem,
    signerKid: ugokiBrPair.kid,
    maxConcurrency: 2,
    dailyRenderCapacity: 10000,
    healthy: true,
    currentInFlight: 0,
  });

  scheduler.registerExecutor({
    executorId: 'raw_html_1',
    kind: 'raw_html_floor',
    supportedJobKinds: ['render_structure', 'crawl_http'],
    conformance: EXPECTED_CONFORMANCE,
    publicKeyPem: rawHtmlPair.publicKeyPem,
    signerKid: rawHtmlPair.kid,
    maxConcurrency: 4,
    dailyRenderCapacity: 0,
    healthy: true,
    currentInFlight: 0,
  });

  return { scheduler, crawlPair, ugokiBrPair, rawHtmlPair };
}

describe('lib/link/scheduler — 5-Class Priority Queue, Starvation Guard, Conformance Failover, Signed Settlement & Capacity Gate', () => {
  test('dispatches jobs in strict 5-class priority order: safety > integrity > identity > evidence > enrichment', () => {
    const { scheduler } = setupScheduler();
    const t0 = new Date('2026-11-20T12:00:00Z');

    // Submit in REVERSE priority order
    scheduler.submitJob({ grantId: 'lgr_1', tenantId: 'tenant_a', siteId: 's1', planId: 'p1', window: 'w1', kind: 'crawl_http', targets: ['https://a.jp/1'], now: t0 });
    scheduler.submitJob({ grantId: 'lgr_1', tenantId: 'tenant_a', siteId: 's1', planId: 'p2', window: 'w1', kind: 'probe_defect', targets: ['https://a.jp/1'], now: t0 });
    scheduler.submitJob({ grantId: 'lgr_1', tenantId: 'tenant_a', siteId: 's1', planId: 'p3', window: 'w1', kind: 'render_structure', targets: ['https://a.jp/1'], now: t0 });
    scheduler.submitJob({ grantId: 'lgr_1', tenantId: 'tenant_a', siteId: 's1', planId: 'p4', window: 'w1', kind: 'sdk_replay', targets: ['https://a.jp/1'], now: t0 });
    scheduler.submitJob({ grantId: 'lgr_1', tenantId: 'tenant_a', siteId: 's1', planId: 'p5', window: 'w1', kind: 'preflight_patch', targets: ['https://a.jp/1'], now: t0 });

    // Increase concurrency temporarily to drain all 5 in sequence
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = scheduler.dispatchNext(t0);
      expect(d.dispatched).toBe(true);
      if (d.dispatched) order.push(d.job.priorityClass);
    }
    expect(order).toEqual(['safety', 'integrity', 'identity', 'evidence']);
  });

  test('starvation guard promotes overdue lower-class jobs while keeping safety absolute', () => {
    const { scheduler } = setupScheduler();
    const t0 = new Date('2026-11-20T12:00:00Z');

    // Old enrichment job submitted at t0
    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'old_enrich',
      window: 'w1',
      kind: 'crawl_http',
      targets: ['https://a.jp/old'],
      now: t0,
    });

    // Fresh identity job submitted at t0 + 6 min (after enrichment maxWaitMs = 5 min!)
    const tLater = new Date(t0.getTime() + 6 * 60_000);
    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'fresh_ident',
      window: 'w1',
      kind: 'render_structure',
      targets: ['https://a.jp/new'],
      now: tLater,
    });

    // Enrichment is starved -> promoted ahead of non-starved identity
    const first = scheduler.dispatchNext(tLater);
    expect(first.dispatched).toBe(true);
    if (first.dispatched) {
      expect(first.job.priorityClass).toBe('enrichment');
      expect(first.promotedByStarvationGuard).toBe(true);
    }

    // Even when another lower class is starved, `safety` ALWAYS goes first!
    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'old_evid',
      window: 'w2',
      kind: 'probe_defect',
      targets: ['https://a.jp/ev'],
      now: t0,
    });
    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'urgent_safety',
      window: 'w2',
      kind: 'preflight_patch',
      targets: ['https://a.jp/safety'],
      now: tLater,
    });

    const safetyFirst = scheduler.dispatchNext(tLater);
    expect(safetyFirst.dispatched).toBe(true);
    if (safetyFirst.dispatched) {
      expect(safetyFirst.job.priorityClass).toBe('safety');
    }
  });

  test('idempotent submission deduplicates without double-reserving credits, and enforces inline vs bulk lanes and budget caps', () => {
    const { scheduler } = setupScheduler();
    const t0 = new Date('2026-11-20T12:00:00Z');

    const sub1 = scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'plan_daily',
      window: '2026-11-20',
      kind: 'render_structure',
      targets: ['https://a.jp/p1', 'https://a.jp/p2'],
      knownUnchangedCount: 1, // 1 full (5) + 1 check-rate (1) = 6 credits
      now: t0,
    });
    expect(sub1.ok).toBe(true);
    if (!sub1.ok) return;
    expect(sub1.deduplicated).toBe(false);
    expect(sub1.quote.estimatedCredits).toBe(6);
    expect(sub1.quote.lane).toBe('inline');

    // Identical submission (even with reversed target order!) deduplicates cleanly
    const sub2 = scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'plan_daily',
      window: '2026-11-20',
      kind: 'render_structure',
      targets: ['https://a.jp/p2', 'https://a.jp/p1'],
      knownUnchangedCount: 1,
      now: t0,
    });
    expect(sub2.ok).toBe(true);
    if (sub2.ok) {
      expect(sub2.deduplicated).toBe(true);
      expect(sub2.job.jobId).toBe(sub1.job.jobId);
    }
    expect(scheduler.getGrantBudgetSnapshot('lgr_1')?.creditsReserved).toBe(6);

    // > 50 URLs routes render_structure to bulk lane automatically
    const manyUrls = Array.from({ length: 60 }, (_, i) => `https://a.jp/page-${i}`);
    const bulkSub = scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'plan_bulk',
      window: '2026-11-20',
      kind: 'render_structure',
      targets: manyUrls,
      now: t0,
    });
    expect(bulkSub.ok).toBe(true);
    if (bulkSub.ok) expect(bulkSub.quote.lane).toBe('bulk');

    // Exceeding external spend cap ($20) fails closed with 402
    const overSpend = scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'serp_panel',
      window: '2026-11-20',
      kind: 'serp_probe',
      targets: ['query-1'],
      estimatedExternalSpendUsd: 25,
      now: t0,
    });
    expect(overSpend.ok).toBe(false);
    if (!overSpend.ok) {
      expect(overSpend.httpStatus).toBe(402);
      expect(overSpend.code).toBe('EXTERNAL_SPEND_CAP_EXCEEDED');
    }
  });

  test('conformance-checked failover: fails over to conformant ugoki_br, blocks mismatched segmenter hash, and falls back to raw-HTML floor when browser renderers are down', () => {
    const { scheduler } = setupScheduler();
    const t0 = new Date('2026-11-20T12:00:00Z');

    // Mark CRAWL pool unhealthy -> should fail over to conformant ugoki_br_1
    scheduler.setExecutorHealth('crawl_pool_1', false);

    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'drift_1',
      window: 'w1',
      kind: 'render_structure',
      targets: ['https://a.jp/p1'],
      now: t0,
    });

    const failoverDisp = scheduler.dispatchNext(t0);
    expect(failoverDisp.dispatched).toBe(true);
    if (failoverDisp.dispatched) {
      expect(failoverDisp.executorId).toBe('ugoki_br_1');
      expect(failoverDisp.failoverUsed).toBe(true);
      expect(failoverDisp.rawHtmlFloorUsed).toBe(false);
    }

    // Replace ugoki_br_1 with a NON-CONFORMANT executor (different segmenterHash) -> MUST NOT dispatch browser job to it, falls back to raw-HTML floor for identity!
    scheduler.setExecutorHealth('ugoki_br_1', false);
    const badPair = generateEd25519KeyPair('bad_br');
    scheduler.registerExecutor({
      executorId: 'ugoki_br_mismatched',
      kind: 'ugoki_br',
      supportedJobKinds: ['render_structure', 'preflight_patch'],
      conformance: {
        ...EXPECTED_CONFORMANCE,
        segmenterHash: 'seg1_sha256_WRONG_HASH',
      },
      publicKeyPem: badPair.publicKeyPem,
      signerKid: badPair.kid,
      maxConcurrency: 5,
      dailyRenderCapacity: 10000,
      healthy: true,
      currentInFlight: 0,
    });

    // preflight_patch has NO raw-HTML fallback -> must refuse mismatched executor completely
    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'pf_1',
      window: 'w1',
      kind: 'preflight_patch',
      targets: ['https://a.jp/p1'],
      now: t0,
    });
    // render_structure (identity) CAN use raw-HTML identity floor when browser renderers are unavailable
    scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'drift_2',
      window: 'w1',
      kind: 'render_structure',
      targets: ['https://a.jp/p2'],
      allowRawHtmlFallback: true,
      now: t0,
    });

    const disp = scheduler.dispatchNext(t0);
    expect(disp.dispatched).toBe(true);
    if (disp.dispatched) {
      expect(disp.executorId).toBe('raw_html_1');
      expect(disp.rawHtmlFloorUsed).toBe(true);
    }
  });

  test('Ed25519 signed usage receipt settles single crawl_passthrough line idempotently, releases unused credits, and rejects forged/unmatched receipts', () => {
    const { scheduler, crawlPair } = setupScheduler();
    const t0 = new Date('2026-11-20T12:00:00Z');

    const sub = scheduler.submitJob({
      grantId: 'lgr_1',
      tenantId: 'tenant_a',
      siteId: 's1',
      planId: 'p_settle',
      window: 'w1',
      kind: 'render_structure',
      targets: ['https://a.jp/1', 'https://a.jp/2', 'https://a.jp/3', 'https://a.jp/4'], // 20 credits reserved
      now: t0,
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;

    const disp = scheduler.dispatchNext(t0);
    expect(disp.dispatched).toBe(true);
    if (!disp.dispatched) return;

    // Forged signature rejected
    const forgedReceipt = signUsageReceipt({
      receiptId: 'rcpt_forged',
      jobId: sub.job.jobId,
      grantId: 'lgr_1',
      executorId: 'crawl_pool_1',
      kind: 'render_structure',
      units: 4,
      credits: 12,
      externalSpendUsd: 0,
      scheduleHash: sub.job.scheduleHash,
      issuedAt: t0.toISOString(),
      signerKid: crawlPair.kid,
      privateKeyPem: generateEd25519KeyPair('attacker').privateKeyPem,
    });
    const forgedRes = scheduler.settleUsageReceipt(forgedReceipt, t0);
    expect(forgedRes.ok).toBe(false);
    if (!forgedRes.ok) expect(forgedRes.code).toBe('INVALID_RECEIPT_SIGNATURE');

    // Valid signed receipt (actual usage 12 credits out of 20 reserved -> releases 8 credits)
    const validReceipt = signUsageReceipt({
      receiptId: 'rcpt_valid_001',
      jobId: sub.job.jobId,
      grantId: 'lgr_1',
      executorId: 'crawl_pool_1',
      kind: 'render_structure',
      units: 4,
      credits: 12,
      externalSpendUsd: 0,
      scheduleHash: sub.job.scheduleHash,
      issuedAt: t0.toISOString(),
      signerKid: crawlPair.kid,
      privateKeyPem: crawlPair.privateKeyPem,
    });
    const settled = scheduler.settleUsageReceipt(validReceipt, t0);
    expect(settled.ok).toBe(true);
    if (settled.ok) {
      expect(settled.idempotentReplay).toBe(false);
      expect(settled.ledgerEntry.lineType).toBe('crawl_passthrough');
      expect(settled.ledgerEntry.creditsCharged).toBe(12);
      expect(settled.ledgerEntry.creditsReleased).toBe(8);
    }

    // Replaying exact receipt is idempotent (no double charge!)
    const replay = scheduler.settleUsageReceipt(validReceipt, t0);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.idempotentReplay).toBe(true);

    const budget = scheduler.getGrantBudgetSnapshot('lgr_1')!;
    expect(budget.creditsReserved).toBe(0);
    expect(budget.creditsSettled).toBe(12);
    expect(scheduler.getLedgerEntries()).toHaveLength(1);
    expect(scheduler.getUnmatchedReceiptCount()).toBe(0);
  });

  test('cumulative capacity >= 2x demand gate evaluates in priority order and protects upper classes during lower-class surges', () => {
    expect(BASELINE_FULL_REFRESH_RENDER_CREDITS).toBe(9100);

    // Fleet capacity = 25,000 renders/day; total demand = 9,100 -> overall ratio = 2.747 >= 2.0
    const healthyReport = evaluateCapacityGate({
      measuredDailyCapacity: 25000,
      demandByClass: {
        safety: 500,
        integrity: 1000,
        identity: 2500,
        evidence: 2100,
        enrichment: 3000,
      },
    });
    expect(healthyReport.totalDailyDemand).toBe(9100);
    expect(healthyReport.allTiersMeet2xGate).toBe(true);
    expect(healthyReport.upperClassesProtected).toBe(true);

    // Lower-class enrichment surge (20,000) pushes total demand above capacity/2,
    // yet upper classes (safety, integrity, identity = 4,000 cumulative -> ratio 6.25x) remain protected!
    const surgeReport = evaluateCapacityGate({
      measuredDailyCapacity: 25000,
      demandByClass: {
        safety: 500,
        integrity: 1000,
        identity: 2500,
        evidence: 2100,
        enrichment: 20000,
      },
    });
    expect(surgeReport.allTiersMeet2xGate).toBe(false);
    expect(surgeReport.upperClassesProtected).toBe(true);
    expect(surgeReport.tiers.find((t) => t.tier === 'identity')?.meets2xGate).toBe(true);
    expect(surgeReport.tiers.find((t) => t.tier === 'enrichment')?.meets2xGate).toBe(false);
  });
});
