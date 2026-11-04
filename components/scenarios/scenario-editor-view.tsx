'use client'

/**
 * ScenarioEditorView — シナリオ編集 UI (M-Director Stage 2 / Phase 2.1)
 *
 *   - useScenarioEditor hook で local edit state を管理
 *   - 編集可能: name / description / status / condition_ast / variants / frequency_cap / schedule
 *   - 保存ボタン enable + PUT /api/scenarios/[id] + sonner toast
 *   - dirty 状態に応じて Reset ボタン表示
 */

import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Check, RotateCcw, Save } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { canonicalizeAst } from '@/lib/scenarios/evaluator'
import {
  canTransitionToStatus,
  isPublishStatus,
  normalizeRole,
  type ScenarioRole,
} from '@/lib/scenarios/publish-rbac'
import type { ConditionNode, Scenario, Variant } from '@/lib/scenarios/types'
import { SCENARIO_STATUSES } from '@/lib/scenarios/types'

import { ConditionVisualBuilder } from './condition-visual-builder'
import { DryRunPreviewPanel } from './dry-run-preview-panel'
import { FrequencyScheduleCard } from './frequency-schedule-card'
import { ScenarioStatsPanel } from './scenario-stats-panel'
import { useScenarioEditor } from './use-scenario-editor'
import { VariantPreview } from './variant-preview'
import { VariantSetEditor } from './variant-set-editor'

interface ScenarioEditorViewProps {
  scenario: Scenario
  /** Phase 2.1 RBAC: JWT 由来の role を server component から渡す。未指定時は 'member' fail-safe。 */
  viewerRole?: ScenarioRole
}

export function ScenarioEditorView({ scenario, viewerRole }: ScenarioEditorViewProps) {
  const editor = useScenarioEditor({ scenario })
  const role: ScenarioRole = normalizeRole(viewerRole)
  const [previewVariant, setPreviewVariant] = useState<Variant | null>(null)

  return (
    <>
      <PageMeta title="ターゲティングバナー" eyebrow="M Agent · Editor" />

      <div className="ug-page-scroll">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto] gap-4 items-end mb-5">
          <div>
            <div className="font-mono text-[10.5px] text-slate-400 uppercase tracking-wider mb-1.5">
              M AGENT · ターゲティングバナー · 編集
            </div>
            <h1 className="text-[22px] font-bold tracking-tight flex items-center gap-2.5">
              <Input
                value={editor.draft.name}
                onChange={(e) => editor.setName(e.target.value)}
                placeholder="シナリオ名"
                aria-label="シナリオ名"
                className="text-[22px] font-bold border-0 px-2 py-0.5 min-w-[540px] bg-transparent focus-visible:bg-slate-50 hover:bg-slate-50"
              />
            </h1>
            <div className="text-xs text-slate-500 mt-1 flex gap-2.5 items-center">
              <span className="font-mono text-[11px] px-1.5 py-0.5 bg-slate-100 rounded">
                {scenario.site_id}
              </span>
              <StatusPill status={editor.draft.status} />
              <Badge variant="outline" className="font-mono text-[9.5px] uppercase tracking-wider">
                {scenario.evidence_level}
              </Badge>
              <span>
                · 最終更新 {new Date(scenario.updated_at).toISOString().slice(0, 16).replace('T', ' ')} ·
                A/B/C variants {editor.draft.variants.length} 件
              </span>
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <Link
              href="/scenarios"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md hover:bg-slate-100 transition-colors"
            >
              <ArrowLeft className="h-3 w-3" /> 一覧へ
            </Link>
            {editor.isDirty ? (
              <Button variant="outline" size="sm" onClick={editor.reset} disabled={editor.isSaving}>
                <RotateCcw className="mr-1.5 h-3 w-3" /> 戻す
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => void editor.save()}
              disabled={!editor.isDirty || editor.isSaving}
              title={editor.isDirty ? '変更を保存' : '変更なし'}
            >
              <Save className="mr-1.5 h-3 w-3" />
              {editor.isSaving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>

        {/* error display */}
        {editor.error ? (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-md text-[12.5px] text-red-700">
            <span className="font-semibold">保存エラー:</span> {editor.error}
          </div>
        ) : null}

        {/* description */}
        <div className="mb-4">
          <label className="font-mono text-[10px] text-slate-400 uppercase tracking-wider font-semibold block mb-1.5">
            description
          </label>
          <textarea
            value={editor.draft.description}
            onChange={(e) => editor.setDescription(e.target.value)}
            placeholder="このシナリオの目的・対象訪問者・期待効果を一行で。後で M-Director 自動分析が参照します。"
            className="w-full min-h-[60px] px-3 py-2 border border-slate-200 rounded-md text-[12.5px] bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 resize-y"
          />
        </div>

        {/* 2-col grid */}
        <div className="grid grid-cols-[1.25fr_1fr] gap-4.5">
          {/* LEFT: condition builder + dry run + stats */}
          <div>
            <Panel
              title="条件 (誰に発火するか)"
              meta="depth ≤ 5 / leaf ≤ 30 · AND/OR + 平坦 leaf 編集可"
            >
              {/* ML Uplift Preset Bar */}
              <div className="px-4 py-3 bg-indigo-50/60 border-b border-indigo-100">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-bold text-indigo-950 flex items-center gap-1.5">
                    🤖 ML Uplift（迷い・離脱予兆検知）プリセット
                  </span>
                  <span className="font-mono text-[10px] text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded">
                    Sure Things（自発CV確実層）への過剰介入を自動除外
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {editor.upliftPresets.map((preset) => (
                    <div
                      key={preset.id}
                      className="flex items-start justify-between gap-3 bg-white border border-indigo-200/80 rounded-md px-3 py-2 text-xs"
                    >
                      <div className="flex-1">
                        <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-600 text-white">
                            {preset.badge}
                          </span>
                          <span>{preset.label}</span>
                        </div>
                        <div className="text-[11px] text-slate-600 mt-0.5">
                          {preset.expectedLiftNote}
                        </div>
                        <div className="text-[10.5px] text-indigo-800 mt-0.5">
                          💡 {preset.whyExcludeSureThings}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => editor.applyUpliftPreset(preset.id)}
                        className="shrink-0 text-[11px] h-7 border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                      >
                        条件に適用
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-4 py-3.5 bg-slate-50 border-b border-slate-100">
                <ConditionVisualBuilder
                  ast={editor.draft.condition_ast}
                  onChange={editor.setConditionAst}
                />
              </div>
              <div className="bg-slate-900 text-slate-100 px-4 py-3 font-mono text-[11.5px] leading-relaxed overflow-x-auto whitespace-pre">
                {formatAstForDisplay(editor.draft.condition_ast)}
              </div>
              <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                <DryRunPreviewPanel
                  conditionAst={editor.draft.condition_ast}
                  siteId={scenario.site_id}
                  hasValidationErrors={false}
                />
              </div>
            </Panel>

            {/* Stats (Stage 7、続 M-12) — scenario_match テーブルから集計 */}
            <SectionHeader>計測 (impression / click / CVR、過去 24h / 7d / 30d)</SectionHeader>
            <ScenarioStatsPanel
              scenarioId={scenario.id}
              tenantId={scenario.tenant_id}
              siteId={scenario.site_id}
            />
          </div>

          {/* RIGHT: variant editor + frequency/schedule + status */}
          <div>
            <Panel
              title="バリアント (A/B/C 最大 3 つ)"
              meta="画像 or HTML · 追加/削除・content_type 切替・プレビュー可"
            >
              <div className="px-4 py-4">
                <VariantSetEditor
                  variants={editor.draft.variants}
                  onChange={editor.setVariants}
                  scenarioId={scenario.id}
                  siteId={scenario.site_id}
                  tenantId={scenario.tenant_id}
                  onPreview={setPreviewVariant}
                />
              </div>
              <div className="px-4 py-3 border-t border-slate-100">
                <FrequencyScheduleCard
                  frequencyCap={editor.draft.frequency_cap}
                  schedule={editor.draft.schedule}
                  onFrequencyCapChange={editor.setFrequencyCap}
                  onScheduleChange={editor.setSchedule}
                />
              </div>
            </Panel>

            {/* Status section */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 mt-3">
              <div className="text-xs font-semibold mb-2 flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-slate-400" /> 配信ステータス
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {SCENARIO_STATUSES.filter((s) => s !== 'archived').map((s) => {
                  const allowed = canTransitionToStatus(role, s)
                  const isCurrentlyPublish = isPublishStatus(s)
                  return (
                    <label
                      key={s}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 border rounded text-[11.5px] ${
                        allowed ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                      } ${
                        editor.draft.status === s
                          ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-semibold'
                          : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                      title={
                        !allowed && isCurrentlyPublish
                          ? `Owner / Admin のみ ${s} に切替可能`
                          : !allowed
                          ? '権限がありません'
                          : ''
                      }
                    >
                      <input
                        type="radio"
                        name="status"
                        checked={editor.draft.status === s}
                        onChange={() => editor.setStatus(s)}
                        disabled={!allowed}
                        className="m-0"
                      />
                      {s}
                      {isCurrentlyPublish ? (
                        <span className="font-mono text-[8.5px] text-amber-600 ml-0.5">owner</span>
                      ) : null}
                    </label>
                  )
                })}
              </div>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                live = 配信開始、preview = 内部のみ、measure_only = 計測のみで配信しない、paused = 停止、draft = 未完成。
                <br />
                <span className="text-[10.5px] text-amber-700">
                  live / preview への切替は <b>Owner / Admin role</b> のみ (REQ-SEC-010)。
                  現在の role: <code className="font-mono">{role}</code>
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {previewVariant ? (
        <VariantPreview variant={previewVariant} onClose={() => setPreviewVariant(null)} />
      ) : null}
    </>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: Scenario['status'] }) {
  const map: Record<Scenario['status'], string> = {
    live: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    preview: 'bg-amber-50 text-amber-700 border-amber-300',
    measure_only: 'bg-indigo-50 text-indigo-700 border-indigo-300',
    paused: 'bg-slate-100 text-slate-600 border-slate-300',
    draft: 'bg-slate-100 text-slate-500 border-slate-300',
    archived: 'bg-slate-100 text-slate-400 border-slate-200',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] font-semibold rounded uppercase tracking-wider border ${map[status]}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden />
      {status}
    </span>
  )
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden mb-3.5">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5">
        <h3 className="text-sm font-semibold flex-1">{title}</h3>
        {meta ? <span className="font-mono text-[10px] text-slate-400">{meta}</span> : null}
      </div>
      {children}
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] text-slate-400 uppercase tracking-wider font-semibold mt-4 mb-2 flex items-center gap-2">
      {children}
      <div className="flex-1 h-px bg-slate-200" />
    </div>
  )
}

function formatAstForDisplay(ast: ConditionNode): string {
  try {
    return JSON.stringify(JSON.parse(canonicalizeAst(ast)), null, 2)
  } catch {
    return canonicalizeAst(ast)
  }
}
