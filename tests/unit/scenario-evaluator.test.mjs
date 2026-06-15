/**
 * Unit tests: lib/scenarios/evaluator + types (M-Director Sprint M-1, 2026-05-25)
 *
 * Reference: linkscrawl/docs/fusion/team/m-director/dsl-spec.md §6 (sample scenarios)
 *
 * Strategy: equivalent JS impl of lib/scenarios/evaluator.ts so tests run with
 * pure `node --test` (no TS toolchain). Keep in lockstep with the TS source.
 *
 * Usage:
 *   node --test tests/unit/scenario-evaluator.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Equivalent JS impl (mirrors lib/scenarios/evaluator.ts) ──

const LEAF_OPS = new Set([
  'EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE',
  'IN', 'NOT_IN',
  'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES_REGEX',
  'VISITED', 'NOT_VISITED',
  'EXISTS', 'NOT_EXISTS',
])

function isLeaf(node) { return LEAF_OPS.has(node.op) }

function evaluate(node, ctx) {
  if (isLeaf(node)) return evalLeaf(node, ctx)
  switch (node.op) {
    case 'AND': return (node.children || []).every((c) => evaluate(c, ctx))
    case 'OR':  return (node.children || []).some((c) => evaluate(c, ctx))
    case 'NOT': return node.children.length === 1 && !evaluate(node.children[0], ctx)
    default: return false
  }
}

function evalLeaf(n, ctx) {
  const v = ctx[n.field]
  const t = n.value
  switch (n.op) {
    case 'EQ': return v === t
    case 'NEQ': return v !== t
    case 'GT': return typeof v === 'number' && typeof t === 'number' && v > t
    case 'GTE': return typeof v === 'number' && typeof t === 'number' && v >= t
    case 'LT': return typeof v === 'number' && typeof t === 'number' && v < t
    case 'LTE': return typeof v === 'number' && typeof t === 'number' && v <= t
    case 'IN': return Array.isArray(t) && t.includes(v)
    case 'NOT_IN': return Array.isArray(t) && !t.includes(v)
    case 'CONTAINS': return typeof v === 'string' && typeof t === 'string' && v.includes(t)
    case 'STARTS_WITH': return typeof v === 'string' && typeof t === 'string' && v.startsWith(t)
    case 'ENDS_WITH': return typeof v === 'string' && typeof t === 'string' && v.endsWith(t)
    case 'MATCHES_REGEX':
      if (typeof t !== 'string' || typeof v !== 'string') return false
      try { return new RegExp(t).test(v) } catch { return false }
    case 'VISITED': return Array.isArray(ctx.visited_paths) && typeof t === 'string' && ctx.visited_paths.includes(t)
    case 'NOT_VISITED': return typeof t === 'string' && (!Array.isArray(ctx.visited_paths) || !ctx.visited_paths.includes(t))
    case 'EXISTS': return v !== undefined && v !== null && v !== ''
    case 'NOT_EXISTS': return v === undefined || v === null || v === ''
    default: return false
  }
}

function canonicalizeAst(node) {
  if (isLeaf(node)) {
    return JSON.stringify({ op: node.op, field: node.field, value: node.value ?? null })
  }
  const childCanon = node.children.map((c) => canonicalizeAst(c))
  const stable = node.op === 'NOT' ? childCanon : [...childCanon].sort()
  return JSON.stringify({ op: node.op, children: stable })
}

// ── dsl-spec.md §6 samples ──

const SAMPLE_1 = {
  op: 'AND',
  children: [
    { op: 'EQ', field: 'is_first_visit', value: true },
    { op: 'GTE', field: 'session_duration_sec', value: 60 },
    { op: 'NOT_VISITED', field: 'url_path', value: '/cart' },
  ],
}

const SAMPLE_2 = {
  op: 'AND',
  children: [
    { op: 'EQ', field: 'utm_medium', value: 'organic' },
    { op: 'GTE', field: 'page_views_in_session', value: 3 },
    { op: 'STARTS_WITH', field: 'url_path', value: '/entry/' },
  ],
}

const SAMPLE_3 = {
  op: 'AND',
  children: [
    { op: 'EQ', field: 'is_first_visit', value: false },
    { op: 'GTE', field: 'scroll_depth_max_pct', value: 80 },
    {
      op: 'AND',
      children: [
        { op: 'GTE', field: 'hour_of_day', value: 12 },
        { op: 'LTE', field: 'hour_of_day', value: 14 },
      ],
    },
  ],
}

const SAMPLE_4 = {
  op: 'AND',
  children: [
    { op: 'EQ', field: 'device_type', value: 'mobile' },
    { op: 'EQ', field: 'utm_medium', value: 'cpc' },
    { op: 'VISITED', field: 'url_path', value: '/cart' },
  ],
}

const SAMPLE_5 = {
  op: 'OR',
  children: [
    { op: 'EQ', field: 'is_agent', value: true },
    {
      op: 'AND',
      children: [
        { op: 'EQ', field: 'is_first_visit', value: true },
        { op: 'GTE', field: 'session_duration_sec', value: 120 },
      ],
    },
  ],
}

// PoC scenario from lib/scenarios/poc-scenario.ts
const POC = {
  op: 'AND',
  children: [
    { op: 'EQ', field: 'utm_medium', value: 'organic' },
    { op: 'GTE', field: 'session_duration_sec', value: 60 },
    { op: 'GTE', field: 'page_views_in_session', value: 3 },
    { op: 'NOT_VISITED', field: 'url_path', value: '/cart' },
    { op: 'EQ', field: 'is_first_visit', value: true },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample 1: 初回 + 60s + cart 未到達
// ─────────────────────────────────────────────────────────────────────────────
test('SAMPLE_1: matches first-visit + 90s + no /cart', () => {
  const ctx = { is_first_visit: true, session_duration_sec: 90, visited_paths: ['/home', '/about'] }
  assert.equal(evaluate(SAMPLE_1, ctx), true)
})

test('SAMPLE_1: fails when /cart visited', () => {
  const ctx = { is_first_visit: true, session_duration_sec: 90, visited_paths: ['/home', '/cart'] }
  assert.equal(evaluate(SAMPLE_1, ctx), false)
})

test('SAMPLE_1: fails when session < 60s', () => {
  const ctx = { is_first_visit: true, session_duration_sec: 30, visited_paths: [] }
  assert.equal(evaluate(SAMPLE_1, ctx), false)
})

test('SAMPLE_1: fails when not first visit', () => {
  const ctx = { is_first_visit: false, session_duration_sec: 90, visited_paths: [] }
  assert.equal(evaluate(SAMPLE_1, ctx), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Sample 2: organic + 3 PV + /entry/* path
// ─────────────────────────────────────────────────────────────────────────────
test('SAMPLE_2: matches organic + 3 PV + /entry/*', () => {
  const ctx = { utm_medium: 'organic', page_views_in_session: 3, url_path: '/entry/tirtir-cushion' }
  assert.equal(evaluate(SAMPLE_2, ctx), true)
})

test('SAMPLE_2: fails when path is not /entry/*', () => {
  const ctx = { utm_medium: 'organic', page_views_in_session: 3, url_path: '/products/foo' }
  assert.equal(evaluate(SAMPLE_2, ctx), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Sample 3: nested AND with hour-of-day range
// ─────────────────────────────────────────────────────────────────────────────
test('SAMPLE_3: nested AND hour range 13 matches', () => {
  const ctx = { is_first_visit: false, scroll_depth_max_pct: 85, hour_of_day: 13 }
  assert.equal(evaluate(SAMPLE_3, ctx), true)
})

test('SAMPLE_3: hour 11 fails (below range)', () => {
  const ctx = { is_first_visit: false, scroll_depth_max_pct: 85, hour_of_day: 11 }
  assert.equal(evaluate(SAMPLE_3, ctx), false)
})

test('SAMPLE_3: hour 15 fails (above range)', () => {
  const ctx = { is_first_visit: false, scroll_depth_max_pct: 85, hour_of_day: 15 }
  assert.equal(evaluate(SAMPLE_3, ctx), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Sample 4: mobile + cpc + VISITED /cart
// ─────────────────────────────────────────────────────────────────────────────
test('SAMPLE_4: VISITED operator matches when path in history', () => {
  const ctx = { device_type: 'mobile', utm_medium: 'cpc', visited_paths: ['/products', '/cart'] }
  assert.equal(evaluate(SAMPLE_4, ctx), true)
})

test('SAMPLE_4: fails when /cart not in history', () => {
  const ctx = { device_type: 'mobile', utm_medium: 'cpc', visited_paths: ['/products'] }
  assert.equal(evaluate(SAMPLE_4, ctx), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Sample 5: OR branch
// ─────────────────────────────────────────────────────────────────────────────
test('SAMPLE_5: OR left branch (is_agent) matches', () => {
  const ctx = { is_agent: true }
  assert.equal(evaluate(SAMPLE_5, ctx), true)
})

test('SAMPLE_5: OR right branch (first-visit + 120s) matches', () => {
  const ctx = { is_agent: false, is_first_visit: true, session_duration_sec: 130 }
  assert.equal(evaluate(SAMPLE_5, ctx), true)
})

test('SAMPLE_5: neither branch fails', () => {
  const ctx = { is_agent: false, is_first_visit: false, session_duration_sec: 30 }
  assert.equal(evaluate(SAMPLE_5, ctx), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// PoC scenario (lib/scenarios/poc-scenario.ts)
// ─────────────────────────────────────────────────────────────────────────────
test('PoC: positive match — first visit organic 90s 3 PV no /cart', () => {
  const ctx = {
    utm_medium: 'organic',
    session_duration_sec: 90,
    page_views_in_session: 3,
    visited_paths: ['/entry/foo', '/products/bar'],
    is_first_visit: true,
  }
  assert.equal(evaluate(POC, ctx), true)
})

test('PoC: negative — /cart visited', () => {
  const ctx = {
    utm_medium: 'organic',
    session_duration_sec: 90,
    page_views_in_session: 3,
    visited_paths: ['/cart'],
    is_first_visit: true,
  }
  assert.equal(evaluate(POC, ctx), false)
})

test('PoC: negative — repeat visitor', () => {
  const ctx = {
    utm_medium: 'organic',
    session_duration_sec: 90,
    page_views_in_session: 3,
    visited_paths: [],
    is_first_visit: false,
  }
  assert.equal(evaluate(POC, ctx), false)
})

test('PoC: negative — paid medium', () => {
  const ctx = {
    utm_medium: 'cpc',
    session_duration_sec: 90,
    page_views_in_session: 3,
    visited_paths: [],
    is_first_visit: true,
  }
  assert.equal(evaluate(POC, ctx), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// AST hash stability
// ─────────────────────────────────────────────────────────────────────────────
test('canonicalizeAst: AND order is stable (commutative)', () => {
  const a = { op: 'AND', children: [
    { op: 'EQ', field: 'utm_medium', value: 'organic' },
    { op: 'GTE', field: 'session_duration_sec', value: 60 },
  ]}
  const b = { op: 'AND', children: [
    { op: 'GTE', field: 'session_duration_sec', value: 60 },
    { op: 'EQ', field: 'utm_medium', value: 'organic' },
  ]}
  assert.equal(canonicalizeAst(a), canonicalizeAst(b))
})

test('canonicalizeAst: NOT order is fixed (non-commutative arity 1)', () => {
  const a = { op: 'NOT', children: [{ op: 'EQ', field: 'is_first_visit', value: true }] }
  const b = { op: 'NOT', children: [{ op: 'EQ', field: 'is_first_visit', value: false }] }
  assert.notEqual(canonicalizeAst(a), canonicalizeAst(b))
})

test('canonicalizeAst: different ASTs hash differently', () => {
  const a = { op: 'EQ', field: 'utm_medium', value: 'organic' }
  const b = { op: 'EQ', field: 'utm_medium', value: 'cpc' }
  assert.notEqual(canonicalizeAst(a), canonicalizeAst(b))
})

// ─────────────────────────────────────────────────────────────────────────────
// NOT arity guard
// ─────────────────────────────────────────────────────────────────────────────
test('NOT with 2 children evaluates false (invalid arity)', () => {
  const bad = {
    op: 'NOT',
    children: [
      { op: 'EQ', field: 'is_first_visit', value: true },
      { op: 'EQ', field: 'is_first_visit', value: false },
    ],
  }
  assert.equal(evaluate(bad, { is_first_visit: true }), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Type-mismatch defensive behavior
// ─────────────────────────────────────────────────────────────────────────────
test('GTE returns false when ctx value is missing', () => {
  const node = { op: 'GTE', field: 'session_duration_sec', value: 60 }
  assert.equal(evaluate(node, {}), false)
})

test('CONTAINS returns false when ctx value is not a string', () => {
  const node = { op: 'CONTAINS', field: 'utm_source', value: 'google' }
  assert.equal(evaluate(node, { utm_source: 42 }), false)
})

test('MATCHES_REGEX returns false for invalid pattern', () => {
  const node = { op: 'MATCHES_REGEX', field: 'url_path', value: '[' }
  assert.equal(evaluate(node, { url_path: '/foo' }), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// A/B/C deterministic split (mirrors public/scenario-runtime.js pickVariant)
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h
}

function pickVariant(scenario, visitorId) {
  const variants = scenario.variants || []
  if (variants.length === 0) return null
  if (variants.length === 1) return variants[0]
  const bucket = fnv1a(visitorId + ':' + scenario.id) % 100
  let cum = 0
  for (const v of variants) {
    cum += v.traffic_split || 0
    if (bucket < cum) return v
  }
  return variants[variants.length - 1]
}

const SC_ABC = {
  id: 'sc-abc-test',
  variants: [
    { id: 'A', traffic_split: 34 },
    { id: 'B', traffic_split: 33 },
    { id: 'C', traffic_split: 33 },
  ],
}

test('pickVariant: same visitor + scenario always returns same variant', () => {
  const vid = 'visitor-xyz-001'
  const r1 = pickVariant(SC_ABC, vid)
  const r2 = pickVariant(SC_ABC, vid)
  const r3 = pickVariant(SC_ABC, vid)
  assert.equal(r1.id, r2.id)
  assert.equal(r2.id, r3.id)
})

test('pickVariant: different visitors map to different variants over a sample', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    seen.add(pickVariant(SC_ABC, 'visitor-' + i).id)
  }
  assert.equal(seen.size, 3) // all three variants seen
})

test('pickVariant: split ratio is approximately respected (200 sample, ±10%)', () => {
  const counts = { A: 0, B: 0, C: 0 }
  for (let i = 0; i < 200; i++) {
    counts[pickVariant(SC_ABC, 'visitor-' + i).id]++
  }
  // Allow ±10% absolute deviation from expected 68 / 66 / 66
  assert.ok(counts.A >= 50 && counts.A <= 86, `A=${counts.A} out of expected ~68`)
  assert.ok(counts.B >= 50 && counts.B <= 84, `B=${counts.B} out of expected ~66`)
  assert.ok(counts.C >= 50 && counts.C <= 84, `C=${counts.C} out of expected ~66`)
})

test('pickVariant: single-variant scenario returns that variant', () => {
  const sc = { id: 'solo', variants: [{ id: 'A', traffic_split: 100 }] }
  assert.equal(pickVariant(sc, 'any-visitor').id, 'A')
})

test('pickVariant: empty variants returns null', () => {
  const sc = { id: 'empty', variants: [] }
  assert.equal(pickVariant(sc, 'any'), null)
})

test('pickVariant: 50/50 split distributes roughly evenly over 200 visitors', () => {
  const sc = { id: 'ab', variants: [{ id: 'A', traffic_split: 50 }, { id: 'B', traffic_split: 50 }] }
  const counts = { A: 0, B: 0 }
  for (let i = 0; i < 200; i++) {
    counts[pickVariant(sc, 'visitor-' + i).id]++
  }
  assert.ok(Math.abs(counts.A - counts.B) < 50, `imbalanced: A=${counts.A} B=${counts.B}`)
})

test('pickVariant: different scenario id with same visitor gives independent assignment', () => {
  const sc1 = { id: 'scenario-1', variants: [{ id: 'A', traffic_split: 50 }, { id: 'B', traffic_split: 50 }] }
  const sc2 = { id: 'scenario-2', variants: [{ id: 'A', traffic_split: 50 }, { id: 'B', traffic_split: 50 }] }
  // Find at least one visitor where assignment differs between the two scenarios
  let found = false
  for (let i = 0; i < 50; i++) {
    if (pickVariant(sc1, 'visitor-' + i).id !== pickVariant(sc2, 'visitor-' + i).id) {
      found = true
      break
    }
  }
  assert.ok(found, 'expected at least one visitor to differ between scenarios')
})
