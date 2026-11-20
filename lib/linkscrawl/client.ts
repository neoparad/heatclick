/**
 * LINKTH CRAWL v1 BFF Client (`lib/linkscrawl/client.ts`)
 *
 * - Connects to LINKTH CRAWL v1 REST API using `LINKSCRAWL_API_URL` and `LINKSCRAWL_API_KEY`.
 * - Wave 0 (束 0-A 止血): 本番経路で作り物・見本データ (`fallback_synthesized`) を一切返さない。
 *   LINKTH CRAWL API が未設定・接続不可・非2xx応答の場合は `status: 'not_collected'` /
 *   `source: 'not_collected'` と明確な理由・空データで返す。
 */

import {
  confidenceReason,
  scoreConfidence,
  type ConfidenceSignal,
} from '@/lib/aiseo/confidence'
import { normalizeUrlFull } from '@/lib/url/normalize-url'
import type {
  AioCitationDiffItem,
  CollectionStatus,
  DataSourceMode,
  FusionAnswerEngineResponse,
  LinkscrawlConfidenceMeta,
  PerformanceFusionResponse,
  SemanticPageType,
  SiteDocAuditResponse,
  UrlFusionMlResponse,
} from './types'

export interface LinkscrawlClientConfig {
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
}

export interface BehaviorOverrideStats {
  sessions?: number
  pageviews?: number
  conversions?: number
  deadClicks?: number
  rageClicks?: number
  avgScrollDepthPct?: number
  bounceRate?: number
  preRenderExitRate?: number
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'
const DEFAULT_TARGET_URL = 'https://link-th.com/entry/internal-link-optimization'
const NOT_COLLECTED_REASON =
  'LINKTH CRAWL API 未接続または対象URLの監査データが未収集です (not_collected)'

export function getLinkscrawlConfig(opts: LinkscrawlClientConfig = {}) {
  const baseUrl = (
    opts.baseUrl ??
    process.env.LINKSCRAWL_API_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, '')
  const apiKey = opts.apiKey ?? process.env.LINKSCRAWL_API_KEY ?? ''
  const timeoutMs = opts.timeoutMs ?? 2500
  return { baseUrl, apiKey, timeoutMs }
}

export function buildConfidenceMeta(signals: ConfidenceSignal[]): LinkscrawlConfidenceMeta {
  return {
    level: scoreConfidence(signals),
    reason: confidenceReason(null, signals),
    signals,
  }
}

function safeNormalize(rawUrl?: string) {
  const candidate = (rawUrl || DEFAULT_TARGET_URL).trim() || DEFAULT_TARGET_URL
  try {
    return normalizeUrlFull(
      candidate.startsWith('/') ? `https://link-th.com${candidate}` : candidate,
    )
  } catch {
    return normalizeUrlFull(DEFAULT_TARGET_URL)
  }
}

function detectPageTypeFromPath(pathname: string): {
  type: SemanticPageType
  label: string
} {
  const p = pathname.toLowerCase()
  if (p === '/' || p === '') return { type: 'top', label: 'トップページ (Top)' }
  if (p.includes('/contact') || p.includes('/inquiry'))
    return { type: 'contact', label: 'お問い合わせ・CVフォーム (Contact)' }
  if (p.includes('/faq') || p.includes('/help'))
    return { type: 'faq', label: 'よくある質問 (FAQ)' }
  if (p.includes('/company') || p.includes('/about'))
    return { type: 'company', label: '企業・運営者情報 (Company / E-E-A-T)' }
  if (p.includes('/terms') || p.includes('/privacy') || p.includes('/legal'))
    return { type: 'legal', label: '規約・法務表記 (Legal)' }
  if (p.includes('/lp') || p.includes('/service') || p.includes('/solution'))
    return { type: 'lp_service', label: 'サービス紹介・LP (Service LP)' }
  if (p.includes('/category') || p.includes('/list') || p.includes('/tag'))
    return { type: 'listing', label: '一覧・カテゴリ (Listing)' }
  return { type: 'article', label: '記事・ナレッジコンテンツ (Article)' }
}

async function tryLinkscrawlFetch<T>(
  pathname: string,
  init: {
    method?: 'GET' | 'POST'
    query?: Record<string, string | number | undefined>
    body?: unknown
    config?: LinkscrawlClientConfig
  } = {},
): Promise<T | null> {
  if (process.env.LINKSCRAWL_FORCE_FALLBACK === '1') {
    return null
  }
  const cfg = getLinkscrawlConfig(init.config)
  const hasExplicitEnv = Boolean(
    init.config?.baseUrl ||
      process.env.LINKSCRAWL_API_URL ||
      process.env.LINKSCRAWL_API_KEY,
  )
  // 未設定時はローカル未起動ポートへの無駄な接続待ちを回避して即 not_collected とする
  if (!hasExplicitEnv) {
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(init.query || {})) {
      if (v !== undefined && v !== null && String(v) !== '') {
        qs.set(k, String(v))
      }
    }
    const url = `${cfg.baseUrl}${pathname}${qs.toString() ? `?${qs.toString()}` : ''}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`
      headers['X-Linkscrawl-Api-Key'] = cfg.apiKey
    }
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as T
    return data
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// 1. getSiteDocAudit
// ============================================================================

export async function getSiteDocAudit(params: {
  siteId: string
  url?: string
  behaviorOverride?: BehaviorOverrideStats
  config?: LinkscrawlClientConfig
}): Promise<SiteDocAuditResponse> {
  const norm = safeNormalize(params.url)
  const live = await tryLinkscrawlFetch<SiteDocAuditResponse>('/api/v1/site-doc/audit', {
    query: { site_id: params.siteId, url: norm.normalizedUrl },
    config: params.config,
  })
  if (live && live.registrySummary && live.semanticAudit) {
    return { ...live, status: 'ok', source: 'live' }
  }

  const pageTypeInfo = detectPageTypeFromPath(norm.pathname)
  return {
    status: 'not_collected',
    reason: NOT_COLLECTED_REASON,
    source: 'not_collected',
    siteId: params.siteId,
    targetUrl: params.url || norm.normalizedUrl,
    canonicalUrl: norm.normalizedUrl,
    urlMatchKey: norm.matchKey,
    auditedAt: new Date().toISOString(),
    totalDetectionRules: 0,
    overallHealthScore: 0,
    grade: 'N/A',
    confidence: buildConfidenceMeta([]),
    registrySummary: {
      totalCategories: 0,
      totalRegistryRules: 0,
      criticalTotal: 0,
      warningTotal: 0,
      noticeTotal: 0,
      passedTotal: 0,
      categories: [],
    },
    topIssues: [],
    semanticAudit: {
      detectedPageType: pageTypeInfo.type,
      pageTypeLabel: pageTypeInfo.label,
      cascadeStageReached: 'stage1_jev',
      overallSemanticScore: 0,
      topicalCoherenceScore: 0,
      pillars: [],
      items: [],
      headingDecorativeAbuse: {
        detected: false,
        totalCheckedHeadings: 0,
        abusedCount: 0,
        angles: {
          visualSizingOnly: false,
          nonHeadingCardLabel: false,
          hierarchySkip: false,
          excessiveLengthOrCta: false,
          repeatedBoilerplateHeading: false,
        },
        examples: [],
      },
    },
    designAudit: {
      deterministicDefectsTotal: 0,
      activeDefectTypes: 0,
      defects: [],
      visionOverallScore: 0,
      visionAxes: [],
    },
    fixPatches: [],
  }
}

// ============================================================================
// 2. getPerformanceFusion
// ============================================================================

export async function getPerformanceFusion(params: {
  siteId: string
  url?: string
  behaviorOverride?: BehaviorOverrideStats
  config?: LinkscrawlClientConfig
}): Promise<PerformanceFusionResponse> {
  const norm = safeNormalize(params.url)
  const live = await tryLinkscrawlFetch<PerformanceFusionResponse>(
    '/api/v1/performance/fusion',
    {
      query: { site_id: params.siteId, url: norm.normalizedUrl },
      config: params.config,
    },
  )
  if (live && live.cwvP75 && live.behaviorCvLossFusion) {
    return { ...live, status: 'ok', source: 'live' }
  }

  const observedSessions = params.behaviorOverride?.sessions ?? 0
  const emptyCohort = (label: string, thresholdLabel: string) => ({
    label,
    thresholdLabel,
    sessions: 0,
    conversions: 0,
    cvr: 0,
    bounceRate: 0,
    avgDwellMs: 0,
  })

  return {
    status: 'not_collected',
    reason: NOT_COLLECTED_REASON,
    source: 'not_collected',
    siteId: params.siteId,
    targetUrl: params.url || norm.normalizedUrl,
    canonicalUrl: norm.normalizedUrl,
    urlMatchKey: norm.matchKey,
    measuredAt: new Date().toISOString(),
    totalSpeedRulesChecked: 0,
    triggeredRulesCount: 0,
    cwvP75: {
      lcpMs: 0,
      inpMs: 0,
      cls: 0,
      ttfbMs: 0,
      fcpMs: 0,
      speedScore: 0,
      status: {
        lcp: 'needs_improvement',
        inp: 'needs_improvement',
        cls: 'needs_improvement',
        ttfb: 'needs_improvement',
      },
    },
    families: [],
    behaviorCvLossFusion: {
      monthlyTotalSessions: observedSessions,
      preRenderExitRate: 0,
      preRenderExitSessions: 0,
      cohortComparison: {
        fastCohort: emptyCohort('高速表示コホート (LCP < 2.5s)', 'LCP < 2.5s'),
        moderateCohort: emptyCohort('標準コホート (2.5s - 4.0s)', '2.5s <= LCP <= 4.0s'),
        slowCohort: emptyCohort('低速表示コホート (LCP > 4.0s)', 'LCP > 4.0s'),
        fastVsSlowCvrMultiplier: 0,
      },
      estimatedMonthlyLostConversions: 0,
      estimatedMonthlyLostRevenueJpy: 0,
      recoverableConversionsIfFast: 0,
      recoverableRevenueJpyIfFast: 0,
      unitConversionValueJpy: 0,
      bottleneckPatterns: [],
    },
    confidence: buildConfidenceMeta([]),
  }
}

// ============================================================================
// 3. getUrlFusionMl
// ============================================================================

export async function getUrlFusionMl(params: {
  siteId: string
  url: string
  behaviorOverride?: BehaviorOverrideStats
  config?: LinkscrawlClientConfig
}): Promise<UrlFusionMlResponse> {
  const norm = safeNormalize(params.url)
  const live = await tryLinkscrawlFetch<UrlFusionMlResponse>('/api/v1/fusion/ml-url', {
    query: { site_id: params.siteId, url: norm.normalizedUrl },
    config: params.config,
  })
  if (live && live.contentMap && live.scrollSurvival && live.cvrPrediction) {
    return { ...live, status: 'ok', source: 'live' }
  }

  return {
    status: 'not_collected',
    reason: NOT_COLLECTED_REASON,
    source: 'not_collected',
    siteId: params.siteId,
    targetUrl: params.url || norm.normalizedUrl,
    canonicalUrl: norm.normalizedUrl,
    urlMatchKey: norm.matchKey,
    analyzedAt: new Date().toISOString(),
    activeMlTools: [],
    contentMap: [],
    frictionHotspots: [],
    scrollSurvival: {
      pageTotalHeightPx: 0,
      medianDropoffYpx: 0,
      medianDropoffScrollPct: 0,
      steepestCliffYpx: 0,
      steepestCliffSection: '',
      converterSurvivalAtCta: 0,
      nonConverterSurvivalAtCta: 0,
      curve: [],
    },
    cvrPrediction: {
      featureCountUsed: 0,
      modelVersion: '',
      currentObservedCvr: 0,
      predictedBaselineCvr: 0,
      potentialOptimizedCvr: 0,
      upliftMultiplier: 0,
      sessionQualityScore: 0,
      sessionQualityGrade: 'N/A',
      personaDistribution: [],
      topLevers: [],
    },
    teacherVerdict: {
      overallScore: 0,
      grade: 'N/A',
      headlineVerdict: 'データ未収集 (not_collected)',
      executiveSummary: NOT_COLLECTED_REASON,
      pillars: [],
      priorityPrescriptions: [],
    },
    confidence: buildConfidenceMeta([]),
  }
}

// ============================================================================
// 4. getAioCitationDiff
// ============================================================================

export async function getAioCitationDiff(params: {
  siteId: string
  url?: string
  config?: LinkscrawlClientConfig
}): Promise<{
  status: CollectionStatus
  reason?: string
  source: DataSourceMode
  totalTrackedQueries: number
  aioAppearanceRate: number
  selfCitationRate: number
  competitorGapCount: number
  diffs: AioCitationDiffItem[]
}> {
  const norm = safeNormalize(params.url)
  const live = await tryLinkscrawlFetch<{
    source: DataSourceMode
    totalTrackedQueries: number
    aioAppearanceRate: number
    selfCitationRate: number
    competitorGapCount: number
    diffs: AioCitationDiffItem[]
  }>('/api/v1/aiseo/aio-citation-diff', {
    query: { site_id: params.siteId, url: norm.normalizedUrl },
    config: params.config,
  })
  if (live && Array.isArray(live.diffs)) {
    return { ...live, status: 'ok', source: 'live' }
  }

  return {
    status: 'not_collected',
    reason: NOT_COLLECTED_REASON,
    source: 'not_collected',
    totalTrackedQueries: 0,
    aioAppearanceRate: 0,
    selfCitationRate: 0,
    competitorGapCount: 0,
    diffs: [],
  }
}

// ============================================================================
// 5. runFusionAnswerEngine
// ============================================================================

export async function runFusionAnswerEngine(params: {
  siteId: string
  url?: string
  message: string
  aiTrafficContext?: {
    totalAiSessions: number
    totalAiConversions: number
    aiCvr: number
    organicCvrMultiplier: number
    topSource: string
  }
  config?: LinkscrawlClientConfig
}): Promise<FusionAnswerEngineResponse> {
  const norm = safeNormalize(params.url)
  const question =
    (params.message || '').trim() ||
    'このページのCVRとAI検索流入を改善する最優先施策は？'

  const live = await tryLinkscrawlFetch<FusionAnswerEngineResponse>(
    '/api/v1/answer-engine/fusion-chat',
    {
      method: 'POST',
      body: {
        site_id: params.siteId,
        url: norm.normalizedUrl,
        message: question,
      },
      config: params.config,
    },
  )
  if (live && live.answer && Array.isArray(live.citations)) {
    return { ...live, status: 'ok', source: 'live' }
  }

  return {
    status: 'not_collected',
    reason: NOT_COLLECTED_REASON,
    source: 'not_collected',
    siteId: params.siteId,
    targetUrl: norm.normalizedUrl,
    question,
    answer: '',
    citations: [],
    usedTools: [],
    suggestedActions: [],
    confidence: buildConfidenceMeta([]),
  }
}
