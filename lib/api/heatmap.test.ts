/**
 * Unit tests: layerToHeatmapType mapping
 *
 * Verifies that every HeatmapLayer maps to the correct heatmap_type value
 * so the API client always sends the right query parameter.
 */

import { layerToHeatmapType } from './heatmap'
import type { HeatmapLayer } from './heatmap'

describe('layerToHeatmapType', () => {
  const cases: Array<{ layer: HeatmapLayer; expected: string }> = [
    { layer: 'click',   expected: 'click'  },
    { layer: 'read',    expected: 'read'   },
    { layer: 'scroll',  expected: 'scroll' },
    { layer: 'exit',    expected: 'exit'   },
    // Disabled / unimplemented layers fall back to click (not fabricated data)
    { layer: 'move',    expected: 'click'  },
    { layer: 'emotion', expected: 'click'  },
    { layer: 'friction', expected: 'click' },
  ]

  for (const { layer, expected } of cases) {
    it(`layer='${layer}' → heatmap_type='${expected}'`, () => {
      expect(layerToHeatmapType(layer)).toBe(expected)
    })
  }

  it('data layers map to their own event_type (not aliased to click)', () => {
    expect(layerToHeatmapType('read')).not.toBe('click')
    expect(layerToHeatmapType('scroll')).not.toBe('click')
    expect(layerToHeatmapType('exit')).not.toBe('click')
  })
})
