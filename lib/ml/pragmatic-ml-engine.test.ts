import {
  computeKaplanMeierScrollSurvival,
  computeShapBottleneckAttribution,
  getScenarioUpliftPresets,
  recommendSemanticInternalLinks,
  scoreSessionFrustrationAndUplift,
} from './pragmatic-ml-engine'
import { buildPragmaticMlInsightsForUrl } from './pragmatic-ml-server'
import { validateConditionAst } from '@/lib/scenarios/types'

describe('Pragmatic ML & Statistical Engines (4 High-ROI Engines)', () => {
  describe('Engine 1: computeShapBottleneckAttribution', () => {
    it('ranks bottlenecks by absolute SHAP impact and bounds predictedOptimalCvr > baselineCvr', () => {
      const result = computeShapBottleneckAttribution({
        baselineCvr: 0.015,
        lcpMs: 3600,
        clsScore: 0.22,
        ctaFirstYPx: 2800,
        formFieldCount: 9,
        rageAndDeadClickRate: 0.018,
        headingSemanticBreaks: 6,
        ssrVisibilityRatio: 0.55,
        mobileTapTargetViolations: 5,
        sessions: 2400,
      })

      expect(result.baselineCvr).toBeCloseTo(0.015, 4)
      expect(result.predictedOptimalCvr).toBeGreaterThan(result.baselineCvr)
      expect(result.modelConfidence).toBe('high')
      expect(result.factors.length).toBe(8)

      // Check sorted descending by |shapImpactCvrPct|
      for (let i = 1; i < result.factors.length; i++) {
        expect(Math.abs(result.factors[i - 1].shapImpactCvrPct)).toBeGreaterThanOrEqual(
          Math.abs(result.factors[i].shapImpactCvrPct),
        )
      }

      // Relative importance sums to ~100%
      const sumRel = result.factors.reduce((acc, f) => acc + f.relativeImportancePct, 0)
      expect(sumRel).toBeGreaterThan(99)
      expect(sumRel).toBeLessThan(101)
    })
  })

  describe('Engine 2: computeKaplanMeierScrollSurvival', () => {
    it('produces monotonically non-increasing survival curves S(y_1) >= S(y_2), detects hazard cliffs, and computes Log-Rank p-value < 0.05', () => {
      const result = computeKaplanMeierScrollSurvival(
        [
          {
            yPx: 0,
            depthPct: 0,
            sectionLabel: 'FV (0px)',
            converterSurvivalRate: 1.0,
            nonConverterSurvivalRate: 1.0,
          },
          {
            yPx: 700,
            depthPct: 20,
            sectionLabel: 'Sec 1 (700px)',
            converterSurvivalRate: 0.96,
            nonConverterSurvivalRate: 0.85,
          },
          {
            yPx: 1500,
            depthPct: 45,
            sectionLabel: 'Sec 2 Comparison Matrix (1500px)',
            converterSurvivalRate: 0.89,
            nonConverterSurvivalRate: 0.51,
          },
          {
            yPx: 2600,
            depthPct: 75,
            sectionLabel: 'Sec 3 Deep Prose (2600px)',
            converterSurvivalRate: 0.81,
            nonConverterSurvivalRate: 0.28,
          },
          {
            yPx: 3600,
            depthPct: 100,
            sectionLabel: 'Footer CTA (3600px)',
            converterSurvivalRate: 0.74,
            nonConverterSurvivalRate: 0.14,
          },
        ],
        { initialConverters: 220, initialNonConverters: 2600 },
      )

      expect(result.convertersCurve.length).toBe(5)
      expect(result.nonConvertersCurve.length).toBe(5)

      for (let i = 1; i < result.convertersCurve.length; i++) {
        expect(result.convertersCurve[i - 1].survivalRate).toBeGreaterThanOrEqual(
          result.convertersCurve[i].survivalRate,
        )
        expect(result.nonConvertersCurve[i - 1].survivalRate).toBeGreaterThanOrEqual(
          result.nonConvertersCurve[i].survivalRate,
        )
      }

      expect(result.steepestCliff).not.toBeNull()
      expect(result.steepestCliff?.yPx).toBe(1500)
      expect(result.logRankStat).toBeGreaterThan(10)
      expect(result.pValue).toBeLessThan(0.05)
      expect(result.isSignificant).toBe(true)
    })
  })

  describe('Engine 3: scoreSessionFrustrationAndUplift', () => {
    it('classifies engaged but hesitating users as persuadable_high_uplift and smooth fast users as sure_thing_do_not_disturb', () => {
      const persuadable = scoreSessionFrustrationAndUplift({
        rageClicks: 1,
        deadClicks: 2,
        scrollReversals: 3,
        formHesitationSec: 12,
        dwellTimeSec: 55,
        scrollDepthPct: 68,
        isPricingOrCartPage: true,
      })

      expect(persuadable.intentSegment).toBe('persuadable_high_uplift')
      expect(persuadable.frustrationScore).toBeGreaterThan(50)
      expect(persuadable.recommendedIntervention).toBe('form_field_helper')
      expect(validateConditionAst(persuadable.recommendedConditionAst)).toEqual([])

      const sureThing = scoreSessionFrustrationAndUplift({
        rageClicks: 0,
        deadClicks: 0,
        scrollReversals: 0,
        formHesitationSec: 1,
        dwellTimeSec: 28,
        scrollDepthPct: 80,
        isPricingOrCartPage: true,
      })

      expect(sureThing.intentSegment).toBe('sure_thing_do_not_disturb')
      expect(sureThing.recommendedIntervention).toBe('none')
      expect(sureThing.frustrationScore).toBeLessThan(20)
    })

    it('provides valid M Agent ASTs for all 3 uplift presets', () => {
      const presets = getScenarioUpliftPresets()
      expect(presets.map((p) => p.id)).toEqual([
        'persuadable_high_uplift',
        'friction_rescue',
        'ai_agent_guide',
      ])
      for (const preset of presets) {
        expect(validateConditionAst(preset.conditionAst)).toEqual([])
      }
    })
  })

  describe('Engine 4: recommendSemanticInternalLinks', () => {
    it('recommends high-authority semantic links and prioritizes orphan and conversion hub pages', () => {
      const recs = recommendSemanticInternalLinks()
      expect(recs.length).toBeGreaterThanOrEqual(3)

      for (const rec of recs) {
        expect(rec.sourceUrl).not.toBe(rec.targetUrl)
        expect(rec.cosineSimilarity).toBeGreaterThanOrEqual(0.45)
        expect(rec.cosineSimilarity).toBeLessThanOrEqual(1)
        expect(rec.authorityTransferScore).toBeGreaterThan(0)
        expect(rec.recommendedAnchorText.length).toBeGreaterThan(3)
      }

      // Top recommendation should include orphan recovery or CV hub link
      const topUrls = recs.slice(0, 3).map((r) => r.targetUrl)
      expect(
        topUrls.some(
          (u) =>
            u.includes('orphan-pages-detection-fix') ||
            u.includes('ugokimap-linkscrawl-trial'),
        ),
      ).toBe(true)
    })
  })

  describe('End-to-End Orchestrator: buildPragmaticMlInsightsForUrl', () => {
    it('returns not_collected with null/empty ML fields (no fabricated fallback outputs) when live data is unavailable', async () => {
      const payload = await buildPragmaticMlInsightsForUrl({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        url: 'https://link-th.com/entry/internal-link-optimization',
      })

      expect(payload.status).toBe('not_collected')
      expect(payload.source).toBe('not_collected')
      expect(payload.reason).toBeTruthy()
      expect(payload.bottleneckAttribution).toBeNull()
      expect(payload.scrollSurvival).toBeNull()
      expect(payload.sampleSessionScoring).toBeNull()
      expect(payload.upliftPresets).toEqual([])
      expect(payload.semanticLinks).toEqual([])
    })
  })
})
