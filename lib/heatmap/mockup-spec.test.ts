/**
 * Unit tests: mockup-spec gradient / color helpers
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 12
 */

import {
  DEVICES,
  EMOTIONS,
  END_BAND_BG,
  EXIT_ROW_BG,
  LAYERS,
  SIDE_TABS,
  SIGNALS,
  blobGradient,
} from './mockup-spec'

describe('mockup-spec', () => {
  it('exposes 6 layer keys (続121: dead "end" toggle removed)', () => {
    expect(LAYERS.map((l) => l.key)).toEqual([
      'click',
      'attention',
      'scroll',
      'exit',
      'move',
      'emo',
    ])
  })

  it('marks move and emo layers as disabled (データ未収集 / ML未実装)', () => {
    const disabledKeys = LAYERS.filter((l) => l.disabled).map((l) => l.key)
    expect(disabledKeys).toContain('move')
    expect(disabledKeys).toContain('emo')
  })

  it('data layers (click/attention/scroll/exit) exist and are not disabled', () => {
    const dataKeys = ['click', 'attention', 'scroll', 'exit']
    for (const key of dataKeys) {
      const layer = LAYERS.find((l) => l.key === key)
      expect(layer).toBeDefined()
      expect(layer?.disabled).toBeFalsy()
    }
  })

  it('exposes 6 emotion keys matching the mockup', () => {
    expect(EMOTIONS.map((e) => e.key)).toEqual(['frust', 'hes', 'cmp', 'eng', 'conf', 'anx'])
  })

  it('exposes 6 signal keys matching the mockup', () => {
    expect(SIGNALS.map((s) => s.key)).toEqual([
      'rage',
      'dead',
      'hover',
      'copy',
      'backscroll',
      'hesitation',
    ])
  })

  it('exposes 4 side tabs', () => {
    expect(SIDE_TABS.map((t) => t.key)).toEqual(['hotspots', 'signals', 'summary', 'sessions'])
  })

  it('marks 3 signals as UGOKY-only (mockup `UGOKY ONLY` badges)', () => {
    const uniques = SIGNALS.filter((s) => s.unique).map((s) => s.key)
    expect(uniques).toEqual(['hover', 'copy', 'hesitation'])
  })

  describe('blobGradient', () => {
    it('returns strong gradient for click + strong', () => {
      const g = blobGradient({ mode: 'click', severity: 'strong' })
      expect(g).toContain('rgba(79,107,255,.85)')
      expect(g).toContain('rgba(168,85,247,.45)')
    })

    it('returns normal gradient for click default', () => {
      const g = blobGradient({ mode: 'click' })
      expect(g).toContain('rgba(79,107,255,.65)')
    })

    it('returns warm gradient for attention + strong', () => {
      const g = blobGradient({ mode: 'attention', severity: 'strong' })
      expect(g).toContain('rgba(214,69,69,.85)')
    })

    it('returns frustration red for emotion=frust', () => {
      const g = blobGradient({ mode: 'emotion', emotion: 'frust' })
      expect(g).toContain('rgba(214,69,69,.7)')
    })

    it('returns hesitation amber for emotion=hes', () => {
      const g = blobGradient({ mode: 'emotion', emotion: 'hes' })
      expect(g).toContain('rgba(201,145,26,.7)')
    })
  })

  it('END_BAND_BG b1 is dominant red (100% reached)', () => {
    expect(END_BAND_BG.b1).toContain('214,69,69')
  })

  it('EXIT_ROW_BG hi is red, ok is green', () => {
    expect(EXIT_ROW_BG.hi).toContain('214,69,69')
    expect(EXIT_ROW_BG.ok).toContain('57,161,105')
  })

  it('DEVICES contain PC/SP/TAB with fullscreen max widths', () => {
    const map = Object.fromEntries(DEVICES.map((d) => [d.key, d.fsMaxWidth]))
    expect(map.pc).toBe(1320)
    expect(map.sp).toBe(390)
    expect(map.tab).toBe(820)
  })
})
