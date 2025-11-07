import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // バリデーション
    if (!body.site_id || !body.session_id || !body.page_url) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // イベントデータの構造化
    const eventData = {
      id: Date.now(),
      site_id: body.site_id,
      session_id: body.session_id,
      user_id: body.user_id || null,
      page_url: body.page_url,
      page_title: body.page_title || null,
      referrer: body.referrer || null,
      search_query: body.search_query || null,
      
      // 要素情報
      element_tag: body.element?.tag || null,
      element_id: body.element?.id || null,
      element_class: body.element?.class || null,
      element_text: body.element?.text || null,
      element_xpath: body.element?.xpath || null,
      element_selector: body.element?.selector || null,
      
      // 位置情報
      click_x: body.position?.x || 0,
      click_y: body.position?.y || 0,
      viewport_width: body.position?.viewport_width || 0,
      viewport_height: body.position?.viewport_height || 0,
      scroll_x: body.position?.scroll_x || 0,
      scroll_y: body.position?.scroll_y || 0,
      scroll_depth: body.position?.scroll_depth || 0,
      
      // デバイス情報
      device_type: body.context?.device_type || 'desktop',
      browser: body.context?.browser || null,
      os: body.context?.os || null,
      user_agent: body.context?.user_agent || null,
      
      // イベント情報
      event_type: body.interaction?.type || 'click',
      event_data: JSON.stringify(body.interaction?.data || {}),
      duration: body.interaction?.duration || 0,
      
      // タイムスタンプ
      created_at: new Date().toISOString()
    }

    // ClickHouseへの挿入（実際の実装ではClickHouseクライアントを使用）
    console.log('Event data:', eventData)
    
    // ここでClickHouseにデータを挿入
    // await clickhouse.insert('click_events', eventData)
    
    return NextResponse.json({
      success: true,
      message: 'Event recorded successfully',
      event_id: eventData.id
    })

  } catch (error) {
    console.error('Error recording event:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'ClickInsight Pro Events API',
    version: '1.0.0',
    endpoints: {
      'POST /api/events': 'Record click events',
      'GET /api/events': 'Get event statistics'
    }
  })
}

