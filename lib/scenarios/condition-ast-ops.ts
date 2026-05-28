/**
 * M-Director Stage 4 (続 M-11) — Condition AST mutation helpers
 *
 * Visual builder UI が AST を操作するための pure / immutable helpers。
 * すべて新しい AST tree を返す (immutability for React state setter)、
 * 元の AST は変更しない。
 *
 * Reference:
 *   - lib/scenarios/types.ts (LEAF_OPERATORS, ALLOWED_FIELDS, depth/leaf limits)
 *   - 続 M-9 §6 #2 (Stage 4 着工計画)
 *   - dsl-spec.md §2 (AST 構造 SSOT)
 *
 * 設計判断 (Phase 2 MVP):
 *   - 単一 root group (AND/OR/NOT) + 平坦な leaf 列 のみ対応
 *   - nested group (子に composite を持つ) は Stage 5+ で UI 化、本ファイルは
 *     データレベルで保持 (clone 時に preserve)
 *   - NOT は children=1 制約あり、UI は AND/OR のみ提供
 */

import {
  ALLOWED_FIELDS,
  ConditionNodeSchema,
  isComposite,
  isLeaf,
  LEAF_OPERATORS,
  type AllowedField,
  type CompositeNode,
  type CompositeOperator,
  type ConditionNode,
  type LeafComparison,
  type LeafOperator,
} from './types'

// ── default values ────────────────────────────────────────────────────────

export const DEFAULT_FIELD: AllowedField = 'utm_source'
export const DEFAULT_OPERATOR: LeafOperator = 'EQ'
export const DEFAULT_VALUE = ''

/** 新規 scenario 作成時の初期 AST */
export function emptyConditionAst(): CompositeNode {
  return {
    op: 'AND',
    children: [makeDefaultLeaf()],
  }
}

export function makeDefaultLeaf(): LeafComparison {
  return {
    op: DEFAULT_OPERATOR,
    field: DEFAULT_FIELD,
    value: DEFAULT_VALUE,
  }
}

// ── leaf-level operators ──────────────────────────────────────────────────
//
// 「値の型 (string/number/boolean/list)」をオペレーターから推定するためのテーブル。
// Visual builder UI 側で input control を切り替える際に使う。

export type ValueKind = 'string' | 'number' | 'boolean' | 'string_list' | 'number_list' | 'none'

const OP_VALUE_KIND: Record<LeafOperator, ValueKind> = {
  EQ: 'string',
  NEQ: 'string',
  GT: 'number',
  GTE: 'number',
  LT: 'number',
  LTE: 'number',
  IN: 'string_list',
  NOT_IN: 'string_list',
  CONTAINS: 'string',
  STARTS_WITH: 'string',
  ENDS_WITH: 'string',
  MATCHES_REGEX: 'string',
  VISITED: 'string',
  NOT_VISITED: 'string',
  EXISTS: 'none',
  NOT_EXISTS: 'none',
}

export function valueKindFor(op: LeafOperator): ValueKind {
  return OP_VALUE_KIND[op] ?? 'string'
}

// ── group operators (Phase 2 = AND/OR、Phase 3 で NOT UI 化) ───────────────

export const GROUP_OPERATORS_UI: readonly CompositeOperator[] = ['AND', 'OR'] as const

// ── leaf mutation helpers (immutable) ─────────────────────────────────────

export function addLeafAt(root: CompositeNode, leaf: LeafComparison): CompositeNode {
  return {
    op: root.op,
    children: [...root.children, leaf],
  }
}

export function removeLeafAt(root: CompositeNode, index: number): CompositeNode {
  if (index < 0 || index >= root.children.length) return root
  const next = root.children.filter((_, i) => i !== index)
  // 最低 1 件は保持 (Zod: children.min(1))
  if (next.length === 0) {
    return {
      op: root.op,
      children: [makeDefaultLeaf()],
    }
  }
  return { op: root.op, children: next }
}

export function updateLeafAt(
  root: CompositeNode,
  index: number,
  patch: Partial<LeafComparison>,
): CompositeNode {
  const current = root.children[index]
  if (!current || !isLeaf(current)) return root
  const merged: LeafComparison = {
    op: patch.op ?? current.op,
    field: patch.field ?? current.field,
    // value は patch で渡された場合のみ更新。op 変更時は型整合を呼び出し側 (UI) が担保
    value: 'value' in patch ? patch.value : current.value,
  }
  return {
    op: root.op,
    children: root.children.map((c, i) => (i === index ? merged : c)),
  }
}

export function setGroupOp(root: CompositeNode, newOp: CompositeOperator): CompositeNode {
  if (root.op === newOp) return root
  // NOT は children=1 制約あり、UI からは AND/OR のみ。NOT は Phase 3 で別 UI。
  return {
    op: newOp,
    children: root.children,
  }
}

// ── op 変更時の value 自動 cast ────────────────────────────────────────────

/**
 * leaf の op を変えたとき、value の型を新 op に合わせて変換する。
 * UI 側から「op だけ変えた」場合に呼ぶと、value が不正な型のまま残らない。
 */
export function castLeafValueForOp(current: LeafComparison, newOp: LeafOperator): LeafComparison {
  const kind = valueKindFor(newOp)
  let nextValue: LeafComparison['value']
  switch (kind) {
    case 'number':
      nextValue = typeof current.value === 'number' ? current.value : Number(current.value) || 0
      break
    case 'boolean':
      nextValue = typeof current.value === 'boolean' ? current.value : false
      break
    case 'string_list':
      nextValue = Array.isArray(current.value)
        ? (current.value as string[]).map(String)
        : typeof current.value === 'string' && current.value.length > 0
          ? current.value.split(',').map((s) => s.trim())
          : []
      break
    case 'number_list':
      nextValue = Array.isArray(current.value)
        ? (current.value as Array<string | number>).map((v) => Number(v) || 0)
        : []
      break
    case 'none':
      // EXISTS / NOT_EXISTS は value 不要
      nextValue = undefined
      break
    case 'string':
    default:
      nextValue = typeof current.value === 'string' ? current.value : String(current.value ?? '')
  }
  return {
    op: newOp,
    field: current.field,
    value: nextValue,
  }
}

// ── normalize: flatten root if not composite (legacy AST 互換) ─────────────

/**
 * 既存 scenario の AST が leaf 直書きの場合 (root が LeafComparison) に
 * AND group でラップして UI から扱いやすくする。
 */
export function ensureCompositeRoot(ast: ConditionNode): CompositeNode {
  if (isComposite(ast)) return ast
  return {
    op: 'AND',
    children: [ast],
  }
}

/**
 * leaf 一覧として root の children を取得 (nested composite は除外)
 */
export function rootLeaves(root: CompositeNode): LeafComparison[] {
  return root.children.filter(isLeaf)
}

/**
 * nested composite 子の数 (UI で「Stage 5+ で render」プレースホルダ表示用)
 */
export function rootNestedGroupCount(root: CompositeNode): number {
  return root.children.filter(isComposite).length
}

// ── validation pass-through ───────────────────────────────────────────────

export function isValidAst(ast: ConditionNode): { ok: true } | { ok: false; message: string } {
  const result = ConditionNodeSchema.safeParse(ast)
  if (!result.success) {
    return { ok: false, message: result.error.issues.map((i) => i.message).join('; ') }
  }
  return { ok: true }
}

// ── re-exports for UI ──────────────────────────────────────────────────────

export { ALLOWED_FIELDS, LEAF_OPERATORS, isLeaf, isComposite }
export type { AllowedField, LeafOperator, CompositeOperator, ConditionNode, LeafComparison, CompositeNode }
