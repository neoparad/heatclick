-- =============================================================================
-- P1b Migration (PostgreSQL) — Auth version-bump triggers (REQ-SEC-129)
-- =============================================================================
--
-- 作成日: 2026-06-08
-- 起草: Director (Codex T1 review HIGH「version bump が authority 変更で強制されない」対応)
-- 適用先: P1 と同じ Supabase 認証 DB (Direct connection :5432 で実行)
-- 前提: 2026-06-08-auth-postgres-p1.sql 適用済み
--
-- 目的 (REQ-SEC-129 / §13.7 P1.5 gate):
--   role 変更などの authority 変更時に membership_version を**必ず**増分し、
--   Layer 2 (getServerSession) の失効照合を確実に効かせる。手動 UPDATE / seed /
--   将来の admin API のどの経路で role が変わっても、アプリ実装に依存せず DB が増分する。
--
-- スコープ:
--   - memberships.role が実際に変化したとき membership_version += 1。
--   - (site 付与変更 = tenant_sites の増減は site_ids が tenant 単位のため、当該テナントの
--     全 membership を bump する必要がある。これは件数とロック範囲が大きいので P2 admin API
--     側で明示的に実行する方針とし、本トリガには含めない。§13.7 REQ-SEC-129 に記載。)
--
-- ⚠ 影響: 本トリガ適用後に seed を再実行すると、role が同値なら bump されない
--   (IS DISTINCT FROM 判定)。role を変える更新のみ version が進む = 意図通り。
--
-- 実行: psql "<Direct :5432>" -f migrations/2026-06-08-auth-postgres-p1b-version-triggers.sql
--   (DDL 適用は Owner/Infra。db モード本番投入 = P1.5 の一部として実行)
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION bump_membership_version_on_role_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.membership_version := OLD.membership_version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memberships_role_version ON memberships;
CREATE TRIGGER trg_memberships_role_version
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION bump_membership_version_on_role_change();

COMMIT;

-- =============================================================================
-- 検証 (適用後)
-- =============================================================================
-- -- role を変えると version が +1 されるか
-- SELECT user_id, role, membership_version FROM memberships WHERE user_id='usr_owner_001';
-- UPDATE memberships SET role='admin' WHERE user_id='usr_owner_001' AND tenant_id='linkth_internal';
-- SELECT user_id, role, membership_version FROM memberships WHERE user_id='usr_owner_001'; -- version +1
-- UPDATE memberships SET role='owner' WHERE user_id='usr_owner_001' AND tenant_id='linkth_internal'; -- 元に戻す (version さらに +1)

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_memberships_role_version ON memberships;
-- DROP FUNCTION IF EXISTS bump_membership_version_on_role_change();
-- COMMIT;
-- =============================================================================
