import { NextRequest, NextResponse } from 'next/server'

// メモリ内データストレージ（実際のプロダクションではデータベースを使用）
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

    // Store in memory (fallback)
    events.forEach(event => {
      trackingData.push({
        ...event,
        received_at: new Date().toISOString()
      })
    })

    // TODO: Store in ClickHouse
    // Uncomment when ClickHouse client is set up
    /*
    try {
      const clickhouse = await getClickHouseClient()
      await clickhouse.insert({
        table: 'clickinsight.events',
        values: events,
        format: 'JSONEachRow',
      })
    } catch (error) {
      console.error('ClickHouse insert error:', error)
      // Continue even if ClickHouse fails (data is in memory)
    }
    */

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



