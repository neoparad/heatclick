import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')

    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required parameter: site_id' },
        { status: 400 }
      )
    }

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
