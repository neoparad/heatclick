/**
 * UGOKI LINK v2 — Next.js App Router HTTP Adapter for `/api/v1/**`
 *
 * Centralizes extraction of Bearer token, Idempotency-Key, API revision header,
 * query params, JSON body, and caller-supplied `tenant_id` probe detection,
 * delegating every request through the single `SurfacePipeline` and `LinkMcpServer`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { IdentityKeyRegistry } from '@/lib/link/auth';
import { AskService, type AskDataExecutor } from '@/lib/link/ask';
import { LinkMcpServer, type McpClientFamily } from './mcp';
import {
  EmptyUnconnectedRepository,
  SurfacePipeline,
  type SurfaceExecutionResult,
} from './pipeline';

export interface SurfaceRuntimeContext {
  readonly pipeline: SurfacePipeline;
  readonly mcpServer: LinkMcpServer;
  readonly askService: AskService;
  readonly repository: EmptyUnconnectedRepository;
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

/**
 * Returns the process-scoped default SurfaceRuntimeContext backed by `EmptyUnconnectedRepository`
 * (honestly returning `not_collected` when no production store is wired — zero mock data!).
 * Tests or boot code can inject a custom context via `setSurfaceRuntimeContext()`.
 */
export function getSurfaceRuntimeContext(): SurfaceRuntimeContext {
  if (!defaultContext) {
    const keyRegistry = new IdentityKeyRegistry({
      pepperVersion: 'runtime_v1',
      pepperSecret: process.env.UGOKILINK_KEY_PEPPER ?? 'unconfigured_ephemeral_pepper_do_not_use_in_prod',
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
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1].trim() : undefined;
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

export async function handleV1RestRoute(params: {
  readonly req: NextRequest;
  readonly operationId: string;
  readonly siteId?: string;
  readonly parseBody?: boolean;
}): Promise<NextResponse> {
  const ctx = getSurfaceRuntimeContext();
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
    clientIp: params.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    dpopThumbprint: params.req.headers.get('x-dpop-jkt') ?? undefined,
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

export async function handleMcpPostRoute(req: NextRequest): Promise<NextResponse> {
  const ctx = getSurfaceRuntimeContext();
  const body = await readOptionalJsonBody(req);
  const method = typeof body.method === 'string' ? body.method : '';

  if (method === 'tools/list') {
    const rawFamily = typeof body.clientFamily === 'string' ? body.clientFamily : 'generic_mcp';
    const clientFamily: McpClientFamily =
      rawFamily === 'claude_desktop' || rawFamily === 'cursor' || rawFamily === 'chatgpt'
        ? rawFamily
        : 'generic_mcp';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const listed = ctx.mcpServer.listVisibleTools({ clientFamily, sessionId });
    return NextResponse.json(listed, { status: 200 });
  }

  if (method === 'tools/search') {
    const q = typeof body.query === 'string' ? body.query : '';
    return NextResponse.json({ tools: ctx.mcpServer.searchTools(q) }, { status: 200 });
  }

  if (method === 'tools/enable') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'default';
    const toolName = typeof body.toolName === 'string' ? body.toolName : '';
    const res = ctx.mcpServer.enableTool(sessionId, toolName);
    return NextResponse.json(res, { status: res.ok ? 200 : 404 });
  }

  if (method === 'tools/call') {
    const toolName = typeof body.toolName === 'string' ? body.toolName : '';
    const args =
      body.arguments !== null && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
    const execRes = ctx.mcpServer.callTool({
      toolName,
      arguments: args,
      bearerToken: extractBearerToken(req),
      dpopThumbprint: req.headers.get('x-dpop-jkt') ?? undefined,
      clientIp: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    });
    return toNextResponse(execRes);
  }

  return NextResponse.json(
    { error: { code: 'UNKNOWN_MCP_METHOD', message: `Unsupported MCP method "${method}"` } },
    { status: 400 }
  );
}
