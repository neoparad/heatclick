import { hmacSha256Hex } from '../../lib/link/allocator';
import {
  DeletionExecutionEngine,
  TenantKeyVersionRegistry,
  type DeletionStoreAdapter,
} from '../../lib/link/store';
import { isUntrustedValue } from '../../packages/contract/response';
import {
  CANONICAL_SCHEMA,
  CODEC_VERSION,
  computeCanonicalSubjectHmac,
  computeFrameChecksum,
  createSdkFrameCodec,
  type TelemetryFrame,
} from '../../packages/contract/schema';
import { computeUrlKeyV2 } from '../../packages/contract/urlkey';
import {
  BoundedTtlLruMap,
  CrossLaneAggregationError,
  LinkCollectorEngine,
  PROTECTED_HUMAN_PIPELINES,
  SegmentCompatIngestEngine,
  SharedInMemoryAckLedgerStore,
  assertSingleMeasurementLane,
  auditZeroLabLeakage,
  createCollectorWorker,
  deriveServerNetworkPrefix,
  filterForHumanPipeline,
  issueEdgeHandoffHeader,
  serializeCustomEventForResponse,
  signLabMarker,
  type CustomEventPersistedRecord,
  type LabMarkerPurpose,
  type LiveTailFrameEvent,
  type PersistedCollectorRecord,
  type QueueLike,
  type R2BucketLike,
  type SiteKeyRegistration,
  type SubjectDeletionRequest,
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
    expect(okRes.ack?.pv_token).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{32}$/);
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
    const validHandoff = issueEdgeHandoffHeader(reqUid, site.edgeHandoffMacKey!, 1795000000000);
    const r4Edge = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 4 }),
      networkPrefix: '203.0.113.0/24',
      handoffHeader: validHandoff,
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
    expect(identifyRec.lane).toBe('customer_defined');
    expect(identifyRec.allowed_traits).toEqual({ plan: 'pro' });
    expect(identifyRec.dropped_traits_count).toBe(2);
    expect(identifyRec.ml_training_eligible).toBe(false);
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
    expect(serialized.lane).toBe('customer_defined');
    expect(serialized.provenance.eligible_for_cross_tenant_pool).toBe(false);
    expect(serialized.properties.total_jpy).toBe(12000);
    expect(isUntrustedValue(serialized.properties.memo)).toBe(true);

    expect(() =>
      assertSingleMeasurementLane([{ lane: 'standard' }, { lane: 'custom_event' }])
    ).toThrow(CrossLaneAggregationError);
    expect(
      assertSingleMeasurementLane([{ lane: 'customer_defined' }, { lane: 'custom_event' }])
    ).toBe('customer_defined');
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
      deletionSink: {
        enqueueSubjectDeletion: async (req) => ({ receiptId: req.receiptId }),
      },
      nowMs: () => now,
    });

    const codec = createSdkFrameCodec(CANONICAL_SCHEMA);

    // 1. Send 3 genuine human PVs (edge_attested so billable=true)
    for (let i = 1; i <= 3; i++) {
      const reqUid = `0000000000000000000000000000000${i}`;
      const handoff = issueEdgeHandoffHeader(reqUid, site.edgeHandoffMacKey!, now);
      const pvId = i.toString(16).padStart(32, '0');
      const bin = codec.encodeFrame(makeValidFrame({ pv_id: pvId, seq: 1 }));
      const resp = await worker.fetch(
        new Request('https://collect.ugokilink.example/v1/collect/events', {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-ugk-key': site.publishableKey,
            'x-ugk-handoff': handoff,
            'CF-Connecting-IP': '203.0.113.42',
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

  test('[C-04] Rejects 1-char/short handoff MAC & stale skew, enforces 30m pv_token TTL, and ignores spoofed x-ugk-prefix in favor of CF-Connecting-IP', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    let now = 1795000000000;
    const site = makeTestSite({ prefixDailyCap: 2, unknownIpDailyCap: 1 });

    const worker = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_secret_c04',
      labMarkerSecret: 'lab_secret_c04',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      nowMs: () => now,
    });

    // 1. Canonical network prefix derivation
    expect(deriveServerNetworkPrefix('203.0.113.42')).toBe('203.0.113.0/24');
    expect(deriveServerNetworkPrefix('::ffff:203.0.113.99')).toBe('203.0.113.0/24');
    expect(deriveServerNetworkPrefix('2001:db8:abcd:1234::1')).toBe('2001:0db8:abcd::/48');
    expect(deriveServerNetworkPrefix(null)).toBe('unknown_ip');
    expect(deriveServerNetworkPrefix('not-an-ip')).toBe('unknown_ip');

    // 2. 1-char / 24-char truncated MAC & stale (>5m) handoff header MUST be rejected!
    const reqUid = '000000000000000000000000000000aa';
    const fullMac = hmacSha256Hex(site.edgeHandoffMacKey!, `handoff/1|${reqUid}|${now}`);
    expect(worker.collector.verifyEdgeHandoffHeader(`${reqUid}.${now}.${fullMac.slice(0, 1)}`, site, now)).toBe(false);
    expect(worker.collector.verifyEdgeHandoffHeader(`${reqUid}.${now}.${fullMac.slice(0, 24)}`, site, now)).toBe(false);
    expect(worker.collector.verifyEdgeHandoffHeader(`${reqUid}.${fullMac.slice(0, 32)}`, site, now)).toBe(false);
    const staleHandoff = issueEdgeHandoffHeader(reqUid, site.edgeHandoffMacKey!, now - 6 * 60_000);
    expect(worker.collector.verifyEdgeHandoffHeader(staleHandoff, site, now)).toBe(false);
    const freshHandoff = issueEdgeHandoffHeader(reqUid, site.edgeHandoffMacKey!, now);
    expect(worker.collector.verifyEdgeHandoffHeader(freshHandoff, site, now)).toBe(true);

    // 3. pv_token strict 30m expiration & pv_id binding
    const pvId = '0123456789abcdef0123456789abcdef';
    const pvTok = worker.collector.issuePvContinuityToken(site.tenantId, site.siteId, pvId, now);
    expect(worker.collector.verifyPvContinuityToken(pvTok, site.tenantId, site.siteId, pvId, now + 29 * 60_000)).toBe(true);
    expect(worker.collector.verifyPvContinuityToken(pvTok, site.tenantId, site.siteId, pvId, now + 30 * 60_000 + 1)).toBe(false);
    expect(worker.collector.verifyPvContinuityToken(pvTok, site.tenantId, site.siteId, pvId, now - 61_000)).toBe(false);
    expect(worker.collector.verifyPvContinuityToken(pvTok, site.tenantId, site.siteId, 'ffffffffffffffffffffffffffffffff', now)).toBe(false);

    // 4. Spoofed `x-ugk-prefix` headers rotating every request CANNOT bypass `CF-Connecting-IP` daily cap!
    for (let i = 1; i <= 3; i++) {
      const resp = await worker.fetch(
        new Request('https://collect.ugokilink.example/v1/collect/events', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ugk-key': site.publishableKey,
            'x-ugk-prefix': `198.51.${i}.0/24`, // attacker tries rotating client header!
            'CF-Connecting-IP': '203.0.113.77', // real edge IP stays in same /24!
          },
          body: JSON.stringify(makeValidFrame({ seq: i, pv_token: pvTok })),
        })
      );
      expect(resp.status).toBe(200);
    }
    // prefixDailyCap is 2 -> 3rd frame from same CF-Connecting-IP /24 MUST have billable=false!
    expect(q.messages[0].billable).toBe(true);
    expect(q.messages[1].billable).toBe(true);
    expect(q.messages[2].billable).toBe(false);
  });

  test('[C-05] & [C-08]: CanonicalWalQueueEnvelope alignment, non-blocking liveTailSink fanout, canonical url_key_v2 overwrite & malformed URL 400 quarantine', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const liveEvents: LiveTailFrameEvent[] = [];
    let liveMode: 'ok' | 'reject' | 'hang' = 'ok';

    const site = makeTestSite({
      storageRegion: 'eu',
      storageTier: 'tier2_link_plus_export',
      retentionDays: 180,
      baseline28dHourVolume: 1000,
    });

    const collector = new LinkCollectorEngine({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_secret_c05',
      labMarkerSecret: 'lab_secret_c05',
      mainQueue: q.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      liveTailSink: {
        publishLiveFrame: (ev) => {
          if (liveMode === 'reject') return Promise.reject(new Error('DO_DOWN'));
          if (liveMode === 'hang') return new Promise<void>(() => {});
          liveEvents.push(ev);
          return Promise.resolve();
        },
      },
      nowMs: () => 1795000000000,
    });

    // 1. Non-canonical URL with credentials, uppercase host, unsorted query & fragment:
    // flagged as non-idempotent AND overwritten with canonical url_key_v2 (zero credentials stored!)
    const dirtyUrlFrame = makeValidFrame({
      seq: 1,
      state: {
        ...makeValidFrame().state,
        page_url_key: 'HTTPS://User:TopSecretPw@Wakegai.JP/Ranking/?utm_source=x&z=1#frag',
      },
    });
    const res1 = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: dirtyUrlFrame,
      networkPrefix: '203.0.113.0/24',
    });
    expect(res1.status).toBe(200);
    expect(res1.ack?.url_key_idempotent).toBe(false);
    expect(res1.persistedRecord?.storage_region).toBe('eu');
    expect(res1.persistedRecord?.storage_tier).toBe('tier2_link_plus_export');
    expect(res1.persistedRecord?.retention_days).toBe(180);
    expect(res1.persistedRecord?.edge_acked).toBe(true);
    expect(res1.persistedRecord?.shard_id).toBeGreaterThanOrEqual(0);
    expect(res1.persistedRecord?.shard_id).toBeLessThan(64);
    expect(res1.persistedRecord?.frame.state.page_url_key).toBe('wakegai.jp/Ranking?z=__ugk_len_1_4__');
    expect(res1.persistedRecord?.raw_frame.state.page_url_key).toBe('wakegai.jp/Ranking?z=__ugk_len_1_4__');
    expect(JSON.stringify(q.messages[0])).not.toContain('TopSecretPw');
    expect(liveEvents).toHaveLength(1);

    // 2. Rejecting or hanging liveTailSink NEVER blocks or breaks 200 ACK!
    liveMode = 'reject';
    const resReject = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 2 }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(resReject.status).toBe(200);

    liveMode = 'hang';
    const resHang = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({ seq: 3 }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(resHang.status).toBe(200);

    // 3. Single-label host:port (`staging:8080/page`) is strictly idempotent
    const stagingCanonical = computeUrlKeyV2('http://staging:8080/page');
    const resStaging = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({
        seq: 4,
        url_id: stagingCanonical.url_id,
        state: { ...makeValidFrame().state, page_url_key: stagingCanonical.url_key_v2 },
      }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(resStaging.status).toBe(200);
    expect(resStaging.ack?.url_key_idempotent).toBe(true);

    // 4. Malformed URL (`https:///admin?secret=LEAK_999`) returns 400 + sanitized quarantine (never 500, zero raw secret!)
    const badUrlFrame = makeValidFrame({
      seq: 5,
      state: { ...makeValidFrame().state, page_url_key: 'https:///admin?secret=LEAK_999' },
    });
    const resBadUrl = await collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: badUrlFrame,
      networkPrefix: '203.0.113.0/24',
    });
    expect(resBadUrl.status).toBe(400);
    expect(quarantine.objects.size).toBe(1);
    const qPayload = Array.from(quarantine.objects.values())[0];
    expect(qPayload).not.toContain('LEAK_999');
    expect(qPayload).not.toContain('https:///admin');
  });

  test('[H-11], [H-14] & [M-02]: /v1/optout deletionSink + fallback receipt, private_scope zero linkable keys, Segment 32KiB/100-prop/PII/undefined-registry fail-closed & shared bounded AckLedgerStore', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const deletionReceived: SubjectDeletionRequest[] = [];
    let now = 1795000000000;

    // Site WITHOUT customEventRegistry -> must fail closed on track & unapproved properties!
    const noRegistrySite = makeTestSite({
      publishableKey: 'ugk_pub_noreg',
      customEventRegistry: undefined,
      allowedTraitKeys: ['department'],
    });
    // Site WITH looseModeAllowed: true for testing 32KiB / 100-prop / %XX PII on page & identify
    const looseSite = makeTestSite({
      publishableKey: 'ugk_pub_loose',
      allowedTraitKeys: ['contact_hint'],
      customEventRegistry: {
        site_id: 'site_wakegai',
        looseModeAllowed: true,
        definitions: [],
      },
    });

    const sharedLedger = new SharedInMemoryAckLedgerStore({ maxEntries: 50, ackTtlMs: 15 * 60_000 });
    const committedSet = new Set<string>();

    const workerA = createCollectorWorker({
      sitesByPublishableKey: new Map([
        [noRegistrySite.publishableKey, noRegistrySite],
        [looseSite.publishableKey, looseSite],
      ]),
      continuityTokenSecret: 'cont_secret_shared',
      labMarkerSecret: 'lab_secret_shared',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      ackLedgerStore: sharedLedger,
      isFrameCommittedInStore: (pvId, seq) => committedSet.has(`${pvId}:${seq}`),
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          deletionReceived.push(req);
          return { receiptId: `sink_${req.receiptId}` };
        },
      },
      nowMs: () => now,
    });

    // Separate Worker Instance B sharing the same `ackLedgerStore` ([M-02])
    const workerB = createCollectorWorker({
      sitesByPublishableKey: new Map([
        [noRegistrySite.publishableKey, noRegistrySite],
        [looseSite.publishableKey, looseSite],
      ]),
      continuityTokenSecret: 'cont_secret_shared',
      labMarkerSecret: 'lab_secret_shared',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      ackLedgerStore: sharedLedger,
      isFrameCommittedInStore: (pvId, seq) => committedSet.has(`${pvId}:${seq}`),
      nowMs: () => now,
    });

    // 1. [H-11]: /v1/optout triggers deletionSink with HMACed subject + 14d SLA + clears cookies; fallback works too
    const optRes1 = await workerA.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ugk-key': noRegistrySite.publishableKey,
          cookie: 'ugk_vid=0123456789abcdef0123456789abcdef; ugk_sid=fedcba9876543210fedcba9876543210',
        },
        body: JSON.stringify({}),
      })
    );
    expect(optRes1.status).toBe(200);
    const optJson1 = (await optRes1.json()) as { receipt_id: string; deletion_sla_days: number };
    expect(optJson1.receipt_id).toMatch(/^sink_del_/);
    expect(optJson1.deletion_sla_days).toBe(14);
    expect(deletionReceived).toHaveLength(1);
    expect(deletionReceived[0].subjectKind).toBe('visitor_id');
    expect(deletionReceived[0].subjectHmac).not.toContain('0123456789abcdef0123456789abcdef');
    expect(optRes1.headers.get('set-cookie')).toContain('ugk_vid=; Path=/; Max-Age=0');

    const optResFallback = await workerB.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': noRegistrySite.publishableKey },
        body: JSON.stringify({ member_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }),
      })
    );
    // Codex #8: Without a configured durable deletionSink, opt-out cookie is set but deletion_queued MUST be false (503)
    expect(optResFallback.status).toBe(503);
    const optFallbackJson = (await optResFallback.json()) as {
      ok: boolean;
      optout_cookie_set: boolean;
      deletion_queued: boolean;
      error: string;
    };
    expect(optFallbackJson.ok).toBe(false);
    expect(optFallbackJson.optout_cookie_set).toBe(true);
    expect(optFallbackJson.deletion_queued).toBe(false);
    expect(optFallbackJson.error).toBe('deletion_sink_unavailable');
    expect(optResFallback.headers.get('set-cookie')).toContain('ugk_optout=1');
    expect(workerB.deletionFallbackQueue).toHaveLength(0);

    // 2. [H-11]: Collector strips all linkable keys on `private_scope` frames
    const privFrame = makeValidFrame({
      seq: 1,
      consent_mode: 'full',
      purposes: ['member_link', 'experiment'],
      visitor_id: '0123456789abcdef0123456789abcdef',
      session_id: 'fedcba9876543210fedcba9876543210',
      member_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      cont_of: '11111111111111111111111111111111',
      state: { ...makeValidFrame().state, dom_state: 'private_scope' },
    });
    const privRes = await workerA.collector.handleTelemetryFrame({
      publishableKey: noRegistrySite.publishableKey,
      body: privFrame,
      networkPrefix: '203.0.113.0/24',
    });
    expect(privRes.status).toBe(200);
    expect(privRes.ack?.pv_token).toBeNull();
    expect(privRes.persistedRecord?.frame.visitor_id).toBeNull();
    expect(privRes.persistedRecord?.frame.session_id).toBeNull();
    expect(privRes.persistedRecord?.frame.member_hash).toBeNull();
    expect(privRes.persistedRecord?.frame.cont_of).toBeNull();

    // 3. [H-14]: Undefined customEventRegistry fails closed on `track` AND on `page` with custom properties
    const noRegTrack = await workerA.compat.handleSingleCall(noRegistrySite.publishableKey, {
      type: 'track',
      event: 'unregistered_ev',
      properties: { x: 1 },
      consent_mode: 'full',
    });
    expect(noRegTrack.status).toBe(422);
    expect(noRegTrack.error).toBe('missing_custom_event_registry');

    const noRegPageProps = await workerA.compat.handleSingleCall(noRegistrySite.publishableKey, {
      type: 'page',
      name: 'Home',
      properties: { sneak_prop: 'secret' },
      consent_mode: 'cookieless',
    });
    expect(noRegPageProps.status).toBe(422);
    expect(noRegPageProps.error).toBe('unapproved_properties_without_registry');

    // 4. [H-14]: >100 properties, >32 KiB payload, and `%40...%ZZ` PII blocked across `page` & `identify`!
    const manyProps: Record<string, number> = {};
    for (let i = 0; i < 101; i++) manyProps[`p_${i}`] = i;
    const over100Res = await workerA.compat.handleSingleCall(looseSite.publishableKey, {
      type: 'page',
      name: 'OverProps',
      properties: manyProps,
      consent_mode: 'cookieless',
    });
    expect(over100Res.status).toBe(422);
    expect(over100Res.error).toBe('property_count_exceeded');

    const over32KbRes = await workerA.compat.handleSingleCall(looseSite.publishableKey, {
      type: 'screen',
      name: 'HugeScreen',
      properties: { blob: 'A'.repeat(33 * 1024) },
      consent_mode: 'session',
    });
    expect(over32KbRes.status).toBe(422);
    expect(over32KbRes.error).toBe('event_size_exceeded');

    const pagePiiRes = await workerA.compat.handleSingleCall(looseSite.publishableKey, {
      type: 'page',
      name: 'Contact',
      properties: { ref_note: 'leak alice%40example.com%ZZ here' },
      consent_mode: 'cookieless',
    });
    expect(pagePiiRes.status).toBe(422);
    expect(pagePiiRes.error).toBe('pii_detected_in_properties');

    // Even an allowedTraitKey carrying `%40...%ZZ` PII is redacted before queue!
    const idTraitPii = await workerA.compat.handleSingleCall(looseSite.publishableKey, {
      type: 'identify',
      userId: 'usr_55',
      traits: { contact_hint: 'bob%40secret.jp%ZZ' },
      consent_mode: 'full',
      purposes: ['member_link'],
    });
    expect(idTraitPii.status).toBe(200);
    expect(idTraitPii.record?.allowed_traits).toEqual({});
    expect(idTraitPii.record?.dropped_traits_count).toBe(1);
    expect(idTraitPii.record?.ml_training_eligible).toBe(false);
    expect(JSON.stringify(customQ.messages)).not.toContain('bob%40secret.jp');

    // 5. [M-02]: Cross-instance `post_ack_loss` detection via SharedInMemoryAckLedgerStore + LRU/TTL bounds
    const crossPvId = '99999999999999999999999999999999';
    const ackResA = await workerA.collector.handleTelemetryFrame({
      publishableKey: looseSite.publishableKey,
      body: makeValidFrame({ pv_id: crossPvId, seq: 1 }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(ackResA.status).toBe(200);

    // 11 minutes later, Worker Instance B handles seq=2 echoing ack_echo_seq=1 -> detects post_ack_loss!
    now += 11 * 60_000;
    await workerB.collector.handleTelemetryFrame({
      publishableKey: looseSite.publishableKey,
      body: makeValidFrame({ pv_id: crossPvId, seq: 2, ack_echo_seq: 1 }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(workerB.collector.postAckLosses).toHaveLength(1);
    expect(sharedLedger.getPostAckLosses()).toHaveLength(1);

    // Verify BoundedTtlLruMap strictly enforces maxEntries & TTL sweep
    const tinyMap = new BoundedTtlLruMap<number>(3, 5_000);
    tinyMap.set('k1', 1, 1000);
    tinyMap.set('k2', 2, 1000);
    tinyMap.set('k3', 3, 1000);
    tinyMap.get('k1', 1500); // touch k1 so k2 becomes LRU
    tinyMap.set('k4', 4, 2000); // evicts k2!
    expect(tinyMap.size).toBe(3);
    expect(tinyMap.get('k2', 2000)).toBeUndefined();
    expect(tinyMap.get('k1', 2000)).toBe(1);
    expect(tinyMap.get('k1', 7000)).toBeUndefined(); // expired after 5s TTL!
  });

  test('Wave 9 Codex #8: /v1/optout NEVER returns deletion_queued: true when deletionSink is missing or throws, while durable sink returns 200 with receipt_id', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite();
    const now = Date.parse('2026-11-23T06:00:00.000Z');
    const rawMember = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    // 1. Missing deletionSink -> HTTP 503, optout_cookie_set: true, deletion_queued: false
    const workerMissingSink = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_sec',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      nowMs: () => now,
    });
    const resMissing = await workerMissingSink.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': site.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ member_hash: rawMember }),
      })
    );
    expect(resMissing.status).toBe(503);
    const jsonMissing = (await resMissing.json()) as Record<string, unknown>;
    expect(jsonMissing.deletion_queued).toBe(false);
    expect(jsonMissing.optout_cookie_set).toBe(true);
    expect(jsonMissing.error).toBe('deletion_sink_unavailable');
    expect(resMissing.headers.get('set-cookie')).toContain('ugk_optout=1');

    // 2. Throwing deletionSink -> HTTP 503, optout_cookie_set: true, deletion_queued: false
    const workerThrowingSink = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_sec',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async () => {
          throw new Error('D1/Queue transient outage');
        },
      },
      nowMs: () => now,
    });
    const resThrowing = await workerThrowingSink.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': site.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ member_hash: rawMember }),
      })
    );
    expect(resThrowing.status).toBe(503);
    const jsonThrowing = (await resThrowing.json()) as Record<string, unknown>;
    expect(jsonThrowing.deletion_queued).toBe(false);
    expect(jsonThrowing.optout_cookie_set).toBe(true);
    expect(jsonThrowing.error).toBe('deletion_sink_unavailable');
    expect(resThrowing.headers.get('set-cookie')).toContain('ugk_optout=1');

    // 3. Succeeding durable deletionSink -> HTTP 200, deletion_queued: true with receipt_id
    const persistedRequests: SubjectDeletionRequest[] = [];
    const workerDurableSink = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_sec',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          persistedRequests.push(req);
          return { receiptId: `durable_${req.receiptId}` };
        },
      },
      nowMs: () => now,
    });
    const resDurable = await workerDurableSink.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': site.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ member_hash: rawMember }),
      })
    );
    expect(resDurable.status).toBe(200);
    const jsonDurable = (await resDurable.json()) as Record<string, unknown>;
    expect(jsonDurable.ok).toBe(true);
    expect(jsonDurable.deletion_queued).toBe(true);
    expect(jsonDurable.optout_cookie_set).toBe(true);
    expect(String(jsonDurable.receipt_id)).toMatch(/^durable_del_/);
    expect(persistedRequests).toHaveLength(1);
  });

  test('Wave 9 Codex #9: unified versioned subject HMAC roundtrip — collected member frame -> /v1/optout -> DeletionExecutionEngine finds and erases the exact collected row', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite({
      tenantId: 'ten_roundtrip_01',
      siteId: 'site_roundtrip_01',
      tenantMemberHashKey: 'tenant_member_secret_v1_2026',
    });
    const now = Date.parse('2026-11-23T06:00:00.000Z');
    const rawMemberHash = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
    const queuedDeletions: SubjectDeletionRequest[] = [];

    const worker = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_sec',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          queuedDeletions.push(req);
          return { receiptId: req.receiptId };
        },
      },
      nowMs: () => now,
    });

    // 1. Collect member frame via LinkCollectorEngine
    const collectRes = await worker.collector.handleTelemetryFrame({
      publishableKey: site.publishableKey,
      body: makeValidFrame({
        pv_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        seq: 1,
        consent_mode: 'full',
        purposes: ['member_link', 'experiment'],
        member_hash: rawMemberHash,
      }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(collectRes.status).toBe(200);
    const storedMemberHmac = collectRes.persistedRecord!.frame.member_hash;
    expect(storedMemberHmac).toBe(
      computeCanonicalSubjectHmac({
        tenantId: site.tenantId,
        subjectKind: 'member_hash',
        subjectValue: rawMemberHash,
        secretKey: site.tenantMemberHashKey,
      })
    );

    // 2. Opt-out via /v1/optout -> queues exact same canonical HMAC
    const optRes = await worker.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': site.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ member_hash: rawMemberHash }),
      })
    );
    expect(optRes.status).toBe(200);
    expect(queuedDeletions).toHaveLength(1);
    expect(queuedDeletions[0].subjectHmac).toBe(storedMemberHmac);

    // 3. DeletionExecutionEngine searches stored rows (both canonical v1 collected row + legacy row)
    const legacyRowHmac = hmacSha256Hex(site.tenantMemberHashKey, rawMemberHash);
    const storedRows = new Map<string, { pvId: string; memberHmac: string }>([
      ['pv_collected', { pvId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', memberHmac: storedMemberHmac! }],
      ['pv_legacy', { pvId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', memberHmac: legacyRowHmac }],
    ]);

    const keyRegistry = new TenantKeyVersionRegistry();
    keyRegistry.registerKeyVersion({
      tenantId: site.tenantId,
      keyVersion: 1,
      secretSalt: site.tenantMemberHashKey,
      status: 'active',
      activeRowCount: 2,
      createdAtMs: now - 86_400_000,
    });

    const adapter: DeletionStoreAdapter = {
      async resolveSubjectKeys({ keyedDigests }) {
        const candidateSet = new Set<string>();
        for (const kd of keyedDigests) {
          candidateSet.add(kd.hmacHex);
          for (const c of kd.lookupCandidates ?? []) candidateSet.add(c);
        }
        const matchedPvIds: string[] = [];
        for (const row of storedRows.values()) {
          if (candidateSet.has(row.memberHmac)) {
            matchedPvIds.push(row.pvId);
          }
        }
        return {
          visitorKeys: [],
          sessionKeys: [],
          pvIds: matchedPvIds,
          reqUids: [],
          unitIds: [],
          touchedPvHoursMs: [],
          matchedKeyVersions: keyedDigests.map((d) => d.keyVersion),
        };
      },
      async maskSubjectImmediate() {
        return { ecMemberSummaryDeleted: 1, edgeCacheKeysPurged: 0 };
      },
      async purgeTable({ table, resolvedKeys }) {
        if (table.tableName === 'page_view_state') {
          let deleted = 0;
          for (const [k, row] of storedRows.entries()) {
            if (resolvedKeys.pvIds.includes(row.pvId)) {
              storedRows.delete(k);
              deleted += 1;
            }
          }
          return { matchedRows: deleted, deletedRows: deleted };
        }
        return { matchedRows: 0, deletedRows: 0 };
      },
      async purgeExternalStore() {
        return { deletedObjects: 0, status: 'expired_or_empty' };
      },
      async markRollupHoursDirty() {},
      async notifyCustomerExportSinks() {
        return [];
      },
    };

    const deletionEngine = new DeletionExecutionEngine(adapter, keyRegistry);
    const queuedReq = queuedDeletions[0]!;
    // Codex R2 #9: Verify ZERO plaintext is stored on the queued SubjectDeletionRequest
    expect(JSON.stringify(queuedReq)).not.toContain(rawMemberHash);
    expect(queuedReq.subject_hmac_candidates.length).toBeGreaterThanOrEqual(2);
    expect(queuedReq.subjectHmacCandidates).toEqual(queuedReq.subject_hmac_candidates);

    // Pass ONLY the queued SubjectDeletionRequest (ZERO plaintext rawSubjectValue!)
    deletionEngine.scheduleRequest({
      requestId: queuedReq.receiptId,
      tenantId: queuedReq.tenantId,
      siteId: queuedReq.siteId,
      subjectKind: queuedReq.subjectKind as 'member_hash',
      subjectHmac: queuedReq.subjectHmac,
      subjectHmacCandidates: queuedReq.subject_hmac_candidates,
      requestedAtMs: queuedReq.requestedAtMs,
    });
    await deletionEngine.executeMaskPhase(queuedReq.receiptId, now + 1000);
    await deletionEngine.executePhysicalPurgePhase(queuedReq.receiptId, now + 2000);

    // Both the newly collected canonical row AND the legacy row were found and erased with ZERO plaintext!
    expect(storedRows.size).toBe(0);
  });

  test('Wave 10 Codex R2 #8: cookie-only visitor /v1/optout 503 preserves signed HttpOnly ugk_del_retry cookie before clearing ugk_vid, enabling retry with only ugk_del_retry', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite({
      tenantId: 'ten_retry_cookie',
      siteId: 'site_retry_cookie',
      tenantMemberHashKey: 'retry_cookie_member_key_2026',
    });
    const now = Date.parse('2026-11-23T08:00:00.000Z');
    const originalVisitorId = 'vis_cookie_only_9988776655443322';
    const expectedVisitorHmac = computeCanonicalSubjectHmac({
      tenantId: site.tenantId,
      subjectKind: 'visitor_id',
      subjectValue: originalVisitorId,
      secretKey: site.tenantMemberHashKey,
    });

    let sinkHealthy = false;
    const queuedDeletions: SubjectDeletionRequest[] = [];
    const worker = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'cont_sec_retry_test',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          if (!sinkHealthy) {
            throw new Error('Deletion sink temporarily unavailable');
          }
          queuedDeletions.push(req);
          return { receiptId: req.receiptId };
        },
      },
      nowMs: () => now,
    });

    // Attempt 1: Cookie-only visitor hits /v1/optout while sink is down -> 503
    const res503 = await worker.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: {
          'x-ugk-key': site.publishableKey,
          cookie: `ugk_vid=${originalVisitorId}; ugk_sid=sess_abc123`,
        },
      })
    );
    expect(res503.status).toBe(503);
    const body503 = (await res503.json()) as Record<string, unknown>;
    expect(body503.deletion_queued).toBe(false);
    expect(body503.optout_cookie_set).toBe(true);

    const setCookies503 = res503.headers.getSetCookie
      ? res503.headers.getSetCookie()
      : (res503.headers.get('set-cookie') ?? '').split(/,(?=\s*ugk_)/);
    const optoutIdx = setCookies503.findIndex((c) => c.startsWith('ugk_optout=1'));
    const sidClearIdx = setCookies503.findIndex((c) => c.startsWith('ugk_sid=;'));
    const delRetryIdx = setCookies503.findIndex((c) => c.startsWith('ugk_del_retry='));
    const vidClearIdx = setCookies503.findIndex((c) => c.startsWith('ugk_vid=;'));
    expect(optoutIdx).toBeGreaterThanOrEqual(0);
    expect(sidClearIdx).toBeGreaterThanOrEqual(0);
    expect(delRetryIdx).toBeGreaterThanOrEqual(0);
    expect(vidClearIdx).toBeGreaterThan(delRetryIdx); // ugk_del_retry issued BEFORE clearing ugk_vid!
    expect(setCookies503[delRetryIdx]).toContain('HttpOnly');
    expect(setCookies503[delRetryIdx]).toContain('Secure');

    const delRetryCookiePair = setCookies503[delRetryIdx]!.split(';')[0]!;
    expect(delRetryCookiePair).toMatch(/^ugk_del_retry=.+\.[0-9a-f]{64}$/);

    // Attempt 2: Sink recovers; browser retries /v1/optout with ONLY ugk_del_retry (no ugk_vid, no body)
    sinkHealthy = true;
    const res200 = await worker.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: {
          'x-ugk-key': site.publishableKey,
          cookie: `ugk_optout=1; ${delRetryCookiePair}`,
        },
      })
    );
    expect(res200.status).toBe(200);
    const body200 = (await res200.json()) as Record<string, unknown>;
    expect(body200.deletion_queued).toBe(true);
    expect(queuedDeletions).toHaveLength(1);
    expect(queuedDeletions[0]!.subjectKind).toBe('visitor_id');
    expect(queuedDeletions[0]!.subjectHmac).toBe(expectedVisitorHmac);
    expect(queuedDeletions[0]!.subject_hmac_candidates).toContain(expectedVisitorHmac);

    // Once 200 succeeds, ugk_del_retry MUST be cleared (Max-Age=0)
    const setCookies200 = res200.headers.getSetCookie
      ? res200.headers.getSetCookie()
      : (res200.headers.get('set-cookie') ?? '').split(/,(?=\s*ugk_)/);
    expect(setCookies200.some((c) => c.startsWith('ugk_del_retry=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  test('Wave 11 Codex R3 #8: ugk_del_retry cookie verifies across rotated continuityTokenSecret via rotatedContinuityTokenSecrets', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const site = makeTestSite({
      tenantId: 'ten_r3_8',
      siteId: 'site_r3_8',
      tenantMemberHashKey: 'member_key_r3_8',
    });
    const now = Date.parse('2026-11-23T11:00:00.000Z');
    const originalVisitorId = 'vis_rotated_secret_112233445566';
    const expectedVisitorHmac = computeCanonicalSubjectHmac({
      tenantId: site.tenantId,
      subjectKind: 'visitor_id',
      subjectValue: originalVisitorId,
      secretKey: site.tenantMemberHashKey,
    });

    // 1. Worker under secret S1 fails with 503 and issues ugk_del_retry signed under S1
    const workerS1 = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'S1',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async () => {
          throw new Error('Transient sink outage');
        },
      },
      nowMs: () => now,
    });

    const res503 = await workerS1.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: {
          'x-ugk-key': site.publishableKey,
          cookie: `ugk_vid=${originalVisitorId}`,
        },
      })
    );
    expect(res503.status).toBe(503);
    const setCookies503 = res503.headers.getSetCookie
      ? res503.headers.getSetCookie()
      : (res503.headers.get('set-cookie') ?? '').split(/,(?=\s*ugk_)/);
    const delRetryCookiePair = setCookies503
      .find((c) => c.startsWith('ugk_del_retry='))!
      .split(';')[0]!;
    expect(delRetryCookiePair).toMatch(/^ugk_del_retry=.+\.[0-9a-f]{64}$/);

    // 2. Worker rotated to S2 WITHOUT rotatedContinuityTokenSecrets cannot recover visitor
    const unrotatedQueued: SubjectDeletionRequest[] = [];
    const workerS2Only = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'S2',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          unrotatedQueued.push(req);
          return { receiptId: req.receiptId };
        },
      },
      nowMs: () => now + 5_000,
    });
    const resWithoutRotated = await workerS2Only.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: {
          'x-ugk-key': site.publishableKey,
          cookie: `ugk_optout=1; ${delRetryCookiePair}`,
        },
      })
    );
    expect(resWithoutRotated.status).toBe(200);
    expect(unrotatedQueued[0]!.subjectKind).toBe('optout_cookie');
    expect(unrotatedQueued[0]!.subjectHmac).toBeNull();

    // 3. Worker rotated to S2 WITH rotatedContinuityTokenSecrets: ['S1'] recovers exact original visitor!
    const queuedDeletions: SubjectDeletionRequest[] = [];
    const workerS2WithRotated = createCollectorWorker({
      sitesByPublishableKey: new Map([[site.publishableKey, site]]),
      continuityTokenSecret: 'S2',
      rotatedContinuityTokenSecrets: ['S1'],
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          queuedDeletions.push(req);
          return { receiptId: req.receiptId };
        },
      },
      nowMs: () => now + 10_000,
    });

    const res200 = await workerS2WithRotated.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: {
          'x-ugk-key': site.publishableKey,
          cookie: `ugk_optout=1; ${delRetryCookiePair}`,
        },
      })
    );
    expect(res200.status).toBe(200);
    expect(queuedDeletions).toHaveLength(1);
    expect(queuedDeletions[0]!.subjectKind).toBe('visitor_id');
    expect(queuedDeletions[0]!.subjectHmac).toBe(expectedVisitorHmac);
    expect(queuedDeletions[0]!.subject_hmac_candidates).toContain(expectedVisitorHmac);
  });

  test('Wave 11 Codex R3 #9: key-versioned subject HMAC candidates match historical (key_v1, digest_v1) row after rotation to key_v2 with ZERO plaintext', async () => {
    const q = makeMemoryQueue<PersistedCollectorRecord>();
    const customQ = makeMemoryQueue<CustomEventPersistedRecord>();
    const spill = makeMemoryR2();
    const hold = makeMemoryR2();
    const quarantine = makeMemoryR2();
    const now = Date.parse('2026-11-23T11:30:00.000Z');
    const rawMemberHash = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

    // 1. Collect a row under key_v1
    const siteV1 = makeTestSite({
      tenantId: 'ten_r3_9',
      siteId: 'site_r3_9',
      tenantMemberHashKey: 'secret_key_v1',
      tenantMemberHashKeyVersion: 'key_v1',
    });
    const workerV1 = createCollectorWorker({
      sitesByPublishableKey: new Map([[siteV1.publishableKey, siteV1]]),
      continuityTokenSecret: 'cont_sec',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      nowMs: () => now,
    });
    const collectRes = await workerV1.collector.handleTelemetryFrame({
      publishableKey: siteV1.publishableKey,
      body: makeValidFrame({
        pv_id: '11112222333344445555666677778888',
        seq: 1,
        consent_mode: 'full',
        purposes: ['member_link', 'experiment'],
        member_hash: rawMemberHash,
      }),
      networkPrefix: '203.0.113.0/24',
    });
    expect(collectRes.status).toBe(200);
    const digestV1 = collectRes.persistedRecord!.frame.member_hash!;

    // Row stored in ClickHouse tagged with keyVersion = 1 (key_v1)
    const storedRows = new Map<string, { pvId: string; keyVersion: number; memberHmac: string }>([
      ['pv_v1', { pvId: '11112222333344445555666677778888', keyVersion: 1, memberHmac: digestV1 }],
    ]);

    // 2. Rotate site to key_v2 while retaining key_v1 in rotatedMemberHashKeyVersions
    const siteV2 = makeTestSite({
      tenantId: 'ten_r3_9',
      siteId: 'site_r3_9',
      tenantMemberHashKey: 'secret_key_v2',
      tenantMemberHashKeyVersion: 'key_v2',
      rotatedMemberHashKeyVersions: [{ keyVersion: 'key_v1', secretKey: 'secret_key_v1' }],
    });
    const queuedDeletions: SubjectDeletionRequest[] = [];
    const workerV2 = createCollectorWorker({
      sitesByPublishableKey: new Map([[siteV2.publishableKey, siteV2]]),
      continuityTokenSecret: 'cont_sec',
      labMarkerSecret: 'lab_sec',
      mainQueue: q.queue,
      customEventQueue: customQ.queue,
      r2SpillBucket: spill.bucket,
      r2HoldBucket: hold.bucket,
      r2QuarantineBucket: quarantine.bucket,
      deletionSink: {
        enqueueSubjectDeletion: async (req) => {
          queuedDeletions.push(req);
          return { receiptId: req.receiptId };
        },
      },
      nowMs: () => now + 60_000,
    });

    const optRes = await workerV2.fetch(
      new Request('https://collect.ugokilink.example/v1/optout', {
        method: 'POST',
        headers: { 'x-ugk-key': siteV2.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ member_hash: rawMemberHash }),
      })
    );
    expect(optRes.status).toBe(200);
    expect(queuedDeletions).toHaveLength(1);
    const queuedReq = queuedDeletions[0]!;

    // Verify ZERO plaintext and explicit per-key-version pairing
    expect(JSON.stringify(queuedReq)).not.toContain(rawMemberHash);
    expect(queuedReq.subject_hmac_versioned_candidates).toBeDefined();
    expect(
      queuedReq.subject_hmac_versioned_candidates!.some(
        (c) => c.key_version === 'key_v1' && c.format === 'canonical_v1' && c.hmac_hex === digestV1
      )
    ).toBe(true);

    // 3. Pass ONLY the queued record (zero plaintext!) to DeletionExecutionEngine
    // Adapter enforces strict (keyVersion, hmac) matching so mis-versioned digests fail to match!
    const keyRegistry = new TenantKeyVersionRegistry();
    keyRegistry.registerKeyVersion({
      tenantId: siteV2.tenantId,
      keyVersion: 1,
      secretSalt: 'secret_key_v1',
      status: 'draining',
      activeRowCount: 1,
      createdAtMs: now - 86_400_000,
    });
    keyRegistry.registerKeyVersion({
      tenantId: siteV2.tenantId,
      keyVersion: 2,
      secretSalt: 'secret_key_v2',
      status: 'active',
      activeRowCount: 0,
      createdAtMs: now,
    });

    const strictAdapter: DeletionStoreAdapter = {
      async resolveSubjectKeys({ keyedDigests }) {
        const matchedPvIds: string[] = [];
        const matchedVersions = new Set<number>();
        for (const row of storedRows.values()) {
          const matched = keyedDigests.some(
            (kd) =>
              kd.keyVersion === row.keyVersion &&
              (kd.hmacHex === row.memberHmac ||
                (kd.lookupCandidates ?? []).includes(row.memberHmac))
          );
          if (matched) {
            matchedPvIds.push(row.pvId);
            matchedVersions.add(row.keyVersion);
          }
        }
        return {
          visitorKeys: [],
          sessionKeys: [],
          pvIds: matchedPvIds,
          reqUids: [],
          unitIds: [],
          touchedPvHoursMs: [],
          matchedKeyVersions: Array.from(matchedVersions),
        };
      },
      async maskSubjectImmediate() {
        return { ecMemberSummaryDeleted: 1, edgeCacheKeysPurged: 0 };
      },
      async purgeTable({ table, resolvedKeys }) {
        if (table.tableName === 'page_view_state') {
          let deleted = 0;
          for (const [k, row] of storedRows.entries()) {
            if (resolvedKeys.pvIds.includes(row.pvId)) {
              storedRows.delete(k);
              deleted += 1;
            }
          }
          return { matchedRows: deleted, deletedRows: deleted };
        }
        return { matchedRows: 0, deletedRows: 0 };
      },
      async purgeExternalStore() {
        return { deletedObjects: 0, status: 'expired_or_empty' };
      },
      async markRollupHoursDirty() {},
      async notifyCustomerExportSinks() {
        return [];
      },
    };

    const deletionEngine = new DeletionExecutionEngine(strictAdapter, keyRegistry);
    deletionEngine.scheduleRequest({
      requestId: queuedReq.receiptId,
      tenantId: queuedReq.tenantId,
      siteId: queuedReq.siteId,
      subjectKind: queuedReq.subjectKind as 'member_hash',
      subjectHmac: queuedReq.subjectHmac,
      subjectHmacCandidates: queuedReq.subject_hmac_candidates,
      subjectHmacVersionedCandidates: queuedReq.subject_hmac_versioned_candidates,
      requestedAtMs: queuedReq.requestedAtMs,
    });
    await deletionEngine.executeMaskPhase(queuedReq.receiptId, now + 61_000);
    await deletionEngine.executePhysicalPurgePhase(queuedReq.receiptId, now + 62_000);
    const cert = deletionEngine.issueCertificate(queuedReq.receiptId, now + 63_000);

    // The historical (key_v1, digest_v1) row MUST be matched and erased!
    expect(storedRows.size).toBe(0);
    expect(cert.keyVersionsSearched).toEqual([1, 2]);
  });
});
