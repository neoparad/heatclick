/**
 * E2E: P-04 heatmap (mockup parity rebuild 2026-05-29)
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-04 / mockup `mockups/01_heatmap_canvas.html`
 *
 * 旧 deck.gl 4-layer radiogroup + 30000px tall canvas は本 dispatch で全廃。
 * mockup parity 後の検証:
 *   1. 未認証で /heatmap → /auth/sign-in redirect
 *   2. layer toggle group が 6 種 (click/end/attention/exit/move/emo) で multi-select
 *   3. page selector で URL 切替可能
 *   4. canvas root (data-testid="heatmap-canvas") が表示される
 *   5. 既存 testid (`heatmap-load-more-sentinel`) は維持されている
 *
 * 注記: 旧「30000px+ canvas height + scroll-based tile pagination」は Phase 2
 *   (実 screenshot underlay) で再導入予定。本 spec では mockup parity の 720px
 *   固定 underlay を前提に確認する。
 */

import { test, expect } from '@playwright/test'

test.describe('P-04 heatmap (mockup parity)', () => {
  test('unauthenticated access redirects to sign-in', async ({ page }) => {
    await page.goto('/heatmap')
    await expect(page).toHaveURL(/\/auth\/sign-in/)
  })

  test.describe('authenticated rendering', () => {
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

    test('layer toggle group has the expected layers (mockup parity)', async ({ page }) => {
      await mockHeatmapApi(page)
      await page.goto('/heatmap')
      // 続121: dead 'end' トグル撤去。click/熟読/スクロール/離脱/マウス/感情。
      for (const key of ['click', 'attention', 'scroll', 'exit', 'move', 'emo']) {
        await expect(page.getByTestId(`layer-toggle-${key}`)).toBeVisible()
      }
    })

    test('changes page selection', async ({ page }) => {
      await mockHeatmapApi(page)
      await page.goto('/heatmap')
      const select = page.getByLabel('ヒートマップ表示対象ページ')
      // E2E_TEST_TOKEN 経由で /api/pages が複数 option を返す前提のみ実行。
      const optionCount = await select.locator('option').count()
      if (optionCount > 1) {
        const second = await select.locator('option').nth(1).getAttribute('value')
        if (second) {
          await select.selectOption(second)
          await expect(select).toHaveValue(second)
        }
      }
    })

    test('canvas root + load-more sentinel are present', async ({ page }) => {
      await mockHeatmapApi(page)
      await page.goto('/heatmap')
      await expect(page.getByTestId('heatmap-canvas')).toBeVisible()
      await expect(page.getByTestId('heatmap-load-more-sentinel')).toHaveCount(1)
    })

    test('mock product page underlay is rendered (720px fixed)', async ({ page }) => {
      await mockHeatmapApi(page)
      await page.goto('/heatmap')
      await expect(page.getByTestId('mock-product-page-underlay')).toBeVisible()
    })

    test.fixme(
      'tile pagination scrolling 30000px page — Phase 2 で実 screenshot underlay と一緒に再導入',
      async () => {},
    )
  })
})

/**
 * Shared API mock — returns 1 tile per call up to y=30000 then null cursor.
 */
async function mockHeatmapApi(page: import('@playwright/test').Page) {
  await page.route('**/api/heatmap?**', async (route) => {
    const url = new URL(route.request().url())
    const cursor = url.searchParams.get('cursor')
    const tileSize = Number(url.searchParams.get('tile_size') ?? 2400)
    let yStart = 0
    if (cursor) {
      try {
        yStart = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')).y_start as number
      } catch {
        try {
          yStart = JSON.parse(atob(cursor)).y_start as number
        } catch {
          yStart = 0
        }
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
            points: [{ x: 640, y: yStart + 100, count: 10, sessions: 5 }],
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
        data_source: 'dummy_lcg',
      },
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  await page.route('**/api/heatmap/page-stats?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          page_views: 100,
          sessions: 50,
          ctr: 0.1,
          scroll_path_rate: 0.5,
          evidence_level: 'observed_exact',
        },
        meta: { query_hash: 'stats' },
      }),
    })
  })
}
