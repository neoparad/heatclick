import { NextResponse } from 'next/server'

import { getClickHouseClient } from '@/lib/clickhouse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/health — liveness + ClickHouse 疎通チェック (middleware の public route)。
 *
 * 旧 clickinsight-pro の `isClickHouseConnected()` は現行 lib/clickhouse.ts に存在しないため、
 * 現行 `getClickHouseClient()` で軽量 `SELECT 1` を実行して疎通判定する。
 * 失敗理由は client に漏らさない (status のみ)。
 */
export async function GET() {
  let clickhouse: 'healthy' | 'unhealthy' = 'unhealthy'
  try {
    const ch = getClickHouseClient()
    const rs = await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    await rs.json()
    clickhouse = 'healthy'
  } catch {
    clickhouse = 'unhealthy'
  }

  const overall = clickhouse === 'healthy' ? 'healthy' : 'degraded'
  return NextResponse.json({
    status: overall === 'healthy' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME ?? 'api',
    health: { clickhouse, overall },
  })
}
