import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import {
  getMemorySites,
  addMemorySite,
  findMemorySiteByUrl,
  formatDateTime,
  SiteData,
} from '@/lib/sites-store'
import { buildCorsHeaders, getAuthContext, badRequest, unauthorized, apiError } from '@/lib/api-utils'

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: buildCorsHeaders(request) })
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

// GET - List sites for authenticated user
export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const clickhouse = await getClickHouseClientAsync()
    const result = await clickhouse.query({
      query: `
        SELECT id, name, url, tracking_id, status,
               created_at, updated_at, last_activity, page_views
        FROM clickinsight.sites
        WHERE user_id = {user_id:String}
        ORDER BY created_at DESC
      `,
      query_params: { user_id: auth.userId },
      format: 'JSONEachRow',
    })
    const sites = await result.json()
    return NextResponse.json({ sites, total: sites.length }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.warn('ClickHouse unavailable, using memory store:', (error as Error).message)
    const sites = getMemorySites()
    return NextResponse.json(
      { sites, total: sites.length, source: 'memory' },
      { headers: buildCorsHeaders(request) }
    )
  }
}

// POST - Create new site
export async function POST(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const data = await request.json()

    if (!data.name || !data.url) {
      return badRequest('Name and URL are required')
    }

    // Validate URL
    try {
      new URL(data.url)
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL format' },
        { status: 400, headers: buildCorsHeaders(request) }
      )
    }

    const now = formatDateTime(new Date())
    const site: SiteData = {
      id: generateId(),
      name: data.name,
      url: data.url,
      tracking_id: generateTrackingId(),
      status: 'active',
      user_id: null,
      org_id: null,
      created_at: now,
      updated_at: now,
      last_activity: now,
      page_views: 0,
    }

    // ClickHouseに保存を試みる
    try {
      const clickhouse = await getClickHouseClientAsync()

      // 重複チェック
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

      await clickhouse.insert({
        table: 'clickinsight.sites',
        values: [site],
        format: 'JSONEachRow',
      })
    } catch (error) {
      console.warn('ClickHouse unavailable, saving to memory:', (error as Error).message)
      // メモリフォールバック: 重複チェック
      if (findMemorySiteByUrl(data.url)) {
        return NextResponse.json(
          { error: 'Site with this URL already exists' },
          { status: 409, headers: buildCorsHeaders(request) }
        )
      }
    }

    // メモリにも常に保存（フォールバック用）
    addMemorySite(site)

    return NextResponse.json(
      { success: true, site },
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
