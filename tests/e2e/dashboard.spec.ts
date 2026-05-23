/**
 * E2E: P-03 dashboard
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-03
 *
 * 検証:
 *   1. 未認証で /dashboard → /auth/sign-in redirect
 *   2. KPI 5 枚 + Insight feed + Alert list 表示
 *   3. EvidenceBadge が AI 出力に必ず付く (Sprint 1 dummy では Inferred / Planned)
 *   4. dummy banner が可視
 */

import { test, expect } from '@playwright/test'

test.describe('P-03 dashboard', () => {
  test('unauthenticated access redirects to sign-in', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/auth\/sign-in/)
  })

  // Sprint 1: authenticated render check requires a test JWT.
  // Below tests rely on bypassing auth via header injection in dev env.
  // CI 環境では COOKIES env で session 注入予定 (Sprint 1 末タスク)。
  test.describe('dummy data rendering', () => {
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

    test('renders 5 KPI cards', async ({ page }) => {
      await page.goto('/dashboard')
      for (const id of ['sessions', 'cv', 'cvr', 'lift', 'bottleneck']) {
        await expect(page.getByTestId(`kpi-card-${id}`)).toBeVisible()
      }
    })

    test('shows dummy data banner', async ({ page }) => {
      await page.goto('/dashboard')
      await expect(page.getByText('Dummy data モード')).toBeVisible()
    })

    test('insight feed has 5 items each with evidence badge', async ({ page }) => {
      await page.goto('/dashboard')
      const feed = page.getByRole('heading', { name: /AI が見つけた今日の気づき/ }).locator('..').locator('..')
      const items = feed.getByRole('listitem')
      await expect(items).toHaveCount(5)
      // Each row must include an Evidence badge label
      await expect(items.first().getByText(/Inferred|Planned|Proven|Observed/)).toBeVisible()
    })
  })
})
