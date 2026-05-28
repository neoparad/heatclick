/**
 * Unit tests: lib/scenarios/condition-ast-ops
 * (M-Director Stage 4 / 続 M-11、2026-05-28)
 *
 * Reference:
 *   - lib/scenarios/condition-ast-ops.ts (AST mutation helpers)
 *   - lib/scenarios/types.ts (LEAF_OPERATORS, ALLOWED_FIELDS)
 *   - 続 M-9 §6 #2 (Stage 4 着工計画)
 *
 * Strategy: mirror condition-ast-ops.ts logic in plain JS (existing convention).
 *
 * Usage:
 *   node --test tests/unit/scenarios-condition-ops.test.mjs
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ── Mirror: leaf vs composite ─────────────────────────────────────────────

const LEAF_OPS = new Set([
  'EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE',
  'IN', 'NOT_IN',
  'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES_REGEX',
  'VISITED', 'NOT_VISITED',
  'EXISTS', 'NOT_EXISTS',
])

const isLeaf = (n) => LEAF_OPS.has(n.op)

// ── Mirror: castLeafValueForOp ────────────────────────────────────────────

const VALUE_KIND = {
  EQ: 'string', NEQ: 'string',
  GT: 'number', GTE: 'number', LT: 'number', LTE: 'number',
  IN: 'string_list', NOT_IN: 'string_list',
  CONTAINS: 'string', STARTS_WITH: 'string', ENDS_WITH: 'string',
  MATCHES_REGEX: 'string', VISITED: 'string', NOT_VISITED: 'string',
  EXISTS: 'none', NOT_EXISTS: 'none',
}

function valueKindFor(op) { return VALUE_KIND[op] ?? 'string' }

function castLeafValueForOp(current, newOp) {
  const kind = valueKindFor(newOp)
  let nextValue
  switch (kind) {
    case 'number':
      nextValue = typeof current.value === 'number' ? current.value : Number(current.value) || 0
      break
    case 'boolean':
      nextValue = typeof current.value === 'boolean' ? current.value : false
      break
    case 'string_list':
      nextValue = Array.isArray(current.value)
        ? current.value.map(String)
        : typeof current.value === 'string' && current.value.length > 0
          ? current.value.split(',').map((s) => s.trim())
          : []
      break
    case 'none':
      nextValue = undefined
      break
    default:
      nextValue = typeof current.value === 'string' ? current.value : String(current.value ?? '')
  }
  return { op: newOp, field: current.field, value: nextValue }
}

// ── Mirror: emptyConditionAst / makeDefaultLeaf ───────────────────────────

function makeDefaultLeaf() {
  return { op: 'EQ', field: 'utm_source', value: '' }
}

function emptyConditionAst() {
  return { op: 'AND', children: [makeDefaultLeaf()] }
}

// ── Mirror: addLeafAt / removeLeafAt / updateLeafAt / setGroupOp ──────────

function addLeafAt(root, leaf) {
  return { op: root.op, children: [...root.children, leaf] }
}

function removeLeafAt(root, index) {
  if (index < 0 || index >= root.children.length) return root
  const next = root.children.filter((_, i) => i !== index)
  if (next.length === 0) {
    return { op: root.op, children: [makeDefaultLeaf()] }
  }
  return { op: root.op, children: next }
}

function updateLeafAt(root, index, patch) {
  const current = root.children[index]
  if (!current || !isLeaf(current)) return root
  const merged = {
    op: patch.op ?? current.op,
    field: patch.field ?? current.field,
    value: 'value' in patch ? patch.value : current.value,
  }
  return {
    op: root.op,
    children: root.children.map((c, i) => (i === index ? merged : c)),
  }
}

function setGroupOp(root, newOp) {
  if (root.op === newOp) return root
  return { op: newOp, children: root.children }
}

// ── Mirror: ensureCompositeRoot ───────────────────────────────────────────

function ensureCompositeRoot(ast) {
  if (!isLeaf(ast)) return ast
  return { op: 'AND', children: [ast] }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('§1 emptyConditionAst / makeDefaultLeaf', () => {
  test('emptyConditionAst returns AND with 1 default leaf', () => {
    const ast = emptyConditionAst()
    assert.equal(ast.op, 'AND')
    assert.equal(ast.children.length, 1)
    assert.equal(ast.children[0].field, 'utm_source')
    assert.equal(ast.children[0].op, 'EQ')
  })
  test('makeDefaultLeaf is a fresh object each call (no shared reference)', () => {
    const a = makeDefaultLeaf()
    const b = makeDefaultLeaf()
    assert.notEqual(a, b)
    a.value = 'mutated'
    assert.notEqual(a.value, b.value)
  })
})

describe('§2 valueKindFor (op → input type)', () => {
  test('EQ / NEQ / CONTAINS → string', () => {
    assert.equal(valueKindFor('EQ'), 'string')
    assert.equal(valueKindFor('NEQ'), 'string')
    assert.equal(valueKindFor('CONTAINS'), 'string')
  })
  test('GT / GTE / LT / LTE → number', () => {
    assert.equal(valueKindFor('GT'), 'number')
    assert.equal(valueKindFor('LTE'), 'number')
  })
  test('IN / NOT_IN → string_list', () => {
    assert.equal(valueKindFor('IN'), 'string_list')
  })
  test('EXISTS / NOT_EXISTS → none', () => {
    assert.equal(valueKindFor('EXISTS'), 'none')
  })
})

describe('§3 castLeafValueForOp (op 変更時の value 型自動 cast)', () => {
  test('string → number (parse OK)', () => {
    const next = castLeafValueForOp({ op: 'EQ', field: 'x', value: '42' }, 'GT')
    assert.equal(next.value, 42)
    assert.equal(next.op, 'GT')
  })
  test('string → number (parse fail → 0)', () => {
    const next = castLeafValueForOp({ op: 'EQ', field: 'x', value: 'abc' }, 'GT')
    assert.equal(next.value, 0)
  })
  test('string → string_list (CSV split)', () => {
    const next = castLeafValueForOp({ op: 'EQ', field: 'x', value: 'a, b, c' }, 'IN')
    assert.deepEqual(next.value, ['a', 'b', 'c'])
  })
  test('number → string (toString)', () => {
    const next = castLeafValueForOp({ op: 'GT', field: 'x', value: 42 }, 'EQ')
    assert.equal(next.value, '42')
  })
  test('any → EXISTS drops value (undefined)', () => {
    const next = castLeafValueForOp({ op: 'EQ', field: 'x', value: 'abc' }, 'EXISTS')
    assert.equal(next.value, undefined)
  })
  test('empty string → string_list (empty array)', () => {
    const next = castLeafValueForOp({ op: 'EQ', field: 'x', value: '' }, 'IN')
    assert.deepEqual(next.value, [])
  })
})

describe('§4 addLeafAt / removeLeafAt (immutability)', () => {
  test('addLeafAt appends a new leaf', () => {
    const root = emptyConditionAst()
    const next = addLeafAt(root, { op: 'GT', field: 'page_views_in_session', value: 5 })
    assert.equal(next.children.length, 2)
    assert.equal(next.children[1].field, 'page_views_in_session')
    // original untouched
    assert.equal(root.children.length, 1)
  })
  test('removeLeafAt removes the indexed leaf', () => {
    const root = { op: 'AND', children: [
      { op: 'EQ', field: 'a', value: '1' },
      { op: 'EQ', field: 'b', value: '2' },
      { op: 'EQ', field: 'c', value: '3' },
    ]}
    const next = removeLeafAt(root, 1)
    assert.equal(next.children.length, 2)
    assert.equal(next.children[0].field, 'a')
    assert.equal(next.children[1].field, 'c')
  })
  test('removeLeafAt keeps at least 1 default leaf if all removed', () => {
    const root = { op: 'AND', children: [{ op: 'EQ', field: 'a', value: '1' }] }
    const next = removeLeafAt(root, 0)
    assert.equal(next.children.length, 1)
    assert.equal(next.children[0].field, 'utm_source') // default
  })
  test('removeLeafAt with invalid index returns same tree', () => {
    const root = emptyConditionAst()
    const next = removeLeafAt(root, 99)
    assert.equal(next.children.length, 1)
  })
})

describe('§5 updateLeafAt (partial patch)', () => {
  test('updates field only, keeps op + value', () => {
    const root = { op: 'AND', children: [{ op: 'EQ', field: 'a', value: 'x' }] }
    const next = updateLeafAt(root, 0, { field: 'b' })
    assert.equal(next.children[0].field, 'b')
    assert.equal(next.children[0].op, 'EQ')
    assert.equal(next.children[0].value, 'x')
  })
  test('updates value only', () => {
    const root = { op: 'AND', children: [{ op: 'EQ', field: 'a', value: 'x' }] }
    const next = updateLeafAt(root, 0, { value: 'y' })
    assert.equal(next.children[0].value, 'y')
  })
  test('updates value to undefined explicitly (EXISTS path)', () => {
    const root = { op: 'AND', children: [{ op: 'EQ', field: 'a', value: 'x' }] }
    const next = updateLeafAt(root, 0, { value: undefined })
    assert.equal(next.children[0].value, undefined)
  })
  test('invalid index → unchanged', () => {
    const root = emptyConditionAst()
    const next = updateLeafAt(root, 99, { field: 'x' })
    assert.deepEqual(next, root)
  })
})

describe('§6 setGroupOp', () => {
  test('switches AND → OR preserving children', () => {
    const root = { op: 'AND', children: [{ op: 'EQ', field: 'a', value: '1' }] }
    const next = setGroupOp(root, 'OR')
    assert.equal(next.op, 'OR')
    assert.equal(next.children.length, 1)
  })
  test('no-op when same op', () => {
    const root = { op: 'AND', children: [{ op: 'EQ', field: 'a', value: '1' }] }
    const next = setGroupOp(root, 'AND')
    assert.equal(next, root) // same reference
  })
})

describe('§7 ensureCompositeRoot (legacy leaf-root AST wrap)', () => {
  test('wraps leaf root in AND group', () => {
    const leaf = { op: 'EQ', field: 'a', value: '1' }
    const wrapped = ensureCompositeRoot(leaf)
    assert.equal(wrapped.op, 'AND')
    assert.equal(wrapped.children.length, 1)
    assert.equal(wrapped.children[0], leaf)
  })
  test('passes through composite root unchanged', () => {
    const root = { op: 'OR', children: [{ op: 'EQ', field: 'a', value: '1' }] }
    assert.equal(ensureCompositeRoot(root), root)
  })
})

describe('§8 Phase 2 invariants', () => {
  test('AND group with all leaves passes Zod-like leaf shape', () => {
    const ast = {
      op: 'AND',
      children: [
        { op: 'EQ', field: 'utm_source', value: 'google' },
        { op: 'GTE', field: 'session_duration_sec', value: 60 },
        { op: 'EQ', field: 'is_first_visit', value: true },
      ],
    }
    for (const c of ast.children) {
      assert.ok(isLeaf(c))
      assert.ok(typeof c.field === 'string')
      assert.ok(LEAF_OPS.has(c.op))
    }
  })
  test('Stage 4 MVP supports AND + OR but not NOT in UI', () => {
    // NOT is preserved in data but UI exposes only AND/OR
    const root = { op: 'NOT', children: [{ op: 'EQ', field: 'a', value: '1' }] }
    // setGroupOp can change to AND or OR but UI buttons only have AND/OR
    const next = setGroupOp(root, 'AND')
    assert.equal(next.op, 'AND')
  })
})
