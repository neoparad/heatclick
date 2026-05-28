/**
 * E2E screenshot: /heatmap mockup parity visual verification
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 14 / §8 DoD
 * Codex review HIGH fix: 視覚 screenshot assertion を追加。
 *
 * 実行:
 *   - desktop viewport (1440x900) で `/heatmap` 全画面 screenshot
 *   - mobile viewport (Pixel 5 default) で `/heatmap` 全画面 screenshot
 *   - 旧 deck.gl GPU canvas が無いため、screenshot は静的 DOM (mockup parity) のみ評価
 *
 * 認証: E2E_TEST_TOKEN が必要 (middleware で全 /heatmap が JWT verify される)。
 * 未設定なら test.skip。screenshot は `test-results/screenshots/` に保存される。
 */

import { test, expect, type Page, type Route } from '@playwright/test'

test.describe('heatmap visual screenshot (mockup parity)', () => {
  test.skip(
    !process.env.E2E_TEST_TOKEN,
    'requires E2E_TEST_TOKEN to render authenticated /heatmap',
  )

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: 'ugokimap_saas_token',
        value: process.env.E2E_TEST_TOKEN!,
        url: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
      },
    ])
  })

  test('desktop screenshot @ 1440x900', async ({ page }) => {
    await mockHeatmapApi(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/heatmap')
    await page.getByTestId('heatmap-canvas').waitFor()
    // overlay 描画完了を軽く待つ
    await expect(page.getByTestId('mock-product-page-underlay')).toBeVisible()
    await expect(page.getByTestId('heat-tag-1')).toBeVisible()
    await page.screenshot({
      path: 'test-results/screenshots/heatmap-desktop.png',
      fullPage: true,
    })
  })

  test('mobile screenshot @ Pixel 5', async ({ page }) => {
    await mockHeatmapApi(page)
    await page.goto('/heatmap')
    await page.getByTestId('heatmap-canvas').waitFor()
    await expect(page.getByTestId('mock-product-page-underlay')).toBeVisible()
    await page.screenshot({
      path: 'test-results/screenshots/heatmap-mobile.png',
      fullPage: true,
    })
  })

  test('fullscreen mode screenshot (mockup parity floating toolbar)', async ({ page }) => {
    await mockHeatmapApi(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/heatmap')
    await page.getByTestId('heatmap-canvas').waitFor()
    await page.getByTestId('enter-fullscreen-btn').click()
    await expect(page.getByTestId('fullscreen-toolbar')).toBeVisible()
    await page.screenshot({
      path: 'test-results/screenshots/heatmap-fullscreen.png',
      fullPage: false,
    })
  })

  test('signals tab + markers screenshot', async ({ page }) => {
    await mockHeatmapApi(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/heatmap')
    await page.getByTestId('hm-side-tab-signals').click()
    await expect(page.getByTestId('signal-overlay')).toBeVisible()
    await page.screenshot({
      path: 'test-results/screenshots/heatmap-signals.png',
      fullPage: true,
    })
  })
})

async function mockHeatmapApi(page: Page) {
  await page.route('**/api/heatmap?**', async (route: Route) => {
    const body = {
      success: true,
      data: {
        tiles: [
          {
            y_start: 0,
            y_end: 2400,
            points: [
              { x: 640, y: 200, count: 40, sessions: 22 },
              { x: 320, y: 400, count: 28, sessions: 15 },
            ],
            truncated: false,
          },
        ],
        next_cursor: null,
      },
      meta: {
        tile_size: 2400,
        page_height_estimate: 30_000,
        cached: false,
        cache_ttl_sec: 7200,
        query_hash: 'screenshot-test',
        data_source: 'clickhouse_events',
      },
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  await page.route('**/api/heatmap/page-stats?**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          page_views: 6210,
          sessions: 2841,
          ctr: 0.265,
          scroll_path_rate: 0.482,
          evidence_level: 'observed_exact',
        },
        meta: { query_hash: 'stats' },
      }),
    })
  })
}
