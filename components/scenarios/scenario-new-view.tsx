'use client'

/**
 * ScenarioNewView — 新規シナリオ作成 Phase 2 partial (M-Director、2026-06-07)
 *
 * 旧 ScenarioNewSkeleton (全 disabled) を置換。
 * - 条件 (左カラム): NlConditionInput + ConditionVisualBuilder を実機能化。
 * - バリアント (右カラム): Phase 2.1 で本実装、現状は disclaimer のみ。
 * - 保存ボタン: バリアント実装完了まで disabled。
 *
 * 親 SSOT: linkscrawl/docs/fusion/team/m-director/prd.md §6 (Phase 2)
 */

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Construction, Save } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConditionVisualBuilder } from './condition-visual-builder'
import { NlConditionInput, type NlGenerationMeta } from './nl-condition-input'
import { emptyConditionAst } from '@/lib/scenarios/condition-ast-ops'
import { validateConditionAst, type ConditionNode } from '@/lib/scenarios/types'

export function ScenarioNewView() {
  const [ast, setAst] = useState<ConditionNode>(emptyConditionAst())
  const [name, setName] = useState('')
  const [nlMeta, setNlMeta] = useState<NlGenerationMeta | null>(null)

  const validationErrors = validateConditionAst(ast)

  function handleNlGenerated(newAst: ConditionNode, meta: NlGenerationMeta): void {
    setAst(newAst)
    setNlMeta(meta)
  }

  return (
    <>
      <PageMeta title="新規バナー" eyebrow="M Agent · Scenarios" />

      <div className="px-8 pt-4 pb-16">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <Link
            href="/scenarios"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-600 text-[11.5px] font-medium hover:bg-slate-50 transition-colors"
          >
            <ArrowLeft className="h-3 w-3" /> 一覧へ
          </Link>
          <Badge
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-wider bg-amber-50 text-amber-700 border-amber-300"
          >
            <Construction className="h-2.5 w-2.5 mr-1" /> Phase 2 (条件のみ実装)
          </Badge>
          <div className="ml-auto flex gap-2 items-center">
            <Button variant="outline" size="sm" disabled title="Phase 2.1 で実装">
              プレビュー
            </Button>
            <Button size="sm" disabled title="バリアント未実装のため保存は Phase 2.1 で">
              <Save className="mr-1.5 h-3 w-3" /> 保存
            </Button>
          </div>
        </div>

        {/* Name */}
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-medium text-slate-600 shrink-0">名前</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 初回訪問者向けクーポン"
            maxLength={255}
            className="h-9 text-xs max-w-md"
          />
        </div>

        {/* Disclaimer */}
        <div className="mb-4 p-3 rounded-md border border-amber-200 bg-amber-50/60 text-xs text-amber-900 leading-relaxed">
          <div className="flex items-center gap-2 font-semibold text-amber-800 mb-0.5">
            <Construction className="h-3.5 w-3.5" /> 条件のみ Phase 2 で実装済
          </div>
          自然言語 → AI で AST 変換 + Visual Builder で編集が稼働中。
          バリアント (画像/HTML) と保存は <b className="font-semibold">Phase 2.1</b> で配備予定。
          現状はトライ & ヒアリング用途。
        </div>

        <div className="grid grid-cols-[1.25fr_1fr] gap-4">
          {/* LEFT: condition (実機能) */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <h3 className="text-sm font-semibold flex-1">条件 (誰に発火するか)</h3>
              <span className="font-mono text-[10px] text-slate-400">depth ≤ 5 / leaf ≤ 30</span>
              {validationErrors.length > 0 ? (
                <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-300">
                  {validationErrors.length} errors
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-300">
                  valid
                </Badge>
              )}
            </div>

            <div className="px-4 py-3 border-b border-slate-100">
              <NlConditionInput onAstGenerated={handleNlGenerated} />
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] text-slate-500 mb-2 font-mono uppercase tracking-wider font-semibold">
                Visual Builder {nlMeta ? '(AI 提案を編集してください)' : ''}
              </div>
              <ConditionVisualBuilder ast={ast} onChange={setAst} />

              {validationErrors.length > 0 ? (
                <ul className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5 space-y-0.5">
                  {validationErrors.map((err, i) => (
                    <li key={i}>
                      <span className="font-mono">{err.code}</span>: {err.message}
                      {err.field ? ` (${err.field})` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          {/* RIGHT: variant skeleton (Phase 2.1) */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <h3 className="text-sm font-semibold flex-1">バリアント (A/B/C 最大 3 つ)</h3>
              <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-300">
                Phase 2.1 で配備
              </Badge>
            </div>

            <div className="px-4 py-8 text-center text-xs text-slate-400">
              <Construction className="mx-auto h-6 w-6 mb-2" />
              <div className="font-medium">画像 (R2) / HTML editor / traffic split は Phase 2.1 で実装予定</div>
              <div className="mt-1 text-[10.5px]">
                先に条件 (左) を Visual Builder で確定し、後でバリアントを追加します。
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
