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

/**
 * field の実型も考慮した value 入力 kind (E)。
 * EQ/NEQ は field の型 (boolean/number/string) に合わせる。これがないと
 * 例: `is_first_visit EQ` が string 入力になり、runtime の厳密等価で `"true" !== true` となり
 * 永久に不一致になる (Codex review 指摘)。GT 系は常に number、IN は number field なら number_list。
 */
export function valueKindForLeaf(field: string, op: LeafOperator): ValueKind {
  const opKind = valueKindFor(op)
  if (opKind === 'none' || opKind === 'number' || opKind === 'number_list') return opKind
  if (opKind === 'string_list') {
    return fieldValueType(field) === 'number' ? 'number_list' : 'string_list'
  }
  if (op === 'EQ' || op === 'NEQ') {
    const t = fieldValueType(field)
    return t === 'boolean' ? 'boolean' : t === 'number' ? 'number' : 'string'
  }
  // CONTAINS / STARTS_WITH / ENDS_WITH / MATCHES_REGEX / VISITED / NOT_VISITED は文字列演算。
  return 'string'
}

// ── field メタ情報 (UI: 日本語ラベル / 値ヒント) ───────────────────────────

export type FieldValueType = 'string' | 'number' | 'boolean'

export interface FieldMeta {
  label: string
  hint: string
  /** EQ/NEQ で入力 UI を出し分けるための field の実型 (runtime ctx の型に一致させる)。 */
  valueType: FieldValueType
}

export const FIELD_META: Record<AllowedField, FieldMeta> = {
  tenant_id: { label: 'テナントID', hint: '内部識別子', valueType: 'string' },
  site_id: { label: 'サイトID', hint: '計測対象サイト', valueType: 'string' },
  visitor_id: { label: '訪問者ID', hint: 'Cookie ベースの匿名ID', valueType: 'string' },
  session_id: { label: 'セッションID', hint: '1 回の訪問', valueType: 'string' },
  is_first_visit: { label: '初回訪問か', hint: 'true / false', valueType: 'boolean' },
  session_count: { label: '訪問回数(セッション数)', hint: '例: 3 (3回目の訪問)。30分以上空くと新セッション', valueType: 'number' },
  session_duration_sec: { label: '滞在秒数', hint: '例: 60 (秒)', valueType: 'number' },
  page_views_in_session: { label: 'PV数(セッション)', hint: '例: 3', valueType: 'number' },
  url_path: { label: 'URLパス', hint: '例: /entry/foo', valueType: 'string' },
  url_query: { label: 'URLクエリ', hint: '例: utm_source=google', valueType: 'string' },
  referrer_host: { label: '参照元ホスト', hint: '例: google.com', valueType: 'string' },
  utm_source: { label: '流入元 (utm_source)', hint: '例: google, newsletter', valueType: 'string' },
  utm_medium: { label: '流入媒体 (utm_medium)', hint: '例: organic, cpc', valueType: 'string' },
  utm_campaign: { label: 'キャンペーン (utm_campaign)', hint: '例: spring_sale', valueType: 'string' },
  device_type: { label: 'デバイス種別', hint: 'desktop / mobile / tablet', valueType: 'string' },
  visited_paths: { label: '訪問済パス一覧', hint: 'VISITED/NOT_VISITED で使用', valueType: 'string' },
  scroll_depth_max_pct: { label: '最大スクロール率(%)', hint: '例: 80', valueType: 'number' },
  cart_value: { label: 'カート金額', hint: '例: 5000', valueType: 'number' },
  language: { label: '言語', hint: '例: ja, en', valueType: 'string' },
  hour_of_day: { label: '時刻 (0-23)', hint: '例: 13', valueType: 'number' },
  is_agent: { label: 'エージェント経由か', hint: 'true / false', valueType: 'boolean' },
  persona_label: { label: 'ペルソナ (ML推定)', hint: '推定セグメント', valueType: 'string' },
  predicted_intent: { label: '推定インテント (ML)', hint: '推定購買意欲', valueType: 'string' },
}

export function fieldMeta(field: string): FieldMeta {
  return (
    (FIELD_META as Record<string, FieldMeta>)[field] ?? {
      label: field,
      hint: 'カスタム field',
      valueType: 'string',
    }
  )
}

export function fieldValueType(field: string): FieldValueType {
  return fieldMeta(field).valueType
}

// ── group operators (Phase 2 = AND/OR。E で NOT を children=1 のとき有効化) ──

export const GROUP_OPERATORS_UI: readonly CompositeOperator[] = ['AND', 'OR'] as const
export const GROUP_OPERATORS_ALL: readonly CompositeOperator[] = ['AND', 'OR', 'NOT'] as const

/** NOT は children=1 のときのみ妥当 (types.ts の Zod superRefine 制約)。 */
export function canUseNot(root: CompositeNode): boolean {
  return root.children.length === 1
}

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
/** value を指定 kind に合わせて coerce (op / field 変更時の共通処理)。 */
export function coerceValueForKind(
  value: LeafComparison['value'],
  kind: ValueKind,
): LeafComparison['value'] {
  switch (kind) {
    case 'number':
      return typeof value === 'number' ? value : Number(value) || 0
    case 'boolean':
      return typeof value === 'boolean' ? value : false
    case 'string_list':
      return Array.isArray(value)
        ? (value as Array<string | number>).map(String)
        : typeof value === 'string' && value.length > 0
          ? value.split(',').map((s) => s.trim())
          : []
    case 'number_list':
      return Array.isArray(value)
        ? (value as Array<string | number>).map((v) => Number(v) || 0)
        : typeof value === 'string' && value.length > 0
          ? value.split(',').map((s) => Number(s.trim()) || 0)
          : []
    case 'none':
      return undefined
    case 'string':
    default:
      return typeof value === 'string' ? value : String(value ?? '')
  }
}

/** leaf の op を変えたとき、value を新 op (+ field 型) の kind に合わせて変換する。 */
export function castLeafValueForOp(current: LeafComparison, newOp: LeafOperator): LeafComparison {
  return {
    op: newOp,
    field: current.field,
    value: coerceValueForKind(current.value, valueKindForLeaf(current.field, newOp)),
  }
}

/**
 * leaf の field を変えたとき、value を新 field (+ 現 op) の kind に合わせて変換する。
 * boolean/number field に切替えた際に string 値が残り、runtime で永久に不一致になるのを防ぐ (E)。
 */
export function castLeafForField(current: LeafComparison, newField: string): LeafComparison {
  return {
    op: current.op,
    field: newField,
    value: coerceValueForKind(current.value, valueKindForLeaf(newField, current.op)),
  }
}

/**
 * op を newOp に変えると value が「型変換 / クリア」されるか。
 * UI 側で「演算子を変えると今の値が失われます」と警告するために使う
 * (従来は無言で cast されデータが消えていた)。
 */
export function opChangeAltersValue(current: LeafComparison, newOp: LeafOperator): boolean {
  if (current.op === newOp) return false
  const casted = castLeafValueForOp(current, newOp)
  const before = current.value === undefined ? null : current.value
  const after = casted.value === undefined ? null : casted.value
  return JSON.stringify(before) !== JSON.stringify(after)
}

// ── nested group helpers (E: 1 段ネスト編集) ───────────────────────────────

/** 新規ネストグループ (既定 OR + leaf 1)。 */
export function makeDefaultGroup(): CompositeNode {
  return { op: 'OR', children: [makeDefaultLeaf()] }
}

/** root に composite 子 (ネストグループ) を 1 つ追加。 */
export function addGroupAt(root: CompositeNode, group: CompositeNode): CompositeNode {
  return { op: root.op, children: [...root.children, group] }
}

/** index の子 (leaf / group どちらでも) を置換。ネストグループの編集結果を書き戻す。 */
export function updateChildAt(
  root: CompositeNode,
  index: number,
  child: ConditionNode,
): CompositeNode {
  if (index < 0 || index >= root.children.length) return root
  return { op: root.op, children: root.children.map((c, i) => (i === index ? child : c)) }
}

/** AST 全体の leaf 総数 (ネスト含む)。条件追加の上限 (<=30) 判定用。 */
export function totalLeafCount(node: ConditionNode): number {
  if (isLeaf(node)) return 1
  return node.children.reduce((acc, c) => acc + totalLeafCount(c), 0)
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
