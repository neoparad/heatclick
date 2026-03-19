import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, verifySiteAccess } from '@/lib/api-utils'

// GET /api/v1/insights/{site_id} — サイトサマリー
export async function GET(
  request: NextRequest,
  { params }: { params: { site_id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  const siteId = params.site_id
  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')

  try {
    const ch = await getClickHouseClientAsync()
    const { authorized } = await verifySiteAccess(request, siteId, ch)
    if (!authorized) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

    const queryParams: Record<string, string> = { site_id: siteId }
    let dateFilter = ''
    if (startDate) { dateFilter += ` AND timestamp >= {start_date:String}`; queryParams.start_date = startDate }
    if (endDate) { dateFilter += ` AND timestamp <= {end_date:String}`; queryParams.end_date = endDate }

    const result = await ch.query({
      query: `
        SELECT
          uniq(session_id) as total_sessions,
          count() as total_events,
          countIf(event_type IN ('pageview','page_view')) as page_views,
          countIf(conversion_type IS NOT NULL) as conversions,
          countIf(conversion_type IS NOT NULL) / greatest(uniq(session_id), 1) * 100 as cvr,
          avg(scroll_percentage) as avg_scroll_depth,
          countIf(event_type = 'rage_click') as rage_clicks,
          countIf(event_type = 'dead_click') as dead_clicks,
          sum(conversion_value) as total_revenue
        FROM clickinsight.events
        WHERE site_id = {site_id:String} ${dateFilter}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    })

    const data = await result.json() as any[]
    return NextResponse.json({
      site_id: siteId,
      period: { start: startDate, end: endDate },
      summary: data[0] || {},
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Internal error' }, { status: 500 })
  }
}
