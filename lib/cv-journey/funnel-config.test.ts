/**
 * funnel-config のユニットテスト。
 * セキュリティ不変条件（値はリテラル連結でなく param 束縛）と allowlist 挙動を固定する。
 */

import {
  buildStepCondition,
  funnelConfigSchema,
  DEFAULT_FUNNEL,
  type FunnelStep,
} from './funnel-config'

describe('DEFAULT_FUNNEL', () => {
  it('schema に適合する', () => {
    expect(() => funnelConfigSchema.parse(DEFAULT_FUNNEL)).not.toThrow()
  })

  it('全ステップが MVP 対応（pageview / conversion のみ）', () => {
    DEFAULT_FUNNEL.steps.forEach((step, i) => {
      expect(buildStepCondition(step, i).supported).toBe(true)
    })
  })
})

describe('buildStepCondition — allowlist & injection guard', () => {
  it('pageview + pathContains は値を param 束縛し、式に裸のリテラルを含めない', () => {
    const step: FunnelStep = {
      label: '商品',
      kind: 'page',
      match: { type: 'pageview', pathContains: "/p/'; DROP TABLE" },
    }
    const c = buildStepCondition(step, 1)
    expect(c.supported).toBe(true)
    expect(c.expr).toContain('{s1_path:String}')
    // 危険なリテラルが式に直接埋め込まれていないこと
    expect(c.expr).not.toContain('DROP TABLE')
    expect(c.params.s1_path).toBe("/p/'; DROP TABLE")
  })

  it('pageview（path 無し）は event_type のみ', () => {
    const c = buildStepCondition({ label: 'LP', kind: 'page', match: { type: 'pageview' } }, 0)
    expect(c.supported).toBe(true)
    expect(c.expr).toBe(`event_type = 'pageview'`)
    expect(Object.keys(c.params)).toHaveLength(0)
  })

  it('conversion は conversionType を param 束縛する', () => {
    const c = buildStepCondition(
      { label: '購入', kind: 'conversion', match: { type: 'conversion', conversionType: 'purchase' } },
      3,
    )
    expect(c.supported).toBe(true)
    expect(c.expr).toContain('{s3_cv:String}')
    expect(c.params.s3_cv).toBe('purchase')
  })

  it('conversion で conversionType 欠如は未対応', () => {
    const c = buildStepCondition({ label: 'x', kind: 'action', match: { type: 'conversion' } }, 2)
    expect(c.supported).toBe(false)
    expect(c.reason).toMatch(/conversionType/)
  })

  it('click/selector は MVP 未対応（Phase 1.5）', () => {
    const c = buildStepCondition(
      { label: 'cta', kind: 'action', match: { type: 'click', selector: '.cta' } },
      1,
    )
    expect(c.supported).toBe(false)
    expect(c.reason).toMatch(/未対応/)
  })
})

describe('funnelConfigSchema', () => {
  it('ステップ 2 未満は拒否', () => {
    expect(() => funnelConfigSchema.parse({ steps: [DEFAULT_FUNNEL.steps[0]] })).toThrow()
  })

  it('windowSec 既定は 1800', () => {
    const parsed = funnelConfigSchema.parse({ steps: DEFAULT_FUNNEL.steps })
    expect(parsed.windowSec).toBe(1_800)
  })
})
