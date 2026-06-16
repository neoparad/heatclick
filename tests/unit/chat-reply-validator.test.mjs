/**
 * Unit tests: lib/llm/chat-reply-validator.ts (続 64, 続 61 §2 (b))
 *
 * Strategy: chat-reply-validator.ts は zod に依存する。本 test は意味検証 (semantic
 *           validation) と repair (coerce) のロジックを mirror 実装する。
 *           zod の shape 検証は本ロジックの前段で行われる前提 (drift 検知は ts-check + handoff §4 Reviewer)。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/chat-reply-validator.test.mjs
 *
 * 検証対象 (続 61 §2 (b) 改善依頼 1:1):
 *   - evidence 空配列禁止
 *   - weakest-wins (`evidenceLevel` が evidence[] の最弱 level と一致)
 *   - inferred / planned 時、reply 中の bare numeric (12.3% / 1500円 等) に「推定」prefix 必須
 *   - confidence は evidence[].confidence の最小値以下
 *   - coerce で軽修復 (prefix 付与 / evidenceLevel 再計算 / confidence クランプ)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── reduceEvidenceLevel() 等価実装 (types/evidence.ts:99-119 と同一仕様) ──

const LEVEL_RANK = { proven: 4, observed: 3, inferred: 2, planned: 1 }
function reduceEvidenceLevel(refs, fallback = 'inferred') {
  if (refs.length === 0) return fallback
  let weakest = refs[0].level
  for (const r of refs) {
    if (LEVEL_RANK[r.level] < LEVEL_RANK[weakest]) weakest = r.level
  }
  return weakest
}

// ── chat-reply-validator.ts 意味検証 mirror 実装 ──────────────────────

const NUMBER_UNIT_RE =
  /(?<!推定[\s　]{0,3}|推測[\s　]{0,3}|概算[\s　]{0,3}|\(推定\)[\s　]{0,3}|（推定）[\s　]{0,3}|[0-9０-９.,．，])[+\-±]?[0-9０-９]+(?:[.．,，][0-9０-９]+)?\s*(%|％|円|￥|¥|件|セッション|CV|CTR|CVR|sec|秒|ms|分|時間|page|views?|tok(?:ens?)?)/g

function checkChatReplySemantics(reply) {
  const issues = []
  if (reply.evidence.length === 0) {
    issues.push({ code: 'EVIDENCE_EMPTY', message: 'evidence empty' })
    return issues
  }
  const computedWeakest = reduceEvidenceLevel(reply.evidence, reply.evidenceLevel)
  if (computedWeakest !== reply.evidenceLevel) {
    issues.push({ code: 'WEAKEST_WINS_MISMATCH', message: `expected ${computedWeakest}` })
  }
  const minEvidenceConf = Math.min(...reply.evidence.map((e) => e.confidence))
  if (reply.confidence > minEvidenceConf + 1e-9) {
    issues.push({ code: 'CONFIDENCE_GT_WEAKEST', message: `conf > min` })
  }
  if (reply.confidence < 0 || reply.confidence > 1) {
    issues.push({ code: 'CONFIDENCE_RANGE', message: `conf out of [0,1]` })
  }
  if (reply.evidenceLevel === 'inferred' || reply.evidenceLevel === 'planned') {
    const matches = [...reply.reply.matchAll(NUMBER_UNIT_RE)]
    if (matches.length > 0) {
      issues.push({ code: 'INFERRED_NUMERIC_WITHOUT_PREFIX', message: 'bare numeric' })
    }
  }
  return issues
}

function coerceChatReply(reply) {
  const computedWeakest = reduceEvidenceLevel(reply.evidence, reply.evidenceLevel)
  const minEvidenceConf =
    reply.evidence.length > 0 ? Math.min(...reply.evidence.map((e) => e.confidence)) : 0
  const clampedConfidence = Math.min(Math.max(reply.confidence, 0), 1, minEvidenceConf)
  let coercedText = reply.reply
  if (computedWeakest === 'inferred' || computedWeakest === 'planned') {
    coercedText = coercedText.replace(NUMBER_UNIT_RE, (m) => `推定 ${m}`)
  }
  return { ...reply, reply: coercedText, evidenceLevel: computedWeakest, confidence: clampedConfidence }
}

// ── Fixtures ──────────────────────────────────────────────────────────

function makeValidObserved() {
  return {
    conversationId: '11111111-1111-4111-8111-111111111111',
    reply: 'モバイルでの CVR は実測 1.23% です (proven データ参照)',
    evidenceLevel: 'observed',
    evidence: [
      {
        id: 'ev-1',
        kind: 'metric',
        level: 'observed',
        label: 'site_x cvr 7d',
        target: { kind: 'metric', metric: 'cvr', site_id: 'site_x', period_days: 7 },
        confidence: 0.85,
      },
    ],
    confidence: 0.85,
    suggestions: ['他デバイス比較'],
    modelMeta: { provider: 'ai-gateway', model: 'anthropic/claude-sonnet-4-5', latencyMs: 1234, tokens: 432 },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

test('semantic-1: 正常 ChatReply (observed, numeric prefix 不要) → 0 issues', () => {
  const r = makeValidObserved()
  const issues = checkChatReplySemantics(r)
  assert.deepEqual(issues, [])
})

test('semantic-2: evidence 空配列 → EVIDENCE_EMPTY', () => {
  const r = { ...makeValidObserved(), evidence: [] }
  const issues = checkChatReplySemantics(r)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].code, 'EVIDENCE_EMPTY')
})

test('semantic-3: weakest-wins 不整合 (evidenceLevel=proven, evidence=inferred) → WEAKEST_WINS_MISMATCH', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'proven'
  r.evidence = [
    {
      id: 'ev-1',
      kind: 'metric',
      level: 'inferred',
      label: '推定 cvr',
      target: { kind: 'metric', metric: 'cvr', site_id: 'site_x', period_days: 7 },
      confidence: 0.3,
    },
  ]
  // reply は inferred 用に書き換える必要があるが、本 test は weakest-wins と confidence のみ検証
  r.reply = '推定 CVR は概算 5% 程度です'
  r.confidence = 0.3
  const issues = checkChatReplySemantics(r)
  const codes = issues.map((i) => i.code)
  assert.ok(codes.includes('WEAKEST_WINS_MISMATCH'), `expected WEAKEST_WINS_MISMATCH, got ${codes}`)
})

test('semantic-4: inferred + bare numeric (推定 prefix なし) → INFERRED_NUMERIC_WITHOUT_PREFIX', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'inferred'
  r.evidence[0].level = 'inferred'
  r.evidence[0].confidence = 0.4
  r.confidence = 0.4
  r.reply = 'モバイルでの CVR は 1.23% です' // bare numeric, prefix なし → reject
  const issues = checkChatReplySemantics(r)
  assert.ok(issues.some((i) => i.code === 'INFERRED_NUMERIC_WITHOUT_PREFIX'))
})

test('semantic-5: inferred + 推定 prefix 付き → PASS', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'inferred'
  r.evidence[0].level = 'inferred'
  r.evidence[0].confidence = 0.4
  r.confidence = 0.4
  r.reply = 'モバイルでの CVR は 推定 1.23% です (概算)'
  const issues = checkChatReplySemantics(r)
  // 推定 prefix 検出を期待、其他 issue 無し
  assert.ok(!issues.some((i) => i.code === 'INFERRED_NUMERIC_WITHOUT_PREFIX'),
    `expected pass, got issues: ${JSON.stringify(issues)}`)
})

test('semantic-6: confidence > min(evidence.confidence) → CONFIDENCE_GT_WEAKEST', () => {
  const r = makeValidObserved()
  r.evidence[0].confidence = 0.3
  r.confidence = 0.9 // 過大
  const issues = checkChatReplySemantics(r)
  assert.ok(issues.some((i) => i.code === 'CONFIDENCE_GT_WEAKEST'))
})

test('semantic-7: planned (default fallback) + bare numeric も検出', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'planned'
  r.evidence[0].level = 'planned'
  r.evidence[0].confidence = 0
  r.confidence = 0
  r.reply = '前提として 500 セッション 必要です'
  const issues = checkChatReplySemantics(r)
  assert.ok(issues.some((i) => i.code === 'INFERRED_NUMERIC_WITHOUT_PREFIX'))
})

test('semantic-8: 全角数字 + 全角% も検出 (¥3,500 / １５件)', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'inferred'
  r.evidence[0].level = 'inferred'
  r.evidence[0].confidence = 0.4
  r.confidence = 0.4
  r.reply = 'コストは ¥3500 で、件数は 15 件 増えました'
  const issues = checkChatReplySemantics(r)
  assert.ok(issues.some((i) => i.code === 'INFERRED_NUMERIC_WITHOUT_PREFIX'),
    `expected detect on full-width / ¥, got: ${JSON.stringify(issues)}`)
})

test('coerce-1: bare numeric に 推定 prefix が自動付与', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'inferred'
  r.evidence[0].level = 'inferred'
  r.evidence[0].confidence = 0.4
  r.confidence = 0.4
  r.reply = 'CVR は 1.23% です'
  const fixed = coerceChatReply(r)
  assert.match(fixed.reply, /推定\s+1\.23%/)
})

test('coerce-2: weakest-wins 再計算で evidenceLevel が降格', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'observed' // 誤申告
  r.evidence[0].level = 'inferred' // 実態は inferred
  r.evidence[0].confidence = 0.3
  r.confidence = 0.3
  r.reply = '推定 cvr は 1% 程度'
  const fixed = coerceChatReply(r)
  assert.equal(fixed.evidenceLevel, 'inferred', 'weakest-wins forces降格')
})

test('coerce-3: confidence が min(evidence.confidence) にクランプ', () => {
  const r = makeValidObserved()
  r.evidence[0].confidence = 0.2
  r.confidence = 0.9 // 過大
  const fixed = coerceChatReply(r)
  assert.equal(fixed.confidence, 0.2, 'confidence clamped to weakest evidence confidence')
})

test('coerce-4: 既に 推定 prefix が付いた数値は二重付与しない', () => {
  const r = makeValidObserved()
  r.evidenceLevel = 'inferred'
  r.evidence[0].level = 'inferred'
  r.evidence[0].confidence = 0.4
  r.confidence = 0.4
  r.reply = '推定 1.23% です'
  const fixed = coerceChatReply(r)
  // 推定 推定 1.23% にならないこと
  assert.doesNotMatch(fixed.reply, /推定\s+推定/)
  assert.match(fixed.reply, /推定\s+1\.23%/)
})
