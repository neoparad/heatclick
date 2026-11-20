import { NextRequest } from 'next/server';
import { handleV1RestRoute } from '@/lib/link/surface';

export async function GET(
  req: NextRequest,
  context: { params: { siteId: string } }
) {
  return handleV1RestRoute({
    req,
    operationId: 'queryJourneys',
    siteId: context.params.siteId,
  });
}
