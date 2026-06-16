/**
 * E2E: P-02 onboarding/install
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-02
 */

import { test, expect } from '@playwright/test'

test.describe('P-02 onboarding/install', () => {
  test('renders install tab content (snippet + GTM guide + classifier)', async ({ page }) => {
    await page.goto('/onboarding/install')

    // Step 1: snippet
    await expect(page.getByRole('heading', { name: /Step 1\. tracking\.js snippet/ })).toBeVisible()
    await expect(page.getByLabel('UGOKI MAP tracking.js snippet')).toContainText('data-site-id=')

    // Step 2: GTM guide
    await expect(page.getByRole('heading', { name: /Step 2\. GTM 設定ガイド/ })).toBeVisible()
    await expect(page.getByLabel(/GTM への UGOKI MAP/)).toBeVisible()

    // Step 3: classifier
    await expect(page.getByRole('heading', { name: /Step 3\. サイト業種を自動診断/ })).toBeVisible()
    await expect(page.getByLabel('サイト URL')).toBeVisible()
  })

  test('snippet copy button is present and labelled', async ({ page }) => {
    await page.goto('/onboarding/install')
    await expect(page.getByRole('button', { name: /コードをコピー/ })).toBeVisible()
  })

  test('classifier rejects invalid URL', async ({ page }) => {
    await page.goto('/onboarding/install')
    await page.getByLabel('サイト URL').fill('not-a-url')
    await page.getByRole('button', { name: /業種を自動診断/ }).click()
    await expect(page.getByRole('alert')).toContainText('URL の形式')
  })

  test('classifier runs and shows inferred evidence badge', async ({ page }) => {
    await page.goto('/onboarding/install')
    await page.getByLabel('サイト URL').fill('https://shop.example.com')
    await page.getByRole('button', { name: /業種を自動診断/ }).click()

    // Loading state
    await expect(page.getByRole('status').filter({ hasText: /分析中/ })).toBeVisible()

    // Result (1.5s dummy delay)
    await expect(page.getByText('診断結果')).toBeVisible({ timeout: 8000 })
    await expect(page.getByText(/Inferred/)).toBeVisible()
  })

  test('only install tab is active in Sprint 1', async ({ page }) => {
    await page.goto('/onboarding/install')
    await expect(page.getByRole('tab', { name: /設置 \(Install\)/ })).toBeEnabled()
    await expect(page.getByRole('tab', { name: /一般/ })).toBeDisabled()
    await expect(page.getByRole('tab', { name: /チーム/ })).toBeDisabled()
    await expect(page.getByRole('tab', { name: /請求/ })).toBeDisabled()
  })
})
