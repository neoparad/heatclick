import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { dateStr, isGscConfigured, querySearchAnalytics, type GscRow } from '@/lib/seo/gsc'
import { generateSeoAccessMock } from '@/lib/seo/mock'

export const dynamic = 'force-dynamic'

function delta(cur: number, prev: number): number | null {
  if (!prev) return cur > 0 ? 1 : 0
  return +((cur - prev) / prev).toFixed(4)
}

function sumTotals(rows: GscRow[]) {
  let clicks = 0
  let impressions = 0
  let posWeighted = 0
  for (const r of rows) {
    clicks += r.clicks || 0
    impressions += r.impressions || 0
    posWeighted += (r.position || 0) * (r.impressions || 0)
  }
  const ctr = impressions ? +(clicks / impressions).toFixed(4) : 0
  const position = impressions ? +(posWeighted / impressions).toFixed(2) : 0
  return { clicks, impressions, ctr, position }
}

export async function GET(req: NextRequest) {
  const ctx = await requireActiveTenantSite(req)
  if (!ctx.ok) return ctx.response
  const { site } = ctx

  const sp = req.nextUrl.searchParams
  const days = Math.min(90, Math.max(7, Number(sp.get('days') || 28)))
  const gscSite = site.gscProperty || process.env.GSC_SITE_URL || `sc-domain:${site.canonicalHost}`

  if (!isGscConfigured() || sp.get('mock') === '1') {
    return NextResponse.json(generateSeoAccessMock(days, gscSite))
  }

  // GSC data has ~2-3 day lag; shift window back 3 days.
  const endDate = dateStr(3)
  const startDate = dateStr(3 + days - 1)
  const prevEnd = dateStr(3 + days)
  const prevStart = dateStr(3 + days * 2 - 1)

  try {
    const [dailyRows, prevDailyRows, queryRows, prevQueryRows, pageRows, prevPageRows, pairRows, deviceRows] =
      await Promise.all([
        querySearchAnalytics(gscSite, { startDate, endDate, dimensions: ['date'], rowLimit: 500 }),
        querySearchAnalytics(gscSite, { startDate: prevStart, endDate: prevEnd, dimensions: ['date'], rowLimit: 500 }),
        querySearchAnalytics(gscSite, { startDate, endDate, dimensions: ['query'], rowLimit: 100 }),
        querySearchAnalytics(gscSite, { startDate: prevStart, endDate: prevEnd, dimensions: ['query'], rowLimit: 200 }),
        querySearchAnalytics(gscSite, { startDate, endDate, dimensions: ['page'], rowLimit: 100 }),
        querySearchAnalytics(gscSite, { startDate: prevStart, endDate: prevEnd, dimensions: ['page'], rowLimit: 200 }),
        querySearchAnalytics(gscSite, { startDate, endDate, dimensions: ['page', 'query'], rowLimit: 1000 }),
        querySearchAnalytics(gscSite, { startDate, endDate, dimensions: ['device'], rowLimit: 10 }),
      ])

    const cur = sumTotals(dailyRows)
    const prev = sumTotals(prevDailyRows)

    const prevQ = new Map(prevQueryRows.map((r) => [r.keys?.[0] || '', r]))
    const queries = queryRows.map((r) => {
      const q = r.keys?.[0] || ''
      const p = prevQ.get(q)
      return {
        query: q,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: +r.ctr.toFixed(4),
        position: +r.position.toFixed(2),
        clicksDelta: p ? delta(r.clicks, p.clicks) : null,
        impressionsDelta: p ? delta(r.impressions, p.impressions) : null,
        positionDelta: p ? +(r.position - p.position).toFixed(2) : null,
      }
    })

    const queriesByPage = new Map<string, Array<{ query: string; clicks: number; impressions: number; position: number }>>()
    const pairs: Array<{
      page: string
      query: string
      clicks: number
      impressions: number
      ctr: number
      position: number
    }> = []
    for (const r of pairRows) {
      const [page, query] = r.keys || ['', '']
      const list = queriesByPage.get(page) || []
      list.push({
        query,
        clicks: r.clicks,
        impressions: r.impressions,
        position: +r.position.toFixed(1),
      })
      queriesByPage.set(page, list)
      pairs.push({
        page,
        query,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: +r.ctr.toFixed(4),
        position: +r.position.toFixed(2),
      })
    }

    const prevP = new Map(prevPageRows.map((r) => [r.keys?.[0] || '', r]))
    const pages = pageRows.map((r) => {
      const page = r.keys?.[0] || ''
      const p = prevP.get(page)
      const qList = queriesByPage.get(page) || []
      return {
        page,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: +r.ctr.toFixed(4),
        position: +r.position.toFixed(2),
        clicksDelta: p ? delta(r.clicks, p.clicks) : null,
        impressionsDelta: p ? delta(r.impressions, p.impressions) : null,
        positionDelta: p ? +(r.position - p.position).toFixed(2) : null,
        queryCount: qList.length,
        topQueries: qList.slice(0, 5),
      }
    })

    const daily = dailyRows.map((r) => ({
      date: r.keys?.[0] || '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: +r.ctr.toFixed(4),
      position: +r.position.toFixed(2),
    }))

    const devices = deviceRows.map((r) => ({
      device: r.keys?.[0] || '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: +r.ctr.toFixed(4),
      position: +r.position.toFixed(2),
    }))

    return NextResponse.json({
      source: 'gsc',
      site: gscSite,
      range: { startDate, endDate, days },
      totals: {
        ...cur,
        clicksDelta: delta(cur.clicks, prev.clicks),
        impressionsDelta: delta(cur.impressions, prev.impressions),
        ctrDelta: delta(cur.ctr, prev.ctr),
        positionDelta: +(cur.position - prev.position).toFixed(2),
      },
      daily,
      queries,
      pages,
      pairs,
      devices,
    })
  } catch (err) {
    const fallback = generateSeoAccessMock(days, gscSite)
    return NextResponse.json({
      ...fallback,
      source: 'mock-fallback',
      error: (err as Error)?.message || String(err),
    })
  }
}
