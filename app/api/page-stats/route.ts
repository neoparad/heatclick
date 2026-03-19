import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

/**
 * ページ単位の統計API
 * PV、滞在時間、離脱率、スクロール深度、画像可視率を返す
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const pageUrl = searchParams.get('page_url')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')

    if (!siteId || !pageUrl) {
      return NextResponse.json(
        { error: 'site_id and page_url are required' },
        { status: 400 }
      )
    }

    const client = await getClickHouseClientAsync()
    const params: Record<string, any> = { site_id: siteId, page_url: pageUrl }
    let dateFilter = ''

    if (startDate) {
      dateFilter += ' AND timestamp >= {start_date:String}'
      params.start_date = startDate
    }
    if (endDate) {
      dateFilter += ' AND timestamp <= {end_date:String}'
      // 日付のみの場合 '2026-03-16' → '2026-03-16 23:59:59' に補完（当日データを含める）
      params.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }

    // 1. PV + ユニークセッション + 平均スクロール深度
    const basicQuery = `
      SELECT
        countIf(event_type = 'pageview' OR event_type = 'page_view') as page_views,
        uniq(session_id) as unique_sessions,
        avgIf(scroll_percentage, event_type = 'scroll_depth' AND scroll_percentage > 0) as avg_scroll_depth
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND url = {page_url:String}
        ${dateFilter}
    `

    // 2. 滞在時間と離脱率（このページを訪問したセッション単位）
    const sessionQuery = `
      SELECT
        count() as total_sessions,
        avg(duration_sec) as avg_duration_seconds,
        countIf(page_count <= 1) as bounce_sessions
      FROM (
        SELECT
          session_id,
          dateDiff('second', min(timestamp), max(timestamp)) as duration_sec,
          uniq(url) as page_count
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
          AND session_id IN (
            SELECT DISTINCT session_id
            FROM clickinsight.events
            WHERE site_id = {site_id:String}
              AND url = {page_url:String}
              AND (event_type = 'pageview' OR event_type = 'page_view')
              ${dateFilter}
          )
          ${dateFilter}
        GROUP BY session_id
      )
    `

    // 3. 画像可視率
    let imgDateFilter = ''
    const imgParams: Record<string, any> = { site_id: siteId, page_url: pageUrl }
    if (startDate) {
      imgDateFilter += ' AND created_at >= {start_date:String}'
      imgParams.start_date = startDate
    }
    if (endDate) {
      imgDateFilter += ' AND created_at <= {end_date:String}'
      imgParams.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }

    const imageQuery = `
      SELECT
        count() as image_count,
        avg(max_visible_ratio) as avg_visible_ratio
      FROM (
        SELECT
          image_src,
          avg(max_visible_ratio) as max_visible_ratio
        FROM clickinsight.image_visibility
        WHERE site_id = {site_id:String}
          AND page_url = {page_url:String}
          ${imgDateFilter}
        GROUP BY image_src
      )
    `

    // 並列実行
    const [basicResult, sessionResult, imageResult] = await Promise.all([
      client.query({ query: basicQuery, query_params: params, format: 'JSONEachRow' }),
      client.query({ query: sessionQuery, query_params: params, format: 'JSONEachRow' }),
      client.query({ query: imageQuery, query_params: imgParams, format: 'JSONEachRow' }).catch(() => null),
    ])

    const basicData = (await basicResult.json() as any[])[0] || {}
    const sessionData = (await sessionResult.json() as any[])[0] || {}
    const imageData = imageResult ? ((await imageResult.json() as any[])[0] || {}) : {}

    const totalSessions = Number(sessionData.total_sessions) || 0
    const bounceSessions = Number(sessionData.bounce_sessions) || 0
    const avgDurationSec = Number(sessionData.avg_duration_seconds) || 0

    return NextResponse.json({
      success: true,
      data: {
        page_views: Number(basicData.page_views) || 0,
        unique_sessions: Number(basicData.unique_sessions) || 0,
        avg_time_on_page: totalSessions > 0 ? Math.round(avgDurationSec) : 0, // 秒
        bounce_rate: totalSessions > 0
          ? Math.round((bounceSessions / totalSessions) * 1000) / 10
          : 0,
        avg_scroll_depth: Math.round(Number(basicData.avg_scroll_depth) || 0),
        avg_image_visibility: Math.round((Number(imageData.avg_visible_ratio) || 0) * 100),
        image_count: Number(imageData.image_count) || 0,
      },
    })
  } catch (error: any) {
    console.error('Error in page-stats API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
