import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

// クエリごとのヒートマップデータ取得
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('siteId')
    const query = searchParams.get('query')
    const pageUrl = searchParams.get('pageUrl')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (!siteId) {
      return NextResponse.json({ error: 'siteId is required' }, { status: 400 })
    }

    const clickhouse = await getClickHouseClientAsync()

    // クエリが指定されている場合、GSCデータとイベントデータを結合
    if (query) {
      // GSCデータから該当クエリのページを取得
      const gscResult = await clickhouse.query({
        query: `
          SELECT DISTINCT page
          FROM clickinsight.gsc_data
          WHERE site_id = {site_id:String}
            AND query = {query:String}
            ${startDate ? 'AND date >= {start_date:String}' : ''}
            ${endDate ? 'AND date <= {end_date:String}' : ''}
        `,
        query_params: {
          site_id: siteId,
          query: query,
          ...(startDate && { start_date: startDate }),
          ...(endDate && { end_date: endDate }),
        },
        format: 'JSONEachRow',
      })

      const gscPages = await gscResult.json()
      const pages = gscPages.map((p: any) => p.page)

      if (pages.length === 0) {
        return NextResponse.json({ data: [], query, message: 'No pages found for this query' })
      }

      // 該当ページのイベントデータを取得
      let eventsQuery = `
        SELECT 
          click_x,
          click_y,
          count() as click_count,
          url,
          search_query
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
          AND event_type = 'click'
          AND url IN ({pages:Array(String)})
      `

      const eventsParams: Record<string, any> = {
        site_id: siteId,
        pages: pages,
      }

      if (startDate) {
        eventsQuery += ` AND timestamp >= {start_date:String}`
        eventsParams.start_date = startDate
      }

      if (endDate) {
        eventsQuery += ` AND timestamp <= {end_date:String}`
        eventsParams.end_date = endDate
      }

      eventsQuery += `
        GROUP BY click_x, click_y, url, search_query
        ORDER BY click_count DESC
      `

      const eventsResult = await clickhouse.query({
        query: eventsQuery,
        query_params: eventsParams,
        format: 'JSONEachRow',
      })

      const events = await eventsResult.json()

      // GSCデータも取得（CTR、順位など）
      const gscDataResult = await clickhouse.query({
        query: `
          SELECT 
            query,
            page,
            sum(clicks) as total_clicks,
            sum(impressions) as total_impressions,
            avg(ctr) as avg_ctr,
            avg(position) as avg_position
          FROM clickinsight.gsc_data
          WHERE site_id = {site_id:String}
            AND query = {query:String}
            ${startDate ? 'AND date >= {start_date:String}' : ''}
            ${endDate ? 'AND date <= {end_date:String}' : ''}
          GROUP BY query, page
        `,
        query_params: {
          site_id: siteId,
          query: query,
          ...(startDate && { start_date: startDate }),
          ...(endDate && { end_date: endDate }),
        },
        format: 'JSONEachRow',
      })

      const gscData = await gscDataResult.json()

      return NextResponse.json({
        success: true,
        query,
        heatmapData: events,
        gscData: gscData[0] || null,
        pages,
      })
    }

    // クエリが指定されていない場合、通常のヒートマップデータを返す
    let heatmapQuery = `
      SELECT 
        click_x,
        click_y,
        count() as click_count
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND event_type = 'click'
    `

    const heatmapParams: Record<string, any> = { site_id: siteId }

    if (pageUrl) {
      heatmapQuery += ` AND url = {page_url:String}`
      heatmapParams.page_url = pageUrl
    }

    if (startDate) {
      heatmapQuery += ` AND timestamp >= {start_date:String}`
      heatmapParams.start_date = startDate
    }

    if (endDate) {
      heatmapQuery += ` AND timestamp <= {end_date:String}`
      heatmapParams.end_date = endDate
    }

    heatmapQuery += `
      GROUP BY click_x, click_y
      ORDER BY click_count DESC
    `

    const result = await clickhouse.query({
      query: heatmapQuery,
      query_params: heatmapParams,
      format: 'JSONEachRow',
    })

    const data = await result.json()

    return NextResponse.json({
      success: true,
      data,
    })
  } catch (error: any) {
    console.error('Error fetching query heatmap data:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch heatmap data' },
      { status: 500 }
    )
  }
}









