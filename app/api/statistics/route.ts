import { NextRequest, NextResponse } from 'next/server'
import { getStatistics } from '@/lib/clickhouse'
import { getStatisticsCache, setStatisticsCache } from '@/lib/redis'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    
    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required parameter: site_id' },
        { status: 400 }
      )
    }

    // キャッシュから取得を試みる
    let cached = false
    let statistics: any = null

    try {
      statistics = await getStatisticsCache(siteId, startDate || undefined, endDate || undefined)
    } catch (cacheError) {
      console.error('Redis cache error:', cacheError)
    }

    if (!statistics) {
      try {
        // ClickHouseからデータを取得
        statistics = await getStatistics(
          siteId,
          startDate || undefined,
          endDate || undefined
        )
        
        // キャッシュに保存
        if (statistics) {
          try {
            await setStatisticsCache(siteId, statistics, startDate || undefined, endDate || undefined)
          } catch (cacheError) {
            console.error('Failed to cache statistics:', cacheError)
          }
        }
      } catch (error) {
        console.error('Error fetching statistics from ClickHouse:', error)
        // エラー時は空の統計を返す
        statistics = {
          total_events: 0,
          clicks: 0,
          scrolls: 0,
          hovers: 0,
          unique_sessions: 0,
          avg_scroll_depth: 0,
          desktop_events: 0,
          tablet_events: 0,
          mobile_events: 0
        }
      }
    } else {
      cached = true
    }

    return NextResponse.json({
      success: true,
      data: statistics || {},
      cached
    })

  } catch (error) {
    console.error('Error fetching statistics:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { site_id, start_date, end_date, metrics } = body

    if (!site_id) {
      return NextResponse.json(
        { error: 'Missing required field: site_id' },
        { status: 400 }
      )
    }

    // ClickHouseから実際のデータを取得
    let basicStats: any = {}
    try {
      basicStats = await getStatistics(
        site_id,
        start_date || undefined,
        end_date || undefined
      )
    } catch (error) {
      console.error('Error fetching statistics from ClickHouse:', error)
      // エラー時は空の統計を返す
      basicStats = {
        total_events: 0,
        clicks: 0,
        scrolls: 0,
        hovers: 0,
        unique_sessions: 0,
        avg_scroll_depth: 0,
        desktop_events: 0,
        tablet_events: 0,
        mobile_events: 0
      }
    }

    // 追加メトリクスの計算
    const totalEvents = Number(basicStats.total_events) || 0
    const clicks = Number(basicStats.clicks) || 0
    const scrolls = Number(basicStats.scrolls) || 0
    const hovers = Number(basicStats.hovers) || 0
    const desktopEvents = Number(basicStats.desktop_events) || 0
    const tabletEvents = Number(basicStats.tablet_events) || 0
    const mobileEvents = Number(basicStats.mobile_events) || 0

    const additionalMetrics = {
      click_rate: totalEvents > 0 ? (clicks / totalEvents * 100) : 0,
      scroll_rate: totalEvents > 0 ? (scrolls / totalEvents * 100) : 0,
      hover_rate: totalEvents > 0 ? (hovers / totalEvents * 100) : 0,
      desktop_ratio: totalEvents > 0 ? (desktopEvents / totalEvents * 100) : 0,
      tablet_ratio: totalEvents > 0 ? (tabletEvents / totalEvents * 100) : 0,
      mobile_ratio: totalEvents > 0 ? (mobileEvents / totalEvents * 100) : 0
    }

    // 期間比較データ（前週・前月）
    let lastWeekStats: any = { total_events: 0, clicks: 0, unique_sessions: 0 }
    let lastMonthStats: any = { total_events: 0, clicks: 0, unique_sessions: 0 }

    if (start_date && end_date) {
      const start = new Date(start_date)
      const end = new Date(end_date)
      const diff = end.getTime() - start.getTime()
      
      // 前週の期間を計算
      const lastWeekEnd = new Date(start.getTime() - 1)
      const lastWeekStart = new Date(start.getTime() - diff - 1)
      
      // 前月の期間を計算
      const lastMonthEnd = new Date(start.getTime() - 1)
      const lastMonthStart = new Date(start.getTime() - diff * 4 - 1)

      try {
        lastWeekStats = await getStatistics(
          site_id,
          lastWeekStart.toISOString().split('T')[0],
          lastWeekEnd.toISOString().split('T')[0]
        ) || { total_events: 0, clicks: 0, unique_sessions: 0 }

        lastMonthStats = await getStatistics(
          site_id,
          lastMonthStart.toISOString().split('T')[0],
          lastMonthEnd.toISOString().split('T')[0]
        ) || { total_events: 0, clicks: 0, unique_sessions: 0 }
      } catch (error) {
        console.error('Error fetching comparison statistics:', error)
      }
    }

    // 比較データ
    const lastWeekTotalEvents = Number(lastWeekStats.total_events) || 0
    const lastWeekClicks = Number(lastWeekStats.clicks) || 0
    const lastWeekSessions = Number(lastWeekStats.unique_sessions) || 0
    const lastMonthTotalEvents = Number(lastMonthStats.total_events) || 0
    const lastMonthClicks = Number(lastMonthStats.clicks) || 0
    const lastMonthSessions = Number(lastMonthStats.unique_sessions) || 0

    const comparison = {
      week_over_week: {
        total_events: lastWeekTotalEvents > 0 ? ((totalEvents - lastWeekTotalEvents) / lastWeekTotalEvents * 100) : 0,
        clicks: lastWeekClicks > 0 ? ((clicks - lastWeekClicks) / lastWeekClicks * 100) : 0,
        unique_sessions: lastWeekSessions > 0 ? ((Number(basicStats.unique_sessions) || 0 - lastWeekSessions) / lastWeekSessions * 100) : 0
      },
      month_over_month: {
        total_events: lastMonthTotalEvents > 0 ? ((totalEvents - lastMonthTotalEvents) / lastMonthTotalEvents * 100) : 0,
        clicks: lastMonthClicks > 0 ? ((clicks - lastMonthClicks) / lastMonthClicks * 100) : 0,
        unique_sessions: lastMonthSessions > 0 ? ((Number(basicStats.unique_sessions) || 0 - lastMonthSessions) / lastMonthSessions * 100) : 0
      }
    }

    const response = {
      basic: basicStats,
      metrics: additionalMetrics,
      comparison: comparison,
      period: {
        start_date: start_date || null,
        end_date: end_date || null
      }
    }

    return NextResponse.json({
      success: true,
      data: response
    })

  } catch (error) {
    console.error('Error processing statistics request:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
