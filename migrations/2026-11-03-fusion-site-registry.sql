-- =============================================================================
-- P1 Fusion Migration (PostgreSQL) — Site Registry Extension on tenant_sites
-- =============================================================================
--
-- 作成日: 2026-11-03
-- 目的:
--   ugokimap (tracking_id: CIP_xxxx)・linkscrawl (host / job_id)・
--   AIreceipt (collector site_id / install_id)・GSC (property) の「サイトの呼び名」を
--   tenant_sites テーブルの1行に束ね、融合SaaS全体のサイト台帳 (Control Plane) とする。
--
-- 前提:
--   migrations/2026-06-08-auth-postgres-p1.sql 適用後 (tenant_sites が存在すること)。
--   AI は本番 DDL を自動実行しない (Owner/Infra が適用)。
-- =============================================================================

BEGIN;

ALTER TABLE tenant_sites
  ADD COLUMN IF NOT EXISTS site_name            TEXT,
  ADD COLUMN IF NOT EXISTS site_url             TEXT,
  ADD COLUMN IF NOT EXISTS canonical_host       TEXT,
  ADD COLUMN IF NOT EXISTS linkscrawl_host      TEXT,
  ADD COLUMN IF NOT EXISTS linkscrawl_job_id    TEXT,
  ADD COLUMN IF NOT EXISTS aireceipt_site_id    TEXT,
  ADD COLUMN IF NOT EXISTS aireceipt_install_id TEXT,
  ADD COLUMN IF NOT EXISTS gsc_property         TEXT,
  ADD COLUMN IF NOT EXISTS gsc_sitemap_url      TEXT,
  ADD COLUMN IF NOT EXISTS cf_zone_id           TEXT,
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT now();

-- 逆引き・一意性インデックス (NULL 以外の時に他テナント/他サイトと重複しないことを保証)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_sites_aireceipt_site
  ON tenant_sites (aireceipt_site_id)
  WHERE aireceipt_site_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_sites_aireceipt_install
  ON tenant_sites (aireceipt_install_id)
  WHERE aireceipt_install_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_sites_canonical_host
  ON tenant_sites (tenant_id, canonical_host)
  WHERE canonical_host IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_sites_linkscrawl_host
  ON tenant_sites (tenant_id, linkscrawl_host)
  WHERE linkscrawl_host IS NOT NULL;

COMMIT;

-- =============================================================================
-- ROLLBACK (必要時のみ)
-- =============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS idx_tenant_sites_linkscrawl_host;
-- DROP INDEX IF EXISTS idx_tenant_sites_canonical_host;
-- DROP INDEX IF EXISTS uq_tenant_sites_aireceipt_install;
-- DROP INDEX IF EXISTS uq_tenant_sites_aireceipt_site;
-- ALTER TABLE tenant_sites
--   DROP COLUMN IF EXISTS updated_at,
--   DROP COLUMN IF EXISTS cf_zone_id,
--   DROP COLUMN IF EXISTS gsc_sitemap_url,
--   DROP COLUMN IF EXISTS gsc_property,
--   DROP COLUMN IF EXISTS aireceipt_install_id,
--   DROP COLUMN IF EXISTS aireceipt_site_id,
--   DROP COLUMN IF EXISTS linkscrawl_job_id,
--   DROP COLUMN IF EXISTS linkscrawl_host,
--   DROP COLUMN IF EXISTS canonical_host,
--   DROP COLUMN IF EXISTS site_url,
--   DROP COLUMN IF EXISTS site_name;
-- COMMIT;
