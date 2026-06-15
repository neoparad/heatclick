'use client'

/**
 * ConditionVisualBuilder — editable AST builder (M-Director Stage 4 / E 強化、2026-06-10)
 *
 * E で追加:
 *   - field の日本語ラベル + 値ヒント表示 (no-code 化)
 *   - operator 変更で値が型変換/クリアされるときの警告 (従来は無言でデータ消失)
 *   - NOT グループ演算子 (children=1 のときのみ有効化)
 *   - 1 段ネストグループ (AND/OR/NOT) の追加・編集・削除
 *
 * 制約:
 *   - UI が作るネストは 1 段まで (depth<=2)。既存のより深いネストはデータ保持し、leaf は
 *     編集可・さらに深い composite は read-only プレースホルダ表示。
 *   - 全体 leaf 数 <= 30 / depth <= 5 は server Zod でも検証 (types.ts validateConditionAst)。
 *
 * Reference: lib/scenarios/condition-ast-ops.ts (immutable AST mutations)
 */

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ALLOWED_FIELDS,
  GROUP_OPERATORS_ALL,
  addGroupAt,
  addLeafAt,
  canUseNot,
  castLeafForField,
  castLeafValueForOp,
  ensureCompositeRoot,
  fieldMeta,
  isLeaf,
  makeDefaultGroup,
  makeDefaultLeaf,
  opChangeAltersValue,
  operatorLabel,
  operatorsForField,
  removeLeafAt,
  setGroupOp,
  totalLeafCount,
  updateChildAt,
  valueKindForLeaf,
  type CompositeNode,
  type CompositeOperator,
  type ConditionNode,
  type LeafComparison,
  type LeafOperator,
} from '@/lib/scenarios/condition-ast-ops'

export interface ConditionVisualBuilderProps {
  ast: ConditionNode
  onChange: (next: ConditionNode) => void
  /** read-only display (Stage 2 backward compat) */
  disabled?: boolean
}

const MAX_LEAVES = 30

export function ConditionVisualBuilder({ ast, onChange, disabled = false }: ConditionVisualBuilderProps) {
  const root = ensureCompositeRoot(ast)
  const leafTotal = totalLeafCount(root)
  // NOT は children=1 制約があるため、複数子のときは leaf/group 追加で壊れる。NOT のときは追加不可。
  const canAddChild = !disabled && leafTotal < MAX_LEAVES && root.op !== 'NOT'

  function handleGroupOp(newOp: CompositeOperator): void {
    if (disabled) return
    onChange(setGroupOp(root, newOp))
  }

  function handleChildChange(index: number, nextChild: ConditionNode): void {
    if (disabled) return
    onChange(updateChildAt(root, index, nextChild))
  }

  function handleRemoveChild(index: number): void {
    if (disabled) return
    onChange(removeLeafAt(root, index))
  }

  return (
    <div className="bg-white border border-slate-200 rounded-md p-3">
      <GroupOpSwitch
        node={root}
        disabled={disabled}
        onOp={handleGroupOp}
      />

      {/* Children (leaf rows + nested groups) */}
      <div className="space-y-1.5 mt-2">
        {root.children.map((child, i) =>
          isLeaf(child) ? (
            <LeafRow
              key={`leaf-${i}`}
              leaf={child}
              disabled={disabled}
              canRemove={root.children.length > 1}
              onChange={(next) => handleChildChange(i, next)}
              onRemove={() => handleRemoveChild(i)}
            />
          ) : (
            <NestedGroupEditor
              key={`group-${i}`}
              group={child}
              disabled={disabled}
              canAddLeaf={!disabled && leafTotal < MAX_LEAVES}
              onChange={(next) => handleChildChange(i, next)}
              onRemove={() => handleRemoveChild(i)}
            />
          ),
        )}
      </div>

      {/* Footer: add buttons + meta */}
      <div className="flex gap-2 pt-2.5 mt-2.5 border-t border-slate-100 items-center">
        <Button
          variant="outline"
          size="sm"
          disabled={!canAddChild}
          onClick={() => onChange(addLeafAt(root, makeDefaultLeaf()))}
          className="border-dashed"
          title={root.op === 'NOT' ? 'NOT は条件 1 件のみ。AND/OR に戻すと追加できます' : '条件を追加'}
        >
          <Plus className="mr-1 h-3 w-3" /> 条件追加
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canAddChild}
          onClick={() => onChange(addGroupAt(root, makeDefaultGroup()))}
          className="border-dashed"
          title={root.op === 'NOT' ? 'NOT は条件 1 件のみ' : 'ネストグループ (例: B OR C) を追加'}
        >
          <Plus className="mr-1 h-3 w-3" /> グループ追加
        </Button>
        <span className="ml-auto text-[10.5px] text-slate-400 font-mono self-center">
          {leafTotal} / {MAX_LEAVES} leaves
        </span>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Group operator switch (AND / OR / NOT)
// ───────────────────────────────────────────────────────────────────────────

function GroupOpSwitch({
  node,
  disabled,
  onOp,
}: {
  node: CompositeNode
  disabled: boolean
  onOp: (op: CompositeOperator) => void
}) {
  const notOk = canUseNot(node)
  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex bg-slate-50 border border-slate-200 rounded p-0.5">
        {GROUP_OPERATORS_ALL.map((op) => {
          const isNot = op === 'NOT'
          const enabled = !disabled && (!isNot || notOk || node.op === 'NOT')
          return (
            <button
              key={op}
              type="button"
              onClick={() => (enabled ? onOp(op) : undefined)}
              disabled={!enabled}
              className={`px-2.5 py-0.5 font-mono text-[10.5px] font-bold rounded transition-colors ${
                node.op === op
                  ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                  : 'text-slate-400 hover:text-slate-600'
              } ${enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
              aria-pressed={node.op === op}
              title={
                isNot && !notOk && node.op !== 'NOT'
                  ? 'NOT は条件 1 件のときのみ (現在は複数条件)'
                  : `グループ演算子を ${op} に切替`
              }
            >
              {op}
            </button>
          )
        })}
      </div>
      <span className="text-[11.5px] text-slate-500 flex-1">
        {node.op === 'AND'
          ? `${node.children.length} 条件すべてを満たす (AND)`
          : node.op === 'OR'
            ? `${node.children.length} 条件のいずれかを満たす (OR)`
            : '条件を満たさない (NOT)'}
      </span>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Nested group editor (1 段ネスト: AND/OR/NOT + leaf 列)
// ───────────────────────────────────────────────────────────────────────────

function NestedGroupEditor({
  group,
  disabled,
  canAddLeaf,
  onChange,
  onRemove,
}: {
  group: CompositeNode
  disabled: boolean
  /** AST 全体の leaf 上限に対する残量 (root が算出)。group 単位ではなく全体で判定する。 */
  canAddLeaf: boolean
  onChange: (next: CompositeNode) => void
  onRemove: () => void
}) {
  const leafChildren = group.children.filter(isLeaf)
  const deeper = group.children.length - leafChildren.length
  // 全体 leaf 上限 (canAddLeaf) と NOT 制約 (children=1) の両方を満たすときだけ追加可。
  const canAdd = canAddLeaf && group.op !== 'NOT'

  return (
    <div className="border-l-2 border-indigo-200 pl-2.5 py-1.5 bg-indigo-50/30 rounded-r">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-mono text-[9.5px] text-indigo-500 uppercase tracking-wider">group</span>
        <GroupOpSwitch node={group} disabled={disabled} onOp={(op) => onChange(setGroupOp(group, op))} />
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded disabled:opacity-30"
          title="グループを削除"
          aria-label="グループを削除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        {group.children.map((child, j) =>
          isLeaf(child) ? (
            <LeafRow
              key={`ng-leaf-${j}`}
              leaf={child}
              disabled={disabled}
              canRemove={leafChildren.length > 1}
              onChange={(next) => onChange(updateChildAt(group, j, next))}
              onRemove={() => onChange(removeLeafAt(group, j))}
            />
          ) : (
            <div
              key={`ng-deep-${j}`}
              className="text-[10.5px] text-slate-400 pl-2 italic py-1 border-l-2 border-slate-200"
            >
              (さらに深いネスト — 編集は上位 UI 非対応、データは保持)
            </div>
          ),
        )}
      </div>

      {deeper === 0 ? (
        <Button
          variant="outline"
          size="sm"
          disabled={!canAdd}
          onClick={() => onChange(addLeafAt(group, makeDefaultLeaf()))}
          className="border-dashed mt-1.5 h-6 text-[10.5px]"
          title={group.op === 'NOT' ? 'NOT は条件 1 件のみ' : 'このグループに条件を追加'}
        >
          <Plus className="mr-1 h-2.5 w-2.5" /> 条件追加
        </Button>
      ) : null}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Leaf row (field + operator + value)。onChange は更新後の leaf を返す。
// ───────────────────────────────────────────────────────────────────────────

interface LeafRowProps {
  leaf: LeafComparison
  disabled: boolean
  canRemove: boolean
  onChange: (next: LeafComparison) => void
  onRemove: () => void
}

function LeafRow({ leaf, disabled, canRemove, onChange, onRemove }: LeafRowProps) {
  const kind = valueKindForLeaf(leaf.field, leaf.op)
  // E: operator / field 変更で値が失われるときの警告 (次の編集で消える)。
  const [castNote, setCastNote] = useState<string | null>(null)
  const meta = fieldMeta(leaf.field)

  function patchLeaf(patch: Partial<LeafComparison>): void {
    setCastNote(null)
    onChange({
      op: patch.op ?? leaf.op,
      field: patch.field ?? leaf.field,
      value: 'value' in patch ? patch.value : leaf.value,
    })
  }

  function changeField(newField: string): void {
    const casted = castLeafForField(leaf, newField)
    if (JSON.stringify(casted.value ?? null) !== JSON.stringify(leaf.value ?? null)) {
      setCastNote('field 変更で値の型が変わりました（前の値は変換またはクリアされました）')
    } else {
      setCastNote(null)
    }
    onChange(casted)
  }

  function changeOp(newOp: LeafOperator): void {
    if (opChangeAltersValue(leaf, newOp)) {
      setCastNote('演算子の変更で値の型が変わりました（前の値は変換またはクリアされました）')
    } else {
      setCastNote(null)
    }
    onChange(castLeafValueForOp(leaf, newOp))
  }

  return (
    <div>
      <div className="grid grid-cols-[1.1fr_148px_1fr_24px] gap-1.5 items-center">
        {/* Field select (日本語ラベル) */}
        <select
          value={leaf.field}
          onChange={(e) => changeField(e.target.value)}
          disabled={disabled}
          className="h-8 px-2 text-xs border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 disabled:opacity-100 disabled:cursor-not-allowed"
          aria-label="field"
          title={`${meta.label} — ${meta.hint}`}
        >
          {ALLOWED_FIELDS.map((f) => (
            <option key={f} value={f}>
              {fieldMeta(f).label}
            </option>
          ))}
          {!(ALLOWED_FIELDS as readonly string[]).includes(leaf.field) ? (
            <option value={leaf.field}>{leaf.field} (custom)</option>
          ) : null}
        </select>

        {/* Operator select */}
        <select
          value={leaf.op}
          onChange={(e) => changeOp(e.target.value as LeafOperator)}
          disabled={disabled}
          className="h-8 px-2 text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-100 disabled:cursor-not-allowed"
          aria-label="operator"
        >
          {operatorsForField(leaf.field, leaf.op).map((op) => (
            <option key={op} value={op}>
              {operatorLabel(op)}
            </option>
          ))}
        </select>

        {/* Value input (type depends on operator) */}
        {kind === 'none' ? (
          <Badge variant="outline" className="h-8 text-[10.5px] text-slate-400 justify-center">
            (値なし)
          </Badge>
        ) : kind === 'boolean' ? (
          <select
            value={String(leaf.value)}
            onChange={(e) => patchLeaf({ value: e.target.value === 'true' })}
            disabled={disabled}
            className="h-8 px-2 text-xs border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 disabled:opacity-100"
            aria-label="value"
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : kind === 'number' ? (
          <Input
            type="number"
            value={String(leaf.value ?? '')}
            onChange={(e) => {
              const n = Number(e.target.value)
              patchLeaf({ value: Number.isFinite(n) ? n : 0 })
            }}
            disabled={disabled}
            className="h-8 text-xs"
            aria-label="value"
          />
        ) : kind === 'string_list' ? (
          <Input
            type="text"
            value={Array.isArray(leaf.value) ? (leaf.value as string[]).join(', ') : String(leaf.value ?? '')}
            onChange={(e) =>
              patchLeaf({
                value: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            disabled={disabled}
            placeholder="value1, value2, value3"
            className="h-8 text-xs"
            aria-label="value"
          />
        ) : kind === 'number_list' ? (
          <Input
            type="text"
            value={
              Array.isArray(leaf.value)
                ? (leaf.value as Array<string | number>).join(', ')
                : String(leaf.value ?? '')
            }
            onChange={(e) =>
              patchLeaf({
                value: e.target.value
                  .split(',')
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isFinite(n)),
              })
            }
            disabled={disabled}
            placeholder="1, 2, 3"
            className="h-8 text-xs"
            aria-label="value"
          />
        ) : (
          <Input
            type="text"
            value={String(leaf.value ?? '')}
            onChange={(e) => patchLeaf({ value: e.target.value })}
            disabled={disabled}
            className="h-8 text-xs"
            aria-label="value"
          />
        )}

        {/* Delete button */}
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled || !canRemove}
          className={`p-1 transition-colors ${
            disabled || !canRemove
              ? 'text-slate-300 cursor-not-allowed'
              : 'text-slate-400 hover:text-red-500 hover:bg-red-50 rounded cursor-pointer'
          }`}
          title={canRemove ? '条件を削除' : '最低 1 件は必要'}
          aria-label="削除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* field ヒント + cast 警告 */}
      <div className="pl-0.5 mt-0.5 flex gap-2 items-center min-h-[14px]">
        <span className="text-[10px] text-slate-400">{meta.hint}</span>
        {castNote ? <span className="text-[10px] text-amber-600">⚠️ {castNote}</span> : null}
      </div>
    </div>
  )
}
