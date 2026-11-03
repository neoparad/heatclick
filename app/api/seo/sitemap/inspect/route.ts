import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { authQuery, isAuthDbConfigured } from '@/lib/db/postgres'
import { fetchSitemapUrls, inspectUrl, isGscConfigured } from '@/lib/seo/gsc'

export const dynamic = 'force-dynamic'

async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

export async function POST(req: NextRequest) {
  const ctx = await requireActiveTenantSite(req)
  if (!ctx.ok) return ctx.response
  const { tenantId, site } = ctx

  const secret = process.env.INSPECT_CRON_SECRET
  if (secret) {
    const got = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')
    if (got !== secret) {
      return NextResponse.json({ error: 'unauthorized cron secret' }, { status: 401 })
    }
  }

  if (!isAuthDbConfigured()) {
    return NextResponse.json({ error: 'AUTH_DATABASE_URL not configured' }, { status: 503 })
  }
  if (!isGscConfigured()) {
    return NextResponse.json({ error: 'GSC_SA_KEY_JSON or GSC_SA_KEY_FILE not configured' }, { status: 503 })
  }

  const sp = req.nextUrl.searchParams
  const property = sp.get('property') || site.gscProperty || process.env.GSC_SITE_URL || `sc-domain:${site.canonicalHost}`
  const sitemapUrl =
    sp.get('sitemap') || process.env.GSC_SITEMAP_URL || `https://${site.canonicalHost}/sitemap.xml`
  const limit = Math.min(2000, Math.max(1, Number(sp.get('limit') || 200)))
  const concurrency = Math.min(8, Math.max(1, Number(sp.get('concurrency') || 4)))
  const staleDays = Math.max(0, Number(sp.get('staleDays') ?? 7))

  try {
    const targetRows = await authQuery<{
      id: string
      property: string
      sitemap_url: string
      daily_quota: number
    }>(
      `INSERT INTO gsc_targets (tenant_id, site_id, property, sitemap_url, daily_quota, enabled)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (tenant_id, property, sitemap_url)
       DO UPDATE SET site_id = EXCLUDED.site_id, enabled = TRUE
       RETURNING id, property, sitemap_url, daily_quota`,
      [tenantId, site.siteId, property, sitemapUrl, limit]
    )
    const target = targetRows[0]

    const sitemapUrls = await fetchSitemapUrls(sitemapUrl, 10000)

    const existing = await authQuery<{
      url: string
      inspected_at: string | null
      verdict: string | null
    }>(
      `SELECT url, inspected_at, verdict
         FROM gsc_inspection
        WHERE tenant_id = $1 AND target_id = $2`,
      [tenantId, target.id]
    )
    const byUrl = new Map(existing.map((r) => [r.url, r]))

    const cutoff = Date.now() - staleDays * 86400 * 1000
    const uninspected: string[] = []
    const staleFailed: Array<{ u: string; t: number }> = []
    const staleOther: Array<{ u: string; t: number }> = []

    for (const u of sitemapUrls) {
      const row = byUrl.get(u)
      if (!row || !row.inspected_at) {
        uninspected.push(u)
      } else {
        const t = new Date(row.inspected_at).getTime()
        if (t < cutoff) {
          if (row.verdict !== 'PASS') staleFailed.push({ u, t })
          else staleOther.push({ u, t })
        }
      }
    }
    staleFailed.sort((a, b) => a.t - b.t)
    staleOther.sort((a, b) => a.t - b.t)

    const queue = [
      ...uninspected,
      ...staleFailed.map((x) => x.u),
      ...staleOther.map((x) => x.u),
    ].slice(0, limit)

    const nowIso = new Date().toISOString()
    const inspected = await runPool(queue, concurrency, async (u) => {
      try {
        const r = await inspectUrl(property, u)
        return {
          url: u,
          verdict: (r.verdict as string) || 'VERDICT_UNSPECIFIED',
          coverage_state: (r.coverageState as string) || null,
          indexing_state: (r.indexingState as string) || null,
          page_fetch_state: (r.pageFetchState as string) || null,
          robots_txt_state: (r.robotsTxtState as string) || null,
          crawled_as: (r.crawledAs as string) || null,
          last_crawl_time: (r.lastCrawlTime as string) || null,
          google_canonical: (r.googleCanonical as string) || null,
          user_canonical: (r.userCanonical as string) || null,
          referring_urls: (r.referringUrls as string[]) || [],
          sitemaps: (r.sitemap as string[]) || [],
          inspected_at: nowIso,
          error: null,
        }
      } catch (e) {
        return {
          url: u,
          verdict: 'ERROR',
          coverage_state: null,
          indexing_state: null,
          page_fetch_state: null,
          robots_txt_state: null,
          crawled_as: null,
          last_crawl_time: null,
          google_canonical: null,
          user_canonical: null,
          referring_urls: [],
          sitemaps: [],
          inspected_at: nowIso,
          error: String((e as Error)?.message || e).slice(0, 500),
        }
      }
    })

    for (const row of inspected) {
      await authQuery(
        `INSERT INTO gsc_inspection (
           tenant_id, target_id, url, verdict, coverage_state, indexing_state,
           page_fetch_state, robots_txt_state, crawled_as, last_crawl_time,
           google_canonical, user_canonical, referring_urls, sitemaps, inspected_at, error
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13::jsonb, $14::jsonb, $15, $16
         )
         ON CONFLICT (target_id, url) DO UPDATE SET
           verdict = EXCLUDED.verdict,
           coverage_state = EXCLUDED.coverage_state,
           indexing_state = EXCLUDED.indexing_state,
           page_fetch_state = EXCLUDED.page_fetch_state,
           robots_txt_state = EXCLUDED.robots_txt_state,
           crawled_as = EXCLUDED.crawled_as,
           last_crawl_time = EXCLUDED.last_crawl_time,
           google_canonical = EXCLUDED.google_canonical,
           user_canonical = EXCLUDED.user_canonical,
           referring_urls = EXCLUDED.referring_urls,
           sitemaps = EXCLUDED.sitemaps,
           inspected_at = EXCLUDED.inspected_at,
           error = EXCLUDED.error`,
        [
          tenantId,
          target.id,
          row.url,
          row.verdict,
          row.coverage_state,
          row.indexing_state,
          row.page_fetch_state,
          row.robots_txt_state,
          row.crawled_as,
          row.last_crawl_time,
          row.google_canonical,
          row.user_canonical,
          JSON.stringify(row.referring_urls),
          JSON.stringify(row.sitemaps),
          row.inspected_at,
          row.error,
        ]
      )
    }

    const allRows = await authQuery<{
      verdict: string | null
      coverage_state: string | null
    }>(
      `SELECT verdict, coverage_state
         FROM gsc_inspection
        WHERE tenant_id = $1 AND target_id = $2`,
      [tenantId, target.id]
    )

    let indexed = 0
    let excluded = 0
    let errorCount = 0
    const verdictCounts: Record<string, number> = {}
    for (const r of allRows) {
      if (r.verdict === 'PASS') indexed++
      else if (r.verdict === 'FAIL') errorCount++
      else if (r.verdict === 'NEUTRAL') excluded++
      const k = r.coverage_state || r.verdict || 'UNKNOWN'
      verdictCounts[k] = (verdictCounts[k] || 0) + 1
    }

    const today = nowIso.slice(0, 10)
    await authQuery(
      `INSERT INTO gsc_index_summary (
         tenant_id, target_id, day, sitemap_total, inspected_total,
         indexed, excluded, error_count, not_inspected, verdict_counts
       ) VALUES (
         $1, $2, $3::date, $4, $5,
         $6, $7, $8, $9, $10::jsonb
       )
       ON CONFLICT (target_id, day) DO UPDATE SET
         sitemap_total = EXCLUDED.sitemap_total,
         inspected_total = EXCLUDED.inspected_total,
         indexed = EXCLUDED.indexed,
         excluded = EXCLUDED.excluded,
         error_count = EXCLUDED.error_count,
         not_inspected = EXCLUDED.not_inspected,
         verdict_counts = EXCLUDED.verdict_counts`,
      [
        tenantId,
        target.id,
        today,
        sitemapUrls.length,
        allRows.length,
        indexed,
        excluded,
        errorCount,
        Math.max(0, sitemapUrls.length - allRows.length),
        JSON.stringify(verdictCounts),
      ]
    )

    return NextResponse.json({
      ok: true,
      target: { id: target.id, property, sitemapUrl },
      sitemapTotal: sitemapUrls.length,
      inspectedThisRun: inspected.length,
      totals: {
        inspected: allRows.length,
        indexed,
        excluded,
        errorCount,
        notInspected: Math.max(0, sitemapUrls.length - allRows.length),
      },
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || String(err) }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return POST(req)
}
