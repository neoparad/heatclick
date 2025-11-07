import { NextRequest, NextResponse } from 'next/server'
// import { getHeatmapData, getHeatmapCache, setHeatmapCache } from '@/lib/clickhouse'
// import { getHeatmapCache as getRedisCache, setHeatmapCache as setRedisCache } from '@/lib/redis'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const pageUrl = searchParams.get('page_url')
    const deviceType = searchParams.get('device_type')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    
    if (!siteId || !pageUrl) {
      return NextResponse.json(
        { error: 'Missing required parameters: site_id, page_url' },
        { status: 400 }
      )
    }

    // モックデータを返す（実際の実装ではClickHouseから取得）
    const heatmapData = [
      { click_x: 100, click_y: 200, click_count: 15, avg_duration: 120, last_click: new Date().toISOString() },
      { click_x: 300, click_y: 150, click_count: 8, avg_duration: 95, last_click: new Date().toISOString() },
      { click_x: 500, click_y: 300, click_count: 12, avg_duration: 110, last_click: new Date().toISOString() }
    ]

    return NextResponse.json({
      success: true,
      data: heatmapData,
      cached: false
    })

  } catch (error) {
    console.error('Error fetching heatmap data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { site_id, page_url, device_type, start_date, end_date } = body

    if (!site_id || !page_url) {
      return NextResponse.json(
        { error: 'Missing required fields: site_id, page_url' },
        { status: 400 }
      )
    }

    // モックデータを返す（実際の実装ではClickHouseから取得）
    const heatmapData = [
      { click_x: 100, click_y: 200, click_count: 15, avg_duration: 120, last_click: new Date().toISOString() },
      { click_x: 300, click_y: 150, click_count: 8, avg_duration: 95, last_click: new Date().toISOString() },
      { click_x: 500, click_y: 300, click_count: 12, avg_duration: 110, last_click: new Date().toISOString() }
    ]

    // ヒートマップの統計情報を計算
    const stats = {
      total_clicks: heatmapData.reduce((sum, item) => sum + item.click_count, 0),
      unique_positions: heatmapData.length,
      avg_duration: heatmapData.reduce((sum, item) => sum + (item.avg_duration || 0), 0) / heatmapData.length,
      last_click: heatmapData.length > 0 ? heatmapData[0].last_click : null
    }

    return NextResponse.json({
      success: true,
      data: heatmapData,
      stats: stats
    })

  } catch (error) {
    console.error('Error processing heatmap request:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
