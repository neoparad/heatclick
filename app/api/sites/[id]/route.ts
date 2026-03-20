import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import {
  getMemorySiteById,
  updateMemorySite,
  deleteMemorySite,
  formatDateTime,
} from '@/lib/sites-store'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'

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

// GET - Get single site by ID
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const clickhouse = await getClickHouseClientAsync()

    // サイトアクセス権限チェック
    const { authorized } = await verifySiteAccess(request, params.id, clickhouse)
    if (!authorized) return forbidden('Access denied to this site')

    const result = await clickhouse.query({
      query: `
        SELECT id, name, url, tracking_id, status,
               created_at, updated_at, last_activity, page_views
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
    return NextResponse.json({ site: sites[0] }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.warn('ClickHouse unavailable, using memory:', (error as Error).message)
    const site = getMemorySiteById(params.id)
    if (!site) {
      return NextResponse.json(
        { error: 'Site not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }
    return NextResponse.json({ site }, { headers: buildCorsHeaders(request) })
  }
}

// PUT - Update site
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const data = await request.json()

    // Validate URL if provided
    if (data.url) {
      try {
        new URL(data.url)
      } catch {
        return badRequest('Invalid URL format')
      }
    }

    // サイトアクセス権限チェック＋ClickHouseで更新を試みる
    try {
      const clickhouse = await getClickHouseClientAsync()

      const { authorized } = await verifySiteAccess(request, params.id, clickhouse)
      if (!authorized) return forbidden('Access denied to this site')

      const existingResult = await clickhouse.query({
        query: `SELECT id FROM clickinsight.sites WHERE id = {id:String}`,
        query_params: { id: params.id },
        format: 'JSONEachRow',
      })
      const existing = await existingResult.json()
      if (existing.length === 0) {
        // メモリフォールバック
        const memorySite = getMemorySiteById(params.id)
        if (!memorySite) {
          return NextResponse.json(
            { error: 'Site not found' },
            { status: 404, headers: buildCorsHeaders(request) }
          )
        }
      }

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

      if (updates.length > 0) {
        updates.push('updated_at = now()')
        await clickhouse.command({
          query: `ALTER TABLE clickinsight.sites UPDATE ${updates.join(', ')} WHERE id = {id:String}`,
          query_params: queryParams,
        })
      }
    } catch (error) {
      console.warn('ClickHouse unavailable for update:', (error as Error).message)
    }

    // メモリも更新
    const updated = updateMemorySite(params.id, data)
    if (!updated) {
      return NextResponse.json(
        { error: 'Site not found' },
        { status: 404, headers: buildCorsHeaders(request) }
      )
    }

    return NextResponse.json(
      { success: true, site: updated },
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
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    // サイトアクセス権限チェック＋ClickHouseから削除
    let chError: string | null = null
    try {
      const clickhouse = await getClickHouseClientAsync()

      const { authorized } = await verifySiteAccess(request, params.id, clickhouse)
      if (!authorized) return forbidden('Access denied to this site')

      // 削除前にレコード存在確認
      const before = await clickhouse.query({
        query: `SELECT count() as cnt FROM clickinsight.sites WHERE id = {id:String}`,
        query_params: { id: params.id },
        format: 'JSONEachRow',
      })
      const beforeData = await before.json() as Record<string, string | number>[]
      const countBefore = Number(beforeData[0]?.cnt || 0)

      if (countBefore === 0) {
        return NextResponse.json(
          { error: 'Site not found in database' },
          { status: 404, headers: buildCorsHeaders(request) }
        )
      }

      // CREATE TABLE ... AS SELECT で削除対象以外をコピーし、テーブルを入れ替え
      // ClickHouseのDELETEは非同期のため、この方法で即時反映を保証
      await clickhouse.command({
        query: `CREATE TABLE clickinsight.sites_tmp AS clickinsight.sites`,
      })

      await clickhouse.command({
        query: `INSERT INTO clickinsight.sites_tmp SELECT * FROM clickinsight.sites WHERE id != {id:String}`,
        query_params: { id: params.id },
      })

      await clickhouse.command({
        query: `EXCHANGE TABLES clickinsight.sites AND clickinsight.sites_tmp`,
      })

      await clickhouse.command({
        query: `DROP TABLE IF EXISTS clickinsight.sites_tmp`,
      })
    } catch (error) {
      chError = (error as Error).message
      console.error('ClickHouse delete error:', chError)

      // EXCHANGEがサポートされてない場合のフォールバック
      try {
        const clickhouse = await getClickHouseClientAsync()
        // tmpテーブルのクリーンアップ
        await clickhouse.command({ query: `DROP TABLE IF EXISTS clickinsight.sites_tmp` })

        // 通常のDELETEにフォールバック
        await clickhouse.command({
          query: `ALTER TABLE clickinsight.sites DELETE WHERE id = {id:String}`,
          query_params: { id: params.id },
        })
        chError = null
      } catch (e2) {
        chError = (e2 as Error).message
      }
    }

    // メモリからも削除
    deleteMemorySite(params.id)

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
