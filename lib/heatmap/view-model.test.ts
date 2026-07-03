/**
 * Unit tests: buildHeatmapViewModel
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap real-data rendering Phase 1
 *   (handoff: `2026-05-29-frontend-heatmap-real-data-rendering.md`)
 *
 * Phase 1 期待挙動:
 *   - dummy_lcg / meta=null → MOCKUP_VIEW_MODEL (mockup parity)
 *   - clickhouse_events で 1 点以上 → real cluster (mockup の emotion / attention /
 *     signal / endBand / exitRow / hotspotCard / signalCard は drop)
 *   - clickhouse_events で 0 点 → empty view-model (fixture には戻らない)
 *   - forceFixture=true → 常に MOCKUP_VIEW_MODEL
 */

import type { HeatmapTile, HeatmapTileMeta } from '@/lib/api/heatmap'
import type { HeatmapElementsData } from '@/lib/api/heatmap-elements'
import { MOCKUP_VIEW_MODEL } from '@/lib/fixtures/heatmap-mockup'
import { MOCK_PAGE_HEIGHT, PAGE_WIDTH } from '@/lib/heatmap/mockup-spec'
import { buildHeatmapViewModel } from './view-model'

function metaWith(
  source: 'dummy_lcg' | 'clickhouse_events',
  pageHeight = 30_000,
): HeatmapTileMeta {
  return {
    tile_size: 2400,
    page_height_estimate: pageHeight,
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
  describe('dummy / fixture modes', () => {
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

    it('returns mockup fixture when data_source is undefined (legacy meta — Codex review HIGH regression)', () => {
      // legacy deploy / 旧 client が meta.data_source を返さないケース。
      // HeatmapCanvas は undefined を dummy 扱いで banner 表示する (lib/api/heatmap.ts コメント参照)。
      // view-model も undefined を real 扱いせず fixture parity に倒す。
      const legacyMeta: HeatmapTileMeta = {
        tile_size: 2400,
        page_height_estimate: 30_000,
        cached: false,
        cache_ttl_sec: 0,
        query_hash: 'test',
      }
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 100, y: 200, count: 9999, sessions: 1 }])],
        meta: legacyMeta,
      })
      expect(vm).toBe(MOCKUP_VIEW_MODEL)
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
  })

  describe('real mode (clickhouse_events)', () => {
    it('returns empty view-model (not fixture) when no points are present', () => {
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([])],
        meta: metaWith('clickhouse_events'),
      })
      expect(vm).not.toBe(MOCKUP_VIEW_MODEL)
      expect(vm.blobs).toEqual([])
      expect(vm.tags).toEqual([])
      expect(vm.signals).toEqual([])
      expect(vm.endBands).toEqual([])
      expect(vm.exitRows).toEqual([])
      expect(vm.readBands).toEqual([])
      expect(vm.scrollReachBands).toEqual([])
      expect(vm.hotspotCards).toEqual([])
      expect(vm.signalCards).toEqual([])
      expect(vm.emotionSummary).toEqual({
        hes: 0,
        eng: 0,
        cmp: 0,
        frust: 0,
        anx: 0,
        conf: 0,
      })
    })

    it('uses real clusters even with sparse data (1-5 clicks) — no fixture fallback (RED → GREEN)', () => {
      // TIRTIR-style sparse minimal fixture: 3 distinct clicks
      const vm = buildHeatmapViewModel({
        tiles: [
          tileWith([
            { x: 283, y: 2049, count: 5, sessions: 3 },
            { x: 540, y: 8200, count: 4, sessions: 2 },
            { x: 120, y: 15_500, count: 2, sessions: 1 },
          ]),
        ],
        meta: metaWith('clickhouse_events'),
      })
      expect(vm).not.toBe(MOCKUP_VIEW_MODEL)
      // real cluster は 1-3 (label は MAX_HOTSPOTS=6 枠)、必ず 1 つ以上
      expect(vm.tags.length).toBeGreaterThanOrEqual(1)
      expect(vm.tags.length).toBeLessThanOrEqual(6)
      // tag label には `クリック密集 #` が含まれ、`hotspot-` 文字列は一切出ない (DoD)
      for (const t of vm.tags) {
        expect(t.label).toMatch(/^クリック密集 #\d+$/)
        expect(t.label).not.toMatch(/hotspot/)
      }
      // hotspotCards も real 由来、selector が「DOM selector 未取得」
      for (const card of vm.hotspotCards) {
        expect(card.id).toMatch(/^real-hs-/)
        expect(card.selector).toBe('DOM selector 未取得')
        expect(card.emotionPercents).toEqual([])
      }
    })

    it('drops mockup emotion/attention/signal/endBand/exitRow when real data present (DoD)', () => {
      const tiles: HeatmapTile[] = [
        tileWith(
          Array.from({ length: 248 }, (_, i) => ({
            x: 100 + (i % 11) * 100,
            y: 1500 + (i % 30) * 1200,
            count: 1 + (i % 8),
            sessions: 1 + (i % 5),
          })),
        ),
      ]
      const vm = buildHeatmapViewModel({ tiles, meta: metaWith('clickhouse_events') })
      // mockup の演出を一切混ぜない
      const attentionBlobs = vm.blobs.filter((b) => b.mode === 'attention')
      const emotionBlobs = vm.blobs.filter((b) => b.mode === 'emotion')
      expect(attentionBlobs).toEqual([])
      expect(emotionBlobs).toEqual([])
      expect(vm.signals).toEqual([])
      expect(vm.endBands).toEqual([])
      expect(vm.exitRows).toEqual([])
      expect(vm.signalCards).toEqual([])
      // emotionSummary は 0 distribution
      expect(vm.emotionSummary.hes).toBe(0)
      expect(vm.emotionSummary.eng).toBe(0)
      // click blob は density field (cluster 数、続137 で MAX_DENSITY_BLOBS 60→110 に引上げ)
      const clickBlobs = vm.blobs.filter((b) => b.mode === 'click')
      expect(clickBlobs.length).toBeGreaterThanOrEqual(1)
      expect(clickBlobs.length).toBeLessThanOrEqual(110)
      // label tag は MAX_HOTSPOTS=6 上限、blob より少ない
      expect(vm.tags.length).toBeLessThanOrEqual(6)
      expect(vm.tags.length).toBeLessThanOrEqual(clickBlobs.length)
      // tags rank は 1 始まりの連番
      expect(vm.tags.map((t) => t.rank)).toEqual(
        Array.from({ length: vm.tags.length }, (_, i) => i + 1),
      )
    })
  })

  describe('coordinate scaling (golden — handoff §4 Step 12)', () => {
    // x scale: x / SOURCE_WIDTH(1280) * PAGE_WIDTH(720)
    //   283 → (283/1280)*720 = 159.19 → 159px (tag 中心は -28 offset で 131)
    // y scale: y / page_height_estimate(30000) * MOCK_PAGE_HEIGHT(860)
    //   2049 → (2049/30000)*860 = 58.74 → 59px (tag 中心は -28 offset で 31)
    it('x=283 maps to ~159px (tag x = 159 - 28 = 131)', () => {
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 283, y: 2049, count: 10, sessions: 5 }])],
        meta: metaWith('clickhouse_events'),
      })
      expect(vm.tags.length).toBe(1)
      const t = vm.tags[0]
      // 159 - 28 = 131, ±2px golden tolerance
      expect(t.x).toBeGreaterThanOrEqual(129)
      expect(t.x).toBeLessThanOrEqual(133)
    })

    it('y=2049 maps to ~59px (tag y = 59 - 28 = 31)', () => {
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 283, y: 2049, count: 10, sessions: 5 }])],
        meta: metaWith('clickhouse_events'),
      })
      const t = vm.tags[0]
      expect(t.y).toBeGreaterThanOrEqual(29)
      expect(t.y).toBeLessThanOrEqual(33)
    })

    it('PAGE_WIDTH/MOCK_PAGE_HEIGHT constants are stable (regression guard)', () => {
      expect(PAGE_WIDTH).toBe(720)
      expect(MOCK_PAGE_HEIGHT).toBe(860)
    })
  })

  describe('click layer — readBands/scrollReachBands are empty (no cross-contamination)', () => {
    it('click mode returns empty readBands and scrollReachBands', () => {
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 200, y: 1000, count: 5, sessions: 3 }])],
        meta: metaWith('clickhouse_events'),
      })
      expect(vm.readBands).toEqual([])
      expect(vm.scrollReachBands).toEqual([])
    })
  })

  // ── Layer → heatmap_type mapping (plumbing correctness) ────────────────
  describe('layer→heatmap_type mapping', () => {
    it('read layer (heatmap_type=read) returns readBands, not blobs', () => {
      const readMeta = {
        ...metaWith('clickhouse_events'),
        heatmap_type: 'read' as const,
      }
      // read_area events: x=0, y=read_y (200px bin)
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([
          { x: 0, y: 200, count: 50, sessions: 30 },
          { x: 0, y: 400, count: 20, sessions: 15 },
          { x: 0, y: 600, count: 80, sessions: 60 },
        ])],
        meta: readMeta,
      })
      expect(vm.blobs).toEqual([])
      expect(vm.tags).toEqual([])
      expect(vm.readBands.length).toBeGreaterThanOrEqual(1)
      expect(vm.scrollReachBands).toEqual([])
      expect(vm.exitRows).toEqual([])
      // intensity should be normalized [0,1]
      for (const b of vm.readBands) {
        expect(b.intensity).toBeGreaterThanOrEqual(0)
        expect(b.intensity).toBeLessThanOrEqual(1)
        expect(b.sessions).toBeGreaterThan(0)
        expect(b.count).toBeGreaterThan(0)
      }
    })

    it('scroll layer (heatmap_type=scroll) returns scrollReachBands, not blobs', () => {
      const scrollMeta = {
        ...metaWith('clickhouse_events'),
        heatmap_type: 'scroll' as const,
      }
      // scroll reach: per-session max_scroll bins
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([
          { x: 0, y: 0,    count: 100, sessions: 100 },
          { x: 0, y: 200,  count: 90,  sessions: 90 },
          { x: 0, y: 1000, count: 40,  sessions: 40 },
        ])],
        meta: scrollMeta,
      })
      expect(vm.blobs).toEqual([])
      expect(vm.tags).toEqual([])
      expect(vm.readBands).toEqual([])
      expect(vm.scrollReachBands.length).toBeGreaterThanOrEqual(1)
      expect(vm.exitRows).toEqual([])
      // reach should be [0,1]
      for (const b of vm.scrollReachBands) {
        expect(b.reach).toBeGreaterThan(0)
        expect(b.reach).toBeLessThanOrEqual(1)
        expect(typeof b.reachLabel).toBe('string')
        expect(b.reachLabel).toMatch(/\d+%/)
      }
    })

    it('exit layer (heatmap_type=exit) returns exitRows, not blobs', () => {
      const exitMeta = {
        ...metaWith('clickhouse_events'),
        heatmap_type: 'exit' as const,
      }
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([
          { x: 0, y: 200,  count: 10, sessions: 10 },
          { x: 0, y: 1000, count: 30, sessions: 30 },
          { x: 0, y: 3000, count: 5,  sessions: 5  },
        ])],
        meta: exitMeta,
      })
      expect(vm.blobs).toEqual([])
      expect(vm.tags).toEqual([])
      expect(vm.readBands).toEqual([])
      expect(vm.scrollReachBands).toEqual([])
      expect(vm.exitRows.length).toBeGreaterThanOrEqual(1)
      for (const row of vm.exitRows) {
        expect(row.exitPct).toMatch(/\d+%/)
        expect(['hi', 'mid', 'lo', 'ok']).toContain(row.level)
      }
    })

    it('read layer returns empty view-model when tiles have no points', () => {
      const readMeta = { ...metaWith('clickhouse_events'), heatmap_type: 'read' as const }
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([])],
        meta: readMeta,
      })
      expect(vm.readBands).toEqual([])
      expect(vm.blobs).toEqual([])
    })

    it('scroll layer: reach is proportional — shallow band has higher reach than deep band', () => {
      const scrollMeta = { ...metaWith('clickhouse_events'), heatmap_type: 'scroll' as const }
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([
          { x: 0, y: 0,    count: 100, sessions: 100 },
          { x: 0, y: 2000, count: 20,  sessions: 20  },
        ])],
        meta: scrollMeta,
      })
      const sorted = [...vm.scrollReachBands].sort((a, b) => a.top - b.top)
      if (sorted.length >= 2) {
        // shallower band should have >= reach than deeper band
        expect(sorted[0].reach).toBeGreaterThanOrEqual(sorted[sorted.length - 1].reach)
      }
    })
  })

  // ── Phase 2 (screenshot underlay) ─────────────────────────────────────
  describe('coordinateContext (Phase 2 screenshot underlay, y 圧縮廃止)', () => {
    it('maps x with referenceWidth/sourceWidth and uses raw y (no MOCK_PAGE_HEIGHT compression)', () => {
      // SP: referenceWidth=390、y は click_y そのまま (圧縮なし)
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 640, y: 1500, count: 10, sessions: 5 }])],
        meta: metaWith('clickhouse_events'),
        coordinateContext: {
          sourceWidth: 1280,
          referenceWidth: 390,
          pageHeight: 8000,
        },
      })
      expect(vm.tags.length).toBe(1)
      const t = vm.tags[0]
      // x = 640/1280 * 390 = 195、tag offset -28 → 167
      expect(t.x).toBeGreaterThanOrEqual(165)
      expect(t.x).toBeLessThanOrEqual(170)
      // y = 1500 (圧縮なし、Phase 1 では 1500/30000 * 860 = 43 だった)、tag offset -28 → 1472
      expect(t.y).toBeGreaterThanOrEqual(1470)
      expect(t.y).toBeLessThanOrEqual(1474)
    })

    it('filters points beyond pageHeight*1.05 outlier guard', () => {
      const vm = buildHeatmapViewModel({
        tiles: [
          tileWith([
            { x: 100, y: 100, count: 5, sessions: 3 },
            { x: 200, y: 1_000_000, count: 99, sessions: 50 }, // huge outlier
          ]),
        ],
        meta: metaWith('clickhouse_events'),
        coordinateContext: {
          sourceWidth: 1280,
          referenceWidth: 720,
          pageHeight: 5000,
        },
      })
      // outlier 1 件捨てられ (5000*1.05=5250 超)、cluster 1 件のみ
      expect(vm.tags.length).toBe(1)
    })

    it('PC capture (referenceWidth=1280) → x 等倍', () => {
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 1280, y: 200, count: 10, sessions: 5 }])],
        meta: metaWith('clickhouse_events'),
        coordinateContext: {
          sourceWidth: 1280,
          referenceWidth: 1280,
          pageHeight: 4000,
        },
      })
      const t = vm.tags[0]
      // x = 1280/1280 * 1280 = 1280、tag offset -28 → 1252
      expect(t.x).toBeGreaterThanOrEqual(1250)
      expect(t.x).toBeLessThanOrEqual(1254)
    })

    it('続128: blob/tag 座標は ctx.pageHeight に依存しない (provisional→real で動かない不変条件)', () => {
      // 暫定座標系 (pageHeight=66000、outlier guard generous) と 実 capture (pageHeight=8000) で
      // referenceWidth が同じなら tag の x/y は完全一致する。= screenshot 差し替え時に blob が動かない。
      const tiles = [tileWith([{ x: 640, y: 3200, count: 10, sessions: 5 }])]
      const meta = metaWith('clickhouse_events')
      const provisional = buildHeatmapViewModel({
        tiles,
        meta,
        coordinateContext: { sourceWidth: 1280, referenceWidth: 1280, pageHeight: 66_000 },
      })
      const real = buildHeatmapViewModel({
        tiles,
        meta,
        coordinateContext: { sourceWidth: 1280, referenceWidth: 1280, pageHeight: 8_000 },
      })
      expect(provisional.tags).toHaveLength(1)
      expect(real.tags).toHaveLength(1)
      // x も y も完全一致 (pageHeight は座標に効かない、outlier guard と容器高さのみ)
      expect(provisional.tags[0].x).toBe(real.tags[0].x)
      expect(provisional.tags[0].y).toBe(real.tags[0].y)
    })

    it('Phase 1 path (no coordinateContext) still uses MOCK_PAGE_HEIGHT compression', () => {
      // Phase 1 backward compat: context 未指定なら旧 scale で動く
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 283, y: 2049, count: 10, sessions: 5 }])],
        meta: metaWith('clickhouse_events'),
      })
      const t = vm.tags[0]
      // y = 2049/30000 * 860 = 58.7、tag offset -28 → 31
      expect(t.y).toBeGreaterThanOrEqual(29)
      expect(t.y).toBeLessThanOrEqual(33)
    })
  })

  // ── 続123: element-level (本物のホットスポット / シグナル) ───────────────
  describe('element-level hotspots / signals (続123)', () => {
    const elementsData: HeatmapElementsData = {
      page_sessions: 870,
      elements: [
        {
          selector: '#bihadashop-toc-container>div>nav>ul>li:nth-child(2)>a',
          text: '【カバー力比較】カバー力が高いのはどれ？長いテキストは省略される想定の文章です',
          tag: 'a',
          href: '/entry/x',
          clicks: 91,
          sessions: 87,
          x: 640,
          y: 2404,
        },
        {
          selector: '#nocopy>div>label',
          text: '',
          tag: 'label',
          href: '',
          clicks: 50,
          sessions: 40,
          x: 320,
          y: 600,
        },
      ],
      signals: [
        {
          type: 'dead',
          count: 561,
          sessions: 333,
          top: [{ selector: '#dead-zone', text: '反応しない領域', count: 200, x: 100, y: 500 }],
        },
        { type: 'rage', count: 0, sessions: 0, top: [] },
      ],
      images: [
        {
          src: 'https://bihadashop.jp/wp-content/uploads/2025/03/hero.jpg',
          alt: 'TIRTIR ヒーロー画像',
          sessions: 575,
          views: 767,
          avg_ratio: 0.97,
          median_ms: 4200,
          y: 2400,
          w: 710,
          h: 532,
        },
      ],
      issues: [
        {
          category: 'a11y',
          type: 'image-alt-missing',
          severity: 'high',
          count: 3,
          recommendation: 'alt 属性を追加してください。',
        },
      ],
    }
    const clickTiles = [tileWith([{ x: 100, y: 200, count: 10, sessions: 5 }])]

    it('uses real element names + selectors for hotspot cards and tags', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
      })
      expect(vm.hotspotCards[0].selector).toBe(
        '#bihadashop-toc-container>div>nav>ul>li:nth-child(2)>a',
      )
      expect(vm.hotspotCards[0].name).toContain('カバー力比較')
      // 26 字 + '…' = 27 字以内に省略
      expect(vm.hotspotCards[0].name.length).toBeLessThanOrEqual(27)
      expect(vm.hotspotCards[0].name.endsWith('…')).toBe(true)
      expect(vm.hotspotCards[0].stats[0]).toEqual({ label: 'クリック', value: '91' })
      // canvas 常時ラベル (tag) も要素名 + 実クリック数
      expect(vm.tags[0].label).toContain('カバー力比較')
      expect(vm.tags[0].count).toBe(91)
    })

    it('falls back to tag-type label when element_text is empty', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
      })
      // text 空 + tag=label → 「選択肢 <selector末尾>」
      expect(vm.hotspotCards[1].name.startsWith('選択肢')).toBe(true)
    })

    it('builds real signal cards + markers, skipping zero-count types', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
      })
      // rage は count=0 → card/marker を出さない
      expect(vm.signalCards).toHaveLength(1)
      expect(vm.signalCards[0]).toMatchObject({ type: 'dead', count: 561 })
      expect(vm.signalCards[0].whereLabel).toContain('反応しない領域')
      expect(vm.signals).toHaveLength(1)
      expect(vm.signals[0]).toMatchObject({ type: 'dead', count: 200 })
    })

    it('falls back to cluster placeholder cards when elements is null', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: null,
      })
      expect(vm.hotspotCards[0].selector).toBe('DOM selector 未取得')
      expect(vm.signalCards).toHaveLength(0)
    })

    it('attaches signal cards AND hotspot cards to non-click layers too (read)', () => {
      const readMeta: HeatmapTileMeta = {
        ...metaWith('clickhouse_events'),
        heatmap_type: 'read',
      }
      const vm = buildHeatmapViewModel({
        tiles: [tileWith([{ x: 0, y: 200, count: 5, sessions: 5 }])],
        meta: readMeta,
        elements: elementsData,
      })
      expect(vm.signalCards).toHaveLength(1)
      // 続124 ⑨: 右パネルは layer 非依存 — read 層でも要素カードが出る
      expect(vm.hotspotCards.length).toBeGreaterThan(0)
      expect(vm.hotspotCards[0].name).toContain('カバー力比較')
      expect(vm.readBands.length).toBeGreaterThan(0)
    })

    it('marks dead-clicked elements as negative spots (warn intent + デッド stat)', () => {
      const data: HeatmapElementsData = {
        page_sessions: 100,
        elements: [
          {
            selector: '#cta-cart',
            text: 'カートに追加',
            tag: 'button',
            href: '',
            clicks: 30,
            sessions: 25,
            x: 640,
            y: 700,
          },
        ],
        signals: [
          {
            type: 'dead',
            count: 12,
            sessions: 10,
            top: [{ selector: '#cta-cart', text: 'カートに追加', count: 12, x: 640, y: 700 }],
          },
        ],
        images: [],
        issues: [],
      }
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: data,
      })
      expect(vm.hotspotCards[0].intent).toBe('warn')
      expect(
        vm.hotspotCards[0].stats.some((s) => s.label === 'デッド' && s.tone === 'neg'),
      ).toBe(true)
      expect(vm.tags[0].intent).toBe('warn')
    })

    it('builds negativeSpots ranking from dead/rage tops (続125 ③)', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
      })
      expect(vm.negativeSpots.length).toBeGreaterThan(0)
      expect(vm.negativeSpots[0]).toMatchObject({ type: 'dead', count: 200 })
      expect(vm.negativeSpots[0].name).toContain('反応しない領域')
      // 回数降順
      const counts = vm.negativeSpots.map((s) => s.count)
      expect([...counts].sort((a, b) => b - a)).toEqual(counts)
    })

    it('adds click-rate stat from page_sessions (続126 ★ ボタンクリック率)', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
      })
      // 87 sessions / 870 page sessions = 10%
      const rateStat = vm.hotspotCards[0].stats.find((s) => s.label === 'クリック率')
      expect(rateStat).toBeDefined()
      expect(rateStat?.value).toBe('10%')
    })

    it('builds imageSpots with view rate from image_visibility (続126 ⑤)', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
        coordinateContext: { sourceWidth: 1280, referenceWidth: 720, pageHeight: 14_000 },
      })
      expect(vm.imageSpots).toHaveLength(1)
      const spot = vm.imageSpots[0]
      expect(spot.name).toContain('TIRTIR')
      // 575/870 ≈ 66%
      expect(Math.round(spot.viewRate * 100)).toBe(66)
      expect(spot.y).toBe(2400) // ctx あり = raw px
      expect(spot.height).toBe(532)
      expect(spot.medianSec).toBe(4)
    })

    it('passes crawl issues through to pageIssues (続126 ★ 構造タブ)', () => {
      const vm = buildHeatmapViewModel({
        tiles: clickTiles,
        meta: metaWith('clickhouse_events'),
        elements: elementsData,
      })
      expect(vm.pageIssues).toHaveLength(1)
      expect(vm.pageIssues[0]).toMatchObject({ type: 'image-alt-missing', severity: 'high' })
    })

    it('exit layer emits continuous 0..95% slots (続125 ② — cannot visually cut off)', () => {
      const exitMeta: HeatmapTileMeta = {
        ...metaWith('clickhouse_events'),
        heatmap_type: 'exit',
      }
      // 観測は 2 スロットのみ (10% と 90%) — それでも全 20 スロットが出る
      const vm = buildHeatmapViewModel({
        tiles: [
          tileWith([
            { x: 0, y: 10, count: 5, sessions: 5 },
            { x: 0, y: 90, count: 3, sessions: 3 },
          ]),
        ],
        meta: exitMeta,
        coordinateContext: { sourceWidth: 1280, referenceWidth: 720, pageHeight: 10_000 },
      })
      expect(vm.exitRows).toHaveLength(20)
      // 最初のスロットは 0px、最後のスロットは 95% 位置 = 9500px
      expect(vm.exitRows[0].top).toBe(0)
      expect(vm.exitRows[19].top).toBe(9500)
      // 観測ありスロットは dropoff > 0、なしは 0
      expect(vm.exitRows.filter((r) => (r.dropoff ?? 0) > 0)).toHaveLength(2)
    })
  })
})
