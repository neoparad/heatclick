-- ============================================================================
-- UGOKI LINK v2 — Generated ClickHouse DDL (schema v2.0.0)
-- Deletion Plan Hash: 034b649a67b3d3f56f1471827699d7e69baacdb9cf6360d9caf2e5fb91591860
-- DO NOT EDIT MANUALLY. Regenerate from packages/contract/schema/canonical.ts
-- ============================================================================
-- Table: access_bot_lt (Verified crawler/fetcher observations (zero visitor data, kept until tenant exit, STORE A1).)
-- Retention: tenant_lifetime | Deletion: not_applicable_non_personal
CREATE TABLE IF NOT EXISTS access_bot_lt (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  month_utc Date COMMENT 'Month start UTC [pii=none;deletable=false]',
  verified_actor_id LowCardinality(String) COMMENT 'Verified bot registry ID [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  req_uid_hash UInt64 COMMENT 'Non-personal crawler observation dedupe hash [pii=none;deletable=false]',
  http_status UInt16 COMMENT 'HTTP response status [pii=none;deletable=false]'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(month_utc)
ORDER BY (tenant_id, site_id, month_utc, verified_actor_id, url_id, req_uid_hash)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000;

-- Dual-layer ClickHouse tenant isolation row policies for access_bot_lt (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_access_bot_lt_tenant_permissive ON access_bot_lt AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_access_bot_lt_tenant_restrictive ON access_bot_lt AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: access_obs (Append-only server/CDN request observations with E/T/P address classes (D-25).)
-- Retention: 35d_access_t | Deletion: by_req_uid
CREATE TABLE IF NOT EXISTS access_obs (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  day_edge Date COMMENT 'Edge receipt day UTC [pii=none;deletable=false]',
  capture_path LowCardinality(String) COMMENT 'Capture source path [pii=none;deletable=false]',
  req_uid UUID COMMENT 'Immutable request observation id [pii=pv_linkable;deletable=true]',
  sub UInt8 COMMENT 'Sub-request ordinal [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  address_class LowCardinality(String) COMMENT 'E | T | P [pii=none;deletable=false]',
  prefix_asn Nullable(String) COMMENT 'Class-T /24 or /48 prefix + ASN (35d) [pii=network_pseudonym;deletable=true]',
  sealed_client_ip Nullable(String) COMMENT 'Sealed IP (E=30d key, P=72h key) [pii=sealed_address;deletable=true]',
  ua_reduced LowCardinality(String) COMMENT 'Browser family/version/in-app class [pii=none;deletable=false]',
  raw_ua_class_e Nullable(String) COMMENT 'Raw UA retained ONLY on class-E automation evidence rows [pii=raw_ua_bot_only;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, day_edge, capture_path, req_uid, sub)
TTL day_edge + INTERVAL 35 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for access_obs (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_access_obs_tenant_permissive ON access_obs AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_access_obs_tenant_restrictive ON access_obs AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: access_verdict (Recomputable actor verification verdicts keyed identically to access_obs.)
-- Retention: 35d_access_t | Deletion: by_req_uid
CREATE TABLE IF NOT EXISTS access_verdict (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  day_edge Date COMMENT 'Edge receipt day UTC [pii=none;deletable=false]',
  capture_path LowCardinality(String) COMMENT 'Capture path [pii=none;deletable=false]',
  req_uid UUID COMMENT 'Request observation id [pii=pv_linkable;deletable=true]',
  sub UInt8 COMMENT 'Sub-request ordinal [pii=none;deletable=false]',
  verdict_rev UInt32 COMMENT 'Verdict revision [pii=none;deletable=false]',
  actor_class LowCardinality(String) COMMENT 'Actor class [pii=none;deletable=false]',
  identity_assurance LowCardinality(String) COMMENT 'Identity assurance [pii=none;deletable=false]',
  verification_result LowCardinality(String) COMMENT 'Verification result [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree(verdict_rev)
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, day_edge, capture_path, req_uid, sub)
TTL day_edge + INTERVAL 35 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for access_verdict (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_access_verdict_tenant_permissive ON access_verdict AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_access_verdict_tenant_restrictive ON access_verdict AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: conversion_fact (Versioned conversion labels and revenue grain attributions (D-18).)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS conversion_fact (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  label_key LowCardinality(String) COMMENT 'engaged_view | aff_click | lead | purchase [pii=none;deletable=false]',
  contract_version UInt16 COMMENT 'Label contract version [pii=none;deletable=false]',
  value_grain LowCardinality(String) COMMENT 'Revenue grain ladder value (D-18) [pii=none;deletable=false]',
  revenue_minor Nullable(Int64) COMMENT 'Minor currency unit (nullable) [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id, label_key, contract_version)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for conversion_fact (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_conversion_fact_tenant_permissive ON conversion_fact AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_conversion_fact_tenant_restrictive ON conversion_fact AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: decision_features_v1 (Point-in-time ML feature record logged widely at decision time (D-17).)
-- Retention: site_class | Deletion: by_unit_key
CREATE TABLE IF NOT EXISTS decision_features_v1 (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  decided_hour DateTime COMMENT 'Decision hour UTC [pii=none;deletable=false]',
  decision_id UUID COMMENT 'Decision ID [pii=pv_linkable;deletable=true]',
  feature_set_version UInt16 COMMENT 'Feature contract version [pii=none;deletable=false]',
  logged_features Map(UInt16, Int64) COMMENT 'Raw fixed-point features logged at decision time [pii=none;deletable=false]',
  batch_snapshot_id String COMMENT 'Immutable batch feature snapshot id [pii=none;deletable=false]',
  skel_fp UInt64 COMMENT 'Structure skeleton fp [pii=none;deletable=false]',
  variant_key UInt64 COMMENT 'Rendered variant_key [pii=none;deletable=false]',
  verified UInt8 COMMENT 'Feature integrity verified [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, decided_hour, decision_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for decision_features_v1 (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_decision_features_v1_tenant_permissive ON decision_features_v1 AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_decision_features_v1_tenant_restrictive ON decision_features_v1 AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: decision_log (Single authoritative decision record for experiments, holdouts, and ML policies (D-17).)
-- Retention: site_class | Deletion: by_unit_key
CREATE TABLE IF NOT EXISTS decision_log (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  layer_id LowCardinality(String) COMMENT 'Allocator layer id [pii=none;deletable=false]',
  decided_hour DateTime COMMENT 'Decision hour UTC [pii=none;deletable=false]',
  decision_id UUID COMMENT 'Decision ID [pii=pv_linkable;deletable=true]',
  experiment_id LowCardinality(String) COMMENT 'Experiment ID [pii=none;deletable=false]',
  arm_id LowCardinality(String) COMMENT 'Assigned arm ID [pii=none;deletable=false]',
  unit_id String COMMENT 'Assigned unit ID [pii=pv_linkable;deletable=true]',
  unit_kind LowCardinality(String) COMMENT 'Unit kind [pii=none;deletable=false]',
  identity_quality LowCardinality(String) COMMENT 'A | B | C [pii=none;deletable=false]',
  consent_mode LowCardinality(String) COMMENT 'Resolved consent mode [pii=none;deletable=false]',
  purposes_mask UInt32 COMMENT 'Consented purposes mask [pii=none;deletable=false]',
  propensity Float64 COMMENT 'Draw propensity [pii=none;deletable=false]',
  traffic_class LowCardinality(String) COMMENT 'Traffic class [pii=none;deletable=false]',
  pv_id Nullable(UUID) COMMENT 'Linked PV ID [pii=pv_linkable;deletable=true]',
  dtk_valid UInt8 COMMENT 'Decision token verified [pii=none;deletable=false]',
  skel_fp UInt64 COMMENT 'Skeleton fp [pii=none;deletable=false]',
  variant_key UInt64 COMMENT 'Rendered variant_key [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, layer_id, decided_hour, decision_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for decision_log (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_decision_log_tenant_permissive ON decision_log AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_decision_log_tenant_restrictive ON decision_log AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: events_v2 (Immutable numbered log items keyed by (pv_id, log_i).)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS events_v2 (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  log_i UInt32 COMMENT 'Immutable log item ordinal [pii=none;deletable=false]',
  log_kind LowCardinality(String) COMMENT 'Item kind [pii=none;deletable=false]',
  activation_kind Nullable(LowCardinality(String)) COMMENT 'Activation kind [pii=none;deletable=false]',
  el_fp Nullable(UInt64) COMMENT 'Element fingerprint [pii=none;deletable=false]',
  dest_key_click Nullable(String) COMMENT 'Scrubbed destination key [pii=none;deletable=false]',
  cv_key Nullable(LowCardinality(String)) COMMENT 'Conversion key [pii=none;deletable=false]',
  ec_product_id Nullable(String) COMMENT 'EC product id [pii=none;deletable=false]',
  content_hash UInt64 COMMENT 'Log conflict detection hash [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id, log_i)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for events_v2 (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_events_v2_tenant_permissive ON events_v2 AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_events_v2_tenant_restrictive ON events_v2 AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: exposure_log (Single authoritative exposure lifecycle record (trigger/render/visible/suppressed/probe, D-17).)
-- Retention: site_class | Deletion: by_unit_key
CREATE TABLE IF NOT EXISTS exposure_log (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  layer_id LowCardinality(String) COMMENT 'Allocator layer id [pii=none;deletable=false]',
  exposed_hour DateTime COMMENT 'Exposure hour UTC [pii=none;deletable=false]',
  decision_id UUID COMMENT 'Decision ID [pii=pv_linkable;deletable=true]',
  exposure_kind LowCardinality(String) COMMENT 'trigger | render | visible | suppressed | probe [pii=none;deletable=false]',
  exposure_reason Nullable(LowCardinality(String)) COMMENT 'Suppression or probe reason [pii=none;deletable=false]',
  lease_id Nullable(String) COMMENT 'Delivery lease ID [pii=none;deletable=false]',
  lease_age_ms Nullable(UInt32) COMMENT 'Lease age ms [pii=none;deletable=false]',
  k_class LowCardinality(String) COMMENT 'Stop class K1..K4 [pii=none;deletable=false]',
  delivery_path LowCardinality(String) COMMENT 'sdk | edge | token | origin [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, layer_id, exposed_hour, decision_id, exposure_kind)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for exposure_log (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_exposure_log_tenant_permissive ON exposure_log AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_exposure_log_tenant_restrictive ON exposure_log AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: frame_log (Frame header log for gap analysis, post-ack echo checks, and closure 1.)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS frame_log (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Monday of expiry week (partition key) [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Loader-assigned PV start hour UTC [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 64-bit id [pii=none;deletable=false]',
  pv_id UUID COMMENT '128-bit PV id [pii=pv_linkable;deletable=true]',
  seq UInt32 COMMENT 'Monotonic frame sequence [pii=none;deletable=false]',
  frame_hash UInt64 COMMENT 'Deterministic frame content hash [pii=none;deletable=false]',
  codec_ver LowCardinality(String) COMMENT 'Wire codec version [pii=none;deletable=false]',
  schema_ver UInt16 COMMENT 'Contract wire schema version [pii=none;deletable=false]',
  frame_class LowCardinality(String) COMMENT 'Trigger class [pii=none;deletable=false]',
  transport LowCardinality(String) COMMENT 'Transport mechanism [pii=none;deletable=false]',
  full UInt8 COMMENT 'Full snapshot flag [pii=none;deletable=false]',
  vis_episode UInt16 COMMENT 'Visible episode ordinal [pii=none;deletable=false]',
  t_mono UInt32 COMMENT 'Monotonic ms [pii=none;deletable=false]',
  t_wall Int64 COMMENT 'Client wall clock ms (diagnostic) [pii=none;deletable=false]',
  ack_echo_seq Int32 COMMENT 'Echoed last ack seq [pii=none;deletable=false]',
  live_word UInt32 COMMENT '32-bit live summary word [pii=none;deletable=false]',
  consent_mode LowCardinality(String) COMMENT 'Resolved consent mode [pii=none;deletable=false]',
  purposes_mask UInt32 COMMENT 'Consented purposes bitmask [pii=none;deletable=false]',
  arm_bits UInt16 COMMENT 'Measurement arm bits [pii=none;deletable=false]',
  received_at DateTime64(3) COMMENT 'Server receive timestamp UTC [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id, seq, frame_hash)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for frame_log (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_frame_log_tenant_permissive ON frame_log AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_frame_log_tenant_restrictive ON frame_log AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: frame_payload (Hot copy of raw frame bytes (timeline items stripped) for rebuild_pv.)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS frame_payload (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  seq UInt32 COMMENT 'Sequence number [pii=none;deletable=false]',
  frame_hash UInt64 COMMENT 'Frame hash [pii=none;deletable=false]',
  payload_bytes String COMMENT 'Encoded ugk-bin/1 frame payload (headers inside payload) [pii=pv_linkable;deletable=true]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id, seq, frame_hash)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for frame_payload (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_frame_payload_tenant_permissive ON frame_payload AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_frame_payload_tenant_restrictive ON frame_payload AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: frame_quarantine (Encrypted decode_quarantine (7-day TTL, no API route, covered by deletion, D-28).)
-- Retention: 7d_quarantine | Deletion: quarantine_7d_delete
CREATE TABLE IF NOT EXISTS frame_quarantine (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  received_day Date COMMENT 'Receipt day (7d TTL) [pii=none;deletable=false]',
  pv_id Nullable(UUID) COMMENT 'PV id if decodable [pii=pv_linkable;deletable=true]',
  seq UInt32 COMMENT 'Sequence if decodable [pii=none;deletable=false]',
  reason LowCardinality(String) COMMENT 'Quarantine reason code [pii=none;deletable=false]',
  sanitized_payload_enc String COMMENT 'Tenant-encrypted sanitized payload (strings in int slots replaced by {type,length}) [pii=pv_linkable;deletable=true]'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(received_day)
ORDER BY (tenant_id, site_id, received_day, pv_id, seq)
TTL received_day + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for frame_quarantine (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_frame_quarantine_tenant_permissive ON frame_quarantine AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_frame_quarantine_tenant_restrictive ON frame_quarantine AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: handoff (Server-Timing document request to PV handoff join (D-1 / D-4 / D-25).)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS handoff (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  req_uid UUID COMMENT 'Server request observation id [pii=pv_linkable;deletable=true]',
  pv_id Nullable(UUID) COMMENT 'Matched browser pv_id [pii=pv_linkable;deletable=true]',
  handoff_state LowCardinality(String) COMMENT 'fresh | reused | shared_cache | ... [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, req_uid)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for handoff (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_handoff_tenant_permissive ON handoff AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_handoff_tenant_restrictive ON handoff AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: identity_link (Tenant-rekeyed member HMAC to visitor key mapping (with key_version for safe rotation deletion).)
-- Retention: site_class | Deletion: by_subject_row
CREATE TABLE IF NOT EXISTS identity_link (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  key_version UInt16 COMMENT 'Tenant HMAC key version (retained until zero rows remain) [pii=none;deletable=false]',
  member_hmac FixedString(64) COMMENT 'HMAC(tenant_key, customer_hex); raw customer hash never stored [pii=member_hash;deletable=true]',
  visitor_key String COMMENT 'Linked visitor key [pii=visitor_id;deletable=true]',
  external_id_hmac Nullable(FixedString(64)) COMMENT 'Optional tenant-keyed external subject id [pii=external_id;deletable=true]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, key_version, member_hmac, visitor_key)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for identity_link (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_identity_link_tenant_permissive ON identity_link AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_identity_link_tenant_restrictive ON identity_link AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: live_tail (Exact last-minutes queries by server receipt minute (2-day TTL).)
-- Retention: 2d_live_tail | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS live_tail (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  minute_recv DateTime COMMENT 'Receipt minute UTC [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  seq UInt32 COMMENT 'Frame seq [pii=none;deletable=false]',
  dim_tuple_code UInt16 COMMENT 'Dimension code [pii=none;deletable=false]',
  live_word UInt32 COMMENT '32-bit live state word [pii=none;deletable=false]'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(minute_recv)
ORDER BY (tenant_id, site_id, minute_recv, pv_id, seq)
TTL minute_recv + INTERVAL 2 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for live_tail (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_live_tail_tenant_permissive ON live_tail AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_live_tail_tenant_restrictive ON live_tail AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: page_view_state (Mergeable cumulative register state per PV (idempotent under duplicates/reordering).)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS page_view_state (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  max_seq SimpleAggregateFunction(max, UInt32) COMMENT 'Highest delivered seq [pii=none;deletable=false]',
  scroll_max_px SimpleAggregateFunction(max, UInt32) COMMENT 'Max scroll depth px [pii=none;deletable=false]',
  doc_h_max SimpleAggregateFunction(max, UInt32) COMMENT 'Max document height px [pii=none;deletable=false]',
  doc_h_last AggregateFunction(argMax, UInt32, Tuple(UInt32, UInt64)) COMMENT 'Latest doc height by (seq, frame_hash) [pii=none;deletable=false]',
  vis_ms SimpleAggregateFunction(max, UInt32) COMMENT 'Cumulative visible dwell ms [pii=none;deletable=false]',
  reversals SimpleAggregateFunction(max, UInt16) COMMENT 'Cumulative scroll reversals [pii=none;deletable=false]',
  js_error_n SimpleAggregateFunction(max, UInt16) COMMENT 'Cumulative JS errors [pii=none;deletable=false]',
  degrade_level SimpleAggregateFunction(max, UInt8) COMMENT 'Max degrade level [pii=none;deletable=false]',
  live_word SimpleAggregateFunction(groupBitOr, UInt32) COMMENT '32-bit live state word [pii=none;deletable=false]',
  sec_vis_ms SimpleAggregateFunction(maxMap, Map(UInt64, UInt32)) COMMENT 'Section dwell ms map [pii=none;deletable=false]',
  sec_t_first_ms SimpleAggregateFunction(minMap, Map(UInt64, UInt32)) COMMENT 'Section first-crossing ms map [pii=none;deletable=false]',
  sec_entries SimpleAggregateFunction(maxMap, Map(UInt64, UInt16)) COMMENT 'Section entry count map [pii=none;deletable=false]',
  blk_vis_ms SimpleAggregateFunction(maxMap, Map(UInt64, UInt32)) COMMENT 'Block dwell ms map [pii=none;deletable=false]',
  field_focus_ms SimpleAggregateFunction(maxMap, Map(UInt64, UInt32)) COMMENT 'Form field focus ms map [pii=none;deletable=false]',
  lcp_ms AggregateFunction(argMax, Nullable(UInt32), Tuple(UInt32, UInt64)) COMMENT 'LCP ms (value, seq) [pii=none;deletable=false]',
  inp_ms AggregateFunction(argMax, Nullable(UInt32), Tuple(UInt32, UInt64)) COMMENT 'INP ms (value, seq) [pii=none;deletable=false]',
  state_incomplete SimpleAggregateFunction(max, UInt8) COMMENT 'Set to 1 on chk mismatch [pii=none;deletable=false]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for page_view_state (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_page_view_state_tenant_permissive ON page_view_state AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_page_view_state_tenant_restrictive ON page_view_state AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: pv_by_session (Session-ordered PV index for journeys and funnels.)
-- Retention: site_class | Deletion: by_session_key
CREATE TABLE IF NOT EXISTS pv_by_session (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  session_day Date COMMENT 'Loader-assigned session placement day [pii=none;deletable=false]',
  session_key String COMMENT 'Session key [pii=session_id;deletable=true]',
  pv_start_srv DateTime64(3) COMMENT 'PV start UTC [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, session_day, session_key, pv_start_srv, pv_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for pv_by_session (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_pv_by_session_tenant_permissive ON pv_by_session AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_pv_by_session_tenant_restrictive ON pv_by_session AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: pv_by_visitor (Primary erasure lookup index and visitor-ordered history.)
-- Retention: site_class | Deletion: by_visitor_key
CREATE TABLE IF NOT EXISTS pv_by_visitor (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  visitor_key String COMMENT 'Visitor identifier (Stratum A or B) [pii=visitor_id;deletable=true]',
  pv_start_srv DateTime64(3) COMMENT 'Loader-assigned PV start UTC [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  session_key Nullable(String) COMMENT 'Session id if present [pii=session_id;deletable=true]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, visitor_key, pv_start_srv, pv_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for pv_by_visitor (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_pv_by_visitor_tenant_permissive ON pv_by_visitor AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_pv_by_visitor_tenant_restrictive ON pv_by_visitor AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: pv_fact (Sealed collapsed PV fact row per build_seq for ML marts and exact rollups.)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS pv_fact (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  page_id UInt64 COMMENT 'Alias-resolved page_id as of pv_start_srv [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  build_seq UInt64 COMMENT 'Immutable sealed build sequence [pii=none;deletable=false]',
  consent_mode LowCardinality(String) COMMENT 'Consent mode [pii=none;deletable=false]',
  identity_quality LowCardinality(String) COMMENT 'Identity stratum A/B/C [pii=none;deletable=false]',
  trust LowCardinality(String) COMMENT 'PV trust tier [pii=none;deletable=false]',
  actor_class LowCardinality(String) COMMENT 'Actor class [pii=none;deletable=false]',
  traffic_class LowCardinality(String) COMMENT 'Traffic class [pii=none;deletable=false]',
  skel_fp UInt64 COMMENT 'Skeleton fp [pii=none;deletable=false]',
  variant_key UInt64 COMMENT 'Variant key [pii=none;deletable=false]',
  scroll_max_px UInt32 COMMENT 'Collapsed max scroll px [pii=none;deletable=false]',
  vis_ms UInt32 COMMENT 'Collapsed visible dwell ms [pii=none;deletable=false]',
  lcp_ms Nullable(UInt32) COMMENT 'Collapsed LCP ms [pii=none;deletable=false]',
  inp_ms Nullable(UInt32) COMMENT 'Collapsed INP ms [pii=none;deletable=false]',
  collection_gen LowCardinality(String) COMMENT 'v3 | legacy [pii=none;deletable=false]'
)
ENGINE = MergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id, build_seq)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for pv_fact (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_pv_fact_tenant_permissive ON pv_fact AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_pv_fact_tenant_restrictive ON pv_fact AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: pv_index (Single-writer loader placement authority and PV header index.)
-- Retention: site_class | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS pv_index (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry week partition [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  pv_hour_min SimpleAggregateFunction(min, DateTime) COMMENT 'Placement conflict detector (min) [pii=none;deletable=false]',
  pv_hour_max SimpleAggregateFunction(max, DateTime) COMMENT 'Placement conflict detector (max) [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'Immutable url_id [pii=none;deletable=false]',
  visitor_key Nullable(String) COMMENT 'Stratum A or B visitor key [pii=visitor_id;deletable=true]',
  session_key Nullable(String) COMMENT 'First-party session key [pii=session_id;deletable=true]',
  identity_quality LowCardinality(String) COMMENT 'A | B | C [pii=none;deletable=false]',
  consent_mode LowCardinality(String) COMMENT 'Resolved consent mode [pii=none;deletable=false]',
  trust LowCardinality(String) COMMENT 'Trust tier [pii=none;deletable=false]',
  actor_class LowCardinality(String) COMMENT 'Actor class [pii=none;deletable=false]',
  traffic_class LowCardinality(String) COMMENT 'Traffic class [pii=none;deletable=false]',
  skel_fp UInt64 COMMENT 'Structure skeleton fp [pii=none;deletable=false]',
  variant_key UInt64 COMMENT 'Rendered variant_key [pii=none;deletable=false]',
  retention_days UInt16 COMMENT 'Assigned site retention days [pii=none;deletable=false]',
  placement_bias_ms SimpleAggregateFunction(max, Int32) COMMENT 'Start placement bias diagnostic [pii=none;deletable=false]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 1024, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for pv_index (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_pv_index_tenant_permissive ON pv_index AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_pv_index_tenant_restrictive ON pv_index AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: pv_sequence (Coarse integer section-token sequence (<=64 tokens per PV, 30d until D-11R clause b).)
-- Retention: 30d_timeline | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS pv_sequence (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id [pii=pv_linkable;deletable=true]',
  seq_def_version UInt16 COMMENT 'Sequence definition version [pii=none;deletable=false]',
  section_tokens Array(UInt64) COMMENT 'Up to 64 integer sec_fp tokens [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree(seq_def_version)
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id)
TTL pv_hour + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for pv_sequence (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_pv_sequence_tenant_permissive ON pv_sequence AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_pv_sequence_tenant_restrictive ON pv_sequence AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: session_index (Session placement authority for the loader.)
-- Retention: site_class | Deletion: by_session_key
CREATE TABLE IF NOT EXISTS session_index (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  session_key String COMMENT 'Session key [pii=session_id;deletable=true]',
  session_day SimpleAggregateFunction(min, Date) COMMENT 'First assigned session day [pii=none;deletable=false]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, session_key)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for session_index (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_session_index_tenant_permissive ON session_index AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_session_index_tenant_restrictive ON session_index AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: session_period (Exact distinct sessions per built period.)
-- Retention: site_class | Deletion: by_session_key
CREATE TABLE IF NOT EXISTS session_period (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  grain LowCardinality(String) COMMENT 'day | week | month [pii=none;deletable=false]',
  period Date COMMENT 'Period start date [pii=none;deletable=false]',
  session_key String COMMENT 'Session key [pii=session_id;deletable=true]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, grain, period, session_key)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for session_period (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_session_period_tenant_permissive ON session_period AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_session_period_tenant_restrictive ON session_period AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: stat_cell_lt (Long-lived generalised statistics cells with n >= k (default 50, STORE M8).)
-- Retention: long_lived_generalised | Deletion: not_applicable_aggregate
CREATE TABLE IF NOT EXISTS stat_cell_lt (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  lattice_node String COMMENT 'Generalised lattice node key [pii=none;deletable=false]',
  period_start Date COMMENT 'Generalised period start [pii=none;deletable=false]',
  n_pvs UInt64 COMMENT 'Cell PV count (enforced >= k) [pii=none;deletable=false]',
  k_threshold UInt16 COMMENT 'Applied k anonymity threshold [pii=none;deletable=false]'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(period_start)
ORDER BY (tenant_id, site_id, lattice_node, period_start)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000;

-- Dual-layer ClickHouse tenant isolation row policies for stat_cell_lt (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_stat_cell_lt_tenant_permissive ON stat_cell_lt AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_stat_cell_lt_tenant_restrictive ON stat_cell_lt AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: trajectories (Integer-only Tier-1 kinematic timeline and verified-agent traces (30-day drop, ZERO string columns, D-11R/tel.G14).)
-- Retention: 30d_timeline | Deletion: by_pv_key
CREATE TABLE IF NOT EXISTS trajectories (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  pv_hour DateTime COMMENT 'Placement PV hour (30-day TTL) [pii=none;deletable=false]',
  url_id UInt64 COMMENT 'urlkey/2 id [pii=none;deletable=false]',
  pv_id UUID COMMENT 'PV id (never keyed by visitor) [pii=pv_linkable;deletable=true]',
  chunk UInt16 COMMENT 'Chunk ordinal [pii=none;deletable=false]',
  v_dt_100ms Array(UInt16) COMMENT 'Dead-reckoned viewport keyframe delta-t (100ms units) [pii=none;deletable=false]',
  v_sec_ord Array(UInt16) COMMENT 'Section ordinal at keyframe [pii=none;deletable=false]',
  v_offset_px8 Array(UInt16) COMMENT 'Offset in px/8 [pii=none;deletable=false]',
  p_x_px8 Array(UInt16) COMMENT 'Pointer rest/tap x (none in forms) [pii=none;deletable=false]',
  p_y_px8 Array(UInt16) COMMENT 'Pointer rest/tap y (none in forms) [pii=none;deletable=false]',
  e_code Array(UInt16) COMMENT 'Integer event marker codes [pii=none;deletable=false]'
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMMDD(pv_hour)
ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id, chunk)
TTL pv_hour + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for trajectories (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_trajectories_tenant_permissive ON trajectories AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_trajectories_tenant_restrictive ON trajectories AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: unit_ledger (Per-unit experiment read-out and deletion index for decision/exposure/conversion rows.)
-- Retention: site_class | Deletion: by_unit_key
CREATE TABLE IF NOT EXISTS unit_ledger (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  layer_id LowCardinality(String) COMMENT 'Allocator layer id [pii=none;deletable=false]',
  unit_id String COMMENT 'Assignment unit id [pii=pv_linkable;deletable=true]',
  kind LowCardinality(String) COMMENT 'decision | exposure | conversion [pii=none;deletable=false]',
  ref_id UUID COMMENT 'Decision or PV ref id [pii=pv_linkable;deletable=true]',
  nc_experiment Nullable(FixedString(32)) COMMENT 'nc(experiment) scoped network pseudonym (only stored here per D-17/D-25) [pii=network_pseudonym;deletable=true]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, layer_id, unit_id, kind, ref_id)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for unit_ledger (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_unit_ledger_tenant_permissive ON unit_ledger AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_unit_ledger_tenant_restrictive ON unit_ledger AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: usage_day (Sealed daily billable PV and byte meters (no identifiers; survives subject deletion, D-29).)
-- Retention: tenant_lifetime | Deletion: not_applicable_non_personal
CREATE TABLE IF NOT EXISTS usage_day (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  day_utc Date COMMENT 'UTC billing day [pii=none;deletable=false]',
  build_seq UInt64 COMMENT 'Sealed build seq [pii=none;deletable=false]',
  billable_pvs UInt64 COMMENT 'Billable PV count (trust >= continuity, not abuse_hold) [pii=none;deletable=false]',
  frames_stored UInt64 COMMENT 'Stored frames count [pii=none;deletable=false]',
  bytes_ingested UInt64 COMMENT 'Total ingested bytes [pii=none;deletable=false]'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(day_utc)
ORDER BY (tenant_id, site_id, day_utc, build_seq)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000;

-- Dual-layer ClickHouse tenant isolation row policies for usage_day (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_usage_day_tenant_permissive ON usage_day AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_usage_day_tenant_restrictive ON usage_day AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;

-- Table: visitor_period (Exact distinct visitors per built period.)
-- Retention: site_class | Deletion: by_visitor_key
CREATE TABLE IF NOT EXISTS visitor_period (
  tenant_id LowCardinality(String) COMMENT 'Tenant boundary key [pii=none;deletable=false]',
  site_id LowCardinality(String) COMMENT 'Site boundary key [pii=none;deletable=false]',
  exp_week Date COMMENT 'Expiry partition week [pii=none;deletable=false]',
  grain LowCardinality(String) COMMENT 'day | week | month [pii=none;deletable=false]',
  period Date COMMENT 'Period start date [pii=none;deletable=false]',
  visitor_key String COMMENT 'Visitor key [pii=visitor_id;deletable=true]'
)
ENGINE = AggregatingMergeTree()
PARTITION BY exp_week
ORDER BY (tenant_id, site_id, grain, period, visitor_key)
TTL exp_week + INTERVAL 7 DAY DELETE
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Dual-layer ClickHouse tenant isolation row policies for visitor_period (§5.6 / STORE M7)
CREATE ROW POLICY IF NOT EXISTS rp_visitor_period_tenant_permissive ON visitor_period AS PERMISSIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
CREATE ROW POLICY IF NOT EXISTS rp_visitor_period_tenant_restrictive ON visitor_period AS RESTRICTIVE FOR SELECT USING tenant_id = replaceRegexpOne(currentUser(), '^ugk_ro_', '') TO ALL EXCEPT ugk_admin, ugk_loader, ugk_builder, ugk_eraser;
