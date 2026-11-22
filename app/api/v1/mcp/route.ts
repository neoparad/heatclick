import { NextRequest } from 'next/server';
import { handleMcpGetRoute, handleMcpPostRoute } from '@/lib/link/surface';

export async function GET(req: NextRequest) {
  return handleMcpGetRoute(req);
}

export async function POST(req: NextRequest) {
  return handleMcpPostRoute(req);
}
