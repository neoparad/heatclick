/**
 * variant-set-editor.test.ts — helper utilities (Phase 2.1、2026-06-07)
 *
 * UI レンダリングは Playwright e2e で別途、本ファイルでは validate/factory のみ。
 */

import {
  addVariantToSet,
  makeDefaultVariant,
  makeInitialVariants,
  removeVariantFromSet,
  switchVariantType,
  validateVariantsForSubmit,
} from './variant-set-editor'
import { VariantsSchema, type Variant } from '@/lib/scenarios/types'

function sum(variants: Variant[]): number {
  return variants.reduce((s, v) => s + v.traffic_split, 0)
}

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

describe('addVariantToSet (F)', () => {
  it('A → A+B rebalanced to 50/50 (sum stays 100)', () => {
    const v = addVariantToSet(makeInitialVariants())
    expect(v.map((x) => x.id)).toEqual(['A', 'B'])
    expect(v.map((x) => x.traffic_split)).toEqual([50, 50])
    expect(sum(v)).toBe(100)
  })

  it('A+B → A+B+C rebalanced (34/33/33, sum 100, remainder to first)', () => {
    const v = addVariantToSet(addVariantToSet(makeInitialVariants()))
    expect(v.map((x) => x.id)).toEqual(['A', 'B', 'C'])
    expect(sum(v)).toBe(100)
    expect(v[0].traffic_split).toBe(34)
  })

  it('is a no-op at 3 variants', () => {
    const three = addVariantToSet(addVariantToSet(makeInitialVariants()))
    expect(addVariantToSet(three)).toHaveLength(3)
  })

  it('reuses the lowest unused id (B) after a middle removal', () => {
    const abc = addVariantToSet(addVariantToSet(makeInitialVariants()))
    const ac = removeVariantFromSet(abc, 'B')
    const re = addVariantToSet(ac)
    expect(re.map((x) => x.id).sort()).toEqual(['A', 'B', 'C'])
    expect(sum(re)).toBe(100)
  })
})

describe('removeVariantFromSet (F)', () => {
  it('removes B and rebalances remainder to 100', () => {
    const abc = addVariantToSet(addVariantToSet(makeInitialVariants()))
    const ac = removeVariantFromSet(abc, 'B')
    expect(ac.map((x) => x.id)).toEqual(['A', 'C'])
    expect(sum(ac)).toBe(100)
  })

  it('keeps at least one variant (no-op on a single set)', () => {
    expect(removeVariantFromSet(makeInitialVariants(), 'A')).toHaveLength(1)
  })
})

describe('switchVariantType (F)', () => {
  it('image → html fills html and drops image fields', () => {
    const [img] = makeInitialVariants()
    const html = switchVariantType(img, 'html')
    expect(html.content_type).toBe('html')
    if (html.content_type === 'html') expect(html.html.length).toBeGreaterThan(0)
    expect('image_url' in html).toBe(false)
  })

  it('html → image fills https:// placeholder and drops html', () => {
    const html = switchVariantType(makeDefaultVariant('A', 100), 'html')
    const img = switchVariantType(html, 'image')
    expect(img.content_type).toBe('image')
    if (img.content_type === 'image') expect(img.image_url).toBe('https://')
    expect('html' in img).toBe(false)
  })

  it('preserves id / position / traffic_split / cta_url across switch', () => {
    const base = {
      ...makeDefaultVariant('B', 40),
      position: 'bottom-right',
      cta_url: 'https://x.example/y',
    } as Variant
    const html = switchVariantType(base, 'html')
    expect(html.id).toBe('B')
    expect(html.position).toBe('bottom-right')
    expect(html.traffic_split).toBe(40)
    expect(html.cta_url).toBe('https://x.example/y')
  })

  it('is a no-op when the type is unchanged', () => {
    const [img] = makeInitialVariants()
    expect(switchVariantType(img, 'image')).toBe(img)
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
