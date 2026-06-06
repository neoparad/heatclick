/**
 * Unit tests: lib/llm/question-templates.ts 53 件達成 + categories balanced (続 70 補強、続 82-ml skeleton 拡張)
 *
 * Strategy: question-templates.ts の `QUESTION_TEMPLATES` 配列を file から static parse して count。
 *           TS 直 import は test runner 制約で不可なので、`grep`/正規表現で `id: '...'` を数える。
 *
 * Usage:
 *   node --test tests/unit/templates-count.test.mjs
 *
 * 検証対象 (続 66 §3 M-3 / 続 70 補強 / 続 82-ml skeleton):
 *   - 続 70: 50 件 (metric_baseline 10 / metric_breakdown 13 / anomaly 10 / comparison 10 / guidance 7)
 *   - 続 82-ml skeleton: +3 件 (ORGANIC_TRAFFIC_SHARE / ORGANIC_BOUNCE_RATE / NEW_VS_RETURNING_CVR)
 *     - ORGANIC_TRAFFIC_SHARE → metric_breakdown
 *     - ORGANIC_BOUNCE_RATE → metric_baseline
 *     - NEW_VS_RETURNING_CVR → metric_breakdown
 *   - 合計 53 件、metric_baseline 11 / metric_breakdown 15 / anomaly 10 / comparison 10 / guidance 7
 *   - 各 template に id / examples / category / answerSkeleton / evidenceLevel / estimatedLatencyMs が定義
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_PATH = join(__dirname, '..', '..', 'lib', 'llm', 'question-templates.ts')

let cached = null
async function loadTemplatesFile() {
  if (cached) return cached
  cached = await readFile(TEMPLATES_PATH, 'utf-8')
  return cached
}

// 続 82-ml skeleton: 50 + 3 = 53 件 (ORGANIC_TRAFFIC_SHARE / ORGANIC_BOUNCE_RATE / NEW_VS_RETURNING_CVR 追加)
const EXPECTED_TOTAL = 53
const EXPECTED_BY_CATEGORY = {
  metric_baseline: 11, // 10 (続 70) + 1 (ORGANIC_BOUNCE_RATE)
  metric_breakdown: 15, // 13 (続 70) + 2 (ORGANIC_TRAFFIC_SHARE / NEW_VS_RETURNING_CVR)
  anomaly: 10,
  comparison: 10,
  guidance: 7,
}

test(`templates-1: 全 templates 数 = ${EXPECTED_TOTAL} 件`, async () => {
  const src = await loadTemplatesFile()
  // QUESTION_TEMPLATES = [ ... ] as const 配列内の `id: '...'` だけを数える
  const idMatches = src.match(/^\s{4}id:\s*'[A-Z_0-9]+'/gm) ?? []
  assert.equal(
    idMatches.length,
    EXPECTED_TOTAL,
    `expected ${EXPECTED_TOTAL} templates, found ${idMatches.length}`,
  )
})

test('templates-2: 各 category 配分 (11/15/10/10/7 = 53)', async () => {
  const src = await loadTemplatesFile()
  const count = (re) => (src.match(re) ?? []).length
  const baseline = count(/^\s{4}category:\s*'metric_baseline'/gm)
  const breakdown = count(/^\s{4}category:\s*'metric_breakdown'/gm)
  const anomaly = count(/^\s{4}category:\s*'anomaly'/gm)
  const comparison = count(/^\s{4}category:\s*'comparison'/gm)
  const guidance = count(/^\s{4}category:\s*'guidance'/gm)

  assert.equal(baseline, EXPECTED_BY_CATEGORY.metric_baseline, `metric_baseline expected ${EXPECTED_BY_CATEGORY.metric_baseline}, got ${baseline}`)
  assert.equal(breakdown, EXPECTED_BY_CATEGORY.metric_breakdown, `metric_breakdown expected ${EXPECTED_BY_CATEGORY.metric_breakdown}, got ${breakdown}`)
  assert.equal(anomaly, EXPECTED_BY_CATEGORY.anomaly, `anomaly expected ${EXPECTED_BY_CATEGORY.anomaly}, got ${anomaly}`)
  assert.equal(comparison, EXPECTED_BY_CATEGORY.comparison, `comparison expected ${EXPECTED_BY_CATEGORY.comparison}, got ${comparison}`)
  assert.equal(guidance, EXPECTED_BY_CATEGORY.guidance, `guidance expected ${EXPECTED_BY_CATEGORY.guidance}, got ${guidance}`)
  assert.equal(
    baseline + breakdown + anomaly + comparison + guidance,
    EXPECTED_TOTAL,
    `sum must equal ${EXPECTED_TOTAL}`,
  )
})

test('templates-3: 各 template に必須 field が存在', async () => {
  const src = await loadTemplatesFile()
  // 必須 field: id / intent / examples / toolPlan / answerSkeleton / evidenceLevel / estimatedLatencyMs / category
  const count = (re) => (src.match(re) ?? []).length
  const ids = count(/^\s{4}id:\s*'/gm)
  const intents = count(/^\s{4}intent:\s*'/gm)
  const examples = count(/^\s{4}examples:\s*\[/gm)
  const toolPlans = count(/^\s{4}toolPlan:\s*\[/gm)
  const skeletons = count(/^\s{4}answerSkeleton:/gm)
  const evidenceLevels = count(/^\s{4}evidenceLevel:\s*'/gm)
  const latencies = count(/^\s{4}estimatedLatencyMs:\s*\d+/gm)
  const categories = count(/^\s{4}category:\s*'/gm)

  assert.equal(ids, EXPECTED_TOTAL)
  assert.equal(intents, EXPECTED_TOTAL)
  assert.equal(examples, EXPECTED_TOTAL)
  assert.equal(toolPlans, EXPECTED_TOTAL)
  assert.equal(skeletons, EXPECTED_TOTAL)
  assert.equal(evidenceLevels, EXPECTED_TOTAL)
  assert.equal(latencies, EXPECTED_TOTAL)
  assert.equal(categories, EXPECTED_TOTAL)
})

test('templates-4: evidenceLevel は 5-tier V2 (proven_exact / observed_exact / observed_approx / inferred / planned) のいずれか', async () => {
  const src = await loadTemplatesFile()
  // 全 evidenceLevel 値を抽出
  const matches = src.match(/^\s{4}evidenceLevel:\s*'(\w+)'/gm) ?? []
  const ALLOWED = new Set(['proven_exact', 'observed_exact', 'observed_approx', 'inferred', 'planned'])
  for (const m of matches) {
    const value = m.match(/'(\w+)'/)?.[1]
    assert.ok(ALLOWED.has(value), `template evidenceLevel '${value}' not in 5-tier V2`)
  }
})

test('templates-5: id 形式 (uppercase + underscore + digits) + unique', async () => {
  const src = await loadTemplatesFile()
  const ids = [...src.matchAll(/^\s{4}id:\s*'([A-Z_0-9]+)'/gm)].map((m) => m[1])
  assert.equal(ids.length, EXPECTED_TOTAL)
  const unique = new Set(ids)
  assert.equal(unique.size, EXPECTED_TOTAL, `expected all unique ids, got ${EXPECTED_TOTAL - unique.size} duplicates`)
})

test('templates-6: 続 82-ml skeleton 3 新規 template が存在', async () => {
  const src = await loadTemplatesFile()
  const ids = [...src.matchAll(/^\s{4}id:\s*'([A-Z_0-9]+)'/gm)].map((m) => m[1])
  for (const expected of ['ORGANIC_TRAFFIC_SHARE', 'ORGANIC_BOUNCE_RATE', 'NEW_VS_RETURNING_CVR']) {
    assert.ok(ids.includes(expected), `expected new template '${expected}' to exist`)
  }
})
