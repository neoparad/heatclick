/**
 * Deterministic mock datasets for SEO Access, Sitemap Inspection, and Internal Links.
 * Used when GSC Service Account, Auth DB cache, or linkscrawl API are not yet connected locally.
 */
import type { SeoPageRow, SeoPairRow, SeoQueryRow } from './filter'

function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

const QUERIES: Array<[string, number, number, number]> = [
  ['内部リンク 最適化', 320, 4800, 3.2],
  ['SEO 記事構成 AI', 280, 5200, 4.1],
  ['サイトマップ 送信 方法', 210, 6100, 5.8],
  ['クローラビリティ 改善', 190, 2900, 3.6],
  ['AIO 対策 とは', 175, 4400, 6.2],
  ['LLMO 最適化', 162, 3100, 4.9],
  ['孤立ページ 検出', 148, 1800, 2.4],
  ['構造化データ JSON-LD 書き方', 134, 5900, 7.3],
  ['Search Console インデックス 未登録', 128, 7200, 8.9],
  ['アンカーテキスト 最適化', 118, 2400, 4.5],
  ['トピッククラスター 設計', 104, 1950, 3.8],
  ['robots.txt AI クローラー', 96, 2200, 5.1],
  ['canonical URL 正規化', 88, 3400, 6.8],
  ['Core Web Vitals 改善', 82, 4600, 9.4],
  ['Perplexity 引用 対策', 76, 1500, 3.1],
  ['ChatGPT 検索 表示されるには', 71, 2800, 5.6],
  ['E-E-A-T 強化 方法', 64, 3900, 8.2],
  ['パンくずリスト 構造化', 58, 2100, 6.0],
  ['ページ速度 LCP 改善', 52, 3300, 10.1],
  ['タイトルタグ 文字数 SEO', 49, 4100, 7.7],
]

const PAGES: Array<[string, number, number, number]> = [
  ['https://link-th.com/entry/internal-link-optimization', 610, 9800, 3.4],
  ['https://link-th.com/entry/aio-llmo-guide', 485, 8600, 4.6],
  ['https://link-th.com/entry/sitemap-index-troubleshooting', 392, 11400, 6.8],
  ['https://link-th.com/entry/topic-cluster-design', 310, 5400, 3.9],
  ['https://link-th.com/entry/orphan-page-audit', 268, 3600, 2.7],
  ['https://link-th.com/entry/ai-crawler-robots-llms-txt', 224, 4900, 5.2],
  ['https://link-th.com/entry/json-ld-schema-patterns', 198, 7800, 7.5],
  ['https://link-th.com/entry/anchor-text-diversity', 176, 3200, 4.3],
  ['https://link-th.com/column/perplexity-citation-study', 152, 2900, 3.5],
  ['https://link-th.com/column/eeat-checklist-2026', 134, 6200, 8.1],
  ['https://link-th.com/tools/sitemap-checker', 118, 4100, 5.9],
  ['https://link-th.com/', 104, 2400, 2.1],
]

export function generateSeoAccessMock(days = 28, siteUrl = 'sc-domain:link-th.com') {
  const rand = rng(days * 97 + 13)
  const scale = days / 28

  const daily: Array<{
    date: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }> = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i - 2)
    const dow = d.getUTCDay()
    const wknd = dow === 0 || dow === 6 ? 0.72 : 1
    const trend = 1 + ((days - i) / days) * 0.18
    const impressions = Math.round((2100 + rand() * 500) * wknd * trend)
    const ctr = 0.042 + (rand() - 0.5) * 0.008
    const clicks = Math.round(impressions * ctr)
    const position = +(5.8 - ((days - i) / days) * 0.6 + (rand() - 0.5) * 0.4).toFixed(2)
    daily.push({
      date: d.toISOString().slice(0, 10),
      clicks,
      impressions,
      ctr: +ctr.toFixed(4),
      position,
    })
  }

  const queries: SeoQueryRow[] = QUERIES.map(([query, c, imp, pos]) => {
    const clicks = Math.round(c * scale)
    const impressions = Math.round(imp * scale)
    const dc = +(rand() * 0.5 - 0.15).toFixed(3)
    const di = +(rand() * 0.4 - 0.1).toFixed(3)
    const dp = +((rand() - 0.55) * 1.6).toFixed(2)
    return {
      query,
      clicks,
      impressions,
      ctr: +(clicks / impressions).toFixed(4),
      position: pos,
      clicksDelta: dc,
      impressionsDelta: di,
      positionDelta: dp,
    }
  })

  const pages: SeoPageRow[] = PAGES.map(([page, c, imp, pos], idx) => {
    const clicks = Math.round(c * scale)
    const impressions = Math.round(imp * scale)
    const dc = +(rand() * 0.5 - 0.12).toFixed(3)
    const di = +(rand() * 0.4 - 0.08).toFixed(3)
    const dp = +((rand() - 0.55) * 1.4).toFixed(2)
    const topQueries = QUERIES.slice(idx % 5, (idx % 5) + 4).map(([q, qc, qi, qp]) => ({
      query: q,
      clicks: Math.round(qc * 0.35 * scale),
      impressions: Math.round(qi * 0.35 * scale),
      position: qp,
    }))
    return {
      page,
      clicks,
      impressions,
      ctr: +(clicks / impressions).toFixed(4),
      position: pos,
      clicksDelta: dc,
      impressionsDelta: di,
      positionDelta: dp,
      queryCount: 8 + Math.round(rand() * 25),
      topQueries,
    }
  })

  const pairs: SeoPairRow[] = []
  PAGES.forEach(([page], idx) => {
    const qs = QUERIES.slice(idx % 6, (idx % 6) + 6)
    qs.forEach(([q, qc, qi, qp], j) => {
      const w = (0.45 - j * 0.05) * scale
      const clicks = Math.max(1, Math.round(qc * w))
      const impressions = Math.max(10, Math.round(qi * w))
      pairs.push({
        query: q,
        page,
        clicks,
        impressions,
        ctr: +(clicks / impressions).toFixed(4),
        position: qp,
      })
    })
  })

  const devices = [
    { device: 'MOBILE', clicks: Math.round(1820 * scale), impressions: Math.round(41200 * scale), ctr: 0.0442, position: 5.7 },
    { device: 'DESKTOP', clicks: Math.round(1290 * scale), impressions: Math.round(22800 * scale), ctr: 0.0566, position: 5.1 },
    { device: 'TABLET', clicks: Math.round(68 * scale), impressions: Math.round(1650 * scale), ctr: 0.0412, position: 6.0 },
  ]

  const totClicks = daily.reduce((s, d) => s + d.clicks, 0)
  const totImpr = daily.reduce((s, d) => s + d.impressions, 0)
  const avgPos = +(daily.reduce((s, d) => s + d.position, 0) / daily.length).toFixed(2)

  return {
    source: 'mock',
    site: siteUrl,
    range: {
      startDate: daily[0]?.date,
      endDate: daily[daily.length - 1]?.date,
      days,
    },
    totals: {
      clicks: totClicks,
      impressions: totImpr,
      ctr: +(totClicks / totImpr).toFixed(4),
      position: avgPos,
      clicksDelta: 0.142,
      impressionsDelta: 0.198,
      ctrDelta: -0.047,
      positionDelta: -0.4,
    },
    daily,
    queries,
    pages,
    pairs,
    devices,
  }
}

const VERDICTS: Array<[string, string, string]> = [
  ['PASS', '登録済み（サイトマップ送信）', 'Submitted and indexed'],
  ['PASS', '登録済み（サイトマップ未送信）', 'Indexed, not submitted in sitemap'],
  ['NEUTRAL', 'クロール済み - インデックス未登録', 'Crawled - currently not indexed'],
  ['NEUTRAL', '検出 - インデックス未登録', 'Discovered - currently not indexed'],
  ['NEUTRAL', '重複（Google が別カノニカルを選択）', 'Duplicate, Google chose different canonical than user'],
  ['NEUTRAL', 'noindex タグにより除外', 'Excluded by noindex tag'],
  ['NEUTRAL', '代替ページ（適切な canonical タグあり）', 'Alternate page with proper canonical tag'],
  ['FAIL', 'ソフト 404', 'Soft 404'],
  ['FAIL', 'サーバーエラー (5xx)', 'Server error (5xx)'],
  ['FAIL', 'リダイレクト エラー', 'Redirect error'],
]

const SAMPLE_PATHS: Array<[string, number, string | null, number]> = [
  ['/entry/internal-link-optimization', 0, '2026-04-12T08:14:00Z', 14],
  ['/entry/aio-llmo-guide', 0, '2026-04-13T03:41:00Z', 11],
  ['/entry/sitemap-index-troubleshooting', 0, '2026-04-11T19:02:00Z', 9],
  ['/entry/topic-cluster-design', 0, '2026-04-10T11:28:00Z', 8],
  ['/entry/orphan-page-audit', 1, '2026-04-09T22:15:00Z', 0],
  ['/entry/ai-crawler-robots-llms-txt', 0, '2026-04-13T06:50:00Z', 6],
  ['/entry/json-ld-schema-patterns', 2, '2026-04-04T14:10:00Z', 1],
  ['/entry/anchor-text-diversity', 0, '2026-04-12T01:33:00Z', 7],
  ['/column/perplexity-citation-study', 0, '2026-04-13T09:05:00Z', 5],
  ['/column/eeat-checklist-2026', 2, '2026-04-02T17:44:00Z', 1],
  ['/column/thin-content-draft-01', 2, '2026-03-28T05:19:00Z', 0],
  ['/column/thin-content-draft-02', 3, null, 0],
  ['/column/upcoming-webinar-notes', 3, null, 0],
  ['/entry/duplicate-guide-print', 4, '2026-04-06T12:00:00Z', 2],
  ['/tag/seo', 5, '2026-04-08T04:20:00Z', 3],
  ['/tag/aio', 5, '2026-04-08T04:21:00Z', 2],
  ['/entry/internal-link-optimization?utm_source=nl', 6, '2026-04-07T10:11:00Z', 1],
  ['/old/2023-campaign', 7, '2026-04-01T16:30:00Z', 0],
  ['/api-preview/healthcheck', 8, '2026-04-11T02:08:00Z', 1],
  ['/legacy/moved-twice', 9, '2026-04-05T20:55:00Z', 1],
]

export function generateSitemapMock() {
  const host = 'https://link-th.com'
  const pages = SAMPLE_PATHS.map(([path, vi, lastCrawl, refs]) => {
    const [verdict, labelJa, coverageState] = VERDICTS[vi]
    const url = host + path
    return {
      url,
      verdict,
      coverageState,
      labelJa,
      indexingState: vi === 5 ? 'BLOCKED_BY_META_TAG' : 'INDEXING_ALLOWED',
      pageFetchState: vi === 8 ? 'SERVER_ERROR' : vi === 7 ? 'SOFT_404' : 'SUCCESSFUL',
      robotsTxtState: 'ALLOWED',
      crawledAs: 'MOBILE',
      lastCrawlTime: lastCrawl,
      googleCanonical: vi === 4 ? host + '/entry/aio-llmo-guide' : url.split('?')[0],
      userCanonical: url.split('?')[0],
      inSitemap: vi !== 1 && !path.includes('?'),
      referringCount: refs,
    }
  })

  const summary = {
    sitemapUrl: `${host}/sitemap.xml`,
    sitemapSubmitted: 148,
    indexed: 118,
    excluded: 24,
    errors: 6,
    lastFetched: '2026-04-14T02:00:00Z',
  }

  const breakdown = [
    { key: 'Submitted and indexed', label: '登録済み（サイトマップ送信）', verdict: 'PASS', count: 112, action: '正常' },
    { key: 'Indexed, not submitted in sitemap', label: '登録済み（サイトマップ未送信）', verdict: 'PASS', count: 6, action: 'sitemap.xml への追加を検討' },
    { key: 'Crawled - currently not indexed', label: 'クロール済み - インデックス未登録', verdict: 'NEUTRAL', count: 9, action: '内容の独自性・内部リンク発リンク数を強化' },
    { key: 'Discovered - currently not indexed', label: '検出 - インデックス未登録', verdict: 'NEUTRAL', count: 6, action: '孤立ページ解消・クロールバジェット確認' },
    { key: 'Excluded by noindex tag', label: 'noindex タグにより除外', verdict: 'NEUTRAL', count: 5, action: '意図通りか確認（タグ/アーカイブ等）' },
    { key: 'Duplicate, Google chose different canonical than user', label: '重複（別カノニカル選択）', verdict: 'NEUTRAL', count: 2, action: 'canonical 指定と内部リンク先を統一' },
    { key: 'Alternate page with proper canonical tag', label: '代替ページ（canonical 適正）', verdict: 'NEUTRAL', count: 2, action: '対応不要' },
    { key: 'Soft 404', label: 'ソフト 404', verdict: 'FAIL', count: 3, action: '本文拡充 または 404/301 を返す' },
    { key: 'Server error (5xx)', label: 'サーバーエラー (5xx)', verdict: 'FAIL', count: 2, action: 'オリジン応答・タイムアウトを調査' },
    { key: 'Redirect error', label: 'リダイレクト エラー', verdict: 'FAIL', count: 1, action: 'リダイレクトチェーンを1段に短縮' },
  ]

  const dailyCoverage: Array<{
    date: string
    indexed: number
    excluded: number
    errors: number
    rate: number
  }> = []
  const now = new Date('2026-04-14T00:00:00Z')
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    const indexed = 104 + Math.round(((30 - i) / 30) * 14)
    const excluded = 28 - Math.round(((30 - i) / 30) * 4)
    const errors = i < 10 ? 6 : 9
    dailyCoverage.push({
      date: d.toISOString().slice(0, 10),
      indexed,
      excluded,
      errors,
      rate: +(indexed / (indexed + excluded + errors)).toFixed(3),
    })
  }

  return {
    source: 'mock',
    site: 'sc-domain:link-th.com',
    summary,
    breakdown,
    dailyCoverage,
    pages,
  }
}

export function generateInternalLinksMock(jobId = 'demo-job-link-th') {
  return {
    source: 'mock',
    jobId,
    structure: {
      total_pages: 48,
      max_depth: 4,
      orphan_count: 3,
      hub_pages: [
        { url: 'https://link-th.com/', title: 'Link-TH トップページ', inbound_count: 42, outbound_count: 28, depth: 0, page_rank: 0.94 },
        { url: 'https://link-th.com/entry/internal-link-optimization', title: '内部リンク最適化の完全ガイド', inbound_count: 31, outbound_count: 19, depth: 1, page_rank: 0.88 },
        { url: 'https://link-th.com/entry/aio-llmo-guide', title: 'AIO / LLMO 対策の実践設計', inbound_count: 24, outbound_count: 16, depth: 1, page_rank: 0.81 },
        { url: 'https://link-th.com/entry/topic-cluster-design', title: 'トピッククラスター設計手法', inbound_count: 19, outbound_count: 15, depth: 1, page_rank: 0.76 },
        { url: 'https://link-th.com/entry/sitemap-index-troubleshooting', title: 'Search Console インデックス未登録の解決手順', inbound_count: 16, outbound_count: 12, depth: 2, page_rank: 0.69 },
        { url: 'https://link-th.com/entry/ai-crawler-robots-llms-txt', title: 'AIクローラー制御（robots.txt / llms.txt）', inbound_count: 14, outbound_count: 11, depth: 2, page_rank: 0.65 },
        { url: 'https://link-th.com/column/perplexity-citation-study', title: 'Perplexity 引用要因の検証レポート', inbound_count: 9, outbound_count: 8, depth: 2, page_rank: 0.54 },
        { url: 'https://link-th.com/column/eeat-checklist-2026', title: '2026年版 E-E-A-T 強化チェックリスト', inbound_count: 4, outbound_count: 5, depth: 3, page_rank: 0.38 },
      ],
      depth_distribution: {
        '0': 1,
        '1': 12,
        '2': 21,
        '3': 11,
        '4': 3,
      },
      directory_stats: [
        { directory: '/entry', page_count: 26, avg_inbound: 14.8, avg_outbound: 11.2, avg_depth: 1.5 },
        { directory: '/column', page_count: 14, avg_inbound: 6.4, avg_outbound: 5.9, avg_depth: 2.4 },
        { directory: '/tools', page_count: 5, avg_inbound: 8.2, avg_outbound: 4.0, avg_depth: 1.8 },
        { directory: '/', page_count: 3, avg_inbound: 18.0, avg_outbound: 14.3, avg_depth: 0.7 },
      ],
    },
    orphans: [
      {
        source_url: 'https://link-th.com/entry/orphan-page-audit',
        description: '内部被リンクが 0 件です。トピッククラスター親記事（/entry/internal-link-optimization）からの発リンク追加を推奨します。',
      },
      {
        source_url: 'https://link-th.com/column/thin-content-draft-01',
        description: '内部被リンクが 0 件かつ GSC でも「クロール済み - インデックス未登録」となっています。',
      },
      {
        source_url: 'https://link-th.com/old/2023-campaign',
        description: '旧キャンペーンLPがサイトマップのみに残存し、サイト内導線から孤立しています。',
      },
    ],
  }
}
