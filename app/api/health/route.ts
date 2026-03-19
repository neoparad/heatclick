import { NextResponse } from 'next/server'
import { isClickHouseConnected } from '@/lib/clickhouse'

export async function GET() {
  const isConnected = await isClickHouseConnected()

  return NextResponse.json({
    status: isConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'UGOKI MAP API',
    health: {
      clickhouse: isConnected ? 'healthy' : 'unhealthy',
      overall: isConnected ? 'healthy' : 'degraded',
    },
  })
}
