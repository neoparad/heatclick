import { NextRequest, NextResponse } from 'next/server'
import { getHeatmapData } from '@/lib/clickhouse'
import { getHeatmapCache, setHeatmapCache } from '@/lib/redis'

// Vercelのタイムアウトを60秒に設定（Pro/Enterpriseプランで有効）
export const maxDuration = 60

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const pageUrl = searchParams.get('page_url')
    const deviceType = searchParams.get('device_type')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const heatmapType = (searchParams.get('heatmap_type') || 'click') as 'click' | 'scroll' | 'read'
    
    if (!siteId || !pageUrl) {
      return NextResponse.json(
        { error: 'Missing required parameters: site_id, page_url' },
        { status: 400 }
      )
    }

    // キャッシュから取得を試みる（期間を含めたキャッシュキーを使用）
    let cached = false
    let heatmapData: any[] = []

    try {
      heatmapData = await getHeatmapCache(
        siteId, 
        pageUrl, 
        deviceType || undefined,
        startDate || undefined,
        endDate || undefined
      ) || []
    } catch (error) {
      console.error('Redis cache error:', error)
    }

    if (!heatmapData || heatmapData.length === 0) {
      try {
        // ClickHouseからデータを取得（ヒートマップタイプを指定）
        heatmapData = await getHeatmapData(
          siteId,
          pageUrl,
          deviceType || undefined,
          startDate || undefined,
          endDate || undefined,
          heatmapType
        )

        // キャッシュに保存（期間を含めたキャッシュキーを使用）
        if (heatmapData && heatmapData.length > 0) {
          try {
            await setHeatmapCache(
              siteId, 
              pageUrl, 
              heatmapData, 
              deviceType || undefined,
              startDate || undefined,
              endDate || undefined
            )
          } catch (cacheError) {
            console.error('Failed to cache heatmap data:', cacheError)
          }
        }
      } catch (error) {
        console.error('Error fetching heatmap data from ClickHouse:', error)
        // データベース接続エラー時はモックデータを返す（開発用）
        console.log('Returning empty data due to database error')
        heatmapData = []
      }
    } else {
      cached = true
    }

    return NextResponse.json({
      success: true,
      data: heatmapData || [],
      cached,
      heatmap_type: heatmapType
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

    // ClickHouseからデータを取得
    let heatmapData: any[] = []
    try {
      heatmapData = await getHeatmapData(
        site_id,
        page_url,
        device_type || undefined,
        start_date || undefined,
        end_date || undefined
      )
    } catch (error) {
      console.error('Error fetching heatmap data from ClickHouse:', error)
      // エラー時は空配列を返す
      heatmapData = []
    }

    // ヒートマップの統計情報を計算
    const stats = {
      total_clicks: heatmapData.reduce((sum: number, item: any) => sum + (item.click_count || 0), 0),
      unique_positions: heatmapData.length,
      avg_duration: heatmapData.length > 0 
        ? heatmapData.reduce((sum: number, item: any) => sum + (item.avg_duration || 0), 0) / heatmapData.length 
        : 0,
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
