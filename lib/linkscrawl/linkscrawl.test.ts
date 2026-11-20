import {
  getAioCitationDiff,
  getPerformanceFusion,
  getSiteDocAudit,
  getUrlFusionMl,
  runFusionAnswerEngine,
} from './client'

describe('lib/linkscrawl/client (Wave 0: no fabricated fallback_synthesized data)', () => {
  it('returns not_collected with zeroed/empty SiteDocAuditResponse when LINKTH CRAWL server is offline', async () => {
    const report = await getSiteDocAudit({
      siteId: 'site-test-1',
      url: 'https://www.link-th.com/entry/internal-link-optimization?utm_source=chatgpt.com',
    })

    expect(report.status).toBe('not_collected')
    expect(report.source).toBe('not_collected')
    expect(report.reason).toBeTruthy()
    expect(report.siteId).toBe('site-test-1')
    expect(report.canonicalUrl).toBe('https://link-th.com/entry/internal-link-optimization')
    expect(report.totalDetectionRules).toBe(0)
    expect(report.grade).toBe('N/A')
    expect(report.confidence.level).toBe('insufficient')
    expect(report.registrySummary.totalCategories).toBe(0)
    expect(report.registrySummary.totalRegistryRules).toBe(0)
    expect(report.registrySummary.categories).toEqual([])
    expect(report.topIssues).toEqual([])
    expect(report.semanticAudit.pillars).toEqual([])
    expect(report.semanticAudit.items).toEqual([])
    expect(report.designAudit.defects).toEqual([])
    expect(report.designAudit.visionAxes).toEqual([])
    expect(report.fixPatches).toEqual([])
  })

  it('returns not_collected with zeroed PerformanceFusionResponse (no fabricated JPY loss or cohorts) when offline', async () => {
    const perf = await getPerformanceFusion({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
    })

    expect(perf.status).toBe('not_collected')
    expect(perf.source).toBe('not_collected')
    expect(perf.reason).toBeTruthy()
    expect(perf.totalSpeedRulesChecked).toBe(0)
    expect(perf.families).toEqual([])
    expect(perf.cwvP75.lcpMs).toBe(0)
    expect(perf.behaviorCvLossFusion.preRenderExitRate).toBe(0)
    expect(perf.behaviorCvLossFusion.estimatedMonthlyLostConversions).toBe(0)
    expect(perf.behaviorCvLossFusion.estimatedMonthlyLostRevenueJpy).toBe(0)
    expect(perf.behaviorCvLossFusion.unitConversionValueJpy).toBe(0)
    expect(perf.behaviorCvLossFusion.cohortComparison.fastVsSlowCvrMultiplier).toBe(0)
    expect(perf.confidence.level).toBe('insufficient')
  })

  it('returns not_collected with empty UrlFusionMlResponse (no fabricated KM curve or 84-feature model) when offline', async () => {
    const ml = await getUrlFusionMl({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
    })

    expect(ml.status).toBe('not_collected')
    expect(ml.source).toBe('not_collected')
    expect(ml.reason).toBeTruthy()
    expect(ml.activeMlTools).toEqual([])
    expect(ml.contentMap).toEqual([])
    expect(ml.frictionHotspots).toEqual([])
    expect(ml.scrollSurvival.medianDropoffYpx).toBe(0)
    expect(ml.scrollSurvival.curve).toEqual([])
    expect(ml.cvrPrediction.featureCountUsed).toBe(0)
    expect(ml.cvrPrediction.topLevers).toEqual([])
    expect(ml.teacherVerdict.pillars).toEqual([])
    expect(ml.teacherVerdict.grade).toBe('N/A')
    expect(ml.confidence.level).toBe('insufficient')
  })

  it('returns not_collected for AIO citation diff and Answer Engine when LINKTH CRAWL is offline', async () => {
    const aio = await getAioCitationDiff({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
    })
    expect(aio.status).toBe('not_collected')
    expect(aio.source).toBe('not_collected')
    expect(aio.totalTrackedQueries).toBe(0)
    expect(aio.competitorGapCount).toBe(0)
    expect(aio.diffs).toEqual([])

    const answer = await runFusionAnswerEngine({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
      message: 'CVRを最も押し下げている原因とAI検索流入の改善策を教えて',
    })

    expect(answer.status).toBe('not_collected')
    expect(answer.source).toBe('not_collected')
    expect(answer.reason).toBeTruthy()
    expect(answer.answer).toBe('')
    expect(answer.citations).toEqual([])
    expect(answer.usedTools).toEqual([])
    expect(answer.confidence.level).toBe('insufficient')
  })
})
