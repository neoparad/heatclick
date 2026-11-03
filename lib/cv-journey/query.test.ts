/**
 * query.ts のユニットテスト。
 * - 純関数（stepsFromReached / assembleFunnel）: 進行/離脱率・nodes/links・ボトルネック・CVR。
 * - buildFunnelData (fakeClient): SQL 契約 — sessions 不参照 / events 化 / tenant_id 全束縛 /
 *   is_agent=0 / NULL-safe CV 判定 / source 絞り込みの events first-touch 化。
 */

import type { ClickHouseClient } from '@clickhouse/client'

import { stepsFromReached, assembleFunnel, buildFunnelData } from './query'
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

// ── buildFunnelData の SQL 契約 (fakeClient で発行クエリを捕捉) ─────────────────

interface CapturedQuery {
  query: string
  query_params: Record<string, unknown>
}

function makeFakeClient(capture: CapturedQuery[]): ClickHouseClient {
  return {
    query: async (input: { query: string; query_params: Record<string, unknown> }) => {
      capture.push({ query: input.query, query_params: input.query_params })
      const rows: unknown[] = input.query.includes('windowFunnel')
        ? [{ s1: 100, s2: 60, s3: 20, s4: 5 }]
        : input.query.includes('GROUP BY source_medium')
          ? [
              { source_medium: 'search', sessions: 70 },
              { source_medium: 'direct / none', sessions: 30 },
            ]
          : input.query.includes('uniqExact(session_id)')
            ? [{ total_sessions: 100, cv_sessions: 5 }]
            : [{ rage_clicks: 1, dead_clicks: 2 }]
      return { json: async () => rows }
    },
  } as unknown as ClickHouseClient
}

describe('buildFunnelData — events 化後の SQL 契約', () => {
  async function run(source?: string) {
    const capture: CapturedQuery[] = []
    const result = await buildFunnelData({
      client: makeFakeClient(capture),
      tenantId: 'tenant_x',
      siteId: 'site_x',
      startDate: '2026-07-08',
      endDate: '2026-07-14',
      source,
      config: DEFAULT_FUNNEL,
    })
    return { capture, result }
  }

  it('sessions テーブルをどのクエリも参照しない (writer 未実装で全件空のため)', async () => {
    const { capture } = await run()
    // DEFAULT_FUNNEL 構成では常に 4 本 (reach / sources / totals / friction×1)
    expect(capture.length).toBe(4)
    for (const c of capture) {
      expect(c.query).not.toContain('clickinsight.sessions')
    }
  })

  it('全クエリで tenant_id / site_id を束縛し、is_agent=0 + session_id 非空を適用する', async () => {
    const { capture } = await run()
    for (const c of capture) {
      expect(c.query_params.tenant_id).toBe('tenant_x')
      expect(c.query_params.site_id).toBe('site_x')
      expect(c.query).toContain('is_agent = 0')
      expect(c.query).toContain(`session_id != ''`)
    }
  })

  it('totals は events から NULL-safe に CV セッションを数える', async () => {
    const { capture, result } = await run()
    const totals = capture.find((c) => c.query.includes('uniqExact(session_id)'))
    expect(totals).toBeDefined()
    expect(totals?.query).toContain('FROM clickinsight.events')
    expect(totals?.query).toContain(`uniqExactIf(session_id, ifNull(conversion_type, '') != '')`)
    expect(result.data.totals.totalSessions).toBe(100)
  })

  it('sources は events first-touch 集計を CvSource へ写像する', async () => {
    const { result } = await run()
    expect(result.data.sources).toEqual([
      { key: 'search', label: 'search', sessions: 70 },
      { key: 'direct / none', label: 'direct / none', sessions: 30 },
    ])
  })

  it('source 絞り込みは events first-touch のサブクエリで解決する', async () => {
    const { capture } = await run('search')
    const reach = capture.find((c) => c.query.includes('windowFunnel'))
    expect(reach).toBeDefined()
    expect(reach?.query).toContain('session_id IN')
    expect(reach?.query).toContain('source_medium = {source:String}')
    expect(reach?.query).not.toContain('clickinsight.sessions')
    expect(reach?.query_params.source).toBe('search')
  })

  it('source 絞り込みは totals(CVR分母) と friction にも同じく適用される', async () => {
    // 分子(funnel)だけフィルタされ分母が全体のままだと CVR が崩れる (code-review HIGH)
    const { capture } = await run('search')
    const totals = capture.find((c) => c.query.includes('uniqExact(session_id)'))
    const friction = capture.find((c) => c.query.includes('rage_click'))
    for (const c of [totals, friction]) {
      expect(c).toBeDefined()
      expect(c?.query).toContain('source_medium = {source:String}')
      expect(c?.query_params.source).toBe('search')
    }
  })

  it('中間に非対応ステップがあっても reached とラベルがズレない (supportedSteps 整列)', async () => {
    const capture: CapturedQuery[] = []
    const { data, warnings } = await buildFunnelData({
      client: makeFakeClient(capture),
      tenantId: 'tenant_x',
      siteId: 'site_x',
      config: {
        windowSec: 1_800,
        steps: [
          { label: 'LP', kind: 'page', match: { type: 'pageview' } },
          { label: 'CTA', kind: 'action', match: { type: 'click', selector: '.cta' } }, // 未対応
          { label: 'CV', kind: 'conversion', match: { type: 'conversion', conversionType: 'affiliate_rakuten' } },
        ],
      },
    })
    expect(warnings).toHaveLength(1)
    // 未対応ステップ (CTA) は除外され、reached[1] は 'CV' に対応する
    expect(data.steps.map((s) => s.label)).toEqual(['LP', 'CV'])
  })

  it('pathContains を持つステップの摩擦を取得して step に付与する', async () => {
    const { result } = await run()
    // DEFAULT_FUNNEL step[1] (商品閲覧 /p/) のみ pathContains あり
    expect(result.data.steps[1].friction).toEqual(
      expect.objectContaining({ rageClicks: 1, deadClicks: 2 }),
    )
    expect(result.data.steps[0].friction).toBeUndefined()
  })
})

describe('buildFunnelData — CV定義との和集合解決 (C2)', () => {
  const cvDefinitions = [
    {
      cvKey: 'affiliate_rakuten',
      trigger: { kind: 'click' as const, conditions: { hrefHosts: ['rakuten.co.jp'] } },
    },
  ]

  it('cvDefinitions 指定時、totals の CV判定が定義述語との和集合になる', async () => {
    const capture: CapturedQuery[] = []
    await buildFunnelData({
      client: makeFakeClient(capture),
      tenantId: 'tenant_x',
      siteId: 'site_x',
      config: DEFAULT_FUNNEL,
      cvDefinitions,
    })
    const totals = capture.find((c) => c.query.includes('uniqExact(session_id)'))
    expect(totals).toBeDefined()
    // 定義述語(click) と 生conversion_type非空 の両方がORで含まれる
    expect(totals?.query).toContain(`event_type, '') IN ('click', 'rage_click', 'dead_click')`)
    expect(totals?.query).toContain(`OR ifNull(conversion_type, '') != ''`)
    expect(totals?.query_params.cvt0_h0).toBe('rakuten.co.jp')
  })

  it('conversion ステップの conversionType が cvKey と一致すれば定義述語との和集合になる', async () => {
    const capture: CapturedQuery[] = []
    await buildFunnelData({
      client: makeFakeClient(capture),
      tenantId: 'tenant_x',
      siteId: 'site_x',
      config: {
        windowSec: 1_800,
        steps: [
          { label: 'LP', kind: 'page', match: { type: 'pageview' } },
          {
            label: 'CV',
            kind: 'conversion',
            match: { type: 'conversion', conversionType: 'affiliate_rakuten' },
          },
        ],
      },
      cvDefinitions,
    })
    const reach = capture.find((c) => c.query.includes('windowFunnel'))
    expect(reach).toBeDefined()
    expect(reach?.query).toContain(`event_type, '') IN ('click', 'rage_click', 'dead_click')`)
    expect(reach?.query).toContain('_raw:String')
  })

  it('cvDefinitions 未指定は完全後方互換 (既存テストと同一SQL)', async () => {
    const { capture } = await run()
    const totals = capture.find((c) => c.query.includes('uniqExact(session_id)'))
    expect(totals?.query).toContain(`uniqExactIf(session_id, ifNull(conversion_type, '') != '')`)
  })
})
