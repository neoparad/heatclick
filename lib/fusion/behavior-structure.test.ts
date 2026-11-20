import {
  buildEnrichedFusionIntelligenceForUrl,
  buildFusionDatasetForUrl,
  diagnoseBehaviorAndStructure,
} from './behavior-structure'

describe('lib/fusion/behavior-structure', () => {
  it('diagnoses dead click × structure, rage click × CLS, pre-render exit, shallow reading, and directory perf bounce with multi-signal confidence', () => {
    const dataset = buildFusionDatasetForUrl('https://link-th.com/entry/internal-link-optimization', 'site-1')
    expect(dataset.urlMatchKey).toBe('link-th.com/entry/internal-link-optimization')
    expect(dataset.urlHash16).toHaveLength(16)

    const diagnoses = diagnoseBehaviorAndStructure(dataset)
    expect(diagnoses.length).toBeGreaterThanOrEqual(5)

    const categories = diagnoses.map((d) => d.category)
    expect(categories).toContain('dead_click_structure')
    expect(categories).toContain('rage_click_cls')
    expect(categories).toContain('exit_before_render')
    expect(categories).toContain('shallow_reading_dropoff')
    expect(categories).toContain('low_perf_high_bounce')
    expect(categories).toContain('ai_vs_human_gap')

    // Every diagnosis that combines independent planes (human_behavior + structure_dom/structure_perf/identity)
    // must achieve 'confirmed' confidence and carry >=2 signals.
    for (const diag of diagnoses) {
      expect(diag.confidence.level).toBe('confirmed')
      expect(diag.confidence.signals.length).toBeGreaterThanOrEqual(2)
      expect(diag.recommendation.length).toBeGreaterThan(10)
    }
  })

  it('downgrades confidence to suspected when only human_behavior signal is available without structure evidence', () => {
    const dataset = buildFusionDatasetForUrl('https://link-th.com/entry/internal-link-optimization')
    // Make all sections have CTAs and links so only the overall deadClicks count triggers a single-plane signal
    const modified = {
      ...dataset,
      sections: dataset.sections.map((s) => ({ ...s, hasCta: true, linkCount: 4 })),
    }
    const diagnoses = diagnoseBehaviorAndStructure(modified)
    const deadClickDiag = diagnoses.find((d) => d.category === 'dead_click_structure')
    expect(deadClickDiag).toBeDefined()
    expect(deadClickDiag?.confidence.level).toBe('suspected')
  })

  it('returns not_collected (no fabricated 418-rule / 90-rule / 80-feature values) when live upstream data is unavailable', async () => {
    const enriched = await buildEnrichedFusionIntelligenceForUrl({
      url: 'https://link-th.com/entry/internal-link-optimization',
      siteId: 'site-1',
    })

    expect(enriched.status).toBe('not_collected')
    expect(enriched.reason).toBeTruthy()
    expect(enriched.crossDiagnoses).toEqual([])
    expect(enriched.siteDoc418.source).toBe('not_collected')
    expect(enriched.siteDoc418.totalDetectionRules).toBe(0)
    expect(enriched.performance90.source).toBe('not_collected')
    expect(enriched.performance90.totalSpeedRulesChecked).toBe(0)
    expect(enriched.teacherVerdict.pillars).toEqual([])
    expect(enriched.scrollSurvival.medianDropoffYpx).toBe(0)
    expect(enriched.cvrPrediction.featureCountUsed).toBe(0)
  })
})

