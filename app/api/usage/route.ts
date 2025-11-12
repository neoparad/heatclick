import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClient } from '@/lib/clickhouse'

// プラン情報の定義
const PLAN_LIMITS: Record<string, { name: string; pvLimit: number }> = {
  free: { name: 'Free', pvLimit: 5000 },
  starter: { name: 'Starter', pvLimit: 50000 },
  professional: { name: 'Professional', pvLimit: 500000 },
  business: { name: 'Business', pvLimit: 2000000 },
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('user_id')
    const plan = searchParams.get('plan') || 'free'
    
    if (!userId) {
      return NextResponse.json(
        { error: 'Missing required parameter: user_id' },
        { status: 400 }
      )
    }

    // プラン情報の取得
    const planInfo = PLAN_LIMITS[plan.toLowerCase()] || PLAN_LIMITS.free

    // 今月の使用量を取得（今月1日から今日まで）
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startDate = startOfMonth.toISOString().split('T')[0]
    const endDate = now.toISOString().split('T')[0]

    let usage = 0
    try {
      const client = getClickHouseClient()
      
      // ユーザーが所有するサイトのIDを取得
      const sitesResult = await client.query({
        query: `
          SELECT id, tracking_id
          FROM clickinsight.sites
          WHERE user_id = {user_id:String}
        `,
        query_params: { user_id: userId },
        format: 'JSONEachRow',
      })
      
      const sites = await sitesResult.json()
      
      if (sites.length > 0) {
        const siteIds = sites.map((s: any) => s.tracking_id)
        
        // 今月のPV数を集計
        const usageResult = await client.query({
          query: `
            SELECT count() as pv_count
            FROM clickinsight.events
            WHERE site_id IN ({site_ids:Array(String)})
              AND event_type = 'pageview'
              AND created_at >= {start_date:String}
              AND created_at <= {end_date:String}
          `,
          query_params: {
            site_ids: siteIds,
            start_date: startDate,
            end_date: endDate,
          },
          format: 'JSONEachRow',
        })
        
        const usageData = await usageResult.json() as any[]
        usage = (usageData && usageData[0]) ? (usageData[0].pv_count || 0) : 0
      }
    } catch (error) {
      console.error('Error fetching usage:', error)
      // エラー時は0を返す
      usage = 0
    }

    const percentage = planInfo.pvLimit > 0 
      ? Math.min(100, (usage / planInfo.pvLimit) * 100)
      : 0

    return NextResponse.json({
      success: true,
      data: {
        plan: planInfo.name,
        planKey: plan,
        usage: usage,
        limit: planInfo.pvLimit,
        percentage: Math.round(percentage * 10) / 10,
      }
    })

  } catch (error) {
    console.error('Error fetching usage:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

