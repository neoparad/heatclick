import { NextRequest } from 'next/server';
import { handleV1RestRoute } from '@/lib/link/surface';

export async function POST(
  req: NextRequest,
  context: { params: { siteId: string } }
) {
  return handleV1RestRoute({
    req,
    operationId: 'compareSegments',
    siteId: context.params.siteId,
    parseBody: true,
  });
}
