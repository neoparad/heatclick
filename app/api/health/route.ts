import { NextResponse } from 'next/server'

import { getClickHouseClient } from '@/lib/clickhouse'
import { getCloudflareBRConfig, getScreenshotWorkerConfig } from '@/lib/heatmap/screenshot-provider'
import {
  DEFAULT_DUMMY_FALLBACK_WINDOW_HOURS,
  getRecentDummyFallbacks,
} from '@/lib/monitoring/dummy-fallback-counter'
import { getIngestFreshnessSummary } from '@/lib/monitoring/ingest-freshness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface IngestHealthField {
  ok: boolean
  checked: boolean
  totalSites: number | null
  activeSites: number | null
  staleSites: number | null
  neverActiveSites: number | null
  thresholdHours: number | null
}

const INGEST_UNCHECKED: IngestHealthField = {
  ok: false,
  checked: false,
  totalSites: null,
  activeSites: null,
  staleSites: null,
  neverActiveSites: null,
  thresholdHours: null,
}

interface CvJourneyHealthField {
  recentDummyFallbacks: number | null
  checked: boolean
  windowHours: number
  forcedDummyMode: boolean
  ok: boolean
}

/**
 * GET /api/health — liveness + ClickHouse 疎通チェック (middleware の public route)。
 *
 * 旧 clickinsight-pro の `isClickHouseConnected()` は現行 lib/clickhouse.ts に存在しないため、
 * 現行 `getClickHouseClient()` で軽量 `SELECT 1` を実行して疎通判定する。
 * 失敗理由は client に漏らさない (status のみ)。
 *
 * 続137 P0-α1 (2026-07-12): event-ingest Worker が CH 資格情報 stale (B1 password rotation
 * に追従せず) で 10日間 401 で全 INSERT が無言で失敗し、誰も気づけなかった (静かな失敗の再発)。
 * `health.ingest` にサイト別 freshness の**集計のみ**を追加し、同種の障害を早期検知できるように
 * する。⚠ このルートは無認証公開なので site_id/tracking_id/tenant_id/個別トラフィック量は
 * 絶対に含めない (件数の集計のみ、lib/monitoring/ingest-freshness.ts 側でも同方針を徹底)。
 */
export async function GET() {
  let clickhouse: 'healthy' | 'unhealthy' = 'unhealthy'
  let ch: ReturnType<typeof getClickHouseClient> | null = null
  try {
    ch = getClickHouseClient('analytics_reader')
    const rs = await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    await rs.json()
    clickhouse = 'healthy'
  } catch {
    clickhouse = 'unhealthy'
  }

  // CH 自体が unhealthy なら freshness クエリも確実に失敗するため実行しない
  // (health check の応答遅延・タイムアウト二重待ちを避ける fail-fast)。
  let ingest: IngestHealthField = INGEST_UNCHECKED
  if (clickhouse === 'healthy' && ch) {
    try {
      const summary = await getIngestFreshnessSummary(ch)
      ingest = {
        ok: summary.ok,
        checked: true,
        totalSites: summary.totalSites,
        activeSites: summary.activeSites,
        staleSites: summary.staleSites,
        neverActiveSites: summary.neverActiveSites,
        thresholdHours: summary.thresholdHours,
      }
    } catch {
      ingest = INGEST_UNCHECKED
    }
  }

  const forcedDummyMode = process.env.CV_JOURNEY_DUMMY_ONLY === '1'
  let cvJourney: CvJourneyHealthField = {
    recentDummyFallbacks: null,
    checked: false,
    windowHours: DEFAULT_DUMMY_FALLBACK_WINDOW_HOURS,
    forcedDummyMode,
    ok: false,
  }
  try {
    const recent = await getRecentDummyFallbacks('cv-journey')
    cvJourney = {
      recentDummyFallbacks: recent.checked ? recent.count : null,
      checked: recent.checked,
      windowHours: recent.windowHours,
      forcedDummyMode,
      ok: recent.checked && recent.count === 0 && !forcedDummyMode,
    }
  } catch {
    // Health remains available even if monitoring infrastructure misbehaves.
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

  const cvJourneyDegraded =
    cvJourney.forcedDummyMode ||
    (cvJourney.checked && (cvJourney.recentDummyFallbacks ?? 0) > 0)
  const overall =
    clickhouse === 'healthy' && ingest.ok && !cvJourneyDegraded ? 'healthy' : 'degraded'
  return NextResponse.json({
    status: overall === 'healthy' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME ?? 'api',
    health: {
      clickhouse,
      ingest,
      cvJourney,
      overall,
      screenshot: {
        workerConfigured,
        cloudflareBRConfigured,
        expectedProvider: expectedScreenshotProvider,
      },
    },
  })
}
