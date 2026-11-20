import { hmacSha256Hex } from '../../lib/link/allocator';
import { isUntrustedValue } from '../../packages/contract/response';
import {
  CANONICAL_SCHEMA,
  CODEC_VERSION,
  computeFrameChecksum,
  createSdkFrameCodec,
  type TelemetryFrame,
} from '../../packages/contract/schema';
import { computeUrlKeyV2 } from '../../packages/contract/urlkey';
import {
  CrossLaneAggregationError,
  LinkCollectorEngine,
  PROTECTED_HUMAN_PIPELINES,
  SegmentCompatIngestEngine,
  assertSingleMeasurementLane,
  auditZeroLabLeakage,
  createCollectorWorker,
  filterForHumanPipeline,
  serializeCustomEventForResponse,
  signLabMarker,
  type CustomEventPersistedRecord,
  type LabMarkerPurpose,
  type PersistedCollectorRecord,
  type QueueLike,
  type R2BucketLike,
  type SiteKeyRegistration,
} from './index';

function makeValidFrame(overrides?: Partial<TelemetryFrame>): TelemetryFrame {
  const urlRes = computeUrlKeyV2('https://wakegai.jp/ranking/');
  const state = {
    page_url_key: urlRes.url_key_v2,
    nav_type: 'navigate' as const,
    started_hidden: false,
    scroll_max_px: 640,
    doc_h_first: 2400,
    doc_h_max: 2400,
    doc_h_last: { value: 2400, seq: 1 },
    vis_ms: 4200,
    reversals: 1,
    js_error_n: 0,
    degrade_level: 0,
    dom_state: 'ok' as const,
    skel_fp: 'aabbccddeeff',
    css_fp: null,
    head_fp: null,
    variant_key: 'default',
    sample_pi: 0.5,
    ...(overrides?.state ?? {}),
  };
  const sections = overrides?.sections ?? [
    { sec_fp: '112233445566', vis_ms: 3000, t_first_ms: 200, entries: 1, max_frac_permille: 850 },
  ];
  const logItems = overrides?.log_items ?? [
    { i: 1, kind: 'activation' as const, t_mono: 3500, activation_kind: 'click' as const, el_fp: 'el_cta_1' },
  ];

  const base: Omit<TelemetryFrame, 'chk'> = {
    codec_ver: CODEC_VERSION,
    schema_ver: CANONICAL_SCHEMA.meta.wireVersion,
    sdk_build: 'v3.0.0',
    pv_id: '0123456789abcdef0123456789abcdef',
    seq: 1,
    cont_of: null,
    frame_class: 'change',
    transport: 'fetch',
    full: false,
    vis_episode: 1,
    t_mono: 4200,
    t_wall: 1795000000000,
    ack_echo_seq: 0,
    pv_token: null,
    consent_mode: 'cookieless',
    purposes: ['experiment'],
    arm_bits: 0b010,
    def_ver: 1,
    url_id: urlRes.url_id,
    key_ver: 2,
    profile_rev: 1,
    dim_tuple_code: 12,
    live_word: 0,
    key_degraded: false,
    handoff_token: null,
    visitor_id: null,
    session_id: null,
    member_hash: null,
    lab_run_id: null,
    state,
    sections,
    log_items: logItems,
    ...overrides,
  };

  return {
    ...base,
    chk: overrides?.chk ?? computeFrameChecksum({ state: base.state, sections: base.sections, log_items: base.log_items }),
  };
}

function makeMemoryR2() {
  const objects = new Map<string, string>();
  let failPut = false;
  const bucket: R2BucketLike = {
    async put(key: string, value: string | Uint8Array) {
      if (failPut) throw new Error('R2_UNAVAILABLE');
      objects.set(key, typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
    },
  };
  return {
    bucket,
    objects,
    setFail: (v: boolean) => {
      failPut = v;
    },
  };
}

function makeMemoryQueue<T>() {
  const messages: T[] = [];
  let failSend = false;
  let onBeforeSendResolve: (() => void) | null = null;
  const queue: QueueLike<T> = {
    async send(msg: T) {
      if (failSend) throw new Error('QUEUE_THROTTLED');
      await Promise.resolve();
      messages.push(msg);
      onBeforeSendResolve?.();
    },
  };
  return {
    queue,
    messages,
    setFail: (v: boolean) => {
      failSend = v;
    },
    setHook: (fn: (() => void) | null) => {
      onBeforeSendResolve = fn;
    },
  };
}

function makeTestSite(overrides?: Partial<SiteKeyRegistration>): SiteKeyRegistration {
  return {
    publishableKey: 'ugk_pub_wakegai',
    tenantId: 'ten_01',
    siteId: 'site_wakegai',
    edgeHandoffMacKey: 'edge_handoff_secret_1',
    originAttestKey: 'origin_attest_secret_1',
    tenantMemberHashKey: 'tenant_member_hmac_secret_1',
    baseline28dHourVolume: 10,
    surgeMultiplier: 2, // threshold = 20
    prefixDailyCap: 3,
    originAttestedPrefixDailyCap: 100,
    allowedTraitKeys: ['plan', 'tier'],
    customEventRegistry: {
      site_id: 'site_wakegai',
      looseModeAllowed: false,
      definitions: [
        {
          event_name: 'checkout_completed',
          def_ver: 2,
          properties: [
            { name: 'total_jpy', type: 'number', required: true },
            { name: 'coupon_used', type: 'boolean' },
            { name: 'channel', type: 'enum', enumValues: ['web', 'app'] },
            { name: 'memo', type: 'string' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('workers/link-collector — Bundles 3-A, 3-B, 3-C (Collector, Surge Breaker, Segment Compat & Lab Marker)', () => {
  test('tel.G1: NEVER returns ACK before Queue resolves; spills to R2 on Queue refusal; returns 503 ONLY if both fail', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite();

    const collector = new LinkCollectorEngine({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_secret',
      labMarkerSecret: 'lab_secret',
      mainQueue: q.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      nowMs: () => 1795000000000,
    });

    // 1. Enqueue must complete BEFORE ACK returns
    let enqueueCompleted = false;
    q.setHook(() => {
      enqueueCompleted = true;
    });
    const okRes = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame(),
      networkPrefix: '203.0.113.0/24',
    });
    expect(enqueueCompleted).toBe(true);
    expect(okRes.status).toBe(200);
    expect(okRes.ack?.accepted_saved).toBe(true);
    expect(okRes.ack?.spilled_to_r2).toBe(false);
    expect(okRes.ack?.pv_token).toMatch(/^pvt1\./);
    expect(okRes.ack?.url_key_idempotent).toBe(true);
    expect(q.messages).toHaveLength(1);

    // 2. Queue refuses -> spills to R2 and STILL returns 200 ACK (`spilled_to_r2: true`)
    q.setFail(true);
    const spillRes = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 2 }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(spillRes.status).toBe(200);
    expect(spillRes.ack?.accepted_saved).toBe(true);
    expect(spillRes.ack?.spilled_to_r2).toBe(true);
    expect(spill.objects.size).toBe(1);

    // 3. BOTH Queue AND R2 fail -> 503 with NO ACK!
    spill.setFail(true);
    const failRes = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 3 }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(failRes.status).toBe(503);
    expect(failRes.ack).toBeNull();
    expect(failRes.error).toBe('queue_and_spill_unavailable');
  });

  test('Partial Acceptance preserves valid fields while clamping/dropping bad fields; strings in int slots are sanitized in quarantine; detects post-ack loss after 10m', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite();

    let now = 1795000000000;
    const committedStore = new Set<string>();

    const collector = new LinkCollectorEngine({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_secret',
      labMarkerSecret: 'lab_secret',
      mainQueue: q.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      isFrameCommittedInStore: (pvId, seq) => committedStore.has(`${pvId}:${seq}`),
      nowMs: () => now,
    });

    // 1. Partial acceptance: out-of-range vis_ms clamped, frame still accepted!
    const badFieldFrame = makeValidFrame({
      seq: 1,
      state: {
        ...makeValidFrame().state,
        vis_ms: 999_999_999,
      },
    });
    const partialRes = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: badFieldFrame,
      networkPrefix: '198.51.100.0/24',
    });
    expect(partialRes.status).toBe(200);
    expect(partialRes.persistedRecord?.partial_accepted).toBe(true);
    expect(partialRes.ack?.rej.some((r) => r.includes('state.vis_ms'))).toBe(true);

    // 2. String injected into integer slot -> 400 quarantine with { type: 'string', length }, ZERO raw secret stored!
    const rawInjected = makeValidFrame({ seq: 2 }) as unknown as Record<string, unknown>;
    (rawInjected.state as Record<string, unknown>).vis_ms = 'SECRET_TYPED_STRING_99';
    const qRes = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: rawInjected,
      networkPrefix: '198.51.100.0/24',
    });
    expect(qRes.status).toBe(400);
    expect(quarantine.objects.size).toBe(1);
    const quarantinedJson = Array.from(quarantine.objects.values())[0];
    expect(quarantinedJson).not.toContain('SECRET_TYPED_STRING_99');
    expect(quarantinedJson).toContain('"length":22');

    // 3. Post-ack loss detection: frame seq=1 was acked at `now`, never committed to store.
    // 11 minutes later, frame seq=3 echoes `ack_echo_seq: 1` -> detected 100%!
    now += 11 * 60 * 1000;
    await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 3, ack_echo_seq: 1 }),
      networkPrefix: '198.51.100.0/24',
    });
    expect(collector.postAckLosses).toHaveLength(1);
    expect(collector.postAckLosses[0].echoed_seq).toBe(1);
  });

  test('§11.8 Surge Circuit Breaker holds unverified overflow WITHOUT saved ACK while NEVER holding edge/origin-attested traffic; over-quota degrades to count-only (never 402)', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    // baseline=2, multiplier=1 => surge threshold = 2 requests/hour
    const site = makeTestSite({
      baseline28dHourVolume: 2,
      surgeMultiplier: 1,
      prefixDailyCap: 2,
      overBillingQuota: true,
    });

    const collector = new LinkCollectorEngine({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_secret',
      labMarkerSecret: 'lab_secret',
      mainQueue: q.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      nowMs: () => 1795000000000,
    });

    const pvToken = collector.issuePvContinuityToken(
      site.tenantId,
      site.siteId,
      '0123456789abcdef0123456789abcdef'
    );

    // First 2 requests within baseline succeed (and signal over_quota_count_only, NEVER 402!)
    const r1 = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 1, pv_token: pvToken }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(r1.status).toBe(200);
    expect(r1.ack?.billing_mode).toBe('over_quota_count_only');
    expect(r1.persistedRecord?.billable).toBe(true);

    const r2 = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 2, pv_token: pvToken }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(r2.status).toBe(200);

    // 3rd request (unverified / continuity only) exceeds surge threshold -> HELD & NOT ACKed as saved!
    const r3Held = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 3, pv_token: pvToken }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(r3Held.status).toBe(202);
    expect(r3Held.ack?.held).toBe(true);
    expect(r3Held.ack?.accepted_saved).toBe(false);
    expect(r3Held.ack?.i_hw).toBe(-1);
    expect(r3Held.persistedRecord?.billable).toBe(false);
    expect(hold.objects.size).toBe(1);

    // 4th request WITH valid edge handoff (`edge_attested`) during the SAME surge -> NEVER HELD!
    const reqUid = '00000000000000000000000000000099';
    const handoffMac = hmacSha256Hex(site.edgeHandoffMacKey!, reqUid).slice(0, 24);
    const r4Edge = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 4 }),
      networkPrefix: '203.0.113.0/24',
      handoffHeader: `${reqUid}.${handoffMac}`,
    });
    expect(r4Edge.status).toBe(200);
    expect(r4Edge.ack?.held).toBe(false);
    expect(r4Edge.ack?.accepted_saved).toBe(true);
    expect(r4Edge.ack?.trust_level).toBe('edge_attested');
    expect(r4Edge.persistedRecord?.billable).toBe(true);
  });

  test('Bundle 3-B: Segment 6 calls + batch, pre-queue trait dropping, tenant userId hashing, consent rules & strict lane separation in storage + responses', async () => {
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const siteA = makeTestSite();
    const siteB = makeTestSite({
      publishableKey: 'ugk_pub_other',
      tenantId: 'ten_02',
      siteId: 'site_other',
      tenantMemberHashKey: 'different_tenant_key_2',
    });

    const compat = new SegmentCompatIngestEngine({
      sitesByPublishableKey: new Map([
        [siteA.publishableKey, siteA],
        [siteB.publishableKey, siteB],
      ]),
      labMarkerSecret: 'lab_secret',
      customEventQueue: customQ.queue,
      r2QuarantineBucket: quarantine.bucket,
      r2SpillBucket: spill.bucket,
      nowMs: () => 1795000000000,
    });

    // 1. All 6 Segment types accepted under full + member_link; unapproved PII traits DROPPED pre-queue!
    const batchRes = await compat.handleBatch(siteA.publishableKey, [
      {
        type: 'identify',
        userId: 'usr_9001',
        traits: { plan: 'pro', email: 'raw_pii@example.jp', phone: '090-1111-2222' },
        consent_mode: 'full',
        purposes: ['member_link'],
      },
      {
        type: 'page',
        name: 'Pricing',
        context: { page: { url: 'https://wakegai.jp/pricing/?utm_source=google' } },
        consent_mode: 'cookieless',
        purposes: [],
      },
      { type: 'screen', name: 'HomeTab', consent_mode: 'session', purposes: [] },
      {
        type: 'track',
        event: 'checkout_completed',
        properties: { total_jpy: 12000, coupon_used: true, channel: 'web', memo: 'fast shipping' },
        consent_mode: 'full',
        purposes: ['experiment'],
      },
      {
        type: 'group',
        groupId: 'org_77',
        traits: { tier: 'enterprise', secret_notes: 'drop_me' },
        consent_mode: 'full',
        purposes: ['member_link'],
      },
      {
        type: 'alias',
        userId: 'usr_9001',
        previousId: 'anon_123',
        consent_mode: 'full',
        purposes: ['member_link'],
      },
    ]);

    expect(batchRes.accepted_count).toBe(6);
    expect(batchRes.rejected_count).toBe(0);
    expect(customQ.messages).toHaveLength(6);

    // Verify ZERO raw unapproved PII traits exist in queue payloads
    const allQueuedJson = JSON.stringify(customQ.messages);
    expect(allQueuedJson).not.toContain('raw_pii@example.jp');
    expect(allQueuedJson).not.toContain('090-1111-2222');
    expect(allQueuedJson).not.toContain('drop_me');
    expect(allQueuedJson).not.toContain('usr_9001'); // userId MUST be tenant-hashed!

    const identifyRec = customQ.messages[0];
    expect(identifyRec.lane).toBe('custom_event');
    expect(identifyRec.allowed_traits).toEqual({ plan: 'pro' });
    expect(identifyRec.dropped_traits_count).toBe(2);
    expect(identifyRec.eligible_for_cross_tenant_pool).toBe(false);
    expect(identifyRec.eligible_for_standard_pv_billing).toBe(false);

    // Same userId on Tenant B hashes to a DIFFERENT value (§4.5)
    const tenantBRes = await compat.handleSingleCall(siteB.publishableKey, {
      type: 'identify',
      userId: 'usr_9001',
      consent_mode: 'full',
      purposes: ['member_link'],
    });
    expect(tenantBRes.accepted).toBe(true);
    expect(tenantBRes.record?.user_id_tenant_hash).not.toBe(identifyRec.user_id_tenant_hash);

    // 2. Consent violations rejected
    expect(
      (
        await compat.handleSingleCall(siteA.publishableKey, {
          type: 'track',
          event: 'checkout_completed',
          consent_mode: 'off',
        })
      ).status
    ).toBe(403);

    expect(
      (
        await compat.handleSingleCall(siteA.publishableKey, {
          type: 'identify',
          userId: 'u1',
          consent_mode: 'stats_exempt',
          purposes: ['member_link'],
        })
      ).status
    ).toBe(403);

    expect(
      (
        await compat.handleSingleCall(siteA.publishableKey, {
          type: 'track',
          event: 'checkout_completed',
          properties: { total_jpy: 100 },
          consent_mode: 'full',
          is_server_side: true, // missing consent_generation!
        })
      ).status
    ).toBe(400);

    // 3. Lane separation penetrates API responses + UntrustedValue wraps freeform strings + cross-lane sum throws!
    const trackRec = customQ.messages[3];
    const serialized = serializeCustomEventForResponse(trackRec);
    expect(serialized.lane).toBe('custom_event');
    expect(serialized.provenance.eligible_for_cross_tenant_pool).toBe(false);
    expect(serialized.properties.total_jpy).toBe(12000);
    expect(isUntrustedValue(serialized.properties.memo)).toBe(true);

    expect(() =>
      assertSingleMeasurementLane([{ lane: 'standard' }, { lane: 'custom_event' }])
    ).toThrow(CrossLaneAggregationError);
    expect(assertSingleMeasurementLane([{ lane: 'custom_event' }, { lane: 'custom_event' }])).toBe(
      'custom_event'
    );
  });

  test('Bundle 3-C Zero-Leakage Gate: ALL 6 Lab Marker purposes have 0 leakage into human rollups, quorums, experiments, ML training, loss ledger & billing', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite({ baseline28dHourVolume: 1000 });
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const labSecret = 'lab_signing_secret_2026';

    const worker = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_secret',
      labMarkerSecret: labSecret,
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      nowMs: () => now,
    });

    const codec = createSdkFrameCodec(CANONICAL_SCHEMA);

    // 1. Send 3 genuine human PVs (edge_attested so billable=true)
    for (let i = 1; i <= 3; i++) {
      const reqUid = `0000000000000000000000000000000${i}`;
      const mac = hmacSha256Hex(site.edgeHandoffMacKey!, reqUid).slice(0, 24);
      const pvId = i.toString(16).padStart(32, '0');
      const bin = codec.encodeFrame(makeValidFrame({ pv_id: pvId, seq: 1 }));
      const resp = await worker.fetch(
        new Request('https://collect.ugokilink.example/v1/collect/events', {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-ugk-key': site.publishableKey,
            'x-ugk-handoff': `${reqUid}.${mac}`,
          },
          body: bin,
        })
      );
      expect(resp.status).toBe(200);
    }

    // 2. Send all 6 Lab Marker purposes (`render`, `install_probe`, `canary_visit`, `preflight`, `agent_run`, `panel`)
    const purposes: readonly LabMarkerPurpose[] = [
      'render',
      'install_probe',
      'canary_visit',
      'preflight',
      'agent_run',
      'panel',
    ];

    for (let idx = 0; idx < purposes.length; idx++) {
      const purpose = purposes[idx];
      const marker = signLabMarker(
        {
          lab_run_id: `lab_run_${purpose}_${idx}`,
          purpose,
          site_id: site.siteId,
          issued_at: '2026-11-20T11:00:00.000Z',
          expires_at: '2026-11-20T13:00:00.000Z',
        },
        labSecret
      );

      const pvId = (100 + idx).toString(16).padStart(32, '0');
      const frame = makeValidFrame({ pv_id: pvId, seq: 1, lab_run_id: marker.lab_run_id });
      const resp = await worker.fetch(
        new Request('https://collect.ugokilink.example/v1/collect/events', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ugk-key': site.publishableKey,
            'x-ugk-lab-marker': JSON.stringify(marker),
          },
          body: JSON.stringify(frame),
        })
      );

      if (purpose === 'render') {
        // §12.2: `render` blocks ingestion completely!
        expect(resp.status).toBe(403);
      } else {
        expect(resp.status).toBe(200);
        const ack = (await resp.json()) as { lab_excluded: boolean };
        expect(ack.lab_excluded).toBe(true);
      }
    }

    // Queue holds 3 genuine human + 5 non-render lab records = 8 total
    expect(q.messages).toHaveLength(8);

    // Filter across ALL 6 protected human/commercial pipelines -> MUST keep 3 human & 0 lab!
    const pipelineOutputs = {
      human_rollups: filterForHumanPipeline(q.messages, 'human_rollups'),
      quorums: filterForHumanPipeline(q.messages, 'quorums'),
      experiments: filterForHumanPipeline(q.messages, 'experiments'),
      ml_training: filterForHumanPipeline(q.messages, 'ml_training'),
      loss_ledger: filterForHumanPipeline(q.messages, 'loss_ledger'),
      billing: filterForHumanPipeline(q.messages, 'billing'),
    };

    for (const pipeline of PROTECTED_HUMAN_PIPELINES) {
      expect(pipelineOutputs[pipeline]).toHaveLength(3);
    }

    const audit = auditZeroLabLeakage(pipelineOutputs);
    expect(audit.passed).toBe(true);
    expect(audit.leakedCount).toBe(0);

    // Also verify /v1/optout route
    const optOutRes = await worker.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': site.publishableKey },
      })
    );
    expect(optOutRes.status).toBe(200);
    expect(optOutRes.headers.get('set-cookie')).toContain('ugk_optout=1');
  });
});
