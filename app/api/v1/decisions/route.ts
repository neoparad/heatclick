/**
 * UGOKI LINK v2 — Server-Side Decision API (`POST /v1/decisions`, §10.1 + [M-15])
 *
 * Authenticated via secret key (`ugk_sec_*`) with `clientIp` + `senderThumbprint` (`x-dpop-jkt`)
 * binding and per-key/IP cost-unit rate limiting through the unified identity & authorization
 * pipeline, calling the Actor-Blind Allocator (`lib/link/allocator`) and strongly-consistent
 * control store (`workers/link-decision`) and returning the unified I1–I7 ResponseEnvelope.
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
  type SurfaceRuntimeContext,
} from '@/lib/link/surface';
import {
  EdgeDecisionWorker,
  type EdgeDecisionContextResponse,
  type StrongControlStore,
} from '@/workers/link-decision';

const contextWorkers = new WeakMap<object, EdgeDecisionWorker>();

function resolveDecisionWorkerForContext(
  ctx: SurfaceRuntimeContext & {
    readonly decisionWorker?: EdgeDecisionWorker;
    readonly decisionSigningKeyPair?: {
      readonly privateKeyPem: string;
      readonly publicKeyPem: string;
    };
  }
): { readonly ok: true; readonly worker: EdgeDecisionWorker } | { readonly ok: false; readonly code: string; readonly message: string } {
  if (ctx.decisionWorker) {
    return { ok: true, worker: ctx.decisionWorker };
  }

  const cached = contextWorkers.get(ctx);
  if (cached) {
    return { ok: true, worker: cached };
  }

  const configuredPair =
    ctx.decisionSigningKeyPair ??
    (process.env.UGOKILINK_DECISION_SIGNING_PRIVATE_KEY_PEM &&
    process.env.UGOKILINK_DECISION_SIGNING_PUBLIC_KEY_PEM
      ? {
          privateKeyPem: process.env.UGOKILINK_DECISION_SIGNING_PRIVATE_KEY_PEM,
          publicKeyPem: process.env.UGOKILINK_DECISION_SIGNING_PUBLIC_KEY_PEM,
        }
      : null);

  if (!configuredPair && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      code: 'DECISION_SIGNING_KEY_UNCONFIGURED',
      message:
        'Production POST /v1/decisions requires configured runtime signing keys (UGOKILINK_DECISION_SIGNING_PRIVATE_KEY_PEM / PUBLIC_KEY_PEM)',
    };
  }

  const pair = configuredPair ?? generateEd25519KeyPair('dec_api_v1');
  const unconnectedStrongStore: StrongControlStore = {
    backendName: 'durable_object_unconnected_default',
    consistency: 'durable_object_strong',
    readTenantControl: () => ({
      reachable: false,
      readLatencyMs: 0,
      record: null,
    }),
  };
  const worker = new EdgeDecisionWorker({
    controlStore: unconnectedStrongStore,
    signingPrivateKeyPem: pair.privateKeyPem,
    signingPublicKeyPem: pair.publicKeyPem,
  });
  contextWorkers.set(ctx, worker);
  return { ok: true, worker };
}

function serializeEnvelopeSafeDecisionPayload(decision: EdgeDecisionContextResponse) {
  return {
    status: decision.status,
    decisionContextId: decision.decisionContextId,
    tenantId: decision.tenantId,
    siteId: decision.siteId,
    pvId: decision.pvId,
    configVersion: decision.configVersion,
    killStampTag: `v${decision.killStampVersion}`,
    consentTier: decision.consentTier,
    displayLease: decision.displayLease
      ? {
          leaseId: decision.displayLease.leaseId,
          tenantId: decision.displayLease.tenantId,
          siteId: decision.displayLease.siteId,
          pvId: decision.displayLease.pvId,
          issuedAt: new Date(decision.displayLease.issuedAtMs).toISOString(),
          expiresAt: new Date(decision.displayLease.expiresAtMs).toISOString(),
          signatureBase64Url: decision.displayLease.signatureBase64Url,
        }
      : null,
    voucherToken: decision.voucherToken,
    sealedProvisionalVisitorTicket: decision.sealedProvisionalVisitorTicket
      ? {
          ticketId: decision.sealedProvisionalVisitorTicket.ticketId,
          sealedCiphertextBase64Url:
            decision.sealedProvisionalVisitorTicket.sealedCiphertextBase64Url,
          singleUse: decision.sealedProvisionalVisitorTicket.singleUse,
          expiresAt: new Date(
            decision.sealedProvisionalVisitorTicket.expiresAtMs
          ).toISOString(),
        }
      : null,
    allocation: decision.allocation
      ? {
          consentTier: decision.allocation.consent_tier,
          canaryArm: decision.allocation.canary_arm,
          measurementArm: decision.allocation.measurement_arm,
          deliveryPermitted: decision.allocation.delivery_permitted,
          unitIdHash:
            decision.allocation.decisions.length > 0
              ? sha256Hex(decision.allocation.decisions[0].unit_id).slice(0, 16)
              : null,
          layerAssignments: Object.fromEntries(
            decision.allocation.decisions.map((d) => [d.layer_id, d.arm_id])
          ),
        }
      : null,
    killedCampaignIds: decision.killedCampaignIds,
    reason: decision.reason,
  };
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
      {
        error: {
          code: 'SECRET_KEY_REQUIRED',
          message: 'POST /v1/decisions requires a valid ugk_sec_* key',
        },
      },
      { status: 401, headers }
    );
  }

  let ctx: SurfaceRuntimeContext;
  try {
    ctx = getSurfaceRuntimeContext();
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: 'UGOKILINK_KEY_PEPPER_UNCONFIGURED',
          message: err instanceof Error ? err.message : 'Runtime key pepper unconfigured',
        },
      },
      { status: 503, headers }
    );
  }

  const workerResolved = resolveDecisionWorkerForContext(ctx);
  if (!workerResolved.ok) {
    return NextResponse.json(
      { error: { code: workerResolved.code, message: workerResolved.message } },
      { status: 503, headers }
    );
  }

  const body = await readOptionalJsonBody(req);
  const siteId = typeof body.siteId === 'string' ? body.siteId : '';
  if (!siteId) {
    return NextResponse.json(
      { error: { code: 'MISSING_SITE_ID', message: 'siteId is required' } },
      { status: 400, headers }
    );
  }

  const clientIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip')?.trim() ??
    undefined;
  const senderThumbprint = req.headers.get('x-dpop-jkt')?.trim() ?? undefined;

  // [M-15]: Pass clientIp and senderThumbprint into verifySecretKey
  const verified = ctx.pipeline.keyRegistry.verifySecretKey(bearer, {
    siteId,
    clientIp,
    senderThumbprint,
    now,
  });
  if (!verified.ok) {
    return NextResponse.json(
      { error: { code: verified.code, message: verified.reason } },
      { status: verified.httpStatus, headers }
    );
  }

  // [M-15]: Enforce per-key + IP cost-unit rate limiting
  const rateKey = `decisions:${verified.principal.tenantId}:${verified.principal.credentialId}:${clientIp ?? 'no_ip'}`;
  const rate = ctx.pipeline.rateLimiter.consume(rateKey, 1, now);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Decision evaluation rate limit exceeded',
        },
      },
      {
        status: 429,
        headers: {
          ...headers,
          'Retry-After': String(rate.retryAfterSec),
          'X-RateLimit-Remaining': String(rate.remaining),
        },
      }
    );
  }

  const siteCfg = ctx.repository.getSiteConfig(siteId);
  const callerSuppliedTenantId =
    typeof body.tenant_id === 'string'
      ? body.tenant_id
      : typeof body.tenantId === 'string'
        ? body.tenantId
        : req.headers.get('x-tenant-id') ?? undefined;

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

  const decision = workerResolved.worker.decide({
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
    freshness: {
      data_through: nowIso,
      lag_s: 0,
      sources: { control_plane: nowIso },
      stale: decision.status !== 'ok',
    },
    coverage: {
      ratio: decision.status === 'ok' ? 1 : 0,
      denominator_n: decision.status === 'ok' ? 1 : 0,
    },
    lineage: { schema_version: '2.0', def_ver: 1, collection_gen: 'v3' },
    residency: {
      storage_region: siteCfg.storageRegion,
      processing_region: siteCfg.processingRegion,
    },
    measures: {
      decision_issued:
        decision.status === 'ok'
          ? {
              value: createDataLayerMetric(1, ref.ref_id, {
                authority: 'allocator_experiment',
                createdAt: nowIso,
              }),
              unit: 'decisions',
              status: 'ok',
              evidence: {
                level: 'observed',
                exactness: 'exact',
                criteria: [],
                refs: [ref],
                scope: `site:${siteId}`,
              },
              sample: { n: 1, unit_kind: 'decision' },
              interval: null,
            }
          : {
              value: null,
              unit: 'decisions',
              status: 'not_collected',
              reason: decision.reason,
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
                  id: 'del.D3',
                  required: 1,
                  observed: 0,
                  unlock: 'Connect strongly-consistent control store',
                },
              ],
            },
    },
    data: serializeEnvelopeSafeDecisionPayload(decision),
  });

  return NextResponse.json(envelope, {
    status: 200,
    headers: {
      ...headers,
      'X-UGOKI-Audit-Id': authz.auditEntryId,
      'X-RateLimit-Remaining': String(rate.remaining),
    },
  });
}
