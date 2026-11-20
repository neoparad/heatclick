import { NextRequest, NextResponse } from 'next/server';
import { getSurfaceRuntimeContext, handleMcpPostRoute } from '@/lib/link/surface';

export async function GET() {
  const { mcpServer } = getSurfaceRuntimeContext();
  return NextResponse.json(
    mcpServer.listVisibleTools({ clientFamily: 'generic_mcp' }),
    { status: 200 }
  );
}

export async function POST(req: NextRequest) {
  return handleMcpPostRoute(req);
}
