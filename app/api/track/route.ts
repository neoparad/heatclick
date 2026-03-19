import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { publishRealtimeData, pushEventBuffer } from '@/lib/redis'
import { checkRateLimit } from '@/lib/rate-limit'
import { anonymizeIp } from '@/lib/privacy'

// Vercel Serverless タイムアウト設定（秒）
export const maxDuration = 60

// メモリ内データストレージ（フォールバック用）
let trackingData: any[] = []

function buildCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  const headers = buildCorsHeaders(request)
  return new NextResponse(null, { headers })
}

export async function POST(request: NextRequest) {
  try {
    // Rate Limiting（IP匿名化）
    const rawIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const clientIp = anonymizeIp(rawIp)
    const rateLimit = checkRateLimit(`track:${clientIp}`)
    
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { 
          status: 429,
          headers: {
            ...buildCorsHeaders(request),
            'X-RateLimit-Limit': '100',
            'X-RateLimit-Remaining': rateLimit.remaining.toString(),
            'X-RateLimit-Reset': new Date(rateLimit.resetTime).toISOString(),
            'Retry-After': Math.ceil((rateLimit.resetTime - Date.now()) / 1000).toString(),
          }
        }
      )
    }

    const data = await request.json()

    // Support both single event and batch events
    const events = data.events || [data]

    // Validate events
    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ error: 'Invalid data' }, { status: 400, headers: buildCorsHeaders(request) })
    }

    // Validate each event
    for (const event of events) {
      if (!event.site_id || !event.event_type) {
        console.error('ClickInsight Pro - Invalid event data:', {
          site_id: event.site_id,
          event_type: event.event_type,
          hasSiteId: !!event.site_id,
          hasEventType: !!event.event_type
        })
        return NextResponse.json({ 
          error: 'Invalid event data: site_id and event_type are required',
          details: {
            site_id: event.site_id || 'missing',
            event_type: event.event_type || 'missing'
          }
        }, { status: 400, headers: buildCorsHeaders(request) })
      }
      
      // Validate site_id format (should be a non-empty string)
      if (typeof event.site_id !== 'string' || event.site_id.trim() === '') {
        console.error('ClickInsight Pro - Invalid site_id format:', event.site_id)
        return NextResponse.json({ 
          error: 'Invalid site_id format: must be a non-empty string',
          site_id: event.site_id
        }, { status: 400, headers: buildCorsHeaders(request) })
      }
    }

    // Prepare events for ClickHouse（収益・広告連携対応）
    const clickHouseEvents = events.map(event => ({
      id: event.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      site_id: event.site_id || event.siteId,
      session_id: event.session_id || event.sessionId,
      user_id: event.user_id || event.userId || null,
      event_type: event.event_type || event.eventType,
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString().replace('T', ' ').replace('Z', '').substring(0, 19) : new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
      url: event.url || event.page_url || '',
      referrer: event.referrer || null,
      user_agent: event.user_agent || event.userAgent || '',
      viewport_width: event.viewport_width || event.viewportWidth || 0,
      viewport_height: event.viewport_height || event.viewportHeight || 0,
      element_tag_name: event.element?.tagName || event.element_tag_name || event.element_tag || null,
      element_id: event.element?.id || event.element_id || null,
      element_class_name: event.element?.className || event.element_class_name || event.element_class || null,
      element_text: event.element?.text || event.element_text || null,
      element_href: event.element?.href || event.element_href || null,
      click_x: event.position?.x || event.click_x || 0,
      click_y: event.position?.y || event.click_y || 0,
      scroll_y: event.scroll_y || 0,
      scroll_percentage: event.scroll_percentage || 0,
      read_y: event.read_y || null,
      read_duration: event.read_duration || 0,
      event_revenue: event.event_revenue || event.revenue || 0,
      utm_source: event.utm_source || null,
      utm_medium: event.utm_medium || null,
      utm_campaign: event.utm_campaign || null,
      utm_term: event.utm_term || null,
      utm_content: event.utm_content || null,
      gclid: event.gclid || null,
      fbclid: event.fbclid || null,
      conversion_type: event.conversion_type || null,
      conversion_value: event.conversion_value || event.conversionValue || 0,
      search_query: event.search_query || null,
      device_type: event.device_type || null,
    }))

    // Prepare image_visibility events
    const imageVisibilityEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'image_visibility' && event.image_src) {
        imageVisibilityEvents.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          site_id: event.site_id || event.siteId,
          session_id: event.session_id || event.sessionId,
          page_url: event.url || event.page_url || '',
          image_src: event.image_src || '',
          image_alt: event.image_alt || '',
          element_path: event.element_path || '',
          image_y: event.image_y || 0,
          image_width: event.image_width || 0,
          image_height: event.image_height || 0,
          visible_duration_ms: event.visible_duration_ms || 0,
          max_visible_ratio: event.max_visible_ratio || 0,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare form_interactions events
    const formEvents: any[] = []
    const formEventTypes = ['form_view', 'form_field_focus', 'form_field_blur', 'form_submit', 'form_abandon']
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (formEventTypes.includes(eventType)) {
        formEvents.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          event_type: eventType,
          form_id: event.form_id || '',
          form_action: event.form_action || '',
          field_name: event.field_name || '',
          field_type: event.field_type || '',
          field_duration_ms: event.field_duration_ms || 0,
          field_filled: event.field_filled || 0,
          field_count: event.field_count || 0,
          filled_count: event.filled_count || 0,
          fields_touched: event.fields_touched || 0,
          last_field: event.last_field || '',
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare video_events
    const videoEvents: any[] = []
    const videoEventTypes = ['video_play', 'video_pause', 'video_complete', 'video_milestone', 'video_summary']
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (videoEventTypes.includes(eventType)) {
        videoEvents.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          event_type: eventType,
          video_src: event.video_src || '',
          element_path: event.element_path || '',
          video_current_time: event.video_current_time || 0,
          video_duration: event.video_duration || 0,
          video_progress: event.video_progress || 0,
          video_milestone: event.video_milestone || 0,
          video_played_ms: event.video_played_ms || 0,
          video_completed: event.video_completed || 0,
          video_interactions: event.video_interactions || 0,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare element_visibility events
    const elementVisibilityEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'element_visibility' && event.element_selector) {
        elementVisibilityEvents.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          element_selector: event.element_selector || '',
          element_tag: event.element_tag || '',
          element_text: event.element_text || '',
          element_y: event.element_y || 0,
          visible_duration_ms: event.visible_duration_ms || 0,
          max_visible_ratio: event.max_visible_ratio || 0,
          element_clicked: event.element_clicked || 0,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Redisバッファ経由でClickHouseに書き込み（即レスポンス返却）
    // Inngest flushEventBuffer が毎分Redisからバッチ取得してClickHouseにINSERT
    try {
      const bufferPromises: Promise<void>[] = [
        pushEventBuffer('clickinsight.events', clickHouseEvents),
      ]

      if (imageVisibilityEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.image_visibility', imageVisibilityEvents))
      }
      if (formEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.form_interactions', formEvents))
      }
      if (videoEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.video_events', videoEvents))
      }
      if (elementVisibilityEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.element_visibility', elementVisibilityEvents))
      }

      await Promise.all(bufferPromises)

      // リアルタイム通知はRedis Pub/Subで即時配信（バッファとは別）
      for (const event of events) {
        const siteId = event.site_id || event.siteId
        if (siteId) {
          await publishRealtimeData(siteId, event)
        }
      }
    } catch (error) {
      console.error('Redis buffer error, falling back to direct ClickHouse insert:', error)
      // Redisが落ちている場合はClickHouseに直接書き込み（フォールバック）
      try {
        const clickhouse = await getClickHouseClientAsync()
        const insertPromises: Promise<any>[] = [
          clickhouse.insert({ table: 'clickinsight.events', values: clickHouseEvents, format: 'JSONEachRow' }),
        ]
        if (imageVisibilityEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.image_visibility', values: imageVisibilityEvents, format: 'JSONEachRow' }))
        }
        if (formEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.form_interactions', values: formEvents, format: 'JSONEachRow' }))
        }
        if (videoEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.video_events', values: videoEvents, format: 'JSONEachRow' }))
        }
        if (elementVisibilityEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.element_visibility', values: elementVisibilityEvents, format: 'JSONEachRow' }))
        }
        await Promise.all(insertPromises)
      } catch (chError) {
        console.error('ClickHouse direct insert also failed:', chError)
        events.forEach(event => {
          trackingData.push({ ...event, received_at: new Date().toISOString() })
        })
      }
    }

    // Debug log
    if (process.env.NODE_ENV === 'development') {
      const uniqueEventTypes = Array.from(new Set(events.map(e => e.event_type)))
      console.log('ClickInsight Pro - Received batch:', {
        count: events.length,
        siteId: events[0]?.site_id,
        eventTypes: uniqueEventTypes,
      })
    }

    return NextResponse.json({
      success: true,
      received: events.length
    }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('ClickInsight Pro - API Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('siteId')
    const eventType = searchParams.get('eventType')
    const limit = parseInt(searchParams.get('limit') || '100')

    // ClickHouseからデータを取得を試みる
    let events: any[] = []
    
    try {
      const clickhouse = await getClickHouseClientAsync()
      
      let query = `
        SELECT 
          id,
          site_id as siteId,
          session_id as sessionId,
          user_id as userId,
          event_type as eventType,
          timestamp,
          url as page_url,
          referrer,
          user_agent as userAgent,
          viewport_width as viewportWidth,
          viewport_height as viewportHeight,
          element_tag_name as elementTag,
          element_id as elementId,
          element_class_name as elementClass,
          element_text as elementText,
          click_x as clickX,
          click_y as clickY,
          scroll_y as scrollY,
          scroll_percentage as scrollPercentage,
          device_type as deviceType
        FROM clickinsight.events
        WHERE 1=1
      `
      
      const params: Record<string, any> = {}
      
      if (siteId) {
        query += ` AND site_id = {site_id:String}`
        params.site_id = siteId
      }
      
      if (eventType) {
        query += ` AND event_type = {event_type:String}`
        params.event_type = eventType
      }
      
      query += ` ORDER BY timestamp DESC LIMIT {limit:UInt32}`
      params.limit = limit
      
      const result = await clickhouse.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      })
      
      events = await result.json()
    } catch (error) {
      console.error('Error fetching events from ClickHouse:', error)
      // フォールバック: メモリ内データを使用
      events = trackingData
      
      if (siteId) {
        events = events.filter(item => item.siteId === siteId || item.site_id === siteId)
      }
      
      if (eventType) {
        events = events.filter(item => item.eventType === eventType || item.event_type === eventType)
      }
      
      events = events
        .sort((a, b) => {
          const timeA = new Date(a.timestamp || a.received_at || 0).getTime()
          const timeB = new Date(b.timestamp || b.received_at || 0).getTime()
          return timeB - timeA
        })
        .slice(0, limit)
    }

    return NextResponse.json({
      data: events,
      total: events.length,
      filtered: events.length,
      source: events.length > 0 && events[0].id ? 'clickhouse' : 'memory'
    }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('Error in GET /api/track:', error)
    return NextResponse.json(
      { error: 'Internal server error', data: [] },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}



