/**
 * Local re-export wrapper for ugokimap-contracts types.
 *
 * dispatch-04 配備で `@ugokimap/contracts/types/ts` から正規 import が可能だが、
 * Cloudflare Workers の wrangler build は monorepo file: link / npm install が
 * deploy 時点で確実に効くとは限らないため、本 wrapper で必要最小の interface のみ
 * 再宣言する。schema 変更時は両 repo CI (contracts-test.yml) で drift 検知される。
 *
 * Source: `C:\Users\M2603\ugokimap-contracts\schemas\*.schema.json`
 * 自動生成 TS は `audience_ids` を maxItems tuple として記述するため、本 Worker では
 * `string[]` の意味的等価を採用 (validation は ajv 側で行う前提)。
 */

export type EvidenceLevel = 'proven' | 'observed' | 'inferred' | 'planned';
export type ConsentTriple = { analytics: boolean; personalization: boolean; ads: boolean };

export interface RuleBundle {
  schema_version: string;
  version: string;
  tenant_id: string;
  site_id: string;
  /**
   * dispatch-14 / 続 103 (Phase 2A.1 B6): Owner 配布の tracking_id alias (CIP_*).
   * tracking.js v2.4.0+ が `?site_id=<tracking_id>` で送出するため、worker は
   * site_id verify を bundle.site_id (UUID v4) または bundle.tracking_id どちらかの一致で OK 判定。
   * Optional、wakegai 等の legacy tracking_id 経路サポート用。
   */
  tracking_id?: string;
  published_at: string;
  consent_flags?: ConsentTriple;
  performance_budget: {
    max_gzip_bytes: number;
    max_main_thread_ms: number;
    max_cls: number;
  };
  banners: BannerConfig[];
  audience_membership_index?: Record<string, string[]>;
  fallback?: {
    action?: 'no_op' | 'show_default_banner';
    default_banner_id?: string | null;
  };
}

export interface BannerConfig {
  banner_id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'active' | 'paused' | 'archived';
  schedule?: { starts_at?: string | null; ends_at?: string | null };
  audience_targeting: {
    operator: 'AND' | 'OR' | 'NONE';
    audience_ids: string[];
    exclude_audience_ids?: string[];
    match_rate_cap?: number | null;
  };
  display: {
    placement: 'bottom-bar' | 'modal' | 'inline-cta' | 'exit-intent' | 'scroll-trigger';
    template_id: string;
    content_variables?: Record<string, string | number | boolean | null | undefined>;
    css_class?: string;
  };
  sensitive_category_excluded?: boolean;
  created_at: string;
  updated_at?: string | null;
  evidence_level?: EvidenceLevel;
}

export interface MemberAttribute {
  schema_version?: string;
  tenant_id: string;
  ga_client_id: string;
  audience_flags: string[];
  consent?: ConsentTriple;
  source?: 'gtm_datalayer' | 'cookie_fallback' | 'bigquery_sync' | 'manual';
  last_synced_at: string;
  ttl_hours?: number;
}

export interface WorkerResponse {
  status: 'ok' | 'no_match' | 'consent_denied' | 'fallback' | 'error';
  tenant_id: string;
  site_id: string;
  ga_client_id?: string | null;
  decision: {
    banner_id?: string | null;
    template_id?: string | null;
    content_variables?: Record<string, string | number | boolean | null | undefined>;
    css_class?: string | null;
    nonce?: string | null;
  };
  served_at: string;
  audit_correlation_id?: string;
  evidence_level?: EvidenceLevel | null;
  debug?: {
    matched_audience_ids?: string[];
    bundle_version?: string | null;
    lookup_ms?: number | null;
  };
}
