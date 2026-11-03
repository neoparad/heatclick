/**
 * テナントコンテキストとサイト台帳 (`lib/sites/site-registry.ts`) のブリッジ。
 *
 * API Route から呼び出し、以下を一括で行う:
 *   1. `requireTenantContext()` で認証・テナント取得（未認証なら UNAUTHENTICATED throw）
 *   2. `?site_id=`（省略時はテナントの最初の許可サイト）を `resolveTenantSite(ctx.tenant_id, ...)` で解決
 *   3. `canAccessSite(ctx, site.siteId)` でテナント内のサイト権限を再確認（不一致なら FORBIDDEN throw）
 */

import { canAccessSite, requireTenantContext, type TenantContext } from '@/lib/tenant'
import { listTenantSites, resolveTenantSite, type FusionSiteRecord } from '@/lib/sites/site-registry'

export interface ActiveTenantSite {
  ctx: TenantContext
  site: FusionSiteRecord
}

export async function requireActiveTenantSite(request: Request): Promise<ActiveTenantSite> {
  const ctx = await requireTenantContext()
  const url = new URL(request.url)
  const requested = url.searchParams.get('site_id')?.trim() || ctx.site_ids[0] || ''
  if (!requested) {
    throw new Error('FORBIDDEN_NO_SITE')
  }

  let site = await resolveTenantSite(ctx.tenant_id, requested)
  if (!site) {
    // まだ台帳に詳細行が無い新規 site_id でも、JWT の site_ids に含まれていれば最小レコードを合成
    if (canAccessSite(ctx, requested)) {
      const all = await listTenantSites(ctx.tenant_id)
      site = all.find((s) => s.siteId === requested) ?? {
        tenantId: ctx.tenant_id,
        siteId: requested,
        siteName: requested,
        siteUrl: null,
        canonicalHost: null,
        linkscrawlHost: null,
        linkscrawlJobId: null,
        aireceiptSiteId: null,
        aireceiptInstallId: null,
        gscProperty: null,
        gscSitemapUrl: null,
        cfZoneId: null,
      }
    } else {
      throw new Error('FORBIDDEN_SITE')
    }
  }

  if (!canAccessSite(ctx, site.siteId)) {
    throw new Error('FORBIDDEN_SITE')
  }

  return { ctx, site }
}
