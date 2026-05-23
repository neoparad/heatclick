-- =============================================================================
-- Sprint 0 Migration (PostgreSQL) — ml_prediction_log Tenant Isolation
-- =============================================================================
--
-- 作成日: 2026-05-17
-- 起草: Infrastructure Engineer (Reviewer 2026-05-17 (夜) A-4 schema drift BLOCKER joint 対応)
-- 適用先: linkscrawl PostgreSQL (Hetzner 159.69.95.59:5433, db=linkscrawl)
-- 関連: ml/logging_store.py ensure_tables() の CREATE TABLE 句 (ML Programmer 並走修正)
--
-- なぜ ClickHouse migration (2026-05-17-sprint0-tenant-isolation.sql) と分離するか:
--   ml_prediction_log は PostgreSQL テーブル (BIGSERIAL / TIMESTAMPTZ 使用)。
--   ClickHouse migration script は LowCardinality(String) / MergeTree のため
--   同一ファイル内で混在させると clickhouse-client が PG 句を構文エラー化する。
--   別ファイルとして分離し、psql --file で個別に適用する。
--
-- 親 SSOT:
--   - reviewer.md 2026-05-17 (夜) BLOCKER A-4 (linkscrawl/docs/fusion/team/reviewer.md L115)
--   - decisions.md 2026-05-17 (夜) Reviewer ML T1 dual A-4 (linkscrawl/docs/fusion/team/decisions.md §A-4)
--   - Codex B-4 DDL 草案 Step 1 (tenant_id LowCardinality 追加と同水準の PG 版)
--   - CLAUDE.md 絶対ルール 7 (tenant_id を全 DB 操作・API call で必ず保持・検証)
--
-- 適用順序:
--   Step 1: ml_prediction_log に tenant_id TEXT NOT NULL DEFAULT '__legacy__' 追加
--   Step 2: 既存 index drop + (tenant_id, site_id, prediction_type, created_at) 順に再作成
--   Step 3: ml_session_outcome (もし PostgreSQL 側にもあれば) に tenant_id 追加
--           ※ 実体は ClickHouse 側 (clickinsight.ml_session_outcome) のため通常 PG には無い
--   Step 4: 検証 SELECT
--
-- 実行方法 (Hetzner SSH トンネル経由):
--   ssh -L 5433:127.0.0.1:5433 root@159.69.95.59
--   psql -h localhost -p 5433 -U linkscrawl -d linkscrawl \
--        -f migrations/2026-05-17-sprint0-postgres-ml-tenant.sql
--
-- ロールバック: 末尾の `-- ROLLBACK:` セクション参照。
-- =============================================================================

BEGIN;

-- =============================================================================
-- Step 1: ml_prediction_log に tenant_id 追加
-- =============================================================================
-- 既存データは DEFAULT '__legacy__' で自動充填、ALTER は PG 11+ で fast path
-- (メタデータ更新のみ、既存行に書込しない)
-- =============================================================================

ALTER TABLE IF EXISTS ml_prediction_log
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '__legacy__';

-- =============================================================================
-- Step 2: idx_ml_log_site_type を (tenant_id, site_id, prediction_type, created_at) 順に再作成
-- =============================================================================
-- Reviewer A-4 期待: tenant_id を index 先頭に配置 (tenant 別 query の selectivity 担保)
-- =============================================================================

DROP INDEX IF EXISTS idx_ml_log_site_type;

CREATE INDEX IF NOT EXISTS idx_ml_log_tenant_site_type
    ON ml_prediction_log (tenant_id, site_id, prediction_type, created_at);

-- =============================================================================
-- Step 3: ml_session_outcome に tenant_id 追加 (PostgreSQL 側に存在する場合のみ)
-- =============================================================================
-- 通常 ml_session_outcome は ClickHouse 側 (clickinsight.ml_session_outcome、
-- 2026-05-17-sprint0-tenant-isolation.sql Step 5 で CREATE) だが、
-- linkscrawl PG 側にも別途存在する場合に備え冪等 ALTER を発行。
-- =============================================================================

ALTER TABLE IF EXISTS ml_session_outcome
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '__legacy__';

-- =============================================================================
-- Step 4: 検証 SELECT (適用後に手動で確認)
-- =============================================================================
-- -- tenant_id 列追加確認
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'ml_prediction_log'
--    AND column_name = 'tenant_id';
--
-- -- index 再構築確認
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'ml_prediction_log'
--  ORDER BY indexname;
--
-- -- 既存行が '__legacy__' で埋まったか
-- SELECT tenant_id, COUNT(*) FROM ml_prediction_log GROUP BY tenant_id;

COMMIT;

-- =============================================================================
-- ROLLBACK (緊急時のみ実行)
-- =============================================================================
-- 注意: ml/logging_store.py の ensure_tables() および ML Programmer 修正
--       (mcp_tools/tools.py:1621 log_prediction 呼出に tenant_id 追加) を元に戻した後に実行
-- =============================================================================
--
-- BEGIN;
-- DROP INDEX IF EXISTS idx_ml_log_tenant_site_type;
-- CREATE INDEX IF NOT EXISTS idx_ml_log_site_type
--     ON ml_prediction_log (site_id, prediction_type, created_at);
-- ALTER TABLE IF EXISTS ml_prediction_log DROP COLUMN IF EXISTS tenant_id;
-- ALTER TABLE IF EXISTS ml_session_outcome DROP COLUMN IF EXISTS tenant_id;
-- COMMIT;
-- =============================================================================

-- =============================================================================
-- Step 5 (F-58 v0.2): sites_embeddings テーブル + pgvector + IVFFlat index
-- =============================================================================
-- 起点: PM F-58 v0.2 (linkscrawl/docs/fusion/team/decisions.md 2026-05-17 PM v0.2
--       §3 Infra 責務 (b)、OQ-28 = pgvector 採用)
-- 用途: F-58 サイト分類タクソノミーの SBERT 384 次元 embedding 格納 + 近傍検索
-- 関連 ClickHouse: 2026-05-17-sprint0-tenant-isolation.sql Step 8 (clickinsight.sites
--                  に分類タクソノミー 7 列追加、本テーブルとは site_id で照合)
--
-- 設計判断 (Infra 起票):
--   - SBERT model = paraphrase-multilingual-MiniLM-L12-v2 (PM v0.2 OQ-27 確定、
--     384 次元、多言語日本語対応)
--   - lists = 100: rule of thumb (rows / 1000、最低 100)、Phase 1 100 サイト → Phase 2
--     1000 サイト超で再評価 (REINDEX + WITH 句変更で運用可能)
--   - vector_cosine_ops: cosine similarity (PM v0.2 #4 Evidence 昇格条件 cosine sim ≥ 0.7)
--   - tenant_id 付与: D-tenant-audit-001 整合 + tenant 別検索高速化用 secondary index
--   - primary_industry / confidence は ClickHouse 側 clickinsight.sites と二重化:
--     PG 側でも保持することで、embedding 検索結果に self-contained で
--     industry / confidence を返せる (cross-DB JOIN 回避、読出 latency 短縮)
--
-- 適用先タイミング: Sprint 2 解禁後 (ML BLOCKER 4 件修正完了 + Reviewer T1 再 Pass 後)
--   = ClickHouse Step 8 と同時適用
--
-- 前提: PostgreSQL 16+ + pgvector extension がインストール可能
--   Hetzner PG 確認: psql -c "SELECT version();" + apt-cache search postgresql-*-pgvector
--   未インストールなら apt install postgresql-16-pgvector を先行
-- =============================================================================

BEGIN;

-- pgvector extension 有効化 (要 superuser、Hetzner では postgres user で実行)
CREATE EXTENSION IF NOT EXISTS vector;

-- sites_embeddings テーブル本体
CREATE TABLE IF NOT EXISTS sites_embeddings (
    site_id          TEXT          PRIMARY KEY,
    tenant_id        TEXT          NOT NULL DEFAULT '__legacy__',
    embedding        vector(384)   NOT NULL,
    primary_industry TEXT,
    confidence       REAL          NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- model_version: SBERT model 更新時の再計算判定用 (Phase 1 = 'sbert-multilingual-MiniLM-L12-v2-1.0')
    model_version    TEXT          NOT NULL DEFAULT 'sbert-multilingual-MiniLM-L12-v2-1.0'
);

-- IVFFlat index for cosine similarity nearest-neighbor search
-- 注意: IVFFlat index は CREATE 時点で行が無いと list 中心点を学習できないため、
-- 100 件程度サイト分類が完了した段階で REINDEX 推奨 (Phase 1 中盤、Operator 連絡)
CREATE INDEX IF NOT EXISTS idx_sites_embeddings_ivfflat
    ON sites_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- tenant 別検索の高速化 (D-tenant-audit-001 整合)
CREATE INDEX IF NOT EXISTS idx_sites_embeddings_tenant
    ON sites_embeddings (tenant_id, updated_at DESC);

-- primary_industry 部分文字列検索用 (Marketer UI でカテゴリ別検索想定)
CREATE INDEX IF NOT EXISTS idx_sites_embeddings_industry_trgm
    ON sites_embeddings
    USING gin (primary_industry gin_trgm_ops);
-- 注意: pg_trgm extension が必要 (CREATE EXTENSION IF NOT EXISTS pg_trgm)
-- 上記 trgm index が初回適用で失敗する場合は pg_trgm 未インストール → 別途インストール後再実行

COMMIT;

-- =============================================================================
-- Step 5 検証 SELECT (適用後手動)
-- =============================================================================
-- -- pgvector extension 確認
-- SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
--
-- -- テーブル構造確認
-- \d sites_embeddings
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns WHERE table_name = 'sites_embeddings';
--
-- -- index 確認
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'sites_embeddings';
--
-- -- 近傍検索 smoke test (ML site_classifier.py 着工後)
-- INSERT INTO sites_embeddings (site_id, tenant_id, embedding, primary_industry, confidence)
--   VALUES ('test-001', 't1', '[0.1, 0.2, ...384 次元 ...]'::vector, 'EC アパレル', 0.92);
-- SELECT site_id, primary_industry, 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS cosine_sim
--   FROM sites_embeddings WHERE tenant_id = 't1'
--   ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector LIMIT 10;

-- =============================================================================
-- ROLLBACK Step 5 (緊急時のみ、ML site_classifier.py / sbert.py 巻き戻し後)
-- =============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS idx_sites_embeddings_industry_trgm;
-- DROP INDEX IF EXISTS idx_sites_embeddings_tenant;
-- DROP INDEX IF EXISTS idx_sites_embeddings_ivfflat;
-- DROP TABLE IF EXISTS sites_embeddings;
-- -- DROP EXTENSION vector;   -- 他テーブルが vector 型を使っていないことを確認してから
-- COMMIT;
-- =============================================================================
