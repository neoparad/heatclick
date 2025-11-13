import { ClickHouseClient, createClient } from '@clickhouse/client'

// ClickHouseクライアントの設定
// 個別の環境変数から構築（より柔軟で確実）
function getClickHouseConfig() {
  const host = process.env.CLICKHOUSE_HOST || 'localhost'
  const port = process.env.CLICKHOUSE_PORT || '8123'
  // CLICKHOUSE_USER と CLICKHOUSE_USERNAME の両方をサポート
  const username = process.env.CLICKHOUSE_USER || process.env.CLICKHOUSE_USERNAME || 'default'
  const password = process.env.CLICKHOUSE_PASSWORD || ''
  const database = process.env.CLICKHOUSE_DATABASE || 'clickinsight'
  
  // CLICKHOUSE_URLが設定されている場合は優先
  const url = process.env.CLICKHOUSE_URL || `http://${host}:${port}`

  return {
    url,
    username,
    password,
    database,
    // 追加の設定オプション
    request_timeout: 30000,
    max_open_connections: 10,
  }
}

let clickhouse: ClickHouseClient | null = null
let connectionError: Error | null = null
let lastConnectionTest: Date | null = null
const CONNECTION_TEST_INTERVAL = 60000 // 1分ごとに接続テスト

// ClickHouseクライアントの初期化（遅延初期化）
function getClickHouseClient(): ClickHouseClient {
  if (!clickhouse) {
    try {
      const config = getClickHouseConfig()
      
      // URL形式から設定を構築
      let clientConfig: any = {
        url: config.url,
        username: config.username,
        password: config.password,
        database: config.database,
        request_timeout: config.request_timeout,
        max_open_connections: config.max_open_connections,
      }
      
      clickhouse = createClient(clientConfig)
      connectionError = null

      console.log('ClickHouse client initialized:', {
        url: config.url,
        database: config.database,
        username: config.username,
        passwordSet: !!config.password,
      })
    } catch (error) {
      connectionError = error as Error
      console.error('Failed to initialize ClickHouse client:', error)
      throw error
    }
  }
  return clickhouse
}

// 接続をリセット（再接続用）
export function resetClickHouseConnection(): void {
  if (clickhouse) {
    try {
      clickhouse.close()
    } catch (error) {
      console.error('Error closing ClickHouse connection:', error)
    }
  }
  clickhouse = null
  connectionError = null
  lastConnectionTest = null
}

// ClickHouse接続のテスト
export async function testClickHouseConnection(): Promise<{
  connected: boolean
  error?: string
  errorDetails?: any
  config?: {
    url: string
    database: string
    username: string
    host?: string
    port?: string
  }
}> {
  try {
    const config = getClickHouseConfig()
    
    // 新しいクライアントインスタンスを作成してテスト
    const testClient = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      request_timeout: 10000, // 10秒のタイムアウト
    })
    
    // 簡単なクエリで接続をテスト
    const result = await testClient.query({
      query: 'SELECT 1 as test',
      format: 'JSONEachRow',
    })
    
    const data = await result.json()
    await testClient.close()
    
    // 接続成功時は既存のクライアントもリセットして再接続
    if (clickhouse) {
      resetClickHouseConnection()
    }
    
    lastConnectionTest = new Date()
    connectionError = null
    
    return {
      connected: true,
      config: {
        url: config.url,
        database: config.database,
        username: config.username,
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: process.env.CLICKHOUSE_PORT || '8123',
      },
    }
  } catch (error: any) {
    const config = getClickHouseConfig()
    const errorMessage = error?.message || String(error)
    const errorCode = error?.code || error?.errno || 'UNKNOWN'
    const errorStack = error?.stack
    
    console.error('ClickHouse connection test failed:', {
      message: errorMessage,
      code: errorCode,
      url: config.url,
      username: config.username,
    })
    
    connectionError = error as Error
    lastConnectionTest = new Date()
    
    return {
      connected: false,
      error: errorMessage,
      errorDetails: {
        code: errorCode,
        message: errorMessage,
        stack: errorStack,
      },
      config: {
        url: config.url,
        database: config.database,
        username: config.username,
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: process.env.CLICKHOUSE_PORT || '8123',
      },
    }
  }
}

// 接続エラー情報を取得
export function getConnectionError(): Error | null {
  return connectionError
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
    const client = await getClickHouseClientAsync()
    await client.insert({
      table: 'clickinsight.events',
      values: [event],
      format: 'JSONEachRow',
    })
  } catch (error: any) {
    console.error('Error inserting click event:', {
      error: error?.message || String(error),
      code: error?.code,
      eventId: event.id,
    })
    // 接続エラーの場合は接続をリセット
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.message?.includes('connection')) {
      resetClickHouseConnection()
    }
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
    
    const client = await getClickHouseClientAsync()
    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    return await result.json()
  } catch (error: any) {
    console.error('Error fetching click events:', {
      error: error?.message || String(error),
      code: error?.code,
      siteId,
    })
    // 接続エラーの場合は接続をリセット
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.message?.includes('connection')) {
      resetClickHouseConnection()
    }
    throw error
  }
}

// ヒートマップデータの取得
export async function getHeatmapData(
  siteId: string,
  pageUrl: string,
  deviceType?: string,
  startDate?: string,
  endDate?: string,
  heatmapType: 'click' | 'scroll' | 'read' = 'click'
): Promise<any[]> {
  try {
    const client = await getClickHouseClientAsync()
    
    // クリックヒートマップの場合（既存のロジック）
    if (heatmapType === 'click') {
      let query = `
        SELECT
          click_x,
          click_y,
          count() as click_count,
          max(timestamp) as last_click,
          argMax(element_tag_name, timestamp) as element_tag_name,
          argMax(element_id, timestamp) as element_id,
          argMax(element_class_name, timestamp) as element_class_name
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
      
      const result = await client.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      })
      
      return await result.json()
    }
    
    // スクロール深度ヒートマップの場合
    if (heatmapType === 'scroll') {
      // heatmap_eventsテーブルからスクロール深度データを取得
      // 各Y座標ごとの到達率を計算（到達したセッション数 / 全セッション数）
      let query = `
        SELECT 
          y as scroll_y,
          count() as session_count,
          uniq(session_id) as unique_sessions,
          avg(value) as avg_scroll_percentage,
          max(value) as max_scroll_percentage
        FROM clickinsight.heatmap_events
        WHERE page_url = {page_url:String}
          AND event_type = 'scroll'
      `
      
      const params: Record<string, any> = {
        page_url: pageUrl,
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
        GROUP BY y
        ORDER BY scroll_y ASC
      `
      
      const result = await client.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      })
      
      const scrollData = await result.json() as any[]
      
      // 全セッション数を取得
      let totalSessionsQuery = `
        SELECT uniq(session_id) as total_sessions
        FROM clickinsight.heatmap_events
        WHERE page_url = {page_url:String}
          AND event_type = 'scroll'
      `
      
      const totalSessionsParams: Record<string, any> = {
        page_url: pageUrl,
      }
      
      if (startDate) {
        totalSessionsQuery += ` AND created_at >= {start_date:String}`
        totalSessionsParams.start_date = startDate
      }

      if (endDate) {
        totalSessionsQuery += ` AND created_at <= {end_date:String}`
        totalSessionsParams.end_date = endDate
      }
      
      const totalSessionsResult = await client.query({
        query: totalSessionsQuery,
        query_params: totalSessionsParams,
        format: 'JSONEachRow',
      })
      
      const totalSessionsData = await totalSessionsResult.json() as any[]
      const totalSessions = Number(totalSessionsData[0]?.total_sessions) || 1
      
      // 到達率を計算して返す
      return scrollData.map(item => ({
        scroll_y: Number(item.scroll_y) || 0,
        session_count: Number(item.session_count) || 0,
        unique_sessions: Number(item.unique_sessions) || 0,
        reach_rate: totalSessions > 0 ? ((Number(item.unique_sessions) / totalSessions) * 100) : 0,
        avg_scroll_percentage: Number(item.avg_scroll_percentage) || 0,
        max_scroll_percentage: Number(item.max_scroll_percentage) || 0,
      }))
    }
    
    // 熟読エリアヒートマップの場合
    if (heatmapType === 'read') {
      // heatmap_eventsテーブルから熟読エリアデータを取得
      // 各Y座標ごとの総滞在時間を合計
      let query = `
        SELECT 
          y as read_y,
          sum(value) as total_duration,
          avg(value) as avg_duration,
          max(value) as max_duration,
          count() as read_count,
          uniq(session_id) as unique_sessions
        FROM clickinsight.heatmap_events
        WHERE page_url = {page_url:String}
          AND event_type = 'read'
      `
      
      const params: Record<string, any> = {
        page_url: pageUrl,
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
        GROUP BY y
        ORDER BY total_duration DESC
      `
      
      const result = await client.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      })
      
      const readData = await result.json() as any[]
      
      // 最大値を取得して正規化（0-1の範囲）
      const maxDuration = Math.max(...readData.map(item => Number(item.total_duration) || 0), 1)
      
      // 正規化済みのintensityを計算
      return readData.map(item => ({
        read_y: Number(item.read_y) || 0,
        total_duration: Number(item.total_duration) || 0,
        avg_duration: Number(item.avg_duration) || 0,
        max_duration: Number(item.max_duration) || 0,
        read_count: Number(item.read_count) || 0,
        unique_sessions: Number(item.unique_sessions) || 0,
        intensity: maxDuration > 0 ? (Number(item.total_duration) / maxDuration) : 0,
      }))
    }
    
    return []
  } catch (error: any) {
    console.error('Error fetching heatmap data:', {
      error: error?.message || String(error),
      code: error?.code,
      siteId,
      pageUrl,
      heatmapType,
    })
    // 接続エラーの場合は接続をリセット
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.message?.includes('connection')) {
      resetClickHouseConnection()
    }
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
        countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views,
        uniq(session_id) as unique_sessions,
        avg(scroll_percentage) as avg_scroll_depth,
        countIf(viewport_width >= 1024) as desktop_events,
        countIf(viewport_width >= 768 AND viewport_width < 1024) as tablet_events,
        countIf(viewport_width < 768) as mobile_events,
        min(timestamp) as first_event_time,
        max(timestamp) as last_event_time
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

    const client = await getClickHouseClientAsync()
    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    
    const data = await result.json()
    const eventStats = data[0] || {}

    // セッション統計を取得（平均滞在時間と直帰率）
    // イベントデータから直接計算（sessionsテーブルに依存しない）
    // 集約関数を使用してループ処理を削減（パフォーマンス改善）
    let sessionQuery = `
      SELECT 
        count() as total_sessions,
        avg(dateDiff('second', session_start, session_end)) as avg_duration_seconds,
        countIf(page_views <= 1) as bounce_sessions
      FROM (
        SELECT 
          session_id,
          min(timestamp) as session_start,
          max(timestamp) as session_end,
          countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
    `
    
    const sessionParams: Record<string, any> = { site_id: siteId }

    if (startDate) {
      sessionQuery += ` AND timestamp >= {start_date:String}`
      sessionParams.start_date = startDate
    }

    if (endDate) {
      sessionQuery += ` AND timestamp <= {end_date:String}`
      sessionParams.end_date = endDate
    }

    sessionQuery += `
        GROUP BY session_id
      )
    `

    let sessionStats: any = {
      avg_time_on_page: 0,
      bounce_sessions: 0,
      total_sessions: 0,
      bounce_rate: 0
    }
    
    try {
      const sessionResult = await client.query({
        query: sessionQuery,
        query_params: sessionParams,
        format: 'JSONEachRow',
      })
      
      const sessionData = await sessionResult.json() as any[]
      
      if (sessionData && sessionData.length > 0) {
        const stats = sessionData[0]
        const totalSessions = Number(stats.total_sessions) || 0
        const avgDurationSeconds = Number(stats.avg_duration_seconds) || 0
        const bounceSessions = Number(stats.bounce_sessions) || 0
        
        // 秒から分に変換
        const avgTimeOnPageMinutes = totalSessions > 0 && avgDurationSeconds > 0 
          ? (avgDurationSeconds / 60).toFixed(1) 
          : '0'
        
        // 直帰率を計算
        const bounceRate = totalSessions > 0 
          ? ((bounceSessions / totalSessions) * 100).toFixed(1) 
          : '0'
        
        sessionStats = {
          avg_time_on_page: Number(avgTimeOnPageMinutes),
          bounce_sessions: bounceSessions,
          total_sessions: totalSessions,
          bounce_rate: Number(bounceRate)
        }
      }
    } catch (error: any) {
      console.error('Error fetching session statistics:', {
        error: error?.message || String(error),
        code: error?.code,
        siteId,
      })
    }

    // 平均滞在時間（分）
    const avgTimeOnPageMinutes = sessionStats.avg_time_on_page || 0

    // 直帰率
    const totalSessions = sessionStats.total_sessions || 0
    const bounceSessions = sessionStats.bounce_sessions || 0
    const bounceRate = sessionStats.bounce_rate || 0

    return {
      ...eventStats,
      avg_time_on_page: Number(avgTimeOnPageMinutes),
      bounce_rate: Number(bounceRate),
      total_sessions: totalSessions,
      bounce_sessions: bounceSessions
    }
  } catch (error) {
    console.error('Error fetching statistics:', error)
    throw error
  }
}

// 流入元情報の取得
export async function getTrafficSources(
  siteId: string,
  startDate?: string,
  endDate?: string
): Promise<any> {
  try {
    const client = await getClickHouseClientAsync()
    
    // リファラー別の統計
    let referrerQuery = `
      SELECT 
        CASE 
          WHEN referrer = '' OR referrer IS NULL THEN 'direct'
          ELSE referrer
        END as referrer,
        count() as sessions,
        uniq(session_id) as unique_sessions,
        countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND (event_type = 'page_view' OR event_type = 'pageview')
    `
    
    const referrerParams: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      referrerQuery += ` AND timestamp >= {start_date:String}`
      referrerParams.start_date = startDate
    }
    
    if (endDate) {
      referrerQuery += ` AND timestamp <= {end_date:String}`
      referrerParams.end_date = endDate
    }
    
    referrerQuery += `
      GROUP BY referrer
      ORDER BY sessions DESC
      LIMIT 20
    `
    
    const referrerResult = await client.query({
      query: referrerQuery,
      query_params: referrerParams,
      format: 'JSONEachRow',
    })
    
    const referrerData = await referrerResult.json() as any[]
    
    // UTM source別の統計
    let utmQuery = `
      SELECT 
        CASE 
          WHEN utm_source = '' OR utm_source IS NULL THEN 'direct'
          ELSE utm_source
        END as utm_source,
        CASE 
          WHEN utm_medium = '' OR utm_medium IS NULL THEN 'none'
          ELSE utm_medium
        END as utm_medium,
        count() as sessions,
        uniq(session_id) as unique_sessions,
        countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND (event_type = 'page_view' OR event_type = 'pageview')
    `
    
    const utmParams: Record<string, any> = { site_id: siteId }
    
    if (startDate) {
      utmQuery += ` AND timestamp >= {start_date:String}`
      utmParams.start_date = startDate
    }
    
    if (endDate) {
      utmQuery += ` AND timestamp <= {end_date:String}`
      utmParams.end_date = endDate
    }
    
    utmQuery += `
      GROUP BY utm_source, utm_medium
      ORDER BY sessions DESC
      LIMIT 20
    `
    
    const utmResult = await client.query({
      query: utmQuery,
      query_params: utmParams,
      format: 'JSONEachRow',
    })
    
    const utmData = await utmResult.json() as any[]
    
    return {
      referrers: referrerData.map(item => ({
        referrer: item.referrer || 'direct',
        sessions: Number(item.sessions) || 0,
        unique_sessions: Number(item.unique_sessions) || 0,
        page_views: Number(item.page_views) || 0,
      })),
      utm_sources: utmData.map(item => ({
        utm_source: item.utm_source || 'direct',
        utm_medium: item.utm_medium || 'none',
        sessions: Number(item.sessions) || 0,
        unique_sessions: Number(item.unique_sessions) || 0,
        page_views: Number(item.page_views) || 0,
      })),
    }
  } catch (error: any) {
    console.error('Error fetching traffic sources:', {
      error: error?.message || String(error),
      code: error?.code,
      siteId,
    })
    return {
      referrers: [],
      utm_sources: [],
    }
  }
}

// データベースの初期化
export async function initializeDatabase(): Promise<void> {
  try {
    const client = await getClickHouseClientAsync()
    
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
    
    // heatmap_eventsテーブルの作成（ヒートマップ専用データ）
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.heatmap_events (
          id String,
          session_id String,
          page_url String,
          event_type String, -- 'scroll', 'read', 'click'
          x UInt16, -- クリック or 読了領域のX座標
          y UInt16, -- スクロール深度・熟読領域のY座標
          value Float32, -- 深度% or 滞在時間(ms)
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree()
        ORDER BY (page_url, event_type, y)
        PARTITION BY toYYYYMM(created_at)
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
  try {
    const client = getClickHouseClient()
    
    // 定期的に接続をテスト（最後のテストから1分以上経過している場合）
    const now = new Date()
    if (!lastConnectionTest || (now.getTime() - lastConnectionTest.getTime()) > CONNECTION_TEST_INTERVAL) {
      try {
        await client.query({
          query: 'SELECT 1',
          format: 'JSONEachRow',
        })
        lastConnectionTest = now
        connectionError = null
      } catch (testError: any) {
        console.warn('ClickHouse connection test failed, resetting client:', testError?.message)
        resetClickHouseConnection()
        // 再接続を試みる
        return getClickHouseClient()
      }
    }
    
    return client
  } catch (error) {
    console.error('ClickHouse client not available:', error)
    connectionError = error as Error
    throw error
  }
}

// ClickHouse接続状態を確認（エラーをスローせずに）
export async function isClickHouseConnected(): Promise<boolean> {
  try {
    const client = await getClickHouseClientAsync()
    await client.query({
      query: 'SELECT 1',
      format: 'JSONEachRow',
    })
    return true
  } catch (error: any) {
    console.warn('ClickHouse connection check failed:', error?.message)
    return false
  }
}

// Export the synchronous client getter (for internal use)
export { getClickHouseClient }
