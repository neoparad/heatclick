import { NextResponse } from 'next/server'

import { getClickHouseClient } from '@/lib/clickhouse'
import { getCloudflareBRConfig, getScreenshotWorkerConfig } from '@/lib/heatmap/screenshot-provider'

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
    const ch = getClickHouseClient('analytics_reader')
    const rs = await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    await rs.json()
    clickhouse = 'healthy'
  } catch {
    clickhouse = 'unhealthy'
  }

  // screenshot 経路の設定有無 (boolean のみ、secret は返さない)。
  // Worker env 欠落 → 全 capture が microlink 劣化 (lazy 画像空白/上部のみ) に落ちるのに
  // 気づけない事故が過去に起きたため、期待 provider をここで可視化する。
  const workerConfigured = getScreenshotWorkerConfig() != null
  const cloudflareBRConfigured = getCloudflareBRConfig() != null
  const expectedScreenshotProvider = workerConfigured
    ? 'worker'
    : cloudflareBRConfigured
      ? 'cloudflare-rest'
      : 'microlink-fallback'

  const overall = clickhouse === 'healthy' ? 'healthy' : 'degraded'
  return NextResponse.json({
    status: overall === 'healthy' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME ?? 'api',
    health: {
      clickhouse,
      overall,
      screenshot: {
        workerConfigured,
        cloudflareBRConfigured,
        expectedProvider: expectedScreenshotProvider,
      },
    },
  })
}
