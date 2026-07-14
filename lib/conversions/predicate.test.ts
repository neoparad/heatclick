/**
 * Unit tests: lib/conversions/predicate.ts + types.ts (C1-a)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §3 / §9
 * 検証の柱:
 *   - SQL断片の正当性 (query_params 束縛・リテラル値を式に含めない)
 *   - NULL-safe (全カラム参照が ifNull で包まれる)
 *   - click は event_type 3種 (dead_click 再分類の取りこぼし防止 — レビューHIGH)
 *   - custom_event は event_type を固定しない (paths Sprint 4-B の罠)
 *   - 未対応/不正条件は supported:false へ降格 (数値を捏造しない)
 *   - cvKey 解決は和集合 (定義述語 OR 生 conversion_type)
 */

import { buildCvPredicate, buildCvKeyResolutionPredicate } from './predicate'
import {
  clickConditionsSchema,
  createCvDefinitionBodySchema,
  cvTriggerSchema,
  normalizeCvHost,
} from './types'
import type { CvTrigger } from './types'

/** 式がパラメータ参照のみで、生のユーザー入力値を含まないことの検証ヘルパ */
function expectNoLiteralLeak(expr: string, values: string[]): void {
  for (const value of values) {
    expect(expr).not.toContain(value)
  }
}

describe('buildCvPredicate', () => {
  describe('page_reach', () => {
    it('exact: pageview+virtual_pageview IN と正規化pathname完全一致', () => {
      const p = buildCvPredicate(
        { trigger: { kind: 'page_reach', url: { mode: 'exact', path: '/thanks/' } } },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain(`ifNull(event_type, '') IN ('pageview', 'virtual_pageview')`)
      expect(p.expr).toContain('{cv0_url:String}')
      // 末尾スラッシュ除去の正規化契約 (paths url-match 共有)
      expect(p.params).toEqual({ cv0_url: '/thanks' })
    })

    it('prefix: パス自身 OR "/"境界付き配下 (誤前方一致の防止)', () => {
      const p = buildCvPredicate(
        { trigger: { kind: 'page_reach', url: { mode: 'prefix', path: '/products' } } },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain('= {cv0_url:String}')
      expect(p.expr).toContain('startsWith(')
      expect(p.expr).toContain('{cv0_url_p:String}')
      expect(p.params).toEqual({ cv0_url: '/products', cv0_url_p: '/products/' })
    })

    it('contains: 生url部分一致 (cv-journey position互換)', () => {
      const p = buildCvPredicate(
        { trigger: { kind: 'page_reach', url: { mode: 'contains', value: '/campaign' } } },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain(`position(ifNull(url, ''), {cv0_url:String}) > 0`)
      expect(p.params).toEqual({ cv0_url: '/campaign' })
    })

    it('正規化不能なパスは supported:false に降格 (捏造しない)', () => {
      const p = buildCvPredicate(
        { trigger: { kind: 'page_reach', url: { mode: 'exact', path: 'javascript:alert(1)' } } },
        'cv0',
      )
      expect(p.supported).toBe(false)
      expect(p.expr).toBe('')
      expect(p.params).toEqual({})
    })
  })

  describe('click', () => {
    it('event_type は3種IN (dead_click再分類の取りこぼし防止)', () => {
      const p = buildCvPredicate(
        {
          trigger: {
            kind: 'click',
            conditions: { hrefHosts: ['rakuten.co.jp'] },
          },
        },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain(`ifNull(event_type, '') IN ('click', 'rage_click', 'dead_click')`)
    })

    it('hrefHosts: suffix一致 (サブドメイン許容) + フィールド内OR', () => {
      const p = buildCvPredicate(
        {
          trigger: {
            kind: 'click',
            conditions: { hrefHosts: ['rakuten.co.jp', 'a.r10.to'] },
          },
        },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain(`lower(domain(ifNull(element_href, ''))) = {cv0_h0:String}`)
      expect(p.expr).toContain(`endsWith(lower(domain(ifNull(element_href, ''))), concat('.', {cv0_h0:String}))`)
      expect(p.expr).toContain('{cv0_h1:String}')
      expect(p.expr).toContain(' OR ')
      expect(p.params).toEqual({ cv0_h0: 'rakuten.co.jp', cv0_h1: 'a.r10.to' })
    })

    it('hrefHosts: 大文字・先頭ドットは正規化される', () => {
      const p = buildCvPredicate(
        {
          trigger: { kind: 'click', conditions: { hrefHosts: ['.Rakuten.CO.JP'] } },
        },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.params.cv0_h0).toBe('rakuten.co.jp')
    })

    it('不正ホストは supported:false に降格', () => {
      const p = buildCvPredicate(
        {
          trigger: { kind: 'click', conditions: { hrefHosts: ["evil' OR 1=1"] } },
        },
        'cv0',
      )
      expect(p.supported).toBe(false)
    })

    it('全条件AND: id/class/selector/text/hrefContains/pageUrl が連結される', () => {
      const p = buildCvPredicate(
        {
          trigger: {
            kind: 'click',
            conditions: {
              hrefContains: 'tel:03',
              elementId: 'buy-button',
              elementClassContains: 'cta',
              selector: '#buy-button',
              textContains: '購入する',
              pageUrl: { mode: 'prefix', path: '/products' },
            },
          },
        },
        'cv1',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain(`position(ifNull(element_href, ''), {cv1_hc:String}) > 0`)
      expect(p.expr).toContain(`ifNull(element_id, '') = {cv1_id:String}`)
      expect(p.expr).toContain(`position(ifNull(element_class_name, ''), {cv1_cls:String}) > 0`)
      expect(p.expr).toContain(`ifNull(element_selector, '') = {cv1_sel:String}`)
      expect(p.expr).toContain(`position(ifNull(element_text, ''), {cv1_txt:String}) > 0`)
      expect(p.expr).toContain('{cv1_pg:String}')
      expect(p.params).toMatchObject({
        cv1_hc: 'tel:03',
        cv1_id: 'buy-button',
        cv1_cls: 'cta',
        cv1_sel: '#buy-button',
        cv1_txt: '購入する',
        cv1_pg: '/products',
        cv1_pg_p: '/products/',
      })
      // 条件は全て AND 連結
      const andCount = (p.expr.match(/ AND /g) ?? []).length
      expect(andCount).toBeGreaterThanOrEqual(6)
    })

    it('条件ゼロは supported:false (schema でも弾くが述語側でも防衛)', () => {
      const p = buildCvPredicate(
        { trigger: { kind: 'click', conditions: {} as never } },
        'cv0',
      )
      expect(p.supported).toBe(false)
    })
  })

  describe('custom_event', () => {
    it('conversion_type 単独一致で event_type を固定しない (Sprint 4-B の罠の集約点)', () => {
      const p = buildCvPredicate(
        { trigger: { kind: 'custom_event', conversionType: 'affiliate_rakuten' } },
        'cv2',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toBe(`ifNull(conversion_type, '') = {cv2_cv:String}`)
      expect(p.expr).not.toContain('event_type')
      expect(p.params).toEqual({ cv2_cv: 'affiliate_rakuten' })
    })
  })

  describe('scope', () => {
    it('UTM/デバイスが追加ANDされる', () => {
      const p = buildCvPredicate(
        {
          trigger: { kind: 'custom_event', conversionType: 'purchase' },
          scope: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'summer', deviceType: 'mobile' },
        },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expect(p.expr).toContain(`ifNull(utm_source, '') = {cv0_us:String}`)
      expect(p.expr).toContain(`ifNull(utm_medium, '') = {cv0_um:String}`)
      expect(p.expr).toContain(`ifNull(utm_campaign, '') = {cv0_uc:String}`)
      expect(p.expr).toContain(`ifNull(device_type, '') = {cv0_dev:String}`)
      expect(p.params).toMatchObject({
        cv0_us: 'google',
        cv0_um: 'cpc',
        cv0_uc: 'summer',
        cv0_dev: 'mobile',
      })
    })
  })

  describe('セキュリティ不変条件', () => {
    it('ユーザー入力値が式に直接埋め込まれない (全て params 経由)', () => {
      const malicious = ["'; DROP TABLE events; --", '{injected:String}', 'rakuten.co.jp']
      const p = buildCvPredicate(
        {
          trigger: {
            kind: 'click',
            conditions: {
              hrefContains: malicious[0],
              elementId: malicious[1],
              hrefHosts: [malicious[2]],
            },
          },
        },
        'cv0',
      )
      expect(p.supported).toBe(true)
      expectNoLiteralLeak(p.expr, [malicious[0], malicious[1]])
      // params には元の値が入る (束縛層でエスケープされる)
      expect(p.params.cv0_hc).toBe(malicious[0])
      expect(p.params.cv0_id).toBe(malicious[1])
    })

    it('全カラム参照が ifNull で NULL-safe (windowFunnel 全滅の罠)', () => {
      const p = buildCvPredicate(
        {
          trigger: {
            kind: 'click',
            conditions: {
              hrefHosts: ['rakuten.co.jp'],
              elementId: 'x',
              textContains: 'y',
              pageUrl: { mode: 'exact', path: '/a' },
            },
          },
          scope: { utmSource: 'google' },
        },
        'cv0',
      )
      // 裸のカラム参照が無いこと: 参照カラムは全て ifNull( 直後に現れる
      for (const column of ['element_href', 'element_id', 'element_text', 'utm_source', 'event_type']) {
        const bare = new RegExp(`(?<!ifNull\\()\\b${column}\\b`)
        expect(p.expr).not.toMatch(bare)
      }
    })

    it('不正な paramPrefix は throw', () => {
      expect(() =>
        buildCvPredicate(
          { trigger: { kind: 'custom_event', conversionType: 'x' } },
          'bad-prefix; DROP',
        ),
      ).toThrow()
    })
  })
})

describe('buildCvKeyResolutionPredicate (和集合解決 §2)', () => {
  const clickTrigger: CvTrigger = {
    kind: 'click',
    conditions: { hrefHosts: ['rakuten.co.jp'] },
  }

  it('定義述語 OR 生conversion_type の和集合になる', () => {
    const p = buildCvKeyResolutionPredicate(
      { trigger: clickTrigger, cvKey: 'affiliate_rakuten' },
      'r0',
    )
    expect(p.supported).toBe(true)
    expect(p.expr).toMatch(/^\(\(.+\) OR ifNull\(conversion_type, ''\) = \{r0_raw:String\}\)$/)
    expect(p.params.r0_raw).toBe('affiliate_rakuten')
    expect(p.params.r0_h0).toBe('rakuten.co.jp')
  })

  it('定義述語が unsupported なら生conversion_type 一致に降格 (完全後方互換)', () => {
    const p = buildCvKeyResolutionPredicate(
      {
        trigger: { kind: 'click', conditions: { hrefHosts: ['not a host!!'] } },
        cvKey: 'affiliate_rakuten',
      },
      'r0',
    )
    expect(p.supported).toBe(true)
    expect(p.expr).toBe(`ifNull(conversion_type, '') = {r0_raw:String}`)
    expect(p.reason).toBeTruthy()
  })
})

describe('types.ts schemas', () => {
  it('clickConditionsSchema: 条件ゼロを拒否', () => {
    expect(clickConditionsSchema.safeParse({}).success).toBe(false)
  })

  it('clickConditionsSchema: 7条件以上を拒否', () => {
    const result = clickConditionsSchema.safeParse({
      hrefHosts: ['a.com'],
      hrefContains: 'x',
      hrefPath: { mode: 'exact', path: '/a' },
      elementId: 'x',
      elementClassContains: 'x',
      selector: 'x',
      textContains: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('clickConditionsSchema: 不正ホストを拒否', () => {
    expect(
      clickConditionsSchema.safeParse({ hrefHosts: ["evil' OR 1=1"] }).success,
    ).toBe(false)
  })

  it('cvTriggerSchema: page_reach の正規化不能パスを拒否', () => {
    expect(
      cvTriggerSchema.safeParse({
        kind: 'page_reach',
        url: { mode: 'exact', path: 'not-a-path' },
      }).success,
    ).toBe(false)
  })

  it('createCvDefinitionBodySchema: cvKey slug 検証 + value 既定', () => {
    const ok = createCvDefinitionBodySchema.safeParse({
      name: '楽天アフィリ送客',
      cvKey: 'affiliate_rakuten',
      trigger: { kind: 'click', conditions: { hrefHosts: ['rakuten.co.jp'] } },
    })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.enabled).toBe(true)
      expect(ok.data.value).toEqual({ mode: 'none' })
    }

    expect(
      createCvDefinitionBodySchema.safeParse({
        name: 'x',
        cvKey: 'Bad-Key',
        trigger: { kind: 'custom_event', conversionType: 'x' },
      }).success,
    ).toBe(false)
  })

  it('normalizeCvHost: 正規化と拒否', () => {
    expect(normalizeCvHost('.Rakuten.CO.JP')).toBe('rakuten.co.jp')
    expect(normalizeCvHost('a.r10.to')).toBe('a.r10.to')
    expect(normalizeCvHost('localhost')).toBeNull() // 単一ラベルは拒否
    expect(normalizeCvHost("evil' OR 1=1")).toBeNull()
    expect(normalizeCvHost('')).toBeNull()
  })
})
