'use client'

/**
 * ScenarioEditorView — シナリオ編集 UI (M-Director Stage 2、続 M-9 / 2026-05-28)
 *
 * mockup `linkscrawl/docs/fusion/mockups/20_scenarios_editor.html` 踏襲。
 *
 * Stage 2 (続 M-9) で変更:
 *   - useScenarioEditor hook で local edit state を管理
 *   - 編集可能: name / description / status / variant.cta_url / variant.position / variant.traffic_split
 *   - 編集不可 (Stage 4 で edit 化): condition_ast、variant の image_url / html / image_alt
 *   - 保存ボタン enable + PUT /api/scenarios/[id] + sonner toast
 *   - dirty 状態に応じて Reset ボタン表示
 *
 * 注意:
 *   - Phase 2 では visual builder (Stage 4) と画像 upload (Stage 3) は未配備
 *   - AST と variant 画像は read-only display のまま
 *   - Reset = local state を original に戻す (server-side rollback ではない)
 */

import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Check, Code2, Eye, ImageIcon, Plus, RotateCcw, Save } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { canonicalizeAst } from '@/lib/scenarios/evaluator'
import type { ConditionNode, Scenario, Variant } from '@/lib/scenarios/types'
import { SCENARIO_STATUSES, VARIANT_POSITIONS } from '@/lib/scenarios/types'

import { ConditionVisualBuilder } from './condition-visual-builder'
import { ScenarioStatsPanel } from './scenario-stats-panel'
import { useScenarioEditor } from './use-scenario-editor'
import { VariantImageUpload } from './variant-image-upload'

interface ScenarioEditorViewProps {
  scenario: Scenario
}

export function ScenarioEditorView({ scenario }: ScenarioEditorViewProps) {
  const editor = useScenarioEditor({ scenario })
  const [activeVariantId, setActiveVariantId] = useState<string>(editor.draft.variants[0]?.id ?? 'A')
  const activeVariant =
    editor.draft.variants.find((v) => v.id === activeVariantId) ?? editor.draft.variants[0]

  return (
    <>
      <PageMeta title="ターゲティングバナー" eyebrow="M Agent · Editor" />

      <div className="px-7 pt-5 pb-16">
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
            <Button variant="outline" size="sm" disabled title="Stage 4 (visual builder) で実装">
              <Eye className="mr-1.5 h-3 w-3" /> プレビュー
            </Button>
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
          {/* LEFT: condition builder (read-only until Stage 4) */}
          <div>
            <Panel
              title="条件 (誰に発火するか)"
              meta="depth ≤ 5 / leaf ≤ 30 · AND/OR + 平坦 leaf 編集可"
            >
              <div className="px-4 py-3.5 bg-slate-50 border-b border-slate-100">
                <ConditionVisualBuilder
                  ast={editor.draft.condition_ast}
                  onChange={editor.setConditionAst}
                />
              </div>
              <div className="bg-slate-900 text-slate-100 px-4 py-3 font-mono text-[11.5px] leading-relaxed overflow-x-auto whitespace-pre">
                {formatAstForDisplay(editor.draft.condition_ast)}
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

          {/* RIGHT: variant editor */}
          <div>
            <Panel title="バリアント (A/B/C 最大 3 つ)" meta="画像 or HTML、汎用フィールドなし">
              {/* A/B/C tabs */}
              <div className="flex gap-1.5 px-4 pt-2.5 border-b border-slate-100 bg-slate-50 items-end">
                {editor.draft.variants.map((v) => {
                  const isActive = activeVariantId === v.id
                  const color = v.id === 'A' ? 'indigo' : v.id === 'B' ? 'purple' : 'emerald'
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setActiveVariantId(v.id)}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-t-md border ${
                        isActive
                          ? `border-${color}-300 bg-white text-${color}-700`
                          : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100'
                      } -mb-[1px] flex items-center gap-2`}
                    >
                      <span
                        className={`w-4.5 h-4.5 rounded-full text-white font-mono text-[10px] font-bold flex items-center justify-center ${
                          v.id === 'A' ? 'bg-indigo-500' : v.id === 'B' ? 'bg-purple-500' : 'bg-emerald-500'
                        }`}
                      >
                        {v.id}
                      </span>
                      variant {v.id}
                    </button>
                  )
                })}
                {editor.draft.variants.length < 3 ? (
                  <button
                    type="button"
                    disabled
                    title="Stage 4 (visual builder) で実装"
                    className="px-3.5 py-2 text-xs font-semibold border-2 border-dashed border-slate-300 rounded-t-md text-slate-400 -mb-[1px] flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" /> 追加
                  </button>
                ) : null}
                <div className="ml-auto font-mono text-[10.5px] text-slate-400 pb-2">
                  {editor.draft.variants.length} / 3 variants
                </div>
              </div>

              <div className="px-4 py-4">
                {activeVariant ? (
                  <VariantEditor
                    variant={activeVariant}
                    scenarioId={scenario.id}
                    tenantId={scenario.tenant_id}
                    onChange={(patch) => editor.updateVariant(activeVariant.id, patch)}
                  />
                ) : null}
              </div>
            </Panel>

            {/* Traffic split */}
            <SectionHeader>traffic split (A/B/C 配信比率、合計 100 必須)</SectionHeader>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
              <SplitBar variants={editor.draft.variants} />
              <div className="grid grid-cols-3 gap-2 mt-2">
                {editor.draft.variants.map((v) => {
                  const color =
                    v.id === 'A' ? 'text-indigo-600' : v.id === 'B' ? 'text-purple-600' : 'text-emerald-600'
                  return (
                    <div
                      key={v.id}
                      className="px-2 py-1.5 border border-slate-200 rounded bg-white flex items-center gap-1.5"
                    >
                      <span className={`font-mono text-[10.5px] font-bold ${color}`}>{v.id}</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={String(v.traffic_split)}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10)
                          if (!Number.isFinite(n)) return
                          editor.updateVariant(v.id, { traffic_split: Math.max(0, Math.min(100, n)) })
                        }}
                        className="w-12 h-6 text-right text-[11.5px] font-mono p-1"
                        aria-label={`variant ${v.id} traffic_split`}
                      />
                      <span className="text-[10.5px] text-slate-400">%</span>
                    </div>
                  )
                })}
              </div>
              <div className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                visitor_id の hash で決定論的に振り分け (同 visitor は常に同じ variant が当たる)。
                各 variant の impression / click / dismiss / conversion を計測。Phase 3 で AI 自動勝者振り分けに昇格予定。
              </div>
            </div>

            {/* Status section */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 mt-3">
              <div className="text-xs font-semibold mb-2 flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-slate-400" /> 配信ステータス
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {SCENARIO_STATUSES.filter((s) => s !== 'archived').map((s) => (
                  <label
                    key={s}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 border rounded text-[11.5px] cursor-pointer ${
                      editor.draft.status === s
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-semibold'
                        : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="status"
                      checked={editor.draft.status === s}
                      onChange={() => editor.setStatus(s)}
                      className="m-0"
                    />
                    {s}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                live = 配信開始、preview = 内部のみ、measure_only = 計測のみで配信しない、paused = 停止、draft = 未完成。
              </p>
            </div>
          </div>
        </div>
      </div>
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

// SimStat 削除済 (Stage 7、続 M-12): ScenarioStatsPanel に置換。

// ───────────────────────────────────────────────────────────────────────────

// ConditionVisualBuilder は components/scenarios/condition-visual-builder.tsx で
// editable 版に置換 (Stage 4、続 M-11)。旧 read-only 内部関数は本ファイルから削除済。

function formatAstForDisplay(ast: ConditionNode): string {
  try {
    return JSON.stringify(JSON.parse(canonicalizeAst(ast)), null, 2)
  } catch {
    return canonicalizeAst(ast)
  }
}

// ───────────────────────────────────────────────────────────────────────────

interface VariantEditorProps {
  variant: Variant
  scenarioId: string
  tenantId: string
  onChange: (patch: Partial<Variant>) => void
}

function VariantEditor({ variant, scenarioId, tenantId, onChange }: VariantEditorProps) {
  return (
    <div>
      {/* content_type radio (Stage 3 で switch 可能化) */}
      <div className="flex gap-2 p-1 bg-slate-100 rounded-md mb-3.5">
        <label
          className={`flex-1 flex items-center gap-2 px-3 py-2 rounded cursor-not-allowed ${
            variant.content_type === 'image' ? 'bg-white border border-indigo-300 shadow-sm' : ''
          }`}
        >
          <input type="radio" name="vtype" checked={variant.content_type === 'image'} readOnly />
          <div
            className={`w-7 h-7 rounded-md flex items-center justify-center ${
              variant.content_type === 'image'
                ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                : 'bg-slate-50 text-slate-400'
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </div>
          <div className="text-xs">
            <div className="font-semibold">画像</div>
            <div className="text-[10.5px] text-slate-400">Cloudflare R2 (Stage 3)</div>
          </div>
        </label>
        <label
          className={`flex-1 flex items-center gap-2 px-3 py-2 rounded cursor-not-allowed ${
            variant.content_type === 'html' ? 'bg-white border border-indigo-300 shadow-sm' : ''
          }`}
        >
          <input type="radio" name="vtype" checked={variant.content_type === 'html'} readOnly />
          <div
            className={`w-7 h-7 rounded-md flex items-center justify-center ${
              variant.content_type === 'html'
                ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                : 'bg-slate-50 text-slate-400'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
          </div>
          <div className="text-xs">
            <div className="font-semibold">HTML</div>
            <div className="text-[10.5px] text-slate-400">インライン (Stage 4)</div>
          </div>
        </label>
      </div>

      {/* Content preview (Stage 3-4 で edit 化) */}
      {variant.content_type === 'image' ? (
        <div className="bg-slate-50 border border-slate-200 rounded overflow-hidden">
          <div className="h-44 bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center text-xs text-slate-400 font-mono relative">
            画像プレビュー ({variant.image_width ?? '?'} × {variant.image_height ?? '?'})
            <span className="absolute bottom-2 right-2.5 px-1.5 py-0.5 bg-black/50 text-white rounded text-[10px]">
              {variant.image_url.split('/').pop()}
            </span>
          </div>
          <div className="px-3.5 py-2.5 text-[11.5px] text-slate-600 flex gap-2 items-center">
            <span className="truncate flex-1">{variant.image_alt}</span>
            {variant.content_type === 'image' ? (
              <VariantImageUpload
                scenarioId={scenarioId}
                tenantId={tenantId}
                currentUrl={variant.image_url}
                onUploaded={({ publicUrl }) => onChange({ image_url: publicUrl } as Partial<Variant>)}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <pre className="bg-slate-900 text-slate-100 rounded p-3.5 font-mono text-[11.5px] leading-relaxed border border-slate-700 min-h-[180px] whitespace-pre-wrap overflow-auto">
          {variant.html}
        </pre>
      )}

      <div className="grid grid-cols-[110px_1fr] gap-2.5 items-center mt-3">
        <span className="text-[11.5px] text-slate-500 font-medium">CTA URL</span>
        <Input
          type="url"
          value={variant.cta_url ?? ''}
          onChange={(e) => onChange({ cta_url: e.target.value || undefined } as Partial<Variant>)}
          placeholder="https://bihadashop.jp/products?promo=..."
          className="h-9 text-xs"
        />

        <span className="text-[11.5px] text-slate-500 font-medium">表示位置</span>
        <select
          value={variant.position}
          onChange={(e) => onChange({ position: e.target.value as Variant['position'] } as Partial<Variant>)}
          className="h-9 text-xs px-3 border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
        >
          {VARIANT_POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function SplitBar({ variants }: { variants: ReadonlyArray<Variant> }) {
  const total = variants.reduce((s, v) => s + v.traffic_split, 0)
  return (
    <>
      <div className="flex h-6 rounded overflow-hidden border border-slate-200">
        {variants.map((v) => {
          const color = v.id === 'A' ? 'bg-indigo-500' : v.id === 'B' ? 'bg-purple-500' : 'bg-emerald-500'
          return (
            <div
              key={v.id}
              className={`${color} flex items-center justify-center font-mono text-[11px] text-white font-bold`}
              style={{ width: `${total > 0 ? (v.traffic_split / total) * 100 : 0}%` }}
              title={`variant ${v.id}: ${v.traffic_split}%`}
            >
              {v.traffic_split}%
            </div>
          )
        })}
      </div>
      {total !== 100 ? (
        <div className="text-[11px] text-amber-600 mt-1 font-medium">
          ⚠️ 合計 {total}% (100% にしないと保存できません)
        </div>
      ) : null}
    </>
  )
}
