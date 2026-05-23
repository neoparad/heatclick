-- =============================================================================
-- Sprint 0 Migration — Tenant Isolation + New Tables
-- =============================================================================
--
-- 作成日: 2026-05-17
-- 起草: Codex B-4 (2026-05-16 dual review 草案、Director 統合)
-- 適用先: Hetzner ClickHouse 24.x (clickinsight + competinsight databases)
--
-- 親 SSOT:
--   - §3.2.1 ClickHouse 主要テーブル 10 + 新規 5
--   - §3.8.1 Multi-tenant Isolation (3 層防御の DB 層)
--   - §3.9.4 sessions.persona_id 列追加
--   - §6.3 Sprint 0 S0-05
--
-- 改訂履歴:
--   2026-05-17: Codex B-4 草案統合 (10 tables × 2 DB)
--   2026-05-18: Director 続 34 §3.1 で sites table を Step 1 範囲に追加 (R7-1/R7-4/R7-5
--               一括解消、worker.ts L311-316 lookupTenantBySiteId 整合)。Step 1 = 11 tables × 2 DB.
--
-- 適用順序:
--   Step 1: 既存 11 テーブル × 2 DB に tenant_id 追加 (LowCardinality, DEFAULT '__legacy__')
--           (sites 含む、Director 続 34 §3.1 で追加)
--   Step 2: clickinsight.sessions に persona_id 追加 (Nullable)
--   Step 3: clickinsight.audit_events CREATE
--   Step 4: clickinsight.user_outcomes CREATE
--   Step 5: clickinsight.ml_session_outcome CREATE
--   Step 6: clickinsight.banner_decisions CREATE (Phase 3 予約)
--   Step 7: clickinsight.persona_sessions CREATE (Phase 3 予約)
--
-- 実行方法:
--   Infrastructure Engineer が SSH トンネル経由で 1 step ずつ適用:
--     ssh -L 8123:127.0.0.1:8123 root@159.69.95.59
--     clickhouse-client --host localhost --port 8123 \
--       --user default --password $CLICKHOUSE_PASSWORD \
--       --multiline --multiquery < migrations/2026-05-17-sprint0-tenant-isolation.sql
--
-- ロールバック: 末尾の `-- ROLLBACK:` セクション参照。
-- =============================================================================

-- =============================================================================
-- Step 1: 既存 11 テーブル × 2 DB に tenant_id 追加
-- =============================================================================
-- 既存データは自動的に '__legacy__' で埋まる (DEFAULT 句)
-- ALTER ADD COLUMN はメタデータ変更のみで通常 < 1 秒、既存データに書き込まない
-- 2026-05-18: sites table 追加 (Director 続 34 §3.1、R7-1/R7-4/R7-5 一括解消)
-- =============================================================================

-- clickinsight 側
ALTER TABLE IF EXISTS clickinsight.events
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.sessions
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.behavior_signals
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.web_vitals
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.scroll_timeline
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.element_visibility_v2
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.image_visibility
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.form_interactions
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.video_events
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS clickinsight.prediction_log
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';

-- sites table (Director 続 34 §3.1 で Step 1 範囲拡張、R7-1/R7-4/R7-5 一括解消)
-- 起点: Reviewer 続 33 §2.4 R7-4 + Director 続 34 §3.1
-- 理由: worker.ts L311-316 `lookupTenantBySiteId` が SELECT tenant_id FROM sites を依存。
--       sites に tenant_id 列無いと worker.ts deploy 後 100% reject (R7-1)。
-- backfill 経路: R6 Operator で `UPDATE sites SET tenant_id = 'linkth_internal' WHERE id IN (...)`
--                (Director 続 34 §3.4 mapping、4 sites を `linkth_internal` 化)
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';

-- competinsight 側 (存在する場合のみ適用)
ALTER TABLE IF EXISTS competinsight.events
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.sessions
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.behavior_signals
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.web_vitals
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.scroll_timeline
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.element_visibility_v2
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.image_visibility
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.form_interactions
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.video_events
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';
ALTER TABLE IF EXISTS competinsight.prediction_log
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';

-- competinsight.sites (存在する場合のみ適用、Director 続 34 §3.1 整合)
ALTER TABLE IF EXISTS competinsight.sites
    ADD COLUMN IF NOT EXISTS tenant_id LowCardinality(String) DEFAULT '__legacy__';

-- =============================================================================
-- Step 1.5: events に削除 API 用識別子列追加 (Codex Round 8 Fix 1)
-- =============================================================================
-- 削除請求 API (§3.8.3) は user_id / external_id / ga_client_id 指定で物理削除する。
-- 既存 events DDL にこれらが無いと削除 API が機能しないため Sprint 0 で追加必須。
-- =============================================================================

ALTER TABLE IF EXISTS clickinsight.events
    ADD COLUMN IF NOT EXISTS user_id Nullable(String);
ALTER TABLE IF EXISTS clickinsight.events
    ADD COLUMN IF NOT EXISTS external_id Nullable(String);
ALTER TABLE IF EXISTS clickinsight.events
    ADD COLUMN IF NOT EXISTS ga_client_id Nullable(String);

ALTER TABLE IF EXISTS clickinsight.sessions
    ADD COLUMN IF NOT EXISTS user_id Nullable(String);
ALTER TABLE IF EXISTS clickinsight.sessions
    ADD COLUMN IF NOT EXISTS external_id Nullable(String);
ALTER TABLE IF EXISTS clickinsight.sessions
    ADD COLUMN IF NOT EXISTS ga_client_id Nullable(String);

-- behavior_signals 等の他テーブルは session_id 経由で sessions と JOIN で解決可能
-- (削除時は user_id → session_ids → 全テーブル DELETE WHERE session_id IN (...))

-- =============================================================================
-- Step 2: sessions に persona_id 追加 (Phase 3 §3.9.4 の足場)
-- =============================================================================
ALTER TABLE IF EXISTS clickinsight.sessions
    ADD COLUMN IF NOT EXISTS persona_id Nullable(String);

ALTER TABLE IF EXISTS competinsight.sessions
    ADD COLUMN IF NOT EXISTS persona_id Nullable(String);

-- =============================================================================
-- Step 3: audit_events 作成 (§3.8.5)
-- =============================================================================
-- 全 API call の監査ログ。プラン別 TTL (Growth 30d / Agency 365d / Enterprise 100y)
-- =============================================================================

CREATE TABLE IF NOT EXISTS clickinsight.audit_events
(
    id              UUID                     DEFAULT generateUUIDv4(),
    tenant_id       LowCardinality(String),
    user_id         String,
    action          LowCardinality(String),  -- e.g., 'api.heatmap.read', 'auth.login'
    resource        String,                  -- e.g., site_id, session_id
    ip_anonymized   String,
    user_agent      String,
    request_id      String,
    response_status UInt16,
    plan_tier       LowCardinality(String)   DEFAULT 'Growth',
    timestamp       DateTime                 DEFAULT now(),
    metadata        String                   DEFAULT '{}'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp)
TTL
    timestamp + INTERVAL 30 DAY DELETE WHERE plan_tier = 'Growth',
    timestamp + INTERVAL 365 DAY DELETE WHERE plan_tier = 'Agency',
    timestamp + INTERVAL 100 YEAR DELETE WHERE plan_tier = 'Enterprise';

-- =============================================================================
-- Step 4: user_outcomes 作成 (§3.2.1)
-- =============================================================================
-- session_id → CV / 離脱 outcome 紐付け。outcome_collector が書き込む。
-- =============================================================================

CREATE TABLE IF NOT EXISTS clickinsight.user_outcomes
(
    tenant_id    LowCardinality(String),
    site_id      String,
    session_id   String,
    outcome_type Enum8('cv' = 1, 'bounce' = 2, 'continue' = 3, 'unknown' = 4),
    outcome_value Float64 DEFAULT 0,
    timestamp    DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, session_id, timestamp);

-- =============================================================================
-- Step 5: ml_session_outcome 作成 (linkscrawl/ml/logging_store.py 互換)
-- =============================================================================
-- ML 学習用 outcome データ。prediction_log との JOIN を想定。
-- ReplacingMergeTree で session_id × page_url 単位の最新値を保持。
-- =============================================================================

CREATE TABLE IF NOT EXISTS clickinsight.ml_session_outcome
(
    id                       UUID          DEFAULT generateUUIDv4(),
    created_at               DateTime      DEFAULT now(),
    updated_at               DateTime      DEFAULT now(),
    tenant_id                LowCardinality(String) DEFAULT '__legacy__',
    site_id                  String,
    session_id               String,
    page_url                 String        DEFAULT '',

    -- 変換 outcome
    converted                Bool          DEFAULT false,
    micro_conversions        String        DEFAULT '{}',

    -- スクロール / 滞在パターン
    scroll_pattern           LowCardinality(String) DEFAULT '',
    total_duration_sec       Nullable(Float64),
    total_pages              Nullable(UInt32),
    revisit_count            Nullable(UInt32),
    max_scroll_depth         Nullable(Float64),
    scroll_up_count          Nullable(UInt32),

    -- 視認 / クリック履歴
    viewed_images            String        DEFAULT '[]',
    clicked_elements         String        DEFAULT '[]',
    read_sections            String        DEFAULT '[]',

    -- 異常クリック
    rage_click_positions     String        DEFAULT '[]',
    dead_click_positions     String        DEFAULT '[]',
    confusion_scrolls        Nullable(UInt32),

    -- 離脱情報
    exit_y_coordinate        Nullable(Float64),
    exit_content_type        LowCardinality(String) DEFAULT 'unknown',
    exit_behavior            LowCardinality(String) DEFAULT '',
    exit_after_sec           Nullable(Float64),

    -- SEO / 品質スコア
    pagerank                 Nullable(Float64),
    click_depth              Nullable(UInt32),
    source_pagerank          Nullable(Float64),
    lcp                      Nullable(Float64),
    cls                      Nullable(Float64),
    psi_score_mobile         Nullable(UInt16),
    image_optimization_score Nullable(Float64),
    vision_labels            String        DEFAULT '[]',

    -- prediction_log JOIN 用外部キー
    outcome_id               Nullable(UInt64)
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, site_id, session_id, page_url);

-- =============================================================================
-- Step 6: banner_decisions 予約テーブル (§3.9.4 Phase 3 用、Phase 1 は名前空間確保)
-- =============================================================================

CREATE TABLE IF NOT EXISTS clickinsight.banner_decisions
(
    tenant_id   LowCardinality(String),
    site_id     String,
    session_id  String,
    decision_id UUID     DEFAULT generateUUIDv4(),
    created_at  DateTime DEFAULT now(),
    _reserved   String   DEFAULT '' COMMENT 'Phase 3 expansion: variant_id, reason, evidence_level, action_ticket_id, model_used, cost_usd'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, site_id, session_id, decision_id);

-- =============================================================================
-- Step 7: persona_sessions 予約テーブル (§3.9.4 Phase 3 用)
-- =============================================================================
-- Phase 1 では sessions.persona_id 列追加で代替、persona_sessions は名前空間確保のみ
-- =============================================================================

CREATE TABLE IF NOT EXISTS clickinsight.persona_sessions
(
    tenant_id  LowCardinality(String),
    site_id    String,
    session_id String,
    persona_id String,
    created_at DateTime DEFAULT now(),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, site_id, session_id);

-- =============================================================================
-- 検証クエリ — 各 Step 後に実行
-- =============================================================================

-- Step 1 検証: tenant_id 追加確認
-- SELECT database, table, name, type
-- FROM system.columns
-- WHERE database IN ('clickinsight', 'competinsight')
--   AND name = 'tenant_id'
-- ORDER BY database, table;

-- Step 2 検証: persona_id 追加確認
-- SELECT database, table, name, type
-- FROM system.columns
-- WHERE database IN ('clickinsight', 'competinsight')
--   AND table = 'sessions'
--   AND name IN ('tenant_id', 'persona_id')
-- ORDER BY database, name;

-- Step 3-7 検証: 各テーブル作成確認
-- SELECT database, table, engine, partition_key, sorting_key
-- FROM system.tables
-- WHERE database = 'clickinsight'
--   AND table IN ('audit_events', 'user_outcomes', 'ml_session_outcome', 'banner_decisions', 'persona_sessions')
-- ORDER BY table;

-- 既存データ件数照合 (ALTER 前後で照合)
-- SELECT database, table, sum(rows) AS active_rows
-- FROM system.parts
-- WHERE active
--   AND database IN ('clickinsight', 'competinsight')
--   AND table IN (
--       'events','sessions','behavior_signals','web_vitals',
--       'scroll_timeline','element_visibility_v2','image_visibility',
--       'form_interactions','video_events','prediction_log'
--   )
-- GROUP BY database, table
-- ORDER BY database, table;

-- =============================================================================
-- ROLLBACK (緊急時のみ実行)
-- =============================================================================
-- 注意: ロールバックは Worker のデプロイバージョンを元に戻した後に実行すること。
-- 順序: 7 → 6 → 5 → 4 → 3 → 2 → 1 (作成順の逆)
-- =============================================================================
--
-- DROP TABLE IF EXISTS clickinsight.persona_sessions;
-- DROP TABLE IF EXISTS clickinsight.banner_decisions;
-- DROP TABLE IF EXISTS clickinsight.ml_session_outcome;
-- DROP TABLE IF EXISTS clickinsight.user_outcomes;
-- DROP TABLE IF EXISTS clickinsight.audit_events;
--
-- ALTER TABLE IF EXISTS clickinsight.sessions DROP COLUMN IF EXISTS persona_id;
-- ALTER TABLE IF EXISTS competinsight.sessions DROP COLUMN IF EXISTS persona_id;
--
-- ALTER TABLE IF EXISTS clickinsight.events DROP COLUMN IF EXISTS tenant_id;
-- ... (全 10 × 2 テーブル繰り返し)
-- =============================================================================

-- =============================================================================
-- 関連 migration (PostgreSQL 側、Reviewer A-4 joint 対応)
-- =============================================================================
-- ml_prediction_log は PostgreSQL テーブル (BIGSERIAL / TIMESTAMPTZ) のため
-- 本 ClickHouse migration には含めず、別ファイル分離:
--   migrations/2026-05-17-sprint0-postgres-ml-tenant.sql
--
-- 適用順序: ClickHouse 側 (本ファイル) → PostgreSQL 側 (別ファイル)
-- 双方完了 = Sprint 0 S0-05 完了基準達成
--
-- 起点: Reviewer 2026-05-17 (夜) BLOCKER A-4 schema drift
-- =============================================================================

-- =============================================================================
-- Step 8 (F-58 v0.2): clickinsight.sites に分類タクソノミー 7 列追加
-- =============================================================================
-- 起点: PM F-58 v0.2 (本 decisions.md 2026-05-17 PM v0.2 §3 Infra 責務 (a))
-- 対象: clickinsight.sites (linkscrawl/ml/pipeline.py:204 で既参照、既存テーブル)
-- 関連 PG migration (sites_embeddings + pgvector): 2026-05-17-sprint0-postgres-ml-tenant.sql Step 5
--
-- 設計判断 (Infra 起票):
--   - classified_by を Enum でなく LowCardinality(String) に変更:
--     Enum は値追加に ALTER MODIFY COLUMN 必須 (重操作)、LowCardinality(String)
--     なら値追加自由 + 内部ストレージ効率はほぼ同等
--   - business_model_tags / revenue_model_tags は Array(LowCardinality(String)) で
--     multi-select tag を表現 (cardinality 数十〜数百想定、LowCardinality 適合)
--   - confidence は Float32 (Float64 不要、精度 0.001 で十分)
--   - last_confirmed_at は分類更新と分離 (顧客が「内容変わってない」確認だけのケース対応)
--
-- 適用先タイミング: Sprint 2 解禁後 (ML BLOCKER 4 件修正完了 + Reviewer T1 再 Pass 後)
--   = sites_embeddings (PG 側) と同時適用
-- =============================================================================

ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS primary_industry String DEFAULT '';
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS business_model_tags Array(LowCardinality(String)) DEFAULT [];
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS revenue_model_tags Array(LowCardinality(String)) DEFAULT [];
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS confidence Float32 DEFAULT 0;
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS classified_at DateTime64(3) DEFAULT toDateTime64(0, 3);
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS classified_by LowCardinality(String) DEFAULT '';
ALTER TABLE IF EXISTS clickinsight.sites
    ADD COLUMN IF NOT EXISTS last_confirmed_at DateTime64(3) DEFAULT toDateTime64(0, 3);

-- =============================================================================
-- Step 8 検証 SELECT (適用後手動)
-- =============================================================================
-- -- 7 列追加確認
-- SELECT name, type, default_expression
--   FROM system.columns
--  WHERE database = 'clickinsight' AND table = 'sites'
--    AND name IN ('primary_industry', 'business_model_tags', 'revenue_model_tags',
--                 'confidence', 'classified_at', 'classified_by', 'last_confirmed_at')
--  ORDER BY name;
--
-- -- classified_by の実値分布 (運用後)
-- SELECT classified_by, COUNT(*) FROM clickinsight.sites GROUP BY classified_by;

-- =============================================================================
-- ROLLBACK Step 8 (緊急時のみ、ML site_classifier.py 巻き戻し後)
-- =============================================================================
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS last_confirmed_at;
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS classified_by;
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS classified_at;
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS confidence;
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS revenue_model_tags;
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS business_model_tags;
-- ALTER TABLE IF EXISTS clickinsight.sites DROP COLUMN IF EXISTS primary_industry;
-- =============================================================================
