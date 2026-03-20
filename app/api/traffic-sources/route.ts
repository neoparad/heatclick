import { NextRequest, NextResponse } from 'next/server'
import { getTrafficSources } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    
    if (!siteId) {
      return badRequest('Missing required parameter: site_id')
    }

    // サイトアクセス権限チェック
    const ch = await getClickHouseClientAsync()
    const { authorized } = await verifySiteAccess(request, siteId, ch)
    if (!authorized) return forbidden('Access denied to this site')

    try {
      const trafficSources = await getTrafficSources(
        siteId,
        startDate || undefined,
        endDate || undefined
      )

      return NextResponse.json({
        success: true,
        data: trafficSources
      })
    } catch (error) {
      console.error('Error fetching traffic sources:', error)
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error processing traffic sources request:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

