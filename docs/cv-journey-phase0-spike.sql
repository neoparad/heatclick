-- =============================================================================
-- CV経路分析 Phase 0 — Query Spike（実データ検証用）
-- =============================================================================
-- 目的: コードを書く前に、実 ClickHouse で計画の前提を検証する。
-- 実行: analytics_reader ロール推奨（RO）。{site_id}/{tenant_id}/{start}/{end} を実値に置換。
-- 確認テーブル: clickinsight.events / clickinsight.sessions
--
-- 列の根拠: app/api/cv-paths/route.ts, lib/session-aggregator.ts で本番稼働中のクエリと同一列。
--   events:   tenant_id, site_id, session_id, user_id, timestamp, event_type, url,
--             utm_source, utm_medium, conversion_type, conversion_value, device_type
--   sessions: session_id, utm_source, utm_medium, referrer_type, conversion_type,
--             landing_page, exit_page, device_type, page_views, start_time
-- =============================================================================

-- 置換用の共通パラメータ（ClickHouse client の query_params で渡す想定）
--   {site_id:String}   例: 'CIP_EcwUTHEZdIOAUqum'
--   {tenant_id:String} 例: 'tenant_xxx'   ← events は tenant_id を持つ。必ず付与。
--   {start:String}     例: '2026-06-10'
--   {end:String}       例: '2026-06-17'
--   {window_sec:UInt32} 例: 1800（30分。セッション内ファネル窓）

-- -----------------------------------------------------------------------------
-- [Q1] 到達数ファネル（windowFunnel）
-- -----------------------------------------------------------------------------
-- ステップ定義（MVP 標準EC ファネル、funnel-config.ts と一致させること）:
--   step1 = pageview (任意ページ = ランディング)
--   step2 = pageview (商品ページ: path LIKE '/p/%' か '/product%')
--   step3 = event_type='conversion' AND conversion_type='add_to_cart'  ← 無ければ click+selector で代替
--   step4 = event_type='conversion' AND conversion_type='purchase'
-- 受け入れ: step1>=step2>=step3>=step4 で単調減少し、step4 が CV 実数と概ね一致。
SELECT
  countIf(reached >= 1) AS step1_sessions,
  countIf(reached >= 2) AS step2_sessions,
  countIf(reached >= 3) AS step3_sessions,
  countIf(reached >= 4) AS step4_sessions,
  round(countIf(reached >= 4) / nullIf(countIf(reached >= 1), 0) * 100, 2) AS overall_cvr_pct
FROM (
  SELECT
    session_id,
    windowFunnel({window_sec:UInt32})(
      toDateTime(timestamp),
      event_type = 'pageview',
      event_type = 'pageview' AND (position(url, '/p/') > 0 OR position(url, '/product') > 0),
      event_type = 'conversion' AND conversion_type = 'add_to_cart',
      event_type = 'conversion' AND conversion_type = 'purchase'
    ) AS reached
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String}
    AND site_id  = {site_id:String}
    AND timestamp >= toDateTime({start:String})
    AND timestamp <  toDateTime({end:String}) + INTERVAL 1 DAY
  GROUP BY session_id
);

-- -----------------------------------------------------------------------------
-- [Q1b] どの conversion_type が実在するか（ステップ定義の現実確認）
-- -----------------------------------------------------------------------------
-- add_to_cart / purchase が無い場合、funnel-config をこのサイトの実値に合わせる必要がある。
SELECT conversion_type, count() AS n
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id  = {site_id:String}
  AND event_type = 'conversion'
  AND timestamp >= toDateTime({start:String})
  AND timestamp <  toDateTime({end:String}) + INTERVAL 1 DAY
GROUP BY conversion_type
ORDER BY n DESC;

-- -----------------------------------------------------------------------------
-- [Q1c] event_type の分布（pageview 以外に何が取れているか）
-- -----------------------------------------------------------------------------
SELECT event_type, count() AS n
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id  = {site_id:String}
  AND timestamp >= toDateTime({start:String})
  AND timestamp <  toDateTime({end:String}) + INTERVAL 1 DAY
GROUP BY event_type
ORDER BY n DESC;

-- -----------------------------------------------------------------------------
-- [Q2] 隣接遷移（Sankey links 用）— セッション内ユニーク・連続重複除去
-- -----------------------------------------------------------------------------
-- パス爆発対策: path 正規化（クエリ削除）→ 連続重複除去 → 隣接ペア集計。
-- 受け入れ: 上位リンクが直感に合う（landing→product→cart→purchase が太い）。
WITH session_paths AS (
  SELECT
    session_id,
    arrayMap(u -> replaceRegexpOne(u, '\\?.*$', ''),
      arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((toDateTime(timestamp), url))))
    ) AS pages
  FROM clickinsight.events
  WHERE tenant_id = {tenant_id:String}
    AND site_id  = {site_id:String}
    AND event_type = 'pageview'
    AND timestamp >= toDateTime({start:String})
    AND timestamp <  toDateTime({end:String}) + INTERVAL 1 DAY
  GROUP BY session_id
),
deduped AS (
  -- 連続重複除去（arrayCompact）→ 隣接ペア生成
  SELECT arrayCompact(pages) AS p FROM session_paths
)
SELECT
  pair.1 AS from_path,
  pair.2 AS to_path,
  count() AS sessions
FROM deduped
ARRAY JOIN arrayZip(arraySlice(p, 1, length(p) - 1), arraySlice(p, 2)) AS pair
WHERE length(p) >= 2
GROUP BY from_path, to_path
HAVING sessions >= 2          -- ノイズ除去
ORDER BY sessions DESC
LIMIT 50;

-- -----------------------------------------------------------------------------
-- [Q3] 流入メディア（step0）— sessions テーブルの first-touch を集計
-- -----------------------------------------------------------------------------
-- 受け入れ: direct 一辺倒に偏らない（utm/referrer_type が機能している）こと。
-- 偏る場合 → step0 を MVP では「coming soon」表示にして他を先行（計画の分岐）。
SELECT
  multiIf(
    utm_source != '' AND utm_medium != '', concat(utm_source, ' / ', utm_medium),
    referrer_type != '', referrer_type,
    'direct / none'
  ) AS source_medium,
  count() AS sessions
FROM clickinsight.sessions
WHERE site_id = {site_id:String}
  AND start_time >= toDateTime({start:String})
  AND start_time <  toDateTime({end:String}) + INTERVAL 1 DAY
GROUP BY source_medium
ORDER BY sessions DESC
LIMIT 20;

-- -----------------------------------------------------------------------------
-- [Q4] ステップ間の摩擦（離脱エリアの観測シグナル）
-- -----------------------------------------------------------------------------
-- 受け入れ: rage_click / dead_click が URL 単位で取れる（heatmap handoff の根拠になる）。
SELECT
  replaceRegexpOne(url, '\\?.*$', '') AS path,
  countIf(event_type = 'rage_click') AS rage_clicks,
  countIf(event_type = 'dead_click') AS dead_clicks,
  uniqExact(session_id) AS sessions
FROM clickinsight.events
WHERE tenant_id = {tenant_id:String}
  AND site_id  = {site_id:String}
  AND event_type IN ('rage_click', 'dead_click')
  AND timestamp >= toDateTime({start:String})
  AND timestamp <  toDateTime({end:String}) + INTERVAL 1 DAY
GROUP BY path
ORDER BY rage_clicks + dead_clicks DESC
LIMIT 20;

-- -----------------------------------------------------------------------------
-- [Q5] CVR 分母の確認（bot 除外・session 定義）
-- -----------------------------------------------------------------------------
-- meta に出す分母を確定する: 全セッション数 vs 流入ありセッション数。
SELECT
  uniqExact(session_id) AS total_sessions,
  uniqExactIf(session_id, conversion_type != '') AS cv_sessions
FROM clickinsight.sessions
WHERE site_id = {site_id:String}
  AND start_time >= toDateTime({start:String})
  AND start_time <  toDateTime({end:String}) + INTERVAL 1 DAY;
