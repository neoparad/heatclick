import { ClickHouseClient, createClient } from '@clickhouse/client'

// ClickHouseクライアントの設定
const clickhouse = createClient({
  host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USERNAME || 'default',
  password: process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_DATABASE || 'clickinsight',
})

// イベントデータの型定義
export interface ClickEvent {
  id: number
  site_id: string
  session_id: string
  user_id?: string
  page_url: string
  page_title?: string
  referrer?: string
  search_query?: string
  
  // 要素情報
  element_tag?: string
  element_id?: string
  element_class?: string
  element_text?: string
  element_xpath?: string
  element_selector?: string
  
  // 位置情報
  click_x: number
  click_y: number
  viewport_width: number
  viewport_height: number
  scroll_x?: number
  scroll_y?: number
  scroll_depth?: number
  
  // デバイス情報
  device_type: 'desktop' | 'tablet' | 'mobile'
  browser?: string
  os?: string
  user_agent?: string
  
  // イベント情報
  event_type: 'click' | 'scroll' | 'hover' | 'copy' | 'rightclick' | 'form_submit' | 'error'
  event_data?: string
  duration?: number
  
  // タイムスタンプ
  created_at: string
}

// イベントデータの挿入
export async function insertClickEvent(event: ClickEvent): Promise<void> {
  try {
    await clickhouse.insert({
      table: 'click_events',
      values: [event],
      format: 'JSONEachRow',
    })
  } catch (error) {
    console.error('Error inserting click event:', error)
    throw error
  }
}

// イベントデータの取得
export async function getClickEvents(
  siteId: string,
  startDate?: string,
  endDate?: string,
  limit: number = 1000
): Promise<ClickEvent[]> {
  try {
    let query = `
      SELECT *
      FROM click_events
      WHERE site_id = {site_id:String}
    `
    
    const params: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      query += ` AND created_at >= {start_date:String}`
      params.start_date = startDate
    }
    
    if (endDate) {
      query += ` AND created_at <= {end_date:String}`
      params.end_date = endDate
    }
    
    query += ` ORDER BY created_at DESC LIMIT {limit:UInt32}`
    params.limit = limit
    
    const result = await clickhouse.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    return await result.json()
  } catch (error) {
    console.error('Error fetching click events:', error)
    throw error
  }
}

// ヒートマップデータの取得
export async function getHeatmapData(
  siteId: string,
  pageUrl: string,
  deviceType?: string,
  startDate?: string,
  endDate?: string
): Promise<any[]> {
  try {
    let query = `
      SELECT 
        click_x,
        click_y,
        count() as click_count,
        avg(duration) as avg_duration,
        max(created_at) as last_click
      FROM click_events
      WHERE site_id = {site_id:String}
        AND page_url = {page_url:String}
        AND event_type = 'click'
    `
    
    const params: Record<string, any> = {
      site_id: siteId,
      page_url: pageUrl,
    }
    
    if (deviceType) {
      query += ` AND device_type = {device_type:String}`
      params.device_type = deviceType
    }
    
    if (startDate) {
      query += ` AND created_at >= {start_date:String}`
      params.start_date = startDate
    }
    
    if (endDate) {
      query += ` AND created_at <= {end_date:String}`
      params.end_date = endDate
    }
    
    query += `
      GROUP BY click_x, click_y
      ORDER BY click_count DESC
    `
    
    const result = await clickhouse.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    return await result.json()
  } catch (error) {
    console.error('Error fetching heatmap data:', error)
    throw error
  }
}

// 統計データの取得
export async function getStatistics(
  siteId: string,
  startDate?: string,
  endDate?: string
): Promise<any> {
  try {
    let query = `
      SELECT 
        count() as total_events,
        countIf(event_type = 'click') as clicks,
        countIf(event_type = 'scroll') as scrolls,
        countIf(event_type = 'hover') as hovers,
        uniq(session_id) as unique_sessions,
        avg(scroll_depth) as avg_scroll_depth,
        countIf(device_type = 'desktop') as desktop_events,
        countIf(device_type = 'tablet') as tablet_events,
        countIf(device_type = 'mobile') as mobile_events
      FROM click_events
      WHERE site_id = {site_id:String}
    `
    
    const params: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      query += ` AND created_at >= {start_date:String}`
      params.start_date = startDate
    }
    
    if (endDate) {
      query += ` AND created_at <= {end_date:String}`
      params.end_date = endDate
    }
    
    const result = await clickhouse.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    const data = await result.json()
    return data[0] || {}
  } catch (error) {
    console.error('Error fetching statistics:', error)
    throw error
  }
}

// データベースの初期化
export async function initializeDatabase(): Promise<void> {
  try {
    // 実際の実装ではClickHouseのテーブルを作成
    // 現在はモック実装
    console.log('ClickHouse database initialized successfully (mock)')
  } catch (error) {
    console.error('Error initializing database:', error)
    throw error
  }
}

export { clickhouse }
