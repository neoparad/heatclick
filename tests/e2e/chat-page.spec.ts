/**
 * E2E: /chat page (Sprint 3 W1 React UI + stub endpoint 結線確認)
 *
 * 親 SSOT §6.4 Sprint 3 W1 / 続 60 §7 [→Frontend] (b) / 続 63 (Frontend 完了)
 * 依存: 続 58 (ML `/api/chat` stub) / chat-stub.spec.ts (API 層側)
 *
 * 検証スコープ:
 *   1. unauthenticated 時に /chat にアクセス → middleware が 401 / redirect する経路は
 *      ここでは扱わない (sign-in.spec.ts で別途検証済)。E2E_TEST_TOKEN 必須 test として書く。
 *   2. authenticated /chat 訪問 → page shell (DummyBanner / 入力 UI / サジェスト chip) 表示
 *   3. composer に入力 → 送信 → assistant message bubble に "[STUB]" 応答が表示
 *   4. EvidenceBadge "Planned" が assistant 応答に付与される (D-07 整合)
 *   5. 「新しい会話」クリック → 会話リセット (新しい conversationId)
 *
 * 注: heatmap.spec.ts / chat-stub.spec.ts と同じく E2E_TEST_TOKEN 未設定時は skip。
 */

import { test, expect } from '@playwright/test'

const TEST_TOKEN = process.env.E2E_TEST_TOKEN

test.describe('/chat (Sprint 3 W1 React shell + stub)', () => {
  test.skip(!TEST_TOKEN, 'requires E2E_TEST_TOKEN to inject auth cookie')

  test.beforeEach(async ({ context }) => {
    // chat-stub.spec.ts と同じ cookie 流儀 (ugokimap_saas_token を JWT として注入)
    if (TEST_TOKEN) {
      await context.addCookies([
        {
          name: 'ugokimap_saas_token',
          value: TEST_TOKEN,
          url: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
          httpOnly: false,
          sameSite: 'Lax',
        },
      ])
    }
  })

  test('renders page shell with DummyBanner and composer', async ({ page }) => {
    await page.goto('/chat')

    await expect(page.getByRole('heading', { name: 'UGOKIMAP AI', level: 1 })).toBeVisible()
    await expect(page.getByText('Sprint 3 W1 — Stub mode')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'チャット入力' })).toBeVisible()
    // 初期 suggestions が 3 件 表示されること
    const suggestionGroup = page.getByRole('group', { name: '次の質問サジェスト' })
    await expect(suggestionGroup.locator('button')).toHaveCount(3)
  })

  test('submit message → stub assistant bubble with Planned EvidenceBadge', async ({ page }) => {
    await page.goto('/chat')

    const input = page.getByRole('textbox', { name: 'チャット入力' })
    await input.fill('SP の CVR が下がっている理由を教えて')

    const send = page.getByRole('button', { name: /送信/ })
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/chat') && r.request().method() === 'POST'),
      send.click(),
    ])

    // user bubble
    const userBubble = page.getByTestId('chat-msg-user').last()
    await expect(userBubble).toContainText('SP の CVR が下がっている理由を教えて')

    // assistant bubble: stub prefix
    const assistantBubble = page.getByTestId('chat-msg-assistant').last()
    await expect(assistantBubble).toContainText('[STUB]')

    // D-07: Planned EvidenceBadge 付与
    await expect(assistantBubble.getByText('Planned', { exact: false })).toBeVisible()

    // composer はクリア
    await expect(input).toHaveValue('')
  })

  test('new conversation clears thread', async ({ page }) => {
    await page.goto('/chat')

    const input = page.getByRole('textbox', { name: 'チャット入力' })
    await input.fill('テスト質問')
    const send = page.getByRole('button', { name: /送信/ })
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/chat')),
      send.click(),
    ])
    await expect(page.getByTestId('chat-msg-user')).toHaveCount(1)

    await page.getByRole('button', { name: '新しい会話' }).click()
    await expect(page.getByTestId('chat-msg-user')).toHaveCount(0)
    await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(0)
  })
})
