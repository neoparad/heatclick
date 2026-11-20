import { NextRequest, NextResponse } from 'next/server';
import {
  extractBearerToken,
  extractQueryParams,
  readOptionalJsonBody,
} from '@/lib/link/surface';
import { executeRecommendRequest } from '@/lib/link/models/recommend-service';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const queryParams = extractQueryParams(req);
  const body = await readOptionalJsonBody(req);

  const callerSuppliedTenantId =
    queryParams.tenant_id ??
    queryParams.tenantId ??
    (typeof body.tenant_id === 'string' ? body.tenant_id : undefined) ??
    (typeof body.tenantId === 'string' ? body.tenantId : undefined) ??
    req.headers.get('x-tenant-id') ??
    undefined;

  const result = executeRecommendRequest({
    channel: 'rest',
    bearerToken: extractBearerToken(req),
    clientIp: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    dpopThumbprint: req.headers.get('x-dpop-jkt') ?? undefined,
    callerSuppliedTenantId,
    body,
  });

  const payload = result.envelope ?? { error: result.error };
  return NextResponse.json(payload, {
    status: result.httpStatus,
    headers: {
      'Cache-Control': 'no-store',
      ...result.headers,
    },
  });
}
