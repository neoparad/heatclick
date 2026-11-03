import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import type { UrlStat } from '@/lib/aiseo/risk'
import { getClickHouseClient } from '@/lib/clickhouse'
import {
  buildFusionDatasetForUrl,
  diagnoseBehaviorAndStructure,
} from '@/lib/fusion/behavior-structure'

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
  const tenantId = ctx.tenant_id

  const sp = req.nextUrl.searchParams
  const rawUrl =
    sp.get('url') || 'https://link-th.com/entry/internal-link-optimization'
  const days = Math.min(90, Math.max(7, Number(sp.get('days') || 30)))

  const baseDataset = buildFusionDatasetForUrl(rawUrl, site.siteId)
  const sources: Record<string, string> = {
    behavior: 'demo-calibrated',
    structure: 'demo-calibrated',
    seo: 'demo-calibrated',
    ai: 'demo-calibrated',
  }

  // 1. Optional live ClickHouse enrichment (human behavior & structure tables)
  if (process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_PASSWORD && sp.get('mock') !== '1') {
    try {
      const ch = getClickHouseClient('analytics_reader')
      const res = await ch.query({
        query: `
          SELECT
            countDistinct(session_id) AS sessions,
            countIf(event_type = 'pageview') AS pageviews,
            countIf(event_type = 'click') AS clicks,
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
          url: baseDataset.canonicalUrl,
          days,
        },
        format: 'JSONEachRow',
      })
      const rows = await res.json<{
        sessions: number
        pageviews: number
        clicks: number
        dead_clicks: number
        rage_clicks: number
        avg_scroll: number
      }>()
      const row = rows[0]
      if (row && Number(row.sessions) > 0) {
        baseDataset.behavior.sessions = Number(row.sessions)
        baseDataset.behavior.pageviews = Number(row.pageviews) || Number(row.sessions)
        baseDataset.behavior.totalClicks = Number(row.clicks)
        baseDataset.behavior.deadClicks = Number(row.dead_clicks)
        baseDataset.behavior.rageClicks = Number(row.rage_clicks)
        if (Number(row.avg_scroll) > 0) {
          baseDataset.behavior.avgScrollDepthPct = Math.round(Number(row.avg_scroll))
        }
        sources.behavior = 'clickhouse'
      }
    } catch {
      // Keep calibrated fallback dataset when ClickHouse is unreachable in local/dev
    }
  }

  // 2. Optional live AIreceipt collector enrichment
  const collectorOpts = {
    siteId: site.aireceiptSiteId ?? site.siteId,
    installId: site.aireceiptInstallId ?? undefined,
  }
  if (collectorConfigured(collectorOpts) && sp.get('mock') !== '1') {
    try {
      const { q } = rangeQuery(days)
      const aiRes = await collectorGet<{ urls: UrlStat[] }>(
        '/v0/analytics/urls',
        q,
        collectorOpts
      )
      if (aiRes && Array.isArray(aiRes.urls)) {
        const match = aiRes.urls.find(
          (u) =>
            u.url &&
            (u.url.includes(baseDataset.urlMatchKey) ||
              baseDataset.canonicalUrl.endsWith(u.url))
        )
        if (match && Number(match.hits) > 0) {
          baseDataset.ai.totalVisits = Number(match.hits)
          sources.ai = 'aireceipt-collector'
        }
      }
    } catch {
      // Keep calibrated fallback dataset
    }
  }

  const diagnoses = diagnoseBehaviorAndStructure(baseDataset)

  return NextResponse.json({
    ok: true,
    tenantId,
    site: {
      siteId: site.siteId,
      canonicalHost: site.canonicalHost,
      gscProperty: site.gscProperty,
      linkscrawlJobId: site.linkscrawlJobId,
      aireceiptSiteId: site.aireceiptSiteId,
    },
    days,
    sources,
    ...baseDataset,
    diagnoses,
  })
}
