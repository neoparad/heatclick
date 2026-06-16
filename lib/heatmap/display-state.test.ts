/**
 * display-state resolver tests
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-30 続 117 v3 frontend heatmap empty-state
 */

import {
  resolveHeatmapDisplayState,
  isRealEmptyHeatmap,
  type HeatmapDisplayStateInput,
} from '@/lib/heatmap/display-state'

function base(overrides: Partial<HeatmapDisplayStateInput> = {}): HeatmapDisplayStateInput {
  return {
    dataSource: 'clickhouse_events',
    blobCount: 0,
    tagCount: 0,
    tileCount: 5,
    loading: false,
    error: null,
    ...overrides,
  }
}

describe('resolveHeatmapDisplayState', () => {
  it('error が最優先 (loading / data に関わらず error)', () => {
    expect(resolveHeatmapDisplayState(base({ error: 'boom', loading: true, tileCount: 0 }))).toBe(
      'error',
    )
    expect(resolveHeatmapDisplayState(base({ error: 'boom', blobCount: 9 }))).toBe('error')
  })

  it('初回 (tile 0 枚) + loading は loading', () => {
    expect(resolveHeatmapDisplayState(base({ loading: true, tileCount: 0 }))).toBe('loading')
  })

  it('tile が既にあり追加 loading 中は loading にしない (real cluster ありなら has-data)', () => {
    expect(
      resolveHeatmapDisplayState(base({ loading: true, tileCount: 3, blobCount: 4 })),
    ).toBe('has-data')
  })

  it('実 query 成功 + 0 hotspot + loading 完了 → real-empty', () => {
    expect(resolveHeatmapDisplayState(base())).toBe('real-empty')
  })

  it('実 query 成功 + blob あり → has-data', () => {
    expect(resolveHeatmapDisplayState(base({ blobCount: 12 }))).toBe('has-data')
  })

  it('実 query 成功 + tag あり (blob 0) → has-data', () => {
    expect(resolveHeatmapDisplayState(base({ tagCount: 3 }))).toBe('has-data')
  })

  it('real-empty 判定中でも loading 継続中なら real-empty にしない', () => {
    // eager prefetch が途中 (loading=true) かつ tile が来始めている場合は data 確定前なので空表示しない
    expect(resolveHeatmapDisplayState(base({ loading: true, tileCount: 2 }))).toBe('has-data')
  })

  it('dummy_lcg は 0 件でも real-empty にしない (fixture parity を出すため has-data)', () => {
    expect(resolveHeatmapDisplayState(base({ dataSource: 'dummy_lcg' }))).toBe('has-data')
  })

  it('legacy meta (data_source undefined) は real-empty にしない', () => {
    expect(resolveHeatmapDisplayState(base({ dataSource: undefined }))).toBe('has-data')
  })
})

describe('isRealEmptyHeatmap', () => {
  it('real-empty のときだけ true', () => {
    expect(isRealEmptyHeatmap(base())).toBe(true)
    expect(isRealEmptyHeatmap(base({ blobCount: 1 }))).toBe(false)
    expect(isRealEmptyHeatmap(base({ dataSource: 'dummy_lcg' }))).toBe(false)
    expect(isRealEmptyHeatmap(base({ error: 'x' }))).toBe(false)
    expect(isRealEmptyHeatmap(base({ loading: true, tileCount: 0 }))).toBe(false)
  })
})
