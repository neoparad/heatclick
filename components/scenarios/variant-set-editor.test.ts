/**
 * variant-set-editor.test.ts — helper utilities (Phase 2.1、2026-06-07)
 *
 * UI レンダリングは Playwright e2e で別途、本ファイルでは validate/factory のみ。
 */

import {
  makeDefaultVariant,
  makeInitialVariants,
  validateVariantsForSubmit,
} from './variant-set-editor'
import { VariantsSchema, type Variant } from '@/lib/scenarios/types'

describe('makeInitialVariants', () => {
  it('returns single A variant with traffic_split=100', () => {
    const v = makeInitialVariants()
    expect(v).toHaveLength(1)
    expect(v[0].id).toBe('A')
    expect(v[0].traffic_split).toBe(100)
  })

  it('default is image variant with https placeholder', () => {
    const [v] = makeInitialVariants()
    expect(v.content_type).toBe('image')
    if (v.content_type === 'image') {
      expect(v.image_url.startsWith('https://')).toBe(true)
    }
  })
})

describe('makeDefaultVariant', () => {
  it('makes B/C variants with given split', () => {
    const b = makeDefaultVariant('B', 33)
    expect(b.id).toBe('B')
    expect(b.traffic_split).toBe(33)
    expect(b.content_type).toBe('image')
    expect(b.position).toBe('center')
  })
})

describe('validateVariantsForSubmit', () => {
  function imgVariant(id: 'A' | 'B' | 'C', traffic_split: number, image_url = 'https://cdn.example.com/x.png'): Variant {
    return {
      id,
      content_type: 'image',
      image_url,
      image_alt: 'alt',
      position: 'center',
      traffic_split,
    } as Variant
  }
  function htmlVariant(id: 'A' | 'B' | 'C', traffic_split: number, html = '<div>x</div>'): Variant {
    return {
      id,
      content_type: 'html',
      html,
      position: 'center',
      traffic_split,
    } as Variant
  }

  it('accepts valid single A variant', () => {
    expect(validateVariantsForSubmit([imgVariant('A', 100)])).toEqual([])
  })

  it('accepts valid A+B with sum=100', () => {
    expect(validateVariantsForSubmit([imgVariant('A', 50), imgVariant('B', 50)])).toEqual([])
  })

  it('rejects sum != 100', () => {
    const errs = validateVariantsForSubmit([imgVariant('A', 60), imgVariant('B', 30)])
    expect(errs.some((e) => e.includes('100'))).toBe(true)
  })

  it('rejects placeholder image_url (https:// only)', () => {
    const errs = validateVariantsForSubmit([imgVariant('A', 100, 'https://')])
    expect(errs.some((e) => e.includes('画像 URL'))).toBe(true)
  })

  it('rejects non-https image_url', () => {
    const errs = validateVariantsForSubmit([imgVariant('A', 100, 'http://insecure.example.com/x.png')])
    expect(errs.some((e) => e.includes('https'))).toBe(true)
  })

  it('rejects empty HTML', () => {
    const errs = validateVariantsForSubmit([htmlVariant('A', 100, '   ')])
    expect(errs.some((e) => e.includes('HTML'))).toBe(true)
  })

  it('rejects duplicate variant ids', () => {
    const errs = validateVariantsForSubmit([imgVariant('A', 50), imgVariant('A', 50)])
    expect(errs.some((e) => e.includes('重複'))).toBe(true)
  })

  it('rejects > 3 variants', () => {
    const errs = validateVariantsForSubmit([
      imgVariant('A', 25),
      imgVariant('B', 25),
      imgVariant('C', 25),
      { ...imgVariant('A', 25), id: 'D' as never },
    ] as Variant[])
    expect(errs.some((e) => e.includes('1〜3'))).toBe(true)
  })
})

describe('variants schema integration', () => {
  it('initial single variant passes Zod schema (when image_url is valid)', () => {
    const initial = makeInitialVariants().map((v) =>
      v.content_type === 'image' ? { ...v, image_url: 'https://cdn.example.com/x.png' } : v,
    )
    expect(VariantsSchema.safeParse(initial).success).toBe(true)
  })

  it('initial placeholder fails Zod (server boundary catches client UI mistake)', () => {
    const initial = makeInitialVariants()
    // 'https://' は SafeHttpsUrlSchema を通らない
    expect(VariantsSchema.safeParse(initial).success).toBe(false)
  })
})
