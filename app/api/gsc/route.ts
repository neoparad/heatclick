import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { fetchGSCDailyData, fetchGSCQueryPageData, fetchGSCDataByQuery, fetchGSCDataByPage, GSCConfig } from '@/lib/integrations/gsc'

// GSCデータの取得と保存
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { siteId, startDate, endDate, action = 'fetch' } = body

    if (!siteId || !startDate || !endDate) {
      return NextResponse.json({ error: 'siteId, startDate, endDate are required' }, { status: 400 })
    }

    // GSC設定を取得（環境変数またはDBから）
    // TODO: サイトごとのGSC設定をDBから取得
    const gscConfig: GSCConfig = {
      clientEmail: process.env.GSC_CLIENT_EMAIL || '',
      privateKey: process.env.GSC_PRIVATE_KEY || '',
      siteUrl: process.env.GSC_SITE_URL || '',
    }

    if (!gscConfig.clientEmail || !gscConfig.privateKey || !gscConfig.siteUrl) {
      return NextResponse.json({ error: 'GSC configuration is missing' }, { status: 400 })
    }

    // GSCデータを取得
    const gscData = await fetchGSCDailyData(gscConfig, startDate, endDate)

    if (action === 'save') {
      // ClickHouseに保存
      const clickhouse = await getClickHouseClientAsync()
      
      const dataToInsert = gscData.map(item => ({
        site_id: siteId,
        date: item.date,
        query: item.query,
        page: item.page,
        clicks: item.clicks,
        impressions: item.impressions,
        ctr: item.ctr,
        position: item.position,
        device: item.device,
      }))

      await clickhouse.insert({
        table: 'clickinsight.gsc_data',
        values: dataToInsert,
        format: 'JSONEachRow',
      })

      return NextResponse.json({
        success: true,
        saved: dataToInsert.length,
        message: 'GSC data saved successfully',
      })
    }

    return NextResponse.json({
      success: true,
      data: gscData,
      count: gscData.length,
    })
  } catch (error: any) {
    console.error('GSC API Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch GSC data' },
      { status: 500 }
    )
  }
}

// GSCデータの取得（保存済みデータから）
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('siteId')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const query = searchParams.get('query')
    const page = searchParams.get('page')

    if (!siteId) {
      return NextResponse.json({ error: 'siteId is required' }, { status: 400 })
    }

    const clickhouse = await getClickHouseClientAsync()

    let sqlQuery = `
      SELECT site_id, date, query, page, clicks, impressions, ctr, position, device
      FROM clickinsight.gsc_data
      WHERE site_id = {site_id:String}
    `

    const params: Record<string, any> = { site_id: siteId }

    if (startDate) {
      sqlQuery += ` AND date >= {start_date:String}`
      params.start_date = startDate
    }

    if (endDate) {
      sqlQuery += ` AND date <= {end_date:String}`
      params.end_date = endDate
    }

    if (query) {
      sqlQuery += ` AND query LIKE {query_pattern:String}`
      params.query_pattern = `%${query}%`
    }

    if (page) {
      sqlQuery += ` AND page = {page:String}`
      params.page = page
    }

    sqlQuery += ` ORDER BY date DESC, clicks DESC LIMIT 1000`

    const result = await clickhouse.query({
      query: sqlQuery,
      query_params: params,
      format: 'JSONEachRow',
    })

    const data = await result.json()

    return NextResponse.json({
      success: true,
      data,
      count: data.length,
    })
  } catch (error: any) {
    console.error('Error fetching GSC data:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch GSC data' },
      { status: 500 }
    )
  }
}




