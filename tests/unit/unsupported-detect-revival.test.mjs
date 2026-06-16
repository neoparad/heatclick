/**
 * Unit tests: lib/llm/orchestrator.ts detectUnsupportedConcepts 続 82-ml Phase 2 revival
 *
 * Strategy:
 *   .ts は node --test で直 import 不可のため、orchestrator.ts の UNSUPPORTED_KEYWORD_MAP を
 *   source parse で抽出 → detectUnsupportedConcepts と同等の matching ロジックを mirror で実装し、
 *   handoff §3.2 雛形の test ケースに通す。
 *
 * Usage:
 *   node --test tests/unit/unsupported-detect-revival.test.mjs
 *
 * 検証対象 (続 82-ml Phase 2):
 *   - 「オーガニック」「即離脱」「新規」「バウンス」「organic」「リピーター」系は unsupported 検出されない
 *     (Infra 続 82 で schema 配備 + ML Phase 2 で UNSUPPORTED_KEYWORD_MAP から 3 category 削除)
 *   - 「ペルソナ」「ランディングページ」系は引き続き unsupported (Sprint 5 対応予定)
 *   - UNSUPPORTED_KEYWORD_MAP の category list が persona_segment + session_flow の 2 種のみ
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_PATH = join(__dirname, '..', '..', 'lib', 'llm', 'orchestrator.ts')

let cachedSource = null
async function loadOrchestratorSource() {
  if (cachedSource) return cachedSource
  cachedSource = await readFile(ORCHESTRATOR_PATH, 'utf-8')
  return cachedSource
}

/**
 * UNSUPPORTED_KEYWORD_MAP block を source から抽出して { keywords, category } の配列にパース。
 * orchestrator.ts の同名定数と shape 互換。
 */
async function loadUnsupportedKeywordMap() {
  const src = await loadOrchestratorSource()
  const blockMatch = src.match(
    /const UNSUPPORTED_KEYWORD_MAP[\s\S]+?\]\s*\n\s*\n/,
  )
  assert.ok(blockMatch, 'UNSUPPORTED_KEYWORD_MAP block not found in orchestrator.ts')
  const block = blockMatch[0]
  const entryRegex = /\{\s*keywords:\s*\[([^\]]+)\],\s*category:\s*'([a-z_]+)'/g
  const entries = []
  let m
  while ((m = entryRegex.exec(block)) !== null) {
    const keywords = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    entries.push({ keywords, category: m[2] })
  }
  return entries
}

/**
 * orchestrator.detectUnsupportedConcepts と同等 (mirror)。
 * src の UNSUPPORTED_KEYWORD_MAP を bind して動かす。
 */
function detectUnsupportedConceptsMirror(message, map) {
  const lower = message.toLowerCase()
  const found = []
  const seenCategories = new Set()
  for (const entry of map) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase()) && !seenCategories.has(entry.category)) {
        found.push({ keyword: kw, category: entry.category })
        seenCategories.add(entry.category)
        break
      }
    }
  }
  return found
}

test('revival-1: UNSUPPORTED_KEYWORD_MAP に bounce_metric/organic_segment/visitor_repeat が存在しない', async () => {
  const map = await loadUnsupportedKeywordMap()
  const categories = map.map((e) => e.category)
  assert.ok(!categories.includes('bounce_metric'), 'bounce_metric should be removed (Phase 2)')
  assert.ok(!categories.includes('organic_segment'), 'organic_segment should be removed (Phase 2)')
  assert.ok(!categories.includes('visitor_repeat'), 'visitor_repeat should be removed (Phase 2)')
})

test('revival-2: UNSUPPORTED_KEYWORD_MAP は persona_segment + session_flow の 2 種のみ', async () => {
  const map = await loadUnsupportedKeywordMap()
  const categories = map.map((e) => e.category).sort()
  assert.deepEqual(categories, ['persona_segment', 'session_flow'])
})

test('revival-3: 「オーガニックの離脱率」は unsupported に該当しない', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror('オーガニックの離脱率', map)
  assert.deepEqual(found, [], `expected [] but got ${JSON.stringify(found)}`)
})

test('revival-4: 「新規ユーザーの CVR」は unsupported に該当しない', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror('新規ユーザーの CVR', map)
  assert.deepEqual(found, [], `expected [] but got ${JSON.stringify(found)}`)
})

test('revival-5: 「即離脱したユーザー数」は unsupported に該当しない', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror('即離脱したユーザー数', map)
  assert.deepEqual(found, [], `expected [] but got ${JSON.stringify(found)}`)
})

test('revival-6: Owner 元質問「昨日、オーガニックアクセスで、即離脱したユーザー数は何％？」は unsupported に該当しない', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror(
    '昨日、オーガニックアクセスで、即離脱したユーザー数は何％？',
    map,
  )
  assert.deepEqual(found, [], `Owner 元質問は Phase 2 で unblock 必須、got ${JSON.stringify(found)}`)
})

test('revival-7: 「バウンス」「organic」「リピーター」も unsupported に該当しない', async () => {
  const map = await loadUnsupportedKeywordMap()
  for (const q of ['バウンス率', 'organic traffic', 'リピーター比率']) {
    const found = detectUnsupportedConceptsMirror(q, map)
    assert.deepEqual(found, [], `'${q}' should not be unsupported, got ${JSON.stringify(found)}`)
  }
})

test('revival-8: 「ペルソナ別 CVR」は引き続き unsupported (persona_segment、Sprint 5 対応)', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror('ペルソナ別 CVR', map)
  assert.equal(found.length, 1)
  assert.equal(found[0].category, 'persona_segment')
})

test('revival-9: 「ランディングページの離脱」は引き続き unsupported (session_flow、Sprint 5 対応)', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror('ランディングページの離脱', map)
  assert.equal(found.length, 1)
  assert.equal(found[0].category, 'session_flow')
})

test('revival-10: 「segment 別の傾向」も persona_segment を検出 (keyword: segment)', async () => {
  const map = await loadUnsupportedKeywordMap()
  const found = detectUnsupportedConceptsMirror('segment 別の傾向', map)
  assert.equal(found.length, 1)
  assert.equal(found[0].category, 'persona_segment')
})
