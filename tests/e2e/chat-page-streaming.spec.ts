/**
 * E2E: /chat page Streaming UI + 5-tier Evidence Badge + ChatModelMeta (続 66 §3 F-1〜F-3)
 *
 * 親 SSOT §6.4 Sprint 3 W2-A / 続 66 §3 F-1〜F-3 / 続 69 (本完了通知)
 * 依存: 続 63 (chat-page.spec.ts 基盤) / 続 58 (ML stub) / 続 64 (W2 hardening)
 *
 * 検証スコープ:
 *   1. F-1 stream parts: ML W2-A 配備前は stub 1-shot reply で legacy path 維持 (regression guard)
 *      → parts なしのレスポンスで final block 不在 / legacy text bubble 表示
 *   2. F-2 5-tier バッジ: stub `evidenceLevel='planned'` が "Planned" 表示 + data-evidence-level
 *   3. F-3 ChatModelMeta toggle: localStorage `chat-debug-meta=1` で full breakdown 表示
 *
 * Streaming flow (Wave 2 ML M-4 配備後の本テスト範囲、現状は skip):
 *   - test('stream partial parts appear before final', ...) は ML M-4 配備後に解禁
 *   - W2-A 全完了時 (続 70+) に skip 解除 + AI SDK v6 toUIMessageStream() の data event 検証
 *
 * 注: heatmap.spec.ts / chat-stub.spec.ts と同じく E2E_TEST_TOKEN 未設定時は skip。
 */

import { test, expect } from '@playwright/test'

const TEST_TOKEN = process.env.E2E_TEST_TOKEN
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

test.describe('/chat W2-A streaming UI + 5-tier badge + debug meta (続 69)', () => {
  test.skip(!TEST_TOKEN, 'requires E2E_TEST_TOKEN to inject auth cookie')

  test.beforeEach(async ({ context }) => {
    if (TEST_TOKEN) {
      await context.addCookies([
        {
          name: 'ugokimap_saas_token',
          value: TEST_TOKEN,
          url: APP_URL,
          httpOnly: false,
          sameSite: 'Lax',
        },
      ])
    }
  })

  test('F-2: stub response renders 5-tier "Planned" badge with data-evidence-level', async ({
    page,
  }) => {
    await page.goto('/chat')

    const input = page.getByRole('textbox', { name: 'チャット入力' })
    await input.fill('SP の CVR 推移を見せて')

    const send = page.getByRole('button', { name: /送信/ })
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/chat') && r.request().method() === 'POST'),
      send.click(),
    ])

    const assistantBubble = page.getByTestId('chat-msg-assistant').last()
    // 5-tier 拡張後も legacy 'Planned' label が visible (後方互換確認)
    await expect(assistantBubble.getByText('Planned', { exact: false })).toBeVisible()

    // 新規: data-evidence-level 属性に V2 (planned) が入っていること
    const badge = assistantBubble.locator('[data-evidence-level]').first()
    await expect(badge).toHaveAttribute('data-evidence-level', 'planned')
    await expect(badge).toHaveAttribute('data-evidence-level-v1', 'planned')
  })

  test('F-1 regression: 1-shot reply (parts なし) は legacy bubble 表示 / partial block 不在', async ({
    page,
  }) => {
    await page.goto('/chat')

    await page.getByRole('textbox', { name: 'チャット入力' }).fill('テスト質問')
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/chat')),
      page.getByRole('button', { name: /送信/ }).click(),
    ])

    const assistantBubble = page.getByTestId('chat-msg-assistant').last()
    // legacy path: streaming partial block も final block も表示されない
    await expect(assistantBubble.getByTestId('chat-stream-partial-block')).toHaveCount(0)
    await expect(assistantBubble.getByTestId('chat-stream-final-block')).toHaveCount(0)
    // ただし通常 bubble は表示される
    await expect(assistantBubble).toContainText('[STUB]')
  })

  test('F-3: ChatModelMeta は minimal 表示 (debug off 初期状態)', async ({ page }) => {
    await page.goto('/chat')

    await page.getByRole('textbox', { name: 'チャット入力' }).fill('latency 確認')
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/chat')),
      page.getByRole('button', { name: /送信/ }).click(),
    ])

    const meta = page.getByTestId('chat-model-meta').last()
    await expect(meta).toBeVisible()
    // 初期は debug=0 (minimal 表示)
    await expect(meta).toHaveAttribute('data-debug', '0')
    // minimal 表示 = "{latency}ms · {tok} tok" pattern
    await expect(meta).toContainText(/ms · /)
  })

  test('F-3: ChatModelMeta クリックで debug 全展開 + localStorage 永続化', async ({ page }) => {
    await page.goto('/chat')
    await page.getByRole('textbox', { name: 'チャット入力' }).fill('debug meta')
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/chat')),
      page.getByRole('button', { name: /送信/ }).click(),
    ])

    const meta = page.getByTestId('chat-model-meta').last()
    await meta.click()

    // toggle 後 data-debug='1' + 詳細ラベル "Latency" が表示される
    await expect(meta).toHaveAttribute('data-debug', '1')
    await expect(meta).toContainText(/Latency/)

    // localStorage に永続化
    const flag = await page.evaluate(() => window.localStorage.getItem('chat-debug-meta'))
    expect(flag).toBe('1')
  })

  // ────────────────────────────────────────────────────────────────
  // 以下は ML M-4 orchestrator (続 68) で AI SDK v6 stream parts emit 開始後に解禁
  // 本時点 (続 69 起票時) は ML stub のため skip
  // ────────────────────────────────────────────────────────────────
  test.skip('F-1 (ML 配備後): partial parts が逐次表示 → final で確定 bubble に切替', async () => {
    // ML M-4 (orchestrator) が AI SDK v6 `toUIMessageStream()` の data event で
    //   { phase: 'partial', queryId, evidence, content }
    //   { phase: 'final',   queryId, evidence, content }
    // を emit するようになったら、本テストを enable する。
    //
    // 期待挙動:
    //   - 送信直後 chat-stream-partial-block が出現
    //   - partial parts 1 件目 "分析中... q=xxx" が text-text-2 で表示
    //   - final 到達後 chat-stream-final-block に切替、partial は <details> に折り畳まれる
    //   - 5-tier badge は final.evidence の最弱 level (例: observed_approx) で表示
  })
})
