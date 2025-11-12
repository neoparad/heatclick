import { ClickHouseClient, createClient } from '@clickhouse/client'

// ClickHouseクライアントの設定
// CLICKHOUSE_URLが設定されている場合はそれを使用、そうでなければ個別の環境変数から構築
function getClickHouseConfig() {
  if (process.env.CLICKHOUSE_URL) {
    // 完全なURL形式の場合
    return {
      url: process.env.CLICKHOUSE_URL,
    }
  } else {
    // 個別の環境変数から構築
    const host = process.env.CLICKHOUSE_HOST || 'localhost'
    const port = process.env.CLICKHOUSE_PORT || '8123'
    const username = process.env.CLICKHOUSE_USER || 'default'
    const password = process.env.CLICKHOUSE_PASSWORD || ''
    const database = process.env.CLICKHOUSE_DATABASE || 'clickinsight'
    
    return {
      host: `http://${host}:${port}`,
      username,
      password,
      database,
    }
  }
}

let clickhouse: ClickHouseClient | null = null

// ClickHouseクライアントの初期化（遅延初期化）
function getClickHouseClient(): ClickHouseClient {
  if (!clickhouse) {
    try {
      const config = getClickHouseConfig()
      clickhouse = createClient(config)

      console.log('ClickHouse client initialized:', {
        host: 'url' in config ? config.url : config.host,
        database: 'database' in config ? config.database : 'N/A',
        hasUrl: !!process.env.CLICKHOUSE_URL,
        hasHost: !!process.env.CLICKHOUSE_HOST,
      })
    } catch (error) {
      console.error('Failed to initialize ClickHouse client:', error)
      throw error
    }
  }
  return clickhouse
}

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
    const client = getClickHouseClient()
    await client.insert({
      table: 'clickinsight.events',
      values: [event],
      format: 'JSONEachRow',
    })
  } catch (error) {
    console.error('Error inserting click event:', error)
    // 開発環境ではエラーをスロー、本番環境ではログのみ
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
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

    query += ` ORDER BY timestamp DESC LIMIT {limit:UInt32}`
    params.limit = limit
    
    const client = getClickHouseClient()
    const result = await client.query({
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
        max(timestamp) as last_click
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND url = {page_url:String}
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
      query += ` AND timestamp >= {start_date:String}`
      params.start_date = startDate
    }

    if (endDate) {
      query += ` AND timestamp <= {end_date:String}`
      params.end_date = endDate
    }

    query += `
      GROUP BY click_x, click_y
      ORDER BY click_count DESC
    `
    
    const client = getClickHouseClient()
    const result = await client.query({
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
        avg(scroll_percentage) as avg_scroll_depth,
        countIf(viewport_width >= 1024) as desktop_events,
        countIf(viewport_width >= 768 AND viewport_width < 1024) as tablet_events,
        countIf(viewport_width < 768) as mobile_events
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

    const client = getClickHouseClient()
    const result = await client.query({
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
    const client = getClickHouseClient()
    
    // データベースの作成（存在しない場合）
    await client.exec({
      query: 'CREATE DATABASE IF NOT EXISTS clickinsight',
    })
    
    // テーブルの作成（存在しない場合）
    // 注意: setup-server.shで既に作成されている場合はスキップされる
    
    // usersテーブルの作成（マルチテナント対応）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.users (
          id String,
          email String,
          password String,
          name String,
          plan String DEFAULT 'free',
          status String DEFAULT 'active',
          org_id Nullable(String),
          role String DEFAULT 'user',
          created_at DateTime,
          updated_at DateTime
        ) ENGINE = MergeTree()
        ORDER BY (id)
      `,
    })
    
    // sitesテーブルの作成（マルチテナント対応）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.sites (
          id String,
          name String,
          url String,
          tracking_id String,
          status String,
          user_id Nullable(String),
          org_id Nullable(String),
          created_at DateTime,
          updated_at DateTime,
          last_activity DateTime,
          page_views UInt64
        ) ENGINE = MergeTree()
        ORDER BY (id)
      `,
    })
    
    // eventsテーブルの作成（拡張版：収益・広告連携対応）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.events (
          id String,
          site_id String,
          session_id String,
          user_id Nullable(String),
          event_type String,
          timestamp DateTime,
          url String,
          referrer Nullable(String),
          user_agent String,
          viewport_width UInt16,
          viewport_height UInt16,
          element_tag_name Nullable(String),
          element_id Nullable(String),
          element_class_name Nullable(String),
          element_text Nullable(String),
          element_href Nullable(String),
          click_x UInt16,
          click_y UInt16,
          scroll_y UInt16,
          scroll_percentage UInt8,
          event_revenue Decimal(10, 2) DEFAULT 0,
          utm_source Nullable(String),
          utm_medium Nullable(String),
          utm_campaign Nullable(String),
          utm_term Nullable(String),
          utm_content Nullable(String),
          gclid Nullable(String),
          fbclid Nullable(String),
          conversion_type Nullable(String),
          conversion_value Decimal(10, 2) DEFAULT 0,
          search_query Nullable(String),
          device_type Nullable(String),
          received_at DateTime DEFAULT now()
        ) ENGINE = MergeTree()
        ORDER BY (site_id, timestamp)
        PARTITION BY toYYYYMM(timestamp)
      `,
    })
    
    // sessionsテーブルの作成（セッション集約）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.sessions (
          session_id String,
          site_id String,
          user_id Nullable(String),
          start_time DateTime,
          end_time DateTime,
          duration UInt32,
          page_views UInt16,
          events_count UInt32,
          total_revenue Decimal(10, 2) DEFAULT 0,
          conversion_type Nullable(String),
          landing_page String,
          exit_page String,
          utm_source Nullable(String),
          utm_medium Nullable(String),
          utm_campaign Nullable(String),
          search_query Nullable(String),
          device_type Nullable(String),
          referrer_type Nullable(String)
        ) ENGINE = MergeTree()
        ORDER BY (site_id, start_time)
        PARTITION BY toYYYYMM(start_time)
      `,
    })
    
    // heatmap_summaryテーブルの作成（集計済みヒートマップキャッシュ）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.heatmap_summary (
          site_id String,
          page_url String,
          date Date,
          device_type String,
          click_data String,
          scroll_data String,
          click_count UInt32,
          scroll_depth_avg Float32,
          last_updated DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(last_updated)
        ORDER BY (site_id, page_url, date, device_type)
        PARTITION BY toYYYYMM(date)
      `,
    })
    
    // session_recordingsテーブルの作成（セッション録画データ）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.session_recordings (
          id String,
          site_id String,
          session_id String,
          user_id Nullable(String),
          start_time DateTime,
          end_time DateTime,
          duration UInt32,
          events_count UInt32,
          recording_data String,
          metadata String,
          has_conversion UInt8 DEFAULT 0,
          conversion_value Decimal(10, 2) DEFAULT 0,
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree()
        ORDER BY (site_id, session_id, start_time)
        PARTITION BY toYYYYMM(start_time)
      `,
    })
    
    // gsc_dataテーブルの作成（Google Search Consoleデータ）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.gsc_data (
          site_id String,
          date Date,
          query String,
          page String,
          clicks UInt32,
          impressions UInt32,
          ctr Float32,
          position Float32,
          device String,
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree()
        ORDER BY (site_id, date, query, page)
        PARTITION BY toYYYYMM(date)
      `,
    })
    
    console.log('ClickHouse database initialized successfully')
  } catch (error) {
    console.error('Error initializing database:', error)
    // 開発環境ではエラーをスロー、本番環境ではログのみ
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
  }
}

// Get ClickHouse client instance (for API routes)
// This is an async wrapper for compatibility with existing code
export async function getClickHouseClientAsync(): Promise<ClickHouseClient> {
  return getClickHouseClient()
}

// Export the synchronous client getter (for internal use)
export { getClickHouseClient }
