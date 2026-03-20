import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'

// CORS headers
function buildCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: buildCorsHeaders(request) })
}

// Generate UUID
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// GET - List all tests
export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const status = searchParams.get('status')
    const type = searchParams.get('type') || 'ab'

    const clickhouse = await getClickHouseClientAsync()

    let query = `
      SELECT *
      FROM clickinsight.tests
      WHERE type = {type:String}
    `
    const queryParams: Record<string, any> = { type }

    if (siteId) {
      // サイトアクセス権限チェック
      const { authorized } = await verifySiteAccess(request, siteId, clickhouse)
      if (!authorized) return forbidden('Access denied to this site')

      query += ` AND site_id = {site_id:String}`
      queryParams.site_id = siteId
    }

    if (status) {
      query += ` AND status = {status:String}`
      queryParams.status = status
    }

    query += ` ORDER BY created_at DESC`

    const result = await clickhouse.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    })
    const tests = await result.json() as Record<string, string | number>[]

    // Fetch basic stats for each test from events table
    const testsWithStats = await Promise.all(
      tests.map(async (test: any) => {
        try {
          const statsQuery = `
            SELECT
              countIf(url = {url_a:String}) as sessions_a,
              countIf(url = {url_b:String}) as sessions_b,
              countIf(url = {url_a:String} AND event_type = 'click') as clicks_a,
              countIf(url = {url_b:String} AND event_type = 'click') as clicks_b
            FROM clickinsight.events
            WHERE site_id = {site_id:String}
          `
          const statsResult = await clickhouse.query({
            query: statsQuery,
            query_params: {
              site_id: test.site_id,
              url_a: test.page_url_a,
              url_b: test.page_url_b || '',
            },
            format: 'JSONEachRow',
          })
          const statsData = await statsResult.json() as Record<string, string | number>[]
          const stats = statsData[0] || {}
          return {
            ...test,
            sessions_a: Number(stats.sessions_a) || 0,
            sessions_b: Number(stats.sessions_b) || 0,
            clicks_a: Number(stats.clicks_a) || 0,
            clicks_b: Number(stats.clicks_b) || 0,
          }
        } catch {
          return {
            ...test,
            sessions_a: 0,
            sessions_b: 0,
            clicks_a: 0,
            clicks_b: 0,
          }
        }
      })
    )

    return NextResponse.json(
      { tests: testsWithStats, total: testsWithStats.length },
      { headers: buildCorsHeaders(request) }
    )
  } catch (error) {
    console.warn('ClickHouse unavailable for tests:', (error as Error).message)
    return NextResponse.json(
      { tests: [], total: 0, source: 'fallback' },
      { headers: buildCorsHeaders(request) }
    )
  }
}

// POST - Create a new test
export async function POST(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const data = await request.json()

    if (!data.name || !data.site_id || !data.page_url_a) {
      return badRequest('name, site_id, and page_url_a are required')
    }

    // サイトアクセス権限チェック
    try {
      const ch = await getClickHouseClientAsync()
      const { authorized } = await verifySiteAccess(request, data.site_id, ch)
      if (!authorized) return forbidden('Access denied to this site')
    } catch {
      return forbidden('Unable to verify site access')
    }

    const now = new Date().toISOString().replace('T', ' ').split('.')[0]
    const test = {
      id: generateId(),
      site_id: data.site_id,
      name: data.name,
      type: data.type || 'ab',
      status: data.status || 'draft',
      page_url_a: data.page_url_a,
      page_url_b: data.page_url_b || '',
      description_a: data.description_a || '',
      description_b: data.description_b || '',
      traffic_split_a: data.traffic_split_a ?? 50,
      traffic_split_b: data.traffic_split_b ?? 50,
      goal_type: data.goal_type || 'cvr',
      confidence_level: data.confidence_level ?? 95,
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      created_at: now,
      updated_at: now,
    }

    try {
      const clickhouse = await getClickHouseClientAsync()
      await clickhouse.insert({
        table: 'clickinsight.tests',
        values: [test],
        format: 'JSONEachRow',
      })
    } catch (error) {
      console.warn('ClickHouse unavailable for test creation:', (error as Error).message)
      return NextResponse.json(
        { error: 'Failed to save test to database' },
        { status: 500, headers: buildCorsHeaders(request) }
      )
    }

    return NextResponse.json(
      { success: true, test },
      { status: 201, headers: buildCorsHeaders(request) }
    )
  } catch (error) {
    console.error('Failed to create test:', error)
    return NextResponse.json(
      { error: 'Failed to create test' },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}
