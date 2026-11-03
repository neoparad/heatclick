/**
 * Unit tests: server-side UA bot detection (detectAgentFromUA, 実 worker.ts を直接 import)
 *
 * 背景 (2026-09-25 Jev shadow 評価): Facebook 広告クローラー `meta-externalads/1.1` が
 * client / server 双方の UA リストに無く素通りしていた (サンプル 797 セッション中 12 件)。
 *
 * Usage:
 *   cd ugokimap-saas/workers/event-ingest
 *   node --test test/agent-detect.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { __TEST_ONLY__ } from '../src/worker.ts'

const { detectAgentFromUA } = __TEST_ONLY__

test('detectAgentFromUA is exported for tests', () => {
  assert.equal(typeof detectAgentFromUA, 'function')
})

test('meta-externalads (Facebook ads crawler) is detected as agent', () => {
  const ua = 'meta-externalads/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
  const r = detectAgentFromUA(ua)
  assert.equal(r.is_agent, 1)
  assert.equal(r.agent_type, 'meta-externalads')
})

test('Meta-ExternalAgent (existing entry) still detected and not shadowed by the new entry', () => {
  const r = detectAgentFromUA('meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)')
  assert.equal(r.is_agent, 1)
  assert.equal(r.agent_type, 'Meta-ExternalAgent')
})

test('ordinary Android Chrome is NOT an agent server-side', () => {
  const r = detectAgentFromUA('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36')
  assert.equal(r.is_agent, 0)
  assert.equal(r.agent_type, '')
})

test('empty UA is not an agent', () => {
  assert.deepEqual(detectAgentFromUA(''), { is_agent: 0, agent_type: '' })
})
