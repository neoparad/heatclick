/**
 * UGOKI LINK v2 — Server-Side Decision API (`POST /v1/decisions`, §10.1)
 *
 * Authenticated via secret key (`ugk_sec_*`) through the unified identity & authorization
 * pipeline, calling the exact same Actor-Blind Allocator (`lib/link/allocator`) and
 * strongly-consistent control store (`workers/link-decision`) and returning the unified
 * `packages/contract/response` envelope.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  buildResponseEnvelope,
  createDataLayerMetric,
  sha256Hex,
} from '@/packages/contract/response';
import {
  TRAFFIC_CLASSES,
  type ConsentMode,
  type ConsentPurpose,
  type IdentityQuality,
  type TrafficClass,
} from '@/packages/contract/schema';
import { generateEd25519KeyPair } from '@/lib/link/auth';
import {
  buildApiVersionHeaders,
  extractBearerToken,
  getSurfaceRuntimeContext,
  readOptionalJsonBody,
} from '@/lib/link/surface';
import { EdgeDecisionWorker, type StrongControlStore } from '@/workers/link-decision';

let decisionWorkerSingleton: EdgeDecisionWorker | null = null;

function getDefaultDecisionWorker(): EdgeDecisionWorker {
  if (!decisionWorkerSingleton) {
    const pair = generateEd25519KeyPair('dec_api_v1');
    const unconnectedStrongStore: StrongControlStore = {
      backendName: 'durable_object_unconnected_default',
      consistency: 'durable_object_strong',
      readTenantControl: () => ({
        reachable: false,
        readLatencyMs: 0,
        record: null,
      }),
    };
    decisionWorkerSingleton = new EdgeDecisionWorker({
      controlStore: unconnectedStrongStore,
      signingPrivateKeyPem: pair.privateKeyPem,
      signingPublicKeyPem: pair.publicKeyPem,
    });
  }
  return decisionWorkerSingleton;
}

export async function POST(req: NextRequest) {
  const now = new Date();
  const nowIso = now.toISOString();
  const headers = buildApiVersionHeaders({
    requestedRevision: req.headers.get('x-ugoki-revision'),
    now,
  });

  const bearer = extractBearerToken(req);
  if (!bearer || !bearer.startsWith('ugk_sec_')) {
    return NextResponse.json(
      { error: { code: 'SECRET_KEY_REQUIRED', message: 'POST /v1/decisions requires a valid ugk_sec_* key' } },
      { status: 401, headers }
    );
  }

  const ctx = getSurfaceRuntimeContext();
  const body = await readOptionalJsonBody(req);
  const siteId = typeof body.siteId === 'string' ? body.siteId : '';
  if (!siteId) {
    return NextResponse.json(
      { error: { code: 'MISSING_SITE_ID', message: 'siteId is required' } },
      { status: 400, headers }
    );
  }

  const verified = ctx.pipeline.keyRegistry.verifySecretKey(bearer, { siteId, now });
  if (!verified.ok) {
    return NextResponse.json(
      { error: { code: verified.code, message: verified.reason } },
      { status: verified.httpStatus, headers }
    );
  }

  const siteCfg = ctx.repository.getSiteConfig(siteId);
  const callerSuppliedTenantId =
    typeof body.tenant_id === 'string'
      ? body.tenant_id
      : typeof body.tenantId === 'string'
        ? body.tenantId
        : undefined;

  const authz = ctx.pipeline.gateway.authorize({
    principal: verified.principal,
    action: 'decisions.evaluate',
    riskClass: 'R0',
    requiredScope: 'decisions:read',
    resource: {
      type: 'site',
      id: siteId,
      tenantId: siteCfg ? siteCfg.tenantId : '__nonexistent_tenant__',
      siteId,
    },
    callerSuppliedTenantId,
    now,
  });

  if (!authz.allowed || !siteCfg) {
    return NextResponse.json(
      { error: { code: authz.code, message: authz.reason, auditEntryId: authz.auditEntryId } },
      { status: authz.allowed ? 404 : authz.httpStatus, headers }
    );
  }

  const rawTrafficClass = body.trafficClass;
  const trafficClass: TrafficClass =
    typeof rawTrafficClass === 'string' &&
    (TRAFFIC_CLASSES as readonly string[]).includes(rawTrafficClass)
      ? (rawTrafficClass as TrafficClass)
      : 'public';

  const worker = getDefaultDecisionWorker();
  const decision = worker.decide({
    tenantId: verified.principal.tenantId,
    siteId,
    pvId: typeof body.pvId === 'string' ? body.pvId : undefined,
    existingVisitorId: typeof body.visitorId === 'string' ? body.visitorId : undefined,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    consentMode: (body.consentMode as ConsentMode | undefined) ?? siteCfg.consentMode,
    purposes: Array.isArray(body.purposes) ? (body.purposes as ConsentPurpose[]) : [],
    identityQuality: (body.identityQuality as IdentityQuality | undefined) ?? 'C',
    trafficClass,
    urlId: typeof body.urlId === 'string' ? body.urlId : 'url_unknown',
    pageId: typeof body.pageId === 'string' ? body.pageId : 'page_unknown',
    viewportClass: (body.viewportClass as 'mobile' | 'tablet' | 'desktop' | undefined) ?? 'desktop',
    pointerType: (body.pointerType as 'coarse' | 'fine' | 'none' | undefined) ?? 'fine',
    nowMs: now.getTime(),
  });

  const ref = {
    ref_id: `dec_${sha256Hex(decision.decisionContextId).slice(0, 16)}`,
    kind: 'ledger' as const,
    params_hash: sha256Hex(`${siteId}:${nowIso}`),
    watermarks: { as_of: nowIso },
    result_digest: sha256Hex(decision.decisionContextId),
    issued_at: nowIso,
    valid_until: new Date(now.getTime() + 60_000).toISOString(),
    kid: 'decision_v1',
  };

  const envelope = buildResponseEnvelope({
    window: { start: nowIso, end: nowIso },
    freshness: { data_through: nowIso, lag_s: 0, sources: { control_plane: nowIso }, stale: decision.status !== 'ok' },
    coverage: { ratio: decision.status === 'ok' ? 1 : 0, denominator_n: decision.status === 'ok' ? 1 : 0 },
    lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
    residency: { storage_region: siteCfg.storageRegion, processing_region: siteCfg.processingRegion },
    measures: {
      decision_issued:
        decision.status === 'ok'
          ? {
              value: createDataLayerMetric(1, ref.ref_id, { authority: 'allocator_experiment', createdAt: nowIso }),
              unit: 'decisions',
              status: 'ok',
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
              sample: { n: 1, unit_kind: 'decision' },
              interval: null,
            }
          : {
              value: null,
              unit: 'decisions',
              status: 'not_collected',
              reason: decision.reason,
              evidence: { level: 'observed', exactness: 'exact', criteria: [], refs: [ref], scope: `site:${siteId}` },
              sample: null,
              interval: null,
              unmet_gates: [{ id: 'del.D3', required: 1, observed: 0, unlock: 'Connect strongly-consistent control store' }],
            },
    },
    data: decision,
  });

  return NextResponse.json(envelope, {
    status: 200,
    headers: { ...headers, 'X-UGOKI-Audit-Id': authz.auditEntryId },
  });
}
