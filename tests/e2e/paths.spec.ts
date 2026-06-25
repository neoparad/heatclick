/**
 * E2E: 経路分析 (paths) — 登録一覧 → 詳細 → 新規登録 → 編集
 *
 * 親 SSOT: mockup 11_path_analysis.html / §3.6.x / D-07
 *
 * 認証方針 (dashboard.spec.ts と同じ):
 *   - 未認証アクセスは /auth/sign-in に redirect (常に検証)
 *   - 認証必須テストは E2E_TEST_TOKEN (ugokimap_saas_token cookie) を注入。未設定なら skip。
 *
 * KV 依存の happy path (新規登録 → KV 保存 → 詳細) は Cloudflare KV env が必要なため、
 * E2E_PATHS_KV=1 のときのみ実行する。それ以外は POST まで (API mock) を検証する。
 */

import { test, expect } from '@playwright/test'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

test.describe('経路分析 paths', () => {
  test('unauthenticated access redirects to sign-in', async ({ page }) => {
    await page.goto('/paths')
    await expect(page).toHaveURL(/\/auth\/sign-in/)
  })

  test.describe('authenticated', () => {
    test.skip(!process.env.E2E_TEST_TOKEN, 'requires E2E_TEST_TOKEN to inject auth cookie')

    test.beforeEach(async ({ context }) => {
      if (process.env.E2E_TEST_TOKEN) {
        await context.addCookies([
          {
            name: 'ugokimap_saas_token',
            value: process.env.E2E_TEST_TOKEN,
            url: APP_URL,
          },
        ])
      }
    })

    test('登録一覧 renders header + 新規登録 link + POC row', async ({ page }) => {
      await page.goto('/paths')
      await expect(page.getByRole('link', { name: /新規経路を登録/ })).toBeVisible()
      // POC seed の比較セットが一覧に出る (linkth_internal / CIP サイトの場合)
      await expect(page.getByText('商品購入 · 3 経路比較')).toBeVisible()
    })

    test('POC 詳細: フローキャンバス + INFERRED バッジ + 編集ボタン disabled', async ({ page }) => {
      await page.goto('/paths')
      await page.getByText('商品購入 · 3 経路比較').click()
      await expect(page).toHaveURL(/\/paths\/[0-9a-f-]{36}/)
      // 経路 (branch) が描画される
      await expect(page.getByText('経路 A · 商品直行')).toBeVisible()
      await expect(page.getByText('経路 C · FAQ 経由')).toBeVisible()
      // D-07: POC は inferred 数値 → INFERRED バッジ
      await expect(page.getByText('INFERRED')).toBeVisible()
      // POC は編集不可 (disabled button)。一覧へ戻るリンクは存在する。
      await expect(page.getByRole('link', { name: '一覧' })).toBeVisible()
    })

    test('新規登録フォーム: 必須バリデーション', async ({ page }) => {
      await page.goto('/paths/new')
      await expect(page.getByText('比較する経路')).toBeVisible()
      // セット名未入力で送信 → バリデーション toast
      await page.getByRole('button', { name: '経路を登録' }).click()
      await expect(page.getByText('経路（比較セット）名を入力してください')).toBeVisible()
    })

    test('新規登録 → POST (mock) → 詳細遷移', async ({ page }) => {
      const created = {
        id: '00000000-0000-4000-8000-0000000000b9',
      }
      await page.route('**/api/paths', (route) => {
        if (route.request().method() === 'POST') {
          return route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify(created),
          })
        }
        return route.continue()
      })

      await page.goto('/paths/new')
      await page.getByPlaceholder('例: 商品購入 · 3 経路比較').fill('E2E テスト経路')
      // 既定の経路 A / ステップに値を埋める
      await page.getByPlaceholder('ステップ名 例: 商品ページ閲覧').first().fill('商品ページ')
      await page.getByPlaceholder('URL 例: /products/*').first().fill('/p/*')

      await page.getByRole('button', { name: '経路を登録' }).click()
      await expect(page).toHaveURL(new RegExp(`/paths/${created.id}`))
    })

    test.describe('KV happy path (requires E2E_PATHS_KV)', () => {
      test.skip(
        process.env.E2E_PATHS_KV !== '1',
        'requires Cloudflare KV env (CF_ACCOUNT_ID / CF_API_TOKEN / RULE_BUNDLES_KV_NS_ID)',
      )

      test('新規登録 → 実 KV 保存 → 詳細 → 編集 → 削除', async ({ page }) => {
        const unique = `E2E ${Date.now()}`
        await page.goto('/paths/new')
        await page.getByPlaceholder('例: 商品購入 · 3 経路比較').fill(unique)
        await page.getByPlaceholder('ステップ名 例: 商品ページ閲覧').first().fill('商品ページ')
        await page.getByPlaceholder('URL 例: /products/*').first().fill('/p/*')
        await page.getByRole('button', { name: '経路を登録' }).click()

        // 詳細へ遷移
        await expect(page).toHaveURL(/\/paths\/[0-9a-f-]{36}/)
        await expect(page.getByText(unique)).toBeVisible()
        // 未分析ノード
        await expect(page.getByText('未分析').first()).toBeVisible()

        // 編集 → 改名
        await page.getByRole('link', { name: '編集' }).click()
        await expect(page).toHaveURL(/\/paths\/[0-9a-f-]{36}\/edit/)
        await page.getByPlaceholder('例: 商品購入 · 3 経路比較').fill(`${unique} 改`)
        await page.getByRole('button', { name: '変更を保存' }).click()
        await expect(page.getByText(`${unique} 改`)).toBeVisible()

        // 削除
        page.on('dialog', (d) => d.accept())
        await page.getByRole('link', { name: '編集' }).click()
        await page.getByRole('button', { name: '削除' }).click()
        await expect(page).toHaveURL(/\/paths$/)
      })
    })
  })
})
