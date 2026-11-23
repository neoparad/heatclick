import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import {
  ALL_SCOPES,
  IdentityKeyRegistry,
  computeActionAndDiffHash,
  computeJwkThumbprint,
  computePkceS256Challenge,
  createDpopProofJwt,
  type VerifiedPrincipal,
} from '@/lib/link/auth';
import { AskService } from '@/lib/link/ask';
import type { HeatmapFetchPrincipal, HeatmapRenderRequest, HeatmapRenderService } from '@/lib/link/heatmap-render';
import { GET as mcpRouteGet, POST as mcpRoutePost } from '@/app/api/v1/mcp/route';
import {
  GET as heatmapRouteGet,
  POST as heatmapRoutePost,
} from '@/app/api/v1/sites/[siteId]/heatmap-image/route';
import { validateSerializedEnvelope } from '@/packages/contract/response';
import {
  BoundedTtlMap,
  CostUnitRateLimiter,
  EmptyUnconnectedRepository,
  INTERNAL_SCREENS,
  KeyPepperUnconfiguredError,
  LinkMcpServer,
  OPERATION_CATALOG,
  SegmentRegistry,
  SurfacePipeline,
  auditOpenApiCatalogAgainstUnknowables,
  buildApiVersionHeaders,
  buildDeletionCertificate,
  buildOpenApi31Document,
  evaluateOrderedFunnel,
  evaluateSegmentMembership,
  evaluateSegmentRule,
  evaluateSiteUsage,
  getSurfaceRuntimeContext,
  handleV1RestRoute,
  loadInternalScreenViaV1,
  resolveRuntimePepperSecret,
  setSurfaceRuntimeContext,
  validateMcpContentProvenance,
  type SiteRuntimeConfig,
  type SurfaceDataRepository,
} from './index';

function buildSurfaceTestFixture() {
  const now = new Date('2026-11-20T12:00:00Z');
  const keyRegistry = new IdentityKeyRegistry({
    pepperVersion: 'p1',
    pepperSecret: 'test-pepper-surface-001',
  });
  keyRegistry.registerOrg({ orgId: 'org_1', type: 'direct', name: 'Org 1', createdAt: now.toISOString() });
  keyRegistry.registerTenant({
    tenantId: 'tenant_a',
    orgId: 'org_1',
    name: 'Tenant A',
    planScopes: [...ALL_SCOPES],
    delegationPolicy: { allowedOemScopes: [], maxExchangedTokenTtlSec: 0, allowOemAccess: false },
    revocationEpoch: 1,
    createdAt: now.toISOString(),
  });
  keyRegistry.registerTenant({
    tenantId: 'tenant_b',
    orgId: 'org_1',
    name: 'Tenant B',
    planScopes: [...ALL_SCOPES],
    delegationPolicy: { allowedOemScopes: [], maxExchangedTokenTtlSec: 0, allowOemAccess: false },
    revocationEpoch: 1,
    createdAt: now.toISOString(),
  });
  keyRegistry.registerPrincipal({
    principalId: 'user_a',
    tenantId: 'tenant_a',
    orgId: 'org_1',
    kind: 'human',
    role: 'admin',
    passkeyEnrolled: true,
  });

  const siteA: SiteRuntimeConfig = {
    siteId: 'site_a1',
    tenantId: 'tenant_a',
    siteName: 'Example A',
    consentMode: 'full',
    storageRegion: 'ap-northeast-1',
    processingRegion: 'ap-northeast-1',
    monthlyQuotaPvs: 100,
    activeLinkGrantId: 'lgr_a1',
    committedSnapshotId: 'snap_001',
    registeredDestinationUrls: ['https://partner.example.jp/offer-1'],
  };
  const siteB: SiteRuntimeConfig = {
    siteId: 'site_b1',
    tenantId: 'tenant_b',
    siteName: 'Foreign B',
    consentMode: 'full',
    storageRegion: 'ap-northeast-1',
    processingRegion: 'ap-northeast-1',
    monthlyQuotaPvs: 100,
  };
  const siteCookieless: SiteRuntimeConfig = {
    siteId: 'site_a_cl',
    tenantId: 'tenant_a',
    siteName: 'Cookieless Site',
    consentMode: 'cookieless',
    storageRegion: 'ap-northeast-1',
    processingRegion: 'ap-northeast-1',
    monthlyQuotaPvs: 100,
  };

  const fullKey = keyRegistry.issueSecretKey({
    tenantId: 'tenant_a',
    principalId: 'user_a',
    scopes: ['analytics:read', 'fusion:read', 'decisions:read', 'decisions:write', 'decisions:publish', 'usage:read', 'privacy:delete'],
    now,
  });
  const readOnlyKey = keyRegistry.issueSecretKey({
    tenantId: 'tenant_a',
    principalId: 'user_a',
    scopes: ['analytics:read'],
    now,
  });

  const emptyRepo = new EmptyUnconnectedRepository();
  emptyRepo.registerSiteConfig(siteA);
  emptyRepo.registerSiteConfig(siteB);
  emptyRepo.registerSiteConfig(siteCookieless);

  const connectedRepo: SurfaceDataRepository = {
    getSiteConfig: (id) => emptyRepo.getSiteConfig(id),
    queryMetrics: ({ siteId }) =>
      siteId === 'site_a1'
        ? {
            connected: true,
            pageViews: 1500,
            conversions: 45,
            avgFocalDwellMs: 12400,
            dataThrough: now.toISOString(),
            lagSeconds: 12,
            queryRefId: 'qref_metrics_1',
            paramsHash: 'ph_1',
            resultDigest: 'rd_1',
            collectionGen: 'v3',
          }
        : null,
    queryFusedInsights: ({ siteId }) =>
      siteId === 'site_a1'
        ? [
            {
              pageId: 'pg_home',
              rawUrl: 'https://example-a.jp/guide',
              secFp: 'sec_hero_1',
              pageViews: 900,
              reachRate: 0.88,
              snapshotId: 'snap_001',
            },
          ]
        : null,
    querySegmentMetrics: () => [
      {
        segmentId: 'seg_big',
        segmentVersion: 1,
        segmentName: 'Organic Mobile',
        pageViews: 420,
        conversions: 21,
        avgDwellMs: 9500,
        queryRefId: 'qref_seg_1',
        paramsHash: 'ph_s1',
        resultDigest: 'rd_s1',
        issuedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 86400_000).toISOString(),
      },
      {
        segmentId: 'seg_tiny',
        segmentVersion: 1,
        segmentName: 'VIP Rare',
        pageViews: 6, // < 10 -> MUST be suppressed!
        conversions: 2,
        avgDwellMs: 15000,
        queryRefId: 'qref_seg_2',
        paramsHash: 'ph_s2',
        resultDigest: 'rd_s2',
        issuedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 86400_000).toISOString(),
      },
    ],
    queryJourneyEvents: () => {
      const evs = [];
      for (let i = 0; i < 15; i++) {
        evs.push({ sessionId: `s_${i}`, pagePath: '/', timestampMs: 1000, consentMode: 'full' as const });
        evs.push({ sessionId: `s_${i}`, pagePath: '/pricing', timestampMs: 5000, consentMode: 'full' as const });
        if (i < 5) {
          evs.push({ sessionId: `s_${i}`, pagePath: '/signup', timestampMs: 9000, consentMode: 'full' as const });
        }
      }
      return evs;
    },
    queryUsageRows: () => {
      const rows = [];
      // 105 billable rows + 50 quarantined/none rows against quota=100 -> 105% (quota_80 + quota_100, count_only!)
      for (let i = 0; i < 105; i++) {
        rows.push({
          rowId: `r_${i}`,
          tenantId: 'tenant_a',
          siteId: 'site_a1',
          saved: true,
          trustTier: 'continuity' as const,
          quarantined: false,
          isLabOrCanary: false,
          occurredAt: now.toISOString(),
        });
      }
      for (let i = 0; i < 50; i++) {
        rows.push({
          rowId: `q_${i}`,
          tenantId: 'tenant_a',
          siteId: 'site_a1',
          saved: true,
          trustTier: 'none' as const,
          quarantined: true,
          isLabOrCanary: false,
          occurredAt: now.toISOString(),
        });
      }
      return rows;
    },
  };

  return { now, keyRegistry, emptyRepo, connectedRepo, fullKey: fullKey.rawKey, readOnlyKey: readOnlyKey.rawKey };
}

describe('lib/link/surface — OpenAPI 3.1, Single Pipeline, MCP, Segments, Journeys, Usage, Privacy, Goals & 5-Screen Adapter', () => {
  test('OpenAPI 3.1 contract passes Unknowables Ledger lint (tel.M9) and enforces >=180-day Sunset headers', () => {
    const doc = buildOpenApi31Document();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(10);
    expect(doc['x-ugoki-contract-sha256']).toMatch(/^[0-9a-f]{64}$/);

    // Deterministic regeneration produces identical SHA-256
    expect(buildOpenApi31Document()['x-ugoki-contract-sha256']).toBe(doc['x-ugoki-contract-sha256']);

    const audit = auditOpenApiCatalogAgainstUnknowables();
    expect(audit.passed).toBe(true);
    expect(audit.failedCount).toBe(0);

    // Deprecation Sunset header enforces >= 180 days notice even if caller supplies shorter date
    const now = new Date('2026-11-20T00:00:00Z');
    const hdrs = buildApiVersionHeaders({
      deprecatedSunsetIso: '2026-12-01T00:00:00Z',
      now,
    });
    expect(hdrs['Deprecation']).toBe('true');
    const sunsetDate = new Date(hdrs['Sunset']);
    expect((sunsetDate.getTime() - now.getTime()) / (24 * 3600_000)).toBeGreaterThanOrEqual(180);
  });

  test('Single pipeline enforces tenant isolation (404 foreign / 403 own), rate units, I1–I7 envelope validation, and never returns dummy numbers when unconnected', () => {
    const { now, keyRegistry, emptyRepo, connectedRepo, fullKey, readOnlyKey } = buildSurfaceTestFixture();

    // Unconnected repository honestly returns `not_collected` with value: null
    const emptyPipeline = new SurfacePipeline({ keyRegistry, repository: emptyRepo });
    const unconnected = emptyPipeline.execute({
      operationId: 'querySiteMetrics',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      now,
    });
    expect(unconnected.httpStatus).toBe(200);
    expect(unconnected.envelope?.status).toBe('not_collected');
    expect(unconnected.envelope?.measures.page_views.value).toBeNull();
    expect(validateSerializedEnvelope(unconnected.envelope).valid).toBe(true);

    // Connected repository returns VerifiedMetricValue + wraps external URLs in UntrustedValue
    const pipeline = new SurfacePipeline({
      keyRegistry,
      repository: connectedRepo,
      rateLimiter: new CostUnitRateLimiter({ maxUnitsPerWindow: 10 }),
    });

    // Foreign tenant site -> ALWAYS 404 + audit entry
    const foreign = pipeline.execute({
      operationId: 'querySiteMetrics',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_b1',
      now,
    });
    expect(foreign.httpStatus).toBe(404);
    expect(foreign.error?.auditEntryId).toBeDefined();

    // Caller-supplied foreign tenant_id -> 404
    const spoofed = pipeline.execute({
      operationId: 'querySiteMetrics',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      callerSuppliedTenantId: 'tenant_b',
      now,
    });
    expect(spoofed.httpStatus).toBe(404);

    // Own-tenant missing scope -> 403
    const ownMissingScope = pipeline.execute({
      operationId: 'upsertGoal',
      channel: 'rest',
      bearerToken: readOnlyKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_goal_01',
      body: { name: 'Signup', kind: 'url_match', matcher: '/thanks' },
      now,
    });
    expect(ownMissingScope.httpStatus).toBe(403);

    // Valid fused insights -> I1–I7 valid & rawUrl wrapped in UntrustedValue
    const insights = pipeline.execute({
      operationId: 'querySiteFusedInsights',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      now,
    });
    expect(insights.httpStatus).toBe(200);
    expect(validateSerializedEnvelope(insights.envelope).valid).toBe(true);

    // Cost-unit rate limiter (budget = 10; fusedInsights used 4; 2 more calls of 4 -> 3rd hits 429!)
    expect(
      pipeline.execute({ operationId: 'querySiteFusedInsights', channel: 'rest', bearerToken: fullKey, siteId: 'site_a1', now }).httpStatus
    ).toBe(200);
    expect(
      pipeline.execute({ operationId: 'querySiteFusedInsights', channel: 'rest', bearerToken: fullKey, siteId: 'site_a1', now }).httpStatus
    ).toBe(429);
  });

  test('Registered segments preserve immutable versions, never auto-promote unknown, support Wave 6-A ML kinds, and suppress k<10 in comparisons', () => {
    const { now, keyRegistry, connectedRepo, fullKey } = buildSurfaceTestFixture();
    const reg = new SegmentRegistry();

    const v1 = reg.register({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      segmentId: 'seg_mobile_hi',
      name: 'Mobile High Dwell',
      kind: 'rule',
      rule: {
        type: 'and',
        children: [
          { type: 'predicate', field: 'device', op: 'eq', value: 'mobile' },
          { type: 'predicate', field: 'dwell_ms', op: 'gte', value: 5000 },
        ],
      },
      createdByPrincipalId: 'user_a',
      now,
    });
    const v2 = reg.register({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      segmentId: 'seg_mobile_hi',
      name: 'Mobile High Dwell v2',
      kind: 'centroid_ml',
      mlDescriptor: {
        modelId: 'cluster_v1',
        modelVersion: '1.0.0',
        featureNames: ['dwell_z', 'depth_z'],
        centroidVector: [0.5, 0.5],
        maxDistance: 1.0,
        inheritedSegmentId: 'seg_mobile_hi',
      },
      createdByPrincipalId: 'user_a',
      now,
    });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(reg.getVersion('tenant_a', 'site_a1', 'seg_mobile_hi', 1)?.kind).toBe('rule');

    // Tri-state rule: unknown attribute NEVER auto-promotes to true!
    expect(evaluateSegmentRule(v1.rule!, { device: 'mobile', dwell_ms: 8000 })).toBe(true);
    expect(evaluateSegmentRule(v1.rule!, { device: 'unknown', dwell_ms: 8000 })).toBe('unknown');
    expect(evaluateSegmentRule(v1.rule!, { device: 'mobile', dwell_ms: null })).toBe('unknown');
    expect(evaluateSegmentRule(v1.rule!, { device: 'desktop', dwell_ms: null })).toBe(false);

    // Wave 6-A centroid_ml evaluation + missing feature -> unknown
    expect(evaluateSegmentMembership(v2, { dwell_z: 0.6, depth_z: 0.4 })).toBe(true);
    expect(evaluateSegmentMembership(v2, { dwell_z: 5.0, depth_z: 5.0 })).toBe(false);
    expect(evaluateSegmentMembership(v2, { dwell_z: undefined, depth_z: 0.4 })).toBe('unknown');

    // Segment comparison via pipeline suppresses k < 10 cell (`seg_tiny` has 6 PVs)
    const pipeline = new SurfacePipeline({ keyRegistry, repository: connectedRepo });
    const cmp = pipeline.execute({
      operationId: 'compareSegments',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      body: { segmentIds: ['seg_big', 'seg_tiny'] },
      now,
    });
    expect(cmp.httpStatus).toBe(200);
    expect(cmp.envelope?.status).toBe('partial');
    expect(cmp.envelope?.measures.seg_seg_big_pvs.status).toBe('ok');
    expect(cmp.envelope?.measures.seg_seg_tiny_pvs.status).toBe('suppressed');
    expect(cmp.envelope?.measures.seg_seg_tiny_pvs.value).toBeNull();
  });

  test('Journeys respect cookieless consent limit (tel.U13), usage enforces 80/100/120% & count_only distinct from minimal, privacy disclosure & 14d cert work', () => {
    const { now, keyRegistry, connectedRepo, fullKey } = buildSurfaceTestFixture();
    const ref = {
      ref_id: 'ref_j1',
      kind: 'query' as const,
      params_hash: 'p',
      watermarks: { as_of: now.toISOString() },
      result_digest: 'd',
      issued_at: now.toISOString(),
      valid_until: now.toISOString(),
      kid: 'k1',
    };

    // Cookieless funnel -> not_collected (tel.U13)
    const cookielessFunnel = evaluateOrderedFunnel({
      siteConsentMode: 'cookieless',
      steps: ['/', '/pricing'],
      events: [],
      windowSec: 1800,
      queryRef: ref,
    });
    expect(cookielessFunnel.consentBlocked).toBe(true);
    expect(cookielessFunnel.measures.funnel_step_0_sessions.status).toBe('not_collected');

    // Usage metering: 105 billable (ignores 50 quarantined/none) against 100 quota -> 105%, count_only, 80 & 100% alerts
    const usage = evaluateSiteUsage({
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      monthlyQuotaPvs: 100,
      rows: connectedRepo.queryUsageRows({ tenantId: 'tenant_a', siteId: 'site_a1' })!,
      now,
    });
    expect(usage.billablePvs).toBe(105);
    expect(usage.ignoredUnverifiedOrQuarantinedPvs).toBe(50);
    expect(usage.collectionModeTag).toBe('over_quota_count_only');
    expect(usage.distinctFromComparisonArmMinimal).toBe(true);
    expect(usage.pvThinningForbidden).toBe(true);
    expect(usage.browserHttp402Forbidden).toBe(true);
    expect(usage.alerts.map((a) => a.kind)).toEqual(['quota_80', 'quota_100']);

    // Privacy disclosure & 14-day deletion certificate SLA check
    const pipeline = new SurfacePipeline({ keyRegistry, repository: connectedRepo });
    const discRes = pipeline.execute({
      operationId: 'getPrivacyDisclosure',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      now,
    });
    expect(discRes.httpStatus).toBe(200);
    expect(validateSerializedEnvelope(discRes.envelope).valid).toBe(true);

    const day11Cert = buildDeletionCertificate({
      requestId: 'del_1',
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      scope: 'subject',
      state: 'masked',
      scheduledAt: '2026-11-01T00:00:00Z',
      now: new Date('2026-11-12T00:00:00Z'),
    });
    expect(day11Cert.day10WarningIssued).toBe(true);
    expect(day11Cert.slaBreached).toBe(false);

    const overdueCert = buildDeletionCertificate({
      requestId: 'del_2',
      tenantId: 'tenant_a',
      siteId: 'site_a1',
      scope: 'subject',
      state: 'masked',
      scheduledAt: '2026-11-01T00:00:00Z',
      now: new Date('2026-11-16T00:00:00Z'),
    });
    expect(overdueCert.slaBreached).toBe(true);
    expect(overdueCert.state).toBe('overdue');
  });

  test('MCP server generates all tools from OpenAPI, exposes R2+ individually, supports search/enable & goals R1, and enforces content provenance + link table', () => {
    const { now, keyRegistry, connectedRepo, fullKey } = buildSurfaceTestFixture();
    const pipeline = new SurfacePipeline({ keyRegistry, repository: connectedRepo });
    const mcp = new LinkMcpServer(pipeline);

    const expectedMcpCount = OPERATION_CATALOG.filter((o) => o.exposeInMcp).length;
    expect(mcp.getAllToolCount()).toBe(expectedMcpCount);

    // Client cap leaves deferred tools discoverable via search + enable, while ALWAYS exposing R2/R4/R5 individually
    const listed = mcp.listVisibleTools({ clientFamily: 'generic_mcp', sessionId: 's_mcp_1' });
    expect(listed.deferredCount).toBeGreaterThan(0);
    expect(listed.visibleTools.some((t) => t.operationId === 'publishDecision' && t.individualHighRiskTool)).toBe(true);
    expect(listed.visibleTools.some((t) => t.operationId === 'manageLinkGrant' && t.individualHighRiskTool)).toBe(true);

    // Search & enable deferred tool
    const search = mcp.searchTools('notification');
    expect(search.some((t) => t.operationId === 'listNotifications')).toBe(true);
    expect(mcp.enableTool('s_mcp_1', 'ugokilink_listNotifications').ok).toBe(true);

    // Goal management (R1) via MCP works through the single pipeline
    const goalUpsert = mcp.callTool({
      toolName: 'ugokilink_upsertGoal',
      bearerToken: fullKey,
      arguments: {
        siteId: 'site_a1',
        idempotencyKey: 'idem_mcp_goal_01',
        name: 'Checkout Complete',
        kind: 'url_match',
        matcher: '/thanks',
        valueYen: 5000,
      },
      now,
    });
    expect(goalUpsert.httpStatus).toBe(200);
    expect(validateSerializedEnvelope(goalUpsert.envelope).valid).toBe(true);

    // Provenance & link destination table validation
    const badLink = validateMcpContentProvenance({
      items: [
        { fieldName: 'cta', provenance: 'approved_asset', assetOrSectionRef: 'asset_1', destinationUrl: 'https://evil.example.com/phish' },
      ],
      registeredDestinationUrls: ['https://partner.example.jp/offer-1'],
    });
    expect(badLink.ok).toBe(false);

    const freeText = validateMcpContentProvenance({
      items: [
        { fieldName: 'headline', provenance: 'free_text', destinationUrl: 'https://partner.example.jp/offer-1' },
      ],
      registeredDestinationUrls: ['https://partner.example.jp/offer-1'],
    });
    expect(freeText.ok).toBe(true);
    expect(freeText.requiresHumanApproval).toBe(true);
    expect(freeText.mappedFieldProvenance).toContain('open');
  });

  test('Internal 5-screen /v1 adapter switches cleanly via feature flags and propagates statuses without mock fallbacks', () => {
    const { now, keyRegistry, connectedRepo, emptyRepo, fullKey } = buildSurfaceTestFixture();
    const pipeline = new SurfacePipeline({ keyRegistry, repository: connectedRepo });
    const emptyPipeline = new SurfacePipeline({ keyRegistry, repository: emptyRepo });

    expect(INTERNAL_SCREENS).toHaveLength(5);

    // Flag off -> legacy_flag_off
    const offRes = loadInternalScreenViaV1({
      screen: 'overview',
      siteId: 'site_a1',
      flags: { useV1Surface: { overview: false } },
      pipeline,
      bearerToken: fullKey,
      now,
    });
    expect(offRes.mode).toBe('legacy_flag_off');

    // Flag on across all 5 screens -> v1_ok
    const allOnFlags = {
      useV1Surface: {
        overview: true,
        heatmap: true,
        cv_journey: true,
        crawler: true,
        experiments: true,
      },
    };
    for (const screen of INTERNAL_SCREENS) {
      const res = loadInternalScreenViaV1({
        screen,
        siteId: 'site_a1',
        flags: allOnFlags,
        pipeline,
        bearerToken: fullKey,
        now,
      });
      expect(res.mode).toBe('v1_ok');
      if (res.mode === 'v1_ok') {
        expect(res.viewModel.dataSource).toBe('v1_surface_api');
        expect(res.viewModel.residency.storageRegion).toBe('ap-northeast-1');
      }
    }

    // Unconnected store -> propagates `not_collected` with null value (never fake 0!)
    const emptyOverview = loadInternalScreenViaV1({
      screen: 'overview',
      siteId: 'site_a1',
      flags: allOnFlags,
      pipeline: emptyPipeline,
      bearerToken: fullKey,
      now,
    });
    expect(emptyOverview.mode).toBe('v1_ok');
    if (emptyOverview.mode === 'v1_ok') {
      expect(emptyOverview.viewModel.overallStatus).toBe('not_collected');
      expect(emptyOverview.viewModel.metrics.every((m) => m.value === null)).toBe(true);
    }

    // Ensure session principal also works seamlessly
    const sessionPrincipal: VerifiedPrincipal = {
      credentialKind: 'session_cookie',
      credentialId: 'sess_1',
      tenantId: 'tenant_a',
      orgId: 'org_1',
      allowedSiteIds: null,
      principalKind: 'human',
      principalId: 'user_a',
      role: 'admin',
      effectiveScopes: new Set(ALL_SCOPES),
      senderConstrained: true,
      passkeyVerified: true,
    };
    const sessOverview = loadInternalScreenViaV1({
      screen: 'overview',
      siteId: 'site_a1',
      flags: allOnFlags,
      pipeline,
      sessionPrincipal,
      now,
    });
    expect(sessOverview.mode).toBe('v1_ok');
  });

  test('[C-01] fails closed (503) in production when UGOKILINK_KEY_PEPPER is unset, eliminates static fallback strings, and enforces Bearer auth + tenant-scoped sessions on ALL /api/v1/mcp methods', async () => {
    // 1. Static source audit: zero hardcoded fallback pepper anywhere in http-adapter.ts
    const adapterSrc = fs.readFileSync(path.join(__dirname, 'http-adapter.ts'), 'utf8');
    expect(adapterSrc).not.toContain('unconfigured_ephemeral_pepper_do_not_use_in_prod');

    // 2. Production fail-closed check (`NODE_ENV === 'production'` without `UGOKILINK_KEY_PEPPER` -> 503!)
    const prevNodeEnv = process.env.NODE_ENV;
    const prevPepper = process.env.UGOKILINK_KEY_PEPPER;
    try {
      setSurfaceRuntimeContext(null);
      delete process.env.UGOKILINK_KEY_PEPPER;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      expect(() => resolveRuntimePepperSecret()).toThrow(KeyPepperUnconfiguredError);
      expect(() => getSurfaceRuntimeContext()).toThrow(KeyPepperUnconfiguredError);

      const prodMcpRes = await mcpRouteGet(new NextRequest('https://api.ugokilink.example/api/v1/mcp'));
      expect(prodMcpRes.status).toBe(503);
      const prodJson = (await prodMcpRes.json()) as { error: { code: string } };
      expect(prodJson.error.code).toBe('UGOKILINK_KEY_PEPPER_UNCONFIGURED');

      // Non-production generates 64-hex CSPRNG secret
      (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
      const nonProdSecret = resolveRuntimePepperSecret();
      expect(nonProdSecret).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
      if (prevPepper === undefined) {
        delete process.env.UGOKILINK_KEY_PEPPER;
      } else {
        process.env.UGOKILINK_KEY_PEPPER = prevPepper;
      }
      setSurfaceRuntimeContext(null);
    }

    // 3. Mandatory Bearer auth + cross-tenant session isolation on GET & POST /api/v1/mcp
    const { now, keyRegistry, emptyRepo, fullKey } = buildSurfaceTestFixture();
    keyRegistry.registerPrincipal({
      principalId: 'user_b',
      tenantId: 'tenant_b',
      orgId: 'org_1',
      kind: 'human',
      role: 'admin',
      passkeyEnrolled: true,
    });
    const tenantBKey = keyRegistry.issueSecretKey({
      tenantId: 'tenant_b',
      principalId: 'user_b',
      scopes: ['analytics:read'],
      now,
    }).rawKey;
    keyRegistry.registerSite({
      siteId: 'site_a1',
      tenantId: 'tenant_a',
      siteRef: 'ref_a1',
      env: 'live',
      hostnames: ['example-a.jp'],
      allowedOrigins: ['https://example-a.jp'],
      createdAt: now.toISOString(),
    });
    const pubKeyA = keyRegistry.issuePublicKey('site_a1');

    const pipeline = new SurfacePipeline({ keyRegistry, repository: emptyRepo });
    const mcpServer = new LinkMcpServer(pipeline);
    const askService = new AskService({
      executor: {
        executePublicViewQuery: (p) => ({
          connected: false,
          rows: [],
          queryRefId: p.viewName,
          paramsHash: 'h',
          resultDigest: 'd',
        }),
      },
    });
    setSurfaceRuntimeContext({ pipeline, mcpServer, askService, repository: emptyRepo });

    try {
      // Unauthenticated GET & POST across ALL 4 MCP methods -> 401!
      expect((await mcpRouteGet(new NextRequest('https://api.ugokilink.example/api/v1/mcp'))).status).toBe(401);
      for (const method of ['tools/list', 'tools/search', 'tools/enable', 'tools/call']) {
        const unauth = await mcpRoutePost(
          new NextRequest('https://api.ugokilink.example/api/v1/mcp', {
            method: 'POST',
            body: JSON.stringify({ method, sessionId: 'shared_sid', toolName: 'ugokilink_listNotifications', query: 'notif' }),
          })
        );
        expect(unauth.status).toBe(401);
      }

      // Browser public key (`ugk_pub_*`) rejected with 403 on MCP endpoint
      const pubAttempt = await mcpRoutePost(
        new NextRequest('https://api.ugokilink.example/api/v1/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${pubKeyA}` },
          body: JSON.stringify({ method: 'tools/list' }),
        })
      );
      expect(pubAttempt.status).toBe(403);

      // Tenant A enables deferred tool `ugokilink_request` (`ugokilink_recommendSiteItems`) on `sessionId: "shared_sid"`;
      // Tenant B listing tools with the IDENTICAL `sessionId: "shared_sid"` MUST NOT see Tenant A's enabled tool!
      const deferredToolName = 'ugokilink_recommendSiteItems';
      const enableA = await mcpRoutePost(
        new NextRequest('https://api.ugokilink.example/api/v1/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${fullKey}` },
          body: JSON.stringify({ method: 'tools/enable', sessionId: 'shared_sid', toolName: deferredToolName }),
        })
      );
      expect(enableA.status).toBe(200);

      const listA = await mcpRoutePost(
        new NextRequest('https://api.ugokilink.example/api/v1/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${fullKey}` },
          body: JSON.stringify({ method: 'tools/list', clientFamily: 'generic_mcp', sessionId: 'shared_sid' }),
        })
      );
      const bodyA = (await listA.json()) as { visibleTools: Array<{ name: string }> };
      expect(bodyA.visibleTools.some((t) => t.name === deferredToolName)).toBe(true);

      const listB = await mcpRoutePost(
        new NextRequest('https://api.ugokilink.example/api/v1/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${tenantBKey}` },
          body: JSON.stringify({ method: 'tools/list', clientFamily: 'generic_mcp', sessionId: 'shared_sid' }),
        })
      );
      const bodyB = (await listB.json()) as { visibleTools: Array<{ name: string }> };
      expect(bodyB.visibleTools.some((t) => t.name === deferredToolName)).toBe(false);
    } finally {
      setSurfaceRuntimeContext(null);
    }
  });

  test('[L-03] enforces bounded max-size + TTL eviction on BoundedTtlMap, CostUnitRateLimiter, SurfacePipeline idempotencyStore, and LinkMcpServer sessions', () => {
    const t0 = new Date('2026-11-20T12:00:00Z');

    // 1. BoundedTtlMap caps entries & expires past TTL
    const ttlMap = new BoundedTtlMap<number>({ maxEntries: 3, ttlMs: 1_000 });
    ttlMap.set('k1', 1, 100);
    ttlMap.set('k2', 2, 100);
    ttlMap.set('k3', 3, 100);
    ttlMap.set('k4', 4, 100);
    expect(ttlMap.getActiveCount(100)).toBe(3);
    expect(ttlMap.get('k1', 100)).toBeUndefined(); // oldest evicted!
    expect(ttlMap.get('k4', 1_200)).toBeUndefined(); // expired after 1000ms TTL!

    // 2. CostUnitRateLimiter caps active buckets
    const limiter = new CostUnitRateLimiter({ maxBuckets: 3, windowMs: 10_000, maxUnitsPerWindow: 50 });
    for (let i = 0; i < 10; i++) {
      limiter.consume(`bucket_${i}`, 1, t0);
    }
    expect(limiter.getActiveBucketCount(t0)).toBeLessThanOrEqual(3);

    // 3. SurfacePipeline idempotencyStore caps maxEntries, replays identical payload, and rejects payload mismatch (409)
    const { keyRegistry, emptyRepo, fullKey } = buildSurfaceTestFixture();
    const pipeline = new SurfacePipeline({
      keyRegistry,
      repository: emptyRepo,
      idempotencyMaxEntries: 2,
      idempotencyTtlMs: 5_000,
    });
    const firstWrite = pipeline.execute({
      operationId: 'upsertGoal',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_bound_001',
      body: { name: 'Goal 1', kind: 'url_match', matcher: '/a' },
      now: t0,
    });
    expect(firstWrite.httpStatus).toBe(200);

    // Identical Idempotency-Key + identical body -> replayed with header!
    const replayWrite = pipeline.execute({
      operationId: 'upsertGoal',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_bound_001',
      body: { name: 'Goal 1', kind: 'url_match', matcher: '/a' },
      now: t0,
    });
    expect(replayWrite.httpStatus).toBe(200);
    expect(replayWrite.headers['X-UGOKI-Idempotent-Replay']).toBe('true');

    // Identical Idempotency-Key + DIFFERENT body -> 409 conflict!
    const conflictWrite = pipeline.execute({
      operationId: 'upsertGoal',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_bound_001',
      body: { name: 'TAMPERED Goal', kind: 'url_match', matcher: '/evil' },
      now: t0,
    });
    expect(conflictWrite.httpStatus).toBe(409);
    expect(conflictWrite.error?.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

    // Exceeding maxEntries=2 evicts oldest idempotency record
    pipeline.execute({
      operationId: 'upsertGoal',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_bound_002',
      body: { name: 'Goal 2', kind: 'url_match', matcher: '/b' },
      now: t0,
    });
    pipeline.execute({
      operationId: 'upsertGoal',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_bound_003',
      body: { name: 'Goal 3', kind: 'url_match', matcher: '/c' },
      now: t0,
    });
    expect(pipeline.getIdempotencyEntryCount(t0)).toBeLessThanOrEqual(2);

    // 4. LinkMcpServer session map caps maxSessions & expires past sessionTtlMs
    const mcp = new LinkMcpServer(pipeline, OPERATION_CATALOG, { maxSessions: 2, sessionTtlMs: 2_000 });
    mcp.enableTool('s1', 'ugokilink_listNotifications', { tenantId: 'tenant_a', principalId: 'u1' }, t0);
    mcp.enableTool('s2', 'ugokilink_listNotifications', { tenantId: 'tenant_a', principalId: 'u1' }, t0);
    mcp.enableTool('s3', 'ugokilink_listNotifications', { tenantId: 'tenant_a', principalId: 'u1' }, t0);
    expect(mcp.getActiveSessionCount(t0)).toBeLessThanOrEqual(2);
    expect(mcp.getActiveSessionCount(new Date(t0.getTime() + 3_000))).toBe(0);
  });

  test('[C-02] heatmap-image route eliminates unverified x-ugk-* header auth, rejects client unit_datasets, enforces foreign-tenant 404, and derives audience server-side', async () => {
    // 1. Static source check: `extractPrincipalFromRequest` & `x-ugk-principal-id`/`x-ugk-audience` header trust deleted!
    const routeSrc = fs.readFileSync(
      path.join(__dirname, '../../../app/api/v1/sites/[siteId]/heatmap-image/route.ts'),
      'utf8'
    );
    expect(routeSrc).not.toContain('extractPrincipalFromRequest');
    expect(routeSrc).not.toContain('x-ugk-principal-id');
    expect(routeSrc).not.toContain('x-ugk-scopes');
    expect(routeSrc).not.toContain('x-ugk-audience');

    const { now, keyRegistry, emptyRepo, fullKey } = buildSurfaceTestFixture();
    // Register an external/OEM partner principal to verify server-derived `audience === 'external_party'`
    keyRegistry.registerPrincipal({
      principalId: 'oem_partner_1',
      tenantId: 'tenant_a',
      orgId: 'org_1',
      kind: 'oem_partner',
      role: 'viewer',
      passkeyEnrolled: false,
    });
    const oemPartnerKey = keyRegistry.issueSecretKey({
      tenantId: 'tenant_a',
      principalId: 'oem_partner_1',
      scopes: ['analytics:read'],
      now,
    }).rawKey;

    let capturedPrincipals: HeatmapFetchPrincipal[] = [];
    const mockHeatmapService = {
      fetchArtifactById: (p: { principal: HeatmapFetchPrincipal | null; artifact_id: string }) => {
        if (p.principal) capturedPrincipals.push(p.principal);
        return {
          http_status: 200 as const,
          artifact: { artifact_id: p.artifact_id, png_sha256: 'deadbeef' },
        };
      },
      renderHeatmap: (principal: HeatmapFetchPrincipal | null, req: HeatmapRenderRequest) => {
        if (principal) capturedPrincipals.push(principal);
        return {
          http_status: 200 as const,
          tenant_id: req.tenant_id,
          site_id: req.site_id,
          audience_seen: principal?.audience,
        };
      },
    } as unknown as HeatmapRenderService;

    const pipeline = new SurfacePipeline({ keyRegistry, repository: emptyRepo });
    const mcpServer = new LinkMcpServer(pipeline);
    const askService = new AskService({
      executor: {
        executePublicViewQuery: (p) => ({
          connected: false,
          rows: [],
          queryRefId: p.viewName,
          paramsHash: 'h',
          resultDigest: 'd',
        }),
      },
    });

    try {
      // Phase A: Unconnected dataset provider
      setSurfaceRuntimeContext({
        pipeline,
        mcpServer,
        askService,
        repository: emptyRepo,
        heatmapService: mockHeatmapService,
      });

      // Forged `x-ugk-*` headers without Bearer token -> 401!
      const spoofedHeaderReq = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image?artifact_id=art_1',
        {
          method: 'GET',
          headers: {
            'x-ugk-principal-id': 'admin_root',
            'x-ugk-tenant-id': 'tenant_a',
            'x-ugk-scopes': 'analytics:read,site:admin',
            'x-ugk-audience': 'site_owner',
          },
        }
      );
      expect((await heatmapRouteGet(spoofedHeaderReq, { params: { siteId: 'site_a1' } })).status).toBe(401);

      // Signed-URL-only `?sig=...` without Bearer token -> 401!
      const sigOnlyReq = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image?artifact_id=art_1&sig=forged_sig',
        { method: 'GET' }
      );
      expect((await heatmapRouteGet(sigOnlyReq, { params: { siteId: 'site_a1' } })).status).toBe(401);

      // Foreign body.tenant_id probe with valid Bearer token -> 404!
      const foreignBodyReq = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${fullKey}` },
          body: JSON.stringify({
            tenant_id: 'tenant_b',
            page_url: 'https://example-a.jp/',
            kind: 'click',
            actor_bucket: 'human',
          }),
        }
      );
      expect((await heatmapRoutePost(foreignBodyReq, { params: { siteId: 'site_a1' } })).status).toBe(404);

      // Client attempting to inject `unit_datasets` in POST body -> 403!
      const clientDatasetReq = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${fullKey}` },
          body: JSON.stringify({
            page_url: 'https://example-a.jp/',
            kind: 'click',
            actor_bucket: 'human',
            unit_datasets: [{ fake: true }],
          }),
        }
      );
      expect((await heatmapRoutePost(clientDatasetReq, { params: { siteId: 'site_a1' } })).status).toBe(403);

      // Unconnected repository returns honest `not_collected` ResponseEnvelope!
      const unconnectedPost = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${fullKey}` },
          body: JSON.stringify({
            page_url: 'https://example-a.jp/',
            kind: 'click',
            actor_bucket: 'human',
          }),
        }
      );
      const unconnectedRes = await heatmapRoutePost(unconnectedPost, { params: { siteId: 'site_a1' } });
      expect(unconnectedRes.status).toBe(200);
      const unconnectedBody = (await unconnectedRes.json()) as { status: string };
      expect(unconnectedBody.status).toBe('not_collected');

      // Phase B: Connected server-side `heatmapDatasetProvider` -> verifies server-derived `audience`!
      capturedPrincipals = [];
      setSurfaceRuntimeContext({
        pipeline,
        mcpServer,
        askService,
        repository: emptyRepo,
        heatmapService: mockHeatmapService,
        heatmapDatasetProvider: {
          loadUnitDatasets: () => [] as unknown as HeatmapRenderRequest['unit_datasets'],
        },
      });

      // Direct tenant secret key -> `audience: 'site_owner'`
      const ownerPost = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${fullKey}`, 'x-ugk-audience': 'external_party' },
          body: JSON.stringify({
            page_url: 'https://example-a.jp/',
            kind: 'click',
            actor_bucket: 'human',
          }),
        }
      );
      expect((await heatmapRoutePost(ownerPost, { params: { siteId: 'site_a1' } })).status).toBe(200);
      expect(capturedPrincipals[0]?.audience).toBe('site_owner');
      expect(capturedPrincipals[0]?.tenant_id).toBe('tenant_a');

      // OEM partner principal trying to spoof `x-ugk-audience: site_owner` -> server forces `'external_party'`!
      const oemPost = new NextRequest(
        'https://api.ugokilink.example/api/v1/sites/site_a1/heatmap-image',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${oemPartnerKey}`,
            'x-ugk-audience': 'site_owner',
          },
          body: JSON.stringify({
            page_url: 'https://example-a.jp/',
            kind: 'click',
            actor_bucket: 'human',
          }),
        }
      );
      expect((await heatmapRoutePost(oemPost, { params: { siteId: 'site_a1' } })).status).toBe(200);
      expect(capturedPrincipals[1]?.audience).toBe('external_party');
      expect(capturedPrincipals[1]?.tenant_id).toBe('tenant_a');
    } finally {
      setSurfaceRuntimeContext(null);
    }
  });

  test('[H-01] enforces 100% 1-to-1 bijection between OPERATION_CATALOG, OpenAPI 3.1 paths, MCP tools, and app/api/v1/**/route.ts on disk', () => {
    const v1Root = path.resolve(__dirname, '../../../app/api/v1');

    function collectRouteFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...collectRouteFiles(full));
        } else if (entry.isFile() && entry.name === 'route.ts') {
          out.push(full);
        }
      }
      return out;
    }

    const routeFiles = collectRouteFiles(v1Root);
    const diskEndpoints = new Set<string>();

    for (const file of routeFiles) {
      const relDir = path
        .relative(v1Root, path.dirname(file))
        .split(path.sep)
        .filter(Boolean)
        .map((seg) => seg.replace(/^\[([^\]]+)\]$/, '{$1}'))
        .join('/');
      const openApiPath = `/v1/${relDir}`;
      const src = fs.readFileSync(file, 'utf8');
      const methodRegex = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE)\b/g;
      let match: RegExpExecArray | null;
      while ((match = methodRegex.exec(src)) !== null) {
        diskEndpoints.add(`${match[1]} ${openApiPath}`);
      }
    }

    const catalogEndpoints = new Set<string>(
      OPERATION_CATALOG.map((op) => `${op.method} ${op.path}`)
    );

    // 1. Exact 1-to-1 parity between OPERATION_CATALOG and Next.js App Router files on disk!
    expect([...diskEndpoints].sort()).toEqual([...catalogEndpoints].sort());

    // 2. Required Wave 8 operations explicitly present in OPERATION_CATALOG, OpenAPI 3.1, and MCP
    for (const requiredEndpoint of [
      'POST /v1/decisions',
      'POST /v1/recommend',
      'POST /v1/sites/{siteId}/recommend',
      'GET /v1/sites/{siteId}/heatmap-image',
      'POST /v1/sites/{siteId}/heatmap-image',
      'GET /v1/sites/{siteId}/insights',
      'GET /v1/sites/{siteId}/notifications',
      'POST /v1/sites/{siteId}/segments/compare',
      'POST /v1/sites/{siteId}/decisions/publish',
      'POST /v1/sites/{siteId}/origin/apply',
      'POST /v1/sites/{siteId}/grants',
    ]) {
      expect(catalogEndpoints.has(requiredEndpoint)).toBe(true);
      expect(diskEndpoints.has(requiredEndpoint)).toBe(true);
    }

    const doc = buildOpenApi31Document();
    const openApiEndpoints = new Set<string>();
    for (const [p, methodsObj] of Object.entries(doc.paths)) {
      for (const m of Object.keys(methodsObj)) {
        openApiEndpoints.add(`${m.toUpperCase()} ${p}`);
      }
    }
    expect([...openApiEndpoints].sort()).toEqual([...catalogEndpoints].sort());

    const { keyRegistry, emptyRepo } = buildSurfaceTestFixture();
    const mcp = new LinkMcpServer(new SurfacePipeline({ keyRegistry, repository: emptyRepo }));
    for (const op of OPERATION_CATALOG) {
      if (op.exposeInMcp) {
        expect(mcp.getTool(`ugokilink_${op.operationId}`)).toBeDefined();
      } else {
        expect(mcp.getTool(`ugokilink_${op.operationId}`)).toBeUndefined();
      }
    }
  });

  test('Wave 9 Regression (#2): HTTP adapter rejects bare x-dpop-jkt and invalid DPoP proofs (401), and accepts genuine RFC 9449 signed DPoP proof (200)', async () => {
    const { keyRegistry, emptyRepo } = buildSurfaceTestFixture();
    const now = new Date();
    const dpopPair = crypto.generateKeyPairSync('ed25519');
    const dpopPubJwk = dpopPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const dpopJkt = computeJwkThumbprint(dpopPubJwk);

    const verifier = 'd'.repeat(48);
    const challenge = computePkceS256Challenge(verifier);
    const issued = keyRegistry.issueMcpOAuthToken({
      tenantId: 'tenant_a',
      principalId: 'user_a',
      clientId: 'claude_desktop',
      scopes: ['analytics:read'],
      codeVerifier: verifier,
      expectedCodeChallengeS256: challenge,
      dpopThumbprint: dpopJkt,
      now,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const pipeline = new SurfacePipeline({ keyRegistry, repository: emptyRepo });
    const mcpServer = new LinkMcpServer(pipeline);
    const askService = new AskService({
      executor: {
        executePublicViewQuery: (p) => ({
          connected: false,
          rows: [],
          queryRefId: p.viewName,
          paramsHash: 'h',
          resultDigest: 'd',
        }),
      },
    });

    try {
      setSurfaceRuntimeContext({ pipeline, mcpServer, askService, repository: emptyRepo });
      const url = 'https://api.ugokilink.example/api/v1/sites/site_a1/capabilities';

      // (a) Bare `x-dpop-jkt` header WITHOUT signed `DPoP` proof MUST fail closed with 401
      const spoofedJktRes = await handleV1RestRoute({
        req: new NextRequest(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${issued.accessToken}`,
            'x-dpop-jkt': dpopJkt,
          },
        }),
        operationId: 'getSiteCapabilities',
        siteId: 'site_a1',
      });
      expect(spoofedJktRes.status).toBe(401);

      // (b1) Wrong htm in signed DPoP proof -> 401
      const wrongHtmProof = createDpopProofJwt({
        alg: 'EdDSA',
        publicJwk: dpopPubJwk,
        privateKey: dpopPair.privateKey,
        htm: 'POST',
        htu: url,
        accessToken: issued.accessToken,
        now,
      });
      const wrongHtmRes = await handleV1RestRoute({
        req: new NextRequest(url, {
          method: 'GET',
          headers: {
            authorization: `DPoP ${issued.accessToken}`,
            dpop: wrongHtmProof,
          },
        }),
        operationId: 'getSiteCapabilities',
        siteId: 'site_a1',
      });
      expect(wrongHtmRes.status).toBe(401);

      // (b2) Wrong htu -> 401
      const wrongHtuProof = createDpopProofJwt({
        alg: 'EdDSA',
        publicJwk: dpopPubJwk,
        privateKey: dpopPair.privateKey,
        htm: 'GET',
        htu: 'https://api.ugokilink.example/api/v1/sites/site_other/capabilities',
        accessToken: issued.accessToken,
        now,
      });
      const wrongHtuRes = await handleV1RestRoute({
        req: new NextRequest(url, {
          method: 'GET',
          headers: {
            authorization: `DPoP ${issued.accessToken}`,
            dpop: wrongHtuProof,
          },
        }),
        operationId: 'getSiteCapabilities',
        siteId: 'site_a1',
      });
      expect(wrongHtuRes.status).toBe(401);

      // (c) Genuine signed DPoP proof succeeds (200), even with query string on request URL
      const validProof = createDpopProofJwt({
        alg: 'EdDSA',
        publicJwk: dpopPubJwk,
        privateKey: dpopPair.privateKey,
        htm: 'GET',
        htu: url,
        accessToken: issued.accessToken,
        jti: 'jti_http_adapter_001',
        now,
      });
      const okRes = await handleV1RestRoute({
        req: new NextRequest(`${url}?foo=bar`, {
          method: 'GET',
          headers: {
            authorization: `DPoP ${issued.accessToken}`,
            dpop: validProof,
          },
        }),
        operationId: 'getSiteCapabilities',
        siteId: 'site_a1',
      });
      expect(okRes.status).toBe(200);

      // (b3) Replaying the exact same DPoP proof (same jti) fails closed -> 401
      const replayRes = await handleV1RestRoute({
        req: new NextRequest(url, {
          method: 'GET',
          headers: {
            authorization: `DPoP ${issued.accessToken}`,
            dpop: validProof,
          },
        }),
        operationId: 'getSiteCapabilities',
        siteId: 'site_a1',
      });
      expect(replayRes.status).toBe(401);
    } finally {
      setSurfaceRuntimeContext(null);
    }
  });

  test('Wave 9 Regression (#25): 429 rate-limit does NOT burn single-use Passkey approval, and idempotent retry returns cached response instead of APPROVAL_ALREADY_CONSUMED', () => {
    const { now, keyRegistry, emptyRepo, fullKey } = buildSurfaceTestFixture();
    const rateLimiter = new CostUnitRateLimiter({ windowMs: 60_000, maxUnitsPerWindow: 6 });
    const pipeline = new SurfacePipeline({
      keyRegistry,
      repository: emptyRepo,
      rateLimiter,
    });

    const ownerSession: VerifiedPrincipal = {
      credentialKind: 'session_cookie',
      credentialId: 'sess_owner_25',
      tenantId: 'tenant_a',
      orgId: 'org_1',
      allowedSiteIds: null,
      principalKind: 'human',
      principalId: 'owner_a',
      role: 'owner',
      effectiveScopes: new Set(ALL_SCOPES),
      senderConstrained: true,
      passkeyVerified: true,
      passkeyVerifiedAt: now.toISOString(),
    };

    const publishBody = { ruleId: 'rule_25', variant: 'hero_b' };
    const { combinedHash } = computeActionAndDiffHash('publishDecision', publishBody);
    const aprRes = pipeline.gateway.createPasskeyApproval({
      principal: ownerSession,
      siteId: 'site_a1',
      action: 'publishDecision',
      renderedDiff: publishBody,
      passkeyAssertion: {
        credentialId: 'webauthn_owner_25',
        userVerification: true,
        signedChallengeHash: combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      now,
    });
    expect(aprRes.ok).toBe(true);
    if (!aprRes.ok) return;

    // Exhaust rate limit bucket for `fullKey` right before the R2 publishDecision call
    const authRes = pipeline.authenticateCaller({ bearerToken: fullKey, now });
    expect(authRes.ok).toBe(true);
    if (!authRes.ok) return;
    rateLimiter.consume(`${authRes.principal.tenantId}:${authRes.principal.credentialId}`, 6, now);

    // 1. Rate-limited (429) request MUST NOT burn the single-use Passkey approval!
    const rateLimited = pipeline.execute({
      operationId: 'publishDecision',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r2_publish_001',
      body: publishBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now,
    });
    expect(rateLimited.httpStatus).toBe(429);
    expect(rateLimited.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(aprRes.approval.consumedAt).toBeUndefined();

    // 2. Retry after rate-limit window resets (65s later) succeeds using the UNBURNED approval!
    const tRetry = new Date(now.getTime() + 65_000);
    const firstSuccess = pipeline.execute({
      operationId: 'publishDecision',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r2_publish_001',
      body: publishBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now: tRetry,
    });
    expect(firstSuccess.httpStatus).toBe(200);
    expect(aprRes.approval.consumedAt).toBeDefined();

    // 3. Idempotent retry with SAME Idempotency-Key + SAME payload returns cached 200 (NOT APPROVAL_ALREADY_CONSUMED)!
    const idempotentRetry = pipeline.execute({
      operationId: 'publishDecision',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r2_publish_001',
      body: publishBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now: new Date(tRetry.getTime() + 1_000),
    });
    expect(idempotentRetry.httpStatus).toBe(200);
    expect(idempotentRetry.headers['X-UGOKI-Idempotent-Replay']).toBe('true');

    // 4. Attempting to reuse the consumed approval under a DIFFERENT Idempotency-Key MUST still fail closed!
    const replayNewIdem = pipeline.execute({
      operationId: 'publishDecision',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r2_publish_002',
      body: publishBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now: new Date(tRetry.getTime() + 2_000),
    });
    expect(replayNewIdem.httpStatus).toBe(202);
    expect(replayNewIdem.error?.code).toBe('APPROVAL_ALREADY_CONSUMED');
  });

  test('Wave 10 Regression (#25 R4): 429 rate-limited R4 deletion creates 0 reservations without burning Passkey approval, and idempotent retry leaves strictly 1 reservation', () => {
    const { now, keyRegistry, emptyRepo, fullKey } = buildSurfaceTestFixture();
    const rateLimiter = new CostUnitRateLimiter({ windowMs: 60_000, maxUnitsPerWindow: 20 });
    const pipeline = new SurfacePipeline({
      keyRegistry,
      repository: emptyRepo,
      rateLimiter,
    });

    const ownerSession: VerifiedPrincipal = {
      credentialKind: 'session_cookie',
      credentialId: 'sess_owner_r4_25',
      tenantId: 'tenant_a',
      orgId: 'org_1',
      allowedSiteIds: null,
      principalKind: 'human',
      principalId: 'owner_a',
      role: 'owner',
      effectiveScopes: new Set(ALL_SCOPES),
      senderConstrained: true,
      passkeyVerified: true,
      passkeyVerifiedAt: now.toISOString(),
    };

    const deleteBody = { scope: 'site', reason: 'gdpr_site_wipe' };
    const { combinedHash } = computeActionAndDiffHash('createDeletionRequest', deleteBody);
    const aprRes = pipeline.gateway.createPasskeyApproval({
      principal: ownerSession,
      siteId: 'site_a1',
      action: 'createDeletionRequest',
      renderedDiff: deleteBody,
      passkeyAssertion: {
        credentialId: 'webauthn_owner_r4_25',
        userVerification: true,
        signedChallengeHash: combinedHash,
        assertedAt: now.toISOString(),
        signatureVerified: true,
      },
      now,
    });
    expect(aprRes.ok).toBe(true);
    if (!aprRes.ok) return;

    // Exhaust rate limit bucket for `fullKey`
    const authRes = pipeline.authenticateCaller({ bearerToken: fullKey, now });
    expect(authRes.ok).toBe(true);
    if (!authRes.ok) return;
    rateLimiter.consume(`${authRes.principal.tenantId}:${authRes.principal.credentialId}`, 20, now);

    // (a) 429 rate-limited R4 deletion creates 0 reservations and does NOT burn the Passkey approval!
    const rateLimited = pipeline.execute({
      operationId: 'createDeletionRequest',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r4_delete_001',
      body: deleteBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now,
    });
    expect(rateLimited.httpStatus).toBe(429);
    expect(rateLimited.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(pipeline.gateway.listDestructionRequests('tenant_a')).toHaveLength(0);
    expect(aprRes.approval.consumedAt).toBeUndefined();

    // (b) Retry after rate-limit window resets succeeds (202), consumes approval, and creates strictly 1 reservation
    const tRetry = new Date(now.getTime() + 65_000);
    const firstOk = pipeline.execute({
      operationId: 'createDeletionRequest',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r4_delete_001',
      body: deleteBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now: tRetry,
    });
    expect(firstOk.httpStatus).toBe(202);
    expect(aprRes.approval.consumedAt).toBeDefined();
    expect(pipeline.gateway.listDestructionRequests('tenant_a')).toHaveLength(1);
    const firstReqId = (
      firstOk.envelope?.data as { deletionRequest?: { requestId: string } }
    )?.deletionRequest?.requestId;
    expect(firstReqId).toBeDefined();

    // (c) Idempotent retry of the succeeded R4 deletion returns cached 202 and leaves strictly 1 reservation (NEVER 2!)
    const idempotentRetry = pipeline.execute({
      operationId: 'createDeletionRequest',
      channel: 'rest',
      bearerToken: fullKey,
      siteId: 'site_a1',
      idempotencyKey: 'idem_r4_delete_001',
      body: deleteBody,
      passkeyApprovalId: aprRes.approval.approvalId,
      now: new Date(tRetry.getTime() + 1_000),
    });
    expect(idempotentRetry.httpStatus).toBe(202);
    expect(idempotentRetry.headers['X-UGOKI-Idempotent-Replay']).toBe('true');
    const retryReqId = (
      idempotentRetry.envelope?.data as { deletionRequest?: { requestId: string } }
    )?.deletionRequest?.requestId;
    expect(retryReqId).toBe(firstReqId);
    expect(pipeline.gateway.listDestructionRequests('tenant_a')).toHaveLength(1);
  });
});
