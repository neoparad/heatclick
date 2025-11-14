import { NextRequest, NextResponse } from 'next/server'
import { getHeatmapData as getHeatmapDataFromQuery } from '@/inngest/lib/heatmapQuery'
import { getHeatmapData as getHeatmapDataLegacy } from '@/lib/clickhouse'
import { getHeatmapCache, setHeatmapCache } from '@/lib/redis'

// 集約テーブル使用で10秒で十分
export const maxDuration = 10

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

    // キャッシュから取得を試みる（heatmap_typeを含めたキャッシュキーを使用）
    let cached = false
    let heatmapData: any[] = []

    try {
      heatmapData = await getHeatmapCache(
        siteId, 
        pageUrl, 
        deviceType || undefined,
        startDate || undefined,
        endDate || undefined,
        heatmapType
      ) || []
    } catch (error) {
      console.error('Redis cache error:', error)
    }

    if (!heatmapData || heatmapData.length === 0) {
      try {
        // クリックヒートマップの場合は集約テーブルから取得
        if (heatmapType === 'click') {
          heatmapData = await getHeatmapDataFromQuery({
            siteId,
            pageUrl,
            deviceType: deviceType || undefined,
            heatmapType: 'click',
            startDate: startDate || undefined,
            endDate: endDate || undefined,
          })
        } else {
          // スクロール・熟読ヒートマップは既存ロジックを使用
          heatmapData = await getHeatmapDataLegacy(
            siteId,
            pageUrl,
            deviceType || undefined,
            startDate || undefined,
            endDate || undefined,
            heatmapType
          )
        }

        // キャッシュに保存（heatmap_typeを含めたキャッシュキーを使用）
        if (heatmapData && heatmapData.length > 0) {
          try {
            await setHeatmapCache(
              siteId, 
              pageUrl, 
              heatmapData, 
              deviceType || undefined,
              startDate || undefined,
              endDate || undefined,
              3600 * 2, // 2時間
              heatmapType
            )
          } catch (cacheError) {
            console.error('Failed to cache heatmap data:', cacheError)
          }
        }
      } catch (error) {
        console.error('Error fetching heatmap data:', error)
        // データベース接続エラー時は空配列を返す
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

    // ClickHouseからデータを取得（集約テーブルから）
    let heatmapData: any[] = []
    try {
      heatmapData = await getHeatmapDataFromQuery({
        siteId: site_id,
        pageUrl: page_url,
        deviceType: device_type || undefined,
        heatmapType: 'click',
        startDate: start_date || undefined,
        endDate: end_date || undefined,
      })
    } catch (error) {
      console.error('Error fetching heatmap data:', error)
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
