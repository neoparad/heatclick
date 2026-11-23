/**
 * UGOKI LINK v2 — Next.js App Router HTTP Adapter for `/api/v1/**`
 *
 * Centralizes extraction of Bearer token, Idempotency-Key, API revision header,
 * query params, JSON body, and caller-supplied `tenant_id` probe detection,
 * delegating every request through the single `SurfacePipeline` and `LinkMcpServer`.
 *
 * Security invariants (`[C-01]` & `[C-02]`):
 *   - Fails closed with HTTP 503 (`UGOKILINK_KEY_PEPPER_UNCONFIGURED`) in `NODE_ENV === 'production'`
 *     when `UGOKILINK_KEY_PEPPER` is unset; uses a per-process CSPRNG `randomBytes(32)` secret in
 *     non-production (zero static fallback strings!).
 *   - Enforces Bearer token authentication + tenant-scoped session isolation on ALL `/api/v1/mcp`
 *     GET & POST methods (`tools/list`, `tools/search`, `tools/enable`, `tools/call`).
 */

import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { IdentityKeyRegistry } from '@/lib/link/auth';
import { AskService, type AskDataExecutor } from '@/lib/link/ask';
import type { HeatmapRenderRequest, HeatmapRenderService } from '@/lib/link/heatmap-render';
import { LinkMcpServer } from './mcp';
import {
  EmptyUnconnectedRepository,
  SurfacePipeline,
  type SurfaceExecutionResult,
} from './pipeline';

export class KeyPepperUnconfiguredError extends Error {
  public readonly code = 'UGOKILINK_KEY_PEPPER_UNCONFIGURED' as const;
  public readonly httpStatus = 503 as const;

  constructor(
    message = 'UGOKILINK_KEY_PEPPER must be configured in production; refusing to start with unconfigured pepper'
  ) {
    super(message);
    this.name = 'KeyPepperUnconfiguredError';
  }
}

export interface HeatmapDatasetProvider {
  loadUnitDatasets(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly pageUrl: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly kind: HeatmapRenderRequest['kind'];
    readonly actorBucket: HeatmapRenderRequest['actor_bucket'];
    readonly deviceClass?: HeatmapRenderRequest['device_class'];
    readonly segmentId?: string;
  }): HeatmapRenderRequest['unit_datasets'] | null;
}

export interface SurfaceRuntimeContext {
  readonly pipeline: SurfacePipeline;
  readonly mcpServer: LinkMcpServer;
  readonly askService: AskService;
  readonly repository: EmptyUnconnectedRepository;
  readonly heatmapService?: HeatmapRenderService;
  readonly heatmapDatasetProvider?: HeatmapDatasetProvider;
}

const UNCONNECTED_ASK_EXECUTOR: AskDataExecutor = {
  executePublicViewQuery: (params) => ({
    connected: false,
    rows: [],
    queryRefId: `unconnected_${params.viewName}`,
    paramsHash: 'unconnected',
    resultDigest: 'empty',
  }),
};

let defaultContext: SurfaceRuntimeContext | null = null;
let nonProdEphemeralPepper: string | null = null;

export function resolveRuntimePepperSecret(): string {
  const configured = process.env.UGOKILINK_KEY_PEPPER?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new KeyPepperUnconfiguredError();
  }
  if (!nonProdEphemeralPepper) {
    nonProdEphemeralPepper = randomBytes(32).toString('hex');
  }
  return nonProdEphemeralPepper;
}

/**
 * Returns the process-scoped default SurfaceRuntimeContext backed by `EmptyUnconnectedRepository`
 * (honestly returning `not_collected` when no production store is wired — zero mock data!).
 * Tests or boot code can inject a custom context via `setSurfaceRuntimeContext()`.
 */
export function getSurfaceRuntimeContext(): SurfaceRuntimeContext {
  if (!defaultContext) {
    const pepperSecret = resolveRuntimePepperSecret();
    const keyRegistry = new IdentityKeyRegistry({
      pepperVersion: 'runtime_v1',
      pepperSecret,
    });
    const repository = new EmptyUnconnectedRepository();
    const askService = new AskService({ executor: UNCONNECTED_ASK_EXECUTOR });
    const pipeline = new SurfacePipeline({
      keyRegistry,
      repository,
      askHandler: ({ principal, site, body, now }) => {
        const question = typeof body.question === 'string' ? body.question : '';
        const tenant = keyRegistry.getTenant(principal.tenantId);
        const res = askService.ask({
          principal,
          siteId: site.siteId,
          siteTenantId: site.tenantId,
          siteConsentMode: site.consentMode,
          permissionEpoch: tenant?.revocationEpoch ?? 1,
          question,
          windowStart: typeof body.windowStart === 'string' ? body.windowStart : undefined,
          windowEnd: typeof body.windowEnd === 'string' ? body.windowEnd : undefined,
          storageRegion: site.storageRegion,
          processingRegion: site.processingRegion,
          now,
        });
        if (!res.allowed || !res.envelope) {
          return {
            httpStatus: res.httpStatus,
            headers: {},
            error: { code: res.auditCode, message: 'Ask request denied' },
          };
        }
        return {
          httpStatus: res.httpStatus,
          headers: {},
          envelope: res.envelope,
        };
      },
    });
    const mcpServer = new LinkMcpServer(pipeline);
    defaultContext = { pipeline, mcpServer, askService, repository };
  }
  return defaultContext;
}

export function setSurfaceRuntimeContext(ctx: SurfaceRuntimeContext | null): void {
  defaultContext = ctx;
}

export function extractBearerToken(req: NextRequest): string | undefined {
  const auth = req.headers.get('authorization');
  if (!auth) return undefined;
  const match = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(auth.trim());
  return match ? match[1].trim() : undefined;
}

export function normalizeRequestHttpUri(req: NextRequest): string {
  const u = req.nextUrl;
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export function extractQueryParams(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function readOptionalJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function toNextResponse(result: SurfaceExecutionResult): NextResponse {
  const payload = result.envelope ?? result.rawBody ?? { error: result.error };
  return NextResponse.json(payload, {
    status: result.httpStatus,
    headers: {
      'Cache-Control': 'no-store',
      ...result.headers,
    },
  });
}

function pepperUnconfiguredResponse(err: KeyPepperUnconfiguredError): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: err.code,
        message: err.message,
      },
    },
    {
      status: err.httpStatus,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

export async function handleV1RestRoute(params: {
  readonly req: NextRequest;
  readonly operationId: string;
  readonly siteId?: string;
  readonly parseBody?: boolean;
}): Promise<NextResponse> {
  let ctx: SurfaceRuntimeContext;
  try {
    ctx = getSurfaceRuntimeContext();
  } catch (err) {
    if (err instanceof KeyPepperUnconfiguredError) {
      return pepperUnconfiguredResponse(err);
    }
    throw err;
  }

  const queryParams = extractQueryParams(params.req);
  const body = params.parseBody ? await readOptionalJsonBody(params.req) : undefined;

  const callerSuppliedTenantId =
    queryParams.tenant_id ??
    queryParams.tenantId ??
    (typeof body?.tenant_id === 'string' ? body.tenant_id : undefined) ??
    (typeof body?.tenantId === 'string' ? body.tenantId : undefined) ??
    params.req.headers.get('x-tenant-id') ??
    undefined;

  const result = ctx.pipeline.execute({
    operationId: params.operationId,
    channel: 'rest',
    bearerToken: extractBearerToken(params.req),
    clientIp:
      params.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      params.req.headers.get('x-real-ip')?.trim() ??
      undefined,
    dpopProof: params.req.headers.get('dpop') ?? undefined,
    httpMethod: params.req.method,
    httpUri: normalizeRequestHttpUri(params.req),
    callerSuppliedTenantId,
    siteId: params.siteId,
    idempotencyKey: params.req.headers.get('idempotency-key') ?? undefined,
    requestedRevision: params.req.headers.get('x-ugoki-revision'),
    params: queryParams,
    body,
    passkeyApprovalId:
      typeof body?.passkeyApprovalId === 'string' ? body.passkeyApprovalId : undefined,
    autonomyEnvelopeId:
      typeof body?.autonomyEnvelopeId === 'string' ? body.autonomyEnvelopeId : undefined,
  });

  return toNextResponse(result);
}

export async function handleMcpGetRoute(req: NextRequest): Promise<NextResponse> {
  let ctx: SurfaceRuntimeContext;
  try {
    ctx = getSurfaceRuntimeContext();
  } catch (err) {
    if (err instanceof KeyPepperUnconfiguredError) {
      return pepperUnconfiguredResponse(err);
    }
    throw err;
  }

  const queryParams = extractQueryParams(req);
  const callerSuppliedTenantId =
    queryParams.tenant_id ??
    queryParams.tenantId ??
    req.headers.get('x-tenant-id') ??
    undefined;

  const result = ctx.mcpServer.handleAuthenticatedRpc({
    method: 'tools/list',
    body: {
      clientFamily: queryParams.clientFamily ?? 'generic_mcp',
      sessionId: queryParams.sessionId,
    },
    bearerToken: extractBearerToken(req),
    dpopProof: req.headers.get('dpop') ?? undefined,
    httpMethod: req.method,
    httpUri: normalizeRequestHttpUri(req),
    clientIp:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip')?.trim() ??
      undefined,
    callerSuppliedTenantId,
  });

  return toNextResponse(result);
}

export async function handleMcpPostRoute(req: NextRequest): Promise<NextResponse> {
  let ctx: SurfaceRuntimeContext;
  try {
    ctx = getSurfaceRuntimeContext();
  } catch (err) {
    if (err instanceof KeyPepperUnconfiguredError) {
      return pepperUnconfiguredResponse(err);
    }
    throw err;
  }

  const queryParams = extractQueryParams(req);
  const body = await readOptionalJsonBody(req);
  const method = typeof body.method === 'string' ? body.method : '';

  const callerSuppliedTenantId =
    queryParams.tenant_id ??
    queryParams.tenantId ??
    (typeof body.tenant_id === 'string' ? body.tenant_id : undefined) ??
    (typeof body.tenantId === 'string' ? body.tenantId : undefined) ??
    req.headers.get('x-tenant-id') ??
    undefined;

  const result = ctx.mcpServer.handleAuthenticatedRpc({
    method,
    body,
    bearerToken: extractBearerToken(req),
    dpopProof: req.headers.get('dpop') ?? undefined,
    httpMethod: req.method,
    httpUri: normalizeRequestHttpUri(req),
    clientIp:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip')?.trim() ??
      undefined,
    callerSuppliedTenantId,
  });

  return toNextResponse(result);
}
