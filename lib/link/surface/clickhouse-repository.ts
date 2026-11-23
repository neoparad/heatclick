/**
 * UGOKI LINK v2 — Option B ClickHouse Surface Repository (`lib/link/surface/clickhouse-repository.ts`)
 *
 * Bridges `SurfaceDataRepository` to the live ClickHouse v2 database (`ugoki_link_v2` by default
 * on existing ClickHouse under Option B; switchable to a dedicated 8 GiB ClickHouse node later by
 * setting `UGK_CLICKHOUSE_V2_URL`).
 *
 * Security invariants:
 * - Every query strictly binds `{tenant_id:String}` and `{site_id:String}` via ClickHouse query_params.
 * - Never fabricates mock numbers when ClickHouse is unreachable or returns 0 rows (`null` -> `not_collected`).
 * - Never reads `.env*` files directly (uses `process.env` only).
 */

import { sha256Hex } from '@/packages/contract/response';
import type { ConsentMode } from '@/packages/contract/schema';
import type {
  FusedInsightRow,
  SiteMetricsSnapshot,
  SiteRuntimeConfig,
  SurfaceDataRepository,
} from './pipeline';
import type { SegmentObservedMetricsRow } from './segments';
import type { JourneyEventObservation, UsageLedgerRow } from './journeys';

export interface ClickHouseV2ConnectionConfig {
  readonly url: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export interface SiteBootstrapEntry {
  readonly siteId: string;
  readonly tenantId: string;
  readonly siteName: string;
  readonly consentMode?: ConsentMode;
  readonly storageRegion?: string;
  readonly processingRegion?: string;
  readonly monthlyQuotaPvs?: number;
}

export function resolveClickHouseV2ConfigFromEnv(): ClickHouseV2ConnectionConfig | null {
  const url = (process.env.UGK_CLICKHOUSE_V2_URL ?? process.env.CLICKHOUSE_URL ?? '').trim();
  if (!url) return null;
  const database = (process.env.UGK_CLICKHOUSE_V2_DB ?? 'ugoki_link_v2').trim() || 'ugoki_link_v2';
  const username = (
    process.env.UGK_CLICKHOUSE_V2_RO_USERNAME ??
    process.env.CLICKHOUSE_RO_USERNAME ??
    process.env.CLICKHOUSE_USERNAME ??
    'default'
  ).trim();
  const password = (
    process.env.UGK_CLICKHOUSE_V2_RO_PASSWORD ??
    process.env.CLICKHOUSE_RO_PASSWORD ??
    process.env.CLICKHOUSE_PASSWORD ??
    ''
  ).trim();
  return { url, database, username, password };
}

export function parseSitesBootstrapFromEnv(): readonly SiteRuntimeConfig[] {
  const raw = process.env.UGK_SITES_BOOTSTRAP_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SiteBootstrapEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.siteId === 'string' && typeof e.tenantId === 'string')
      .map((e) => ({
        siteId: e.siteId,
        tenantId: e.tenantId,
        siteName: e.siteName ?? e.siteId,
        consentMode: e.consentMode ?? 'cookieless',
        storageRegion: e.storageRegion ?? 'jp',
        processingRegion: e.processingRegion ?? 'jp',
        monthlyQuotaPvs: e.monthlyQuotaPvs ?? 2_000_000,
      }));
  } catch {
    return [];
  }
}

interface ClickHouseMetricsRow {
  readonly pv_count?: number | string;
  readonly cv_count?: number | string;
  readonly avg_vis_ms?: number | string;
  readonly max_ts?: string;
}

/**
 * ClickHouse-backed SurfaceDataRepository with an in-memory read-through snapshot cache
 * (because `SurfacePipeline.execute()` is synchronous, routes call `prefetchSiteMetrics()`
 * before executing when `UGK_ENABLE_V2_PROD_WIRING=true`).
 */
export class ClickHouseSurfaceRepository implements SurfaceDataRepository {
  private readonly siteConfigs = new Map<string, SiteRuntimeConfig>();
  private readonly metricsCache = new Map<string, { snapshot: SiteMetricsSnapshot; fetchedAtMs: number }>();
  private readonly usageCache = new Map<string, readonly UsageLedgerRow[]>();
  private readonly cacheTtlMs: number;

  public constructor(
    private readonly chConfig: ClickHouseV2ConnectionConfig,
    options?: { readonly cacheTtlMs?: number; readonly initialSites?: readonly SiteRuntimeConfig[] }
  ) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 30_000;
    for (const site of options?.initialSites ?? []) {
      this.siteConfigs.set(site.siteId, site);
    }
  }

  public registerSiteConfig(cfg: SiteRuntimeConfig): void {
    this.siteConfigs.set(cfg.siteId, cfg);
  }

  public getSiteConfig(siteId: string): SiteRuntimeConfig | null {
    return this.siteConfigs.get(siteId) ?? null;
  }

  private metricsKey(tenantId: string, siteId: string, windowStart: string, windowEnd: string): string {
    return `${tenantId}|${siteId}|${windowStart}|${windowEnd}`;
  }

  public async prefetchSiteMetrics(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly nowMs?: number;
  }): Promise<SiteMetricsSnapshot | null> {
    const nowMs = params.nowMs ?? Date.now();
    const key = this.metricsKey(params.tenantId, params.siteId, params.windowStart, params.windowEnd);
    const cached = this.metricsCache.get(key);
    if (cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return cached.snapshot;
    }

    const db = this.chConfig.database.replace(/[^a-zA-Z0-9_]/g, '');
    const sql = [
      `SELECT`,
      `  count() AS pv_count,`,
      `  0 AS cv_count,`,
      `  avg(vis_ms) AS avg_vis_ms,`,
      `  toString(max(updated_at)) AS max_ts`,
      `FROM ${db}.pv_state`,
      `WHERE tenant_id = {tenant_id:String}`,
      `  AND site_id = {site_id:String}`,
      `  AND updated_at >= parseDateTimeBestEffort({window_start:String})`,
      `  AND updated_at <= parseDateTimeBestEffort({window_end:String})`,
      `FORMAT JSONEachRow`,
    ].join('\n');

    const base = this.chConfig.url.replace(/\/+$/, '');
    const url = new URL(`${base}/`);
    url.searchParams.set('query', sql);
    url.searchParams.set('param_tenant_id', params.tenantId);
    url.searchParams.set('param_site_id', params.siteId);
    url.searchParams.set('param_window_start', params.windowStart);
    url.searchParams.set('param_window_end', params.windowEnd);

    const headers: Record<string, string> = {};
    if (this.chConfig.username || this.chConfig.password) {
      headers['X-ClickHouse-User'] = this.chConfig.username;
      headers['X-ClickHouse-Key'] = this.chConfig.password;
    }

    try {
      const resp = await fetch(url.toString(), { method: 'GET', headers });
      if (!resp.ok) return null;
      const text = (await resp.text()).trim();
      if (!text) return null;
      const row = JSON.parse(text.split('\n')[0]) as ClickHouseMetricsRow;
      const pvCount = Number(row.pv_count ?? 0);
      if (!Number.isFinite(pvCount) || pvCount === 0) return null;

      const cvCount = Number(row.cv_count ?? 0);
      const avgVisMs = Number(row.avg_vis_ms ?? 0);
      const dataThrough = row.max_ts || new Date(nowMs).toISOString();
      const paramsHash = sha256Hex(key);
      const resultDigest = sha256Hex(text);

      const snapshot: SiteMetricsSnapshot = {
        connected: true,
        pageViews: pvCount,
        conversions: Number.isFinite(cvCount) ? cvCount : 0,
        avgFocalDwellMs: Number.isFinite(avgVisMs) ? Math.round(avgVisMs) : null,
        dataThrough,
        lagSeconds: 60,
        queryRefId: `ch_v2_${paramsHash.slice(0, 12)}`,
        paramsHash,
        resultDigest,
        collectionGen: 'v3',
      };
      this.metricsCache.set(key, { snapshot, fetchedAtMs: nowMs });
      return snapshot;
    } catch {
      return null;
    }
  }

  public queryMetrics(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly segmentId?: string;
  }): SiteMetricsSnapshot | null {
    const key = this.metricsKey(params.tenantId, params.siteId, params.windowStart, params.windowEnd);
    return this.metricsCache.get(key)?.snapshot ?? null;
  }

  public queryFusedInsights(): ReadonlyArray<FusedInsightRow> | null {
    return null;
  }

  public querySegmentMetrics(): ReadonlyArray<SegmentObservedMetricsRow> | null {
    return null;
  }

  public queryJourneyEvents(): ReadonlyArray<JourneyEventObservation> | null {
    return null;
  }

  public queryUsageRows(params: {
    readonly tenantId: string;
    readonly siteId: string;
  }): ReadonlyArray<UsageLedgerRow> | null {
    return this.usageCache.get(`${params.tenantId}|${params.siteId}`) ?? null;
  }
}
