import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

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
  const headers = buildCorsHeaders(request)
  return new NextResponse(null, { headers })
}

// GET - Get single site by ID
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
        WHERE id = {id:String}
      `,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })

    const sites = await result.json()

    if (sites.length === 0) {
      return NextResponse.json(
        { error: 'Site not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }

    return NextResponse.json(
      { site: sites[0] },
      { headers: buildCorsHeaders(request) }
    )
  } catch (error) {
    console.error('Failed to fetch site:', error)
    return NextResponse.json(
      { error: 'Failed to fetch site' },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}

// PUT - Update site
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const data = await request.json()
    const clickhouse = await getClickHouseClientAsync()

    // Check if site exists
    const existingResult = await clickhouse.query({
      query: `SELECT id FROM clickinsight.sites WHERE id = {id:String}`,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })

    const existing = await existingResult.json()
    if (existing.length === 0) {
      return NextResponse.json(
        { error: 'Site not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }

    // Validate URL if provided
    if (data.url) {
      try {
        new URL(data.url)
      } catch {
        return NextResponse.json(
          { error: 'Invalid URL format' },
          { status: 400, headers: buildCorsHeaders(request) }
        )
      }
    }

    // Build update query
    const updates: string[] = []
    const queryParams: Record<string, any> = { id: params.id }

    if (data.name !== undefined) {
      updates.push('name = {name:String}')
      queryParams.name = data.name
    }

    if (data.url !== undefined) {
      updates.push('url = {url:String}')
      queryParams.url = data.url
    }

    if (data.status !== undefined) {
      updates.push('status = {status:String}')
      queryParams.status = data.status
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400, headers: buildCorsHeaders(request) }
      )
    }

    // Add updated_at
    updates.push('updated_at = now()')

    // Execute update using ALTER TABLE (ClickHouse way)
    // Note: ClickHouse doesn't support traditional UPDATE, we need to use ALTER TABLE UPDATE
    await clickhouse.command({
      query: `
        ALTER TABLE clickinsight.sites
        UPDATE ${updates.join(', ')}
        WHERE id = {id:String}
      `,
      query_params: queryParams,
    })

    // Wait a moment for the mutation to process
    await new Promise(resolve => setTimeout(resolve, 100))

    // Fetch updated site
    const updatedResult = await clickhouse.query({
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
        WHERE id = {id:String}
      `,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })

    const updatedSites = await updatedResult.json()

    if (process.env.NODE_ENV === 'development') {
      console.log('Site updated:', { id: params.id, updates: data })
    }

    return NextResponse.json(
      {
        success: true,
        site: updatedSites[0]
      },
      { headers: buildCorsHeaders(request) }
    )
  } catch (error) {
    console.error('Failed to update site:', error)
    return NextResponse.json(
      { error: 'Failed to update site' },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}

// DELETE - Delete site
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const clickhouse = await getClickHouseClientAsync()

    // Check if site exists
    const existingResult = await clickhouse.query({
      query: `SELECT id FROM clickinsight.sites WHERE id = {id:String}`,
      query_params: { id: params.id },
      format: 'JSONEachRow',
    })

    const existing = await existingResult.json()
    if (existing.length === 0) {
      return NextResponse.json(
        { error: 'Site not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }

    // Delete site using ALTER TABLE DELETE (ClickHouse way)
    await clickhouse.command({
      query: `
        ALTER TABLE clickinsight.sites
        DELETE WHERE id = {id:String}
      `,
      query_params: { id: params.id },
    })

    if (process.env.NODE_ENV === 'development') {
      console.log('Site deleted:', { id: params.id })
    }

    return NextResponse.json(
      { success: true },
      { headers: buildCorsHeaders(request) }
    )
  } catch (error) {
    console.error('Failed to delete site:', error)
    return NextResponse.json(
      { error: 'Failed to delete site' },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}
