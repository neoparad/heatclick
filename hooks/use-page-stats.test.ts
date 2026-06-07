/**
 * Unit tests: pageStatsToLabels (PageStatsState → HeatmapToolbar labels)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap controls compact Phase 2 (B 改修)
 */

import { pageStatsToLabels, type PageStatsState } from './use-page-stats'

describe('pageStatsToLabels', () => {
  it('returns empty when loading', () => {
    expect(pageStatsToLabels({ kind: 'loading' })).toEqual({})
  })

  it('returns empty when error', () => {
    expect(pageStatsToLabels({ kind: 'error', message: 'x' })).toEqual({})
  })

  it('returns empty when page_views = 0 (no data)', () => {
    const state: PageStatsState = {
      kind: 'ready',
      data: {
        page_views: 0,
        sessions: 0,
        ctr: null,
        scroll_path_rate: null,
        evidence_level: 'observed_exact',
      },
    }
    expect(pageStatsToLabels(state)).toEqual({})
  })

  it('formats PV / CTR / 到達率 with 1 decimal % and locale string', () => {
    const state: PageStatsState = {
      kind: 'ready',
      data: {
        page_views: 6210,
        sessions: 2841,
        ctr: 0.265,
        scroll_path_rate: 0.482,
        evidence_level: 'observed_exact',
      },
    }
    expect(pageStatsToLabels(state)).toEqual({
      pvLabel: '6,210',
      ctrLabel: '26.5%',
      scrollLabel: '48.2%',
    })
  })

  it('omits CTR/scroll when null (some tenants do not emit scroll events)', () => {
    const state: PageStatsState = {
      kind: 'ready',
      data: {
        page_views: 100,
        sessions: 50,
        ctr: null,
        scroll_path_rate: null,
        evidence_level: 'observed_approx',
      },
    }
    expect(pageStatsToLabels(state)).toEqual({
      pvLabel: '100',
      ctrLabel: undefined,
      scrollLabel: undefined,
    })
  })

  it('CTR present but scroll null', () => {
    const state: PageStatsState = {
      kind: 'ready',
      data: {
        page_views: 1000,
        sessions: 500,
        ctr: 0.123,
        scroll_path_rate: null,
        evidence_level: 'observed_exact',
      },
    }
    expect(pageStatsToLabels(state)).toEqual({
      pvLabel: '1,000',
      ctrLabel: '12.3%',
      scrollLabel: undefined,
    })
  })
})
