-- =============================================================================
-- P1 Migration (PostgreSQL) — Multi-Tenant Auth Registry
-- =============================================================================
--
-- 作成日: 2026-06-08
-- 起草: Director (docs/multi-tenant-auth-design.md §4 / §13.5 dual-review 統合)
-- 適用先: **新規 Managed Postgres = Supabase** (2026-06-08 Owner 決定、専用プロジェクト推奨)
--          ※ linkscrawl Hetzner PG (159.69.95.59:5433) とは別インスタンス。
--             認証は全リクエストで参照するため Vercel 近接・低レイテンシの managed PG に置く。
--          ※ 本 DDL の実行は **Direct connection (port 5432)** を使う (pooler 6543 は DDL 非推奨)。
--             アプリ実行時の接続は Pooler / Transaction mode (port 6543) を使う。
--
-- 目的: ハードコード登録簿 (lib/auth/dogfood-users.ts) を関係DBに永続化し、
--       外部クライアント (wakegai 等) を独立テナント (B) で運用できる足場を作る。
--
-- 親 SSOT:
--   - docs/multi-tenant-auth-design.md (§4 データモデル / §13.5 REQ-SEC-101..125)
--   - CLAUDE.md 絶対ルール 7 (tenant_id を全 DB 操作で必ず保持・検証)
--   - §3.8.1 multi-tenant isolation
--
-- 反映している受け入れ基準 (dual review: threat-modeler + Codex):
--   - REQ-SEC-101 セッション失効: users.session_version / memberships.membership_version
--   - REQ-SEC-102 テナント停止: tenants.status ('active' | 'suspended')
--   - REQ-SEC-104 Postgres も tenant スコープ強制 (全 join に tenant_id)
--   - REQ-SEC-106/107 招待権限境界・email 一致 (アプリ層で強制、schema は素材を保持)
--   - REQ-SEC-120 invitations は token_hash 保存・短寿命・1回限り (生 token は保存しない)
--
-- 実行方法 (Supabase):
--   方法A (psql):   psql "<Direct connection string :5432>" -f migrations/2026-06-08-auth-postgres-p1.sql
--   方法B (UI):     Supabase Dashboard → SQL Editor に本ファイルを貼り付けて実行 (最も簡単)
--   ※ DDL 適用は Owner/Infra が実行 (AI は実行しない、既存ルール)。
--   ※ Supabase の `citext` は標準で利用可。失敗する場合は Dashboard → Database → Extensions で有効化。
--
-- ロールバック: 末尾の `-- ROLLBACK:` セクション参照。
-- =============================================================================

BEGIN;

-- citext: email を大小文字無視で UNIQUE にする (REQ: unique email)
CREATE EXTENSION IF NOT EXISTS citext;

-- =============================================================================
-- tenants — テナント1行
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenants (
    id          TEXT        PRIMARY KEY,                 -- 'tnt_wakegai' / 'linkth_internal'
    name        TEXT        NOT NULL,
    plan        TEXT        NOT NULL DEFAULT 'free',
    status      TEXT        NOT NULL DEFAULT 'active'     -- REQ-SEC-102: 'active' | 'suspended'
                            CHECK (status IN ('active', 'suspended')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- tenant_sites — テナントがアクセスできる ClickHouse site_id (CIP_xxxx)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenant_sites (
    tenant_id   TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id     TEXT        NOT NULL,                     -- ClickHouse の site_id
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, site_id)
);
-- 1 site が複数テナントに属さないことを保証 (re-tenant 時の cross-tenant 残留防止, REQ-SEC-117)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_sites_site ON tenant_sites (site_id);

-- =============================================================================
-- users — ユーザー1行 (email が自然キー、id は安定 surrogate)
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id              TEXT        PRIMARY KEY,              -- 'usr_xxx'
    email           CITEXT      UNIQUE NOT NULL,
    name            TEXT,
    -- REQ-SEC-101: user 単位の失効世代。全セッション失効 (pw 相当イベント) で +1。
    session_version INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- memberships — user × tenant × role (1ユーザーが複数テナント所属可)
-- =============================================================================
CREATE TABLE IF NOT EXISTS memberships (
    user_id            TEXT        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    tenant_id          TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role               TEXT        NOT NULL
                                   CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    -- REQ-SEC-101: membership 単位の失効世代。role 剥奪 / 退会 / テナント停止反映で +1。
    membership_version INTEGER     NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id)
);
-- login lookup: email→user→memberships を高速化
CREATE INDEX IF NOT EXISTS idx_memberships_user   ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships (tenant_id);

-- =============================================================================
-- invitations — 招待 (生 token は保存せず hash のみ, REQ-SEC-120)
-- =============================================================================
CREATE TABLE IF NOT EXISTS invitations (
    token_hash  TEXT        PRIMARY KEY,                  -- sha256(raw token)
    email       CITEXT      NOT NULL,                     -- 受諾時にこの email と一致必須 (REQ-SEC-107)
    tenant_id   TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role        TEXT        NOT NULL
                            CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
    expires_at  TIMESTAMPTZ NOT NULL,                     -- 短寿命 (アプリ層で 72h 等)
    accepted_at TIMESTAMPTZ,                              -- 受諾済 (1回限り: NULL の時のみ受諾可)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitations_email  ON invitations (email);
CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON invitations (tenant_id);

COMMIT;

-- =============================================================================
-- 検証 SELECT (適用後に手動で確認)
-- =============================================================================
-- -- テーブルが揃ったか
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public'
--    AND table_name IN ('tenants','tenant_sites','users','memberships','invitations')
--  ORDER BY table_name;
--
-- -- session/membership version 列の存在 (REQ-SEC-101)
-- SELECT table_name, column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE (table_name='users'       AND column_name='session_version')
--     OR (table_name='memberships' AND column_name='membership_version');
--
-- -- citext 有効化確認
-- SELECT extname FROM pg_extension WHERE extname = 'citext';

-- =============================================================================
-- seed について
-- =============================================================================
-- 既存 dogfood-users (linkth_internal + 5 sites + 既存 email) の seed は
-- **本 SQL に直書きしない**。lib/auth/dogfood-users.ts と drift しないよう、
-- アプリ側の seed スクリプト (USER_REGISTRY 抽象経由) で投入する。
-- これにより seed のロールバック = 認可のロールバック (REQ-SEC-123) を1箇所で管理する。

-- =============================================================================
-- ROLLBACK (緊急時のみ実行)
-- =============================================================================
-- 注意: アプリ側 USER_REGISTRY=hardcode に戻した後に実行 (DB 経路を切ってから drop)。
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS invitations;
-- DROP TABLE IF EXISTS memberships;
-- DROP TABLE IF EXISTS tenant_sites;
-- DROP TABLE IF EXISTS users;
-- DROP TABLE IF EXISTS tenants;
-- -- DROP EXTENSION citext;  -- 他テーブルが citext を使っていないことを確認してから
-- COMMIT;
-- =============================================================================
