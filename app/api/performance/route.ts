import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { redis as getRedisClient } from '@/lib/redis'
import { PerformanceData, PagePerformance, PageSpeedData } from '@/types/performance'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const device = searchParams.get('device') || 'mobile'

    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required parameter: site_id' },
        { status: 400 }
      )
    }

    const client = await getClickHouseClientAsync()

    // サイト情報取得（tracking_idとURLを取得）
    // eventsテーブルのsite_idにはtracking_idが保存されている
    const siteResult = await client.query({
      query: `SELECT id, url, tracking_id FROM clickinsight.sites WHERE id = {site_id:String} LIMIT 1`,
      query_params: { site_id: siteId },
      format: 'JSONEachRow',
    })
    const siteData = await siteResult.json() as any[]

    if (siteData.length === 0) {
      return NextResponse.json({
        success: true,
        data: { pages: [], summary: { avg_score: null, avg_lcp: null, problem_pages: 0, avg_cvr: 0 } },
      })
    }

    const siteUrl = siteData[0].url || ''
    const trackingId = siteData[0].tracking_id || siteId

    // まずテーブルのカラム情報を取得してconversion_typeの有無を確認
    let hasConversionType = false
    try {
      const colResult = await client.query({
        query: `SELECT name FROM system.columns WHERE database = 'clickinsight' AND table = 'events' AND name = 'conversion_type'`,
        format: 'JSONEachRow',
      })
      const cols = await colResult.json() as any[]
      hasConversionType = cols.length > 0
    } catch (e) {
      // カラム確認失敗時は無しとして扱う
    }

    // URL別セッション・スクロール集計（tracking_idで検索）
    const conversionSelect = hasConversionType
      ? `countIf(conversion_type IS NOT NULL AND conversion_type != '') as conversions,`
      : `0 as conversions,`

    let pageQuery = `
      SELECT
        url,
        uniq(session_id) as sessions,
        ${conversionSelect}
        avg(scroll_percentage) as avg_scroll_depth
      FROM clickinsight.events
      WHERE site_id = {tracking_id:String}
    `
    const pageParams: Record<string, any> = { tracking_id: trackingId }

    if (startDate) {
      pageQuery += ` AND timestamp >= {start_date:String}`
      pageParams.start_date = startDate
    }
    if (endDate) {
      pageQuery += ` AND timestamp <= {end_date:String}`
      pageParams.end_date = endDate
    }

    pageQuery += `
      GROUP BY url
      ORDER BY sessions DESC
      LIMIT 50
    `

    // レイジクリック別クエリ
    let rageQuery = `
      SELECT url, count() as rage_clicks
      FROM clickinsight.events
      WHERE site_id = {tracking_id:String}
        AND event_type = 'rage_click'
    `
    const rageParams: Record<string, any> = { tracking_id: trackingId }

    if (startDate) {
      rageQuery += ` AND timestamp >= {start_date:String}`
      rageParams.start_date = startDate
    }
    if (endDate) {
      rageQuery += ` AND timestamp <= {end_date:String}`
      rageParams.end_date = endDate
    }

    rageQuery += ` GROUP BY url`

    // 並列クエリ実行
    const [pageResult, rageResult] = await Promise.all([
      client.query({ query: pageQuery, query_params: pageParams, format: 'JSONEachRow' }),
      client.query({ query: rageQuery, query_params: rageParams, format: 'JSONEachRow' }).catch(() => null),
    ])

    const pageData = await pageResult.json() as any[]
    const rageData = rageResult ? await rageResult.json() as any[] : []

    // レイジクリックをURLでマップ化
    const rageMap: Record<string, number> = {}
    for (const row of rageData) {
      rageMap[row.url] = Number(row.rage_clicks) || 0
    }

    // 各URLのPageSpeedデータをRedisから取得
    const redisClient = getRedisClient()
    const pages: PagePerformance[] = await Promise.all(
      pageData.map(async (row: any) => {
        const url = row.url
        const sessions = Number(row.sessions) || 0
        const conversions = Number(row.conversions) || 0

        // PageSpeedキャッシュ取得
        let pagespeed: PageSpeedData | null = null
        try {
          // URLをフルURLに変換してキャッシュキーを構築
          const fullUrl = url.startsWith('http') ? url : `${siteUrl}${url}`
          const cacheKey = `pagespeed:${fullUrl}:${device}`
          const cached = await redisClient.get(cacheKey)
          if (cached) {
            pagespeed = JSON.parse(cached)
          }
        } catch (e) {
          // キャッシュ取得失敗時はnull
        }

        return {
          url,
          sessions,
          conversions,
          cvr: sessions > 0 ? (conversions / sessions) * 100 : 0,
          avg_scroll_depth: Number(row.avg_scroll_depth) || 0,
          rage_clicks: rageMap[url] || 0,
          pagespeed,
        }
      })
    )

    // サマリー計算
    const pagesWithScore = pages.filter(p => p.pagespeed !== null)
    const totalSessions = pages.reduce((sum, p) => sum + p.sessions, 0)
    const totalConversions = pages.reduce((sum, p) => sum + p.conversions, 0)

    const summary = {
      avg_score: pagesWithScore.length > 0
        ? Math.round(pagesWithScore.reduce((sum, p) => sum + (p.pagespeed?.performance_score || 0), 0) / pagesWithScore.length)
        : null,
      avg_lcp: pagesWithScore.length > 0
        ? Number((pagesWithScore.reduce((sum, p) => sum + (p.pagespeed?.lcp || 0), 0) / pagesWithScore.length).toFixed(1))
        : null,
      problem_pages: pagesWithScore.filter(p => (p.pagespeed?.performance_score || 0) < 50).length,
      avg_cvr: totalSessions > 0 ? Number(((totalConversions / totalSessions) * 100).toFixed(1)) : 0,
    }

    const data: PerformanceData = { pages, summary }

    return NextResponse.json({
      success: true,
      data,
    })
  } catch (error) {
    console.error('Error fetching performance data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
