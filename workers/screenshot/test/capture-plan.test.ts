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
  canCaptureSharp,
  capForDsf,
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
    // viewport 390 だけで見ると 390*9000*4 = 14.0M で通るが、実際の画像幅 1200 で見ると 1200*9000*4 = 43.2M
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
