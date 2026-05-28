'use client'

/**
 * ConditionVisualBuilder — editable AST builder (M-Director Stage 4、続 M-11、2026-05-28)
 *
 * UI Spec:
 *   - linkscrawl/docs/fusion/mockups/20_scenarios_editor.html §VB
 *
 * Scope (Phase 2):
 *   - Single root group (AND / OR) + flat leaf list (1〜30 件)
 *   - Each leaf: field select (ALLOWED_FIELDS) + op select (LEAF_OPERATORS) + value input
 *   - Add condition / Remove condition / Group op toggle
 *   - Nested composite groups は表示のみ、編集は Phase 3
 *   - NOT operator は Phase 3 で別 UI (NOT children=1 制約のため)
 *
 * Reference:
 *   - lib/scenarios/condition-ast-ops.ts (immutable AST mutations)
 *   - lib/scenarios/types.ts (ConditionNode + Zod schema)
 *   - 続 M-9 §6 #1 (Stage 4 着工計画)
 */

import { Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ALLOWED_FIELDS,
  GROUP_OPERATORS_UI,
  LEAF_OPERATORS,
  addLeafAt,
  castLeafValueForOp,
  ensureCompositeRoot,
  isLeaf,
  makeDefaultLeaf,
  removeLeafAt,
  rootNestedGroupCount,
  setGroupOp,
  updateLeafAt,
  valueKindFor,
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

export function ConditionVisualBuilder({ ast, onChange, disabled = false }: ConditionVisualBuilderProps) {
  const root = ensureCompositeRoot(ast)
  const nestedCount = rootNestedGroupCount(root)

  function handleGroupOp(newOp: CompositeOperator): void {
    if (disabled) return
    onChange(setGroupOp(root, newOp))
  }

  function handleAddLeaf(): void {
    if (disabled) return
    onChange(addLeafAt(root, makeDefaultLeaf()))
  }

  function handleLeafChange(index: number, patch: Partial<LeafComparison>): void {
    if (disabled) return
    onChange(updateLeafAt(root, index, patch))
  }

  function handleLeafOpChange(index: number, newOp: LeafOperator): void {
    if (disabled) return
    const current = root.children[index]
    if (!current || !isLeaf(current)) return
    const cast = castLeafValueForOp(current, newOp)
    onChange(updateLeafAt(root, index, cast))
  }

  function handleRemoveLeaf(index: number): void {
    if (disabled) return
    onChange(removeLeafAt(root, index))
  }

  return (
    <div className="bg-white border border-slate-200 rounded-md p-3">
      {/* Group operator switch */}
      <div className="flex items-center gap-2 mb-2">
        <div className="inline-flex bg-slate-50 border border-slate-200 rounded p-0.5">
          {GROUP_OPERATORS_UI.map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => handleGroupOp(op)}
              disabled={disabled}
              className={`px-2.5 py-0.5 font-mono text-[10.5px] font-bold rounded transition-colors ${
                root.op === op
                  ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                  : 'text-slate-400 hover:text-slate-600'
              } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              aria-pressed={root.op === op}
              title={`グループ演算子を ${op} に切替`}
            >
              {op}
            </button>
          ))}
          <span className="px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-slate-400 cursor-not-allowed" title="Phase 3 で実装">
            NOT
          </span>
        </div>
        <span className="text-[11.5px] text-slate-500 flex-1">
          {root.op === 'AND'
            ? `${root.children.length} 条件すべてを満たす (AND)`
            : `${root.children.length} 条件のいずれかを満たす (OR)`}
        </span>
      </div>

      {/* Leaf rows */}
      <div className="space-y-1.5">
        {root.children.map((child, i) =>
          isLeaf(child) ? (
            <LeafRow
              key={`leaf-${i}`}
              leaf={child}
              disabled={disabled}
              canRemove={root.children.length > 1}
              onChange={(patch) => handleLeafChange(i, patch)}
              onOpChange={(newOp) => handleLeafOpChange(i, newOp)}
              onRemove={() => handleRemoveLeaf(i)}
            />
          ) : (
            <div
              key={`group-${i}`}
              className="text-[11px] text-slate-400 pl-2 italic py-1 border-l-2 border-slate-200"
            >
              (nested {child.op} group — Phase 3 で edit 化、現在は read-only 保持)
            </div>
          ),
        )}
      </div>

      {/* Footer: add buttons + meta */}
      <div className="flex gap-2 pt-2.5 mt-2.5 border-t border-slate-100">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || root.children.length >= 30}
          onClick={handleAddLeaf}
          className="border-dashed"
        >
          <Plus className="mr-1 h-3 w-3" /> 条件追加
        </Button>
        <Button variant="outline" size="sm" disabled className="border-dashed" title="Phase 3 で実装">
          <Plus className="mr-1 h-3 w-3" /> グループ追加
        </Button>
        {nestedCount > 0 ? (
          <span className="ml-auto text-[10.5px] text-slate-400 self-center">
            ※ nested group {nestedCount} 件保持中 (Phase 3 で edit 化)
          </span>
        ) : null}
        <span className="ml-auto text-[10.5px] text-slate-400 font-mono self-center">
          {root.children.length} / 30 leaves
        </span>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

interface LeafRowProps {
  leaf: LeafComparison
  disabled: boolean
  canRemove: boolean
  onChange: (patch: Partial<LeafComparison>) => void
  onOpChange: (newOp: LeafOperator) => void
  onRemove: () => void
}

function LeafRow({ leaf, disabled, canRemove, onChange, onOpChange, onRemove }: LeafRowProps) {
  const kind = valueKindFor(leaf.op)

  return (
    <div className="grid grid-cols-[1.1fr_104px_1fr_24px] gap-1.5 items-center">
      {/* Field select */}
      <select
        value={leaf.field}
        onChange={(e) => onChange({ field: e.target.value })}
        disabled={disabled}
        className="h-8 px-2 text-xs font-mono border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 disabled:opacity-100 disabled:cursor-not-allowed"
        aria-label="field"
      >
        {ALLOWED_FIELDS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        {/* 不正な field が保存されている場合の fallback */}
        {!(ALLOWED_FIELDS as readonly string[]).includes(leaf.field) ? (
          <option value={leaf.field}>{leaf.field} (custom)</option>
        ) : null}
      </select>

      {/* Operator select */}
      <select
        value={leaf.op}
        onChange={(e) => onOpChange(e.target.value as LeafOperator)}
        disabled={disabled}
        className="h-8 px-2 text-[10.5px] font-mono text-indigo-700 bg-indigo-50 border border-indigo-200 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-100 disabled:cursor-not-allowed"
        aria-label="operator"
      >
        {LEAF_OPERATORS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>

      {/* Value input (type depends on operator) */}
      {kind === 'none' ? (
        <Badge variant="outline" className="h-8 text-[10.5px] text-slate-400 justify-center">
          (no value)
        </Badge>
      ) : kind === 'boolean' ? (
        <select
          value={String(leaf.value)}
          onChange={(e) => onChange({ value: e.target.value === 'true' })}
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
            onChange({ value: Number.isFinite(n) ? n : 0 })
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
            onChange({
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
      ) : (
        <Input
          type="text"
          value={String(leaf.value ?? '')}
          onChange={(e) => onChange({ value: e.target.value })}
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
  )
}
