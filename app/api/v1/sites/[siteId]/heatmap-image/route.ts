/**
 * UGOKI LINK v2 — REST Route: `GET` / `POST` `/api/v1/sites/[siteId]/heatmap-image` (§11.12 & [C-02])
 *
 * Security invariants (`[C-02]`):
 *   - ZERO trust in client-supplied principal/tenant/scope/audience headers or signed-URL-only (`?sig=...`) parameters.
 *   - Authenticates EVERY `GET` and `POST` request through `getSurfaceRuntimeContext()`
 *     (`IdentityKeyRegistry` + `AuthorizationGateway` + `CostUnitRateLimiter`).
 *   - Derives `tenant_id` strictly from verified `principal.tenantId` (rejecting foreign
 *     `body.tenant_id` / query `tenant_id` / foreign or unknown `siteId` with HTTP 404).
 *   - Derives `audience` strictly server-side from verified principal kind (`oem_exchanged` /
 *     `oem_key` / `oem_partner` / `external_grant` / `share_token` -> `'external_party'`,
 *     direct tenant principal -> `'site_owner'`).
 *   - Never accepts client-injected `unit_datasets`; loads datasets exclusively from
 *     server-side `ctx.heatmapDatasetProvider`, returning an honest `not_collected`
 *     `ResponseEnvelope` when unconnected.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Scope, VerifiedPrincipal } from '@/lib/link/auth';
import {
  HeatmapRenderService,
  type HeatmapConsentMode,
  type HeatmapFetchPrincipal,
  type HeatmapRenderRequest,
} from '@/lib/link/heatmap-render';
import {
  KeyPepperUnconfiguredError,
  buildApiVersionHeaders,
  extractBearerToken,
  extractQueryParams,
  getSurfaceRuntimeContext,
  type SurfaceRuntimeContext,
} from '@/lib/link/surface';
import { buildResponseEnvelope, sha256Hex } from '@/packages/contract/response';

const defaultHeatmapService = new HeatmapRenderService();

function deriveServerHeatmapPrincipal(
  principal: VerifiedPrincipal,
  revocationEpoch: number
): HeatmapFetchPrincipal {
  const kindStr = principal.credentialKind as string;
  const principalKindStr = principal.principalKind as string;
  const isExternalParty =
    kindStr === 'oem_exchanged' ||
    kindStr === 'oem_key' ||
    kindStr === 'external_grant' ||
    kindStr === 'share_token' ||
    principalKindStr === 'oem_partner';

  const audience: 'site_owner' | 'external_party' = isExternalParty
    ? 'external_party'
    : 'site_owner';

  return Object.freeze({
    principal_id: principal.principalId,
    tenant_id: principal.tenantId,
    allowed_site_ids:
      principal.allowedSiteIds === null ? ('*' as const) : principal.allowedSiteIds,
    scopes: Array.from(principal.effectiveScopes) as Scope[],
    token_revocation_epoch: revocationEpoch,
    audience,
  });
}

function authenticateAndAuthorizeHeatmapRoute(params: {
  readonly req: NextRequest;
  readonly siteId: string;
  readonly operationId: 'getHeatmapArtifact' | 'renderHeatmapImage';
  readonly costUnits: number;
  readonly callerSuppliedTenantId?: string;
  readonly now: Date;
}):
  | {
      readonly ok: true;
      readonly ctx: SurfaceRuntimeContext;
      readonly principal: VerifiedPrincipal;
      readonly heatmapPrincipal: HeatmapFetchPrincipal;
      readonly siteConsentMode: HeatmapRenderRequest['consent_mode'];
      readonly storageRegion: string;
      readonly processingRegion: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly response: NextResponse } {
  const versionHeaders = buildApiVersionHeaders({
    requestedRevision: params.req.headers.get('x-ugoki-revision'),
    now: params.now,
  });
  const baseHeaders = {
    'Cache-Control': 'private, no-store',
    ...versionHeaders,
  };

  let ctx: SurfaceRuntimeContext;
  try {
    ctx = getSurfaceRuntimeContext();
  } catch (err) {
    if (err instanceof KeyPepperUnconfiguredError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: { code: err.code, message: err.message } },
          { status: err.httpStatus, headers: baseHeaders }
        ),
      };
    }
    throw err;
  }

  const bearerToken = extractBearerToken(params.req);
  if (!bearerToken && params.req.nextUrl.searchParams.get('sig')) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'SIGNED_URL_ONLY_FORBIDDEN',
            message: 'Signed URL token alone cannot access heatmap artifacts; Bearer authentication is required',
          },
        },
        { status: 401, headers: baseHeaders }
      ),
    };
  }

  const clientIp =
    params.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    params.req.headers.get('x-real-ip')?.trim() ??
    undefined;

  const auth = ctx.pipeline.authenticateCaller({
    bearerToken,
    clientIp,
    dpopThumbprint: params.req.headers.get('x-dpop-jkt') ?? undefined,
    siteId: params.siteId,
    forbidPublicBrowserKey: true,
    now: params.now,
  });

  if (!auth.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: { code: auth.code, message: auth.reason } },
        { status: auth.httpStatus, headers: baseHeaders }
      ),
    };
  }

  const principal = auth.principal;
  const siteCfg = ctx.repository.getSiteConfig(params.siteId);

  const authz = ctx.pipeline.gateway.authorize({
    principal,
    action: params.operationId,
    riskClass: 'R0',
    requiredScope: 'analytics:read',
    resource: {
      type: 'site',
      id: params.siteId,
      tenantId: siteCfg ? siteCfg.tenantId : '__nonexistent_tenant__',
      siteId: params.siteId,
    },
    callerSuppliedTenantId: params.callerSuppliedTenantId,
    now: params.now,
  });

  if (!authz.allowed || !siteCfg) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: authz.allowed ? 'SITE_NOT_FOUND' : authz.code,
            message: authz.allowed ? 'Site not found' : authz.reason,
            auditEntryId: authz.auditEntryId,
          },
        },
        { status: authz.allowed ? 404 : authz.httpStatus, headers: baseHeaders }
      ),
    };
  }

  const rateKey = `heatmap:${principal.tenantId}:${principal.credentialId}:${clientIp ?? 'no_ip'}`;
  const rate = ctx.pipeline.rateLimiter.consume(rateKey, params.costUnits, params.now);
  if (!rate.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Rate limit exceeded for ${params.operationId}`,
            auditEntryId: authz.auditEntryId,
          },
        },
        {
          status: 429,
          headers: {
            ...baseHeaders,
            'Retry-After': String(rate.retryAfterSec),
            'X-UGOKI-Cost-Units-Remaining': String(rate.remaining),
          },
        }
      ),
    };
  }

  const tenant = ctx.pipeline.keyRegistry.getTenant(principal.tenantId);
  const heatmapPrincipal = deriveServerHeatmapPrincipal(principal, tenant?.revocationEpoch ?? 1);

  const mappedHeatmapConsentMode: HeatmapConsentMode =
    siteCfg.consentMode === 'session' ? 'essential_first_party' : siteCfg.consentMode;

  return {
    ok: true,
    ctx,
    principal,
    heatmapPrincipal,
    siteConsentMode: mappedHeatmapConsentMode,
    storageRegion: siteCfg.storageRegion,
    processingRegion: siteCfg.processingRegion,
    headers: {
      ...baseHeaders,
      'X-UGOKI-Cost-Units': String(params.costUnits),
      'X-UGOKI-Cost-Units-Remaining': String(rate.remaining),
      'X-UGOKI-Audit-Id': authz.auditEntryId,
    },
  };
}

export async function GET(
  req: NextRequest,
  context: { params: { siteId: string } }
): Promise<NextResponse> {
  const now = new Date();
  const siteId = context.params.siteId;
  const queryParams = extractQueryParams(req);
  const callerSuppliedTenantId =
    queryParams.tenant_id ??
    queryParams.tenantId ??
    req.headers.get('x-tenant-id') ??
    undefined;

  const verified = authenticateAndAuthorizeHeatmapRoute({
    req,
    siteId,
    operationId: 'getHeatmapArtifact',
    costUnits: 1,
    callerSuppliedTenantId,
    now,
  });
  if (!verified.ok) {
    return verified.response;
  }

  const artifactId = req.nextUrl.searchParams.get('artifact_id')?.trim();
  if (!artifactId) {
    return NextResponse.json(
      { error: { code: 'MISSING_ARTIFACT_ID', message: 'artifact_id query parameter is required' } },
      { status: 400, headers: verified.headers }
    );
  }

  const heatmapSvc = verified.ctx.heatmapService ?? defaultHeatmapService;
  const result = heatmapSvc.fetchArtifactById({
    principal: verified.heatmapPrincipal,
    artifact_id: artifactId,
    signed_url_token_only: false,
    now_iso: now.toISOString(),
  });

  if (result.http_status !== 200 || !result.artifact) {
    return NextResponse.json(
      { ok: false, error: result.reason, artifact_id: artifactId },
      { status: result.http_status, headers: verified.headers }
    );
  }

  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('image/png') && result.png_bytes) {
    return new NextResponse(Buffer.from(result.png_bytes), {
      status: 200,
      headers: {
        ...verified.headers,
        'Content-Type': 'image/png',
        'X-UGK-Artifact-Id': result.artifact.artifact_id,
        'X-UGK-Png-Sha256': result.artifact.png_sha256 ?? '',
      },
    });
  }

  return NextResponse.json(
    { ok: true, site_id: siteId, artifact: result.artifact },
    { status: 200, headers: verified.headers }
  );
}

export async function POST(
  req: NextRequest,
  context: { params: { siteId: string } }
): Promise<NextResponse> {
  const now = new Date();
  const nowIso = now.toISOString();
  const siteId = context.params.siteId;
  const queryParams = extractQueryParams(req);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json(
        { ok: false, error: 'invalid_json_body' },
        { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json_body' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const callerSuppliedTenantId =
    queryParams.tenant_id ??
    queryParams.tenantId ??
    (typeof body.tenant_id === 'string' ? body.tenant_id : undefined) ??
    (typeof body.tenantId === 'string' ? body.tenantId : undefined) ??
    req.headers.get('x-tenant-id') ??
    undefined;

  const verified = authenticateAndAuthorizeHeatmapRoute({
    req,
    siteId,
    operationId: 'renderHeatmapImage',
    costUnits: 4,
    callerSuppliedTenantId,
    now,
  });
  if (!verified.ok) {
    return verified.response;
  }

  // [C-02]: NEVER accept client-injected arbitrary `unit_datasets`!
  if (Object.prototype.hasOwnProperty.call(body, 'unit_datasets') && body.unit_datasets !== undefined) {
    return NextResponse.json(
      {
        error: {
          code: 'CLIENT_UNIT_DATASETS_FORBIDDEN',
          message: 'Client-supplied unit_datasets are forbidden; heatmap datasets are loaded strictly server-side',
        },
      },
      { status: 403, headers: verified.headers }
    );
  }

  const pageUrl = typeof body.page_url === 'string' ? body.page_url.trim() : '';
  const kind = body.kind as HeatmapRenderRequest['kind'] | undefined;
  const actorBucket = body.actor_bucket as HeatmapRenderRequest['actor_bucket'] | undefined;

  if (!pageUrl || !kind || !actorBucket) {
    return NextResponse.json(
      { ok: false, error: 'missing_required_fields' },
      { status: 400, headers: verified.headers }
    );
  }

  const periodStart =
    typeof body.period_start === 'string' && body.period_start
      ? body.period_start
      : '2026-11-01T00:00:00Z';
  const periodEnd =
    typeof body.period_end === 'string' && body.period_end
      ? body.period_end
      : '2026-11-20T00:00:00Z';
  const deviceClass =
    (body.device_class as HeatmapRenderRequest['device_class'] | undefined) ?? 'desktop';
  const segmentId = typeof body.segment_id === 'string' ? body.segment_id : 'all';

  // Resolve unit_datasets strictly from server-side provider on SurfaceRuntimeContext
  const serverDatasets =
    verified.ctx.heatmapDatasetProvider?.loadUnitDatasets({
      tenantId: verified.principal.tenantId,
      siteId,
      pageUrl,
      periodStart,
      periodEnd,
      kind,
      actorBucket,
      deviceClass,
      segmentId,
    }) ?? null;

  if (!serverDatasets) {
    const ref = {
      ref_id: `hm_unconnected_${sha256Hex(`${verified.principal.tenantId}:${siteId}:${pageUrl}`).slice(0, 16)}`,
      kind: 'query' as const,
      params_hash: sha256Hex(`${siteId}:${pageUrl}:${periodStart}:${periodEnd}`),
      watermarks: { as_of: nowIso },
      result_digest: sha256Hex('unconnected'),
      issued_at: nowIso,
      valid_until: new Date(now.getTime() + 24 * 3600_000).toISOString(),
      kid: 'heatmap_v1',
    };
    const envelope = buildResponseEnvelope({
      window: { start: periodStart, end: periodEnd },
      freshness: { data_through: nowIso, lag_s: 0, sources: {}, stale: false },
      coverage: { ratio: 0, denominator_n: 0 },
      lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
      residency: {
        storage_region: verified.storageRegion,
        processing_region: verified.processingRegion,
      },
      measures: {
        heatmap_units: {
          value: null,
          unit: 'units',
          status: 'not_collected',
          reason: 'Server-side heatmap telemetry repository not connected for this site',
          evidence: {
            level: 'observed',
            exactness: 'exact',
            criteria: [],
            refs: [ref],
            scope: `site:${siteId}`,
          },
          sample: null,
          interval: null,
          unmet_gates: [
            {
              id: 'store.G-7',
              required: 1,
              observed: 0,
              unlock: 'Connect server-side heatmap dataset repository for this site',
            },
          ],
        },
      },
      data: {
        siteId,
        audience: verified.heatmapPrincipal.audience,
        artifacts: [],
      },
    });
    return NextResponse.json(envelope, { status: 200, headers: verified.headers });
  }

  const renderReq: HeatmapRenderRequest = {
    tenant_id: verified.principal.tenantId,
    site_id: siteId,
    page_url: pageUrl,
    period_start: periodStart,
    period_end: periodEnd,
    device_class: deviceClass,
    kind,
    lane: (body.lane as HeatmapRenderRequest['lane'] | undefined) ?? 'standard_telemetry',
    actor_bucket: actorBucket,
    verdict_version: typeof body.verdict_version === 'string' ? body.verdict_version : 'verdict/1',
    segment_id: segmentId,
    consent_mode: verified.siteConsentMode,
    granted_purposes: Array.isArray(body.granted_purposes)
      ? (body.granted_purposes as HeatmapRenderRequest['granted_purposes'])
      : ['standard_analytics'],
    jurisdiction: (body.jurisdiction as HeatmapRenderRequest['jurisdiction'] | undefined) ?? 'JP',
    sdk_capability:
      (body.sdk_capability as HeatmapRenderRequest['sdk_capability'] | undefined) ?? 'full',
    custom_event_mapped_to_page_version_position:
      typeof body.custom_event_mapped_to_page_version_position === 'boolean'
        ? body.custom_event_mapped_to_page_version_position
        : undefined,
    requested_metric_keys: Array.isArray(body.requested_metric_keys)
      ? (body.requested_metric_keys as string[])
      : undefined,
    model_inferred_header: body.model_inferred_header as HeatmapRenderRequest['model_inferred_header'],
    unit_datasets: serverDatasets,
    custom_display_label:
      typeof body.custom_display_label === 'string' ? body.custom_display_label : undefined,
    requested_at: nowIso,
  };

  const heatmapSvc = verified.ctx.heatmapService ?? defaultHeatmapService;
  try {
    const res = heatmapSvc.renderHeatmap(verified.heatmapPrincipal, renderReq);
    return NextResponse.json(res, {
      status: res.http_status,
      headers: verified.headers,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'render_failed' },
      { status: 400, headers: verified.headers }
    );
  }
}
