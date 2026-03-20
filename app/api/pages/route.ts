import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')

    if (!siteId) {
      return badRequest('Missing required parameter: site_id')
    }

    // サイトアクセス権限チェック
    const ch = await getClickHouseClientAsync()
    const { authorized } = await verifySiteAccess(request, siteId, ch)
    if (!authorized) return forbidden('Access denied to this site')

    // ClickHouseからページURLのリストを取得
    let pages: any[] = []

    try {
      const clickhouse = await getClickHouseClientAsync()

      const query = `
        SELECT
          url,
          count() as count
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
        GROUP BY url
        ORDER BY count DESC
        LIMIT 100
      `

      const result = await clickhouse.query({
        query,
        query_params: { site_id: siteId },
        format: 'JSONEachRow',
      })

      pages = await result.json()
    } catch (error) {
      console.error('Error fetching pages from ClickHouse:', error)
      // エラー時は空の配列を返す
      pages = []
    }

    return NextResponse.json({
      success: true,
      data: pages,
      count: pages.length
    })

  } catch (error) {
    console.error('Error in GET /api/pages:', error)
    return NextResponse.json(
      { error: 'Internal server error', data: [] },
      { status: 500 }
    )
  }
}
