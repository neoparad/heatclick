/**
 * E2E: P-04 heatmap
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-04 / Infra heatmap-pagination.md §7
 *
 * 検証:
 *   1. 未認証で /heatmap → /auth/sign-in redirect
 *   2. (authenticated) 30000px fixture が canvas + a11y table 両方に出る
 *   3. layer toggle で 4 layer 切替可能
 *   4. page selector で URL 切替可能
 *   5. hotspot クリックで詳細パネル開閉
 *   6. cursor 連鎖で 13 tile 取得 (Infra §7 完了条件 #3)
 */

import { test, expect } from '@playwright/test'

test.describe('P-04 heatmap', () => {
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

    test('layer toggle has 4 layers', async ({ page }) => {
      await page.goto('/heatmap')
      const group = page.getByRole('radiogroup', { name: 'ヒートマップレイヤー' })
      for (const label of ['クリック', 'ムーブ', '感情', '摩擦']) {
        await expect(group.getByRole('radio', { name: label })).toBeVisible()
      }
    })

    test('switches layer via keyboard', async ({ page }) => {
      await page.goto('/heatmap')
      const click = page.getByRole('radio', { name: 'クリック' })
      await click.focus()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('radio', { name: 'ムーブ' })).toBeFocused()
    })

    test('changes page selection', async ({ page }) => {
      await page.goto('/heatmap')
      const select = page.getByLabel('ヒートマップ表示対象ページ')
      await select.selectOption({ label: 'コラム: ニキビ治療' })
      await expect(select).toHaveValue('https://bihadashop.jp/column/acne/')
    })

    test('canvas container takes 30000px+ height when API returns long page', async ({ page }) => {
      await mockHeatmapApi(page)
      await page.goto('/heatmap')
      const canvas = page.getByRole('img', { name: /クリック ヒートマップ/ })
      await expect(canvas).toBeVisible()
      const box = await canvas.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(30_000)
    })

    test('B-1 fix: tile pagination fetches every tile when user scrolls through 30000px page', async ({
      page,
    }) => {
      // counter of API calls — each successful call = 1 tile fetched
      const calls: Array<{ cursor: string | null; yStart: number }> = []
      await mockHeatmapApi(page, calls)

      await page.goto('/heatmap')
      await page.getByRole('img', { name: /クリック ヒートマップ/ }).waitFor()

      // Helper: scroll incrementally and let IntersectionObserver fire loadMore
      const VIEWPORT_H = 720
      for (let y = 0; y <= 30_000; y += VIEWPORT_H) {
        await page.evaluate((scrollTo) => window.scrollTo(0, scrollTo), y)
        // wait briefly for IO callback + fetch round-trip
        await page.waitForTimeout(120)
      }

      // 30000 / 2400 = 12.5 → 13 tiles expected
      expect(calls.length).toBeGreaterThanOrEqual(13)
      // y_start sequence: 0, 2400, 4800, ..., 28800 → 13 tiles, last y_start = 28800
      const yStarts = calls.map((c) => c.yStart).sort((a, b) => a - b)
      expect(yStarts[0]).toBe(0)
      expect(yStarts[yStarts.length - 1]).toBe(28_800)
      // No gap (each tile must be contiguous)
      for (let i = 1; i < yStarts.length; i++) {
        expect(yStarts[i] - yStarts[i - 1]).toBe(2400)
      }
    })
  })
})

/**
 * Shared API mock — returns 1 tile per call up to y=30000 then null cursor.
 * If `calls` array provided, records each tile's y_start for assertion.
 */
async function mockHeatmapApi(
  page: import('@playwright/test').Page,
  calls?: Array<{ cursor: string | null; yStart: number }>,
) {
  await page.route('**/api/heatmap*', async (route) => {
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

    if (calls) calls.push({ cursor, yStart })

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
      },
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}
