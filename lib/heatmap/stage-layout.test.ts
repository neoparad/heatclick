/**
 * Unit tests: computeStageLayout — outer hm-page (720 SSOT) と inner stage (capture px) の scale 計算
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 続 116 frontend heatmap screenshot stage-fix
 */

import { computeStageLayout } from './stage-layout'

describe('computeStageLayout', () => {
  it('1080 capture × 720 display → scale 0.667、outer ≤ 720 SSOT (Critical regression guard)', () => {
    const out = computeStageLayout({
      displayWidth: 720,
      captureNaturalWidth: 1080,
      captureNaturalHeight: 4000,
    })
    // SSOT 720 を破らない
    expect(out.outerWidth).toBe(720)
    expect(out.outerWidth).toBeLessThanOrEqual(720)
    expect(out.scale).toBeCloseTo(0.6667, 3)
    // outer height = 4000 * 0.6667 ≒ 2667
    expect(out.outerHeight).toBeGreaterThanOrEqual(2666)
    expect(out.outerHeight).toBeLessThanOrEqual(2668)
    // inner stage is at capture px
    expect(out.stageWidth).toBe(1080)
    expect(out.stageHeight).toBe(4000)
  })

  it('720 capture × 720 display → scale 1 (PC default、ピクセル等倍)', () => {
    const out = computeStageLayout({
      displayWidth: 720,
      captureNaturalWidth: 720,
      captureNaturalHeight: 3000,
    })
    expect(out.scale).toBe(1)
    expect(out.outerHeight).toBe(3000)
    expect(out.stageWidth).toBe(720)
    expect(out.stageHeight).toBe(3000)
  })

  it('390 capture × 390 display (SP) → scale 1', () => {
    const out = computeStageLayout({
      displayWidth: 390,
      captureNaturalWidth: 390,
      captureNaturalHeight: 5000,
    })
    expect(out.scale).toBe(1)
    expect(out.outerWidth).toBe(390)
    expect(out.outerHeight).toBe(5000)
  })

  it('1320 capture × 720 display (FS PC viewport mismatch) → scale 0.545、outer ≤ 720', () => {
    // FS PC は fsMaxWidth=1320、capture は pc=720。display=1320 でも capture=720 なら scale up=1.83
    // 逆に display=720, capture=1320 (sp ではない wider capture) なら scale down=0.545
    const out = computeStageLayout({
      displayWidth: 720,
      captureNaturalWidth: 1320,
      captureNaturalHeight: 6000,
    })
    expect(out.scale).toBeCloseTo(0.5454, 3)
    expect(out.outerWidth).toBe(720)
    expect(out.outerHeight).toBeGreaterThanOrEqual(3271)
    expect(out.outerHeight).toBeLessThanOrEqual(3273)
  })

  it('extreme tall page (naturalHeight 30000) keeps outer SSOT 720 + scaled height', () => {
    const out = computeStageLayout({
      displayWidth: 720,
      captureNaturalWidth: 1080,
      captureNaturalHeight: 30_000,
    })
    expect(out.outerWidth).toBe(720)
    // 30000 * 0.6667 = 20000
    expect(out.outerHeight).toBeGreaterThanOrEqual(19998)
    expect(out.outerHeight).toBeLessThanOrEqual(20002)
  })

  it('safe fallback when any dimension is 0 or negative', () => {
    expect(computeStageLayout({ displayWidth: 0, captureNaturalWidth: 1080, captureNaturalHeight: 3000 })).toMatchObject({
      scale: 1,
    })
    expect(computeStageLayout({ displayWidth: 720, captureNaturalWidth: 0, captureNaturalHeight: 3000 })).toMatchObject({
      scale: 1,
    })
    expect(
      computeStageLayout({ displayWidth: 720, captureNaturalWidth: -10, captureNaturalHeight: 3000 }),
    ).toMatchObject({ scale: 1 })
  })
})
