import { NextRequest } from 'next/server';
import { handleV1RestRoute } from '@/lib/link/surface';

export async function POST(req: NextRequest) {
  return handleV1RestRoute({
    req,
    operationId: 'askNaturalLanguage',
    parseBody: true,
  });
}
