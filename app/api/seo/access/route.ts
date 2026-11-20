/**
 * GET /api/seo/access — Google Search Console Search Analytics
 *
 * Wave 0 (束 0-A 止血):
 *   - GSC 未設定・エラー時のモック返却 (`generateSeoAccessMock`) および `?mock=1` バイパスを完全廃止。
 *   - 未設定・取得失敗時は `status: 'not_collected'`, `source: 'not_collected'` + 空データを返す。
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { dateStr, isGscConfigured, querySearchAnalytics, type GscRow } from '@/lib/seo/gsc'

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

function buildNotCollectedSeoAccess(
  gscSite: string,
  startDate: string,
  endDate: string,
  days: number,
  reason: string,
) {
  return {
    status: 'not_collected' as const,
    reason,
    source: 'not_collected' as const,
    site: gscSite,
    range: { startDate, endDate, days },
    totals: {
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
      clicksDelta: null,
      impressionsDelta: null,
      ctrDelta: null,
      positionDelta: null,
    },
    daily: [],
    queries: [],
    pages: [],
    pairs: [],
    devices: [],
  }
}

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(req)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { site } = active

  const sp = req.nextUrl.searchParams
  const days = Math.min(90, Math.max(7, Number(sp.get('days') || 28)))
  const gscSite =
    site.gscProperty ||
    process.env.GSC_SITE_URL ||
    `sc-domain:${site.canonicalHost || 'link-th.com'}`

  // GSC data has ~2-3 day lag; shift window back 3 days.
  const endDate = dateStr(3)
  const startDate = dateStr(3 + days - 1)
  const prevEnd = dateStr(3 + days)
  const prevStart = dateStr(3 + days * 2 - 1)

  if (!isGscConfigured()) {
    return NextResponse.json(
      buildNotCollectedSeoAccess(
        gscSite,
        startDate,
        endDate,
        days,
        'Google Search Console 認証情報が未設定のため検索データは未収集です (not_collected)',
      ),
    )
  }

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
      status: 'ok',
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
    const errMsg = (err as Error)?.message || String(err)
    return NextResponse.json({
      ...buildNotCollectedSeoAccess(
        gscSite,
        startDate,
        endDate,
        days,
        `GSC Search Analytics 取得失敗のため未収集です (not_collected): ${errMsg}`,
      ),
      error: errMsg,
    })
  }
}
