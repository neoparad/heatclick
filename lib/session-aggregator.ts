// セッション集約機能
import { getClickHouseClientAsync } from './clickhouse'

export interface SessionData {
  session_id: string
  site_id: string
  user_id?: string
  start_time: string
  end_time: string
  duration: number
  page_views: number
  events_count: number
  total_revenue: number
  conversion_type?: string
  landing_page: string
  exit_page: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  search_query?: string
  device_type?: string
  referrer_type?: string
}

// セッション集約処理（バッチ処理用）
export async function aggregateSessions(
  siteId: string,
  startDate?: string,
  endDate?: string
): Promise<void> {
  try {
    const clickhouse = await getClickHouseClientAsync()
    
    let query = `
      INSERT INTO clickinsight.sessions
      SELECT
        session_id,
        site_id,
        any(user_id) as user_id,
        min(timestamp) as start_time,
        max(timestamp) as end_time,
        toUInt32(dateDiff('second', min(timestamp), max(timestamp))) as duration,
        countIf(event_type = 'pageview') as page_views,
        count() as events_count,
        sum(event_revenue) as total_revenue,
        anyIf(conversion_type, conversion_type != '') as conversion_type,
        anyIf(url, event_type = 'pageview') as landing_page,
        anyIf(url, timestamp = max(timestamp)) as exit_page,
        anyIf(utm_source, utm_source != '') as utm_source,
        anyIf(utm_medium, utm_medium != '') as utm_medium,
        anyIf(utm_campaign, utm_campaign != '') as utm_campaign,
        anyIf(search_query, search_query != '') as search_query,
        anyIf(device_type, device_type != '') as device_type,
        anyIf(referrer_type, referrer_type != '') as referrer_type
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
    `
    
    const params: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      query += ` AND timestamp >= {start_date:String}`
      params.start_date = startDate
    }
    
    if (endDate) {
      query += ` AND timestamp <= {end_date:String}`
      params.end_date = endDate
    }
    
    query += ` GROUP BY session_id, site_id`
    
    await clickhouse.exec({
      query,
      query_params: params,
    })
    
    console.log('Session aggregation completed for site:', siteId)
  } catch (error) {
    console.error('Error aggregating sessions:', error)
    throw error
  }
}

// セッションデータの取得
export async function getSessions(
  siteId: string,
  startDate?: string,
  endDate?: string,
  limit: number = 100
): Promise<SessionData[]> {
  try {
    const clickhouse = await getClickHouseClientAsync()
    
    let query = `
      SELECT *
      FROM clickinsight.sessions
      WHERE site_id = {site_id:String}
    `
    
    const params: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      query += ` AND start_time >= {start_date:String}`
      params.start_date = startDate
    }
    
    if (endDate) {
      query += ` AND end_time <= {end_date:String}`
      params.end_date = endDate
    }
    
    query += ` ORDER BY start_time DESC LIMIT {limit:UInt32}`
    params.limit = limit
    
    const result = await clickhouse.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    return await result.json()
  } catch (error) {
    console.error('Error fetching sessions:', error)
    throw error
  }
}

// ファネル分析用：セッションごとのページ遷移を取得
export async function getSessionFunnel(
  siteId: string,
  sessionId: string
): Promise<Array<{ url: string; timestamp: string; event_type: string }>> {
  try {
    const clickhouse = await getClickHouseClientAsync()
    
    const result = await clickhouse.query({
      query: `
        SELECT url, timestamp, event_type
        FROM clickinsight.events
        WHERE site_id = {site_id:String} AND session_id = {session_id:String}
        ORDER BY timestamp ASC
      `,
      query_params: {
        site_id: siteId,
        session_id: sessionId,
      },
      format: 'JSONEachRow',
    })
    
    return await result.json()
  } catch (error) {
    console.error('Error fetching session funnel:', error)
    throw error
  }
}



