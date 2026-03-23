import { getClickHouseClientAsync } from './client'

export async function initializeDatabase(): Promise<void> {
  try {
    const client = await getClickHouseClientAsync()

    await client.exec({ query: 'CREATE DATABASE IF NOT EXISTS clickinsight' })

    // users
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.users (
          id String, email String, password String, name String,
          plan String DEFAULT 'free', status String DEFAULT 'active',
          org_id Nullable(String), role String DEFAULT 'user',
          created_at DateTime, updated_at DateTime
        ) ENGINE = MergeTree() ORDER BY (id)
      `,
    })

    // sites
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.sites (
          id String, name String, url String, tracking_id String, status String,
          user_id Nullable(String), org_id Nullable(String),
          ga4_property_id Nullable(String),
          created_at DateTime, updated_at DateTime, last_activity DateTime, page_views UInt64
        ) ENGINE = MergeTree() ORDER BY (id)
      `,
    })

    // events
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.events (
          id String, site_id String, session_id String, user_id Nullable(String),
          event_type String, timestamp DateTime, url String, referrer Nullable(String),
          user_agent String, viewport_width UInt16, viewport_height UInt16,
          element_tag_name Nullable(String), element_id Nullable(String),
          element_class_name Nullable(String), element_text Nullable(String), element_href Nullable(String),
          click_x UInt16, click_y UInt16, scroll_y UInt16, scroll_percentage UInt8,
          read_y UInt16 DEFAULT 0, read_duration Float32 DEFAULT 0,
          event_revenue Decimal(10, 2) DEFAULT 0,
          utm_source Nullable(String), utm_medium Nullable(String), utm_campaign Nullable(String),
          utm_term Nullable(String), utm_content Nullable(String),
          gclid Nullable(String), fbclid Nullable(String),
          conversion_type Nullable(String), conversion_value Decimal(10, 2) DEFAULT 0,
          search_query Nullable(String), device_type Nullable(String), ga_client_id Nullable(String),
          external_id Nullable(String), received_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, timestamp) PARTITION BY toYYYYMM(timestamp)
      `,
    })

    // ALTER TABLE for existing tables
    try {
      await client.exec({ query: `ALTER TABLE clickinsight.events ADD COLUMN IF NOT EXISTS read_y UInt16 DEFAULT 0` })
      await client.exec({ query: `ALTER TABLE clickinsight.events ADD COLUMN IF NOT EXISTS read_duration Float32 DEFAULT 0` })
      await client.exec({ query: `ALTER TABLE clickinsight.events ADD COLUMN IF NOT EXISTS ga_client_id Nullable(String)` })
      await client.exec({ query: `ALTER TABLE clickinsight.events ADD COLUMN IF NOT EXISTS external_id Nullable(String)` })
      // Tier 1: CSS selector + sequence_id
      await client.exec({ query: `ALTER TABLE clickinsight.events ADD COLUMN IF NOT EXISTS element_selector Nullable(String)` })
      await client.exec({ query: `ALTER TABLE clickinsight.events ADD COLUMN IF NOT EXISTS sequence_id UInt32 DEFAULT 0` })
    } catch { /* columns already exist */ }

    // sites テーブルに ga4_property_id カラム追加（既存テーブル対応）
    try {
      await client.exec({ query: `ALTER TABLE clickinsight.sites ADD COLUMN IF NOT EXISTS ga4_property_id Nullable(String)` })
    } catch { /* column already exists */ }

    // sessions
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.sessions (
          session_id String, site_id String, user_id Nullable(String),
          start_time DateTime, end_time DateTime, duration UInt32, page_views UInt16, events_count UInt32,
          total_revenue Decimal(10, 2) DEFAULT 0, conversion_type Nullable(String),
          landing_page String, exit_page String,
          utm_source Nullable(String), utm_medium Nullable(String), utm_campaign Nullable(String),
          search_query Nullable(String), device_type Nullable(String), referrer_type Nullable(String)
        ) ENGINE = MergeTree() ORDER BY (site_id, start_time) PARTITION BY toYYYYMM(start_time)
      `,
    })

    // heatmap_summary
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.heatmap_summary (
          site_id String, page_url String, date Date, device_type String,
          click_data String, scroll_data String, click_count UInt32, scroll_depth_avg Float32,
          last_updated DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(last_updated) ORDER BY (site_id, page_url, date, device_type) PARTITION BY toYYYYMM(date)
      `,
    })

    // session_recordings
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.session_recordings (
          id String, site_id String, session_id String, user_id Nullable(String),
          start_time DateTime, end_time DateTime, duration UInt32, events_count UInt32,
          recording_data String, metadata String, has_conversion UInt8 DEFAULT 0,
          conversion_value Decimal(10, 2) DEFAULT 0, created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, session_id, start_time) PARTITION BY toYYYYMM(start_time)
      `,
    })

    // gsc_data
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.gsc_data (
          site_id String, date Date, query String, page String,
          clicks UInt32, impressions UInt32, ctr Float32, position Float32, device String,
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, date, query, page) PARTITION BY toYYYYMM(date)
      `,
    })

    // image_visibility
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.image_visibility (
          id String, site_id String, session_id String, page_url String,
          image_src String, image_alt String DEFAULT '', element_path String DEFAULT '',
          image_y UInt32, image_width UInt16, image_height UInt16,
          visible_duration_ms UInt32, max_visible_ratio Float32, device_type Nullable(String),
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, page_url, image_src, created_at) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // form_interactions
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.form_interactions (
          id String, site_id String, session_id String, page_url String, event_type String,
          form_id String, form_action String DEFAULT '', field_name String DEFAULT '', field_type String DEFAULT '',
          field_duration_ms UInt32 DEFAULT 0, field_filled UInt8 DEFAULT 0,
          field_count UInt16 DEFAULT 0, filled_count UInt16 DEFAULT 0,
          fields_touched UInt16 DEFAULT 0, last_field String DEFAULT '',
          device_type Nullable(String), created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, page_url, form_id, created_at) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // video_events
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.video_events (
          id String, site_id String, session_id String, page_url String, event_type String,
          video_src String, element_path String DEFAULT '',
          video_current_time UInt32 DEFAULT 0, video_duration UInt32 DEFAULT 0,
          video_progress UInt8 DEFAULT 0, video_milestone UInt8 DEFAULT 0,
          video_played_ms UInt32 DEFAULT 0, video_completed UInt8 DEFAULT 0,
          video_interactions UInt16 DEFAULT 0, device_type Nullable(String),
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, page_url, video_src, created_at) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // element_visibility
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.element_visibility (
          id String, site_id String, session_id String, page_url String,
          element_selector String, element_tag String DEFAULT '', element_text String DEFAULT '',
          element_y UInt32 DEFAULT 0, visible_duration_ms UInt32, max_visible_ratio Float32,
          element_clicked UInt8 DEFAULT 0, device_type Nullable(String),
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, page_url, element_selector, created_at) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // user_mappings
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.user_mappings (
          site_id String, anonymous_id String, external_id String,
          metadata String DEFAULT '', created_at DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (site_id, anonymous_id)
      `,
    })

    // behavior_signals (emotion inference: text_copy, scroll_reversal, tab_return, browser_back, pinch_zoom, cta_hover)
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.behavior_signals (
          id String, site_id String, session_id String, page_url String, event_type String,
          -- text_copy
          copied_text Nullable(String), copied_length UInt16 DEFAULT 0, copy_y UInt32 DEFAULT 0,
          -- scroll_reversal
          reversal_count UInt16 DEFAULT 0, final_scroll_y UInt32 DEFAULT 0,
          -- tab_return
          away_duration_ms UInt32 DEFAULT 0, tab_switch_count UInt16 DEFAULT 0, return_scroll_y UInt32 DEFAULT 0,
          -- browser_back
          from_url Nullable(String), scroll_y_at_back UInt32 DEFAULT 0, scroll_depth_at_back UInt8 DEFAULT 0,
          -- pinch_zoom
          zoom_scale Float32 DEFAULT 0, zoom_y UInt32 DEFAULT 0,
          target_tag Nullable(String), target_src Nullable(String), target_alt Nullable(String),
          pinch_zoom_count UInt16 DEFAULT 0,
          -- cta_hover
          hover_duration_ms UInt32 DEFAULT 0, hover_y UInt32 DEFAULT 0, hover_clicked UInt8 DEFAULT 0,
          -- common
          element_path Nullable(String), element_text Nullable(String),
          device_type Nullable(String), created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, page_url, event_type, created_at) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // scroll_timeline (Tier 1: scroll position time series for reading pattern analysis)
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.scroll_timeline (
          id String, site_id String, session_id String, page_url String,
          timestamp_ms UInt64, scroll_y UInt32, viewport_height UInt16,
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, session_id, timestamp_ms) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // element_visibility_v2 (Tier 1: broad content element visibility with precise timing)
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.element_visibility_v2 (
          id String, site_id String, session_id String, page_url String,
          element_selector String, element_tag String DEFAULT '', element_text String DEFAULT '',
          visible_start_ms UInt64 DEFAULT 0, visible_end_ms UInt64 DEFAULT 0,
          visible_duration_ms UInt32 DEFAULT 0, viewport_percent Float32 DEFAULT 0,
          created_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, session_id, element_selector) PARTITION BY toYYYYMM(created_at)
      `,
    })

    // tests
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.tests (
          id String, site_id String, name String, type String DEFAULT 'ab',
          status String DEFAULT 'draft', page_url_a String, page_url_b String DEFAULT '',
          description_a String DEFAULT '', description_b String DEFAULT '',
          traffic_split_a UInt8 DEFAULT 50, traffic_split_b UInt8 DEFAULT 50,
          goal_type String DEFAULT 'cvr', confidence_level UInt8 DEFAULT 95,
          start_date Nullable(Date), end_date Nullable(Date),
          created_at DateTime DEFAULT now(), updated_at DateTime DEFAULT now()
        ) ENGINE = MergeTree() ORDER BY (site_id, id)
      `,
    })

    console.log('ClickHouse database initialized successfully')
  } catch (error) {
    console.error('Error initializing database:', error)
    if (process.env.NODE_ENV === 'development') throw error
  }
}
