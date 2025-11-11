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

    // モックデータを返す（実際の実装ではClickHouseから取得）
    const basicStats = {
      total_events: 12345,
      clicks: 8900,
      scrolls: 2100,
      hovers: 1345,
      unique_sessions: 8234,
      avg_scroll_depth: 65.5,
      desktop_events: 7234,
      tablet_events: 988,
      mobile_events: 4123
    }

    // 追加メトリクスの計算
    const additionalMetrics = {
      click_rate: basicStats.clicks / basicStats.total_events * 100,
      scroll_rate: basicStats.scrolls / basicStats.total_events * 100,
      hover_rate: basicStats.hovers / basicStats.total_events * 100,
      desktop_ratio: basicStats.desktop_events / basicStats.total_events * 100,
      tablet_ratio: basicStats.tablet_events / basicStats.total_events * 100,
      mobile_ratio: basicStats.mobile_events / basicStats.total_events * 100
    }

    // 期間比較データ（前週・前月）
    const now = new Date()
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // モックデータを返す（実際の実装ではClickHouseから取得）
    const lastWeekStats = {
      total_events: 11000,
      clicks: 8000,
      unique_sessions: 7500
    }

    const lastMonthStats = {
      total_events: 10000,
      clicks: 7000,
      unique_sessions: 6500
    }

    // 比較データ
    const comparison = {
      week_over_week: {
        total_events: ((basicStats.total_events - lastWeekStats.total_events) / lastWeekStats.total_events * 100) || 0,
        clicks: ((basicStats.clicks - lastWeekStats.clicks) / lastWeekStats.clicks * 100) || 0,
        unique_sessions: ((basicStats.unique_sessions - lastWeekStats.unique_sessions) / lastWeekStats.unique_sessions * 100) || 0
      },
      month_over_month: {
        total_events: ((basicStats.total_events - lastMonthStats.total_events) / lastMonthStats.total_events * 100) || 0,
        clicks: ((basicStats.clicks - lastMonthStats.clicks) / lastMonthStats.clicks * 100) || 0,
        unique_sessions: ((basicStats.unique_sessions - lastMonthStats.unique_sessions) / lastMonthStats.unique_sessions * 100) || 0
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
