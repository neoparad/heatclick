-- =============================================================================
-- 宝プロジェクト — 標準実験 registry + 横断プール corpus (PostgreSQL / Supabase)
-- =============================================================================
--
-- 作成日: 2026-06-10
-- 起草: feature/standard-ab-pooling (標準2案A/B × k匿名横断プール)
-- 親 SSOT:
--   - linkscrawl/docs/fusion/team/handoff/2026-06-10-ugokimap-treasure-ab-pooling-module.md
--   - linkscrawl/docs/fusion/team/decisions.md D-12 (§1.7.1 carve-out: mechanical 標準実験のみ自前実行)
--   - CLAUDE.md 絶対ルール 7 / §3.8.1 multi-tenant isolation (全 DB 操作で tenant_id 保持・検証)
--
-- 目的:
--   1. experiments — テナント所有の標準実験 registry。locked taxonomy (事前登録) を列で保持。
--   2. experiment_pool_cells — k匿名で全顧客横断プールした「効く施策」corpus (= 宝の本体)。
--
-- 接続先 (Owner 2026-06-10 決定 = (A) 既存 auth Supabase 相乗り):
--   - EXPERIMENTS_DATABASE_URL 優先、未設定時は AUTH_DATABASE_URL にフォールバック (lib/experiments/db.ts)。
--   - auth tenants / tenant_sites が同一 DB にあるため (tenant_id, site_id) を tenant_sites に FK 参照。
--   - 将来 (B) 専用インスタンスへ分離する場合は inline FK を外し EXPERIMENTS_DATABASE_URL を別 PG に向ける。
--
-- 前提: 本 DDL は auth migration (2026-06-08-auth-postgres-p1.sql) 適用後・同一 DB に適用する
--       (tenants / tenant_sites を FK 参照するため)。tenant_sites は experiments 利用テナント分を seed 済とする。
--
-- 適用 (DDL 実行は Owner/Infra。AI は実行しない — 既存ルール):
--   方法A (psql):  psql "<Direct connection :5432>" -f migrations/2026-06-10-experiments-registry.sql
--   方法B (UI):    Supabase Dashboard → SQL Editor に貼り付け
--
-- レビュー: T1 (registry/migration) = Claude + Codex dual review 反映済 (CRITICAL/HIGH 対応)。
-- ロールバック: 末尾 `-- ROLLBACK:` 参照。
-- =============================================================================

BEGIN;

-- =============================================================================
-- experiments — 標準実験 1 行 (テナント所有)
--   locked taxonomy = intervention_type / page_type / industry / device /
--   primary_metric / window_code。running 遷移時にロックし以後不変 (事前登録)。
--   多層防御: app 層 (lib/experiments/types.ts assertLockedFieldsUnchanged) +
--             DB トリガ (trg_experiments_enforce_lock、下記) の二重で immutability を強制。
--   ※ taxonomy enum の authoritative source は lib/experiments/taxonomy.ts。
--     DB CHECK は status / 数値不変条件のみ (TS enum との drift を避け、列値検証は Zod 境界に集約)。
-- =============================================================================
CREATE TABLE IF NOT EXISTS experiments (
    id                TEXT        PRIMARY KEY,                 -- uuid v4
    tenant_id         TEXT        NOT NULL,                    -- §3.8.1: 全 query で WHERE 必須
    site_id           TEXT        NOT NULL,                    -- ClickHouse site_id (CIP_xxxx)
    name              TEXT        NOT NULL,
    url_pattern       TEXT        NOT NULL,                    -- ITT 分母: 実験ページの absolute path prefix

    -- locked taxonomy (事前登録の心臓)
    intervention_type TEXT        NOT NULL,                    -- mechanical のみ (taxonomy.ts)
    page_type         TEXT        NOT NULL,
    industry          TEXT        NOT NULL,
    device            TEXT        NOT NULL,                    -- mobile|desktop|tablet (unknown 不可)
    primary_metric    TEXT        NOT NULL,                    -- cvr|cta_click_rate|form_submit_rate
    window_code       TEXT        NOT NULL,                    -- 14d|28d|56d (列名は SQL 予約語 WINDOW 回避)

    status            TEXT        NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','running','stopped','archived')),
    start_at          TIMESTAMPTZ,                             -- 計測期間 (running で確定)
    end_at            TIMESTAMPTZ,
    salt_version      INTEGER     NOT NULL DEFAULT 1 CHECK (salt_version >= 1),  -- 割付 salt ローテーション

    -- consent (k匿名横断プール参加)
    pool_opt_in       BOOLEAN     NOT NULL DEFAULT false,
    k_anonymity_min   INTEGER     NOT NULL DEFAULT 50 CHECK (k_anonymity_min >= 50),

    created_by        TEXT        NOT NULL,
    locked_at         TIMESTAMPTZ,                             -- draft→running で刻む (taxonomy ロック時刻)
    stopped_at        TIMESTAMPTZ,
    archived_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- (tenant_id, site_id) が tenant_sites に存在する = 当該テナントが所有する site のみ実験可
    -- (Codex HIGH: site 所有未証明による別テナント site への登録 = プール汚染を封じる)。
    -- tenant_sites.tenant_id → tenants(id) なので tenant 存在も transitively 保証。
    CONSTRAINT experiments_tenant_site_fk
        FOREIGN KEY (tenant_id, site_id) REFERENCES tenant_sites (tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT experiments_dates_order
        CHECK (start_at IS NULL OR end_at IS NULL OR start_at < end_at)
);

-- tenant 隔離 + list 高速化 (§3.8.1)
CREATE INDEX IF NOT EXISTS idx_experiments_tenant_site ON experiments (tenant_id, site_id);
-- pooling: セル次元での横断集計を高速化 (計測対象 = running/stopped のみ)
CREATE INDEX IF NOT EXISTS idx_experiments_cell
    ON experiments (intervention_type, page_type, industry, device, primary_metric)
    WHERE status IN ('running', 'stopped');

-- 事前登録 immutability を DB 層でも強制 (Codex HIGH: store 直叩き / 生 SQL でも locked field を守る)。
-- running 以降 (status <> 'draft') に taxonomy / url_pattern / salt_version を変えたら例外。
CREATE OR REPLACE FUNCTION experiments_enforce_lock() RETURNS trigger AS $$
BEGIN
    IF OLD.status <> 'draft' THEN
        IF NEW.intervention_type <> OLD.intervention_type
            OR NEW.page_type      <> OLD.page_type
            OR NEW.industry       <> OLD.industry
            OR NEW.device         <> OLD.device
            OR NEW.primary_metric <> OLD.primary_metric
            OR NEW.window_code    <> OLD.window_code
            OR NEW.url_pattern    <> OLD.url_pattern
            OR NEW.salt_version   <> OLD.salt_version THEN
            RAISE EXCEPTION 'experiment % locked fields are immutable once running (status=%)', OLD.id, OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_experiments_enforce_lock ON experiments;
CREATE TRIGGER trg_experiments_enforce_lock
    BEFORE UPDATE ON experiments
    FOR EACH ROW EXECUTE FUNCTION experiments_enforce_lock();

-- =============================================================================
-- experiment_pool_cells — k匿名横断プール corpus (= 宝の本体)
--   セル = intervention_type × page_type × industry × device (handoff)。metric 混在を防ぐため
--   PK に primary_metric を含める。DerSimonian-Laird + Knapp-Hartung の pooled 結果と
--   異質性 (τ²/I²) を保存。
--
--   二層しきい値 (handoff §マイルストーン4「K≈24〜50 で宝の1行目」+ 鉄則「k≥50 匿名・同意」):
--     - 行の存在 ⟺ k_sites >= 24  … 「効く傾向 (CI下限>0)」を計算してよい統計 floor。
--       sub-24 のノイズ行は corpus に入れない (CHECK で強制)。
--     - meets_k50 = (k_sites >= 50) … **cross-customer 開示・集約の同意/匿名ゲート**。
--       顧客へサイト数や pooled 値を開示・共有するのは meets_k50 かつ consent 済のセルのみ
--       (開示ゲートは M4/M5 の query 層で適用)。
--   ※ cross-tenant 集約。**tenant_id / visitor_id は持たない** (k匿名境界)。per-site の生値はここに永続化しない。
-- =============================================================================
CREATE TABLE IF NOT EXISTS experiment_pool_cells (
    cell_key          TEXT        NOT NULL,                    -- 'intervention|page|industry|device'
    intervention_type TEXT        NOT NULL,
    page_type         TEXT        NOT NULL,
    industry          TEXT        NOT NULL,
    device            TEXT        NOT NULL,
    primary_metric    TEXT        NOT NULL,

    k_sites           INTEGER     NOT NULL CHECK (k_sites >= 24),  -- K (効く傾向の統計 floor = 24)
    total_sessions    BIGINT      NOT NULL DEFAULT 0,

    pooled_log_rr     DOUBLE PRECISION,                        -- DL+KH pooled logRR
    ci_low            DOUBLE PRECISION,
    ci_high           DOUBLE PRECISION,
    tau2              DOUBLE PRECISION,                        -- 異質性 τ² (必須保存)
    i2                DOUBLE PRECISION,                        -- 異質性 I²  (必須保存、0..1)

    meets_k50         BOOLEAN     NOT NULL DEFAULT false,      -- 開示・集約の同意/匿名ゲート
    method            TEXT        NOT NULL DEFAULT 'DL+KH',    -- DerSimonian-Laird + Knapp-Hartung
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (cell_key, primary_metric),
    -- フラグが k_sites と矛盾しないことを保証 (Codex CRITICAL: フラグ詐称防止)
    CONSTRAINT pool_cells_k50_flag CHECK (meets_k50 = (k_sites >= 50))
);

COMMIT;

-- =============================================================================
-- 検証 SELECT (適用後に手動確認)
-- =============================================================================
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema='public' AND table_name IN ('experiments','experiment_pool_cells')
--  ORDER BY table_name;
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_experiments_enforce_lock';

-- =============================================================================
-- ROLLBACK (緊急時のみ)
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS experiment_pool_cells;
-- DROP TRIGGER IF EXISTS trg_experiments_enforce_lock ON experiments;
-- DROP FUNCTION IF EXISTS experiments_enforce_lock();
-- DROP TABLE IF EXISTS experiments;
-- COMMIT;
-- =============================================================================
