import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { publishRealtimeData } from '@/lib/redis'
import { checkRateLimit } from '@/lib/rate-limit'
import { anonymizeIp } from '@/lib/privacy'

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
        return NextResponse.json({ error: 'Invalid event data' }, { status: 400, headers: buildCorsHeaders(request) })
      }
    }

    // Prepare events for ClickHouse（収益・広告連携対応）
    const clickHouseEvents = events.map(event => ({
      id: event.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      site_id: event.site_id || event.siteId,
      session_id: event.session_id || event.sessionId,
      user_id: event.user_id || event.userId || null,
      event_type: event.event_type || event.eventType,
      timestamp: event.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19),
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

    // Store in ClickHouse (primary storage)
    try {
      const clickhouse = await getClickHouseClientAsync()
      await clickhouse.insert({
        table: 'clickinsight.events',
        values: clickHouseEvents,
        format: 'JSONEachRow',
      })
      
      // Publish realtime data via Redis
      for (const event of events) {
        const siteId = event.site_id || event.siteId
        if (siteId) {
          await publishRealtimeData(siteId, event)
        }
      }
    } catch (error) {
      console.error('ClickHouse insert error:', error)
      // Fallback to memory storage if ClickHouse fails
      events.forEach(event => {
        trackingData.push({
          ...event,
          received_at: new Date().toISOString()
        })
      })
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
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get('siteId')
  const eventType = searchParams.get('eventType')
  const limit = parseInt(searchParams.get('limit') || '100')

  let filteredData = trackingData

  if (siteId) {
    filteredData = filteredData.filter(item => item.siteId === siteId)
  }

  if (eventType) {
    filteredData = filteredData.filter(item => item.eventType === eventType)
  }

  // 最新のデータを返す
  filteredData = filteredData
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)

  return NextResponse.json({
    data: filteredData,
    total: trackingData.length,
    filtered: filteredData.length
  }, { headers: buildCorsHeaders(request) })
}



