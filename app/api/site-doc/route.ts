/**
 * GET /api/site-doc
 *
 * Returns LINKTH CRAWL v1 418-item Site Doc Audit + UGOKI MAP Behavior & ML 13-Tool Fusion:
 *   - 15 categories / 294 rules in ISSUE_TYPE_META
 *   - Page-type adaptive 16 items x 7 pillars Semantic AI Audit (`heading_decorative_abuse` 5-angle detection)
 *   - Deterministic Design Defects (10 types) & Vision Design Evaluation (8 axes)
 *   - Automated Fix Patches (`fixPatches`)
 *   - UGOKI MAP Fusion & ML 13 Tools (`urlFusionMl`: contentMap, frictionHotspots, scrollSurvival, cvrPrediction, teacherVerdict)
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { getClickHouseClient } from '@/lib/clickhouse'
import {
  getSiteDocAudit,
  getUrlFusionMl,
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
  if (
    process.env.CLICKHOUSE_URL &&
    process.env.CLICKHOUSE_PASSWORD &&
    sp.get('mock') !== '1'
  ) {
    try {
      const ch = getClickHouseClient('analytics_reader')
      const res = await ch.query({
        query: `
          SELECT
            countDistinct(session_id) AS sessions,
            countIf(event_type = 'pageview') AS pageviews,
            countIf(event_type = 'dead_click') AS dead_clicks,
            countIf(event_type = 'rage_click') AS rage_clicks,
            avgIf(scroll_percentage, scroll_percentage > 0) AS avg_scroll
          FROM clickinsight.events
          WHERE site_id = {site_id:String}
            AND url = {url:String}
            AND timestamp >= now() - INTERVAL {days:UInt32} DAY
        `,
        query_params: {
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
        avg_scroll: number
      }>()
      const row = rows[0]
      if (row && Number(row.sessions) > 0) {
        behaviorOverride = {
          sessions: Number(row.sessions),
          pageviews: Number(row.pageviews) || Number(row.sessions),
          deadClicks: Number(row.dead_clicks),
          rageClicks: Number(row.rage_clicks),
          avgScrollDepthPct:
            Number(row.avg_scroll) > 0
              ? Math.round(Number(row.avg_scroll))
              : undefined,
        }
      }
    } catch {
      // Graceful degradation to synthesized behavior baseline
    }
  }

  const [audit, urlFusionMl] = await Promise.all([
    getSiteDocAudit({
      siteId: site.siteId,
      url: canonicalUrl,
      behaviorOverride,
    }),
    getUrlFusionMl({
      siteId: site.siteId,
      url: canonicalUrl,
      behaviorOverride,
    }),
  ])

  return NextResponse.json({
    ok: true,
    tenantId: ctx.tenant_id,
    site: {
      siteId: site.siteId,
      canonicalHost: site.canonicalHost,
      linkscrawlJobId: site.linkscrawlJobId,
      gscProperty: site.gscProperty,
      aireceiptSiteId: site.aireceiptSiteId,
    },
    days,
    ...audit,
    urlFusionMl,
  })
}
