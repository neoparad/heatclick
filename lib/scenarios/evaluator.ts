/**
 * M-Director Sprint M-1 (2026-05-25): Scenario condition AST evaluator
 *
 * Reference: linkscrawl/docs/fusion/team/m-director/dsl-spec.md §7
 *
 * This module is the canonical evaluator used by:
 *   - server-side dry-run preview (lib/scenarios/preview.ts)
 *   - unit tests (tests/unit/scenario-evaluator.test.mjs)
 *   - public/scenario-runtime.js (mirrored implementation in vanilla JS)
 *
 * Performance target: < 10ms per scenario per event (dsl-spec §7).
 * Idempotency: same (ast, ctx) MUST return same boolean.
 */

import { isLeaf, type ConditionNode, type LeafComparison } from './types'

export interface EvaluationContext {
  tenant_id?: string
  site_id?: string
  visitor_id?: string
  session_id?: string
  is_first_visit?: boolean
  session_duration_sec?: number
  page_views_in_session?: number
  url_path?: string
  url_query?: string
  referrer_host?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  device_type?: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  visited_paths?: string[]
  scroll_depth_max_pct?: number
  cart_value?: number
  language?: string
  hour_of_day?: number
  is_agent?: boolean
  persona_label?: string
  predicted_intent?: string
  [key: string]: unknown
}

export interface EvaluationResult {
  matched: boolean
  evaluation_ms: number
  reason?: string
}

export function evaluate(node: ConditionNode, ctx: EvaluationContext): EvaluationResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let matched: boolean
  let reason: string | undefined
  try {
    matched = evaluateNode(node, ctx)
  } catch (err) {
    matched = false
    reason = err instanceof Error ? err.message : 'evaluation error'
  }
  const end = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    matched,
    evaluation_ms: Math.max(0, Math.round(end - start)),
    reason,
  }
}

function evaluateNode(node: ConditionNode, ctx: EvaluationContext): boolean {
  if (isLeaf(node)) {
    return evaluateLeaf(node, ctx)
  }
  switch (node.op) {
    case 'AND':
      return node.children.every((c) => evaluateNode(c, ctx))
    case 'OR':
      return node.children.some((c) => evaluateNode(c, ctx))
    case 'NOT':
      if (node.children.length !== 1) {
        return false
      }
      return !evaluateNode(node.children[0], ctx)
    default:
      return false
  }
}

function evaluateLeaf(node: LeafComparison, ctx: EvaluationContext): boolean {
  const v = ctx[node.field]
  const target = node.value

  switch (node.op) {
    case 'EQ':
      return v === target
    case 'NEQ':
      return v !== target
    case 'GT':
      return typeof v === 'number' && typeof target === 'number' && v > target
    case 'GTE':
      return typeof v === 'number' && typeof target === 'number' && v >= target
    case 'LT':
      return typeof v === 'number' && typeof target === 'number' && v < target
    case 'LTE':
      return typeof v === 'number' && typeof target === 'number' && v <= target
    case 'IN':
      return Array.isArray(target) && (target as unknown[]).includes(v)
    case 'NOT_IN':
      return Array.isArray(target) && !(target as unknown[]).includes(v)
    case 'CONTAINS':
      return typeof v === 'string' && typeof target === 'string' && v.includes(target)
    case 'STARTS_WITH':
      return typeof v === 'string' && typeof target === 'string' && v.startsWith(target)
    case 'ENDS_WITH':
      return typeof v === 'string' && typeof target === 'string' && v.endsWith(target)
    case 'MATCHES_REGEX':
      if (typeof target !== 'string' || typeof v !== 'string') return false
      try {
        return new RegExp(target).test(v)
      } catch {
        return false
      }
    case 'VISITED':
      return Array.isArray(ctx.visited_paths) && typeof target === 'string' && ctx.visited_paths.includes(target)
    case 'NOT_VISITED':
      return (
        typeof target === 'string' &&
        (!Array.isArray(ctx.visited_paths) || !ctx.visited_paths.includes(target))
      )
    case 'EXISTS':
      return v !== undefined && v !== null && v !== ''
    case 'NOT_EXISTS':
      return v === undefined || v === null || v === ''
    default:
      return false
  }
}

/**
 * Hash an AST to a stable sha256 hex string (matched_condition_hash column).
 * Implementation note: order matters in AND/OR children to avoid semantic-equal but hash-different ASTs.
 * Client-side (scenario-runtime.js) MUST use the same canonicalization to stay in sync.
 */
export function canonicalizeAst(node: ConditionNode): string {
  if (isLeaf(node)) {
    return JSON.stringify({ op: node.op, field: node.field, value: node.value ?? null })
  }
  const childCanon = node.children.map((c) => canonicalizeAst(c))
  // For AND/OR (commutative), sort children to stabilize hash.
  const stable = node.op === 'NOT' ? childCanon : [...childCanon].sort()
  return JSON.stringify({ op: node.op, children: stable })
}
