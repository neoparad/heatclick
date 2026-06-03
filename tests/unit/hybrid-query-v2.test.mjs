/**
 * Unit tests: lib/llm/hybrid-query.ts 続 82-ml Phase 2 SQL revival + summary 集計
 *
 * Strategy:
 *   .ts は node --test で直 import 不可のため、orchestrator-routing.test.mjs と同じく
 *   source parse + mirror 等価実装 で contract 担保。実 ClickHouse query は integration 領域 (本続範囲外)。
 *
 * Usage:
 *   node --test tests/unit/hybrid-query-v2.test.mjs
 *
 * 検証対象 (続 82-ml Phase 2):
 *   - ANALYTICS_METRICS に bounce_rate / avg_session_duration が含まれる
 *   - AnalyticsDim union に utm_source / visitor_type が含まれる
 *   - executeAnalyticsQuery の MV SQL に uniqCombined64IfMerge(bounce_sessions) + quantileTDigestMerge が含まれる
 *   - executeAnalyticsQuery の Raw SQL に uniqExactIf(session_end + page_views_in_session<=1 + session_duration_sec<10) +
 *     quantileTDigestIf(session_duration_sec, session_end) が含まれる
 *   - toRawColumn が utm_source / visitor_type で正しい derive 式を返す
 *   - aggregateSummary が bounceRate / avgSessionDurationSec を実値で算出する (sessions = 0 / 全 bucket null では null)
 *   - tenant_id parameter binding が全 SQL に維持されている (cross-tenant 防御)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HYBRID_QUERY_PATH = join(__dirname, '..', '..', 'lib', 'llm', 'hybrid-query.ts')

let cachedSource = null
async function loadSource() {
  if (cachedSource) return cachedSource
  cachedSource = await readFile(HYBRID_QUERY_PATH, 'utf-8')
  return cachedSource
}

// ── aggregateSummary 等価実装 (hybrid-query.ts と同一仕様、Phase 2) ─────

function aggregateSummaryMirror(rows) {
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0)
  const totalConv = rows.reduce((s, r) => s + r.conversions, 0)
  const totalPv = rows.reduce((s, r) => s + r.page_views, 0)
  const totalBounce = rows.reduce((s, r) => s + r.bounce_sessions, 0)
  const bounceRate = totalSessions > 0 ? totalBounce / totalSessions : null

  let durationNumerator = 0
  let durationDenominator = 0
  for (const r of rows) {
    if (r.sessions > 0 && r.p50_duration > 0) {
      durationNumerator += r.p50_duration * r.sessions
      durationDenominator += r.sessions
    }
  }
  const avgSessionDurationSec = durationDenominator > 0 ? durationNumerator / durationDenominator : null

  return {
    sessions: totalSessions,
    conversions: totalConv,
    cvr: totalSessions > 0 ? totalConv / totalSessions : null,
    pageViews: totalPv,
    bounceRate,
    avgSessionDurationSec,
  }
}

// ── Source contract tests ────────────────────────────────────────────

test('hq2-1: ANALYTICS_METRICS に bounce_rate / avg_session_duration を含む', async () => {
  const src = await loadSource()
  const block = src.match(/export const ANALYTICS_METRICS = \[([\s\S]+?)\] as const/)
  assert.ok(block, 'ANALYTICS_METRICS block not found')
  const body = block[1]
  for (const expected of ['cvr', 'page_views', 'sessions', 'bounce_rate', 'avg_session_duration']) {
    assert.ok(body.includes(`'${expected}'`), `ANALYTICS_METRICS must include '${expected}'`)
  }
})

test('hq2-2: AnalyticsDim union に utm_source / visitor_type を含む', async () => {
  const src = await loadSource()
  const block = src.match(/export type AnalyticsDim =([\s\S]+?)\n\s*\n/)
  assert.ok(block, 'AnalyticsDim type union not found')
  const body = block[1]
  for (const expected of ["'page_url'", "'device'", "'utm_source'", "'visitor_type'", "'all'"]) {
    assert.ok(body.includes(expected), `AnalyticsDim must include ${expected}`)
  }
})

test('hq2-3: MV SELECT 句に bounce_sessions + session_duration_td merge が含まれる', async () => {
  const src = await loadSource()
  assert.ok(
    src.includes('uniqCombined64IfMerge(bounce_sessions)'),
    'MV SQL must include uniqCombined64IfMerge(bounce_sessions)',
  )
  assert.ok(
    src.includes('quantileTDigestMerge(0.5)(session_duration_td)'),
    'MV SQL must include quantileTDigestMerge(0.5)(session_duration_td)',
  )
})

test('hq2-4: Raw SELECT 句に session_end 限定の bounce / p50_duration 算出が含まれる', async () => {
  const src = await loadSource()
  // bounce: session_end + page_views_in_session <= 1 + session_duration_sec < 10
  assert.ok(
    /uniqExactIf\(\s*session_id,\s*event_type\s*=\s*'session_end'/.test(src),
    'Raw SQL must include uniqExactIf with session_end filter for bounce_sessions',
  )
  assert.ok(
    /page_views_in_session\s*<=\s*1/.test(src),
    'Raw SQL bounce filter must include page_views_in_session <= 1',
  )
  assert.ok(
    /session_duration_sec\s*<\s*10/.test(src),
    'Raw SQL bounce filter must include session_duration_sec < 10',
  )
  assert.ok(
    src.includes("quantileTDigestIf(0.5)(session_duration_sec, event_type = 'session_end')"),
    'Raw SQL must include quantileTDigestIf p50 session_duration_sec for session_end',
  )
})

test('hq2-5: toRawColumn が utm_source で MV 正規化と整合する derive 式を返す', async () => {
  const src = await loadSource()
  // function 本体に "if(utm_source = '', '__none__', utm_source)" expression が存在
  assert.ok(
    src.includes("\"if(utm_source = '', '__none__', utm_source)\""),
    'toRawColumn must return MV-equivalent utm_source normalization expression',
  )
})

test('hq2-6: toRawColumn が visitor_type で MV 等価の is_first_visit derive 式を返す', async () => {
  const src = await loadSource()
  assert.ok(
    src.includes("\"if(is_first_visit, 'new', 'returning')\""),
    'toRawColumn must return MV-equivalent visitor_type derive expression',
  )
})

test('hq2-7: SQL に tenant_id parameter binding が維持されている (cross-tenant 防御)', async () => {
  const src = await loadSource()
  // mvQuery + rawQuery 両方に tenant_id = {tenant_id:String} が必須
  const tenantBindingCount = (src.match(/tenant_id = \{tenant_id:String\}/g) ?? []).length
  assert.ok(
    tenantBindingCount >= 3,
    `tenant_id parameter binding must appear in MV + raw + contributors SQL (>=3), got ${tenantBindingCount}`,
  )
})

test('hq2-8: verify metric expr に bounce_rate / avg_session_duration が含まれる', async () => {
  const src = await loadSource()
  // executeVerifyQuery 内の switch case
  assert.ok(/case 'bounce_rate':/.test(src), "verify must have case 'bounce_rate'")
  assert.ok(/case 'avg_session_duration':/.test(src), "verify must have case 'avg_session_duration'")
})

// ── aggregateSummary 計算ロジック ────────────────────────────────────

test('hq2-9: aggregateSummary bounceRate = sum(bounce_sessions) / sum(sessions)', () => {
  const rows = [
    { bucket_start: 'b1', sessions: 100, conversions: 5, page_views: 250, bounce_sessions: 30, p50_duration: 45, source: 'mv' },
    { bucket_start: 'b2', sessions: 200, conversions: 10, page_views: 480, bounce_sessions: 50, p50_duration: 60, source: 'mv' },
  ]
  const summary = aggregateSummaryMirror(rows)
  assert.equal(summary.sessions, 300)
  assert.equal(summary.conversions, 15)
  assert.equal(summary.pageViews, 730)
  assert.equal(summary.cvr, 15 / 300)
  // bounceRate = (30 + 50) / 300 = 0.2666...
  assert.ok(Math.abs(summary.bounceRate - 80 / 300) < 1e-9, `bounceRate expected ${80 / 300}, got ${summary.bounceRate}`)
  // avgSessionDurationSec = (45 * 100 + 60 * 200) / 300 = (4500 + 12000) / 300 = 55
  assert.equal(summary.avgSessionDurationSec, 55)
})

test('hq2-10: aggregateSummary sessions=0 で bounceRate / avgSessionDurationSec が null', () => {
  const rows = [
    { bucket_start: 'b1', sessions: 0, conversions: 0, page_views: 0, bounce_sessions: 0, p50_duration: 0, source: 'mv' },
  ]
  const summary = aggregateSummaryMirror(rows)
  assert.equal(summary.sessions, 0)
  assert.equal(summary.cvr, null)
  assert.equal(summary.bounceRate, null)
  assert.equal(summary.avgSessionDurationSec, null)
})

test('hq2-11: aggregateSummary p50_duration=0 の bucket を duration 加重から除外', () => {
  const rows = [
    // session_end イベント未到達 bucket (sessions>0 だが p50=0)
    { bucket_start: 'b1', sessions: 50, conversions: 2, page_views: 100, bounce_sessions: 0, p50_duration: 0, source: 'mv' },
    // session_end 到達 bucket
    { bucket_start: 'b2', sessions: 100, conversions: 5, page_views: 250, bounce_sessions: 20, p50_duration: 30, source: 'mv' },
  ]
  const summary = aggregateSummaryMirror(rows)
  // bounceRate は両方の sessions で割る (caveat は文言注釈で説明)
  assert.equal(summary.sessions, 150)
  assert.ok(Math.abs(summary.bounceRate - 20 / 150) < 1e-9)
  // avgSessionDurationSec は p50>0 の bucket だけで加重平均 (b1 は除外)
  assert.equal(summary.avgSessionDurationSec, 30)
})

test('hq2-12: aggregateSummary 空 rows で全 metric null/0', () => {
  const summary = aggregateSummaryMirror([])
  assert.equal(summary.sessions, 0)
  assert.equal(summary.conversions, 0)
  assert.equal(summary.pageViews, 0)
  assert.equal(summary.cvr, null)
  assert.equal(summary.bounceRate, null)
  assert.equal(summary.avgSessionDurationSec, null)
})

test('hq2-13: aggregateSummary mixed MV + raw row source で総和が正しい', () => {
  const rows = [
    { bucket_start: 'b1', sessions: 100, conversions: 5, page_views: 200, bounce_sessions: 30, p50_duration: 40, source: 'mv' },
    { bucket_start: 'b2', sessions: 50, conversions: 2, page_views: 110, bounce_sessions: 10, p50_duration: 50, source: 'raw' },
  ]
  const summary = aggregateSummaryMirror(rows)
  assert.equal(summary.sessions, 150)
  assert.equal(summary.conversions, 7)
  assert.equal(summary.pageViews, 310)
  // bounce = 40 / 150
  assert.ok(Math.abs(summary.bounceRate - 40 / 150) < 1e-9)
  // duration weighted = (40 * 100 + 50 * 50) / 150 = (4000 + 2500) / 150 = 43.333...
  const expected = (40 * 100 + 50 * 50) / 150
  assert.ok(Math.abs(summary.avgSessionDurationSec - expected) < 1e-9)
})

// ── Phase 2 削除 marker (skeleton 残骸の sanity check) ───────────────

test('hq2-14: skeleton phase の「常に null」コメント残骸が削除されている', async () => {
  const src = await loadSource()
  // skeleton phase で書いた「現状 (skeleton phase) は常に null」は Phase 2 で除去済を確認
  assert.ok(
    !src.includes('現状 (skeleton phase) は常に null'),
    'Phase 2 で skeleton-always-null コメントを削除すべき',
  )
})

// ── 続 83 ClickHouse Code 386 (no supertype String, DateTime('Asia/Tokyo')) regression ──

test('hq2-15: 時間比較の toDateTime(str, tz) が外側 toDateTime() で plain DateTime に統一されている', async () => {
  const src = await loadSource()
  // 修正後は `toDateTime(toDateTime({...:String}, {tz:String}))` 形 (tz tag 剥がし) のみが存在し、
  // 素の `toDateTime({...:String}, {tz:String})` を比較/least/greatest に直接渡す形は無いこと。
  //
  // 唯一の例外: rawQuery の bucket label 生成 `formatDateTime(toStartOf*(timestamp, {tz:String}), ...)`
  //   これは比較ではなく表示用の tz-aware bucketing なので対象外。

  // 1) 包んだ形が少なくとも MV(2) + raw(2) + contributors(2) + drilldown(2) + verify(2) = 10 箇所
  const wrapped = (src.match(/toDateTime\(toDateTime\(\{(?:start|end):String\}, \{tz:String\}\)\)/g) ?? []).length
  assert.ok(
    wrapped >= 10,
    `wrapped toDateTime(toDateTime(...)) must appear >=10 times (MV/raw/contributors/drilldown/verify), got ${wrapped}`,
  )

  // 2) bucket_start / timestamp の比較に「素の」toDateTime(str, tz) が直接現れないこと。
  //    包んだ形を一旦除去してから素形を探す (誤検出回避)。
  const stripped = src.replace(/toDateTime\(toDateTime\(\{(?:start|end):String\}, \{tz:String\}\)\)/g, '__WRAPPED__')
  const bareInCompare = /(?:bucket_start|timestamp)\s*[<>=]+\s*[^\n]*toDateTime\(\{(?:start|end):String\}, \{tz:String\}\)/.test(
    stripped,
  )
  assert.ok(
    !bareInCompare,
    'bucket_start / timestamp の比較に素の toDateTime(str, tz) (DateTime(tz)) を直接渡してはならない (Code 386)',
  )
})

test('hq2-16: tz-aware bucket label 生成 (formatDateTime + toStartOf*) は維持されている', async () => {
  const src = await loadSource()
  // raw 側の表示ラベルは tz-aware bucketing を維持 (Asia/Tokyo の壁時計でラベル化)。
  assert.ok(
    /formatDateTime\(\$\{tierBucketFn\}\(timestamp, \{tz:String\}\)/.test(src),
    'raw query は formatDateTime(toStartOf*(timestamp, tz)) で tz-aware ラベルを維持すべき',
  )
})
