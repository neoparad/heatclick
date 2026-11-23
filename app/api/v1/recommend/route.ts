import { NextRequest, NextResponse } from 'next/server';
import {
  KeyPepperUnconfiguredError,
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

  try {
    const result = executeRecommendRequest({
      channel: 'rest',
      bearerToken: extractBearerToken(req),
      clientIp:
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip')?.trim() ??
        undefined,
      dpopProof: req.headers.get('dpop')?.trim() ?? undefined,
      httpMethod: req.method,
      httpUri: req.nextUrl ? `${req.nextUrl.origin}${req.nextUrl.pathname}` : undefined,
      requestedRevision: req.headers.get('x-ugoki-revision'),
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
  } catch (err) {
    if (err instanceof KeyPepperUnconfiguredError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.httpStatus, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    throw err;
  }
}
