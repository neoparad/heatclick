import {
  ALL_SCOPES,
  IdentityKeyRegistry,
  type VerifiedPrincipal,
} from '@/lib/link/auth';
import { validateSerializedEnvelope } from '@/packages/contract/response';
import {
  CostUnitRateLimiter,
  EmptyUnconnectedRepository,
  INTERNAL_SCREENS,
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
  loadInternalScreenViaV1,
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
});
