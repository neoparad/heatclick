'use client'

/**
 * useScenarioEditor — Stage 2-4 (続 M-9〜M-11): local edit state + PUT API call hook
 *
 * Phase 2 scope:
 *   - Edit: name, description, status, condition_ast, variant.cta_url / position / traffic_split
 *   - Image upload (Stage 3): variant.image_url via VariantImageUpload
 *   - Stage 5 (Phase 2.5) で edit 化: variant.image_alt, variant.html (HTML editor)
 *
 * Save flow:
 *   1. local state diff (dirty 検知)
 *   2. PUT /api/scenarios/[id]?tenant_id=...&site_id=...
 *   3. on success: refresh router → server-side re-fetch
 *   4. on error: rollback local state + toast.error
 *
 * Reference:
 *   - lib/scenarios/types.ts (Scenario, Variant schemas)
 *   - lib/scenarios/condition-ast-ops.ts (AST mutation helpers)
 *   - app/api/scenarios/[id]/route.ts (PUT endpoint)
 *   - 続 M-7 §4 #2-3 (Stage 2 配備計画) / 続 M-10 §5 (Stage 4)
 */

import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

import type { ConditionNode, Scenario, ScenarioStatus, Variant } from '@/lib/scenarios/types'

export interface EditableScenarioFields {
  name: string
  description: string
  status: ScenarioStatus
  condition_ast: ConditionNode
  variants: Variant[]
}

export interface UseScenarioEditorOptions {
  scenario: Scenario
  /** override fetch (test 用)、default = global fetch */
  fetchImpl?: typeof fetch
}

export interface UseScenarioEditorResult {
  /** 現在の編集中 state (controlled inputs にバインド) */
  draft: EditableScenarioFields
  /** dirty flag = 1 つ以上のフィールドが original と diff あり */
  isDirty: boolean
  /** saving = PUT in flight */
  isSaving: boolean
  /** バリデーション error (Zod parse fail 等) */
  error: string | null
  /** field setters */
  setName: (value: string) => void
  setDescription: (value: string) => void
  setStatus: (value: ScenarioStatus) => void
  setConditionAst: (next: ConditionNode) => void
  updateVariant: (variantId: string, patch: Partial<Variant>) => void
  /** Save 実行 (PUT API call) */
  save: () => Promise<void>
  /** dirty state を original に reset */
  reset: () => void
}

const SCENARIO_STATUSES: ScenarioStatus[] = [
  'draft',
  'measure_only',
  'preview',
  'live',
  'paused',
  'archived',
]

export function isValidStatus(s: string): s is ScenarioStatus {
  return (SCENARIO_STATUSES as string[]).includes(s)
}

export function useScenarioEditor(opts: UseScenarioEditorOptions): UseScenarioEditorResult {
  const { scenario, fetchImpl = fetch } = opts
  const router = useRouter()

  const initial: EditableScenarioFields = useMemo(
    () => ({
      name: scenario.name,
      description: scenario.description,
      status: scenario.status,
      condition_ast: scenario.condition_ast,
      variants: [...scenario.variants],
    }),
    [scenario],
  )

  const [draft, setDraft] = useState<EditableScenarioFields>(initial)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDirty = useMemo(() => {
    if (draft.name !== initial.name) return true
    if (draft.description !== initial.description) return true
    if (draft.status !== initial.status) return true
    if (JSON.stringify(draft.condition_ast) !== JSON.stringify(initial.condition_ast)) return true
    if (JSON.stringify(draft.variants) !== JSON.stringify(initial.variants)) return true
    return false
  }, [draft, initial])

  const setName = useCallback((value: string) => {
    setDraft((d) => ({ ...d, name: value }))
  }, [])
  const setDescription = useCallback((value: string) => {
    setDraft((d) => ({ ...d, description: value }))
  }, [])
  const setStatus = useCallback((value: ScenarioStatus) => {
    setDraft((d) => ({ ...d, status: value }))
  }, [])
  const setConditionAst = useCallback((next: ConditionNode) => {
    setDraft((d) => ({ ...d, condition_ast: next }))
  }, [])
  const updateVariant = useCallback((variantId: string, patch: Partial<Variant>) => {
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v) => (v.id === variantId ? ({ ...v, ...patch } as Variant) : v)),
    }))
  }, [])

  const reset = useCallback(() => {
    setDraft(initial)
    setError(null)
  }, [initial])

  const save = useCallback(async () => {
    if (!isDirty || isSaving) return
    setIsSaving(true)
    setError(null)

    try {
      // traffic_split sum=100 validation (defense in depth, server also validates)
      const splitSum = draft.variants.reduce((s, v) => s + v.traffic_split, 0)
      if (splitSum !== 100) {
        throw new Error(`traffic_split の合計が 100 になっていません (現在 ${splitSum})`)
      }

      const body = {
        name: draft.name,
        description: draft.description,
        status: draft.status,
        condition_ast: draft.condition_ast,
        variants: draft.variants,
      }
      const url =
        `/api/scenarios/${encodeURIComponent(scenario.id)}` +
        `?tenant_id=${encodeURIComponent(scenario.tenant_id)}` +
        `&site_id=${encodeURIComponent(scenario.site_id)}`

      const resp = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const errorBody = await resp.json().catch(() => ({ error: 'unknown' }))
        const issues = Array.isArray(errorBody.issues)
          ? errorBody.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join(' / ')
          : ''
        throw new Error(
          `保存に失敗しました (HTTP ${resp.status}${issues ? ': ' + issues : ''})`,
        )
      }

      toast.success('保存しました', { description: `${draft.name} を更新` })
      router.refresh()
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      toast.error('保存に失敗', { description: message })
    } finally {
      setIsSaving(false)
    }
  }, [draft, initial, isDirty, isSaving, scenario, fetchImpl, router])

  return {
    draft,
    isDirty,
    isSaving,
    error,
    setName,
    setDescription,
    setStatus,
    setConditionAst,
    updateVariant,
    save,
    reset,
  }
}
