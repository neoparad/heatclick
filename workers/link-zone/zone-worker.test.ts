import { sha256Hex } from '../link-signer';
import {
  createZoneWorkerHandler,
  deriveZoneSubKeys,
  type ExecutionContextLike,
  type ZoneContextResponse,
  type ZoneObservationRecord,
} from './index';

const SAMPLE_ORIGIN_HTML = [
  '<!doctype html><html><head><title>Test</title></head><body>',
  '<h1 data-ugk-id="cta_head">元の見出し</h1>',
  '<a href="https://px.a8.net/svt/ejp?a8mat=ORIG123">公式を見る</a>',
  '</body></html>',
].join('');

function makeCtx(): { ctx: ExecutionContextLike; flush: () => Promise<void> } {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        promises.push(p);
      },
    },
    async flush() {
      await Promise.all(promises);
    },
  };
}

async function makeContextResponse(): Promise<ZoneContextResponse> {
  return {
    decision_id: 'dec_0123456789abcdef',
    bundle_seq: 12,
    lease_id: 'lease_abc',
    lease_issued_at_ms: 1795089600000,
    consent_mode: 'cookieless',
    unit_kind: 'page_view',
    draws: { 'patch:hero': 'treatment_b' },
    rewrites: [
      {
        op: 'SetText',
        marker_id: 'cta_head',
        expected_text_sha256: await sha256Hex('元の見出し'),
        new_text: '新しい見出し',
      },
    ],
    ctl_digest: 'ctl_sha_1',
  };
}

describe('Bundle 2-D.3: Customer-Deployed Single Zone Worker', () => {
  it('derives distinct per-function sub-keys from ugk_edge_* (D-24)', async () => {
    const keys = await deriveZoneSubKeys('ugk_edge_site_secret_demo');
    expect(keys.handoffMacKey).not.toBe(keys.logIngestKey);
    expect(keys.logIngestKey).not.toBe(keys.sessionTokenKey);
    expect(keys.handoffMacKey).not.toBe(keys.sessionTokenKey);
  });

  it('serves /_ugk/selftest diagnostics and enforces DELIVERY FIRST -> OBSERVATION AFTER (waitUntil)', async () => {
    const observations: ZoneObservationRecord[] = [];
    const ctxResp = await makeContextResponse();
    let captureRanBeforeResponseReturn = false;
    let responseReturned = false;

    const worker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_sha_256_demo',
      abi: 2,
      edgeIntegritySecret: 'ugk_edge_secret_1',
      modules: { deliver: true, handoff: true, origin_kit: true, capture: true, lab_sink: true },
      passthroughShare: 0, // force active delivery for this test
      regionClass: 'JP',
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      fetchDecisionContext: async () => ctxResp,
      shipObservation: async (rec) => {
        if (!responseReturned) {
          captureRanBeforeResponseReturn = true;
        }
        observations.push(rec);
      },
      mintReqUid: () => '00000000000000000000000000000001',
    });

    // Self-test check
    const stCtx = makeCtx();
    const selfTestRes = await worker.fetch(new Request('https://wakegai.jp/_ugk/selftest'), stCtx.ctx);
    expect(selfTestRes.status).toBe(200);
    const selfTest = (await selfTestRes.json()) as {
      release_hash: string;
      delivery_before_capture: boolean;
      conformance_passed: boolean;
    };
    expect(selfTest.release_hash).toBe('rel_sha_256_demo');
    expect(selfTest.delivery_before_capture).toBe(true);
    expect(selfTest.conformance_passed).toBe(true);

    // HTML request: deliver first, capture deferred in waitUntil AFTER response returns
    const reqCtx = makeCtx();
    const res = await worker.fetch(
      new Request('https://wakegai.jp/ranking/', {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/137.0' },
      }),
      reqCtx.ctx
    );
    responseReturned = true;
    await reqCtx.flush();

    expect(captureRanBeforeResponseReturn).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers.get('server-timing')).toMatch(/^ugk;desc="00000000000000000000000000000001\.[0-9a-f]{24}"$/);
    expect(res.headers.get('x-ugk-region')).toBe('JP');
    // cookieless mode MUST NOT emit Stratum-A Set-Cookie
    expect(res.headers.get('set-cookie')).toBeNull();

    const html = await res.text();
    expect(html).toContain('新しい見出し');
    expect(html).toContain('<script type="application/json" id="ugk-ctx">');
    // Real visitor affiliate link MUST remain byte-identical
    expect(html).toContain('https://px.a8.net/svt/ejp?a8mat=ORIG123');

    expect(observations).toHaveLength(1);
    expect(observations[0].deliver_applied).toBe(true);
    expect(observations[0].execution_order).toEqual(['deliver', 'handoff', 'origin_kit', 'capture']);
  });

  it('produces identical delivered HTML across Chrome, Googlebot, and GPTBot UAs (no actor content differential)', async () => {
    const ctxResp = await makeContextResponse();
    const worker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_1',
      abi: 2,
      edgeIntegritySecret: 'ugk_edge_secret_1',
      modules: { deliver: true, handoff: true, origin_kit: false, capture: true, lab_sink: false },
      passthroughShare: 0,
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      fetchDecisionContext: async () => ctxResp,
      shipObservation: async () => {},
      mintReqUid: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    const uas = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/137.0.0.0 Safari/537.36',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2',
    ];

    const bodies: string[] = [];
    for (const ua of uas) {
      const c = makeCtx();
      const res = await worker.fetch(
        new Request('https://wakegai.jp/ranking/', { headers: { 'user-agent': ua } }),
        c.ctx
      );
      await c.flush();
      bodies.push(await res.text());
    }
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });

  it('fails open on module exceptions, skips over-budget modules, and skips slow context race (>50ms)', async () => {
    const observations: ZoneObservationRecord[] = [];
    const ctxResp = await makeContextResponse();

    // 1. CPU budget exceeded on deliver -> skips deliver, keeps origin & handoff
    const budgetWorker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_1',
      abi: 2,
      edgeIntegritySecret: 'sec',
      modules: { deliver: true, handoff: true, origin_kit: false, capture: true, lab_sink: false },
      passthroughShare: 0,
      budgets: { deliverBudgetMs: 10 },
      measureModuleMs: (mod) => (mod === 'deliver' ? 25 : 1),
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      fetchDecisionContext: async () => ctxResp,
      shipObservation: async (r) => {
        observations.push(r);
      },
    });
    const c1 = makeCtx();
    const resBudget = await budgetWorker.fetch(new Request('https://wakegai.jp/'), c1.ctx);
    await c1.flush();
    expect(await resBudget.text()).toBe(SAMPLE_ORIGIN_HTML);
    expect(observations[0].deliver_skipped_reason).toBe('budget_exceeded');
    expect(observations[0].budget_skips).toContain('deliver');
    expect(observations[0].handoff_attached).toBe(true);

    // 2. Context race timeout (> 50ms) -> edge_skipped, origin passed through
    const slowWorker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_1',
      abi: 2,
      edgeIntegritySecret: 'sec',
      modules: { deliver: true, handoff: true, origin_kit: false, capture: true, lab_sink: false },
      passthroughShare: 0,
      budgets: { contextRaceMs: 15 },
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      fetchDecisionContext: () =>
        new Promise((resolve) => setTimeout(() => resolve(ctxResp), 80)),
      shipObservation: async (r) => {
        observations.push(r);
      },
    });
    const c2 = makeCtx();
    const resSlow = await slowWorker.fetch(new Request('https://wakegai.jp/'), c2.ctx);
    await c2.flush();
    expect(await resSlow.text()).toBe(SAMPLE_ORIGIN_HTML);
    expect(observations[1].deliver_skipped_reason).toBe('context_timeout');

    // 3. Unhandled exception inside module -> fail-open untouched origin response
    const crashWorker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_1',
      abi: 2,
      edgeIntegritySecret: 'sec',
      modules: { deliver: true, handoff: true, origin_kit: false, capture: true, lab_sink: false },
      passthroughShare: 0,
      measureModuleMs: () => {
        throw new Error('simulated_runtime_boom');
      },
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      fetchDecisionContext: async () => ctxResp,
      shipObservation: async () => {},
    });
    const c3 = makeCtx();
    const resCrash = await crashWorker.fetch(new Request('https://wakegai.jp/'), c3.ctx);
    expect(resCrash.status).toBe(200);
    expect(await resCrash.text()).toBe(SAMPLE_ORIGIN_HTML);
    expect(crashWorker.getSelfTestReport().counters.exception_fallback_count).toBe(1);
  });

  it('runs 1% pass-through arm bypassing deliver ONLY while keeping handoff & capture on 100% of requests', async () => {
    let seq = 0;
    const obs: ZoneObservationRecord[] = [];
    const ctxResp = await makeContextResponse();

    const worker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_1',
      abi: 2,
      edgeIntegritySecret: 'sec',
      modules: { deliver: true, handoff: true, origin_kit: false, capture: true, lab_sink: false },
      passthroughShare: 0.01,
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      fetchDecisionContext: async () => ctxResp,
      shipObservation: async (r) => {
        obs.push(r);
      },
      mintReqUid: () => (++seq).toString(16).padStart(32, '0'),
    });

    const N = 500;
    for (let i = 0; i < N; i++) {
      const c = makeCtx();
      await worker.fetch(new Request('https://wakegai.jp/'), c.ctx);
      await c.flush();
    }

    expect(obs).toHaveLength(N);
    expect(obs.every((o) => o.handoff_attached)).toBe(true);
    const passthroughCount = obs.filter((o) => o.passthrough_arm).length;
    // Expected ~5 out of 500 (binomial 99% range ~[0, 14], >0)
    expect(passthroughCount).toBeGreaterThan(0);
    expect(passthroughCount).toBeLessThan(20);
  });

  it('applies lab outbound sink ONLY when a verified lab_token is present (D-22)', async () => {
    const ctxResp = await makeContextResponse();
    const worker = createZoneWorkerHandler({
      tenantId: 't1',
      siteId: 's1',
      releaseHash: 'rel_1',
      abi: 2,
      edgeIntegritySecret: 'sec',
      modules: { deliver: true, handoff: true, origin_kit: false, capture: true, lab_sink: true },
      passthroughShare: 0,
      fetchOrigin: async () =>
        new Response(SAMPLE_ORIGIN_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      fetchDecisionContext: async () => ctxResp,
      verifyLabToken: async (tok) =>
        tok === 'valid_lab_tok' ? { run_id: 'run_canary_99', purpose: 'canary_visit' } : null,
      shipObservation: async () => {},
    });

    const c = makeCtx();
    const labRes = await worker.fetch(
      new Request('https://wakegai.jp/ranking/', {
        headers: { 'x-ugk-lab-token': 'valid_lab_tok' },
      }),
      c.ctx
    );
    await c.flush();
    const labHtml = await labRes.text();
    expect(labHtml).toContain('/_ugk/lab-sink?run_id=run_canary_99');
    expect(labHtml).not.toContain('https://px.a8.net/svt/ejp');
  });
});
