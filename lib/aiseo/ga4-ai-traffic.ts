/**
 * AISEO: GA4 / ClickHouse Events AI Search Inflow Analytics +
 * SERP AI Overview (AIO) Citation Diff + 16-Item Semantic AI Audit Integration.
 *
 * Classifies human sessions & conversions originating from AI search / generative AI platforms:
 *   - ChatGPT (`chatgpt.com`, `chat.openai.com`)
 *   - Perplexity (`perplexity.ai`)
 *   - Gemini (`gemini.google.com`, `bard.google.com`)
 *   - Claude (`claude.ai`)
 *   - Microsoft Copilot (`copilot.microsoft.com`, `bing.com/chat`, `edgeservices.bing.com`)
 *   - Google AI Overview / SGE (`utm_source=google_aio`, `utm_source=sge`, `utm_medium=ai_overview`, etc.)
 */

import type { ClickHouseClient } from '@clickhouse/client'
import {
  buildConfidenceMeta,
  getAioCitationDiff,
  getSiteDocAudit,
} from '@/lib/linkscrawl/client'
import type {
  AioCitationDiffItem,
  CollectionStatus,
  DataSourceMode,
  LinkscrawlConfidenceMeta,
  SemanticCascadeAudit,
} from '@/lib/linkscrawl/types'
import type { ConfidenceSignal } from '@/lib/aiseo/confidence'
import { normalizeUrlFull } from '@/lib/url/normalize-url'

export type AiTrafficSourceKey =
  | 'ChatGPT'
  | 'Perplexity'
  | 'Gemini'
  | 'Claude'
  | 'Microsoft Copilot'
  | 'Google AI Overview / SGE'

export type TrafficChannelCategory =
  | 'ai_referral'
  | 'organic_search'
  | 'direct_or_other'

export interface RawTrafficEventRow {
  sessionId?: string
  url?: string
  referrer?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  sessions?: number
  conversions?: number
  bounceCount?: number
  totalDwellMs?: number
}

export interface ClassifiedTrafficSource {
  channel: TrafficChannelCategory
  aiSource: AiTrafficSourceKey | null
  matchedRule: string
}

export interface AiSourceMetricRow {
  source: AiTrafficSourceKey
  sessions: number
  sharePct: number // 0..100 among total AI sessions
  conversions: number
  cvr: number // 0..1
  cvrVsOrganicMultiplier: number
  bounceRate: number // 0..1
  avgDwellSec: number
  sampleReferrers: string[]
}

export interface AiLandingUrlRankingRow {
  url: string
  pathname: string
  aiSessions: number
  aiConversions: number
  aiCvr: number // 0..1
  topAiSource: AiTrafficSourceKey
  sourceBreakdown: Partial<Record<AiTrafficSourceKey, number>>
  semanticScore: number | null // null when unmeasured (not_collected)
  aioCitedCount: number | null // null when unmeasured (not_collected)
}

export interface Ga4AiTrafficReport {
  totalAiSessions: number
  totalAiConversions: number
  aiCvr: number // 0..1
  organicSearchSessions: number
  organicSearchConversions: number
  organicSearchCvr: number // 0..1
  aiShareOfSearchPct: number // AI sessions / (AI + Organic) * 100
  aiVsOrganicCvrMultiplier: number
  bySource: AiSourceMetricRow[]
  topLandingUrls: AiLandingUrlRankingRow[]
}

export interface AiseoOverviewResponse {
  status: CollectionStatus
  reason?: string
  source: DataSourceMode
  siteId: string
  targetUrl: string
  canonicalUrl: string
  days: number
  generatedAt: string
  aiTraffic: Ga4AiTrafficReport
  aioCitationDiff: {
    status: CollectionStatus
    reason?: string
    source: DataSourceMode
    totalTrackedQueries: number
    aioAppearanceRate: number
    selfCitationRate: number
    competitorGapCount: number
    diffs: AioCitationDiffItem[]
  }
  semanticAudit: SemanticCascadeAudit
  confidence: LinkscrawlConfidenceMeta
}

export const AI_TRAFFIC_SOURCES_ORDER: AiTrafficSourceKey[] = [
  'ChatGPT',
  'Perplexity',
  'Gemini',
  'Claude',
  'Microsoft Copilot',
  'Google AI Overview / SGE',
]

function extractQueryParamsLower(rawUrlOrRef: string): Record<string, string> {
  const out: Record<string, string> = {}
  const qIdx = rawUrlOrRef.indexOf('?')
  if (qIdx < 0) return out
  const qStr = rawUrlOrRef.slice(qIdx + 1).split('#')[0]
  try {
    const sp = new URLSearchParams(qStr)
    sp.forEach((v, k) => {
      out[k.toLowerCase()] = v.toLowerCase()
    })
  } catch {
    // ignore malformed query
  }
  return out
}

/**
 * Pure classification function: inspects `referrer`, `utm_source`, `utm_medium`, and `url` query parameters
 * to determine if a session came from an AI Search / Generative AI platform or traditional organic search.
 */
export function classifyAiTrafficSource(input: {
  referrer?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  url?: string | null
}): ClassifiedTrafficSource {
  const ref = (input.referrer || '').trim().toLowerCase()
  const urlParams = input.url ? extractQueryParamsLower(input.url) : {}
  const refParams = ref ? extractQueryParamsLower(ref) : {}

  const utmSource = (
    input.utmSource ||
    urlParams['utm_source'] ||
    refParams['utm_source'] ||
    ''
  )
    .trim()
    .toLowerCase()
  const utmMedium = (
    input.utmMedium ||
    urlParams['utm_medium'] ||
    refParams['utm_medium'] ||
    ''
  )
    .trim()
    .toLowerCase()

  // 1. Google AI Overview / SGE explicit signals (utm_source / utm_medium / text fragment marker)
  if (
    utmSource === 'google_aio' ||
    utmSource === 'google-aio' ||
    utmSource === 'sge' ||
    utmSource === 'google_sge' ||
    utmSource === 'ai_overview' ||
    utmMedium === 'ai_overview' ||
    utmMedium === 'google_aio' ||
    utmMedium === 'sge'
  ) {
    return {
      channel: 'ai_referral',
      aiSource: 'Google AI Overview / SGE',
      matchedRule: `utm:${utmSource || utmMedium}`,
    }
  }

  // 2. ChatGPT (`chatgpt.com`, `chat.openai.com`, `utm_source=chatgpt.com` / `openai`)
  if (
    ref.includes('chatgpt.com') ||
    ref.includes('chat.openai.com') ||
    utmSource.includes('chatgpt') ||
    utmSource === 'openai' ||
    utmSource === 'chat.openai.com'
  ) {
    return {
      channel: 'ai_referral',
      aiSource: 'ChatGPT',
      matchedRule: ref.includes('chat') ? 'referrer:chatgpt' : `utm:${utmSource}`,
    }
  }

  // 3. Perplexity (`perplexity.ai`, `utm_source=perplexity`)
  if (ref.includes('perplexity.ai') || utmSource.includes('perplexity')) {
    return {
      channel: 'ai_referral',
      aiSource: 'Perplexity',
      matchedRule: ref.includes('perplexity.ai')
        ? 'referrer:perplexity.ai'
        : `utm:${utmSource}`,
    }
  }

  // 4. Gemini (`gemini.google.com`, `bard.google.com`, `utm_source=gemini` / `bard`)
  if (
    ref.includes('gemini.google.com') ||
    ref.includes('bard.google.com') ||
    utmSource === 'gemini' ||
    utmSource === 'gemini.google.com' ||
    utmSource === 'bard'
  ) {
    return {
      channel: 'ai_referral',
      aiSource: 'Gemini',
      matchedRule: ref.includes('google.com') ? 'referrer:gemini.google.com' : `utm:${utmSource}`,
    }
  }

  // 5. Claude (`claude.ai`, `utm_source=claude` / `anthropic`)
  if (
    ref.includes('claude.ai') ||
    utmSource === 'claude' ||
    utmSource === 'claude.ai' ||
    utmSource === 'anthropic'
  ) {
    return {
      channel: 'ai_referral',
      aiSource: 'Claude',
      matchedRule: ref.includes('claude.ai') ? 'referrer:claude.ai' : `utm:${utmSource}`,
    }
  }

  // 6. Microsoft Copilot (`copilot.microsoft.com`, `bing.com/chat`, `edgeservices.bing.com`)
  if (
    ref.includes('copilot.microsoft.com') ||
    ref.includes('bing.com/chat') ||
    ref.includes('edgeservices.bing.com') ||
    utmSource === 'copilot' ||
    utmSource === 'copilot.microsoft.com' ||
    utmSource === 'bing_chat'
  ) {
    return {
      channel: 'ai_referral',
      aiSource: 'Microsoft Copilot',
      matchedRule: ref.includes('copilot') || ref.includes('bing.com')
        ? 'referrer:copilot'
        : `utm:${utmSource}`,
    }
  }

  // 7. Standard Organic Search
  const isOrganicMedium =
    utmMedium === 'organic' || (!utmMedium && !utmSource.includes('cpc'))
  if (
    isOrganicMedium &&
    (ref.includes('google.') ||
      ref.includes('bing.com') ||
      ref.includes('yahoo.co.jp') ||
      ref.includes('search.yahoo.') ||
      ref.includes('duckduckgo.com') ||
      utmSource === 'google' ||
      utmSource === 'bing' ||
      utmSource === 'yahoo')
  ) {
    return {
      channel: 'organic_search',
      aiSource: null,
      matchedRule: 'organic_search',
    }
  }

  return {
    channel: 'direct_or_other',
    aiSource: null,
    matchedRule: 'other',
  }
}

/**
 * Pure aggregation function: takes raw session/event rows and computes AI source breakdown,
 * CVR comparison vs organic search, and top AI landing URL rankings.
 */
export function aggregateAiTrafficRows(
  rows: ReadonlyArray<RawTrafficEventRow>,
  options: {
    fallbackOrganicSessions?: number
    fallbackOrganicConversions?: number
  } = {},
): Ga4AiTrafficReport {
  const sourceStats = new Map<
    AiTrafficSourceKey,
    {
      sessions: number
      conversions: number
      bounces: number
      dwellMs: number
      referrers: Set<string>
    }
  >()

  for (const key of AI_TRAFFIC_SOURCES_ORDER) {
    sourceStats.set(key, {
      sessions: 0,
      conversions: 0,
      bounces: 0,
      dwellMs: 0,
      referrers: new Set<string>(),
    })
  }

  const urlMap = new Map<
    string,
    {
      url: string
      pathname: string
      sessions: number
      conversions: number
      bySource: Partial<Record<AiTrafficSourceKey, number>>
    }
  >()

  let organicSessions = 0
  let organicConversions = 0

  for (const row of rows) {
    const sessions = Math.max(0, Number(row.sessions ?? 1))
    const conversions = Math.max(0, Number(row.conversions ?? 0))
    const bounces = Math.max(0, Number(row.bounceCount ?? 0))
    const dwellMs = Math.max(0, Number(row.totalDwellMs ?? 0))

    const classified = classifyAiTrafficSource({
      referrer: row.referrer,
      utmSource: row.utmSource,
      utmMedium: row.utmMedium,
      url: row.url,
    })

    if (classified.channel === 'organic_search') {
      organicSessions += sessions
      organicConversions += conversions
      continue
    }

    if (classified.channel === 'ai_referral' && classified.aiSource) {
      const st = sourceStats.get(classified.aiSource)!
      st.sessions += sessions
      st.conversions += conversions
      st.bounces += Math.min(sessions, bounces)
      st.dwellMs += dwellMs
      if (row.referrer && st.referrers.size < 3) {
        st.referrers.add(row.referrer)
      }

      if (row.url) {
        let canonical = row.url
        let pathname = '/'
        try {
          const norm = normalizeUrlFull(
            row.url.startsWith('/') ? `https://link-th.com${row.url}` : row.url,
          )
          canonical = norm.normalizedUrl
          pathname = norm.pathname
        } catch {
          pathname = row.url
        }

        const existing = urlMap.get(canonical) ?? {
          url: canonical,
          pathname,
          sessions: 0,
          conversions: 0,
          bySource: {},
        }
        existing.sessions += sessions
        existing.conversions += conversions
        existing.bySource[classified.aiSource] =
          (existing.bySource[classified.aiSource] ?? 0) + sessions
        urlMap.set(canonical, existing)
      }
    }
  }

  if (organicSessions === 0 && options.fallbackOrganicSessions) {
    organicSessions = options.fallbackOrganicSessions
    organicConversions = options.fallbackOrganicConversions ?? 0
  }

  const organicSearchCvr =
    organicSessions > 0
      ? Number((organicConversions / organicSessions).toFixed(4))
      : 0

  let totalAiSessions = 0
  let totalAiConversions = 0
  sourceStats.forEach((v) => {
    totalAiSessions += v.sessions
    totalAiConversions += v.conversions
  })

  const aiCvr =
    totalAiSessions > 0
      ? Number((totalAiConversions / totalAiSessions).toFixed(4))
      : 0

  const aiVsOrganicCvrMultiplier =
    organicSearchCvr > 0 && aiCvr > 0
      ? Number((aiCvr / organicSearchCvr).toFixed(2))
      : 0

  const bySource: AiSourceMetricRow[] = AI_TRAFFIC_SOURCES_ORDER.map((source) => {
    const st = sourceStats.get(source)!
    const sharePct =
      totalAiSessions > 0
        ? Number(((st.sessions / totalAiSessions) * 100).toFixed(1))
        : 0
    const cvr =
      st.sessions > 0 ? Number((st.conversions / st.sessions).toFixed(4)) : 0
    const cvrVsOrganicMultiplier =
      organicSearchCvr > 0 && cvr > 0
        ? Number((cvr / organicSearchCvr).toFixed(2))
        : 0
    const bounceRate =
      st.sessions > 0
        ? Number((st.bounces / st.sessions).toFixed(3))
        : 0
    const avgDwellSec =
      st.sessions > 0 ? Math.round(st.dwellMs / st.sessions / 1000) : 0

    return {
      source,
      sessions: st.sessions,
      sharePct,
      conversions: st.conversions,
      cvr,
      cvrVsOrganicMultiplier,
      bounceRate,
      avgDwellSec,
      sampleReferrers: Array.from(st.referrers),
    }
  }).sort((a, b) => b.sessions - a.sessions)

  const topLandingUrls: AiLandingUrlRankingRow[] = Array.from(urlMap.values())
    .sort((a, b) => b.sessions - a.sessions)
    .map((u) => {
      let topAiSource: AiTrafficSourceKey = 'ChatGPT'
      let maxCount = -1
      for (const s of AI_TRAFFIC_SOURCES_ORDER) {
        const c = u.bySource[s] ?? 0
        if (c > maxCount) {
          maxCount = c
          topAiSource = s
        }
      }
      const aiUrlCvr =
        u.sessions > 0 ? Number((u.conversions / u.sessions).toFixed(4)) : 0
      return {
        url: u.url,
        pathname: u.pathname,
        aiSessions: u.sessions,
        aiConversions: u.conversions,
        aiCvr: aiUrlCvr,
        topAiSource,
        sourceBreakdown: u.bySource,
        semanticScore: null,
        aioCitedCount: null,
      }
    })

  const totalSearchPool = totalAiSessions + organicSessions
  const aiShareOfSearchPct =
    totalSearchPool > 0
      ? Number(((totalAiSessions / totalSearchPool) * 100).toFixed(2))
      : 0

  return {
    totalAiSessions,
    totalAiConversions,
    aiCvr,
    organicSearchSessions: organicSessions,
    organicSearchConversions: organicConversions,
    organicSearchCvr,
    aiShareOfSearchPct,
    aiVsOrganicCvrMultiplier,
    bySource,
    topLandingUrls,
  }
}

/**
 * Queries ClickHouse `clickinsight.events` for AI referrer / UTM traffic over the given period.
 * Wave 0 (束 0-A 止血):
 *   - 必ず `tenant_id = {tenant_id:String}` をバインドする（未指定時は fail-closed でクエリ非実行）。
 *   - ClickHouse 未接続・エラー・0件時に合成行を返さず `status: 'not_collected'` + 空集計を返す。
 */
export async function queryClickHouseAiTraffic(params: {
  clickhouse?: ClickHouseClient | null
  tenantId?: string
  siteId: string
  host?: string | null
  days?: number
}): Promise<{
  status: CollectionStatus
  reason?: string
  source: DataSourceMode
  report: Ga4AiTrafficReport
}> {
  const days = Math.min(90, Math.max(7, Number(params.days || 30)))
  const emptyReport = aggregateAiTrafficRows([])

  if (!params.clickhouse) {
    return {
      status: 'not_collected',
      reason: 'ClickHouse 未接続のためAI検索流入データは未収集です (not_collected)',
      source: 'not_collected',
      report: emptyReport,
    }
  }

  const tenantId = (params.tenantId || '').trim()
  if (!tenantId) {
    return {
      status: 'not_collected',
      reason: 'tenant_id が未指定のためクエリを実行できません (fail-closed)',
      source: 'not_collected',
      report: emptyReport,
    }
  }

  try {
    const res = await params.clickhouse.query({
      query: `
        SELECT
          url,
          referrer,
          countDistinct(session_id) AS sessions,
          countIf(event_type = 'conversion' OR conversion_type != '') AS conversions
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND timestamp >= now() - INTERVAL {days:UInt32} DAY
        GROUP BY url, referrer
        ORDER BY sessions DESC
        LIMIT 500
      `,
      query_params: {
        tenant_id: tenantId,
        site_id: params.siteId,
        days,
      },
      format: 'JSONEachRow',
    })
    const dbRows = await res.json<{
      url: string
      referrer: string
      sessions: number
      conversions: number
    }>()

    if (Array.isArray(dbRows) && dbRows.length > 0) {
      const mapped: RawTrafficEventRow[] = dbRows.map((r) => ({
        url: r.url,
        referrer: r.referrer,
        sessions: Number(r.sessions) || 0,
        conversions: Number(r.conversions) || 0,
      }))
      const report = aggregateAiTrafficRows(mapped)
      if (report.totalAiSessions > 0) {
        return { status: 'ok', source: 'live', report }
      }
      return {
        status: 'not_collected',
        reason: '対象期間にAI検索リファラー流入イベントが観測されていません (not_collected)',
        source: 'not_collected',
        report,
      }
    }

    return {
      status: 'not_collected',
      reason: '対象期間のイベントデータが0件です (not_collected)',
      source: 'not_collected',
      report: emptyReport,
    }
  } catch {
    return {
      status: 'not_collected',
      reason: 'ClickHouse クエリ取得失敗のためAI検索流入データは未収集です (not_collected)',
      source: 'not_collected',
      report: emptyReport,
    }
  }
}

/**
 * Full AISEO Overview aggregator combining:
 *   1. ClickHouse AI Search Inflow Analytics (6 AI engines + CVR vs Organic)
 *   2. SERP AI Overview (`aio_citation_diff`) competitor citation gap
 *   3. 16-Item x 7-Pillar Semantic AI Audit (`semanticAudit`)
 */
export async function getAiseoOverview(params: {
  tenantId?: string
  siteId: string
  url?: string
  host?: string | null
  days?: number
  clickhouse?: ClickHouseClient | null
}): Promise<AiseoOverviewResponse> {
  const days = Math.min(90, Math.max(7, Number(params.days || 30)))
  const rawUrl =
    params.url || `https://${params.host || 'link-th.com'}/entry/internal-link-optimization`
  let canonicalUrl = rawUrl
  try {
    canonicalUrl = normalizeUrlFull(rawUrl).normalizedUrl
  } catch {
    canonicalUrl = 'https://link-th.com/entry/internal-link-optimization'
  }

  const [trafficResult, aioDiff, siteDoc] = await Promise.all([
    queryClickHouseAiTraffic({
      clickhouse: params.clickhouse,
      tenantId: params.tenantId,
      siteId: params.siteId,
      host: params.host,
      days,
    }),
    getAioCitationDiff({ siteId: params.siteId, url: canonicalUrl }),
    getSiteDocAudit({ siteId: params.siteId, url: canonicalUrl }),
  ])

  const overallSource: DataSourceMode =
    trafficResult.source === 'live' ||
    aioDiff.source === 'live' ||
    siteDoc.source === 'live'
      ? 'live'
      : 'not_collected'

  const status: CollectionStatus = overallSource === 'live' ? 'ok' : 'not_collected'
  const reasons = [
    trafficResult.source !== 'live' ? trafficResult.reason : undefined,
    aioDiff.source !== 'live' ? aioDiff.reason : undefined,
    siteDoc.source !== 'live' ? siteDoc.reason : undefined,
  ].filter((r): r is string => Boolean(r))

  const signals: ConfidenceSignal[] = []
  if (trafficResult.source === 'live') {
    signals.push({
      kind: 'identity',
      label: `AI検索6大エンジン流入分類 (計${trafficResult.report.totalAiSessions}セッション, オーガニック比CVR ${trafficResult.report.aiVsOrganicCvrMultiplier}倍)`,
    })
  }
  if (siteDoc.source === 'live') {
    signals.push({
      kind: 'structure_dom',
      label: `16項目×7要素 AI意味監査スコア ${siteDoc.semanticAudit.overallSemanticScore}点`,
    })
  }
  if (aioDiff.source === 'live') {
    signals.push({
      kind: 'behavior_target',
      label: `SERP AI Overview 引用競合差分 (${aioDiff.totalTrackedQueries}クエリ中 未引用ギャップ ${aioDiff.competitorGapCount}件)`,
    })
  }

  const confidence = buildConfidenceMeta(signals)

  return {
    status,
    reason: status === 'not_collected' ? (reasons[0] || 'AISEO 実測データが未収集です (not_collected)') : undefined,
    source: overallSource,
    siteId: params.siteId,
    targetUrl: rawUrl,
    canonicalUrl,
    days,
    generatedAt: new Date().toISOString(),
    aiTraffic: trafficResult.report,
    aioCitationDiff: aioDiff,
    semanticAudit: siteDoc.semanticAudit,
    confidence,
  }
}
