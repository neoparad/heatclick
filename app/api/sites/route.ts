import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

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
  const headers = buildCorsHeaders(request)
  return new NextResponse(null, { headers })
}

// Generate tracking ID
function generateTrackingId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = 'CIP_'
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// Generate UUID
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// GET - List all sites
export async function GET(request: NextRequest) {
  try {
    const clickhouse = await getClickHouseClientAsync()

    const result = await clickhouse.query({
      query: `
        SELECT
          id,
          name,
          url,
          tracking_id,
          status,
          created_at,
          updated_at,
          last_activity,
          page_views
        FROM clickinsight.sites
        ORDER BY created_at DESC
      `,
      format: 'JSONEachRow',
    })

    const sites = await result.json()

    return NextResponse.json({
      sites: sites,
      total: sites.length
    }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('Failed to fetch sites:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sites' },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}

// POST - Create new site
export async function POST(request: NextRequest) {
  try {
    const data = await request.json()

    // Validate required fields
    if (!data.name || !data.url) {
      return NextResponse.json(
        { error: 'Name and URL are required' },
        { status: 400, headers: buildCorsHeaders(request) }
      )
    }

    // Validate URL format
    try {
      new URL(data.url)
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL format' },
        { status: 400, headers: buildCorsHeaders(request) }
      )
    }

    const clickhouse = await getClickHouseClientAsync()

    // Check if URL already exists
    const existingResult = await clickhouse.query({
      query: `SELECT id FROM clickinsight.sites WHERE url = {url:String}`,
      query_params: { url: data.url },
      format: 'JSONEachRow',
    })

    const existing = await existingResult.json()
    if (existing.length > 0) {
      return NextResponse.json(
        { error: 'Site with this URL already exists' },
        { status: 409, headers: buildCorsHeaders(request) }
      )
    }

    // Create new site
    const site = {
      id: generateId(),
      name: data.name,
      url: data.url,
      tracking_id: generateTrackingId(),
      status: 'active',
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
      updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
      last_activity: new Date().toISOString().replace('T', ' ').substring(0, 19),
      page_views: 0,
    }

    await clickhouse.insert({
      table: 'clickinsight.sites',
      values: [site],
      format: 'JSONEachRow',
    })

    if (process.env.NODE_ENV === 'development') {
      console.log('Site created:', {
        id: site.id,
        name: site.name,
        tracking_id: site.tracking_id
      })
    }

    return NextResponse.json(
      {
        success: true,
        site: site
      },
      { status: 201, headers: buildCorsHeaders(request) }
    )
  } catch (error) {
    console.error('Failed to create site:', error)
    return NextResponse.json(
      { error: 'Failed to create site' },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}
