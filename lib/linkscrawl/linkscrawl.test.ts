import {
  getAioCitationDiff,
  getPerformanceFusion,
  getSiteDocAudit,
  getUrlFusionMl,
  runFusionAnswerEngine,
} from './client'

describe('lib/linkscrawl/client (LINKTH CRAWL v1 BFF Integration & Graceful Degradation)', () => {
  it('gracefully degrades when LINKTH CRAWL server is offline and returns full 418-item SiteDocAuditResponse with multi-signal confidence', async () => {
    const report = await getSiteDocAudit({
      siteId: 'site-test-1',
      url: 'https://www.link-th.com/entry/internal-link-optimization?utm_source=chatgpt.com',
    })

    expect(report.source).toBe('fallback_synthesized')
    expect(report.siteId).toBe('site-test-1')
    expect(report.canonicalUrl).toBe('https://link-th.com/entry/internal-link-optimization')
    expect(report.totalDetectionRules).toBe(418)
    expect(['S', 'A', 'B', 'C', 'D']).toContain(report.grade)

    // 1. 15 categories summing to 294 technical SEO registry rules
    expect(report.registrySummary.totalCategories).toBe(15)
    expect(report.registrySummary.totalRegistryRules).toBe(294)
    expect(report.registrySummary.categories).toHaveLength(15)
    const sumCategoryRules = report.registrySummary.categories.reduce(
      (sum, c) => sum + c.totalRules,
      0,
    )
    expect(sumCategoryRules).toBe(294)

    // Top issues carry CSS selector, HTML snippet, line number, and confidence metadata
    expect(report.topIssues.length).toBeGreaterThanOrEqual(4)
    for (const issue of report.topIssues) {
      expect(['confirmed', 'suspected']).toContain(issue.confidence.level)
      expect(issue.confidence.signals.length).toBeGreaterThanOrEqual(1)
    }
    const confirmedIssues = report.topIssues.filter(
      (i) => i.confidence.level === 'confirmed',
    )
    expect(confirmedIssues.length).toBeGreaterThanOrEqual(4)

    // 2. 16-item × 7-pillar semantic AI audit + 5-angle <h> decorative abuse detection
    expect(report.semanticAudit.pillars).toHaveLength(7)
    expect(report.semanticAudit.items).toHaveLength(16)
    expect(report.semanticAudit.headingDecorativeAbuse.detected).toBe(true)
    expect(report.semanticAudit.headingDecorativeAbuse.angles.visualSizingOnly).toBe(true)
    expect(report.semanticAudit.headingDecorativeAbuse.angles.nonHeadingCardLabel).toBe(true)
    expect(report.semanticAudit.headingDecorativeAbuse.angles.hierarchySkip).toBe(true)
    expect(report.semanticAudit.headingDecorativeAbuse.angles.excessiveLengthOrCta).toBe(true)
    expect(report.semanticAudit.headingDecorativeAbuse.angles.repeatedBoilerplateHeading).toBe(true)

    // 3. 10 deterministic design defects + Vision 8 axes + auto fix-patches
    expect(report.designAudit.deterministicDefectsTotal).toBe(10)
    expect(report.designAudit.defects).toHaveLength(10)
    expect(report.designAudit.visionAxes).toHaveLength(8)
    expect(report.fixPatches.length).toBeGreaterThanOrEqual(3)
    expect(report.fixPatches[0].unifiedDiff).toContain('@@')
  })

  it('returns 12-family 90-rule PerformanceFusionResponse with CWV p75 and behavior CV loss quantification', async () => {
    const perf = await getPerformanceFusion({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
    })

    expect(perf.totalSpeedRulesChecked).toBe(90)
    expect(perf.families).toHaveLength(12)
    const sumRules = perf.families.reduce((acc, f) => acc + f.totalRules, 0)
    expect(sumRules).toBe(90)

    expect(perf.cwvP75.lcpMs).toBeGreaterThan(0)
    expect(perf.behaviorCvLossFusion.preRenderExitRate).toBeGreaterThan(0)
    expect(perf.behaviorCvLossFusion.estimatedMonthlyLostConversions).toBeGreaterThan(0)
    expect(perf.behaviorCvLossFusion.recoverableConversionsIfFast).toBeGreaterThan(0)
    expect(
      perf.behaviorCvLossFusion.cohortComparison.fastVsSlowCvrMultiplier,
    ).toBeGreaterThan(1)
    expect(perf.confidence.level).toBe('confirmed')
  })

  it('returns UGOKI MAP Fusion & ML 13-Tool analysis (Content Map, Friction Hotspots, Kaplan-Meier Survival, 80+ Feature CVR Prediction, 7-Pillar Teacher Verdict)', async () => {
    const ml = await getUrlFusionMl({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
    })

    expect(ml.activeMlTools).toHaveLength(13)
    expect(ml.contentMap.length).toBeGreaterThanOrEqual(4)
    expect(ml.frictionHotspots.length).toBeGreaterThanOrEqual(2)
    expect(ml.scrollSurvival.medianDropoffYpx).toBeGreaterThan(0)
    expect(ml.scrollSurvival.curve.length).toBeGreaterThanOrEqual(5)
    expect(ml.cvrPrediction.featureCountUsed).toBeGreaterThanOrEqual(80)
    expect(ml.cvrPrediction.potentialOptimizedCvr).toBeGreaterThan(
      ml.cvrPrediction.currentObservedCvr,
    )
    expect(ml.cvrPrediction.topLevers.length).toBeGreaterThanOrEqual(3)
    expect(ml.teacherVerdict.pillars).toHaveLength(7)
    expect(['S', 'A', 'B', 'C', 'D']).toContain(ml.teacherVerdict.grade)
  })

  it('returns AIO citation diff and executes 18-tool Fusion Answer Engine with strict [1]..[4] citations and HMAC evidenceRef', async () => {
    const aio = await getAioCitationDiff({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
    })
    expect(aio.totalTrackedQueries).toBeGreaterThan(0)
    expect(aio.competitorGapCount).toBeGreaterThan(0)
    expect(aio.diffs.length).toBeGreaterThan(0)

    const answer = await runFusionAnswerEngine({
      siteId: 'site-test-1',
      url: 'https://link-th.com/entry/internal-link-optimization',
      message: 'CVRを最も押し下げている原因とAI検索流入の改善策を教えて',
    })

    expect(answer.answer).toContain('[1]')
    expect(answer.answer).toContain('[2]')
    expect(answer.answer).toContain('[3]')
    expect(answer.citations.length).toBeGreaterThanOrEqual(4)
    expect(answer.citations[0].evidenceRef).toMatch(/^ev_hmac_/)
    expect(answer.usedTools.length).toBeGreaterThanOrEqual(6)
    expect(answer.confidence.level).toBe('confirmed')
  })
})
