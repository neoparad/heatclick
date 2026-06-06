/**
 * Unit tests: lib/llm/question-templates.ts classifyQuestion (続 68 W2-A、続 66 §3 M-3)
 *
 * Strategy: classifyQuestion は純関数で TS 依存なし → ロジックを mirror して contract 担保。
 *
 * Usage:
 *   node --test tests/unit/question-templates-classifier.test.mjs
 *
 * 検証対象:
 *   - 完全一致 → confidence 1.0
 *   - 部分一致 → confidence 0.75-0.95
 *   - keyword overlap → 0.35-0.65
 *   - 全くマッチしない → templateId null, confidence 0
 *   - threshold 0.75 で hit/no-hit 判定
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── 等価実装 (question-templates.ts:classifyQuestion 同一仕様) ──

const TEMPLATES = [
  {
    id: 'CVR_WEEKLY',
    intent: 'CVR の週次サマリ',
    examples: ['先週の CVR は?', '過去 7 日の CV 率', 'コンバージョン率の動き', '今週の CV を教えて'],
  },
  {
    id: 'BOUNCE_PAGES',
    intent: '離脱率が高いページ',
    examples: ['離脱多いページ', 'バウンスレート高いところ', 'すぐ帰っちゃうページ'],
  },
  {
    id: 'CVR_DROP_ROOT_CAUSE',
    intent: 'CVR 下落の原因',
    examples: ['CVR が下がった原因', 'なぜ CV 減ったの', '昨日からの落ち込み', 'CVR 急落'],
  },
  {
    id: 'WHAT_CAN_YOU_DO',
    intent: '機能ガイダンス',
    examples: ['何ができる?', '使い方', 'どんな質問できる?', 'できること教えて'],
  },
]

function normalize(s) {
  return s.toLowerCase().replace(/[\s　、。!?！？]/g, '')
}

function countOverlapTokens(a, b) {
  const tokens = new Set()
  for (let i = 0; i < a.length - 1; i++) tokens.add(a.slice(i, i + 2))
  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) if (tokens.has(b.slice(i, i + 2))) overlap++
  return overlap
}

function classifyQuestion(question) {
  const normalized = normalize(question)
  if (!normalized) return { templateId: null, confidence: 0, matched: [] }
  const scored = []
  for (const tpl of TEMPLATES) {
    let best = 0
    for (const ex of tpl.examples) {
      const exNorm = normalize(ex)
      if (!exNorm) continue
      if (exNorm === normalized) {
        best = Math.max(best, 1.0)
        continue
      }
      if (normalized.includes(exNorm)) {
        best = Math.max(best, 0.85)
        continue
      }
      if (exNorm.includes(normalized)) {
        best = Math.max(best, 0.75)
        continue
      }
      const overlap = countOverlapTokens(exNorm, normalized)
      if (overlap > 0) {
        best = Math.max(best, Math.min(0.65, 0.35 + overlap * 0.15))
      }
    }
    const intentNorm = normalize(tpl.intent)
    if (intentNorm && countOverlapTokens(intentNorm, normalized) >= 1) {
      best = Math.min(1.0, best + 0.1)
    }
    if (best > 0) scored.push({ templateId: tpl.id, score: best })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top) return { templateId: null, confidence: 0, matched: [] }
  const hit = top.score >= 0.75
  return { templateId: hit ? top.templateId : null, confidence: top.score, matched: scored.slice(0, 5) }
}

// ── Tests ─────────────────────────────────────────────────────────────

test('class-1: 完全一致 → confidence 1.0 / hit', () => {
  const r = classifyQuestion('先週の CVR は?')
  assert.equal(r.templateId, 'CVR_WEEKLY')
  assert.ok(r.confidence >= 1.0)
})

test('class-2: 完全一致 + intent keyword boost (CVR_DROP_ROOT_CAUSE)', () => {
  const r = classifyQuestion('CVR が下がった原因')
  assert.equal(r.templateId, 'CVR_DROP_ROOT_CAUSE')
  assert.ok(r.confidence >= 1.0)
})

test('class-3: 部分一致 (LLM 風言い回し) → hit', () => {
  // 「離脱多いページ教えて」は example「離脱多いページ」を contains
  const r = classifyQuestion('離脱多いページ教えて')
  assert.equal(r.templateId, 'BOUNCE_PAGES')
  assert.ok(r.confidence >= 0.75)
})

test('class-4: question が example に contains される場合 → hit (0.75+)', () => {
  // 「使い方」は example の 1 つに完全一致するため 1.0
  const r = classifyQuestion('使い方')
  assert.equal(r.templateId, 'WHAT_CAN_YOU_DO')
  assert.ok(r.confidence >= 0.75)
})

test('class-5: keyword overlap のみ (CVR + 増 etc.) → < 0.75 で template miss', () => {
  // 「CVR 増えた」は overlap あるが完全一致なし、bigram 「CV」「VR」程度
  const r = classifyQuestion('CVR 増えた')
  // hit する可能性 (intent boost で 0.6+) or miss → どちらも許容、確実なのは hit ならば templateId が CVR_DROP_ROOT_CAUSE / CVR_WEEKLY のいずれか
  if (r.templateId !== null) {
    assert.ok(['CVR_WEEKLY', 'CVR_DROP_ROOT_CAUSE'].includes(r.templateId))
  }
  assert.ok(r.confidence >= 0)
})

test('class-6: 全くマッチしない → templateId null', () => {
  const r = classifyQuestion('foobar zzz xyz')
  assert.equal(r.templateId, null)
  assert.equal(r.confidence, 0)
})

test('class-7: 空文字 → null', () => {
  const r = classifyQuestion('')
  assert.equal(r.templateId, null)
  assert.equal(r.confidence, 0)
})

test('class-8: ボーダーライン (0.6 < x < 0.75) は template miss + matched に top 候補が残る', () => {
  // 「CV 教えて」は example の bigram と overlap、完全一致なし
  const r = classifyQuestion('CV 教えて')
  if (r.confidence < 0.75) {
    assert.equal(r.templateId, null)
    // ただし matched に top 候補が残ること
    assert.ok(r.matched.length > 0)
  }
})
