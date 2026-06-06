-- ════════════════════════════════════════════════════════════════════
-- Deep Research v1 用 ClickHouse テーブル (analysis_jobs / proposal_tickets)
-- ════════════════════════════════════════════════════════════════════
-- 対象: Hetzner ClickHouse / DB=clickinsight
-- 適用: Infra Engineer が手動で実行 (AI は本番 DDL を適用しない)。
--   ssh root@<host>
--   clickhouse-client --user default --password "$CLICKHOUSE_PASSWORD" \
--     --multiline --multiquery < 2026-06-06-deep-research-tables.sql
--
-- 設計根拠: docs/ai-chat-deep-research-design.md §B。
-- 規約: tenant_id=LowCardinality を ORDER BY 先頭 / ReplacingMergeTree(updated_at) /
--       PARTITION BY toYYYYMM(created_at) / TTL (続 既存 daily_site_summaries・llm_audit_ledger 準拠)。
-- ════════════════════════════════════════════════════════════════════

-- 非同期 Deep Research ジョブのキュー兼ステータス管理。
CREATE TABLE IF NOT EXISTS clickinsight.analysis_jobs
(
  id              UUID DEFAULT generateUUIDv4(),
  tenant_id       LowCardinality(String),
  site_id         String,
  user_id         String,
  job_type        LowCardinality(String),            -- 'deep_research'
  report_type     LowCardinality(String),            -- 'uiux_audit' | 'cta_form_tickets' | 'attention_action_gap'
  status          LowCardinality(String),            -- 'pending' | 'running' | 'completed' | 'failed'
  input_config    String,                            -- JSON (period / filters / requested reports)
  output_results  Nullable(String),                  -- JSON (完了時のみ。実行中は NULL)
  error_message   Nullable(String),
  scheduled_by    LowCardinality(String) DEFAULT 'user_request', -- 'user_request' | 'system_cron'
  model_id        LowCardinality(String) DEFAULT '',
  cost_usd        Float64 DEFAULT 0,
  created_at      DateTime DEFAULT now(),
  started_at      Nullable(DateTime),
  completed_at    Nullable(DateTime),
  updated_at      DateTime DEFAULT now(),             -- ReplacingMergeTree のバージョン列
  duration_seconds Nullable(UInt32),
  INDEX idx_id id TYPE bloom_filter GRANULARITY 1     -- UUID 単体 lookup 用
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, site_id, created_at)
TTL created_at + INTERVAL 180 DAY;

-- Deep Research が生成する改善提案チケット (M Agent 配下で表示・介入の入口)。
-- 冪等キー: (tenant_id, site_id, week, report_type, version) — 同週・同種・同版は dedup。
CREATE TABLE IF NOT EXISTS clickinsight.proposal_tickets
(
  id                UUID DEFAULT generateUUIDv4(),
  tenant_id         LowCardinality(String),
  site_id           String,
  job_id            UUID,
  report_type       LowCardinality(String),
  week              Date,                             -- 集計対象週 (月曜起点等、冪等キー)
  version           UInt16 DEFAULT 1,
  problem           String,
  evidence          String,                          -- JSON (根拠数値 + evidence_level + query_id 参照)
  affected_segment  String,
  recommended_change String,
  confidence        Float32 DEFAULT 0,
  evidence_level    LowCardinality(String),          -- observed_exact|observed_approx|inferred|planned (D-07)
  blocked_claims    Array(String),                   -- データ未計測で言えないこと
  query_refs        Array(String),                   -- 裏取りに使った query / tool 参照
  status            LowCardinality(String) DEFAULT 'open', -- open|accepted|dismissed|shipped
  created_at        DateTime DEFAULT now(),
  updated_at        DateTime DEFAULT now(),           -- ReplacingMergeTree のバージョン列
  INDEX idx_id id TYPE bloom_filter GRANULARITY 1
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, site_id, week, report_type, version)
TTL created_at + INTERVAL 365 DAY;

-- 確認:
--   SHOW CREATE TABLE clickinsight.analysis_jobs;
--   SHOW CREATE TABLE clickinsight.proposal_tickets;
