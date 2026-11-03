-- Migration: 2026-11-03-fusion-gsc-cache.sql
-- Purpose: Port GSC target & sitemap inspection cache tables from aiseo/web (Supabase)
--          into ugokimap-saas Auth/Tenant Postgres DB (tenant_id + site_id scoped).

CREATE TABLE IF NOT EXISTS gsc_targets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  site_id      TEXT NOT NULL,
  property     TEXT NOT NULL,
  sitemap_url  TEXT NOT NULL,
  daily_quota  INTEGER NOT NULL DEFAULT 500,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, property, sitemap_url)
);

CREATE INDEX IF NOT EXISTS idx_gsc_targets_tenant_site
  ON gsc_targets (tenant_id, site_id);

CREATE TABLE IF NOT EXISTS gsc_inspection (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL,
  target_id          UUID NOT NULL REFERENCES gsc_targets(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  verdict            TEXT,
  coverage_state     TEXT,
  indexing_state     TEXT,
  page_fetch_state   TEXT,
  robots_txt_state   TEXT,
  crawled_as         TEXT,
  last_crawl_time    TIMESTAMPTZ,
  google_canonical   TEXT,
  user_canonical     TEXT,
  referring_urls     JSONB,
  sitemaps           JSONB,
  inspected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error              TEXT,
  UNIQUE (target_id, url)
);

CREATE INDEX IF NOT EXISTS idx_gsc_inspection_target_verdict
  ON gsc_inspection (target_id, verdict);

CREATE INDEX IF NOT EXISTS idx_gsc_inspection_target_inspected
  ON gsc_inspection (target_id, inspected_at);

CREATE INDEX IF NOT EXISTS idx_gsc_inspection_tenant
  ON gsc_inspection (tenant_id);

CREATE TABLE IF NOT EXISTS gsc_index_summary (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  target_id       UUID NOT NULL REFERENCES gsc_targets(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  sitemap_total   INTEGER NOT NULL DEFAULT 0,
  inspected_total INTEGER NOT NULL DEFAULT 0,
  indexed         INTEGER NOT NULL DEFAULT 0,
  excluded        INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  not_inspected   INTEGER NOT NULL DEFAULT 0,
  verdict_counts  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, day)
);

CREATE INDEX IF NOT EXISTS idx_gsc_index_summary_tenant_target
  ON gsc_index_summary (tenant_id, target_id, day DESC);
