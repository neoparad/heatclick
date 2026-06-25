'use client'

/**
 * path-builder-form — 新規 / 編集で共有する経路ビルダー UI とロジック
 *
 * - usePathBuilder: name / description / trigger / branches(steps) の controlled state + 操作
 * - PathBuilderFields: 上記 state を描画する presentational component
 * - pathSetToDraft / draftToBranchInputs: PathSet ⇔ フォーム下書きの変換
 *
 * 新規 (path-new-view) と 編集 (path-edit-view) はどちらも本モジュールを使い、
 * 送信先 (POST /api/paths vs PUT /api/paths/[id]) と付帯 UI (サイト選択 / ステータス / 削除)
 * だけを各 view 側で差し込む。
 */

import { useState } from 'react'
import { GitBranch, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PathBranchInput, PathSet } from '@/lib/paths/types'

export const MAX_BRANCHES = 8
export const MAX_STEPS = 12

export interface StepDraft {
  title: string
  url: string
}

export interface BranchDraft {
  name: string
  description: string
  steps: StepDraft[]
}

export interface PathBuilderValue {
  name: string
  description: string
  triggerTitle: string
  triggerUrl: string
  periodDays: number
  branches: BranchDraft[]
}

export interface PathBuilderHandlers {
  setName: (v: string) => void
  setDescription: (v: string) => void
  setTriggerTitle: (v: string) => void
  setTriggerUrl: (v: string) => void
  setPeriodDays: (v: number) => void
  updateBranch: (idx: number, patch: Partial<BranchDraft>) => void
  updateStep: (bIdx: number, sIdx: number, patch: Partial<StepDraft>) => void
  addBranch: () => void
  removeBranch: (idx: number) => void
  addStep: (bIdx: number) => void
  removeStep: (bIdx: number, sIdx: number) => void
}

function emptyStep(): StepDraft {
  return { title: '', url: '' }
}

function emptyBranch(index: number): BranchDraft {
  const letter = String.fromCharCode(65 + index)
  return {
    name: `経路 ${letter}`,
    description: '',
    steps: [emptyStep(), { title: '購入完了', url: '/thanks/' }],
  }
}

export function defaultBuilderValue(): PathBuilderValue {
  return {
    name: '',
    description: '',
    triggerTitle: 'トリガー · TOP 訪問',
    triggerUrl: '/',
    periodDays: 30,
    branches: [emptyBranch(0)],
  }
}

/** PathSet (永続) → ビルダー下書き。編集画面の初期値生成に使う。 */
export function pathSetToDraft(pset: PathSet): PathBuilderValue {
  return {
    name: pset.name,
    description: pset.description,
    triggerTitle: pset.trigger.title,
    triggerUrl: pset.trigger.url,
    periodDays: pset.trigger.periodDays,
    branches: pset.branches.map((b) => ({
      name: b.name,
      description: b.description,
      steps: b.nodes.map((n) => ({ title: n.title, url: n.url })),
    })),
  }
}

/** ビルダー下書き → API の branches 定義 (空ステップを除去)。 */
export function draftToBranchInputs(branches: ReadonlyArray<BranchDraft>): PathBranchInput[] {
  return branches.map((b) => ({
    name: b.name.trim(),
    description: b.description.trim(),
    steps: b.steps
      .filter((s) => s.title.trim() && s.url.trim())
      .map((s) => ({ title: s.title.trim(), url: s.url.trim() })),
  }))
}

/** 共通バリデーション。OK なら null、NG ならエラーメッセージ。 */
export function validateBuilder(value: PathBuilderValue): string | null {
  if (!value.name.trim()) return '経路（比較セット）名を入力してください'
  if (!value.triggerTitle.trim()) return 'トリガー名を入力してください'
  if (!value.triggerUrl.trim()) return 'トリガー URL を入力してください'
  for (const [i, b] of value.branches.entries()) {
    if (!b.name.trim()) return `経路 ${i + 1} の名前を入力してください`
    const validSteps = b.steps.filter((s) => s.title.trim() && s.url.trim())
    if (validSteps.length === 0) {
      return `経路 ${i + 1} に少なくとも 1 ステップ（タイトル + URL）が必要です`
    }
  }
  return null
}

export function usePathBuilder(initial: PathBuilderValue): {
  value: PathBuilderValue
  handlers: PathBuilderHandlers
} {
  const [value, setValue] = useState<PathBuilderValue>(initial)

  const handlers: PathBuilderHandlers = {
    setName: (v) => setValue((s) => ({ ...s, name: v })),
    setDescription: (v) => setValue((s) => ({ ...s, description: v })),
    setTriggerTitle: (v) => setValue((s) => ({ ...s, triggerTitle: v })),
    setTriggerUrl: (v) => setValue((s) => ({ ...s, triggerUrl: v })),
    setPeriodDays: (v) => setValue((s) => ({ ...s, periodDays: v })),
    updateBranch: (idx, patch) =>
      setValue((s) => ({
        ...s,
        branches: s.branches.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
      })),
    updateStep: (bIdx, sIdx, patch) =>
      setValue((s) => ({
        ...s,
        branches: s.branches.map((b, i) =>
          i === bIdx
            ? {
                ...b,
                steps: b.steps.map((st, j) => (j === sIdx ? { ...st, ...patch } : st)),
              }
            : b,
        ),
      })),
    addBranch: () =>
      setValue((s) =>
        s.branches.length >= MAX_BRANCHES
          ? s
          : { ...s, branches: [...s.branches, emptyBranch(s.branches.length)] },
      ),
    removeBranch: (idx) =>
      setValue((s) =>
        s.branches.length <= 1 ? s : { ...s, branches: s.branches.filter((_, i) => i !== idx) },
      ),
    addStep: (bIdx) =>
      setValue((s) => ({
        ...s,
        branches: s.branches.map((b, i) =>
          i === bIdx && b.steps.length < MAX_STEPS ? { ...b, steps: [...b.steps, emptyStep()] } : b,
        ),
      })),
    removeStep: (bIdx, sIdx) =>
      setValue((s) => ({
        ...s,
        branches: s.branches.map((b, i) =>
          i === bIdx && b.steps.length > 1
            ? { ...b, steps: b.steps.filter((_, j) => j !== sIdx) }
            : b,
        ),
      })),
  }

  return { value, handlers }
}

interface PathBuilderFieldsProps {
  value: PathBuilderValue
  handlers: PathBuilderHandlers
  /** 基本情報セクションの先頭に差し込む追加 UI (サイト選択 / ステータス) */
  basicExtra?: React.ReactNode
}

export function PathBuilderFields({ value, handlers, basicExtra }: PathBuilderFieldsProps) {
  return (
    <>
      {/* 基本情報 */}
      <Section title="基本情報">
        {basicExtra}
        <Field label="経路（比較セット）名" htmlFor="name" required>
          <Input
            id="name"
            value={value.name}
            onChange={(e) => handlers.setName(e.target.value)}
            placeholder="例: 商品購入 · 3 経路比較"
            maxLength={255}
          />
        </Field>
        <Field label="説明" htmlFor="desc">
          <Input
            id="desc"
            value={value.description}
            onChange={(e) => handlers.setDescription(e.target.value)}
            placeholder="例: TOP 訪問から購入までの 3 経路を比較監視"
            maxLength={2000}
          />
        </Field>
      </Section>

      {/* トリガー */}
      <Section title="トリガー（経路の起点）">
        <Field label="トリガー名" htmlFor="trigName" required>
          <Input
            id="trigName"
            value={value.triggerTitle}
            onChange={(e) => handlers.setTriggerTitle(e.target.value)}
            placeholder="例: トリガー · TOP 訪問"
            maxLength={120}
          />
        </Field>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="トリガー URL" htmlFor="trigUrl" required>
            <Input
              id="trigUrl"
              value={value.triggerUrl}
              onChange={(e) => handlers.setTriggerUrl(e.target.value)}
              placeholder="例: /"
              maxLength={2048}
            />
          </Field>
          <Field label="計測期間（日）" htmlFor="period">
            <Input
              id="period"
              type="number"
              min={1}
              max={365}
              value={value.periodDays}
              onChange={(e) =>
                handlers.setPeriodDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))
              }
            />
          </Field>
        </div>
      </Section>

      {/* 経路ビルダー */}
      <div className="mb-3 mt-6 flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-indigo-500" aria-hidden />
        <h2 className="text-sm font-semibold text-slate-900">比較する経路</h2>
        <span className="font-mono text-[11px] text-slate-400">
          {value.branches.length}/{MAX_BRANCHES}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlers.addBranch}
          disabled={value.branches.length >= MAX_BRANCHES}
          className="ml-auto"
        >
          <Plus className="mr-1 h-3 w-3" /> 経路を追加
        </Button>
      </div>

      <div className="space-y-4">
        {value.branches.map((branch, bIdx) => (
          <div key={bIdx} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 font-mono text-xs font-bold text-white">
                {String.fromCharCode(65 + bIdx)}
              </span>
              <Input
                value={branch.name}
                onChange={(e) => handlers.updateBranch(bIdx, { name: e.target.value })}
                placeholder="経路名"
                maxLength={120}
                className="h-8 max-w-xs text-sm font-semibold"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handlers.removeBranch(bIdx)}
                disabled={value.branches.length <= 1}
                className="ml-auto text-rose-600 hover:text-rose-700"
                aria-label={`経路 ${bIdx + 1} を削除`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <Input
              value={branch.description}
              onChange={(e) => handlers.updateBranch(bIdx, { description: e.target.value })}
              placeholder="経路の説明（任意）例: 直接商品ページ → カート → 購入"
              maxLength={280}
              className="mb-3 h-8 text-[12.5px]"
            />

            {/* steps */}
            <div className="space-y-2">
              {branch.steps.map((step, sIdx) => (
                <div key={sIdx} className="flex items-center gap-2">
                  <span className="w-7 flex-shrink-0 font-mono text-[10px] font-semibold uppercase text-slate-400">
                    {sIdx === branch.steps.length - 1
                      ? 'CV'
                      : `${String.fromCharCode(65 + bIdx)}${sIdx + 1}`}
                  </span>
                  <Input
                    value={step.title}
                    onChange={(e) => handlers.updateStep(bIdx, sIdx, { title: e.target.value })}
                    placeholder="ステップ名 例: 商品ページ閲覧"
                    maxLength={120}
                    className="h-8 text-[12.5px]"
                  />
                  <Input
                    value={step.url}
                    onChange={(e) => handlers.updateStep(bIdx, sIdx, { url: e.target.value })}
                    placeholder="URL 例: /products/*"
                    maxLength={2048}
                    className="h-8 font-mono text-[12px]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handlers.removeStep(bIdx, sIdx)}
                    disabled={branch.steps.length <= 1}
                    className="flex-shrink-0 px-2 text-slate-400 hover:text-rose-600"
                    aria-label={`ステップ ${sIdx + 1} を削除`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handlers.addStep(bIdx)}
              disabled={branch.steps.length >= MAX_STEPS}
              className="mt-2"
            >
              <Plus className="mr-1 h-3 w-3" /> ステップを追加
            </Button>
          </div>
        ))}
      </div>
    </>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

export function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string
  htmlFor: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="mb-1 block text-[12.5px] text-slate-600">
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </Label>
      {children}
    </div>
  )
}
