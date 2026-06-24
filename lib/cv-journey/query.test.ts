/**
 * query.ts の純関数（stepsFromReached / assembleFunnel）のユニットテスト。
 * 進行/離脱率・nodes/links・ボトルネック・CVR の算出を固定する。
 */

import { stepsFromReached, assembleFunnel } from './query'
import { DEFAULT_FUNNEL } from './funnel-config'
import type { CvSource } from '@/lib/api/cv-journey'

const REACHED = [10_000, 6_000, 1_500, 300]

describe('stepsFromReached', () => {
  const steps = stepsFromReached(DEFAULT_FUNNEL, REACHED, [null, null, null, null])

  it('各ステップの reached が一致', () => {
    expect(steps.map((s) => s.reached)).toEqual(REACHED)
  })

  it('進行/離脱が単調に算出される', () => {
    expect(steps[0].advanced).toBe(6_000)
    expect(steps[0].dropped).toBe(4_000)
    expect(steps[0].dropRate).toBeCloseTo(0.4, 5)
    expect(steps[0].advanceRate).toBeCloseTo(0.6, 5)
  })

  it('最終ステップは離脱 0・advanced=reached', () => {
    const last = steps[steps.length - 1]
    expect(last.dropped).toBe(0)
    expect(last.advanced).toBe(300)
    expect(last.dropRate).toBe(0)
  })

  it('reached=0 のステップはゼロ除算しない', () => {
    const s = stepsFromReached(DEFAULT_FUNNEL, [0, 0, 0, 0], [null, null, null, null])
    expect(s[0].dropRate).toBe(0)
    expect(s[0].advanceRate).toBe(0)
  })
})

describe('assembleFunnel', () => {
  const steps = stepsFromReached(DEFAULT_FUNNEL, REACHED, [null, null, null, null])
  const sources: CvSource[] = [
    { key: 'google / organic', label: 'google / organic', sessions: 7_000 },
    { key: 'direct / none', label: 'direct / none', sessions: 3_000 },
  ]
  const data = assembleFunnel(steps, sources, { totalSessions: 10_000, cvSessions: 300 })

  it('source ノード + step ノード + dropoff ノードを生成', () => {
    expect(data.nodes.filter((n) => n.kind === 'source')).toHaveLength(2)
    expect(data.nodes.filter((n) => n.id.startsWith('step-'))).toHaveLength(4)
    // 最終以外の 3 ステップに dropoff（drop>0）
    expect(data.nodes.filter((n) => n.kind === 'dropoff')).toHaveLength(3)
  })

  it('source → step-0 リンクが按分される', () => {
    const srcLinks = data.links.filter((l) => l.target === 'step-0')
    expect(srcLinks).toHaveLength(2)
    expect(srcLinks[0].rate).toBeCloseTo(0.7, 5)
  })

  it('最大ボトルネックは最大離脱率のステップ（最終を除く）', () => {
    // drop率: step0=0.4, step1=0.75, step2=0.8(=1500→300) が最大。step3 は最終で除外。
    expect(data.totals.biggestBottleneck?.stepIndex).toBe(2)
    expect(data.totals.biggestBottleneck?.dropRate).toBeCloseTo(0.8, 5)
  })

  it('CVR = cvSessions / totalSessions * 100', () => {
    expect(data.totals.cvrPct).toBeCloseTo(3.0, 5)
    expect(data.totals.cvSessions).toBe(300)
    expect(data.totals.cvrDenominator).toBe('all_sessions')
  })
})
