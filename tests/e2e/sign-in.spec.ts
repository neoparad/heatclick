/**
 * E2E: P-01 sign-in
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-01
 *
 * 検証:
 *   1. 未認証アクセスは /auth/sign-in に redirect
 *   2. magic link form 表示
 *   3. 空 / 不正 email でクライアント側 validation
 *   4. 正常送信で「リンクを送信しました」確認画面表示
 *   5. /api/auth/magic-link を mock で 429 にして rate limit エラー UI
 *   6. /api/auth/verify の link-used redirect が error UI 表示
 *   7. legal リンクが visible
 */

import { test, expect } from '@playwright/test'

test.describe('P-01 sign-in', () => {
  test('redirects unauthenticated user from protected route to /auth/sign-in', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/auth\/sign-in/)
    await expect(page.getByRole('heading', { level: 1, name: /おかえりなさい/ })).toBeVisible()
  })

  test('shows magic link form fields', async ({ page }) => {
    await page.goto('/auth/sign-in')
    await expect(page.getByLabel('メールアドレス')).toBeVisible()
    await expect(page.getByRole('button', { name: /magic link を送信/ })).toBeVisible()
  })

  test('client-side validation rejects invalid email', async ({ page }) => {
    await page.goto('/auth/sign-in')
    await page.getByLabel('メールアドレス').fill('not-an-email')
    await page.getByRole('button', { name: /magic link を送信/ }).click()
    await expect(page.getByRole('alert')).toContainText('メールアドレスの形式')
  })

  test('shows confirmation panel on successful magic link request', async ({ page }) => {
    await page.route('**/api/auth/magic-link', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      }),
    )

    await page.goto('/auth/sign-in')
    await page.getByLabel('メールアドレス').fill('hiroki@linkth.com')
    await page.getByRole('button', { name: /magic link を送信/ }).click()

    await expect(page.getByRole('status')).toContainText('サインインリンクを送信しました')
    await expect(page.getByText('hiroki@linkth.com')).toBeVisible()
  })

  test('shows rate-limit error when API returns 429', async ({ page }) => {
    await page.route('**/api/auth/magic-link', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' }),
      }),
    )

    await page.goto('/auth/sign-in')
    await page.getByLabel('メールアドレス').fill('hiroki@linkth.com')
    await page.getByRole('button', { name: /magic link を送信/ }).click()

    await expect(page.getByRole('alert')).toContainText('送信回数の上限')
  })

  test('shows link-used error from verify redirect', async ({ page }) => {
    await page.goto('/auth/sign-in?error=link-used')
    await expect(page.getByRole('alert')).toContainText('既に使用されています')
  })

  test('legal links are visible', async ({ page }) => {
    await page.goto('/auth/sign-in')
    await expect(page.getByRole('link', { name: '利用規約' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'プライバシーポリシー' })).toBeVisible()
  })
})
