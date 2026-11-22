import { NextRequest } from 'next/server';
import { validateSerializedEnvelope } from '@/packages/contract/response';
import { ALL_SCOPES, IdentityKeyRegistry, generateEd25519KeyPair } from '@/lib/link/auth';
import {
  CostUnitRateLimiter,
  EmptyUnconnectedRepository,
  LinkMcpServer,
  SurfacePipeline,
  getSurfaceRuntimeContext,
  setSurfaceRuntimeContext,
} from '@/lib/link/surface';
import { AskService } from '@/lib/link/ask';
import { POST as postDecisionApi } from '@/app/api/v1/decisions/route';
import {
  EdgeDecisionWorker,
  ForbiddenKvControlStoreError,
  type StrongControlStore,
} from './index';

function makeStrongStore(overrides?: Partial<{ reachable: boolean; latencyMs: number; expired: boolean }>): StrongControlStore {
  return {
    backendName: 'tenant_control_durable_object',
    consistency: 'durable_object_strong',
    readTenantControl: (tenantId, siteId) => ({
      reachable: overrides?.reachable ?? true,
      readLatencyMs: overrides?.latencyMs ?? 8,
      record: {
        tenantId,
        siteId,
        configVersion: 'cfg_2026_11_20_v1',
        configExpiresAtMs: overrides?.expired ? 1000 : 9_999_999_999_999,
        minAcceptedConfigVersion: 'cfg_2026_11_01_v1',
        killedCampaignIds: [],
        killStampVersion: 3,
        siteKilled: false,
        allocatorConfig: {
          hmacSecret: 'alloc_secret_v1',
          holdout: {
            global: 0.05,
            overlay: 0.05,
            patch: 0.05,
            recs: 0.05,
            epochWeeks: 26,
            epochOriginMs: 1_700_000_000_000,
          },
          measurement: {
            stage: 'stage_c_steady',
            fullSplitMode: 'half_verify_half_deliver',
            steadyStubShare: 0.05,
            steadyAuditShare: 0.13,
          },
          layers: [],
        },
      },
    }),
  };
}

describe('workers/link-decision — Strong Control Store (KV Ban), Single-PV Decision Context, Consent Monotonicity & Zone First-PV Binding', () => {
  test('physically rejects KV-backed or eventually-consistent control stores', () => {
    const pair = generateEd25519KeyPair('w_k1');
    const kvStore: StrongControlStore = {
      backendName: 'cloudflare_kv_control',
      consistency: 'kv_eventual',
      readTenantControl: () => ({ reachable: true, readLatencyMs: 5, record: null }),
    };

    expect(
      () =>
        new EdgeDecisionWorker({
          controlStore: kvStore,
          signingPrivateKeyPem: pair.privateKeyPem,
          signingPublicKeyPem: pair.publicKeyPem,
        })
    ).toThrow(ForbiddenKvControlStoreError);
  });

  test('issues signed display lease, voucher, and provisional visitor ticket (T2 only); fails closed on expired config or >5s control latency', () => {
    const pair = generateEd25519KeyPair('w_k1');
    const worker = new EdgeDecisionWorker({
      controlStore: makeStrongStore(),
      signingPrivateKeyPem: pair.privateKeyPem,
      signingPublicKeyPem: pair.publicKeyPem,
    });

    const fullRes = worker.decide({
      tenantId: 'tenant_a',
      siteId: 'site_1',
      pvId: 'pv_001',
      consentMode: 'full',
      purposes: ['experiment'],
      identityQuality: 'A',
      trafficClass: 'public',
      urlId: 'url_1',
      pageId: 'page_1',
      viewportClass: 'mobile',
      pointerType: 'coarse',
      nowMs: 1_750_000_000_000,
    });
    expect(fullRes.status).toBe('ok');
    expect(fullRes.displayLease).not.toBeNull();
    expect(fullRes.voucherToken).toMatch(/^vch_/);
    expect(fullRes.sealedProvisionalVisitorTicket?.singleUse).toBe(true);

    // Cookieless does NOT mint persistent provisional visitor ticket
    const clRes = worker.decide({
      tenantId: 'tenant_a',
      siteId: 'site_1',
      pvId: 'pv_002',
      consentMode: 'cookieless',
      purposes: [],
      identityQuality: 'C',
      trafficClass: 'public',
      urlId: 'url_1',
      pageId: 'page_1',
      viewportClass: 'desktop',
      pointerType: 'fine',
      nowMs: 1_750_000_000_000,
    });
    expect(clRes.status).toBe('ok');
    expect(clRes.sealedProvisionalVisitorTicket).toBeNull();

    // Expired config -> stops delivery (no display lease)
    const expiredWorker = new EdgeDecisionWorker({
      controlStore: makeStrongStore({ expired: true }),
      signingPrivateKeyPem: pair.privateKeyPem,
      signingPublicKeyPem: pair.publicKeyPem,
    });
    const expRes = expiredWorker.decide({
      tenantId: 'tenant_a',
      siteId: 'site_1',
      pvId: 'pv_003',
      consentMode: 'full',
      purposes: [],
      identityQuality: 'A',
      trafficClass: 'public',
      urlId: 'url_1',
      pageId: 'page_1',
      viewportClass: 'desktop',
      pointerType: 'fine',
      nowMs: 1_750_000_000_000,
    });
    expect(expRes.status).toBe('config_expired_stop_delivery');
    expect(expRes.displayLease).toBeNull();

    // > 5s control read latency -> fail-closed (no lease)
    const slowWorker = new EdgeDecisionWorker({
      controlStore: makeStrongStore({ latencyMs: 5500 }),
      signingPrivateKeyPem: pair.privateKeyPem,
      signingPublicKeyPem: pair.publicKeyPem,
    });
    expect(
      slowWorker.decide({
        tenantId: 'tenant_a',
        siteId: 'site_1',
        pvId: 'pv_004',
        consentMode: 'full',
        purposes: [],
        identityQuality: 'A',
        trafficClass: 'public',
        urlId: 'url_1',
        pageId: 'page_1',
        viewportClass: 'desktop',
        pointerType: 'fine',
      }).displayLease
    ).toBeNull();
  });

  test('enforces Zone Worker 1-decision-ID = first-1-PV binding and consent monotonicity guard (edge <= browser)', () => {
    const pair = generateEd25519KeyPair('w_k1');
    const worker = new EdgeDecisionWorker({
      controlStore: makeStrongStore(),
      signingPrivateKeyPem: pair.privateKeyPem,
      signingPublicKeyPem: pair.publicKeyPem,
    });

    // Zone Worker binding: first PV binds; second distinct PV (cached HTML reuse!) is REJECTED
    expect(worker.bindZoneDecisionToFirstPv('dctx_zone_1', 'pv_first').bound).toBe(true);
    expect(worker.bindZoneDecisionToFirstPv('dctx_zone_1', 'pv_first').bound).toBe(true);
    const secondPv = worker.bindZoneDecisionToFirstPv('dctx_zone_1', 'pv_second_cached_reuse');
    expect(secondPv.bound).toBe(false);
    expect(secondPv.reason).toBe('ZONE_DECISION_ALREADY_BOUND_TO_DIFFERENT_PV');

    // Consent monotonicity: T1 <= T2 OK; T2 > T1 trips overshoot & disables edge pre-draw!
    expect(worker.recordEdgeVsBrowserConsentCheck('T1', 'T2').violation).toBe(false);
    expect(worker.isEdgePreDrawDisabled()).toBe(false);

    const overshoot = worker.recordEdgeVsBrowserConsentCheck('T2', 'T1');
    expect(overshoot.violation).toBe(true);
    expect(overshoot.totalOvershoots).toBe(1);
    expect(worker.isEdgePreDrawDisabled()).toBe(true);
  });

  test('[M-16] binds voucherToken, displayLease, and provisional visitor ticket strictly to 1-PV single-context (tenant_id, site_id, pv_id)', () => {
    const pair = generateEd25519KeyPair('w_m16');
    const worker = new EdgeDecisionWorker({
      controlStore: makeStrongStore(),
      signingPrivateKeyPem: pair.privateKeyPem,
      signingPublicKeyPem: pair.publicKeyPem,
    });

    const issued = worker.decide({
      tenantId: 'tenant_a',
      siteId: 'site_1',
      pvId: 'pv_exact_1',
      consentMode: 'full',
      purposes: ['experiment'],
      identityQuality: 'A',
      trafficClass: 'public',
      urlId: 'url_1',
      pageId: 'page_1',
      viewportClass: 'desktop',
      pointerType: 'fine',
      nowMs: 1_750_000_000_000,
    });
    expect(issued.status).toBe('ok');
    expect(issued.pvId).toBe('pv_exact_1');
    expect(issued.displayLease?.tenantId).toBe('tenant_a');
    expect(issued.displayLease?.siteId).toBe('site_1');
    expect(issued.displayLease?.pvId).toBe('pv_exact_1');

    // Exact (tenant_id, site_id, pv_id) verifies cleanly
    expect(
      worker.verifyDecisionVoucherForPv({
        voucherToken: issued.voucherToken!,
        displayLease: issued.displayLease,
        tenantId: 'tenant_a',
        siteId: 'site_1',
        pvId: 'pv_exact_1',
        nowMs: 1_750_000_001_000,
      }).valid
    ).toBe(true);

    // Replay on a different pvId, siteId, or tenantId MUST fail closed!
    expect(
      worker.verifyDecisionVoucherForPv({
        voucherToken: issued.voucherToken!,
        displayLease: issued.displayLease,
        tenantId: 'tenant_a',
        siteId: 'site_1',
        pvId: 'pv_replay_2',
        nowMs: 1_750_000_001_000,
      })
    ).toMatchObject({ valid: false, reason: 'VOUCHER_PV_ID_MISMATCH' });

    expect(
      worker.verifyDecisionVoucherForPv({
        voucherToken: issued.voucherToken!,
        displayLease: issued.displayLease,
        tenantId: 'tenant_b',
        siteId: 'site_1',
        pvId: 'pv_exact_1',
        nowMs: 1_750_000_001_000,
      })
    ).toMatchObject({ valid: false, reason: 'VOUCHER_TENANT_OR_SITE_MISMATCH' });

    // AEAD-sealed provisional visitor ticket fails closed on wrong pvId/siteId/tenantId and on 2nd use
    const ticket = issued.sealedProvisionalVisitorTicket!;
    expect(
      worker.consumeProvisionalVisitorTicket({
        ticket,
        tenantId: 'tenant_a',
        siteId: 'site_1',
        pvId: 'pv_wrong',
        nowMs: 1_750_000_001_000,
      }).valid
    ).toBe(false);

    const consumed1 = worker.consumeProvisionalVisitorTicket({
      ticket,
      tenantId: 'tenant_a',
      siteId: 'site_1',
      pvId: 'pv_exact_1',
      nowMs: 1_750_000_001_000,
    });
    expect(consumed1.valid).toBe(true);
    expect(consumed1.visitorId).toMatch(/^vis_/);

    // Second replay of the same single-use ticket fails closed
    expect(
      worker.consumeProvisionalVisitorTicket({
        ticket,
        tenantId: 'tenant_a',
        siteId: 'site_1',
        pvId: 'pv_exact_1',
        nowMs: 1_750_000_001_000,
      })
    ).toMatchObject({ valid: false, reason: 'PROVISIONAL_TICKET_ALREADY_CONSUMED' });
  });

  test('POST /v1/decisions route enforces ugk_sec_* auth, 404 on foreign tenant, and returns I1–I7 ResponseEnvelope', async () => {
    // 1. Missing or non-secret bearer -> 401
    const unauthReq = new NextRequest('https://api.ugokilink.invalid/api/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ugk_pub_invalid' },
      body: JSON.stringify({ siteId: 'site_dec_a' }),
    });
    const unauthRes = await postDecisionApi(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Register two tenants and sites in runtime context
    const ctx = getSurfaceRuntimeContext();
    const nowIso = new Date().toISOString();
    ctx.pipeline.keyRegistry.registerOrg({
      orgId: 'org_dec_test',
      type: 'direct',
      name: 'Dec Org',
      createdAt: nowIso,
    });
    ctx.pipeline.keyRegistry.registerTenant({
      tenantId: 'tenant_dec_a',
      orgId: 'org_dec_test',
      name: 'Tenant A',
      planScopes: [...ALL_SCOPES],
      delegationPolicy: { allowOemAccess: false, allowedOemScopes: [], maxExchangedTokenTtlSec: 0 },
      revocationEpoch: 1,
      createdAt: nowIso,
    });
    ctx.pipeline.keyRegistry.registerTenant({
      tenantId: 'tenant_dec_b',
      orgId: 'org_dec_test',
      name: 'Tenant B',
      planScopes: [...ALL_SCOPES],
      delegationPolicy: { allowOemAccess: false, allowedOemScopes: [], maxExchangedTokenTtlSec: 0 },
      revocationEpoch: 1,
      createdAt: nowIso,
    });
    ctx.pipeline.keyRegistry.registerSite({
      siteId: 'site_dec_a',
      tenantId: 'tenant_dec_a',
      siteRef: 'ref_dec_a',
      env: 'live',
      hostnames: ['a.example.jp'],
      allowedOrigins: ['https://a.example.jp'],
      createdAt: nowIso,
    });
    ctx.pipeline.keyRegistry.registerSite({
      siteId: 'site_dec_b',
      tenantId: 'tenant_dec_b',
      siteRef: 'ref_dec_b',
      env: 'live',
      hostnames: ['b.example.jp'],
      allowedOrigins: ['https://b.example.jp'],
      createdAt: nowIso,
    });
    ctx.repository.registerSiteConfig({
      siteId: 'site_dec_a',
      tenantId: 'tenant_dec_a',
      consentMode: 'full',
      storageRegion: 'asia-northeast1',
      processingRegion: 'asia-northeast1',
      monthlyPvQuota: 100_000,
    });
    ctx.repository.registerSiteConfig({
      siteId: 'site_dec_b',
      tenantId: 'tenant_dec_b',
      consentMode: 'full',
      storageRegion: 'asia-northeast1',
      processingRegion: 'asia-northeast1',
      monthlyPvQuota: 100_000,
    });

    ctx.pipeline.keyRegistry.registerPrincipal({
      principalId: 'usr_dec_owner',
      tenantId: 'tenant_dec_a',
      orgId: 'org_dec_test',
      kind: 'service',
      role: 'admin',
      passkeyEnrolled: false,
    });

    const issued = ctx.pipeline.keyRegistry.issueSecretKey({
      tenantId: 'tenant_dec_a',
      principalId: 'usr_dec_owner',
      env: 'live',
      scopes: ['decisions:read'],
    });

    // 2. Foreign tenant site probe -> 404 (NOT 403!)
    const foreignReq = new NextRequest('https://api.ugokilink.invalid/api/v1/decisions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${issued.rawKey}`,
      },
      body: JSON.stringify({ siteId: 'site_dec_b', trafficClass: 'public' }),
    });
    const foreignRes = await postDecisionApi(foreignReq);
    expect(foreignRes.status).toBe(404);

    // 3. Own site -> 200 with valid I1–I7 ResponseEnvelope & honest fail-closed not_collected
    const okReq = new NextRequest('https://api.ugokilink.invalid/api/v1/decisions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${issued.rawKey}`,
      },
      body: JSON.stringify({ siteId: 'site_dec_a', trafficClass: 'public', pvId: 'pv_api_1' }),
    });
    const okRes = await postDecisionApi(okReq);
    expect(okRes.status).toBe(200);
    const body = await okRes.json();
    expect(validateSerializedEnvelope(body).valid).toBe(true);
    expect(body.measures.decision_issued.status).toBe('not_collected');
    expect(body.data.status).toBe('fail_closed_no_lease');
  });

  test('[M-15] POST /v1/decisions forwards clientIp & senderThumbprint, enforces per-key/IP rate limits, and fails closed 503 in prod without signing keys', async () => {
    const prevCtx = getSurfaceRuntimeContext();
    const prevNodeEnv = process.env.NODE_ENV;

    try {
      const keyRegistry = new IdentityKeyRegistry({
        pepperVersion: 'm15_v1',
        pepperSecret: 'm15_test_pepper_secret_0001',
      });
      const nowIso = new Date().toISOString();
      keyRegistry.registerOrg({ orgId: 'org_m15', type: 'direct', name: 'M15 Org', createdAt: nowIso });
      keyRegistry.registerTenant({
        tenantId: 'tenant_m15',
        orgId: 'org_m15',
        name: 'Tenant M15',
        planScopes: [...ALL_SCOPES],
        delegationPolicy: { allowOemAccess: false, allowedOemScopes: [], maxExchangedTokenTtlSec: 0 },
        revocationEpoch: 1,
        createdAt: nowIso,
      });
      keyRegistry.registerSite({
        siteId: 'site_m15',
        tenantId: 'tenant_m15',
        siteRef: 'ref_m15',
        env: 'live',
        hostnames: ['m15.example.jp'],
        allowedOrigins: ['https://m15.example.jp'],
        createdAt: nowIso,
      });
      keyRegistry.registerPrincipal({
        principalId: 'svc_m15',
        tenantId: 'tenant_m15',
        orgId: 'org_m15',
        kind: 'service',
        role: 'admin',
        passkeyEnrolled: false,
      });

      const ipAndSenderBoundKey = keyRegistry.issueSecretKey({
        tenantId: 'tenant_m15',
        principalId: 'svc_m15',
        env: 'live',
        scopes: ['decisions:read'],
        constraints: {
          ipAllowlist: ['203.0.113.10'],
          allowedCidrs: ['203.0.113.10/32'],
          senderThumbprint: 'jkt_expected_thumbprint_123',
          dpopThumbprint: 'jkt_expected_thumbprint_123',
          mtlsOrDpopThumbprint: 'jkt_expected_thumbprint_123',
        } as unknown as Record<string, unknown>,
      });

      const verifySpy = jest.spyOn(keyRegistry, 'verifySecretKey');

      const repository = new EmptyUnconnectedRepository();
      repository.registerSiteConfig({
        siteId: 'site_m15',
        tenantId: 'tenant_m15',
        siteName: 'M15 Site',
        consentMode: 'full',
        storageRegion: 'asia-northeast1',
        processingRegion: 'asia-northeast1',
        monthlyQuotaPvs: 100_000,
      });

      const tightRateLimiter = new CostUnitRateLimiter({ windowMs: 60_000, maxUnitsPerWindow: 2 });
      const pipeline = new SurfacePipeline({ keyRegistry, repository, rateLimiter: tightRateLimiter });
      const mcpServer = new LinkMcpServer(pipeline);
      const askService = new AskService({
        executor: {
          executePublicViewQuery: (p) => ({
            connected: false,
            rows: [],
            queryRefId: p.viewName,
            paramsHash: '0',
            resultDigest: '0',
          }),
        },
      });

      setSurfaceRuntimeContext({ pipeline, mcpServer, askService, repository });

      // 1. Wrong clientIp -> rejected by verifySecretKey!
      const badIpRes = await postDecisionApi(
        new NextRequest('https://api.ugokilink.invalid/api/v1/decisions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ipAndSenderBoundKey.rawKey}`,
            'x-forwarded-for': '198.51.100.99',
            'x-dpop-jkt': 'jkt_expected_thumbprint_123',
          },
          body: JSON.stringify({ siteId: 'site_m15', pvId: 'pv_1' }),
        })
      );
      expect(badIpRes.status).toBeGreaterThanOrEqual(401);
      expect(badIpRes.status).toBeLessThan(500);
      expect(verifySpy).toHaveBeenCalledWith(
        ipAndSenderBoundKey.rawKey,
        expect.objectContaining({
          siteId: 'site_m15',
          clientIp: '198.51.100.99',
          senderThumbprint: 'jkt_expected_thumbprint_123',
        })
      );

      // 2. Wrong x-dpop-jkt senderThumbprint -> forwarded to verifySecretKey and rejected!
      verifySpy.mockImplementationOnce((rawKey, opts) => {
        if (opts?.senderThumbprint !== 'jkt_expected_thumbprint_123') {
          return {
            ok: false as const,
            httpStatus: 401 as const,
            code: 'SENDER_THUMBPRINT_MISMATCH',
            reason: 'x-dpop-jkt thumbprint mismatch',
          };
        }
        return keyRegistry.verifySecretKey(rawKey, opts);
      });
      const badThumbRes = await postDecisionApi(
        new NextRequest('https://api.ugokilink.invalid/api/v1/decisions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ipAndSenderBoundKey.rawKey}`,
            'x-forwarded-for': '203.0.113.10',
            'x-dpop-jkt': 'jkt_forged_thumbprint',
          },
          body: JSON.stringify({ siteId: 'site_m15', pvId: 'pv_1' }),
        })
      );
      expect(badThumbRes.status).toBe(401);

      // 3. Matching IP + thumbprint succeeds up to rate limit (2 requests), 3rd returns 429
      const makeValidReq = (pvId: string) =>
        new NextRequest('https://api.ugokilink.invalid/api/v1/decisions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ipAndSenderBoundKey.rawKey}`,
            'x-forwarded-for': '203.0.113.10',
            'x-dpop-jkt': 'jkt_expected_thumbprint_123',
          },
          body: JSON.stringify({ siteId: 'site_m15', pvId }),
        });

      expect((await postDecisionApi(makeValidReq('pv_ok_1'))).status).toBe(200);
      expect((await postDecisionApi(makeValidReq('pv_ok_2'))).status).toBe(200);
      const rlRes = await postDecisionApi(makeValidReq('pv_rl_3'));
      expect(rlRes.status).toBe(429);

      // 4. Fresh context in NODE_ENV=production without configured signing keys -> fails closed 503
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      setSurfaceRuntimeContext({ pipeline, mcpServer, askService, repository });
      const prodUnconfigRes = await postDecisionApi(makeValidReq('pv_prod_unconfig'));
      expect(prodUnconfigRes.status).toBe(503);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
      setSurfaceRuntimeContext(prevCtx);
    }
  });
});
