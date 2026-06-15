-- =============================================================================
-- 宝プロジェクト M6 — experiments.render_config 追加 (additive)
-- =============================================================================
--
-- 作成日: 2026-06-11 / 起草: feature/standard-ab-pooling (Owner 承認 Option A)
-- 前提: migrations/2026-06-10-experiments-registry.sql 適用済み。
--
-- 目的: treatment が顧客サイトで適用する mechanical 操作のパラメータを registry に保持。
--   - 形は lib/experiments/types.ts RenderConfigSchema (Zod) が authoritative:
--       {"kind":"cta","cta_selector":"..."} | {"kind":"form_fields","field_selectors":[...]}
--   - **任意 HTML は保持しない** — CSS selector のみ (experiment-runtime.js は既存要素の
--     移動/クローン/表示切替だけを行う)。
--   - NULL = レンダリングなし (実質 A/A、計測のみ)。
--   - running 以降は不変 (locked field)。app 層 (assertLockedFieldsUnchanged) + 下記トリガ更新の
--     多層防御。
--
-- 適用 (DDL 実行は Owner/Infra。AI は実行しない):
--   psql "<Direct connection :5432>" -f migrations/2026-06-11-experiments-render-config.sql
-- =============================================================================

BEGIN;

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS render_config JSONB;

-- 事前登録 immutability トリガを render_config 込みで更新 (2026-06-10 版を置換)。
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
            OR NEW.salt_version   <> OLD.salt_version
            OR NEW.render_config  IS DISTINCT FROM OLD.render_config THEN
            RAISE EXCEPTION 'experiment % locked fields are immutable once running (status=%)', OLD.id, OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- 検証:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='experiments' AND column_name='render_config';

-- ROLLBACK (緊急時のみ):
-- BEGIN;
-- ALTER TABLE experiments DROP COLUMN IF EXISTS render_config;
-- (トリガ関数は 2026-06-10 版の定義を再適用)
-- COMMIT;
