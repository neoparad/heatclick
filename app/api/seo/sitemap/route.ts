import { NextRequest, NextResponse } from 'next/server'
import { requireActiveTenantSite } from '@/lib/aiseo/active-site'
import { authQuery, isAuthDbConfigured } from '@/lib/db/postgres'
import { generateSitemapMock } from '@/lib/seo/mock'

export const dynamic = 'force-dynamic'

const LABEL_MAP: Record<string, [string, string]> = {
  'Submitted and indexed': ['登録済み（サイトマップ送信）', '正常'],
  'Indexed, not submitted in sitemap': ['登録済み（サイトマップ未送信）', 'sitemap.xml への追加を検討'],
  'Crawled - currently not indexed': ['クロール済み - インデックス未登録', '内容の独自性・内部リンク発リンク数を強化'],
  'Discovered - currently not indexed': ['検出 - インデックス未登録', '孤立ページ解消・クロールバジェット確認'],
  'Excluded by noindex tag': ['noindex タグにより除外', '意図通りか確認（タグ/アーカイブ等）'],
  'Duplicate, Google chose different canonical than user': ['重複（別カノニカル選択）', 'canonical 指定と内部リンク先を統一'],
  'Alternate page with proper canonical tag': ['代替ページ（canonical 適正）', '対応不要'],
  'Page with redirect': ['リダイレクトのあるページ', '内部リンク先を最終URLに更新'],
  'Not found (404)': ['見つかりませんでした (404)', 'リンク切れ修正 または 301 設定'],
  'Blocked by robots.txt': ['robots.txt によりブロック', '意図通りか確認'],
  'Soft 404': ['ソフト 404', '本文拡充 または 404/301 を返す'],
  'Server error (5xx)': ['サーバーエラー (5xx)', 'オリジン応答・タイムアウトを調査'],
  'Redirect error': ['リダイレクト エラー', 'リダイレクトチェーンを1段に短縮'],
  'URL is unknown to Google': ['Google に認識されていない URL', '内部リンク追加・インデックス登録リクエスト'],
}

export async function GET(req: NextRequest) {
  let active
  try {
    active = await requireActiveTenantSite(req)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'UNAUTHORIZED'
    const status = msg.startsWith('FORBIDDEN') ? 403 : 401
    return NextResponse.json({ error: msg }, { status })
  }
  const { ctx, site } = active
  const tenantId = ctx.tenant_id

  const sp = req.nextUrl.searchParams
  if (!isAuthDbConfigured() || sp.get('mock') === '1') {
    return NextResponse.json(generateSitemapMock())
  }

  try {
    const targets = await authQuery<{
      id: string
      property: string
      sitemap_url: string
      daily_quota: number
    }>(
      `SELECT id, property, sitemap_url, daily_quota
         FROM gsc_targets
        WHERE tenant_id = $1 AND site_id = $2
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId, site.siteId]
    )

    if (targets.length === 0) {
      return NextResponse.json({
        ...generateSitemapMock(),
        source: 'mock-no-target',
        note: 'No gsc_targets row yet; run /api/seo/sitemap/inspect first.',
      })
    }

    const target = targets[0]
    const [rows, summaries] = await Promise.all([
      authQuery<{
        url: string
        verdict: string | null
        coverage_state: string | null
        indexing_state: string | null
        page_fetch_state: string | null
        robots_txt_state: string | null
        crawled_as: string | null
        last_crawl_time: string | null
        google_canonical: string | null
        user_canonical: string | null
        referring_urls: string[] | null
        sitemaps: string[] | null
        inspected_at: string | null
        error: string | null
      }>(
        `SELECT url, verdict, coverage_state, indexing_state, page_fetch_state, robots_txt_state,
                crawled_as, last_crawl_time, google_canonical, user_canonical,
                referring_urls, sitemaps, inspected_at, error
           FROM gsc_inspection
          WHERE tenant_id = $1 AND target_id = $2
          ORDER BY inspected_at DESC
          LIMIT 5000`,
        [tenantId, target.id]
      ),
      authQuery<{
        day: string
        sitemap_total: number
        inspected_total: number
        indexed: number
        excluded: number
        error_count: number
        not_inspected: number
      }>(
        `SELECT day::text AS day, sitemap_total, inspected_total, indexed, excluded, error_count, not_inspected
           FROM gsc_index_summary
          WHERE tenant_id = $1 AND target_id = $2
          ORDER BY day ASC
          LIMIT 90`,
        [tenantId, target.id]
      ),
    ])

    let indexed = 0
    let excluded = 0
    let errors = 0
    let lastFetched: string | null = null
    const bucket = new Map<string, { verdict: string; count: number }>()

    const pages = rows.map((r) => {
      if (r.verdict === 'PASS') indexed++
      else if (r.verdict === 'FAIL') errors++
      else if (r.verdict) excluded++

      if (!lastFetched || (r.inspected_at && r.inspected_at > lastFetched)) {
        lastFetched = r.inspected_at
      }

      const key = r.coverage_state || r.verdict || 'UNKNOWN'
      const cur = bucket.get(key) || { verdict: r.verdict || 'NEUTRAL', count: 0 }
      cur.count++
      bucket.set(key, cur)

      const [labelJa] = LABEL_MAP[key] || [key, '']
      const sitemaps = Array.isArray(r.sitemaps) ? r.sitemaps : []
      const refs = Array.isArray(r.referring_urls) ? r.referring_urls : []
      return {
        url: r.url,
        verdict: r.verdict || 'NEUTRAL',
        coverageState: key,
        labelJa,
        indexingState: r.indexing_state,
        pageFetchState: r.page_fetch_state,
        robotsTxtState: r.robots_txt_state,
        crawledAs: r.crawled_as,
        lastCrawlTime: r.last_crawl_time,
        googleCanonical: r.google_canonical,
        userCanonical: r.user_canonical,
        inSitemap: sitemaps.length > 0,
        referringCount: refs.length,
        inspectedAt: r.inspected_at,
        error: r.error,
      }
    })

    const breakdown = Array.from(bucket.entries())
      .map(([key, v]) => {
        const [label, action] = LABEL_MAP[key] || [key, '要確認']
        return { key, label, verdict: v.verdict, count: v.count, action }
      })
      .sort((a, b) => b.count - a.count)

    const latestSum = summaries[summaries.length - 1]
    const sitemapSubmitted = latestSum?.sitemap_total || pages.length

    const dailyCoverage = summaries.map((s) => {
      const denom = s.indexed + s.excluded + s.error_count || 1
      return {
        date: s.day,
        indexed: s.indexed,
        excluded: s.excluded,
        errors: s.error_count,
        rate: +(s.indexed / denom).toFixed(3),
      }
    })

    return NextResponse.json({
      source: 'postgres',
      site: target.property,
      summary: {
        sitemapUrl: target.sitemap_url,
        sitemapSubmitted,
        inspectedTotal: pages.length,
        indexed,
        excluded,
        errors,
        lastFetched,
      },
      breakdown,
      dailyCoverage,
      pages,
    })
  } catch (err) {
    return NextResponse.json({
      ...generateSitemapMock(),
      source: 'mock-fallback',
      error: (err as Error)?.message || String(err),
    })
  }
}
