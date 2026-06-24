import { NextResponse } from 'next/server'

/**
 * /api/track — 410 Gone stub。
 *
 * 旧 clickinsight-pro の重い ingestion 実装 (Redis buffer + Inngest flush + 直 ClickHouse insert) は
 * 撤去済み。現行のイベント受信は Cloudflare Worker (ugokimap-event-ingest) が本線
 * (public/tracking.js / v2/tracking.js / scenario-runtime.js の送信先)。
 * path 自体は旧タグ互換のため 410 で残置する (docs/infra/cross-cutting-concerns.md 方針)。
 */

export const runtime = 'nodejs'

function corsHeaders(): Record<string, string> {
  // 410 stub: 機微データを返さず credentials も使わないため wildcard が安全
  // (origin 反射は open-CORS パターンになるため避ける)。
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }
}

export function OPTIONS() {
  return new NextResponse(null, { headers: corsHeaders() })
}

export function POST() {
  return NextResponse.json(
    {
      error: 'gone',
      message:
        'This ingestion endpoint has moved to the Cloudflare Worker (ugokimap-event-ingest). Update your tracking tag.',
    },
    { status: 410, headers: corsHeaders() },
  )
}

export function GET() {
  return NextResponse.json(
    { error: 'gone', message: 'Endpoint removed. Use the current analytics APIs.' },
    { status: 410, headers: corsHeaders() },
  )
}
