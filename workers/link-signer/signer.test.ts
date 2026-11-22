import {
  InMemoryBundleStateStore,
  SignerCasConflictError,
  SignerPolicyError,
  canonicalJson,
  createSignedRelaxationApproval,
  createSignerWorkerHandler,
  generateEd25519KeyPair,
  resolveEffectiveConsentMode,
  sha256Hex,
  sha256Sri,
  signCanonicalObject,
  signConfigBundle,
  signReleaseManifest,
  validateClosedGrammarAction,
  verifyConfigBundle,
  verifyReleaseManifest,
  type ConfigBundlePayload,
  type ReleaseManifestPayload,
  type SignedConfigBundle,
} from './index';

const BASE_NOW_MS = Date.parse('2026-11-20T00:00:00Z');
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

async function buildTestFixtures() {
  const offlineKp = await generateEd25519KeyPair();
  const onlineKp = await generateEd25519KeyPair();
  const approverKp = await generateEd25519KeyPair();

  const measureBytes = new TextEncoder().encode('// measure-core v2');
  const segBytes = new TextEncoder().encode('// segmenter v2');
  const deliverBytes = new TextEncoder().encode('// deliver-core v2');
  const emptyBytes = new Uint8Array(0);

  const manifestPayload: ReleaseManifestPayload = {
    manifest_seq: 10,
    issued_at: new Date(BASE_NOW_MS).toISOString(),
    not_after: new Date(BASE_NOW_MS + 30 * MS_PER_DAY).toISOString(),
    resign_due_at: new Date(BASE_NOW_MS + 14 * MS_PER_DAY).toISOString(),
    abi: 2,
    min_config_seq: 5,
    artifacts: {
      measure_core: {
        url: 'https://cdn.ugokilink.example/v2/measure.js',
        sri: await sha256Sri(measureBytes),
        sha256: await sha256Hex(measureBytes),
        bytes_gzip: 14200,
      },
      segmenter: {
        url: 'https://cdn.ugokilink.example/v2/segmenter.js',
        sri: await sha256Sri(segBytes),
        sha256: await sha256Hex(segBytes),
        bytes_gzip: 4800,
      },
      deliver_core: {
        url: 'https://cdn.ugokilink.example/v2/deliver.js',
        sri: await sha256Sri(deliverBytes),
        sha256: await sha256Hex(deliverBytes),
        bytes_gzip: 11200,
      },
      census_empty_file: {
        url: 'https://cdn.ugokilink.example/static/empty.v1.js',
        sri: await sha256Sri(emptyBytes),
        sha256: await sha256Hex(emptyBytes),
      },
    },
    online_signing_keys: [
      {
        kid: 'online-k1',
        algorithm: 'Ed25519',
        public_key_jwk: onlineKp.publicKeyJwk,
        status: 'active',
        valid_until: new Date(BASE_NOW_MS + 90 * MS_PER_DAY).toISOString(),
      },
    ],
    approver_passkey_pubkeys: [
      {
        kid: 'passkey-owner-1',
        approver_id: 'owner_admin',
        public_key_jwk: approverKp.publicKeyJwk,
      },
    ],
    affiliate_param_allowlist: [
      {
        network_id: 'a8',
        allowed_params: ['id1', 'id2'],
        overwrite_existing: false,
      },
      {
        network_id: 'afb',
        allowed_params: ['id1'],
        overwrite_existing: false,
      },
    ],
  };

  const signedManifest = await signReleaseManifest(
    manifestPayload,
    offlineKp.privateKey,
    'offline-root-1'
  );

  const bundlePayload: ConfigBundlePayload = {
    aud: { tenant_id: 'tenant_1', site_id: 'site_wakegai' },
    seq: 10,
    abi: 2,
    issued_at: new Date(BASE_NOW_MS).toISOString(),
    not_after: new Date(BASE_NOW_MS + 24 * MS_PER_HOUR).toISOString(),
    measure: {
      site_default_consent: 'cookieless',
      allowed_purposes: ['experiment', 'automation_detection'],
      param_classes: {
        page: 'content',
        q: 'user_input',
        fbclid: 'noise',
      },
      protected_regions: ['pr_disclosure_banner', 'price_box'],
      private_regions: ['account_settings'],
      conversion_rules: [
        {
          cv_key: 'aff_click_cta',
          rule_ver: 1,
          match_kind: 'el_fp',
          match_value: 'aabbcc112233',
        },
      ],
      sampling_rates: { default: 1.0 },
    },
    capture: {
      feed_version: '2026-11-20',
      daily_seal_kid: 'seal-20261120',
      capture_rules: ['document', 'robots', 'sdk_empty'],
    },
    deliver: {
      actions: [
        {
          action_id: 'act_cta_copy_1',
          rung: 'A2',
          content_hash: 'deadbeef01',
          seo_class: 'indexable_minor',
          k_class: 'K2',
          ops: [
            {
              op: 'SetText',
              anchor_id: 'cta_btn_primary',
              text: '公式サイトで詳細を見る',
            },
            {
              op: 'SetStyle',
              anchor_id: 'cta_btn_primary',
              style_props: {
                'background-color': '#1d4ed8',
                color: '#ffffff',
                'border-radius': '8px',
              },
            },
          ],
        },
      ],
      affiliate_slot_bindings: [
        { network_id: 'a8', param_name: 'id1', slot_code: 'slot_top_cta' },
      ],
      shards: [
        {
          shard_id: 'shard_ranking',
          url_scope: '/ranking/*',
          sha256: 'a'.repeat(64),
          bytes_gzip: 4200,
        },
      ],
    },
    models: {
      batch_snapshot_id: 'snap_20261120',
      artifacts: [
        {
          model_id: 'timing_tree_v1',
          version: '1.0.0',
          sha256: 'b'.repeat(64),
          bytes_gzip: 18500,
          format: 'int_tree_table_v1',
        },
      ],
    },
  };

  return { offlineKp, onlineKp, approverKp, signedManifest, bundlePayload };
}

describe('Bundle 2-D.1: Signer Service, Unified Config Bundle & §10.1 Red-Team Gates', () => {
  it('signs and verifies offline Release Manifest with 50/70/85% alerts and anti-downgrade floor', async () => {
    const { offlineKp, signedManifest } = await buildTestFixtures();

    const fresh = await verifyReleaseManifest(signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + 5 * MS_PER_DAY,
      minRememberedSeq: 10,
    });
    expect(fresh.valid).toBe(true);
    expect(fresh.alertLevel).toBe('none');
    expect(fresh.deliverAllowed).toBe(true);

    const alert50 = await verifyReleaseManifest(signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + 16 * MS_PER_DAY,
    });
    expect(alert50.alertLevel).toBe('50%');

    const alert70 = await verifyReleaseManifest(signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + 22 * MS_PER_DAY,
    });
    expect(alert70.alertLevel).toBe('70%');

    const alert85 = await verifyReleaseManifest(signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + 27 * MS_PER_DAY,
    });
    expect(alert85.alertLevel).toBe('85%');

    // Downgrade below remembered seq is rejected
    const downgraded = await verifyReleaseManifest(signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + MS_PER_DAY,
      minRememberedSeq: 11,
    });
    expect(downgraded.valid).toBe(false);
    expect(downgraded.downgraded).toBe(true);
    expect(downgraded.deliverAllowed).toBe(false);
    expect(downgraded.measureAllowed).toBe(false);
  });

  it('enforces per-section expiry fallback (deliver & models fail closed; measure stays open up to 7d cap then minimal stub)', async () => {
    const { offlineKp, onlineKp, signedManifest, bundlePayload } = await buildTestFixtures();
    const signedBundle = await signConfigBundle(
      bundlePayload,
      onlineKp.privateKey,
      'online-k1',
      signedManifest.payload
    );

    // Valid at +12h
    const validRes = await verifyConfigBundle(signedBundle, signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + 12 * MS_PER_HOUR,
      expectedTenantId: 'tenant_1',
      expectedSiteId: 'site_wakegai',
    });
    expect(validRes.valid).toBe(true);
    expect(validRes.sectionState.deliver.enabled).toBe(true);
    expect(validRes.sectionState.models.enabled).toBe(true);
    expect(validRes.sectionState.measure.configStale).toBe(false);

    // Expired at +36h (inside 7-day measure stale window): deliver & models STOP, measure continues stale
    const expiredStale = await verifyConfigBundle(
      signedBundle,
      signedManifest,
      offlineKp.publicKey,
      {
        nowMs: BASE_NOW_MS + 36 * MS_PER_HOUR,
        expectedTenantId: 'tenant_1',
        expectedSiteId: 'site_wakegai',
      }
    );
    expect(expiredStale.valid).toBe(false);
    expect(expiredStale.expired).toBe(true);
    expect(expiredStale.sectionState.deliver.enabled).toBe(false);
    expect(expiredStale.sectionState.deliver.unmetGate).toBe('bundle_integrity');
    expect(expiredStale.sectionState.models.enabled).toBe(false);
    expect(expiredStale.sectionState.measure.enabled).toBe(true);
    expect(expiredStale.sectionState.measure.configStale).toBe(true);
    expect(expiredStale.sectionState.measure.fallbackToMinimalStub).toBe(false);
    expect(expiredStale.sectionState.capture.enabled).toBe(true);
    expect(expiredStale.sectionState.capture.unverifiableStaleEvidence).toBe(true);

    // Past 7-day stale cap (+9 days): measure drops to minimal_stub
    const pastCap = await verifyConfigBundle(signedBundle, signedManifest, offlineKp.publicKey, {
      nowMs: BASE_NOW_MS + 9 * MS_PER_DAY,
      expectedTenantId: 'tenant_1',
      expectedSiteId: 'site_wakegai',
    });
    expect(pastCap.sectionState.measure.enabled).toBe(false);
    expect(pastCap.sectionState.measure.fallbackToMinimalStub).toBe(true);
  });

  describe('Red-Team Attack Gate 1 (§10.1 / del.D1): Compromised online keys CANNOT run arbitrary JS or hijack affiliate params', () => {
    it('rejects <script>, onerror, javascript:, url(), position:fixed even if attacker directly signs with compromised online private key', async () => {
      const { offlineKp, onlineKp, signedManifest, bundlePayload } = await buildTestFixtures();

      const attackPayloads: ConfigBundlePayload[] = [
        // Attack 1a: InsertNode <script>
        {
          ...bundlePayload,
          deliver: {
            ...bundlePayload.deliver,
            actions: [
              {
                ...bundlePayload.deliver.actions[0],
                ops: [{ op: 'InsertNode', anchor_id: 'a1', insert_tag: 'script' }],
              },
            ],
          },
        },
        // Attack 1b: SetAttr onclick / javascript:
        {
          ...bundlePayload,
          deliver: {
            ...bundlePayload.deliver,
            actions: [
              {
                ...bundlePayload.deliver.actions[0],
                ops: [{ op: 'SetAttr', anchor_id: 'a1', attr_name: 'onclick', attr_value: 'alert(1)' }],
              },
            ],
          },
        },
        // Attack 1c: SetStyle url() beacon / position: fixed
        {
          ...bundlePayload,
          deliver: {
            ...bundlePayload.deliver,
            actions: [
              {
                ...bundlePayload.deliver.actions[0],
                ops: [
                  {
                    op: 'SetStyle',
                    anchor_id: 'a1',
                    style_props: { 'background-color': 'url(https://evil.example/steal)', position: 'fixed' },
                  },
                ],
              },
            ],
          },
        },
        // Attack 1d: Unregistered affiliate click parameter outside OFFLINE manifest allowlist (§6.5)
        {
          ...bundlePayload,
          deliver: {
            ...bundlePayload.deliver,
            affiliate_slot_bindings: [
              { network_id: 'a8', param_name: 'a8mat_hijack', slot_code: 'attacker_id' },
            ],
          },
        },
        // Attack 1e: Legally required disclosure placed in runtime-only bundle (§10.1)
        {
          ...bundlePayload,
          deliver: {
            ...bundlePayload.deliver,
            actions: [
              {
                ...bundlePayload.deliver.actions[0],
                is_legally_required_disclosure: true,
              },
            ],
          },
        },
        // Attack 1f: Non-integer / executable model artifact (>50KB or wrong format)
        {
          ...bundlePayload,
          models: {
            batch_snapshot_id: 'snap_1',
            artifacts: [
              {
                model_id: 'evil_js',
                version: '1',
                sha256: 'c'.repeat(64),
                bytes_gzip: 60000,
                format: 'onnx_wasm' as 'int_tree_table_v1',
              },
            ],
          },
        },
      ];

      for (const malicious of attackPayloads) {
        // 1. Official signer refuses to sign
        await expect(
          signConfigBundle(malicious, onlineKp.privateKey, 'online-k1', signedManifest.payload)
        ).rejects.toThrow(SignerPolicyError);

        // 2. Even if attacker steals onlinePrivateKey and signs directly, consumer verifier STILL REJECTS!
        const { sha256, sigB64 } = await signCanonicalObject(onlineKp.privateKey, malicious);
        const forgedBundle: SignedConfigBundle = {
          payload: malicious,
          bundle_hash: sha256,
          signatures: [{ kid: 'online-k1', alg: 'Ed25519', sig_b64: sigB64 }],
        };
        const res = await verifyConfigBundle(forgedBundle, signedManifest, offlineKp.publicKey, {
          nowMs: BASE_NOW_MS + 1000,
          expectedTenantId: 'tenant_1',
          expectedSiteId: 'site_wakegai',
        });
        expect(res.valid).toBe(false);
        expect(res.sectionState.deliver.enabled).toBe(false);
      }
    });

    it('rejects any manifest tampered by an attacker without the offline release private key', async () => {
      const { offlineKp, onlineKp, signedManifest } = await buildTestFixtures();
      const tamperedPayload: ReleaseManifestPayload = {
        ...signedManifest.payload,
        artifacts: {
          ...signedManifest.payload.artifacts,
          measure_core: {
            url: 'https://evil.example/pwn.js',
            sri: await sha256Sri('alert(document.cookie)'),
            sha256: await sha256Hex('alert(document.cookie)'),
            bytes_gzip: 100,
          },
        },
      };
      // Attacker signs tampered manifest with stolen ONLINE key
      const forged = await signReleaseManifest(tamperedPayload, onlineKp.privateKey, 'offline-root-1');
      const res = await verifyReleaseManifest(forged, offlineKp.publicKey, {
        nowMs: BASE_NOW_MS + 1000,
      });
      expect(res.valid).toBe(false);
      expect(res.signatureValid).toBe(false);
      expect(res.deliverAllowed).toBe(false);
      expect(res.measureAllowed).toBe(false);
    });
  });

  describe('Red-Team Attack Gate 2 (§10.1): Online keys CANNOT relax consent, hide protected regions, or replay old configs', () => {
    it('blocks consent relaxation, protected region removal, and user_input param loosening without offline-pinned passkey signature', async () => {
      const { offlineKp, onlineKp, approverKp, signedManifest, bundlePayload } =
        await buildTestFixtures();

      // Attack 2a: Relax consent from cookieless -> full without passkey
      const relaxedPayload: ConfigBundlePayload = {
        ...bundlePayload,
        seq: 11,
        measure: {
          ...bundlePayload.measure,
          site_default_consent: 'full',
          protected_regions: ['price_box'], // dropped pr_disclosure_banner!
          param_classes: { ...bundlePayload.measure.param_classes, q: 'content' }, // loosened user_input!
        },
      };

      await expect(
        signConfigBundle(relaxedPayload, onlineKp.privateKey, 'online-k1', signedManifest.payload, {
          previousBundle: bundlePayload,
        })
      ).rejects.toThrow(SignerPolicyError);

      // Even if forged directly with compromised online key, consumer verifier rejects!
      const { sha256, sigB64 } = await signCanonicalObject(onlineKp.privateKey, relaxedPayload);
      const forgedRelaxed: SignedConfigBundle = {
        payload: relaxedPayload,
        bundle_hash: sha256,
        signatures: [{ kid: 'online-k1', alg: 'Ed25519', sig_b64: sigB64 }],
      };
      const verifyForged = await verifyConfigBundle(
        forgedRelaxed,
        signedManifest,
        offlineKp.publicKey,
        {
          nowMs: BASE_NOW_MS + 1000,
          expectedTenantId: 'tenant_1',
          expectedSiteId: 'site_wakegai',
          previousBundle: bundlePayload,
        }
      );
      expect(verifyForged.valid).toBe(false);

      // Now attach legitimate offline-pinned approver passkey signature bound to (tenant_id, site_id, prev_seq, next_seq) -> SUCCEEDS!
      const relaxationApproval = await createSignedRelaxationApproval({
        approverKid: 'passkey-owner-1',
        approverPrivateKey: approverKp.privateKey,
        tenantId: relaxedPayload.aud.tenant_id,
        siteId: relaxedPayload.aud.site_id,
        prevSeq: bundlePayload.seq,
        nextSeq: relaxedPayload.seq,
        nextMeasure: relaxedPayload.measure,
      });
      const approvedPayload: ConfigBundlePayload = {
        ...relaxedPayload,
        measure: {
          ...relaxedPayload.measure,
          relaxation_approval: relaxationApproval,
        },
      };
      const signedApproved = await signConfigBundle(
        approvedPayload,
        onlineKp.privateKey,
        'online-k1',
        signedManifest.payload,
        { previousBundle: bundlePayload }
      );
      const verifyApproved = await verifyConfigBundle(
        signedApproved,
        signedManifest,
        offlineKp.publicKey,
        {
          nowMs: BASE_NOW_MS + 1000,
          expectedTenantId: 'tenant_1',
          expectedSiteId: 'site_wakegai',
          previousBundle: bundlePayload,
        }
      );
      expect(verifyApproved.valid).toBe(true);

      // Cross-site replay of that exact relaxationApproval onto site_other MUST FAIL (C-18)
      const crossSiteReplay: ConfigBundlePayload = {
        ...approvedPayload,
        aud: { tenant_id: 'tenant_1', site_id: 'site_other' },
      };
      await expect(
        signConfigBundle(
          crossSiteReplay,
          onlineKp.privateKey,
          'online-k1',
          signedManifest.payload,
          {
            previousBundle: {
              ...bundlePayload,
              aud: { tenant_id: 'tenant_1', site_id: 'site_other' },
            },
          }
        )
      ).rejects.toThrow(SignerPolicyError);
    });

    it('blocks Hide/SetStyle targeting protected regions and blocks replay below min_config_seq', async () => {
      const { onlineKp, signedManifest, bundlePayload } = await buildTestFixtures();

      // Hide targeting protected region `pr_disclosure_banner`
      const hideProtected: ConfigBundlePayload = {
        ...bundlePayload,
        deliver: {
          ...bundlePayload.deliver,
          actions: [
            {
              ...bundlePayload.deliver.actions[0],
              ops: [{ op: 'Hide', anchor_id: 'pr_disclosure_banner' }],
            },
          ],
        },
      };
      await expect(
        signConfigBundle(hideProtected, onlineKp.privateKey, 'online-k1', signedManifest.payload)
      ).rejects.toThrow(SignerPolicyError);

      // Replay old config with seq < min_config_seq (5)
      const replayedOld: ConfigBundlePayload = { ...bundlePayload, seq: 3 };
      await expect(
        signConfigBundle(replayedOld, onlineKp.privateKey, 'online-k1', signedManifest.payload)
      ).rejects.toThrow(SignerPolicyError);
    });

    it('ensures online loader data can ONLY tighten consent, never raise above site default or origin declaration (§4.2)', () => {
      // Attacker sends loaderDataCap='full' while siteDefault='cookieless' -> stays 'cookieless'
      expect(
        resolveEffectiveConsentMode({
          siteDefault: 'cookieless',
          originDeclared: 'session',
          loaderDataCap: 'full',
          disclosureVerified: true,
        })
      ).toBe('cookieless');

      // Online loader can tighten down to 'off'
      expect(
        resolveEffectiveConsentMode({
          siteDefault: 'session',
          originDeclared: 'session',
          loaderDataCap: 'off',
          disclosureVerified: true,
        })
      ).toBe('off');

      // Minors site caps at cookieless even with CMP 'full'
      expect(
        resolveEffectiveConsentMode({
          siteDefault: 'full',
          cmpResolved: 'full',
          minorsFlag: true,
          disclosureVerified: true,
        })
      ).toBe('cookieless');

      // Missing disclosure blocks JP subject site to 'off'
      expect(
        resolveEffectiveConsentMode({
          siteDefault: 'cookieless',
          disclosureVerified: false,
          subjectToJpExternalTransmissionRule: true,
        })
      ).toBe('off');
    });
  });

  it('[C-18] Signer Worker requires constant-time control-plane Bearer auth, ignores caller previousBundle via CAS BundleStateStore, and enforces baseline cookieless relaxation on seq=1', async () => {
    const { offlineKp, onlineKp, approverKp, signedManifest, bundlePayload } = await buildTestFixtures();
    const manifestSeq1Floor = await signReleaseManifest(
      { ...signedManifest.payload, min_config_seq: 1 },
      offlineKp.privateKey,
      'offline-root-1'
    );
    const stateStore = new InMemoryBundleStateStore();

    // Unconfigured controlPlaneSignerToken -> fails closed 503
    const unconfiguredWorker = createSignerWorkerHandler({
      offlinePublicKey: offlineKp.publicKey,
      onlinePrivateKey: onlineKp.privateKey,
      onlineKid: 'online-k1',
      bundleStateStore: stateStore,
      getReleaseManifest: async () => manifestSeq1Floor,
      getLoaderData: async () => null,
      nowMs: () => BASE_NOW_MS + 1000,
    });
    const unconfRes = await unconfiguredWorker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer any' },
        body: JSON.stringify({ payload: { ...bundlePayload, seq: 1 } }),
      })
    );
    expect(unconfRes.status).toBe(503);

    const cpToken = 'cp_signer_internal_token_9876543210';
    const worker = createSignerWorkerHandler({
      offlinePublicKey: offlineKp.publicKey,
      onlinePrivateKey: onlineKp.privateKey,
      onlineKid: 'online-k1',
      controlPlaneSignerToken: cpToken,
      bundleStateStore: stateStore,
      getReleaseManifest: async () => manifestSeq1Floor,
      getLoaderData: async (siteRef) => ({
        site_ref: siteRef,
        region_class: 'JP',
        region_consent_cap: 'cookieless',
        kill_bits: 0,
        stop_deliver: false,
        coarsen_factor: 1,
        active_config_seq: 1,
        ctl_digest: 'ctl_abc',
        server_time_ms: BASE_NOW_MS,
      }),
      nowMs: () => BASE_NOW_MS + 1000,
    });

    const loaderRes = await worker.fetch(new Request('https://signer.example/l/wakegai.json?p=abc'));
    expect(loaderRes.status).toBe(200);

    // 1. Unauthenticated or wrong Bearer token -> 401
    const unauthSign = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { ...bundlePayload, seq: 1 } }),
      })
    );
    expect(unauthSign.status).toBe(401);

    const badTokenSign = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong_token' },
        body: JSON.stringify({ payload: { ...bundlePayload, seq: 1 } }),
      })
    );
    expect(badTokenSign.status).toBe(401);

    // 2. Initial bundle (!prev) trying to jump to seq=2 or relax consent to 'full' without passkey -> 422
    const seqJump = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cpToken}` },
        body: JSON.stringify({ payload: { ...bundlePayload, seq: 2 } }),
      })
    );
    expect(seqJump.status).toBe(422);

    const unapprovedInitialFull = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cpToken}` },
        body: JSON.stringify({
          payload: {
            ...bundlePayload,
            seq: 1,
            measure: { ...bundlePayload.measure, site_default_consent: 'full' },
          },
          // Attacker tries to smuggle fake previousBundle claiming site was already 'full'
          previousBundle: {
            ...bundlePayload,
            seq: 0,
            measure: { ...bundlePayload.measure, site_default_consent: 'full' },
          },
        }),
      })
    );
    expect(unapprovedInitialFull.status).toBe(422);

    // 3. Valid initial seq=1 with baseline 'cookieless' commits to BundleStateStore
    const signSeq1 = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cpToken}` },
        body: JSON.stringify({ payload: { ...bundlePayload, seq: 1 } }),
      })
    );
    expect(signSeq1.status).toBe(200);

    // 4. Omitting previousBundle on seq=2 while relaxing consent to 'full' STILL caught via authoritative store!
    const omitPrevAttack = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cpToken}` },
        body: JSON.stringify({
          payload: {
            ...bundlePayload,
            seq: 2,
            measure: { ...bundlePayload.measure, site_default_consent: 'full' },
          },
        }),
      })
    );
    expect(omitPrevAttack.status).toBe(422);

    // 5. With valid Passkey approval bound to (tenant_1, site_wakegai, prev_seq=1, next_seq=2), seq=2 succeeds
    const seq2FullMeasure = { ...bundlePayload.measure, site_default_consent: 'full' as const };
    const seq2Approval = await createSignedRelaxationApproval({
      approverKid: 'passkey-owner-1',
      approverPrivateKey: approverKp.privateKey,
      tenantId: 'tenant_1',
      siteId: 'site_wakegai',
      prevSeq: 1,
      nextSeq: 2,
      nextMeasure: seq2FullMeasure,
    });
    const signSeq2 = await worker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cpToken}` },
        body: JSON.stringify({
          payload: {
            ...bundlePayload,
            seq: 2,
            measure: { ...seq2FullMeasure, relaxation_approval: seq2Approval },
          },
        }),
      })
    );
    expect(signSeq2.status).toBe(200);

    // 6. Simulate CAS race conflict -> throws SignerCasConflictError / returns 409
    const racingStore: typeof stateStore = {
      getCurrent: (t, s) => stateStore.getCurrent(t, s),
      seedBundle: (b) => stateStore.seedBundle(b),
      compareAndSwap: async () => ({ committed: false, current: null }),
    } as unknown as InMemoryBundleStateStore;
    const racingWorker = createSignerWorkerHandler({
      offlinePublicKey: offlineKp.publicKey,
      onlinePrivateKey: onlineKp.privateKey,
      onlineKid: 'online-k1',
      controlPlaneSignerToken: cpToken,
      bundleStateStore: racingStore,
      getReleaseManifest: async () => manifestSeq1Floor,
      getLoaderData: async () => null,
      nowMs: () => BASE_NOW_MS + 1000,
    });
    await expect(
      racingWorker.signerService.signAndCommitBundle({
        ...bundlePayload,
        seq: 3,
        measure: { ...seq2FullMeasure },
      })
    ).rejects.toThrow(SignerCasConflictError);
    const casConflictHttp = await racingWorker.fetch(
      new Request('https://signer.example/v1/signer/bundle/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cpToken}` },
        body: JSON.stringify({
          payload: { ...bundlePayload, seq: 3, measure: { ...seq2FullMeasure } },
        }),
      })
    );
    expect(casConflictHttp.status).toBe(409);
  });

  it('[H-09] InsertNode blocks affiliate hosts/params & external outbound hosts, and siteDefault=off blocks CMP escalation unless explicitly permitted', () => {
    const baseAction = {
      action_id: 'act_ins_1',
      rung: 'A2' as const,
      content_hash: 'h1',
      seo_class: 'non_indexable' as const,
      k_class: 'K2' as const,
    };

    // 1. InsertNode <a href="https://px.a8.net/..."> or amzn.to or external host -> REJECTED
    expect(
      validateClosedGrammarAction(
        {
          ...baseAction,
          ops: [
            {
              op: 'InsertNode',
              anchor_id: 'hero',
              insert_tag: 'a',
              insert_attrs: { href: 'https://px.a8.net/svt/ejp?a8mat=STEAL' },
            },
          ],
        },
        []
      ).valid
    ).toBe(false);

    expect(
      validateClosedGrammarAction(
        {
          ...baseAction,
          ops: [
            {
              op: 'InsertNode',
              anchor_id: 'hero',
              insert_tag: 'a',
              insert_attrs: { href: 'https://amzn.to/3xyz' },
            },
          ],
        },
        []
      ).valid
    ).toBe(false);

    expect(
      validateClosedGrammarAction(
        {
          ...baseAction,
          ops: [
            {
              op: 'InsertNode',
              anchor_id: 'hero',
              insert_tag: 'img',
              insert_attrs: { src: 'https://evil-tracker.example/pixel.gif' },
            },
          ],
        },
        []
      ).valid
    ).toBe(false);

    // Safe relative internal InsertNode passes
    expect(
      validateClosedGrammarAction(
        {
          ...baseAction,
          ops: [
            {
              op: 'InsertNode',
              anchor_id: 'hero',
              insert_tag: 'a',
              insert_attrs: { href: '/pricing', class: 'ugk-cta-btn' },
            },
          ],
        },
        []
      ).valid
    ).toBe(true);

    // 2. siteDefault === 'off': CMP 'full' NEVER escalates above 'off' unless allowCmpOptInFromDefaultOff === true
    expect(
      resolveEffectiveConsentMode({
        siteDefault: 'off',
        cmpResolved: 'full',
        disclosureVerified: true,
      })
    ).toBe('off');

    expect(
      resolveEffectiveConsentMode({
        siteDefault: 'off',
        cmpResolved: 'full',
        allowCmpOptInFromDefaultOff: true,
        disclosureVerified: true,
      })
    ).toBe('full');
  });
});
