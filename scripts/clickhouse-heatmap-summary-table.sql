-- ClickHouse ヒートマップ集約テーブル作成SQL
-- 実行方法: ClickHouseサーバーに接続して実行

-- ============================================
-- 1. 集約テーブル（SummingMergeTree）
-- ============================================

CREATE TABLE IF NOT EXISTS clickinsight.heatmap_daily_summary (
  site_id String,
  page_url String,
  device_type String,
  event_type String,
  date Date,
  click_x UInt16,
  click_y UInt16,
  click_count UInt32,
  unique_sessions UInt32,
  last_updated DateTime DEFAULT now()
)
ENGINE = SummingMergeTree(click_count, unique_sessions)
ORDER BY (site_id, page_url, event_type, date, device_type, click_x, click_y)
PARTITION BY toYYYYMM(date);

-- ============================================
-- 2. マテビュー（リアルタイム集約）
-- ============================================

CREATE MATERIALIZED VIEW IF NOT EXISTS clickinsight.heatmap_daily_summary_mv
TO clickinsight.heatmap_daily_summary
AS
SELECT
  site_id,
  url AS page_url,
  coalesce(device_type, 'unknown') AS device_type,
  event_type,
  toDate(timestamp) AS date,
  click_x,
  click_y,
  count() AS click_count,
  uniq(session_id) AS unique_sessions,
  now() AS last_updated
FROM clickinsight.events
WHERE event_type = 'click'
  AND click_x > 0
  AND click_y > 0
GROUP BY site_id, page_url, device_type, event_type, date, click_x, click_y;

-- ============================================
-- 3. 確認クエリ
-- ============================================

-- テーブルが作成されたか確認
SELECT count() FROM clickinsight.heatmap_daily_summary;

-- マテビューが動作しているか確認
SELECT count() FROM clickinsight.heatmap_daily_summary_mv;

-- ============================================
-- 4. 初期データ集約（オプション）
-- ============================================

-- 過去の全データを集約（時間がかかる可能性があります）
-- このクエリは Inngest の rebuildAll 関数で実行されます
-- 手動で実行する場合は以下を実行:

-- INSERT INTO clickinsight.heatmap_daily_summary
-- SELECT
--   site_id,
--   url AS page_url,
--   coalesce(device_type, 'unknown') AS device_type,
--   event_type,
--   toDate(timestamp) AS date,
--   click_x,
--   click_y,
--   count() AS click_count,
--   uniq(session_id) AS unique_sessions,
--   now() AS last_updated
-- FROM clickinsight.events
-- WHERE event_type = 'click'
--   AND click_x > 0
--   AND click_y > 0
-- GROUP BY site_id, page_url, device_type, event_type, date, click_x, click_y;





