import { NextRequest } from 'next/server';
import { handleV1RestRoute } from '@/lib/link/surface';

export async function GET(
  req: NextRequest,
  context: { params: { siteId: string } }
) {
  return handleV1RestRoute({
    req,
    operationId: 'listGoals',
    siteId: context.params.siteId,
  });
}

export async function POST(
  req: NextRequest,
  context: { params: { siteId: string } }
) {
  return handleV1RestRoute({
    req,
    operationId: 'upsertGoal',
    siteId: context.params.siteId,
    parseBody: true,
  });
}

export async function DELETE(
  req: NextRequest,
  context: { params: { siteId: string } }
) {
  return handleV1RestRoute({
    req,
    operationId: 'deleteGoal',
    siteId: context.params.siteId,
  });
}
