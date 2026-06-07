/**
 * E2E: 続 82 Sprint 4 W1 Frontend — heatmap 実 data 表示 + stats bar + segment chips
 *
 * 親 SSOT Part V §5.5.1 P-04 / 続 82 handoff `2026-05-25-frontend-sprint4-w1-heatmap-real-data-stats-bar.md`
 *
 * 検証 (mockup parity Phase 1):
 *   1. data_source='clickhouse_events' を返す mock → Sprint 4 W1 banner が消えている
 *   2. data_source='dummy_lcg' を返す mock → banner が出る (Infra 続 82 deploy 前の表示)
 *   3. PageStatsBar が PV / sessions / CTR を表示
 *   4. SegmentChip (device / period) クリックで /api/heatmap が再 fetch される
 *   5. HotspotRankingsPanel が右側に top-10 hotspot を ranked 表示
 *   6. emotion-chip skeleton が disabled で表示される
 */

import { test, expect, type Page, type Route } from '@playwright/test'

type DataSource = 'dummy_lcg' | 'clickhouse_events'

interface HeatmapMockOptions {
  dataSource: DataSource
  /** call カウンタ (chip クリックで refetch 発生検証用) */
  calls?: Array<{ deviceType: string | null; periodHint: string | null }>
}

interface PageStatsMockOptions {
  pageViews?: number
  sessions?: number
  ctr?: number | null
  scrollPathRate?: number | null
  evidenceLevel?: 'observed_exact' | 'observed_approx'
}

test.describe('P-04 heatmap 続 82 Sprint 4 W1 (real-data + stats bar + chips)', () => {
  test.skip(
    Boolean(process.env.CI) && !process.env.E2E_TEST_TOKEN,
    'requires E2E_TEST_TOKEN to inject auth cookie',
  )

  test.beforeEach(async ({ context }) => {
    if (process.env.E2E_TEST_TOKEN) {
      await context.addCookies([
        {
          name: 'ugokimap_saas_token',
          value: process.env.E2E_TEST_TOKEN,
          url: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
        },
      ])
    }
  })

  test('Sprint 4 W1 banner is hidden when data_source=clickhouse_events', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 6210, sessions: 2841, ctr: 0.265 })

    await page.goto('/heatmap')
    await page.getByTestId('heatmap-canvas').waitFor()

    await expect(page.getByTestId('heatmap-dummy-banner')).toHaveCount(0)
    await expect(page.getByTestId('heatmap-canvas')).toHaveAttribute(
      'data-data-source',
      'clickhouse_events',
    )
  })

  test('Sprint 4 W1 banner is visible when data_source=dummy_lcg', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'dummy_lcg' })
    await mockPageStatsApi(page, {})

    await page.goto('/heatmap')
    await expect(page.getByTestId('heatmap-dummy-banner')).toBeVisible()
    await expect(page.getByTestId('heatmap-dummy-banner')).toContainText('dummy data fallback')
  })

  // 続 115 Phase 2 / B 改修: 段 2 PageStatsBar 撤去、PV/CTR/到達率 は canvas-top に集約。
  // page-stats-bar testid は廃止、`canvas-stat-*` testid を使う。
  test('canvas-top displays PV / CTR / 到達率 from /api/heatmap/page-stats', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, {
      pageViews: 6210,
      sessions: 2841,
      ctr: 0.265,
      scrollPathRate: 0.482,
    })

    await page.goto('/heatmap')
    const toolbar = page.getByTestId('heatmap-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(page.getByTestId('canvas-stat-pv')).toContainText('6,210')
    await expect(page.getByTestId('canvas-stat-ctr')).toContainText('26.5%')
    await expect(page.getByTestId('canvas-stat-scroll')).toContainText('48.2%')
  })

  test('canvas-top hides PV/CTR/到達率 when PV=0 (no spurious metrics)', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 0, sessions: 0, ctr: null, scrollPathRate: null })

    await page.goto('/heatmap')
    await page.getByTestId('heatmap-toolbar').waitFor()
    await expect(page.getByTestId('canvas-stat-pv')).toHaveCount(0)
    await expect(page.getByTestId('canvas-stat-ctr')).toHaveCount(0)
    await expect(page.getByTestId('canvas-stat-scroll')).toHaveCount(0)
  })

  test('SegmentChip (device + period) triggers heatmap refetch', async ({ page }) => {
    const calls: Array<{ deviceType: string | null; periodHint: string | null }> = []
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events', calls })
    await mockPageStatsApi(page, { pageViews: 100, sessions: 50, ctr: 0.1 })

    await page.goto('/heatmap')
    await page.getByTestId('heatmap-canvas').waitFor()
    const initialCalls = calls.length
    expect(initialCalls).toBeGreaterThanOrEqual(1)

    // device=PC でフィルタ
    await page.getByTestId('segment-chip-device-desktop').click()
    await page.waitForTimeout(200)
    const afterDevice = calls.length
    expect(afterDevice).toBeGreaterThan(initialCalls)
    expect(calls[calls.length - 1].deviceType).toBe('desktop')

    // 期間 30 日切替
    await page.getByTestId('segment-chip-period-30').click()
    await page.waitForTimeout(200)
    expect(calls.length).toBeGreaterThan(afterDevice)
  })

  test('HeatmapSidePanel hotspots tab renders 5 hotspot cards (mockup parity)', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 100, sessions: 50 })

    await page.goto('/heatmap')
    const panel = page.getByTestId('hotspot-rankings-panel')
    await expect(panel).toBeVisible()
    for (const rank of [1, 2, 3, 4, 5]) {
      await expect(panel.getByTestId(`hotspot-card-${rank}`)).toBeVisible()
    }
  })

  test('HeatmapSidePanel signals tab toggles signal markers (UGOKI MAP 6 signals)', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 1, sessions: 1 })

    await page.goto('/heatmap')
    await page.getByTestId('hm-side-tab-signals').click()
    // 開いた瞬間に signal overlay が表示される (mockup 同等)
    await expect(page.getByTestId('signal-overlay')).toBeVisible()
    // rage card を toggle off
    await page.getByTestId('signal-card-rage').click()
    // rage marker は非表示になり、他の signal は残る
    await expect(page.locator('[data-testid^="sig-marker-rage-"]').first()).toHaveCount(0)
    await expect(page.locator('[data-testid^="sig-marker-dead-"]').first()).toBeVisible()
  })

  test('emotion chips control emotion blob visibility (mockup parity)', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 1, sessions: 1 })

    await page.goto('/heatmap')
    // mockup default で 4 chip active (frust/hes/cmp/eng)
    await expect(page.getByTestId('emo-chip-frust')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('emo-chip-frust').click()
    await expect(page.getByTestId('emo-chip-frust')).toHaveAttribute('aria-pressed', 'false')
  })

  test('layer toggle group supports multi-select (mockup parity)', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 1, sessions: 1 })

    await page.goto('/heatmap')
    // click は default active
    await expect(page.getByTestId('layer-toggle-click')).toHaveAttribute('aria-pressed', 'true')
    // end も同時 ON 可能
    await page.getByTestId('layer-toggle-end').click()
    await expect(page.getByTestId('layer-toggle-end')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('end-bands')).toBeVisible()
  })

  test('fullscreen mode + device width switching', async ({ page }) => {
    await mockHeatmapApi(page, { dataSource: 'clickhouse_events' })
    await mockPageStatsApi(page, { pageViews: 1, sessions: 1 })

    await page.goto('/heatmap')
    await page.getByTestId('enter-fullscreen-btn').click()
    await expect(page.getByTestId('heatmap-canvas')).toHaveAttribute('data-fullscreen', '1')
    await expect(page.getByTestId('fullscreen-toolbar')).toBeVisible()
    await page.getByTestId('fs-device-sp').click()
    await expect(page.getByTestId('heatmap-canvas')).toHaveAttribute('data-fs-device', 'sp')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('heatmap-canvas')).toHaveAttribute('data-fullscreen', '0')
  })
})

async function mockHeatmapApi(page: Page, opts: HeatmapMockOptions) {
  await page.route('**/api/heatmap?**', async (route: Route) => {
    const url = new URL(route.request().url())
    const cursor = url.searchParams.get('cursor')
    const tileSize = Number(url.searchParams.get('tile_size') ?? 2400)
    const deviceType = url.searchParams.get('device_type')
    const startDate = url.searchParams.get('start_date')
    if (opts.calls) opts.calls.push({ deviceType, periodHint: startDate })

    let yStart = 0
    if (cursor) {
      try {
        yStart = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')).y_start as number
      } catch {
        yStart = 0
      }
    }
    const next = yStart + tileSize
    const hasMore = next < 30_000

    const body = {
      success: true,
      data: {
        tiles: [
          {
            y_start: yStart,
            y_end: Math.min(next, 30_000),
            points: [
              { x: 640, y: yStart + 100, count: 40, sessions: 22 },
              { x: 320, y: yStart + 250, count: 28, sessions: 15 },
              { x: 880, y: yStart + 600, count: 18, sessions: 11 },
            ],
            truncated: false,
          },
        ],
        next_cursor: hasMore
          ? Buffer.from(
              JSON.stringify({
                y_start: next,
                query_hash: 'test-hash-32chars-aaaaaaaaaaaaaaaa',
                exp: Math.floor(Date.now() / 1000) + 600,
              }),
            ).toString('base64url')
          : null,
      },
      meta: {
        tile_size: tileSize,
        page_height_estimate: 30_000,
        cached: false,
        cache_ttl_sec: 7200,
        query_hash: 'test-hash-32chars-aaaaaaaaaaaaaaaa',
        data_source: opts.dataSource,
      },
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

async function mockPageStatsApi(page: Page, opts: PageStatsMockOptions) {
  await page.route('**/api/heatmap/page-stats?**', async (route: Route) => {
    const body = {
      success: true,
      data: {
        page_views: opts.pageViews ?? 0,
        sessions: opts.sessions ?? 0,
        ctr: opts.ctr ?? null,
        scroll_path_rate: opts.scrollPathRate ?? null,
        evidence_level: opts.evidenceLevel ?? 'observed_exact',
      },
      meta: { query_hash: 'test-stats-hash' },
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}
