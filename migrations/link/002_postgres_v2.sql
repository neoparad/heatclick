-- ============================================================================
-- UGOKI LINK v2 — Generated Postgres Control-Plane DDL (schema v2.0.0)
-- Deletion Plan Hash: 165924f413a3272a7c66be027976bcfedb93c80dbeacd6ba6532152fecec0ce6
-- DO NOT EDIT MANUALLY. Regenerate from packages/contract/schema/canonical.ts
-- ============================================================================
-- Table: audit_log (Append-only hash-chained R0-R5 audit log (R2+ retained >=1 year on every plan, SUR §5.2).)
-- Retention: audit_min_1y | Deletion: not_applicable_non_personal
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  actor_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  prev_chain_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (audit_id)
);
COMMENT ON COLUMN audit_log.audit_id IS 'Audit entry UUID [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.tenant_id IS 'Tenant UUID (RLS bound) [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.actor_type IS 'human | agent | service [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.principal_id IS 'Opaque principal identifier [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.operation IS 'Canonical operation id [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.risk_class IS 'R0..R5 [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.prev_chain_hash IS 'Hash chain pointer [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.entry_hash IS 'Entry integrity digest [pii=none;deletable=false]';
COMMENT ON COLUMN audit_log.occurred_at IS 'Event timestamp UTC [pii=none;deletable=false]';
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_time ON audit_log (tenant_id, occurred_at);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_audit_log_tenant_permissive ON audit_log;
CREATE POLICY rls_audit_log_tenant_permissive ON audit_log AS PERMISSIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS rls_audit_log_tenant ON audit_log;
CREATE POLICY rls_audit_log_tenant ON audit_log AS RESTRICTIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Table: deletion_requests (14-day subject erasure state machine (scheduled -> masked <=24h -> purged <=5d -> certified <=14d).)
-- Retention: audit_min_1y | Deletion: by_subject_row
CREATE TABLE IF NOT EXISTS deletion_requests (
  request_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_hmac CHAR(64),
  state TEXT NOT NULL DEFAULT 'scheduled',
  deletion_epoch BIGINT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  masked_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  certified_at TIMESTAMPTZ,
  certificate_json JSONB,
  PRIMARY KEY (request_id)
);
COMMENT ON COLUMN deletion_requests.request_id IS 'Deletion request UUID [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.tenant_id IS 'Tenant UUID (RLS bound) [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.site_id IS 'Site UUID [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.subject_kind IS 'visitor_id | member_hash | external_id | ga_client_id [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.subject_hmac IS 'Tenant-keyed subject digest (cleared after certification) [pii=member_hash;deletable=true]';
COMMENT ON COLUMN deletion_requests.state IS 'scheduled | masked | purged | certified | cancelled | overdue [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.deletion_epoch IS 'Monotonic deletion epoch invalidating exports/extracts [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.requested_at IS 'Request timestamp UTC [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.masked_at IS 'Masked timestamp (<=24h) [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.purged_at IS 'Physical purge timestamp (<=5d) [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.certified_at IS 'Certificate issued timestamp (<=14d) [pii=none;deletable=false]';
COMMENT ON COLUMN deletion_requests.certificate_json IS 'Matched counts and named unreachable classes [pii=none;deletable=false]';
CREATE INDEX IF NOT EXISTS idx_deletion_requests_tenant_state ON deletion_requests (tenant_id, site_id);
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_deletion_requests_tenant_permissive ON deletion_requests;
CREATE POLICY rls_deletion_requests_tenant_permissive ON deletion_requests AS PERMISSIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS rls_deletion_requests_tenant ON deletion_requests;
CREATE POLICY rls_deletion_requests_tenant ON deletion_requests AS RESTRICTIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Table: disclosure_records (Generated privacy disclosure records and policy URL verification states (D-30 / tel.G12).)
-- Retention: tenant_lifetime | Deletion: not_applicable_non_personal
CREATE TABLE IF NOT EXISTS disclosure_records (
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL,
  version INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  policy_url TEXT,
  verification_state TEXT NOT NULL DEFAULT 'missing',
  legal_recipient TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  verified_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, site_id, version)
);
COMMENT ON COLUMN disclosure_records.tenant_id IS 'Tenant UUID (RLS bound) [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.site_id IS 'Site UUID [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.version IS 'Monotonic disclosure version [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.schema_version IS 'Source contract schema version [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.content_sha256 IS 'SHA-256 of generated disclosure HTML/JSON [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.policy_url IS 'Declared site policy URL [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.verification_state IS 'verified | declared | missing [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.legal_recipient IS 'Legal recipient name under JP external transmission rule [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.payload_json IS 'Generated disclosure payload [pii=none;deletable=false]';
COMMENT ON COLUMN disclosure_records.verified_at IS 'Last SSRF-guarded verification timestamp UTC [pii=none;deletable=false]';
CREATE INDEX IF NOT EXISTS idx_disclosure_records_site_state ON disclosure_records (tenant_id, site_id);
ALTER TABLE disclosure_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_disclosure_records_tenant_permissive ON disclosure_records;
CREATE POLICY rls_disclosure_records_tenant_permissive ON disclosure_records AS PERMISSIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS rls_disclosure_records_tenant ON disclosure_records;
CREATE POLICY rls_disclosure_records_tenant ON disclosure_records AS RESTRICTIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Table: tenant_sites (Site configuration, retention grid selection, industry class, minors flag, and data residency.)
-- Retention: tenant_lifetime | Deletion: not_applicable_non_personal
CREATE TABLE IF NOT EXISTS tenant_sites (
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL,
  site_ref TEXT NOT NULL,
  retention_months SMALLINT NOT NULL DEFAULT 13,
  default_consent_mode TEXT NOT NULL DEFAULT 'cookieless',
  minors_flag BOOLEAN NOT NULL DEFAULT FALSE,
  industry_class TEXT NOT NULL,
  storage_region TEXT NOT NULL DEFAULT 'jp',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, site_id)
);
COMMENT ON COLUMN tenant_sites.tenant_id IS 'Tenant UUID (RLS bound) [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.site_id IS 'Site UUID [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.site_ref IS 'Immutable public site reference [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.retention_months IS 'Published retention grid months (1..36) [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.default_consent_mode IS 'Signed site default consent mode [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.minors_flag IS 'Caps site at cookieless when true [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.industry_class IS 'Industry classification for sensitive auto-off [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.storage_region IS 'Pinned data storage region (§11.11.13) [pii=none;deletable=false]';
COMMENT ON COLUMN tenant_sites.created_at IS 'Created UTC [pii=none;deletable=false]';
CREATE INDEX IF NOT EXISTS idx_tenant_sites_tenant ON tenant_sites (tenant_id, site_id);
ALTER TABLE tenant_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_sites_tenant_permissive ON tenant_sites;
CREATE POLICY rls_tenant_sites_tenant_permissive ON tenant_sites AS PERMISSIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS rls_tenant_sites_tenant ON tenant_sites;
CREATE POLICY rls_tenant_sites_tenant ON tenant_sites AS RESTRICTIVE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
