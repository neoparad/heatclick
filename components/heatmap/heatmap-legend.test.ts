/**
 * HeatmapLegend.legendSpecFor — 純関数の層→凡例マッピング regression (node env)
 */
import type { LayerKey } from '@/lib/heatmap/types'

import { legendSpecFor } from './heatmap-legend'

describe('legendSpecFor', () => {
  const cases: Array<{ layer: LayerKey; caption: string }> = [
    { layer: 'click', caption: 'クリック密度' },
    { layer: 'attention', caption: '熟読の強さ' },
    { layer: 'scroll', caption: 'スクロール到達' },
    { layer: 'exit', caption: '離脱の集中' },
    { layer: 'end', caption: '終了の集中' },
  ]

  it.each(cases)('data layer $layer → caption "$caption"', ({ layer, caption }) => {
    const spec = legendSpecFor(new Set<LayerKey>([layer]))
    expect(spec).not.toBeNull()
    expect(spec?.caption).toBe(caption)
    expect(spec?.gradient).toContain('linear-gradient')
    expect(spec?.lowLabel).toBeTruthy()
    expect(spec?.highLabel).toBeTruthy()
  })

  it('空集合は null (凡例なし)', () => {
    expect(legendSpecFor(new Set<LayerKey>())).toBeNull()
  })

  it('disabled 層 (move / emo) のみは null', () => {
    expect(legendSpecFor(new Set<LayerKey>(['move', 'emo']))).toBeNull()
  })

  it('複数 active 時は優先順 (click > attention)', () => {
    const spec = legendSpecFor(new Set<LayerKey>(['attention', 'click']))
    expect(spec?.caption).toBe('クリック密度')
  })
})
