import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { checkRateLimit } from '@/lib/rate-limit'
import { anonymizeIp } from '@/lib/privacy'
import { getAuthContext, unauthorized, badRequest } from '@/lib/api-utils'

function buildCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: buildCorsHeaders(request) })
}

// セッション録画データの保存
export async function POST(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const rawIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const clientIp = anonymizeIp(rawIp)
    const rateLimit = checkRateLimit(`recordings:${clientIp}`)

    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: buildCorsHeaders(request) })
    }

    const data = await request.json()

    if (!data.site_id || !data.session_id || !data.events || !Array.isArray(data.events)) {
      return badRequest('Invalid data')
    }

    // 録画データサイズ制限（5MB）
    const jsonStr = JSON.stringify(data.events)
    if (jsonStr.length > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'Recording batch too large' }, { status: 413, headers: buildCorsHeaders(request) })
    }

    const clickhouse = await getClickHouseClientAsync()

    const recording = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      site_id: data.site_id,
      session_id: data.session_id,
      user_id: data.user_id || null,
      start_time: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
      end_time: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
      duration: 0,
      events_count: data.events.length,
      recording_data: jsonStr,
      metadata: JSON.stringify({ is_final: data.is_final || false, user_agent: request.headers.get('user-agent') || '' }),
      has_conversion: 0,
      conversion_value: 0,
    }

    await clickhouse.insert({
      table: 'clickinsight.session_recordings',
      values: [recording],
      format: 'JSONEachRow',
    })

    return NextResponse.json({
      success: true,
      events_received: data.events.length,
    }, { headers: buildCorsHeaders(request) })
  } catch (error: any) {
    console.error('Error saving recording:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}

// セッション録画データの取得
export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const sessionId = searchParams.get('session_id')
    const limit = parseInt(searchParams.get('limit') || '20')

    if (!siteId) {
      return badRequest('site_id is required')
    }

    const clickhouse = await getClickHouseClientAsync()

    let query = `
      SELECT
        id, site_id, session_id, user_id,
        start_time, end_time, duration, events_count,
        has_conversion, conversion_value,
        created_at
      FROM clickinsight.session_recordings
      WHERE site_id = {site_id:String}
    `
    const params: Record<string, any> = { site_id: siteId }

    if (sessionId) {
      query += ` AND session_id = {session_id:String}`
      params.session_id = sessionId
    }

    query += ` ORDER BY created_at DESC LIMIT {limit:UInt32}`
    params.limit = limit

    const result = await clickhouse.query({ query, query_params: params, format: 'JSONEachRow' })
    const recordings = await result.json()

    // 個別セッションの録画データ取得
    if (sessionId) {
      const dataQuery = `
        SELECT recording_data
        FROM clickinsight.session_recordings
        WHERE site_id = {site_id:String} AND session_id = {session_id:String}
        ORDER BY created_at ASC
      `
      const dataResult = await clickhouse.query({ query: dataQuery, query_params: { site_id: siteId, session_id: sessionId }, format: 'JSONEachRow' })
      const dataRows = await dataResult.json() as any[]

      // 全バッチのイベントを結合
      const allEvents: any[] = []
      for (const row of dataRows) {
        try {
          const events = JSON.parse(row.recording_data)
          allEvents.push(...events)
        } catch { /* skip invalid */ }
      }

      return NextResponse.json({
        success: true,
        recordings,
        events: allEvents,
        total_events: allEvents.length,
      }, { headers: buildCorsHeaders(request) })
    }

    return NextResponse.json({
      success: true,
      recordings,
      total: (recordings as any[]).length,
    }, { headers: buildCorsHeaders(request) })
  } catch (error: any) {
    console.error('Error fetching recordings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}
