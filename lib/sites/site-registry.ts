/**
 * 融合SaaS サイト台帳 (Control Plane Site Registry)
 *
 * 解決する課題 (STATE_2026-11-03.md §5 / PLAN.md P1):
 *   ugokimap (`CIP_xxxx`)、linkscrawl (`host` + `job_id`)、AIreceipt (`site_id` + `install_id`)、
 *   GSC (`property`) でサイトの呼び名がバラバラだったものを、テナント境界 (`tenant_id`) を
 *   厳守した単一のサイト台帳レコード (`FusionSiteRecord`) に統合する。
 *
 * 動作モード (`lib/auth/user-registry.ts` の `USER_REGISTRY` と連動):
 *   - `hardcode` (既定): dogfood シード定義 + 環境変数オーバーライド (`FUSION_SITE_REGISTRY_JSON`,
 *     `LINKSCRAWL_JOB_ID`, `AIRECEIPT_SITE_ID`, `AIRECEIPT_INSTALL_ID`, `GSC_PROPERTY`, `CLOUDFLARE_ZONE_ID`)
 *   - `db`: Postgres `tenant_sites` テーブル (migrations/2026-11-03-fusion-site-registry.sql) を参照。
 *     DB 行に未設定の列があれば dogfood 既定値で安全に補完 (段階的移行を壊さない)。
 *
 * セキュリティ不変条件 (CLAUDE.md ルール7 / REQ-SEC-104):
 *   - 全検索関数は `tenantId` を第1引数に必須とし、他テナントのサイトは絶対に返さない (`null` を返す)。
 */

import { getRegistryMode } from '@/lib/auth/user-registry'
import { authQuery } from '@/lib/db/postgres'
import { normalizeHost } from '@/lib/url/normalize-url'

export interface FusionSiteRecord {
  /** テナントID (例: `linkth_internal`) */
  tenantId: string
  /** ugokimap の site_id / tracking_id (主キー、例: `CIP_EcwUTHEZdIOAUqum`) */
  siteId: string
  /** 表示名 (例: `bihadashop.jp`) */
  siteName: string
  /** サイトの代表URL (例: `https://bihadashop.jp`) */
  siteUrl: string | null
  /** 正規化済みホスト名 (`www.` なし小文字、例: `bihadashop.jp`) */
  canonicalHost: string | null
  /** linkscrawl 側の対象ホスト名 (例: `bihadashop.jp`) */
  linkscrawlHost: string | null
  /** linkscrawl の最新または固定クロール job_id */
  linkscrawlJobId: string | null
  /** AIreceipt collector の site_id (例: `site_bihadashop` 等) */
  aireceiptSiteId: string | null
  /** AIreceipt collector の install_id */
  aireceiptInstallId: string | null
  /** Google Search Console の property (例: `sc-domain:bihadashop.jp` または `https://bihadashop.jp/`) */
  gscProperty: string | null
  /** Google Search Console の sitemap URL */
  gscSitemapUrl: string | null
  /** Cloudflare Analytics 対象 Zone ID */
  cfZoneId: string | null
}

/**
 * Dogfood 既定サイト定義 (`lib/auth/dogfood-users.ts` および `app/(proof)/install/page.tsx` と整合)
 */
const DEFAULT_DOGFOOD_SITES: ReadonlyArray<Omit<FusionSiteRecord, 'linkscrawlJobId' | 'aireceiptSiteId' | 'aireceiptInstallId' | 'gscProperty' | 'gscSitemapUrl' | 'cfZoneId'> & Partial<FusionSiteRecord>> = [
  {
    tenantId: 'linkth_internal',
    siteId: 'CIP_EcwUTHEZdIOAUqum',
    siteName: 'bihadashop.jp',
    siteUrl: 'https://bihadashop.jp',
    canonicalHost: 'bihadashop.jp',
    linkscrawlHost: 'bihadashop.jp',
    gscProperty: 'sc-domain:bihadashop.jp',
    gscSitemapUrl: 'https://bihadashop.jp/sitemap.xml',
  },
  {
    tenantId: 'linkth_internal',
    siteId: 'CIP_E3xzSWfXcXx6GaTL',
    siteName: 'link-th.co.jp (コーポレート)',
    siteUrl: 'https://link-th.co.jp',
    canonicalHost: 'link-th.co.jp',
    linkscrawlHost: 'link-th.co.jp',
    gscProperty: 'sc-domain:link-th.co.jp',
    gscSitemapUrl: 'https://link-th.co.jp/sitemap.xml',
  },
  {
    tenantId: 'linkth_internal',
    siteId: 'CIP_xginf3nVacnkn62o',
    siteName: 'site-2 (linkth internal)',
    siteUrl: null,
    canonicalHost: null,
    linkscrawlHost: null,
  },
  {
    tenantId: 'linkth_internal',
    siteId: 'CIP_6r2WofQDSKrOwxmM',
    siteName: 'site-3 (linkth internal)',
    siteUrl: null,
    canonicalHost: null,
    linkscrawlHost: null,
  },
  {
    tenantId: 'linkth_internal',
    siteId: 'CIP_8eN7xgfBtDAnzE26',
    siteName: 'site-4 (linkth internal)',
    siteUrl: null,
    canonicalHost: null,
    linkscrawlHost: null,
  },
  {
    tenantId: 'linkth_internal',
    siteId: 'CIP_QWaPiks5krukJ6NM',
    siteName: 'site-5 (linkth internal)',
    siteUrl: null,
    canonicalHost: null,
    linkscrawlHost: null,
  },
]

function applyEnvDefaults(base: FusionSiteRecord): FusionSiteRecord {
  // bihadashop.jp (既定プライマリサイト) には単一サイト用の環境変数 (LINKSCRAWL_JOB_ID / AIRECEIPT_* / GSC_*) をフォールバック適用
  const isBihada = base.siteId === 'CIP_EcwUTHEZdIOAUqum' || base.canonicalHost === 'bihadashop.jp'
  if (!isBihada) return base

  return {
    ...base,
    linkscrawlJobId: base.linkscrawlJobId ?? (process.env.LINKSCRAWL_JOB_ID?.trim() || null),
    aireceiptSiteId: base.aireceiptSiteId ?? (process.env.AIRECEIPT_SITE_ID?.trim() || null),
    aireceiptInstallId: base.aireceiptInstallId ?? (process.env.AIRECEIPT_INSTALL_ID?.trim() || null),
    gscProperty: base.gscProperty ?? (process.env.GSC_PROPERTY?.trim() || 'sc-domain:bihadashop.jp'),
    gscSitemapUrl:
      base.gscSitemapUrl ?? (process.env.GSC_SITEMAP_URL?.trim() || 'https://bihadashop.jp/sitemap.xml'),
    cfZoneId: base.cfZoneId ?? (process.env.CLOUDFLARE_ZONE_ID?.trim() || null),
  }
}

function loadEnvRegistryOverrides(): Map<string, Partial<FusionSiteRecord>> {
  const map = new Map<string, Partial<FusionSiteRecord>>()
  const raw = process.env.FUSION_SITE_REGISTRY_JSON
  if (!raw) return map
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return map
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof item.siteId === 'string') {
        map.set(item.siteId, item as Partial<FusionSiteRecord>)
      }
    }
  } catch {
    // ignore malformed JSON
  }
  return map
}

function buildHardcodeSites(tenantId: string): FusionSiteRecord[] {
  const overrides = loadEnvRegistryOverrides()
  const records: FusionSiteRecord[] = []

  for (const seed of DEFAULT_DOGFOOD_SITES) {
    if (seed.tenantId !== tenantId) continue
    const ov = overrides.get(seed.siteId) ?? {}
    const canonicalHost =
      normalizeHost(ov.canonicalHost ?? seed.canonicalHost ?? ov.siteUrl ?? seed.siteUrl) ?? null
    const linkscrawlHost =
      normalizeHost(ov.linkscrawlHost ?? seed.linkscrawlHost ?? canonicalHost) ?? canonicalHost

    const merged: FusionSiteRecord = applyEnvDefaults({
      tenantId: seed.tenantId,
      siteId: seed.siteId,
      siteName: ov.siteName ?? seed.siteName,
      siteUrl: ov.siteUrl ?? seed.siteUrl ?? null,
      canonicalHost,
      linkscrawlHost,
      linkscrawlJobId: ov.linkscrawlJobId ?? seed.linkscrawlJobId ?? null,
      aireceiptSiteId: ov.aireceiptSiteId ?? seed.aireceiptSiteId ?? null,
      aireceiptInstallId: ov.aireceiptInstallId ?? seed.aireceiptInstallId ?? null,
      gscProperty: ov.gscProperty ?? seed.gscProperty ?? null,
      gscSitemapUrl: ov.gscSitemapUrl ?? seed.gscSitemapUrl ?? null,
      cfZoneId: ov.cfZoneId ?? seed.cfZoneId ?? null,
    })
    records.push(merged)
  }

  // overrides に新規 siteId (該当 tenantId) が含まれていれば追加
  for (const [siteId, ov] of Array.from(overrides.entries())) {
    if (ov.tenantId !== tenantId) continue
    if (records.some((r) => r.siteId === siteId)) continue
    const canonicalHost = normalizeHost(ov.canonicalHost ?? ov.siteUrl ?? null)
    records.push(
      applyEnvDefaults({
        tenantId,
        siteId,
        siteName: ov.siteName ?? siteId,
        siteUrl: ov.siteUrl ?? null,
        canonicalHost,
        linkscrawlHost: normalizeHost(ov.linkscrawlHost ?? canonicalHost) ?? canonicalHost,
        linkscrawlJobId: ov.linkscrawlJobId ?? null,
        aireceiptSiteId: ov.aireceiptSiteId ?? null,
        aireceiptInstallId: ov.aireceiptInstallId ?? null,
        gscProperty: ov.gscProperty ?? null,
        gscSitemapUrl: ov.gscSitemapUrl ?? null,
        cfZoneId: ov.cfZoneId ?? null,
      }),
    )
  }

  return records
}

interface DbTenantSiteRow {
  tenant_id: string
  site_id: string
  site_name?: string | null
  site_url?: string | null
  canonical_host?: string | null
  linkscrawl_host?: string | null
  linkscrawl_job_id?: string | null
  aireceipt_site_id?: string | null
  aireceipt_install_id?: string | null
  gsc_property?: string | null
  gsc_sitemap_url?: string | null
  cf_zone_id?: string | null
}

async function loadDbSites(tenantId: string): Promise<FusionSiteRecord[]> {
  const rows = await authQuery<DbTenantSiteRow>(
    `SELECT * FROM tenant_sites WHERE tenant_id = $1 ORDER BY site_id`,
    [tenantId],
  )
  const hardcodeFallbackMap = new Map(
    buildHardcodeSites(tenantId).map((s) => [s.siteId, s] as const),
  )

  return rows.map((r) => {
    const fb = hardcodeFallbackMap.get(r.site_id)
    const canonicalHost =
      normalizeHost(r.canonical_host ?? r.site_url ?? fb?.canonicalHost ?? null) ?? null
    const linkscrawlHost =
      normalizeHost(r.linkscrawl_host ?? fb?.linkscrawlHost ?? canonicalHost) ?? canonicalHost

    return applyEnvDefaults({
      tenantId: r.tenant_id,
      siteId: r.site_id,
      siteName: r.site_name ?? fb?.siteName ?? r.site_id,
      siteUrl: r.site_url ?? fb?.siteUrl ?? null,
      canonicalHost,
      linkscrawlHost,
      linkscrawlJobId: r.linkscrawl_job_id ?? fb?.linkscrawlJobId ?? null,
      aireceiptSiteId: r.aireceipt_site_id ?? fb?.aireceiptSiteId ?? null,
      aireceiptInstallId: r.aireceipt_install_id ?? fb?.aireceiptInstallId ?? null,
      gscProperty: r.gsc_property ?? fb?.gscProperty ?? null,
      gscSitemapUrl: r.gsc_sitemap_url ?? fb?.gscSitemapUrl ?? null,
      cfZoneId: r.cf_zone_id ?? fb?.cfZoneId ?? null,
    })
  })
}

/**
 * テナントに属する全サイト台帳レコードを取得する。
 */
export async function listTenantSites(tenantId: string): Promise<FusionSiteRecord[]> {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required for listTenantSites')
  }
  if (getRegistryMode() === 'db') {
    return loadDbSites(tenantId)
  }
  return buildHardcodeSites(tenantId)
}

/**
 * 任意の識別子 (ugokimap `siteId` / ホスト名 / URL / AIreceipt `site_id` / AIreceipt `install_id` / GSC `property`)
 * から、当該テナント内のサイト台帳レコードを1件解決する。
 *
 * 他テナントのサイトや未登録の識別子は `null` を返す (テナント隔離の強制)。
 */
export async function resolveTenantSite(
  tenantId: string,
  identifier: string | null | undefined,
): Promise<FusionSiteRecord | null> {
  if (!tenantId || !identifier || typeof identifier !== 'string') return null
  const trimmed = identifier.trim()
  if (!trimmed) return null

  const sites = await listTenantSites(tenantId)

  // 1. ugokimap siteId (CIP_xxxx) 完全一致
  const bySiteId = sites.find((s) => s.siteId === trimmed)
  if (bySiteId) return bySiteId

  // 2. AIreceipt site_id または install_id 完全一致
  const byAireceipt = sites.find(
    (s) => s.aireceiptSiteId === trimmed || s.aireceiptInstallId === trimmed,
  )
  if (byAireceipt) return byAireceipt

  // 3. linkscrawl job_id 完全一致
  const byJobId = sites.find((s) => s.linkscrawlJobId === trimmed)
  if (byJobId) return byJobId

  // 4. GSC property 完全一致
  const byGscProp = sites.find(
    (s) => s.gscProperty && s.gscProperty.toLowerCase() === trimmed.toLowerCase(),
  )
  if (byGscProp) return byGscProp

  // 5. 正規化ホスト名 (`bihadashop.jp`, `https://www.bihadashop.jp/...`, `sc-domain:bihadashop.jp`) で一致
  const targetHost = normalizeHost(trimmed)
  if (targetHost) {
    const byHost = sites.find(
      (s) => s.canonicalHost === targetHost || s.linkscrawlHost === targetHost,
    )
    if (byHost) return byHost
  }

  return null
}
