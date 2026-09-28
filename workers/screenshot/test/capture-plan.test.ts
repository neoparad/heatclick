/**
 * Unit tests: workers/screenshot/src/capture-plan.ts (実ファイルを直接 import、jest = `npm test` で実行)
 *
 * 背景 (2026-09-29): SP の背景画像が粗い問題への対処として、軽い SP ページは 2x でも撮る。
 * - 2x は「面積」と「一辺の寸法 (Chrome の 16K px 級の制限)」の両方が予算内のときだけ。
 * - 2x の撮影が失敗・時間切れでも、先に確保した 1x を返す (withSharpUpgrade)。
 */
import {
  MAX_CAPTURE_AREA_PX,
  MAX_SHARP_AREA_PX,
  MAX_SHARP_DIMENSION_PX,
  buildCaptureHeaders,
  canCaptureSharp,
  capForDsf,
  isSharpEligible,
  isSharpRecaptureConsistent,
  sharpBudgetMs,
  withSharpUpgrade,
} from '../src/capture-plan'

describe('capForDsf (area cap at the dsf actually used)', () => {
  it('dsf=1 is exactly the pre-existing logic: capHeight = min(fullHeight, floor(26M / width))', () => {
    expect(capForDsf({ width: 1280, dsf: 1, fullHeight: 4_000 })).toEqual({ capHeight: 4_000, capped: false })
    expect(capForDsf({ width: 1280, dsf: 1, fullHeight: 50_000 })).toEqual({
      capHeight: Math.floor(26_000_000 / 1280),
      capped: true,
    })
    expect(capForDsf({ width: 390, dsf: 1, fullHeight: 100_000 })).toEqual({
      capHeight: Math.floor(26_000_000 / 390),
      capped: true,
    })
  })

  it('shrinks the CSS cap by dsf^2 when the image is really 2x', () => {
    expect(capForDsf({ width: 390, dsf: 2, fullHeight: 100_000 }).capHeight).toBe(
      Math.floor(26_000_000 / (390 * 4)),
    )
  })

  it('non-finite / non-positive fullHeight gives capHeight 0 and not capped, never NaN', () => {
    for (const fullHeight of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const r = capForDsf({ width: 390, dsf: 1, fullHeight })
      expect(r).toEqual({ capHeight: 0, capped: false })
    }
  })
})

describe('canCaptureSharp (2x budget: area AND dimension)', () => {
  it('constants: the sharp area budget is stricter than the overall cap', () => {
    expect(MAX_CAPTURE_AREA_PX).toBe(26_000_000)
    expect(MAX_SHARP_AREA_PX).toBeLessThan(MAX_CAPTURE_AREA_PX)
    expect(MAX_SHARP_DIMENSION_PX).toBeLessThan(16_384)
  })

  it('light SP page is eligible', () => {
    expect(canCaptureSharp({ width: 390, dsf: 2, fullHeight: 5_000 })).toBe(true)
  })

  it('area boundary: exactly 16M px is eligible, one CSS px more is not (dimension is not the limiter here)', () => {
    // 1000 * 4000 * 2^2 = 16,000,000
    expect(canCaptureSharp({ width: 1000, dsf: 2, fullHeight: 4_000 })).toBe(true)
    expect(canCaptureSharp({ width: 1000, dsf: 2, fullHeight: 4_001 })).toBe(false)
  })

  it('height-dimension boundary: 8,000 CSS px at 2x (= 16,000 px) is eligible, 8,001 is not (area is not the limiter)', () => {
    // 390 * 8000 * 4 = 12.48M < 16M
    expect(canCaptureSharp({ width: 390, dsf: 2, fullHeight: 8_000 })).toBe(true)
    expect(canCaptureSharp({ width: 390, dsf: 2, fullHeight: 8_001 })).toBe(false)
  })

  it('width-dimension boundary: an overflowing page wider than 8,000 CSS px is not eligible at 2x', () => {
    expect(canCaptureSharp({ width: 8_000, dsf: 2, fullHeight: 100 })).toBe(true)
    expect(canCaptureSharp({ width: 8_001, dsf: 2, fullHeight: 100 })).toBe(false)
  })

  it('a horizontally overflowing page slips past the area budget only if width is the viewport width', () => {
    // viewport 幅 390 なら 390*7000*4 = 10.9M で通るが、実際の画像幅 1200 で見ると 1200*7000*4 = 33.6M で予算外
    expect(canCaptureSharp({ width: 390, dsf: 2, fullHeight: 7_000 })).toBe(true)
    expect(canCaptureSharp({ width: 1200, dsf: 2, fullHeight: 7_000 })).toBe(false)
  })

  it('dsf <= 1 is never sharp', () => {
    expect(canCaptureSharp({ width: 390, dsf: 1, fullHeight: 2_000 })).toBe(false)
    expect(canCaptureSharp({ width: 390, dsf: 0.5, fullHeight: 2_000 })).toBe(false)
  })

  it('non-finite / non-positive inputs are not eligible', () => {
    for (const fullHeight of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(canCaptureSharp({ width: 390, dsf: 2, fullHeight })).toBe(false)
    }
    expect(canCaptureSharp({ width: 0, dsf: 2, fullHeight: 1_000 })).toBe(false)
    expect(canCaptureSharp({ width: Number.NaN, dsf: 2, fullHeight: 1_000 })).toBe(false)
  })

  it('invariant: an eligible 2x shot is never clipped and stays within both budgets', () => {
    for (const width of [320, 390, 820, 1280, 3840]) {
      for (const fullHeight of [1, 500, 3_000, 5_000, 8_000, 10_000, 20_000, 50_000]) {
        for (const dsf of [1.5, 2, 3, 4]) {
          if (!canCaptureSharp({ width, dsf, fullHeight })) continue
          expect(capForDsf({ width, dsf, fullHeight }).capped).toBe(false)
          expect(width * dsf).toBeLessThanOrEqual(MAX_SHARP_DIMENSION_PX)
          expect(fullHeight * dsf).toBeLessThanOrEqual(MAX_SHARP_DIMENSION_PX)
          expect(width * fullHeight * dsf * dsf).toBeLessThanOrEqual(MAX_SHARP_AREA_PX)
        }
      }
    }
  })
})

describe('withSharpUpgrade (1x in hand, try 2x, fall back to 1x)', () => {
  const BASE = { name: '1x' }
  const SHARP = { name: '2x' }
  const plenty = () => 30_000

  it('not eligible: returns base and never tries 2x', async () => {
    const trySharp = jest.fn(async () => SHARP)
    const r = await withSharpUpgrade({ base: BASE, eligible: false, remainingMs: plenty, minBudgetMs: 1_000, trySharp })
    expect(r).toBe(BASE)
    expect(trySharp).not.toHaveBeenCalled()
  })

  it('not enough time left: returns base and never tries 2x', async () => {
    const trySharp = jest.fn(async () => SHARP)
    const r = await withSharpUpgrade({ base: BASE, eligible: true, remainingMs: () => 5_000, minBudgetMs: 20_000, trySharp })
    expect(r).toBe(BASE)
    expect(trySharp).not.toHaveBeenCalled()
  })

  it('eligible and 2x succeeds: returns the 2x shot', async () => {
    const r = await withSharpUpgrade({
      base: BASE,
      eligible: true,
      remainingMs: plenty,
      minBudgetMs: 1_000,
      trySharp: async () => SHARP,
    })
    expect(r).toBe(SHARP)
  })

  it('2x decides not to capture (null, e.g. the reloaded page is over budget): returns base', async () => {
    const r = await withSharpUpgrade({
      base: BASE,
      eligible: true,
      remainingMs: plenty,
      minBudgetMs: 1_000,
      trySharp: async () => null,
    })
    expect(r).toBe(BASE)
  })

  it('2x throws (e.g. Chrome screenshot failure): returns base and reports the error once', async () => {
    const onError = jest.fn()
    const boom = new Error('Unable to capture screenshot')
    const r = await withSharpUpgrade({
      base: BASE,
      eligible: true,
      remainingMs: plenty,
      minBudgetMs: 1_000,
      trySharp: async () => {
        throw boom
      },
      onError,
    })
    expect(r).toBe(BASE)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('2x throws synchronously: still returns base', async () => {
    const r = await withSharpUpgrade({
      base: BASE,
      eligible: true,
      remainingMs: plenty,
      minBudgetMs: 1_000,
      trySharp: () => {
        throw new Error('sync boom')
      },
    })
    expect(r).toBe(BASE)
  })

  it('a failure that arrives after the deadline is not reported a second time', async () => {
    const onError = jest.fn()
    const r = await withSharpUpgrade({
      base: BASE,
      eligible: true,
      remainingMs: () => 40,
      minBudgetMs: 10,
      trySharp: () =>
        new Promise<typeof SHARP>((_resolve, reject) => setTimeout(() => reject(new Error('Target closed')), 150)),
      onError,
    })
    expect(r).toBe(BASE)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(onError).toHaveBeenCalledTimes(1) // 時間切れの 1 回だけ
  })

  it('2x is slower than the remaining budget: returns base at the deadline and ignores the late result', async () => {
    const started = Date.now()
    const r = await withSharpUpgrade({
      base: BASE,
      eligible: true,
      remainingMs: () => 60,
      minBudgetMs: 10,
      trySharp: () => new Promise<typeof SHARP>((resolve) => setTimeout(() => resolve(SHARP), 400)),
    })
    expect(r).toBe(BASE)
    expect(Date.now() - started).toBeLessThan(300)
  })
})

describe('isSharpEligible (preferred hint + budget)', () => {
  const light = { baseDsf: 1, width: 390, scrollWidth: 390, fullHeight: 5_000 }

  it('eligible: SP prefers 2x on a light page', () => {
    expect(isSharpEligible({ ...light, preferredDsf: 2 })).toBe(true)
  })

  it('not eligible when the caller did not ask (PC / TAB, or an old app)', () => {
    expect(isSharpEligible({ ...light, preferredDsf: undefined })).toBe(false)
  })

  it('not eligible when the preferred scale is not meaningfully above the base (no pointless reload)', () => {
    expect(isSharpEligible({ ...light, preferredDsf: 1 })).toBe(false)
    expect(isSharpEligible({ ...light, preferredDsf: 0.5 })).toBe(false)
    expect(isSharpEligible({ ...light, preferredDsf: 1.0000001 })).toBe(false)
    expect(isSharpEligible({ ...light, preferredDsf: 1.5 })).toBe(true)
  })

  it('uses max(viewport width, scrollWidth) for the budget: a horizontally overflowing page is not eligible', () => {
    expect(isSharpEligible({ ...light, fullHeight: 7_000, preferredDsf: 2 })).toBe(true)
    expect(isSharpEligible({ ...light, fullHeight: 7_000, scrollWidth: 1_200, preferredDsf: 2 })).toBe(false)
  })

  it('a tall SP page is not eligible', () => {
    expect(isSharpEligible({ ...light, fullHeight: 12_000, preferredDsf: 2 })).toBe(false)
  })
})

describe('sharpBudgetMs (time available for the 2x re-capture)', () => {
  const base = { startedAt: 1_000, totalTimeoutMs: 55_000, safetyMs: 8_000, maxAttemptMs: 25_000 }

  it('early in the request the per-attempt cap is the limiter', () => {
    expect(sharpBudgetMs({ ...base, now: 1_000 + 10_000 })).toBe(25_000)
  })

  it('late in the request the global deadline minus the safety margin is the limiter', () => {
    // deadline = 1_000 + 55_000 - 8_000 = 48_000
    expect(sharpBudgetMs({ ...base, now: 1_000 + 40_000 })).toBe(7_000)
  })

  it('goes negative once past the deadline (callers treat < minBudget as "do not try")', () => {
    expect(sharpBudgetMs({ ...base, now: 1_000 + 50_000 })).toBeLessThan(0)
  })
})

describe('isSharpRecaptureConsistent (do not let an error page / other variant replace a good 1x)', () => {
  it('accepts heights within 0.8x - 1.25x of the 1x height (inclusive)', () => {
    expect(isSharpRecaptureConsistent(5_000, 5_000)).toBe(true)
    expect(isSharpRecaptureConsistent(5_000, 4_000)).toBe(true)
    expect(isSharpRecaptureConsistent(4_000, 5_000)).toBe(true)
  })

  it('rejects heights outside the band', () => {
    expect(isSharpRecaptureConsistent(5_000, 3_999)).toBe(false)
    expect(isSharpRecaptureConsistent(4_000, 5_001)).toBe(false)
    expect(isSharpRecaptureConsistent(5_000, 600)).toBe(false) // 例: エラーページ
    expect(isSharpRecaptureConsistent(5_000, 20_000)).toBe(false)
  })

  it('rejects non-positive / non-finite heights', () => {
    for (const v of [0, -1, Number.NaN]) {
      expect(isSharpRecaptureConsistent(v, 5_000)).toBe(false)
      expect(isSharpRecaptureConsistent(5_000, v)).toBe(false)
    }
  })
})

describe('buildCaptureHeaders', () => {
  it('1x, not clipped', () => {
    expect(buildCaptureHeaders({ capped: false, capHeight: 5_000, fullHeight: 5_000, dsf: 1 })).toEqual({
      'content-type': 'image/jpeg',
      'x-capture-capped': '0',
      'x-capture-full-height': '5000',
      'x-capture-height': '5000',
      'x-capture-dsf': '1',
    })
  })

  it('1x, clipped: capped=1 and the true full height is reported (app truncation guard input)', () => {
    const h = buildCaptureHeaders({ capped: true, capHeight: 20_312, fullHeight: 52_000, dsf: 1 })
    expect(h['x-capture-capped']).toBe('1')
    expect(h['x-capture-full-height']).toBe('52000')
    expect(h['x-capture-height']).toBe('20312')
  })

  it('2x sharp shot: capped=0, height in CSS px, dsf=2', () => {
    const h = buildCaptureHeaders({ capped: false, capHeight: 7_000, fullHeight: 7_000, dsf: 2 })
    expect(h['x-capture-capped']).toBe('0')
    expect(h['x-capture-height']).toBe('7000')
    expect(h['x-capture-dsf']).toBe('2')
  })
})
