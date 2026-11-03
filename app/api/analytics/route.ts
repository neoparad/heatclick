/**
 * GET /api/analytics — AIreceipt collector read API のプロキシ（AIアクセス解析用）。
 *
 * 認証・テナント分離:
 *   - `requireActiveTenantSite` で JWT 検証 + サイト台帳 (`FusionSiteRecord`) 解決
 *   - collector が未設定の環境では 200 (source: "mock") に安全フォールバック
 */

import { NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { collectorConfigured, collectorGet, rangeQuery } from '@/lib/aiseo/collector'
import { generateMockAnalytics } from '@/lib/aiseo/mock'
import type { AgentStat, UrlStat } from '@/lib/aiseo/risk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  let active
  try {
    active = await requireActiveTenantSite(request)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }

  const { site } = active
  const collectorOpts = {
    siteId: site.aireceiptSiteId ?? undefined,
    installId: site.aireceiptInstallId ?? undefined,
  }

  if (!collectorConfigured(collectorOpts)) {
    return NextResponse.json(generateMockAnalytics(`${site.siteName} (mock)`))
  }

  try {
    const days = Number(new URL(request.url).searchParams.get('days')) || 30
    const { q } = rangeQuery(days)
    const [urls, agents] = await Promise.all([
      collectorGet<{ period: { dates: string[] }; ruleset_version: string; total: number; urls: UrlStat[] }>(
        '/v0/analytics/urls',
        q,
        collectorOpts,
      ),
      collectorGet<{ period: { dates: string[] }; ruleset_version: string; total: number; agents: AgentStat[] }>(
        '/v0/analytics/agents',
        q,
        collectorOpts,
      ),
    ])
    return NextResponse.json({
      source: 'live',
      site_label: site.siteName,
      urls,
      agents,
      fetched_at: new Date().toISOString(),
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'collector fetch failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
