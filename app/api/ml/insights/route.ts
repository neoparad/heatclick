import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { buildPragmaticMlInsightsForUrl } from '@/lib/ml/pragmatic-ml-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  let siteId = sp.get('site_id') || 'default'

  if (!sp.get('site_id')) {
    try {
      const active = await requireActiveTenantSite(req)
      siteId = active.site.siteId || 'default'
    } catch {
      siteId = 'default'
    }
  }

  const url =
    sp.get('url') || 'https://link-th.com/entry/internal-link-optimization'

  const insights = await buildPragmaticMlInsightsForUrl({
    siteId,
    url,
  })

  return NextResponse.json({
    ok: true,
    data: {
      bottleneckAttribution: insights.bottleneckAttribution,
      scrollSurvival: insights.scrollSurvival,
      upliftPresets: insights.upliftPresets,
      semanticLinks: insights.semanticLinks,
      methodologyNote: insights.methodologyNote,
    },
  })
}
