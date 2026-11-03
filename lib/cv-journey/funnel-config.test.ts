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
    // NULL-safe: Nullable 列 (url) が windowFunnel の reached を NULL にしないこと
    expect(c.expr).toContain(`ifNull(url, '')`)
  })

  it('pageview（path 無し）は event_type のみ (NULL-safe)', () => {
    const c = buildStepCondition({ label: 'LP', kind: 'page', match: { type: 'pageview' } }, 0)
    expect(c.supported).toBe(true)
    expect(c.expr).toBe(`ifNull(event_type, '') = 'pageview'`)
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

  it('conversion は conversion_type 単独一致 (event_type を固定しない・NULL-safe)', () => {
    // 実データ契約 (Sprint 4-B): conversion_type は click 行に載る。
    // event_type='conversion' を AND すると構造的に必ず 0 件になる。
    const c = buildStepCondition(
      { label: 'CV', kind: 'conversion', match: { type: 'conversion', conversionType: 'affiliate_rakuten' } },
      2,
    )
    expect(c.expr).toBe(`ifNull(conversion_type, '') = {s2_cv:String}`)
    expect(c.expr).not.toContain('event_type')
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

describe('buildStepCondition — CV定義との和集合解決 (C2)', () => {
  const step: FunnelStep = {
    label: 'CV',
    kind: 'conversion',
    match: { type: 'conversion', conversionType: 'affiliate_rakuten' },
  }

  it('cvDefinitionsByKey に一致する定義があれば和集合述語になる', () => {
    const cvDefinitionsByKey = new Map([
      [
        'affiliate_rakuten',
        { trigger: { kind: 'click' as const, conditions: { hrefHosts: ['rakuten.co.jp'] } } },
      ],
    ])
    const c = buildStepCondition(step, 2, cvDefinitionsByKey)
    expect(c.supported).toBe(true)
    // 定義述語(click) OR 生conversion_type一致、の両方が式に現れる
    expect(c.expr).toContain(`event_type, '') IN ('click', 'rage_click', 'dead_click')`)
    expect(c.expr).toContain(`OR ifNull(conversion_type, '') = {s2_cv_raw:String}`)
    expect(c.params.s2_cv_raw).toBe('affiliate_rakuten')
  })

  it('cvKey に一致する定義が無ければ従来通り生conversion_type単独一致 (完全後方互換)', () => {
    const cvDefinitionsByKey = new Map([
      ['some_other_key', { trigger: { kind: 'custom_event' as const, conversionType: 'x' } }],
    ])
    const c = buildStepCondition(step, 2, cvDefinitionsByKey)
    expect(c.expr).toBe(`ifNull(conversion_type, '') = {s2_cv:String}`)
  })

  it('cvDefinitionsByKey 未指定は従来通り (既存呼び出し元との後方互換)', () => {
    const c = buildStepCondition(step, 2)
    expect(c.expr).toBe(`ifNull(conversion_type, '') = {s2_cv:String}`)
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
