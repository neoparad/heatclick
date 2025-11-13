import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const pageUrl = searchParams.get('page_url')

    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required parameter: site_id' },
        { status: 400 }
      )
    }

    let client
    try {
      client = await getClickHouseClientAsync()
    } catch (error: any) {
      console.error('ClickHouse connection error:', {
        error: error?.message || String(error),
        code: error?.code,
      })
      // データベース接続エラー時は空データを返す
      return NextResponse.json({
        success: true,
        data: {
          elements: [],
          pages: [],
          devices: [],
          timeline: [],
          stats: {
            totalClicks: 0,
            uniqueSessions: 0,
            avgClicksPerSession: 0,
            clickChange: '+0%'
          }
        },
        warning: 'ClickHouse connection failed. Returning empty data.',
      })
    }

    // 要素別クリックデータの取得
    let elementQuery = `
      SELECT 
        element_tag_name as element_tag,
        element_id,
        element_class_name as element_class,
        element_text,
        url as page,
        device_type as device,
        avg(click_x) as avg_x,
        avg(click_y) as avg_y,
        count() as clicks,
        uniq(session_id) as unique_sessions
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND event_type = 'click'
    `
    
    const params: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      elementQuery += ` AND timestamp >= {start_date:String}`
      params.start_date = startDate
    }
    
    if (endDate) {
      elementQuery += ` AND timestamp <= {end_date:String}`
      params.end_date = endDate
    }

    if (pageUrl && pageUrl !== 'all') {
      elementQuery += ` AND url = {page_url:String}`
      params.page_url = pageUrl
    }
    
    elementQuery += `
      GROUP BY element_tag, element_id, element_class, element_text, page, device
      ORDER BY clicks DESC
      LIMIT 100
    `
    
    const elementResult = await client.query({
      query: elementQuery,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    const elementData = await elementResult.json()

    // ページ別統計の取得
    let pageQuery = `
      SELECT 
        url as page,
        count() as clicks,
        uniq(session_id) as visitors
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND event_type = 'click'
    `
    
    if (startDate) {
      pageQuery += ` AND timestamp >= {start_date:String}`
    }
    
    if (endDate) {
      pageQuery += ` AND timestamp <= {end_date:String}`
    }
    
    pageQuery += `
      GROUP BY page
      ORDER BY clicks DESC
    `
    
    const pageResult = await client.query({
      query: pageQuery,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    const pageData = await pageResult.json()

    // デバイス別統計の取得
    let deviceQuery = `
      SELECT 
        device_type as device,
        count() as clicks,
        uniq(session_id) as unique_sessions
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND event_type = 'click'
    `
    
    if (startDate) {
      deviceQuery += ` AND timestamp >= {start_date:String}`
    }
    
    if (endDate) {
      deviceQuery += ` AND timestamp <= {end_date:String}`
    }
    
    deviceQuery += `
      GROUP BY device
      ORDER BY clicks DESC
    `
    
    const deviceResult = await client.query({
      query: deviceQuery,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    const deviceData = await deviceResult.json()

    // 総統計の取得
    let statsQuery = `
      SELECT 
        count() as total_clicks,
        uniq(session_id) as unique_sessions,
        uniq(url) as unique_pages,
        uniq(concat(element_tag_name, '|', coalesce(element_id, ''), '|', coalesce(element_class_name, ''))) as unique_elements
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND event_type = 'click'
    `
    
    if (startDate) {
      statsQuery += ` AND timestamp >= {start_date:String}`
    }
    
    if (endDate) {
      statsQuery += ` AND timestamp <= {end_date:String}`
    }
    
    const statsResult = await client.query({
      query: statsQuery,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    const statsData = await statsResult.json() as any[]
    const stats = (statsData && statsData[0]) ? statsData[0] : { total_clicks: 0 }

    // 前期間との比較（簡易版）
    let prevStartDate: string | undefined
    let prevEndDate: string | undefined
    
    if (startDate && endDate) {
      const start = new Date(startDate)
      const end = new Date(endDate)
      const diff = end.getTime() - start.getTime()
      prevEndDate = new Date(start.getTime() - 1).toISOString().split('T')[0]
      prevStartDate = new Date(start.getTime() - diff - 1).toISOString().split('T')[0]
    } else if (endDate) {
      const end = new Date(endDate)
      prevEndDate = new Date(end.getTime() - 1).toISOString().split('T')[0]
    }

    let prevStats = { total_clicks: 0 }
    if (prevStartDate && prevEndDate) {
      let prevQuery = `
        SELECT count() as total_clicks
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
          AND event_type = 'click'
          AND timestamp >= {prev_start_date:String}
          AND timestamp <= {prev_end_date:String}
      `
      
      const prevResult = await client.query({
        query: prevQuery,
        query_params: {
          site_id: siteId,
          prev_start_date: prevStartDate,
          prev_end_date: prevEndDate,
        },
        format: 'JSONEachRow',
      })
      
      const prevData = await prevResult.json() as any[]
      prevStats = (prevData && prevData[0]) ? prevData[0] : { total_clicks: 0 }
    }

    const totalClicks = Number(stats.total_clicks) || 0
    const prevTotalClicks = Number(prevStats.total_clicks) || 0
    const clickChange = prevTotalClicks > 0 
      ? ((totalClicks - prevTotalClicks) / prevTotalClicks * 100).toFixed(1)
      : '0'

    // データの整形
    const formattedElementData = elementData.map((item: any) => {
      const elementName = item.element_text 
        ? `「${item.element_text.substring(0, 30)}${item.element_text.length > 30 ? '...' : ''}」`
        : item.element_tag || '要素'
      
      const selector = 
        (item.element_id ? `#${item.element_id}` : '') ||
        (item.element_class ? `.${item.element_class.split(' ')[0]}` : '') ||
        item.element_tag || ''
      
      const sessions = Number(item.unique_sessions) || 0
      const clicks = Number(item.clicks) || 0
      const ctr = sessions > 0 ? ((clicks / sessions) * 100).toFixed(1) : '0'
      
      return {
        element: elementName,
        selector: selector,
        clicks: clicks,
        ctr: parseFloat(ctr),
        change: '+0%', // 前期間比較は別途実装
        page: item.page || '/',
        device: item.device || 'desktop',
        position: {
          x: Math.round(Number(item.avg_x) || 0),
          y: Math.round(Number(item.avg_y) || 0)
        }
      }
    })

    // ページ別統計の整形（CTR計算用に訪問者数も必要）
    const formattedPageData = pageData.map((item: any) => {
      const visitors = Number(item.visitors) || 0
      const clicks = Number(item.clicks) || 0
      const ctr = visitors > 0 ? (clicks / visitors * 100).toFixed(1) : '0'
      
      return {
        page: item.page || '/',
        clicks: clicks,
        ctr: parseFloat(ctr),
        visitors: visitors
      }
    })

    // デバイス別統計の整形
    const totalDeviceClicks = deviceData.reduce((sum: number, item: any) => sum + (Number(item.clicks) || 0), 0)
    const formattedDeviceData = deviceData.map((item: any) => {
      const clicks = Number(item.clicks) || 0
      const percentage = totalDeviceClicks > 0 ? (clicks / totalDeviceClicks * 100).toFixed(1) : '0'
      const sessions = Number(item.unique_sessions) || 0
      const ctr = sessions > 0 ? (clicks / sessions * 100).toFixed(1) : '0'
      
      const deviceName = item.device === 'desktop' ? 'デスクトップ' :
                        item.device === 'mobile' ? 'モバイル' :
                        item.device === 'tablet' ? 'タブレット' : item.device
      
      return {
        device: deviceName,
        clicks: clicks,
        percentage: parseFloat(percentage),
        ctr: parseFloat(ctr)
      }
    })

    return NextResponse.json({
      success: true,
      data: {
        elements: formattedElementData,
        pages: formattedPageData,
        devices: formattedDeviceData,
        stats: {
          totalClicks: totalClicks,
          uniqueElements: Number(stats.unique_elements) || 0,
          uniquePages: Number(stats.unique_pages) || 0,
          uniqueSessions: Number(stats.unique_sessions) || 0,
          clickChange: clickChange
        }
      }
    })

  } catch (error) {
    console.error('Error fetching clicks data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

