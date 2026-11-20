/**
 * GET /api/performance
 *
 * Returns LINKTH CRAWL v1 Page Speed Analysis (12 Families / 90 Speed Rules) +
 * CWV p75 (LCP / INP / CLS / TTFB) +
 * UGOKI MAP Speed x Behavior CV Loss Fusion (`linkscrawl_performance_fusion`).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { getClickHouseClient } from '@/lib/clickhouse'
import {
  getPerformanceFusion,
  type BehaviorOverrideStats,
} from '@/lib/linkscrawl/client'
import { normalizeUrlFull } from '@/lib/url/normalize-url'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(req)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { ctx, site } = active
  const sp = req.nextUrl.searchParams
  const defaultHost = site.canonicalHost || 'link-th.com'
  const rawUrl =
    sp.get('url') || `https://${defaultHost}/entry/internal-link-optimization`
  const days = Math.min(90, Math.max(7, Number(sp.get('days') || 30)))

  let canonicalUrl = rawUrl
  try {
    canonicalUrl = normalizeUrlFull(
      rawUrl.startsWith('/') ? `https://${defaultHost}${rawUrl}` : rawUrl,
    ).normalizedUrl
  } catch {
    canonicalUrl = 'https://link-th.com/entry/internal-link-optimization'
  }

  let behaviorOverride: BehaviorOverrideStats | undefined
  if (process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_PASSWORD) {
    try {
      const ch = getClickHouseClient('analytics_reader')
      const res = await ch.query({
        query: `
          SELECT
            countDistinct(session_id) AS sessions,
            countIf(event_type = 'pageview') AS pageviews,
            countIf(event_type = 'dead_click') AS dead_clicks,
            countIf(event_type = 'rage_click') AS rage_clicks
          FROM clickinsight.events
          WHERE tenant_id = {tenant_id:String}
            AND site_id = {site_id:String}
            AND url = {url:String}
            AND timestamp >= now() - INTERVAL {days:UInt32} DAY
        `,
        query_params: {
          tenant_id: ctx.tenant_id,
          site_id: site.siteId,
          url: canonicalUrl,
          days,
        },
        format: 'JSONEachRow',
      })
      const rows = await res.json<{
        sessions: number
        pageviews: number
        dead_clicks: number
        rage_clicks: number
      }>()
      const row = rows[0]
      if (row && Number(row.sessions) > 0) {
        behaviorOverride = {
          sessions: Number(row.sessions),
          pageviews: Number(row.pageviews) || Number(row.sessions),
          deadClicks: Number(row.dead_clicks),
          rageClicks: Number(row.rage_clicks),
        }
      }
    } catch {
      // Behavior plane remains not_collected (no fabricated fallback)
    }
  }

  const perfFusion = await getPerformanceFusion({
    siteId: site.siteId,
    url: canonicalUrl,
    behaviorOverride,
  })

  const status = perfFusion.status ?? (perfFusion.source === 'live' ? 'ok' : 'not_collected')

  return NextResponse.json({
    ok: true,
    status,
    reason: perfFusion.reason,
    behaviorStatus: behaviorOverride ? 'ok' : 'not_collected',
    tenantId: ctx.tenant_id,
    site: {
      siteId: site.siteId,
      canonicalHost: site.canonicalHost,
      linkscrawlJobId: site.linkscrawlJobId,
    },
    days,
    ...perfFusion,
  })
}
