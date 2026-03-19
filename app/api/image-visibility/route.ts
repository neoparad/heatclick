import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest } from '@/lib/api-utils'

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const pageUrl = searchParams.get('page_url')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const deviceType = searchParams.get('device_type')

    if (!siteId) {
      return badRequest('site_id is required')
    }

    const clickhouse = await getClickHouseClientAsync()

    // 画像ごとの集計: 平均視認時間、最大表示割合、セッション数、閲覧スコア
    let query = `
      SELECT
        image_src,
        any(image_alt) as image_alt,
        any(element_path) as element_path,
        any(image_y) as image_y,
        any(image_width) as image_width,
        any(image_height) as image_height,
        avg(visible_duration_ms) as avg_duration_ms,
        max(visible_duration_ms) as max_duration_ms,
        sum(visible_duration_ms) as total_duration_ms,
        avg(max_visible_ratio) as avg_max_ratio,
        uniq(session_id) as unique_sessions,
        count() as view_count
      FROM clickinsight.image_visibility
      WHERE site_id = {site_id:String}
    `

    const params: Record<string, any> = { site_id: siteId }

    if (pageUrl) {
      query += ` AND page_url = {page_url:String}`
      params.page_url = pageUrl
    }

    if (startDate) {
      query += ` AND created_at >= {start_date:String}`
      params.start_date = startDate
    }

    if (endDate) {
      query += ` AND created_at <= {end_date:String}`
      params.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }

    if (deviceType) {
      query += ` AND device_type = {device_type:String}`
      params.device_type = deviceType
    }

    query += `
      GROUP BY image_src
      ORDER BY avg_duration_ms DESC
      LIMIT 100
    `

    const result = await clickhouse.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })

    const rawData = await result.json() as any[]

    // 全セッション数を取得（閲覧率の分母）
    let totalSessionsQuery = `
      SELECT uniq(session_id) as total_sessions
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND (event_type = 'pageview' OR event_type = 'page_view')
    `
    const totalParams: Record<string, any> = { site_id: siteId }

    if (pageUrl) {
      totalSessionsQuery += ` AND url = {page_url:String}`
      totalParams.page_url = pageUrl
    }
    if (startDate) {
      totalSessionsQuery += ` AND timestamp >= {start_date:String}`
      totalParams.start_date = startDate
    }
    if (endDate) {
      totalSessionsQuery += ` AND timestamp <= {end_date:String}`
      totalParams.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }

    const totalResult = await clickhouse.query({
      query: totalSessionsQuery,
      query_params: totalParams,
      format: 'JSONEachRow',
    })
    const totalData = await totalResult.json() as any[]
    const totalSessions = Number(totalData[0]?.total_sessions) || 1

    // 閲覧スコアを計算: avg_duration * avg_ratio で正規化
    const maxScore = Math.max(
      ...rawData.map(d => (Number(d.avg_duration_ms) || 0) * (Number(d.avg_max_ratio) || 0)),
      1
    )

    const data = rawData.map(item => {
      const avgDuration = Number(item.avg_duration_ms) || 0
      const avgRatio = Number(item.avg_max_ratio) || 0
      const rawScore = avgDuration * avgRatio
      const uniqueSessions = Number(item.unique_sessions) || 0
      const viewRate = totalSessions > 0 ? (uniqueSessions / totalSessions) * 100 : 0

      return {
        image_src: item.image_src,
        image_alt: item.image_alt || '',
        element_path: item.element_path || '',
        image_y: Number(item.image_y) || 0,
        image_width: Number(item.image_width) || 0,
        image_height: Number(item.image_height) || 0,
        avg_duration_ms: Math.round(avgDuration),
        max_duration_ms: Number(item.max_duration_ms) || 0,
        total_duration_ms: Number(item.total_duration_ms) || 0,
        avg_max_ratio: Math.round(avgRatio * 100) / 100,
        unique_sessions: uniqueSessions,
        view_count: Number(item.view_count) || 0,
        view_rate: Math.round(viewRate * 10) / 10,
        // 0-100のスコア
        visibility_score: Math.round((rawScore / maxScore) * 100),
      }
    })

    return NextResponse.json({
      success: true,
      data,
      total_sessions: totalSessions,
      image_count: data.length,
    })
  } catch (error: any) {
    console.error('Error in image-visibility API:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error?.message },
      { status: 500 }
    )
  }
}
