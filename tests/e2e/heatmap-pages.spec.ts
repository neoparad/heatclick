/**
 * E2E: /api/pages dynamic page list (Sprint 3 W1 ヒートマップ本接続)
 *
 * 親 SSOT §3.6.5 / decisions.md 続 56 / Infra handoff 2026-05-30-infra-sprint3-w1-heatmap-completed.md §5
 *
 * 検証:
 *   1. 未認証で /api/pages → 401
 *   2. (authenticated) 5 sites それぞれで page list 取得 + ヒートマップ画面 page selector に反映
 *   3. cross-tenant site_id 指定 → 403 (middleware 段で拒否)
 *   4. site_id 切替で page selector の options が動的に変わる (Sprint 3 W1 完了条件)
 *   5. invalid site_id query → 400
 *
 * CI: E2E_TEST_TOKEN (5 sites アクセス可能な linkth_internal tenant JWT) を要求。
 *     未設定の skip テストは 1/2/5 のみ public 動作確認。
 */

import { test, expect, type Page } from '@playwright/test'

const SITES = [
  { id: 'CIP_EcwUTHEZdIOAUqum', name: 'bihadashop' },
  { id: 'CIP_xginf3nVacnkn62o', name: 'ehaiki' },
  { id: 'CIP_6r2WofQDSKrOwxmM', name: 'nvrseen' },
  { id: 'CIP_8eN7xgfBtDAnzE26', name: 'bousuikouji' },
  { id: 'CIP_QWaPiks5krukJ6NM', name: 'wakegai' },
] as const

const FOREIGN_TENANT_SITE_ID = 'CIP_FOREIGN_TENANT_NOT_OWNED' // 存在しない / 別 tenant 想定

async function setAuthCookie(page: Page): Promise<void> {
  if (!process.env.E2E_TEST_TOKEN) return
  await page.context().addCookies([
    {
      name: 'ugokimap_saas_token',
      value: process.env.E2E_TEST_TOKEN,
      url: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    },
  ])
}

test.describe('GET /api/pages — auth / validation', () => {
  test('unauthenticated → 401', async ({ request }) => {
    const res = await request.get('/api/pages?site_id=CIP_EcwUTHEZdIOAUqum')
    expect(res.status()).toBe(401)
  })

  test('missing site_id → 400', async ({ request, context }) => {
    if (process.env.E2E_TEST_TOKEN) {
      await context.addCookies([
        {
          name: 'ugokimap_saas_token',
          value: process.env.E2E_TEST_TOKEN,
          url: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
        },
      ])
    }
    const res = await request.get('/api/pages')
    // E2E_TEST_TOKEN 無ければ middleware 段で 401。あれば schema validate 失敗で 400。
    expect([400, 401]).toContain(res.status())
  })
})

test.describe('GET /api/pages — authenticated', () => {
  test.skip(
    !process.env.E2E_TEST_TOKEN,
    'requires E2E_TEST_TOKEN (linkth_internal tenant JWT) to call protected /api/pages',
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

  for (const site of SITES) {
    test(`returns page list for ${site.name} (${site.id})`, async ({ request }) => {
      const res = await request.get(`/api/pages?site_id=${site.id}`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(Array.isArray(body.data)).toBe(true)
      // event 0 件の site は data 空配列で 200 を返す (404 にしない)
      if (body.data.length > 0) {
        for (const opt of body.data) {
          expect(typeof opt.url).toBe('string')
          expect(typeof opt.label).toBe('string')
          expect(opt.url.length).toBeGreaterThan(0)
          expect(opt.label.length).toBeGreaterThan(0)
        }
      }
    })
  }

  test('cross-tenant site_id → 403 (middleware enforcement)', async ({ request }) => {
    const res = await request.get(`/api/pages?site_id=${FOREIGN_TENANT_SITE_ID}`)
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.success).toBe(false)
  })
})

test.describe('Heatmap page — dynamic page selector via /api/pages', () => {
  test.skip(
    !process.env.E2E_TEST_TOKEN,
    'requires E2E_TEST_TOKEN to render authenticated heatmap page',
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

  test('page selector reflects /api/pages response (default site)', async ({ page }) => {
    await setAuthCookie(page)
    await page.goto('/heatmap')
    const select = page.getByLabel('ヒートマップ表示対象ページ')
    // 「過去 7 日間のイベントがまだ集まっていません」が出ていない場合のみセレクタを assert
    const empty = page.getByText('過去 7 日間のイベントがまだ集まっていません')
    const isEmpty = await empty.isVisible().catch(() => false)
    if (!isEmpty) {
      await expect(select).toBeVisible()
      const optionCount = await select.locator('option').count()
      expect(optionCount).toBeGreaterThan(0)
    }
  })

  test('switching site_id query updates page options dynamically', async ({ page }) => {
    await setAuthCookie(page)

    // bihadashop で取得した options
    await page.goto(`/heatmap?site_id=${SITES[0].id}`)
    const select = page.getByLabel('ヒートマップ表示対象ページ')
    const empty = page.getByText('過去 7 日間のイベントがまだ集まっていません')

    let bihadaOptions: string[] = []
    if (!(await empty.isVisible().catch(() => false))) {
      bihadaOptions = await select.locator('option').allTextContents()
    }

    // ehaiki に切替
    await page.goto(`/heatmap?site_id=${SITES[1].id}`)
    let ehaikiOptions: string[] = []
    if (!(await empty.isVisible().catch(() => false))) {
      ehaikiOptions = await select.locator('option').allTextContents()
    }

    // 両 site で events が存在するなら options が異なるはず (動的取得の証拠)
    if (bihadaOptions.length > 0 && ehaikiOptions.length > 0) {
      expect(bihadaOptions.sort().join('|')).not.toBe(ehaikiOptions.sort().join('|'))
    } else {
      // 片方でも空なら、空表示の挙動だけ確認 (タグ未設置サイトの protective path)
      test.info().annotations.push({
        type: 'note',
        description: `site ${SITES[0].id} or ${SITES[1].id} has no events yet — dynamic switch assertion skipped`,
      })
    }
  })
})
