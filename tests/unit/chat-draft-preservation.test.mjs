/**
 * Unit tests for chat-conversation-pane draft preservation — 続 72 (B-3 fix)
 *
 * 背景: Owner 動作テスト (2026-05-23 22:50) で AIチャットの error 後に
 *   ・入力欄が viewport 外に押し出される (layout)
 *   ・typed text が消失して再入力必要 (state)
 *
 * 続 72 fix (chat-conversation-pane.tsx):
 *   1. pane height: `h-[calc(100vh-3.5rem)]` → `flex-1 min-h-0`
 *      (親 <main flex-col h-screen> 残余高に追随、header + DummyBanner 込みで input 可視)
 *   2. setDraft('') を optimistic 早出しから success 確定後に遅延
 *      (error / network 例外時は draft 保持 = 即 retry 可能)
 *
 * Strategy: source-level 検査 (関数本体内の制御フロー regex)。
 *           E2E 動作検証は Playwright (tests/e2e/chat-page.spec.ts) に委譲。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/chat-draft-preservation.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SOURCE_PATH = resolve(
  __dirname,
  '../../components/chat/chat-conversation-pane.tsx',
)
const source = readFileSync(SOURCE_PATH, 'utf8')

test('pane root uses flex-1 min-h-0 (続 72 B-3 layout fix)', () => {
  // 旧 = h-[calc(100vh-3.5rem)] により header + banner 込みで input が viewport 外
  // 新 = flex-1 min-h-0 で親 flex-col の残余高を正しく充填
  //
  // コメント除去後の実 className のみを scan (regression コメント保持のため)
  const code = stripComments(source)
  assert.ok(
    code.includes('flex-1') && code.includes('min-h-0'),
    'pane root className must use `flex-1 min-h-0` for proper height calculation',
  )
  assert.ok(
    !code.includes('h-[calc(100vh-3.5rem)]'),
    'pane root must NOT use `h-[calc(100vh-3.5rem)]` (regression: pushes input below viewport)',
  )
})

/** TS/JS の line comment (`// ...`) と block comment (`/* ... *​/`) を除去。 */
function stripComments(src) {
  // block first (greedy 回避のため非貪欲)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line (URL の :// は除外)
  return out
}

test('sendMessage clears draft only after success (続 72 B-3 state fix)', () => {
  // sendMessage function 内で `setDraft('')` の出現位置を確認:
  //   旧 = setMessages(...) 直後 (fetch 前) に setDraft → error 時 typed text 消失
  //   新 = success branch (setMessages で complete に更新した後) で setDraft
  //
  // 構造的契約: setDraft('') の出現が setIsSending(true) より後、かつ
  // 'complete' を含む setMessages の後にあること。
  const sendStart = source.indexOf('const sendMessage')
  assert.ok(sendStart > 0, 'sendMessage callback must exist')
  const sendEnd = source.indexOf('[conversationId,', sendStart)
  assert.ok(sendEnd > sendStart, 'sendMessage callback boundary must be locatable')
  const sendBody = stripComments(source.slice(sendStart, sendEnd))

  const setDraftOccurrences = [...sendBody.matchAll(/setDraft\(['"]['"]\)/g)]
  assert.ok(
    setDraftOccurrences.length >= 1,
    "sendMessage must call setDraft('') at least once (on success)",
  )

  const setIsSendingTrueIdx = sendBody.indexOf('setIsSending(true)')
  assert.ok(
    setIsSendingTrueIdx >= 0,
    'sendMessage must call setIsSending(true) before fetch',
  )
  for (const m of setDraftOccurrences) {
    assert.ok(
      m.index > setIsSendingTrueIdx,
      `setDraft('') must be called after setIsSending(true), not before fetch ` +
        `(else error path loses typed text). Found at index ${m.index}, isSending(true) at ${setIsSendingTrueIdx}`,
    )
  }

  const completeStatusIdx = sendBody.indexOf("status: 'complete'")
  assert.ok(
    completeStatusIdx >= 0,
    "sendMessage must set assistant message status: 'complete' on success",
  )
  for (const m of setDraftOccurrences) {
    assert.ok(
      m.index > completeStatusIdx,
      `setDraft('') must be called after success status update (続 72 fix). ` +
        `Found at index ${m.index}, complete at ${completeStatusIdx}`,
    )
  }
})

test('sendMessage error path does NOT clear draft (続 72 B-3 retry support)', () => {
  // sendMessage 内の error 行 ±範囲に setDraft('') がないこと (コメント除去後)
  const sendStart = source.indexOf('const sendMessage')
  const sendEnd = source.indexOf('[conversationId,', sendStart)
  const sendBody = stripComments(source.slice(sendStart, sendEnd))

  const errorStatusIdx = sendBody.indexOf("status: 'error'")
  assert.ok(errorStatusIdx >= 0, "sendMessage must handle status: 'error'")

  // error の前後 ±300 文字 (sendBody 内) に setDraft('') がないこと
  const proximityStart = Math.max(0, errorStatusIdx - 100)
  const proximityEnd = Math.min(sendBody.length, errorStatusIdx + 300)
  const proximity = sendBody.slice(proximityStart, proximityEnd)
  assert.ok(
    !/setDraft\(['"]['"]\)/.test(proximity),
    `setDraft('') must not appear near error path (続 72 fix retry support). ` +
      `Proximity: ${JSON.stringify(proximity.slice(0, 200))}...`,
  )
})

test('ChatInput component is always rendered (no conditional unmount)', () => {
  // ChatInput は state に関わらず render されること
  // (error / sending state でも unmount されない契約)
  const chatInputUsage = source.match(/<ChatInput\s+/g) ?? []
  assert.equal(
    chatInputUsage.length,
    1,
    'ChatInput must be rendered exactly once unconditionally',
  )
  // 直前に conditional rendering (e.g., `{!isError && <ChatInput`) がないこと
  const chatInputIdx = source.indexOf('<ChatInput')
  const beforeChatInput = source.slice(Math.max(0, chatInputIdx - 50), chatInputIdx)
  assert.ok(
    !/[{?&|]\s*$/.test(beforeChatInput.trim()),
    'ChatInput must not be conditionally rendered. ' +
      `Found preceding text: ${JSON.stringify(beforeChatInput)}`,
  )
})
