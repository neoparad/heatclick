import {
  computeRequiredSampleSizePerArm,
  normalCdf,
  normalQuantile,
  runHypothesisTest,
} from '@/lib/experiments/hypothesis-testing'

describe('lib/experiments/hypothesis-testing', () => {
  it('normalCdf & normalQuantile are accurate inverses', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5)
    expect(normalCdf(1.95996)).toBeCloseTo(0.975, 4)
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 3)
    expect(normalQuantile(0.5)).toBeCloseTo(0, 5)
  })

  it('returns underpowered when sample size is small even if raw lift looks huge', () => {
    const res = runHypothesisTest({
      controlSessions: 120,
      controlConversions: 3, // 2.5%
      variantSessions: 120,
      variantConversions: 9, // 7.5% (+200% lift, but only 120 sessions!)
    })
    expect(res.verdict).toBe('underpowered')
    expect(res.verdictHeadline).toContain('検出力不足')
    expect(res.verdictHeadline).toContain('早期終了による偽陽性リスクあり')
    expect(res.sampleProgressPct).toBeLessThan(100)
    expect(res.remainingSessionsNeeded).toBeGreaterThan(0)
  })

  it('returns significant_winner when p < 0.05, power >= 0.8, and lift > 0', () => {
    const res = runHypothesisTest({
      controlSessions: 4200,
      controlConversions: 126, // 3.00%
      variantSessions: 4250,
      variantConversions: 187, // 4.40% (+46.7% lift)
    })
    expect(res.verdict).toBe('significant_winner')
    expect(res.pValue).toBeLessThan(0.05)
    expect(res.statisticalPower).toBeGreaterThanOrEqual(0.8)
    expect(res.relativeLiftPct).toBeGreaterThan(40)
    expect(res.ci95Low).toBeGreaterThan(0)
    expect(res.verdictHeadline).toContain('統計的有意に改善')
  })

  it('returns significant_loser when p < 0.05 and lift < 0 with sufficient sample', () => {
    const res = runHypothesisTest({
      controlSessions: 4000,
      controlConversions: 160, // 4.00%
      variantSessions: 4000,
      variantConversions: 104, // 2.60% (-35% lift)
    })
    expect(res.verdict).toBe('significant_loser')
    expect(res.pValue).toBeLessThan(0.05)
    expect(res.relativeLiftPct).toBeLessThan(-30)
    expect(res.ci95High).toBeLessThan(0)
    expect(res.verdictHeadline).toContain('統計的有意に悪化')
  })

  it('returns inconclusive when sample size reaches target but difference is noise', () => {
    const res = runHypothesisTest({
      controlSessions: 12000,
      controlConversions: 480, // 4.00%
      variantSessions: 12000,
      variantConversions: 492, // 4.10% (+2.5% lift, noise)
      mdeRelative: 0.25,
    })
    expect(res.verdict).toBe('inconclusive')
    expect(res.pValue).toBeGreaterThanOrEqual(0.05)
    expect(res.ci95Low).toBeLessThan(0)
    expect(res.ci95High).toBeGreaterThan(0)
    expect(res.verdictHeadline).toContain('有意差なし')
  })

  it('computeRequiredSampleSizePerArm returns bounded positive integer and supports visitorsC/V aliases', () => {
    const n = computeRequiredSampleSizePerArm({
      baselineCvr: 0.04,
      mdeRelative: 0.15,
      alpha: 0.05,
      targetPower: 0.8,
    })
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(400)
    expect(n).toBeLessThanOrEqual(25000)

    const aliasRes = runHypothesisTest({
      visitorsC: 5000,
      conversionsC: 150,
      visitorsV: 5000,
      conversionsV: 225,
    })
    expect(aliasRes.verdict).toBe('significant_winner')
    expect(aliasRes.requiredSamplePerArm).toBe(aliasRes.requiredSessionsPerArm)
  })
})
