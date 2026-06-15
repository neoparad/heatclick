/**
 * condition-ast-ops.test.ts — E で追加した pure helper の単体テスト
 *
 * 既存 helper (cast/add/remove/update leaf) は tests/unit/scenarios-condition-ops.test.mjs で
 * mirror テスト済。本ファイルは E 追加分 (field meta / cast 警告判定 / NOT / nested group) を検証。
 */

import {
  addGroupAt,
  addLeafAt,
  canUseNot,
  castLeafForField,
  castLeafValueForOp,
  fieldMeta,
  makeDefaultGroup,
  makeDefaultLeaf,
  opChangeAltersValue,
  operatorLabel,
  operatorsForField,
  totalLeafCount,
  updateChildAt,
  valueKindForLeaf,
} from './condition-ast-ops'
import { ConditionNodeSchema, type CompositeNode, type LeafComparison } from './types'

describe('operatorLabel (演算子の日本語ラベル)', () => {
  it('returns symbol + Japanese for comparison operators', () => {
    expect(operatorLabel('GTE')).toBe('≥ 以上')
    expect(operatorLabel('EQ')).toBe('＝ 等しい')
    expect(operatorLabel('NOT_VISITED')).toBe('未訪問')
  })
})

describe('operatorsForField (field 型別の演算子候補)', () => {
  it('number field offers numeric comparisons, not text ops', () => {
    const ops = operatorsForField('session_duration_sec')
    expect(ops).toEqual(expect.arrayContaining(['EQ', 'GT', 'GTE', 'LTE']))
    expect(ops).not.toContain('CONTAINS')
    expect(ops).not.toContain('MATCHES_REGEX')
    expect(ops).not.toContain('VISITED')
  })

  it('string field offers text ops, not numeric comparisons', () => {
    const ops = operatorsForField('utm_source')
    expect(ops).toEqual(expect.arrayContaining(['EQ', 'CONTAINS', 'STARTS_WITH']))
    expect(ops).not.toContain('GTE')
    expect(ops).not.toContain('GT')
  })

  it('boolean field offers only equality/existence', () => {
    expect(operatorsForField('is_first_visit')).toEqual(['EQ', 'NEQ', 'EXISTS', 'NOT_EXISTS'])
  })

  it('always includes the current op even if outside the field-type set (legacy safety)', () => {
    const ops = operatorsForField('session_duration_sec', 'CONTAINS')
    expect(ops[0]).toBe('CONTAINS')
    expect(ops).toContain('GTE')
  })
})

describe('fieldMeta', () => {
  it('returns label + hint for a known field', () => {
    expect(fieldMeta('utm_source').label).toMatch(/utm_source/)
    expect(fieldMeta('device_type').hint).toMatch(/mobile/)
  })

  it('falls back for an unknown field', () => {
    const m = fieldMeta('weird_custom')
    expect(m.label).toBe('weird_custom')
    expect(m.hint).toMatch(/カスタム/)
  })
})

describe('opChangeAltersValue (cast 警告)', () => {
  const strLeaf: LeafComparison = { op: 'EQ', field: 'utm_source', value: 'google' }

  it('false when the op is unchanged', () => {
    expect(opChangeAltersValue(strLeaf, 'EQ')).toBe(false)
  })

  it('false for EQ → NEQ (both string, value kept)', () => {
    expect(opChangeAltersValue(strLeaf, 'NEQ')).toBe(false)
  })

  it('true for EQ(string) → GT(number) (value casts away)', () => {
    expect(opChangeAltersValue(strLeaf, 'GT')).toBe(true)
  })

  it('true for EQ → EXISTS (value cleared)', () => {
    expect(opChangeAltersValue(strLeaf, 'EXISTS')).toBe(true)
  })

  it('false for GT → LT (number kept)', () => {
    const numLeaf: LeafComparison = { op: 'GT', field: 'cart_value', value: 100 }
    expect(opChangeAltersValue(numLeaf, 'LT')).toBe(false)
  })
})

describe('canUseNot', () => {
  it('true when the group has exactly 1 child', () => {
    expect(canUseNot({ op: 'AND', children: [makeDefaultLeaf()] })).toBe(true)
  })

  it('false when the group has >1 child', () => {
    expect(canUseNot({ op: 'AND', children: [makeDefaultLeaf(), makeDefaultLeaf()] })).toBe(false)
  })
})

describe('valueKindForLeaf (field-aware, Codex MEDIUM fix)', () => {
  it('EQ/NEQ on a boolean field → boolean', () => {
    expect(valueKindForLeaf('is_first_visit', 'EQ')).toBe('boolean')
    expect(valueKindForLeaf('is_agent', 'NEQ')).toBe('boolean')
  })

  it('EQ on a number field → number; on a string field → string', () => {
    expect(valueKindForLeaf('cart_value', 'EQ')).toBe('number')
    expect(valueKindForLeaf('utm_source', 'EQ')).toBe('string')
  })

  it('GT is always number regardless of field type', () => {
    expect(valueKindForLeaf('utm_source', 'GT')).toBe('number')
  })

  it('IN → number_list on a number field, string_list on a string field', () => {
    expect(valueKindForLeaf('cart_value', 'IN')).toBe('number_list')
    expect(valueKindForLeaf('utm_source', 'IN')).toBe('string_list')
  })

  it('CONTAINS stays string even on a number field; EXISTS → none', () => {
    expect(valueKindForLeaf('cart_value', 'CONTAINS')).toBe('string')
    expect(valueKindForLeaf('is_first_visit', 'EXISTS')).toBe('none')
  })
})

describe('castLeafForField / field-aware cast', () => {
  it('coerces value when switching string field → boolean field', () => {
    const leaf: LeafComparison = { op: 'EQ', field: 'utm_source', value: 'google' }
    const next = castLeafForField(leaf, 'is_first_visit')
    expect(next.field).toBe('is_first_visit')
    expect(typeof next.value).toBe('boolean')
    expect(next.op).toBe('EQ')
  })

  it('EQ→NEQ on a boolean field keeps the boolean (no string coercion)', () => {
    const leaf: LeafComparison = { op: 'EQ', field: 'is_first_visit', value: true }
    expect(castLeafValueForOp(leaf, 'NEQ').value).toBe(true)
    expect(opChangeAltersValue(leaf, 'NEQ')).toBe(false)
  })
})

describe('nested group helpers (E)', () => {
  it('addGroupAt appends a composite child and the result is a valid AST', () => {
    const root: CompositeNode = { op: 'AND', children: [makeDefaultLeaf()] }
    const next = addGroupAt(root, makeDefaultGroup())
    expect(next.children).toHaveLength(2)
    expect(next.children[1]).toMatchObject({ op: 'OR' })
    expect(ConditionNodeSchema.safeParse(next).success).toBe(true)
  })

  it('updateChildAt writes back an edited nested group', () => {
    const nested = makeDefaultGroup()
    const root: CompositeNode = { op: 'AND', children: [makeDefaultLeaf(), nested] }
    const editedNested = addLeafAt(nested, makeDefaultLeaf())
    const next = updateChildAt(root, 1, editedNested)
    const child = next.children[1]
    expect(child).toMatchObject({ op: 'OR' })
    if ('children' in child) expect(child.children).toHaveLength(2)
  })

  it('updateChildAt is a no-op for an out-of-range index (same ref)', () => {
    const root: CompositeNode = { op: 'AND', children: [makeDefaultLeaf()] }
    expect(updateChildAt(root, 5, makeDefaultLeaf())).toBe(root)
  })

  it('totalLeafCount counts nested leaves', () => {
    const root: CompositeNode = {
      op: 'AND',
      children: [makeDefaultLeaf(), { op: 'OR', children: [makeDefaultLeaf(), makeDefaultLeaf()] }],
    }
    expect(totalLeafCount(root)).toBe(3)
  })
})
