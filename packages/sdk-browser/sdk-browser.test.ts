import {
  CANONICAL_SCHEMA,
  createSdkFrameCodec,
  type TelemetryFrame,
} from '../contract/schema';
import { EMPTY_FILE_SRI, SNIPPET_MAX_BYTES } from '../sdk-snippet';
import { generateEd25519KeyPair } from '../../workers/link-signer';
import {
  UgokiBrowserSdk,
  buildValidatedCustomEvent,
  computeAdaptiveHeartbeatSec,
  createBrowserSegmentCompatClient,
  generateQuickstartOnboarding,
  resolveBrowserConsent,
  rewriteOutboundForLabSink,
  runQuickstartSelfDiagnostics,
  type CollectorAckPayload,
  type CookieJarLike,
  type LabMarkerToken,
  type SiteCustomEventRegistry,
  type StorageLike,
} from './index';

function makeDeterministicRandom(seedByte = 0xab): (len: number) => Uint8Array {
  let counter = 0;
  return (len: number) => {
    counter += 1;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = (seedByte + counter * 17 + i * 31) & 0xff;
    }
    return out;
  };
}

function makeInstrumentedStorage() {
  const store = new Map<string, string>();
  let readCount = 0;
  let writeCount = 0;
  let removeCount = 0;

  const storage: StorageLike = {
    getItem(key: string) {
      readCount += 1;
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      writeCount += 1;
      store.set(key, value);
    },
    removeItem(key: string) {
      removeCount += 1;
      store.delete(key);
    },
  };

  return {
    storage,
    store,
    get totalTouches() {
      return readCount + writeCount + removeCount;
    },
    get readCount() {
      return readCount;
    },
    get writeCount() {
      return writeCount;
    },
  };
}

function makeInstrumentedCookieJar() {
  const cookies = new Map<string, { value: string; maxAge: number }>();
  let readCount = 0;
  let writeCount = 0;

  const jar: CookieJarLike = {
    getCookie(name: string) {
      readCount += 1;
      return cookies.get(name)?.value ?? null;
    },
    setCookie(name: string, value: string, maxAgeSec: number) {
      writeCount += 1;
      cookies.set(name, { value, maxAge: maxAgeSec });
    },
    deleteCookie(name: string) {
      writeCount += 1;
      cookies.delete(name);
    },
  };

  return {
    jar,
    cookies,
    get totalTouches() {
      return readCount + writeCount;
    },
  };
}

describe('packages/sdk-browser — Bundles 3-A, 3-B, 3-C (SDK, Consent, tel.G7, Replay, Custom Events, Quickstart, Lab Sink)', () => {
  test('tel.G7 Non-Interference: runs differing ONLY in typed text, chosen options, password, and clipboard produce 100% byte-identical outbound payloads', async () => {
    const runScenario = async (scenarioCanary: {
      readonly typedSecret: string;
      readonly passwordSecret: string;
      readonly chosenOptionText: string;
      readonly clipboardSecret: string;
    }): Promise<Uint8Array[]> => {
      // Both runs perform IDENTICAL structural interaction timing/counts, while visitor
      // types/selects completely different strings and secrets (which the SDK MUST NEVER read!).
      const payloads: Uint8Array[] = [];
      let mono = 1000;
      const wall = 1795000000000;

      const sdk = new UgokiBrowserSdk({
        siteKey: 'ugk_pub_site1',
        collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
        sdkBuild: 'v3.0.0',
        defVer: 1,
        profileRev: 1,
        armBits: 0b010,
        dimTupleCode: 42,
        initialUrl: 'https://wakegai.jp/contact/?q=' + encodeURIComponent(scenarioCanary.typedSecret),
        urlRules: {
          paramClasses: { q: 'user_input' },
        },
        skelFp: 'aabbccddeeff',
        consent: {
          siteDefaultMode: 'cookieless',
          originRegionClass: 'JP',
          disclosureStatus: 'verified',
        },
        randomBytes: makeDeterministicRandom(0x42),
        nowMonoMs: () => mono,
        nowWallMs: () => wall,
        transport: {
          sendFetch: async (_ep, bytes, frame): Promise<CollectorAckPayload> => {
            payloads.push(new Uint8Array(bytes));
            return { seq: frame.seq, i_hw: frame.chk.logHighWater, srv_t: wall, pv_token: 'pvt1.test' };
          },
          sendBeacon: (_ep, bytes) => {
            payloads.push(new Uint8Array(bytes));
            return true;
          },
        },
      });

      await sdk.init();

      // Advance scroll & dwell
      mono = 2500;
      sdk.advance({
        scrollY: 320,
        sections: [{ sec_fp: '112233445566', topPx: 200, bottomPx: 900 }],
        blocks: [{ blk_fp: 'blk_cta_1', alwaysWatch: true, inViewport: true }],
        isInputTick: true,
      });

      // Focus & interact with normal text input (SDK receives structural metadata ONLY, never scenarioCanary.typedSecret)
      mono = 3000;
      sdk.recordFormFocus({ tMono: mono, form_fp: 'frm_01', el_fp: 'fld_name', isSensitive: false });
      mono = 3400;
      sdk.recordFormInteraction({
        tMono: mono,
        form_fp: 'frm_01',
        el_fp: 'fld_name',
        isSensitive: false,
        isComposition: false,
        isDeletion: false,
        becameFilled: true,
      });
      mono = 3900;
      sdk.recordFormBlur('fld_name', mono);

      // Focus & interact with sensitive password field (presence ONLY, never scenarioCanary.passwordSecret)
      mono = 4100;
      sdk.recordFormFocus({ tMono: mono, form_fp: 'frm_01', el_fp: 'fld_pass', isSensitive: true });
      mono = 4300;
      sdk.recordFormInteraction({
        tMono: mono,
        form_fp: 'frm_01',
        el_fp: 'fld_pass',
        isSensitive: true,
        isComposition: false,
        isDeletion: false,
        becameFilled: true,
      });

      // Choice group / keypad click inside form: groupFp only, coordinates & option identity omitted!
      mono = 4600;
      await sdk.recordClick({
        tMono: mono,
        el_fp: `opt_${scenarioCanary.chosenOptionText}`,
        activation_kind: 'click',
        insideFormOrChoiceOrKeypad: true,
        groupFp: 'grp_payment_choice',
        xPermille: scenarioCanary.chosenOptionText.length * 10,
        yPermille: 500,
      });

      // Copy event (count only, never reads scenarioCanary.clipboardSecret)
      sdk.recordCopy('blk_cta_1');

      mono = 5000;
      await sdk.handleVisibilityHidden();

      // Confirm ZERO canary strings appear in any outbound byte array
      const allBytesText = payloads.map((b) => Buffer.from(b).toString('utf8')).join('\n');
      expect(allBytesText).not.toContain(scenarioCanary.typedSecret);
      expect(allBytesText).not.toContain(scenarioCanary.passwordSecret);
      expect(allBytesText).not.toContain(scenarioCanary.chosenOptionText);
      expect(allBytesText).not.toContain(scenarioCanary.clipboardSecret);

      return payloads;
    };

    // Equal-length user_input query tokens (both in __len_5_16 bucket) with completely different secrets
    const runA = await runScenario({
      typedSecret: 'AlphaSecret1',
      passwordSecret: 'MyPass!999',
      chosenOptionText: 'OptionA_CreditCard',
      clipboardSecret: 'CopiedConfidentialA',
    });
    const runB = await runScenario({
      typedSecret: 'ZebraDiffer9',
      passwordSecret: 'OtherPw#11',
      chosenOptionText: 'OptionB_BankWire',
      clipboardSecret: 'CopiedConfidentialB',
    });

    expect(runA.length).toBe(runB.length);
    expect(runA.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < runA.length; i++) {
      // Exact byte-for-byte identity across the two runs (`tel.G7`)!
      expect(Buffer.compare(Buffer.from(runA[i]), Buffer.from(runB[i]))).toBe(0);
    }
  });

  test('tel.G10 & tel.G12: ZERO cookie/storage access before consent resolution and in off/cookieless; 5 modes & strictest-wins resolution', async () => {
    const cookie = makeInstrumentedCookieJar();
    const sess = makeInstrumentedStorage();
    const local = makeInstrumentedStorage();
    const sent: TelemetryFrame[] = [];

    // 1. Before init(): ZERO touches on cookie/sessionStorage/localStorage!
    const sdkOff = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_jp',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0,
      dimTupleCode: 1,
      initialUrl: 'https://wakegai.jp/article/',
      skelFp: 'aabbccddeeff',
      cookieJar: cookie.jar,
      sessionStorage: sess.storage,
      localStorage: local.storage,
      consent: {
        siteDefaultMode: 'full',
        originRegionClass: 'JP',
        loaderRegionClass: 'JP',
        disclosureStatus: 'missing', // JP unverified disclosure -> MUST force `off`!
      },
      transport: {
        sendFetch: async (_ep, _b, frame) => {
          sent.push(frame);
          return { seq: frame.seq, i_hw: -1, srv_t: Date.now() };
        },
        sendBeacon: () => true,
      },
    });

    expect(cookie.totalTouches).toBe(0);
    expect(sess.totalTouches).toBe(0);
    expect(local.totalTouches).toBe(0);

    const resOff = await sdkOff.init();
    expect(resOff.mode).toBe('off');
    expect(resOff.cappedReason).toBe('unverified_disclosure_jp');
    expect(sent).toHaveLength(0);
    expect(cookie.totalTouches).toBe(0);
    expect(sess.totalTouches).toBe(0);
    expect(local.totalTouches).toBe(0);

    // 2. Cookieless (JP verified disclosure, unsigned legal row -> cookieless): frames sent, ZERO storage touches!
    const sdkCookieless = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_jp',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0,
      dimTupleCode: 1,
      initialUrl: 'https://wakegai.jp/article/',
      skelFp: 'aabbccddeeff',
      cookieJar: cookie.jar,
      sessionStorage: sess.storage,
      localStorage: local.storage,
      consent: {
        siteDefaultMode: 'full',
        originRegionClass: 'JP',
        disclosureStatus: 'verified',
      },
      transport: {
        sendFetch: async (_ep, _b, frame) => {
          sent.push(frame);
          return { seq: frame.seq, i_hw: -1, srv_t: Date.now() };
        },
        sendBeacon: () => true,
      },
    });
    const resCookieless = await sdkCookieless.init();
    expect(resCookieless.mode).toBe('cookieless');
    expect(sent).toHaveLength(1);
    expect(sent[0].visitor_id).toBeNull();
    expect(sent[0].session_id).toBeNull();
    expect(cookie.totalTouches).toBe(0);
    expect(sess.totalTouches).toBe(0);
    expect(local.totalTouches).toBe(0);

    // 3. Test switching through stats_exempt -> session -> full -> optOut()
    const statsRes = sdkCookieless.consent('stats_exempt', ['experiment', 'pool', 'member_link']);
    expect(statsRes.mode).toBe('stats_exempt');
    expect(statsRes.purposes).toEqual(['experiment']); // pool & member_link disallowed in stats_exempt!
    expect(cookie.cookies.has('ugk_vid')).toBe(true);
    expect(cookie.cookies.has('ugk_sid')).toBe(false);

    const sessionRes = sdkCookieless.consent('session', ['experiment', 'member_link']);
    expect(sessionRes.mode).toBe('session');
    expect(sessionRes.purposes).toEqual(['experiment']); // member_link disallowed in session
    expect(cookie.cookies.has('ugk_sid')).toBe(true);
    expect(cookie.cookies.get('ugk_sid')?.maxAge).toBe(1800); // 30-min rolling cookie

    const fullRes = sdkCookieless.consent('full', ['experiment', 'member_link']);
    expect(fullRes.mode).toBe('full');
    expect(fullRes.purposes).toEqual(['experiment', 'member_link']);
    expect(sdkCookieless.identify('deadbeef0123456789abcdef01234567')).toBe(true);

    // optOut() immediately stops telemetry
    const optOutRes = sdkCookieless.optOut();
    expect(optOutRes.mode).toBe('off');
    expect(await sdkCookieless.flush('heartbeat')).toBe(false);

    // 4. Strictest-wins region, minors cap, privacy signal, and script-7d optout durability
    expect(
      resolveBrowserConsent({
        siteDefaultMode: 'full',
        originRegionClass: 'EU_EEA',
        loaderRegionClass: 'JP', // online loader CANNOT raise EU above off!
        disclosureStatus: 'verified',
      }).mode
    ).toBe('off');

    expect(
      resolveBrowserConsent({
        siteDefaultMode: 'full',
        explicitConsentMode: 'full',
        minorsSite: true,
        disclosureStatus: 'verified',
      }).mode
    ).toBe('cookieless');

    const gpcRes = resolveBrowserConsent({
      siteDefaultMode: 'full',
      originRegionClass: 'US_OPTOUT',
      explicitConsentMode: 'full',
      explicitPurposes: ['experiment', 'pool', 'ads', 'member_link'],
      privacySignal: true,
      disclosureStatus: 'verified',
    });
    expect(gpcRes.purposes).toEqual(['experiment']); // pool, ads, member_link ALWAYS stripped under GPC!

    const durRes = resolveBrowserConsent({
      siteDefaultMode: 'full',
      explicitConsentMode: 'full',
      optOutDurability: 'capped_7d',
      disclosureStatus: 'verified',
    });
    expect(durRes.mode).toBe('session'); // stepped down 1 tier from full -> session
  });

  test('tel.G14 & D-08 Lock: Replay Tier 1/2 kinematic timelines NEVER leave the browser until D-08 + legal sign-off, and stay OFF on password PVs', async () => {
    const sentFrames: TelemetryFrame[] = [];
    let mono = 500;

    // Default SDK: D-08 is pending in canonical ledger -> timeline_chunk MUST NEVER be sent!
    const sdkPending = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_1',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0,
      dimTupleCode: 1,
      initialUrl: 'https://wakegai.jp/review/',
      skelFp: 'aabbccddeeff',
      consent: {
        siteDefaultMode: 'full',
        explicitConsentMode: 'full',
        explicitPurposes: ['timeline'],
        disclosureStatus: 'verified',
      },
      replay: { serverRequestedTimeline: true },
      nowMonoMs: () => mono,
      transport: {
        sendFetch: async (_ep, _b, frame) => {
          sentFrames.push(frame);
          return { seq: frame.seq, i_hw: frame.chk.logHighWater, srv_t: Date.now() };
        },
        sendBeacon: (_ep, _b, frame) => {
          sentFrames.push(frame);
          return true;
        },
      },
    });

    await sdkPending.init();
    mono = 1500;
    sdkPending.advance({
      scrollY: 400,
      sections: [{ sec_fp: '112233445566', topPx: 0, bottomPx: 1000 }],
    });
    expect(sdkPending.getBehaviourEngine().getBufferedTimelineInts().length).toBeGreaterThan(0);

    const decisionPending = sdkPending.getBehaviourEngine().evaluateKinematicTimelineEmission(['timeline']);
    expect(decisionPending.allowed).toBe(false);
    expect(decisionPending.status).toBe('not_entitled');

    mono = 2500;
    await sdkPending.handleVisibilityHidden();
    const allLogItems = sentFrames.flatMap((f) => f.log_items);
    expect(allLogItems.some((item) => item.kind === 'timeline_chunk')).toBe(false);

    // Even WITH D-08 approved, a PV containing a sensitive password/payment field MUST block timeline_chunk!
    const sdkSensitive = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_1',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0,
      dimTupleCode: 1,
      initialUrl: 'https://wakegai.jp/checkout/',
      skelFp: 'aabbccddeeff',
      consent: {
        siteDefaultMode: 'full',
        explicitConsentMode: 'full',
        explicitPurposes: ['timeline'],
        disclosureStatus: 'verified',
      },
      replay: {
        ownerDecisionD08Approved: true,
        legalSignOffRecorded: true,
        serverRequestedTimeline: true,
      },
      nowMonoMs: () => mono,
      transport: {
        sendFetch: async (_ep, _b, frame) => ({ seq: frame.seq, i_hw: frame.chk.logHighWater, srv_t: Date.now() }),
        sendBeacon: () => true,
      },
    });
    await sdkSensitive.init();
    sdkSensitive.recordFormFocus({ tMono: 2600, form_fp: 'f1', el_fp: 'cc_num', isSensitive: true });
    const sensDecision = sdkSensitive.getBehaviourEngine().evaluateKinematicTimelineEmission(['timeline']);
    expect(sensDecision.allowed).toBe(false);
    expect(sensDecision.reason).toBe('password_or_payment_field_present');

    // When D-08 approved + legal signed off + non-sensitive PV -> integer-only timeline_chunk emitted!
    const approvedFrames: TelemetryFrame[] = [];
    const sdkApproved = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_1',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0,
      dimTupleCode: 1,
      initialUrl: 'https://wakegai.jp/guide/',
      skelFp: 'aabbccddeeff',
      consent: {
        siteDefaultMode: 'full',
        explicitConsentMode: 'full',
        explicitPurposes: ['timeline'],
        disclosureStatus: 'verified',
      },
      replay: {
        ownerDecisionD08Approved: true,
        legalSignOffRecorded: true,
        serverRequestedTimeline: true,
      },
      nowMonoMs: () => mono,
      transport: {
        sendFetch: async (_ep, _b, frame) => {
          approvedFrames.push(frame);
          return { seq: frame.seq, i_hw: frame.chk.logHighWater, srv_t: Date.now() };
        },
        sendBeacon: (_ep, _b, frame) => {
          approvedFrames.push(frame);
          return true;
        },
      },
    });
    await sdkApproved.init();
    mono = 3500;
    sdkApproved.advance({
      scrollY: 500,
      sections: [{ sec_fp: '112233445566', topPx: 0, bottomPx: 1200 }],
    });
    mono = 4500;
    await sdkApproved.handleVisibilityHidden();
    const timelineItem = approvedFrames
      .flatMap((f) => f.log_items)
      .find((i) => i.kind === 'timeline_chunk');
    expect(timelineItem).toBeDefined();
    expect(timelineItem?.timeline_ints?.every((n) => Number.isInteger(n))).toBe(true);
  });

  test('Protocol Lifecycle, Conversions (<=50 rules + tel/mailto + 2s dedupe), fetchLater, adaptive heartbeat, degradation & no unload/beforeunload', async () => {
    const codec = createSdkFrameCodec(CANONICAL_SCHEMA);
    const fetchFrames: TelemetryFrame[] = [];
    const beaconFrames: TelemetryFrame[] = [];
    let fetchLaterArmedCount = 0;
    let mono = 1000;

    const sdk = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_1',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 3,
      armBits: 0b001,
      dimTupleCode: 7,
      initialUrl: 'https://wakegai.jp/ranking/',
      skelFp: '112233445566',
      blockSampleRate: 0.5,
      conversionRules: [
        { cv_key: 'aff_main', rule_ver: 2, predicate_kind: 'class', predicate_value: 'btn-aff' },
      ],
      consent: {
        siteDefaultMode: 'cookieless',
        originRegionClass: 'JP',
        disclosureStatus: 'verified',
      },
      nowMonoMs: () => mono,
      transport: {
        sendFetch: async (_ep, bytes, frame) => {
          expect(codec.validateFrame(frame).valid).toBe(true);
          expect(bytes.byteLength).toBeLessThanOrEqual(48 * 1024);
          fetchFrames.push(frame);
          return { seq: frame.seq, i_hw: frame.chk.logHighWater, srv_t: Date.now() };
        },
        sendBeacon: (_ep, bytes, frame) => {
          expect(codec.validateFrame(frame).valid).toBe(true);
          expect(bytes.byteLength).toBeLessThanOrEqual(16 * 1024);
          beaconFrames.push(frame);
          return true;
        },
        armFetchLater: (_ep, _bytes, frame) => {
          expect(frame.frame_class).toBe('deferred');
          expect(frame.full).toBe(true);
          fetchLaterArmedCount += 1;
          return { activated: false, abort: () => undefined };
        },
      },
    });

    // Must NEVER register unload or beforeunload (TEL A5 #9)
    expect(sdk.registeredLifecycleListeners).not.toContain('unload');
    expect(sdk.registeredLifecycleListeners).not.toContain('beforeunload');
    expect(sdk.registeredLifecycleListeners).toContain('visibilitychange');
    expect(sdk.registeredLifecycleListeners).toContain('pagehide');

    await sdk.init();
    expect(fetchFrames).toHaveLength(1);
    expect(fetchFrames[0].frame_class).toBe('first');
    expect(fetchLaterArmedCount).toBe(1);

    // Adaptive heartbeat formula clamp [2, 30]
    expect(computeAdaptiveHeartbeatSec(120, 0.2, true)).toBe(12);
    expect(computeAdaptiveHeartbeatSec(10, 0.5, false)).toBe(2);
    expect(computeAdaptiveHeartbeatSec(1000, 0.05, true)).toBe(30);

    // tel: & mailto: links count destination kind ONLY (no phone/email PII!)
    mono = 2000;
    await sdk.recordClick({
      tMono: mono,
      el_fp: 'el_tel_1',
      activation_kind: 'click',
      href: 'tel:+81-90-1234-5678',
    });
    mono = 2100;
    await sdk.recordClick({
      tMono: mono,
      el_fp: 'el_mail_1',
      activation_kind: 'click',
      href: 'mailto:secret@example.co.jp',
    });

    // Conversion rule + 2-second duplicate click deduplication
    mono = 3000;
    const cv1 = await sdk.recordClick({
      tMono: mono,
      el_fp: 'el_aff_1',
      activation_kind: 'click',
      elementClasses: ['btn-aff'],
      href: 'https://px.a8.net/svt/ejp?a8mat=ABC&secret_token=xyz',
      allowedDestRoleParams: ['a8mat'],
    });
    expect(cv1.matchedConversions).toEqual(['aff_main@2']);

    mono = 3500; // within 2000ms bucket -> deduplicated!
    const cvDup = await sdk.recordClick({
      tMono: mono,
      el_fp: 'el_aff_1',
      activation_kind: 'click',
      elementClasses: ['btn-aff'],
      href: 'https://px.a8.net/svt/ejp?a8mat=ABC',
    });
    expect(cvDup.matchedConversions).toEqual([]);

    const allBeaconLogs = beaconFrames.flatMap((f) => f.log_items);
    const telItem = allBeaconLogs.find((i) => i.el_fp === 'el_tel_1');
    expect(telItem?.activation_kind).toBe('tel_link');
    expect(telItem?.dest_key_click).toBe('tel_scheme');
    expect(JSON.stringify(beaconFrames)).not.toContain('1234-5678');
    expect(JSON.stringify(beaconFrames)).not.toContain('secret@example.co.jp');
    expect(JSON.stringify(beaconFrames)).not.toContain('secret_token');

    // Soft navigation: hash-only -> anchor_jump on SAME pv_id; new path -> new pv_id
    const pvBefore = sdk.getPvId();
    expect(await sdk.handleSoftNavigation('https://wakegai.jp/ranking/#top')).toBe('anchor_jump');
    expect(sdk.getPvId()).toBe(pvBefore);

    expect(await sdk.handleSoftNavigation('https://wakegai.jp/ranking/page2/')).toBe('new_pv');
    expect(sdk.getPvId()).not.toBe(pvBefore);
    // Hidden frame before soft nav MUST be full=true
    const hiddenFrame = beaconFrames.find((f) => f.frame_class === 'hidden');
    expect(hiddenFrame?.full).toBe(true);

    // Heavy-device degradation ladder records degrade_level
    for (let i = 0; i < 6; i++) {
      sdk.getBehaviourEngine().recordHandlerSelfCost(25);
    }
    expect(sdk.state().degrade_level).toBe(3);
  });

  test('Bundle 3-B: Custom Events lane separation, PII blocking, Segment compat shim & 5-minute Quickstart self-diagnostics', async () => {
    const registry: SiteCustomEventRegistry = {
      site_id: 'site_1',
      looseModeAllowed: false,
      definitions: [
        {
          event_name: 'plan_upgraded',
          def_ver: 1,
          properties: [
            { name: 'amount_jpy', type: 'number', required: true },
            { name: 'plan_tier', type: 'enum', enumValues: ['starter', 'pro'], required: true },
            { name: 'note', type: 'string' },
          ],
        },
      ],
    };

    // Valid strict event
    const okEv = buildValidatedCustomEvent({
      registry,
      eventName: 'plan_upgraded',
      properties: { amount_jpy: 9800, plan_tier: 'pro', note: 'upgraded via dashboard' },
      consentMode: 'full',
      purposes: ['experiment'],
      occurredAtIso: '2026-11-20T12:00:00.000Z',
    });
    expect(okEv.accepted).toBe(true);
    expect(okEv.envelope?.lane).toBe('custom_event');
    expect(okEv.envelope?.eligible_for_cross_tenant_pool).toBe(false);
    expect(okEv.envelope?.eligible_for_standard_pv_billing).toBe(false);
    expect(okEv.envelope?.properties.find((p) => p.name === 'amount_jpy')?.ml_feature_eligible).toBe(true);
    expect(okEv.envelope?.properties.find((p) => p.name === 'note')?.ml_feature_eligible).toBe(false);
    expect(okEv.envelope?.properties.find((p) => p.name === 'note')?.untrusted).toBe(true);

    // PII in freeform string blocked & quarantined!
    const piiEv = buildValidatedCustomEvent({
      registry,
      eventName: 'plan_upgraded',
      properties: { amount_jpy: 9800, plan_tier: 'pro', note: 'contact alice@example.com' },
      consentMode: 'full',
      purposes: [],
      occurredAtIso: '2026-11-20T12:00:00.000Z',
    });
    expect(piiEv.accepted).toBe(false);
    expect(piiEv.quarantined).toBe(true);

    // Browser Segment compat shim blocks identify in stats_exempt & omits anonymousId in cookieless
    const dispatched: Array<{ path: string; body: Record<string, unknown> }> = [];
    let currentMode: 'cookieless' | 'stats_exempt' | 'full' = 'stats_exempt';
    let currentPurposes: Array<'member_link' | 'experiment'> = ['experiment'];
    const segClient = createBrowserSegmentCompatClient({
      getConsentMode: () => currentMode,
      getPurposes: () => currentPurposes,
      endpointBase: 'https://collect.ugokilink.example',
      dispatch: async (p, body) => {
        dispatched.push({ path: p, body });
        return true;
      },
    });

    expect((await segClient.identify('u_123', { email: 'x@y.com' })).sent).toBe(false);
    currentMode = 'cookieless';
    expect((await segClient.track('cta_seen', { slot: 1 })).sent).toBe(true);
    expect(dispatched[0].body.lane).toBe('custom_event');
    expect(dispatched[0].body.anonymousId).toBeUndefined();

    // 5-minute Quickstart onboarding + JP disclosure verification gate
    const keyPair = await generateEd25519KeyPair();
    const pubJwk = keyPair.publicKeyJwk;
    const probeMarker: LabMarkerToken = {
      lab_run_id: 'probe_001',
      purpose: 'install_probe',
      site_id: 'site_1',
      issued_at: '2026-11-20T00:00:00.000Z',
      expires_at: '2026-11-21T00:00:00.000Z',
      signature_b64: 'sig_placeholder',
    };
    const qs = await generateQuickstartOnboarding({
      siteRef: 'wakegai_jp',
      siteName: 'Wakegai',
      siteOrigin: 'https://wakegai.jp',
      cdnOrigin: 'https://cdn.ugokilink.example',
      collectorOrigin: 'https://collect.ugokilink.example',
      offlinePubKeyJwk: pubJwk,
      minManifestSeq: 1,
      legalRecipientName: 'LINKTH Inc.',
      optOutUrl: 'https://wakegai.jp/privacy#optout',
      installProbeMarker: probeMarker,
    });

    expect(qs.snippetResult.snippetBytes).toBeLessThanOrEqual(SNIPPET_MAX_BYTES);
    expect(qs.installHtmlBlock).toContain(EMPTY_FILE_SRI);
    expect(qs.installProbeUrl).toContain('ugk_probe_purpose=install_probe');

    // Before disclosure verification: JP general traffic stays `off`
    const diagUnverified = await runQuickstartSelfDiagnostics({
      bundle: qs,
      observedEmptyFileBytes: new Uint8Array(0),
      observedCspConnectSrc: ['https://cdn.ugokilink.example', 'https://collect.ugokilink.example'],
      disclosureStatus: 'missing',
      installProbeMarker: probeMarker,
    });
    expect(diagUnverified.readyForGeneralTraffic).toBe(false);
    expect(diagUnverified.generalVisitorEffectiveMode).toBe('off');

    // After disclosure verification: ready!
    const diagVerified = await runQuickstartSelfDiagnostics({
      bundle: qs,
      observedEmptyFileBytes: new Uint8Array(0),
      observedCspConnectSrc: ['https://cdn.ugokilink.example', 'https://collect.ugokilink.example'],
      disclosureStatus: 'verified',
      installProbeMarker: probeMarker,
    });
    expect(diagVerified.readyForGeneralTraffic).toBe(true);
    expect(diagVerified.checks.emptyFileSriValid).toBe(true);
  });

  test('Bundle 3-C: Lab Marker rewrites affiliate destinations to first-party sink (0 affiliate host hits) and render purpose blocks telemetry', async () => {
    const nowMs = Date.parse('2026-11-20T12:00:00.000Z');
    const affiliateHref = 'https://px.a8.net/svt/ejp?a8mat=REAL_AFF_999';

    // Real visitor (no lab marker): href is 100% byte-identical
    const humanRes = rewriteOutboundForLabSink(affiliateHref, 'https://wakegai.jp', null, nowMs);
    expect(humanRes.rewritten).toBe(false);
    expect(humanRes.href).toBe(affiliateHref);

    // Lab visit (`agent_run`): rewritten to first-party `/_ugk/lab-sink`
    const labMarker: LabMarkerToken = {
      lab_run_id: 'run_agent_42',
      purpose: 'agent_run',
      site_id: 'site_1',
      issued_at: '2026-11-20T11:00:00.000Z',
      expires_at: '2026-11-20T13:00:00.000Z',
      signature_b64: 'signed_mac',
    };
    const labRes = rewriteOutboundForLabSink(affiliateHref, 'https://wakegai.jp', labMarker, nowMs);
    expect(labRes.rewritten).toBe(true);
    expect(labRes.affiliateHostContactBlocked).toBe(true);
    expect(new URL(labRes.href).origin).toBe('https://wakegai.jp');
    expect(new URL(labRes.href).pathname).toBe('/_ugk/lab-sink');
    expect(labRes.href).not.toContain('px.a8.net');

    // `render` lab purpose blocks telemetry sending completely (§12.2)
    let sentCount = 0;
    const renderSdk = new UgokiBrowserSdk({
      siteKey: 'ugk_pub_1',
      collectorEndpoint: 'https://collect.ugokilink.example/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0,
      dimTupleCode: 1,
      initialUrl: 'https://wakegai.jp/',
      skelFp: 'aabbccddeeff',
      labMarker: { ...labMarker, purpose: 'render' },
      consent: {
        siteDefaultMode: 'cookieless',
        originRegionClass: 'JP',
        disclosureStatus: 'verified',
      },
      nowWallMs: () => nowMs,
      transport: {
        sendFetch: async () => {
          sentCount += 1;
          return { seq: 1, i_hw: -1, srv_t: nowMs };
        },
        sendBeacon: () => {
          sentCount += 1;
          return true;
        },
      },
    });
    await renderSdk.init();
    expect(sentCount).toBe(0);
  });
});
