import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const pageUrl = searchParams.get('page_url')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')

    if (!siteId) {
      return badRequest('site_id is required')
    }

    const clickhouse = await getClickHouseClientAsync()

    const { authorized } = await verifySiteAccess(request, siteId, clickhouse)
    if (!authorized) return forbidden('Access denied to this site')

    const params: Record<string, string> = { site_id: siteId }
    let dateFilter = ''
    if (startDate) {
      dateFilter += ' AND created_at >= {start_date:String}'
      params.start_date = startDate
    }
    if (endDate) {
      dateFilter += ' AND created_at <= {end_date:String}'
      params.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }
    let pageFilter = ''
    if (pageUrl) {
      pageFilter = ' AND page_url = {page_url:String}'
      params.page_url = pageUrl
    }

    const result = await clickhouse.query({
      query: `
        SELECT
          element_selector,
          any(element_tag) as element_tag,
          any(element_text) as element_text,
          any(page_url) as page_url,
          avg(element_y) as avg_y,
          avg(visible_duration_ms) as avg_visible_ms,
          avg(max_visible_ratio) as avg_visible_ratio,
          count() as impressions,
          uniq(session_id) as unique_sessions,
          countIf(element_clicked = 1) as clicks,
          uniqIf(session_id, element_clicked = 1) as click_sessions
        FROM clickinsight.element_visibility
        WHERE site_id = {site_id:String}
          ${dateFilter}
          ${pageFilter}
        GROUP BY element_selector
        ORDER BY impressions DESC
        LIMIT 100
      `,
      query_params: params,
      format: 'JSONEachRow',
    })

    const rawData = await result.json() as Record<string, string | number>[]

    const elements = rawData.map(item => {
      const impressions = Number(item.impressions) || 0
      const clicks = Number(item.clicks) || 0
      const uniqueSessions = Number(item.unique_sessions) || 0
      const clickSessions = Number(item.click_sessions) || 0

      return {
        element_selector: item.element_selector,
        element_tag: item.element_tag || '',
        element_text: String(item.element_text || '').substring(0, 60),
        page_url: item.page_url || '',
        avg_y: Math.round(Number(item.avg_y) || 0),
        avg_visible_ms: Math.round(Number(item.avg_visible_ms) || 0),
        avg_visible_ratio: Math.round((Number(item.avg_visible_ratio) || 0) * 100),
        impressions,
        unique_sessions: uniqueSessions,
        clicks,
        click_rate: uniqueSessions > 0 ? Math.round((clickSessions / uniqueSessions) * 1000) / 10 : 0,
        visibility_to_click: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
      }
    })

    const totalElements = elements.length
    const avgClickRate = elements.length > 0
      ? Math.round(elements.reduce((s, e) => s + e.click_rate, 0) / elements.length * 10) / 10
      : 0
    const avgVisibleMs = elements.length > 0
      ? Math.round(elements.reduce((s, e) => s + e.avg_visible_ms, 0) / elements.length)
      : 0
    const worstCta = elements.length > 0
      ? elements.reduce((worst, e) => (e.impressions > 10 && e.click_rate < (worst?.click_rate ?? 100)) ? e : worst, elements[0])
      : null

    return NextResponse.json({
      success: true,
      data: {
        elements,
        summary: {
          total_elements: totalElements,
          avg_click_rate: avgClickRate,
          avg_visible_ms: avgVisibleMs,
          worst_cta: worstCta?.element_text || worstCta?.element_selector || null,
        },
      },
    })
  } catch (error: any) {
    console.error('Error in element-analysis API:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error?.message },
      { status: 500 }
    )
  }
}
