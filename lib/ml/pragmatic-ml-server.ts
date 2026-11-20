/**
 * Server-only orchestrator for Pragmatic ML Insights (`lib/ml/pragmatic-ml-server.ts`)
 *
 * Separated from `pragmatic-ml-engine.ts` so client components (`components/scenarios/*`,
 * `components/ml/*`, `app/(proof)/seo/internal-links/page.tsx`) never pull ClickHouse (`node:os`)
 * or `node:crypto` into Next.js browser bundles.
 */

import { analyzeCrawlerPageAcquisition } from '@/lib/aiseo/crawler-acquisition'
import { createEmptyFusionDatasetForUrl } from '@/lib/fusion/behavior-structure'
import {
  getPerformanceFusion,
  getSiteDocAudit,
  getUrlFusionMl,
  type LinkscrawlClientConfig,
} from '@/lib/linkscrawl/client'
import {
  computeKaplanMeierScrollSurvival,
  computeShapBottleneckAttribution,
  getScenarioUpliftPresets,
  type PragmaticMlInsightsPayload,
  type ScrollCohortStepInput,
} from '@/lib/ml/pragmatic-ml-engine'

export function getLinksCrawlClient(config?: LinkscrawlClientConfig) {
  return {
    getCvrPrediction: async (siteId: string, url: string) => {
      const ml = await getUrlFusionMl({ siteId, url, config })
      return ml.cvrPrediction
    },
    getSpeedLoss: async (siteId: string, url: string) => {
      const perf = await getPerformanceFusion({ siteId, url, config })
      return perf
    },
    getFrictionHotspots: async (siteId: string, url: string) => {
      const [ml, doc] = await Promise.all([
        getUrlFusionMl({ siteId, url, config }),
        getSiteDocAudit({ siteId, url, config }),
      ])
      return {
        isLive: ml.source === 'live' && doc.source === 'live',
        frictionHotspots: ml.frictionHotspots,
        contentMap: ml.contentMap,
        scrollSurvival: ml.scrollSurvival,
        semanticAudit: doc.semanticAudit,
        designAudit: doc.designAudit,
      }
    },
  }
}

export async function buildPragmaticMlInsightsForUrl(params: {
  tenantId?: string
  siteId: string
  url: string
  config?: LinkscrawlClientConfig
}): Promise<PragmaticMlInsightsPayload> {
  const client = getLinksCrawlClient(params.config)
  const emptyBase = createEmptyFusionDatasetForUrl(params.url, params.siteId)

  const [urlMl, speedLoss, frictionData, acqReport] = await Promise.all([
    getUrlFusionMl({ siteId: params.siteId, url: emptyBase.canonicalUrl, config: params.config }),
    client.getSpeedLoss(params.siteId, emptyBase.canonicalUrl),
    client.getFrictionHotspots(params.siteId, emptyBase.canonicalUrl),
    analyzeCrawlerPageAcquisition({
      tenantId: params.tenantId,
      siteId: params.siteId,
      url: emptyBase.canonicalUrl,
    }).catch(() => null),
  ])

  const hasLiveData =
    urlMl.source === 'live' &&
    speedLoss.source === 'live' &&
    frictionData.isLive &&
    speedLoss.behaviorCvLossFusion.monthlyTotalSessions > 0 &&
    frictionData.contentMap.length > 0

  if (!hasLiveData) {
    const reason =
      'ClickHouse 行動実測または LINKTH CRAWL 構造・ML 推論データが未収集のため推論結果を生成しません (not_collected)'
    return {
      status: 'not_collected',
      source: 'not_collected',
      reason,
      siteId: params.siteId,
      targetUrl: emptyBase.canonicalUrl,
      bottleneckAttribution: null,
      scrollSurvival: null,
      sampleSessionScoring: null,
      upliftPresets: [],
      semanticLinks: [],
      methodologyNote: reason,
    }
  }

  const cvrPred = urlMl.cvrPrediction
  const firstCtaSec = frictionData.contentMap.find((s) => s.hasCta)
  const ctaFirstYPx = firstCtaSec ? firstCtaSec.yStartPx : 0
  const totalSessions = speedLoss.behaviorCvLossFusion.monthlyTotalSessions
  const totalDead = frictionData.contentMap.reduce((s, sec) => s + sec.deadClickCount, 0)
  const totalRage = frictionData.contentMap.reduce((s, sec) => s + sec.rageClickCount, 0)
  const rageAndDeadRate = totalSessions > 0 ? (totalDead + totalRage) / totalSessions : 0

  const bottleneckAttribution = computeShapBottleneckAttribution({
    baselineCvr: cvrPred.currentObservedCvr,
    lcpMs: speedLoss.cwvP75.lcpMs,
    clsScore: speedLoss.cwvP75.cls,
    ctaFirstYPx,
    formFieldCount: 0,
    rageAndDeadClickRate: rageAndDeadRate,
    headingSemanticBreaks: frictionData.semanticAudit.headingDecorativeAbuse.abusedCount,
    ssrVisibilityRatio: acqReport && acqReport.status === 'ok' ? acqReport.ssrVisibilityScore / 100 : 1,
    mobileTapTargetViolations:
      frictionData.designAudit.defects.find(
        (d) => d.code === 'tap_target_too_small',
      )?.count ?? 0,
    sessions: totalSessions,
  })

  const kmSteps: ScrollCohortStepInput[] = frictionData.scrollSurvival.curve.map((pt) => ({
    yPx: pt.yPx,
    depthPct: pt.scrollPct,
    sectionLabel: pt.nearestHeading ? `${pt.nearestHeading} (${pt.yPx}px)` : `${pt.yPx}px`,
    converterSurvivalRate: pt.convertersSurvival,
    nonConverterSurvivalRate: pt.nonConvertersSurvival,
  }))

  const scrollSurvival =
    kmSteps.length >= 2
      ? computeKaplanMeierScrollSurvival(kmSteps, {
          initialConverters: Math.max(1, Math.round(totalSessions * bottleneckAttribution.baselineCvr)),
          initialNonConverters: Math.max(1, totalSessions),
        })
      : null

  return {
    status: 'ok',
    source: 'live',
    siteId: params.siteId,
    targetUrl: emptyBase.canonicalUrl,
    bottleneckAttribution,
    scrollSurvival,
    sampleSessionScoring: null,
    upliftPresets: getScenarioUpliftPresets(),
    semanticLinks: [],
    methodologyNote:
      'LINKTH CRAWL live 構造データおよび実測行動セッションに基づく説明可能ML推論結果です。',
  }
}
