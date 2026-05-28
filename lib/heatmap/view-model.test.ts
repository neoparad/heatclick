/**
 * Unit tests: buildHeatmapViewModel
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 12
 */

import type { HeatmapTile, HeatmapTileMeta } from '@/lib/api/heatmap'
import { MOCKUP_VIEW_MODEL } from '@/lib/fixtures/heatmap-mockup'
import { buildHeatmapViewModel } from './view-model'

function metaWith(source: 'dummy_lcg' | 'clickhouse_events'): HeatmapTileMeta {
  return {
    tile_size: 2400,
    page_height_estimate: 30_000,
    cached: false,
    cache_ttl_sec: 0,
    query_hash: 'test',
    data_source: source,
  }
}

function tileWith(points: HeatmapTile['points']): HeatmapTile {
  return { y_start: 0, y_end: 2400, points, truncated: false }
}

describe('buildHeatmapViewModel', () => {
  it('returns mockup fixture when meta is null (initial render)', () => {
    const vm = buildHeatmapViewModel({ tiles: [], meta: null })
    expect(vm).toBe(MOCKUP_VIEW_MODEL)
  })

  it('returns mockup fixture when data_source = dummy_lcg', () => {
    const vm = buildHeatmapViewModel({
      tiles: [tileWith([{ x: 100, y: 200, count: 9999, sessions: 1 }])],
      meta: metaWith('dummy_lcg'),
    })
    expect(vm).toBe(MOCKUP_VIEW_MODEL)
  })

  it('returns mockup fixture when real data has too few points (< 8)', () => {
    const vm = buildHeatmapViewModel({
      tiles: [
        tileWith([
          { x: 100, y: 200, count: 5, sessions: 3 },
          { x: 200, y: 300, count: 6, sessions: 3 },
        ]),
      ],
      meta: metaWith('clickhouse_events'),
    })
    expect(vm).toBe(MOCKUP_VIEW_MODEL)
  })

  it('uses real blobs/tags when clickhouse data is dense, but keeps mockup signals/endBands/exitRows', () => {
    const tiles: HeatmapTile[] = [
      tileWith(
        Array.from({ length: 12 }, (_, i) => ({
          x: 100 + i * 80,
          y: 50 + i * 40,
          count: 50 + i,
          sessions: 20 + i,
        })),
      ),
    ]
    const vm = buildHeatmapViewModel({ tiles, meta: metaWith('clickhouse_events') })
    expect(vm).not.toBe(MOCKUP_VIEW_MODEL)
    // signals / endBands / exitRows / emotionSummary / hotspotCards / signalCards は fixture と同じ
    expect(vm.signals).toBe(MOCKUP_VIEW_MODEL.signals)
    expect(vm.endBands).toBe(MOCKUP_VIEW_MODEL.endBands)
    expect(vm.exitRows).toBe(MOCKUP_VIEW_MODEL.exitRows)
    expect(vm.emotionSummary).toBe(MOCKUP_VIEW_MODEL.emotionSummary)
    expect(vm.hotspotCards).toBe(MOCKUP_VIEW_MODEL.hotspotCards)
    expect(vm.signalCards).toBe(MOCKUP_VIEW_MODEL.signalCards)
    // tags は 5 件 (top-5)
    expect(vm.tags.length).toBe(5)
    // blobs に click mode が含まれ、emotion / attention は mockup のもの (12 件 mockup minus 5 click = 7) が継承
    const clickBlobs = vm.blobs.filter((b) => b.mode === 'click')
    expect(clickBlobs.length).toBe(5)
    const inheritedAttention = vm.blobs.filter((b) => b.mode === 'attention')
    expect(inheritedAttention.length).toBeGreaterThan(0)
  })

  it('forceFixture overrides real data to fixture', () => {
    const tiles: HeatmapTile[] = [
      tileWith(
        Array.from({ length: 12 }, (_, i) => ({
          x: 100 + i * 80,
          y: 50 + i * 40,
          count: 50 + i,
          sessions: 20 + i,
        })),
      ),
    ]
    const vm = buildHeatmapViewModel({
      tiles,
      meta: metaWith('clickhouse_events'),
      forceFixture: true,
    })
    expect(vm).toBe(MOCKUP_VIEW_MODEL)
  })

  it('tags are sorted by descending rank starting at 1', () => {
    const tiles: HeatmapTile[] = [
      tileWith(
        Array.from({ length: 12 }, (_, i) => ({
          x: 100 + i * 80,
          y: 50 + i * 40,
          count: 50 + i,
          sessions: 20 + i,
        })),
      ),
    ]
    const vm = buildHeatmapViewModel({ tiles, meta: metaWith('clickhouse_events') })
    const ranks = vm.tags.map((t) => t.rank)
    expect(ranks).toEqual([1, 2, 3, 4, 5])
  })
})
