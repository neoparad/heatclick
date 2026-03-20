import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, verifySiteAccess, forbidden } from '@/lib/api-utils'

// CORS headers
function buildCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: buildCorsHeaders(request) })
}

// GET - Get single test by ID
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const clickhouse = await getClickHouseClientAsync()
    const result = await clickhouse.query({
      query: `SELECT * FROM clickinsight.tests WHERE id = {id:String}`,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })
    const tests = await result.json() as Record<string, string | number>[]
    if (tests.length === 0) {
      return NextResponse.json(
        { error: 'Test not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }

    const test = tests[0]

    // サイトアクセス権限チェック
    if (test.site_id) {
      const { authorized } = await verifySiteAccess(request, String(test.site_id), clickhouse)
      if (!authorized) return forbidden('Access denied to this site')
    }

    // Fetch stats from events
    try {
      const statsResult = await clickhouse.query({
        query: `
          SELECT
            countIf(url = {url_a:String}) as sessions_a,
            countIf(url = {url_b:String}) as sessions_b,
            countIf(url = {url_a:String} AND event_type = 'click') as clicks_a,
            countIf(url = {url_b:String} AND event_type = 'click') as clicks_b
          FROM clickinsight.events
          WHERE site_id = {site_id:String}
        `,
        query_params: {
          site_id: test.site_id,
          url_a: test.page_url_a,
          url_b: test.page_url_b || '',
        },
        format: 'JSONEachRow',
      })
      const statsData = await statsResult.json() as Record<string, string | number>[]
      const stats = statsData[0] || {}
      test.sessions_a = Number(stats.sessions_a) || 0
      test.sessions_b = Number(stats.sessions_b) || 0
      test.clicks_a = Number(stats.clicks_a) || 0
      test.clicks_b = Number(stats.clicks_b) || 0
    } catch {
      test.sessions_a = 0
      test.sessions_b = 0
      test.clicks_a = 0
      test.clicks_b = 0
    }

    return NextResponse.json({ test }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.warn('ClickHouse unavailable:', (error as Error).message)
    return NextResponse.json(
      { error: 'Test not found' },
      { status: 404, headers: buildCorsHeaders(request) }
    )
  }
}

// PUT - Update test
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const data = await request.json()
    const clickhouse = await getClickHouseClientAsync()

    // Check existence
    const existingResult = await clickhouse.query({
      query: `SELECT id FROM clickinsight.tests WHERE id = {id:String}`,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })
    const existing = await existingResult.json() as Record<string, string | number>[]
    if (existing.length === 0) {
      return NextResponse.json(
        { error: 'Test not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }

    const updates: string[] = []
    const queryParams: Record<string, string | number> = { id: params.id }

    const allowedFields: Record<string, string> = {
      name: 'String', status: 'String', page_url_a: 'String', page_url_b: 'String',
      description_a: 'String', description_b: 'String', goal_type: 'String',
      traffic_split_a: 'UInt8', traffic_split_b: 'UInt8', confidence_level: 'UInt8',
      start_date: 'String', end_date: 'String',
    }

    for (const [field, chType] of Object.entries(allowedFields)) {
      if (data[field] !== undefined) {
        updates.push(`${field} = {${field}:${chType}}`)
        queryParams[field] = data[field]
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = now()')
      await clickhouse.command({
        query: `ALTER TABLE clickinsight.tests UPDATE ${updates.join(', ')} WHERE id = {id:String}`,
        query_params: queryParams,
      })
    }

    return NextResponse.json({ success: true }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('Failed to update test:', error)
    return NextResponse.json({ error: 'Failed to update test' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}

// DELETE - Delete test
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const clickhouse = await getClickHouseClientAsync()

    const before = await clickhouse.query({
      query: `SELECT count() as cnt FROM clickinsight.tests WHERE id = {id:String}`,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })
    const beforeData = await before.json() as Record<string, string | number>[]
    const countBefore = Number(beforeData[0]?.cnt || 0)

    if (countBefore === 0) {
      return NextResponse.json({ error: 'Test not found' }, { status: 404, headers: buildCorsHeaders(request) })
    }

    await clickhouse.command({
      query: `ALTER TABLE clickinsight.tests DELETE WHERE id = {id:String}`,
      query_params: { id: params.id },
    })

    return NextResponse.json({ success: true }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('Failed to delete test:', error)
    return NextResponse.json({ error: 'Failed to delete test' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}
