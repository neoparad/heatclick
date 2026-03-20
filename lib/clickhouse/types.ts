import type { ClickHouseClient } from '@clickhouse/client'

// Re-export for convenience
export type { ClickHouseClient }

// ClickHouse型定義
export interface ClickEvent {
  id: number
  site_id: string
  session_id: string
  user_id?: string
  page_url: string
  page_title?: string
  referrer?: string
  search_query?: string
  element_tag?: string
  element_id?: string
  element_class?: string
  element_text?: string
  element_xpath?: string
  element_selector?: string
  click_x: number
  click_y: number
  viewport_width: number
  viewport_height: number
  scroll_x?: number
  scroll_y?: number
  scroll_depth?: number
  device_type: 'desktop' | 'tablet' | 'mobile'
  browser?: string
  os?: string
  user_agent?: string
  event_type: string
  event_data?: string
  duration?: number
  created_at: string
}

export interface ClickHouseConfig {
  url: string
  username: string
  password: string
  database: string
  request_timeout: number
  max_open_connections: number
}

// ClickHouse query result row types
export interface ClickHeatmapRow {
  click_x: string | number
  click_y: string | number
  click_count: string | number
  last_click: string
  element_tag_name: string | null
  element_id: string | null
  element_class_name: string | null
}

export interface ScrollHeatmapRow {
  scroll_y: string | number
  unique_sessions: string | number
  session_count: string | number
  avg_scroll_percentage: string | number
  max_scroll_percentage: string | number
}

export interface ReadHeatmapRow {
  read_y: string | number
  total_duration: string | number
  avg_duration: string | number
  max_duration: string | number
  read_count: string | number
  unique_sessions: string | number
}

export interface StatisticsRow {
  total_events: string | number
  clicks: string | number
  scrolls: string | number
  hovers: string | number
  page_views: string | number
  unique_sessions: string | number
  avg_scroll_depth: string | number
  desktop_events: string | number
  tablet_events: string | number
  mobile_events: string | number
  first_event_time: string
  last_event_time: string
}

export interface SessionStatsRow {
  total_sessions: string | number
  avg_duration_seconds: string | number
  bounce_sessions: string | number
}

export interface CountRow {
  count: string | number
}

export interface TotalSessionsRow {
  total_sessions: string | number
}

// Event buffer item
export interface EventBufferItem {
  table: string
  values: Record<string, unknown>[]
  timestamp: number
}

// User from DB
export interface UserRow {
  id: string
  email: string
  password: string
  name: string
  plan: string
  status: string
}
