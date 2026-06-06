-- ════════════════════════════════════════════════════════════════════
-- UGOKI Crawl × UGOKI MAP 融合 v1 — ClickHouse 5 テーブル
-- ════════════════════════════════════════════════════════════════════
-- 対象: Hetzner ClickHouse / DB=clickinsight
-- 適用: Infra/Owner が手動実行 (AI は本番DDLを適用しない)。
--   clickhouse-client --user default --password "$CLICKHOUSE_PASSWORD" \
--     --multiline --multiquery < 2026-06-06-ugokicrawl-fusion-clickhouse.sql
-- 設計: docs/ugokicrawl-fusion-implementation-plan.md / plan (3 Explore + Codex 4 ラウンド)。
-- 規約: tenant_id=LowCardinality を ORDER BY 先頭 / 全表 schema_version /
--       crawl由来の事実は append (MergeTree) でクロール間 diff 可能 / 可変集計は ReplacingMergeTree。
-- 突合キー: セレクタ優先 (selector_hash) + 同 viewport_class 内 y フォールバック。
-- ════════════════════════════════════════════════════════════════════

-- (1) crawl_runs — クロール1実行=1行。最新crawl/在庫/冪等/viewport分離。
CREATE TABLE IF NOT EXISTS clickinsight.crawl_runs
(
  crawl_id        String,
  tenant_id       LowCardinality(String),
  site_id         String,
  viewport_class  LowCardinality(String),          -- 'mobile' | 'desktop'
  status          LowCardinality(String),          -- 'running' | 'completed' | 'failed'
  page_count      UInt32 DEFAULT 0,
  source_job_id   String DEFAULT '',               -- ugokicrawl 側のクロールジョブ
  crawled_at      DateTime,
  ingested_at     DateTime DEFAULT now(),
  updated_at      DateTime DEFAULT now(),           -- ReplacingMergeTree バージョン列
  schema_version  LowCardinality(String) DEFAULT 'v1',
  INDEX idx_crawl_id crawl_id TYPE bloom_filter GRANULARITY 1
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(crawled_at)
ORDER BY (tenant_id, site_id, crawl_id)
TTL crawled_at + INTERVAL 365 DAY;

-- (2) page_content_sections — セクション地図 (crawl毎 append)。クロール間 diff の源泉。
--   text_hash/asset_hash/cta_hash で「文言/画像/ボタンが変わった」を blob 再解析なしでクエリ可。
CREATE TABLE IF NOT EXISTS clickinsight.page_content_sections
(
  crawl_id              String,
  tenant_id             LowCardinality(String),
  site_id               String,
  page_url              String,
  viewport_class        LowCardinality(String),
  section_index         UInt16,
  section_selector      String,                    -- 安定代表セレクタ (突合の主キー的役割)
  section_selector_hash String,
  section_dom_path      String DEFAULT '',
  section_heading       String DEFAULT '',
  y_start               UInt32,
  y_end                 UInt32,
  page_height           UInt32 DEFAULT 0,
  visible_text          String DEFAULT '' CODEC(ZSTD(3)),
  has_cta               UInt8 DEFAULT 0,
  has_price             UInt8 DEFAULT 0,
  word_count            UInt32 DEFAULT 0,
  image_count           UInt16 DEFAULT 0,
  link_count            UInt16 DEFAULT 0,
  text_hash             String DEFAULT '',          -- 文言変更検知
  asset_hash            String DEFAULT '',          -- 画像/メディア変更検知
  cta_hash              String DEFAULT '',          -- CTA(文言/href/有無)変更検知
  crawled_at            DateTime,
  ingested_at           DateTime DEFAULT now(),
  schema_version        LowCardinality(String) DEFAULT 'v1'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(crawled_at)
ORDER BY (tenant_id, site_id, page_url, viewport_class, crawl_id, section_index)
TTL crawled_at + INTERVAL 180 DAY;

-- (3) page_performance — ラボ数値 (LCP/CLS/INP)。数値時系列なので issue 表と分離。
--   実測 RUM (既存 web_vitals) と「ラボ vs 実測」突合できる。
CREATE TABLE IF NOT EXISTS clickinsight.page_performance
(
  crawl_id                  String,
  tenant_id                 LowCardinality(String),
  site_id                   String,
  page_url                  String,
  viewport_class            LowCardinality(String),
  lcp_ms                    UInt32 DEFAULT 0,
  lcp_element_selector      String DEFAULT '',
  lcp_section_selector_hash String DEFAULT '',      -- どの区間が LCP culprit か
  cls_score                 Float32 DEFAULT 0,
  inp_ms                    UInt32 DEFAULT 0,
  ttfb_ms                   UInt32 DEFAULT 0,
  fcp_ms                    UInt32 DEFAULT 0,
  performance_score         UInt8 DEFAULT 0,         -- 0-100
  crawled_at                DateTime,
  ingested_at               DateTime DEFAULT now(),
  schema_version            LowCardinality(String) DEFAULT 'v1'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(crawled_at)
ORDER BY (tenant_id, site_id, page_url, viewport_class, crawl_id)
TTL crawled_at + INTERVAL 180 DAY;

-- (4) page_issues — 定性 findings (SEO/a11y/content/perfしきい値超え)。数値は metric_* で参照。
CREATE TABLE IF NOT EXISTS clickinsight.page_issues
(
  crawl_id              String,
  tenant_id             LowCardinality(String),
  site_id               String,
  page_url              String,
  issue_type            LowCardinality(String),
  issue_code            LowCardinality(String) DEFAULT '',
  issue_category        LowCardinality(String),     -- 'seo' | 'a11y' | 'perf' | 'content'
  severity              LowCardinality(String),     -- 'critical' | 'high' | 'medium' | 'low'
  selector              String DEFAULT '',
  selector_hash         String DEFAULT '',
  section_selector_hash String DEFAULT '',           -- どの区間の問題か (突合用)
  metric_name           LowCardinality(String) DEFAULT '',
  metric_value          Float64 DEFAULT 0,
  metric_unit           LowCardinality(String) DEFAULT '',
  evidence              String DEFAULT '' CODEC(ZSTD(3)),
  recommendation        String DEFAULT '' CODEC(ZSTD(3)),
  detected_at           DateTime,
  ingested_at           DateTime DEFAULT now(),
  schema_version        LowCardinality(String) DEFAULT 'v1'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(detected_at)
ORDER BY (tenant_id, site_id, page_url, crawl_id, issue_category, severity, selector_hash)
TTL detected_at + INTERVAL 180 DAY;

-- (5) section_behavior_summary — 行動を section×時間bucket で事前集計 (チャットが毎回 raw 突合しない)。
CREATE TABLE IF NOT EXISTS clickinsight.section_behavior_summary
(
  tenant_id             LowCardinality(String),
  site_id               String,
  page_url              String,
  viewport_class        LowCardinality(String),
  section_selector_hash String,
  window_start          Date,
  window_grain          LowCardinality(String) DEFAULT 'day',
  reached_sessions      UInt32 DEFAULT 0,
  clicks                UInt32 DEFAULT 0,
  dead_clicks           UInt32 DEFAULT 0,
  rage_clicks           UInt32 DEFAULT 0,
  avg_dwell_ms          Float32 DEFAULT 0,
  avg_scroll_depth      Float32 DEFAULT 0,
  exits                 UInt32 DEFAULT 0,
  conversions           UInt32 DEFAULT 0,
  friction_score        Float32 DEFAULT 0,           -- (dead+rage)/events 等の合成
  match_confidence      Float32 DEFAULT 0,           -- 突合信頼度の平均 (低い行は"裏取り済"表示しない)
  updated_at            DateTime DEFAULT now(),
  schema_version        LowCardinality(String) DEFAULT 'v1'
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(window_start)
ORDER BY (tenant_id, site_id, page_url, viewport_class, section_selector_hash, window_start)
TTL window_start + INTERVAL 365 DAY;

-- ── 既存テーブルへの列追加 (再利用) ──────────────────────────────────
-- page_structure: ページ単位SEO事実。crawl_id/crawled_at を追加して最新クロール特定。
ALTER TABLE clickinsight.page_structure
  ADD COLUMN IF NOT EXISTS crawl_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS viewport_class LowCardinality(String) DEFAULT 'desktop';
-- (crawled_at は page_structure に既存)

-- ml_event_section_map: viewport_class + section_selector_hash を追加 (セレクタ優先突合)。
ALTER TABLE clickinsight.ml_event_section_map
  ADD COLUMN IF NOT EXISTS viewport_class LowCardinality(String) DEFAULT 'desktop',
  ADD COLUMN IF NOT EXISTS section_selector_hash String DEFAULT '';

-- ── 確認 ──────────────────────────────────────────────────────────
-- SELECT name, engine, sorting_key FROM system.tables
--   WHERE database='clickinsight'
--     AND name IN ('crawl_runs','page_content_sections','page_performance','page_issues','section_behavior_summary');
--
-- ── grants (別途 Infra/Owner、GRANT=アクセス制御変更で AI は実行しない) ──
-- GRANT SELECT ON clickinsight.crawl_runs, clickinsight.page_content_sections,
--   clickinsight.page_performance, clickinsight.page_issues, clickinsight.section_behavior_summary
--   TO analytics_reader;
-- GRANT INSERT, SELECT ON clickinsight.crawl_runs, clickinsight.page_content_sections,
--   clickinsight.page_performance, clickinsight.page_issues, clickinsight.section_behavior_summary
--   TO chat_writer;
