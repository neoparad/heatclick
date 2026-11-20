/**
 * AI Crawler Page Acquisition Inspector (`lib/aiseo/crawler-acquisition.ts`)
 *
 * 「どのページで何を取得でき、何を取りこぼしたか」を構造化・定量化するエンジン。
 *
 * Wave 0 (束 0-A 止血):
 *   - ClickHouse `clickinsight.ai_crawler_logs` クエリに `tenant_id = {tenant_id:String}` を必須適用
 *     （`tenantId` 未指定または `'default'` の場合は fail-closed でクエリ非実行）。
 *   - 実測データ（ClickHouse ログ / LINKTH CRAWL live 応答）が無い場合に
 *     推定 GPTBot ヒット数や仮想 SSR スコア・仮想 CSR セクションを合成せず、
 *     `status: 'not_collected'` と明確な理由・空データを返す。
 */

import type { ClickHouseClient } from '@clickhouse/client'
import { getClickHouseClient } from '@/lib/clickhouse'
import { getSiteDocAudit } from '@/lib/linkscrawl/client'
import type { CollectionStatus } from '@/lib/linkscrawl/types'
import { normalizeUrlFull } from '@/lib/url/normalize-url'

export type CrawlerBotFamily = 'openai' | 'anthropic' | 'perplexity' | 'google' | 'other'

export type CrawlerExtractionStatus = 'full_ssr' | 'partial_csr_loss' | 'blocked_or_error'

export interface CrawlerAccessSummaryItem {
  botName: string
  family: CrawlerBotFamily
  hits: number
  lastSeenAt: string
  statusCode: number
  bytesFetchedEstimate: number
  extractionStatus: CrawlerExtractionStatus
}

export interface AcquiredJsonLdSchema {
  type: string
  fieldsExtracted: string[]
  completenessScore: number
  rawPreview: Record<string, unknown>
}

export interface AcquiredHeadingChunk {
  level: 'H1' | 'H2' | 'H3'
  text: string
  charCount: number
  yRangePx: [number, number]
  readableByHttpCrawler: boolean
  semanticRole: string
}

export type MissedSectionReason =
  | 'client_side_rendered'
  | 'lazy_loaded_without_noscript'
  | 'div_table_unstructured'
  | 'image_missing_alt'
  | 'nosnippet_or_robots'

export interface MissedCsrSectionItem {
  sectionName: string
  selector: string
  yRangePx: [number, number]
  reason: MissedSectionReason
  impactLevel: 'high' | 'medium' | 'low'
  missedInformationSummary: string
  remediationPatch: string
}

export interface CrawlerPageAcquisitionReport {
  status: CollectionStatus
  reason?: string
  url: string
  siteId: string
  ssrVisibilityScore: number
  crawlerAccessSummary: CrawlerAccessSummaryItem[]
  acquiredContent: {
    title: string
    metaDescription: string | null
    canonicalUrl: string | null
    jsonLdSchemas: AcquiredJsonLdSchema[]
    headingChunks: AcquiredHeadingChunk[]
    extractedInternalLinksCount: number
  }
  missedContent: {
    csrHiddenSections: MissedCsrSectionItem[]
  }
  semanticAuditSummary: {
    pageType: string
    overallScore: number
    citationReadinessScore: number
    topBlockers: string[]
  }
  confidence: 'high' | 'medium' | 'low' | 'insufficient'
  dataSource: 'linkscrawl_live' | 'clickhouse_live' | 'not_collected'
}

export interface AnalyzeCrawlerAcquisitionParams {
  tenantId?: string
  siteId: string
  url: string
  clickhouse?: ClickHouseClient | null
}

const DEFAULT_FALLBACK_URL = 'https://bihadashop.jp/'

/**
 * Normalizes any raw URL or path for cross-table joining (`linkscrawl` x `AIreceipt` x `ClickHouse`).
 */
export function normalizeUrlForJoin(rawUrl?: string | null): {
  normalizedUrl: string
  matchKey: string
  pathname: string
  host: string
} {
  const candidate = (rawUrl || DEFAULT_FALLBACK_URL).trim() || DEFAULT_FALLBACK_URL
  try {
    const full = candidate.startsWith('/')
      ? `https://bihadashop.jp${candidate}`
      : candidate
    const res = normalizeUrlFull(full)
    return {
      normalizedUrl: res.normalizedUrl,
      matchKey: res.matchKey,
      pathname: res.pathname,
      host: res.host,
    }
  } catch {
    const fallback = normalizeUrlFull(DEFAULT_FALLBACK_URL)
    return {
      normalizedUrl: fallback.normalizedUrl,
      matchKey: fallback.matchKey,
      pathname: fallback.pathname,
      host: fallback.host,
    }
  }
}

export function classifyBotFamily(botName: string): CrawlerBotFamily {
  const lower = (botName || '').toLowerCase()
  if (lower.includes('gpt') || lower.includes('oai') || lower.includes('chatgpt') || lower.includes('openai')) {
    return 'openai'
  }
  if (lower.includes('claude') || lower.includes('anthropic')) {
    return 'anthropic'
  }
  if (lower.includes('perplexity')) {
    return 'perplexity'
  }
  if (lower.includes('google') || lower.includes('gemini')) {
    return 'google'
  }
  return 'other'
}

interface ClickHouseBotLogRow {
  bot_name: string
  hits: number
  last_seen: string
  status_code: number
  bytes_avg: number
}

async function tryFetchClickHouseCrawlerLogs(
  tenantId: string | undefined,
  siteId: string,
  normalizedUrl: string,
  pathname: string,
  injectedClient?: ClickHouseClient | null,
): Promise<ClickHouseBotLogRow[]> {
  // Fail-closed: tenant_id なしでの ClickHouse クエリ実行を禁止
  const cleanTenantId = (tenantId || '').trim()
  if (!cleanTenantId || cleanTenantId === 'default') {
    return []
  }

  let ch: ClickHouseClient
  if (injectedClient !== undefined) {
    if (!injectedClient) return []
    ch = injectedClient
  } else {
    if (!process.env.CLICKHOUSE_URL || !process.env.CLICKHOUSE_PASSWORD) {
      return []
    }
    if (process.env.NODE_ENV === 'test' && process.env.CLICKHOUSE_LIVE_TEST !== '1') {
      return []
    }
    ch = getClickHouseClient('analytics_reader')
  }

  try {
    const rs = await ch.query({
      query: `
        SELECT
          bot_name,
          count() AS hits,
          toString(max(timestamp)) AS last_seen,
          anyLast(status_code) AS status_code,
          round(avg(response_bytes)) AS bytes_avg
        FROM clickinsight.ai_crawler_logs
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND (url = {url:String} OR path = {path:String})
        GROUP BY bot_name
        ORDER BY hits DESC
        LIMIT 10
      `,
      query_params: {
        tenant_id: cleanTenantId,
        site_id: siteId,
        url: normalizedUrl,
        path: pathname,
      },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as ClickHouseBotLogRow[]
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export async function analyzeCrawlerPageAcquisition(
  params: AnalyzeCrawlerAcquisitionParams,
): Promise<CrawlerPageAcquisitionReport> {
  const siteId = (params.siteId || '').trim()
  const norm = normalizeUrlForJoin(params.url)

  const [siteDoc, chLogs] = await Promise.all([
    siteId
      ? getSiteDocAudit({ siteId, url: norm.normalizedUrl }).catch(() => null)
      : Promise.resolve(null),
    siteId
      ? tryFetchClickHouseCrawlerLogs(
          params.tenantId,
          siteId,
          norm.normalizedUrl,
          norm.pathname,
          params.clickhouse,
        )
      : Promise.resolve([]),
  ])

  const isLiveLinkscrawl = siteDoc?.source === 'live'
  const hasChLogs = chLogs.length > 0

  if (!isLiveLinkscrawl && !hasChLogs) {
    return {
      status: 'not_collected',
      reason:
        'ClickHouse ai_crawler_logs および LINKTH CRAWL 監査の実測データが未収集です (not_collected)',
      url: norm.normalizedUrl,
      siteId,
      ssrVisibilityScore: 0,
      crawlerAccessSummary: [],
      acquiredContent: {
        title: '',
        metaDescription: null,
        canonicalUrl: norm.normalizedUrl,
        jsonLdSchemas: [],
        headingChunks: [],
        extractedInternalLinksCount: 0,
      },
      missedContent: {
        csrHiddenSections: [],
      },
      semanticAuditSummary: {
        pageType: 'unknown',
        overallScore: 0,
        citationReadinessScore: 0,
        topBlockers: [],
      },
      confidence: 'insufficient',
      dataSource: 'not_collected',
    }
  }

  const aiReadinessPillar = isLiveLinkscrawl
    ? (siteDoc?.semanticAudit?.pillars?.find((p) => p.key === '06_ai_readiness')?.score ?? 0)
    : 0
  const overallSemanticScore = isLiveLinkscrawl
    ? (siteDoc?.semanticAudit?.overallSemanticScore ?? 0)
    : 0
  const ssrVisibilityScore = isLiveLinkscrawl ? aiReadinessPillar : 0

  const crawlerAccessSummary: CrawlerAccessSummaryItem[] = chLogs.map((r) => {
    const status = Number(r.status_code) || 0
    return {
      botName: r.bot_name,
      family: classifyBotFamily(r.bot_name),
      hits: Number(r.hits) || 0,
      lastSeenAt: r.last_seen || '',
      statusCode: status,
      bytesFetchedEstimate: Number(r.bytes_avg) || 0,
      extractionStatus:
        status >= 400
          ? 'blocked_or_error'
          : isLiveLinkscrawl && ssrVisibilityScore >= 85
            ? 'full_ssr'
            : 'partial_csr_loss',
    }
  })

  return {
    status: 'ok',
    url: norm.normalizedUrl,
    siteId,
    ssrVisibilityScore,
    crawlerAccessSummary,
    acquiredContent: {
      title: '',
      metaDescription: null,
      canonicalUrl: siteDoc?.canonicalUrl || norm.normalizedUrl,
      jsonLdSchemas: [],
      headingChunks: [],
      extractedInternalLinksCount: 0,
    },
    missedContent: {
      csrHiddenSections: [],
    },
    semanticAuditSummary: {
      pageType: isLiveLinkscrawl ? (siteDoc?.semanticAudit?.detectedPageType || 'unknown') : 'unknown',
      overallScore: overallSemanticScore,
      citationReadinessScore: aiReadinessPillar,
      topBlockers: isLiveLinkscrawl
        ? (siteDoc?.topIssues || []).slice(0, 5).map((i) => i.title)
        : [],
    },
    confidence: isLiveLinkscrawl && hasChLogs ? 'high' : 'medium',
    dataSource: isLiveLinkscrawl ? 'linkscrawl_live' : 'clickhouse_live',
  }
}
