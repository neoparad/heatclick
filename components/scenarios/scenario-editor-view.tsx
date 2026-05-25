'use client'

/**
 * ScenarioEditorView — シナリオ編集 UI (M-Director Day 2、2026-05-25)
 *
 * mockup `linkscrawl/docs/fusion/mockups/20_scenarios_editor.html` 踏襲。
 * Phase 1 read-only skeleton: 条件 / variant A/B/C / traffic split / status を表示。
 * Save は disabled (CRUD は Phase 2)。
 *
 * 注意: Phase 1 では Visual Builder の入力は全て disabled (form 値変更不可)。
 * Phase 2 で react-hook-form + Zod validation を導入して on-change 永続化。
 */

import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Check, Code2, Eye, ImageIcon, Plus, Save, Trash2 } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { canonicalizeAst } from '@/lib/scenarios/evaluator'
import type { ConditionNode, Scenario, Variant } from '@/lib/scenarios/types'
import { isLeaf } from '@/lib/scenarios/types'

interface ScenarioEditorViewProps {
  scenario: Scenario
}

export function ScenarioEditorView({ scenario }: ScenarioEditorViewProps) {
  const [activeVariantId, setActiveVariantId] = useState<string>(scenario.variants[0]?.id ?? 'A')
  const activeVariant = scenario.variants.find((v) => v.id === activeVariantId) ?? scenario.variants[0]

  return (
    <>
      <PageMeta title="ターゲティングバナー" eyebrow="M Agent · Editor" />

      <div className="px-7 pt-5 pb-16 max-w-[1360px] mx-auto">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto] gap-4 items-end mb-5">
          <div>
            <div className="font-mono text-[10.5px] text-slate-400 uppercase tracking-wider mb-1.5">
              M AGENT · ターゲティングバナー · 編集
            </div>
            <h1 className="text-[22px] font-bold tracking-tight flex items-center gap-2.5">
              <Input
                value={scenario.name}
                disabled
                className="text-[22px] font-bold border-0 px-2 py-0.5 min-w-[540px] bg-transparent disabled:opacity-100 disabled:cursor-default"
              />
            </h1>
            <div className="text-xs text-slate-500 mt-1 flex gap-2.5 items-center">
              <span className="font-mono text-[11px] px-1.5 py-0.5 bg-slate-100 rounded">
                {scenario.site_id}
              </span>
              <StatusPill status={scenario.status} />
              <Badge variant="outline" className="font-mono text-[9.5px] uppercase tracking-wider">
                {scenario.evidence_level}
              </Badge>
              <span>· 最終更新 {new Date(scenario.updated_at).toISOString().slice(0, 16).replace('T', ' ')} · A/B/C variants {scenario.variants.length} 件</span>
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <Link
              href="/scenarios"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md hover:bg-slate-100 transition-colors"
            >
              <ArrowLeft className="h-3 w-3" /> 一覧へ
            </Link>
            <Button variant="outline" size="sm" disabled>
              <Eye className="mr-1.5 h-3 w-3" /> プレビュー
            </Button>
            <Button size="sm" disabled title="Phase 2 で実装">
              <Save className="mr-1.5 h-3 w-3" /> 保存
            </Button>
          </div>
        </div>

        {/* 2-col grid */}
        <div className="grid grid-cols-[1.25fr_1fr] gap-4.5">
          {/* LEFT: condition builder */}
          <div>
            <Panel
              title="条件 (誰に発火するか)"
              meta="depth ≤ 5 / leaf ≤ 30"
            >
              <div className="px-4 py-3.5 bg-slate-50 border-b border-slate-100">
                <ConditionVisualBuilder ast={scenario.condition_ast} />
              </div>
              <div className="bg-slate-900 text-slate-100 px-4 py-3 font-mono text-[11.5px] leading-relaxed overflow-x-auto whitespace-pre">
                {formatAstForDisplay(scenario.condition_ast)}
              </div>
            </Panel>

            {/* Simulation */}
            <SectionHeader>対象想定 (過去 7 日シミュレーション)</SectionHeader>
            <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm grid grid-cols-4 gap-3.5">
              <SimStat label="対象 visitor" value="612" />
              <SimStat label="match 件数" value="847" />
              <SimStat label="推定 CVR" value="4.3%" valueClassName="text-emerald-600" />
              <SimStat label="サイト平均" value="2.1%" valueClassName="text-slate-400" />
            </div>
          </div>

          {/* RIGHT: variant editor */}
          <div>
            <Panel title="バリアント (A/B/C 最大 3 つ)" meta="画像 or HTML、汎用フィールドなし">
              {/* A/B/C tabs */}
              <div className="flex gap-1.5 px-4 pt-2.5 border-b border-slate-100 bg-slate-50 items-end">
                {scenario.variants.map((v) => {
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
                {scenario.variants.length < 3 ? (
                  <button
                    type="button"
                    disabled
                    title="Phase 2 で実装"
                    className="px-3.5 py-2 text-xs font-semibold border-2 border-dashed border-slate-300 rounded-t-md text-slate-400 -mb-[1px] flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" /> 追加
                  </button>
                ) : null}
                <div className="ml-auto font-mono text-[10.5px] text-slate-400 pb-2">
                  {scenario.variants.length} / 3 variants
                </div>
              </div>

              <div className="px-4 py-4">
                {activeVariant ? <VariantEditor variant={activeVariant} /> : null}
              </div>
            </Panel>

            {/* Traffic split */}
            <SectionHeader>traffic split (A/B/C 配信比率)</SectionHeader>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
              <SplitBar variants={scenario.variants} />
              <div className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                visitor_id の hash で決定論的に振り分け (同 visitor は常に同じ variant が当たる、ページ遷移してもブレない)。
                各 variant の impression / click / dismiss / conversion を計測し、勝者を観測。Phase 3 で AI 自動勝者振り分けに昇格予定。
              </div>
            </div>

            {/* Status section */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 mt-3">
              <div className="text-xs font-semibold mb-2 flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-slate-400" /> 配信ステータス
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {(['draft', 'measure_only', 'preview', 'live', 'paused'] as const).map((s) => (
                  <label
                    key={s}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 border rounded text-[11.5px] cursor-default ${
                      scenario.status === s
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-semibold'
                        : 'bg-white border-slate-200 text-slate-500'
                    }`}
                  >
                    <input type="radio" name="status" checked={scenario.status === s} readOnly className="m-0" />
                    {s}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                Phase 1 は read-only。Phase 2 で変更 + 保存可能化予定。
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

function SimStat({
  label,
  value,
  valueClassName = '',
}: {
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div>
      <div className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">{label}</div>
      <div className={`font-mono text-lg font-bold mt-1 ${valueClassName}`}>{value}</div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function ConditionVisualBuilder({ ast }: { ast: ConditionNode }) {
  if (!isLeaf(ast) && ast.op === 'AND') {
    return (
      <div className="bg-white border border-slate-200 rounded-md p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex bg-slate-50 border border-slate-200 rounded p-0.5">
            <span className="px-2.5 py-0.5 font-mono text-[10.5px] font-bold bg-gradient-to-br from-indigo-500 to-purple-500 text-white rounded">
              AND
            </span>
            <span className="px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-slate-400 cursor-not-allowed">OR</span>
            <span className="px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-slate-400 cursor-not-allowed">NOT</span>
          </span>
          <span className="text-[11.5px] text-slate-500 flex-1">
            {ast.children.length} 条件すべてを満たす
          </span>
        </div>

        <div className="space-y-1.5">
          {ast.children.map((c, i) =>
            isLeaf(c) ? (
              <div
                key={i}
                className="grid grid-cols-[1.1fr_104px_1fr_24px] gap-1.5 items-center"
              >
                <Input value={c.field} disabled className="h-8 text-xs font-mono disabled:opacity-100" />
                <Badge
                  variant="outline"
                  className="justify-center font-mono text-[10.5px] text-indigo-700 bg-indigo-50 border-indigo-200 h-8 px-2 font-semibold"
                >
                  {c.op}
                </Badge>
                <Input value={String(c.value)} disabled className="h-8 text-xs disabled:opacity-100" />
                <button
                  type="button"
                  disabled
                  className="text-slate-300 p-1 cursor-not-allowed"
                  title="Phase 2 で実装"
                  aria-label="削除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div key={i} className="text-[11px] text-slate-400 pl-2 italic">
                (nested {c.op} group — Phase 2 で render)
              </div>
            ),
          )}
        </div>

        <div className="flex gap-2 pt-2.5 mt-2.5 border-t border-slate-100">
          <Button variant="outline" size="sm" disabled className="border-dashed">
            <Plus className="mr-1 h-3 w-3" /> 条件追加
          </Button>
          <Button variant="outline" size="sm" disabled className="border-dashed">
            <Plus className="mr-1 h-3 w-3" /> グループ追加
          </Button>
        </div>
      </div>
    )
  }
  return <div className="text-xs text-slate-500">条件式が読み込めません</div>
}

function formatAstForDisplay(ast: ConditionNode): string {
  // canonicalizeAst を pretty 化
  try {
    return JSON.stringify(JSON.parse(canonicalizeAst(ast)), null, 2)
  } catch {
    return canonicalizeAst(ast)
  }
}

// ───────────────────────────────────────────────────────────────────────────

function VariantEditor({ variant }: { variant: Variant }) {
  return (
    <div>
      {/* content_type radio */}
      <div className="flex gap-2 p-1 bg-slate-100 rounded-md mb-3.5">
        <label
          className={`flex-1 flex items-center gap-2 px-3 py-2 rounded cursor-default ${
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
            <div className="text-[10.5px] text-slate-400">Cloudflare R2</div>
          </div>
        </label>
        <label
          className={`flex-1 flex items-center gap-2 px-3 py-2 rounded cursor-default ${
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
            <div className="text-[10.5px] text-slate-400">インライン</div>
          </div>
        </label>
      </div>

      {/* Content preview */}
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
            <Button variant="outline" size="sm" disabled>差し替え</Button>
          </div>
        </div>
      ) : (
        <pre className="bg-slate-900 text-slate-100 rounded p-3.5 font-mono text-[11.5px] leading-relaxed border border-slate-700 min-h-[180px] whitespace-pre-wrap overflow-auto">
          {variant.html}
        </pre>
      )}

      <div className="grid grid-cols-[110px_1fr] gap-2.5 items-center mt-3">
        <span className="text-[11.5px] text-slate-500 font-medium">CTA URL</span>
        <Input value={variant.cta_url ?? ''} disabled className="h-9 text-xs disabled:opacity-100" />

        <span className="text-[11.5px] text-slate-500 font-medium">表示位置</span>
        <Input value={variant.position} disabled className="h-9 text-xs disabled:opacity-100" />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function SplitBar({ variants }: { variants: ReadonlyArray<Variant> }) {
  return (
    <>
      <div className="flex h-6 rounded overflow-hidden border border-slate-200">
        {variants.map((v) => {
          const color = v.id === 'A' ? 'bg-indigo-500' : v.id === 'B' ? 'bg-purple-500' : 'bg-emerald-500'
          return (
            <div
              key={v.id}
              className={`${color} flex items-center justify-center font-mono text-[11px] text-white font-bold`}
              style={{ width: `${v.traffic_split}%` }}
            >
              {v.traffic_split}%
            </div>
          )
        })}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        {variants.map((v) => {
          const color = v.id === 'A' ? 'text-indigo-600' : v.id === 'B' ? 'text-purple-600' : 'text-emerald-600'
          return (
            <div key={v.id} className="px-2 py-1.5 border border-slate-200 rounded bg-white flex items-center gap-1.5">
              <span className={`font-mono text-[10.5px] font-bold ${color}`}>{v.id}</span>
              <Input value={String(v.traffic_split)} disabled className="w-12 h-6 text-right text-[11.5px] font-mono p-1 disabled:opacity-100" />
              <span className="text-[10.5px] text-slate-400">%</span>
            </div>
          )
        })}
      </div>
    </>
  )
}
