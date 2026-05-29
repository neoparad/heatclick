'use client'

/**
 * ScenarioNewSkeleton — 新規シナリオ作成 skeleton UI (M-Director 続 M-6 §C、2026-05-25)
 *
 * Phase 1 では実装せず、「Phase 2 で配備予定」 disclaimer と Visual Builder の形だけ表示。
 * 全入力は disabled、保存ボタンも disabled。一覧 page の「新規バナー」CTA から到達する。
 *
 * Phase 2 で:
 *   - react-hook-form + Zod (ScenarioSchema) で form 永続化
 *   - 自然言語 input → Claude Haiku で AST 変換
 *   - Visual Builder で AST manual 編集
 *   - A/B/C variant 編集 (画像 R2 upload + HTML editor)
 *   - traffic split slider
 *   - POST /api/scenarios で永続化
 */

import Link from 'next/link'
import { ArrowLeft, Construction, Plus, Save, Sparkles } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ScenarioNewSkeleton() {
  return (
    <>
      <PageMeta title="新規バナー" eyebrow="M Agent · Scenarios" />

      <div className="px-8 pt-4 pb-16">
        {/* Header (続 M-6 §A 同方針で 1 行に圧縮) */}
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
            <Construction className="h-2.5 w-2.5 mr-1" /> Phase 2 配備予定
          </Badge>
          <div className="ml-auto flex gap-2 items-center">
            <Button variant="outline" size="sm" disabled>
              プレビュー
            </Button>
            <Button size="sm" disabled title="Phase 2 で実装">
              <Save className="mr-1.5 h-3 w-3" /> 保存
            </Button>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="mb-4 p-3.5 rounded-md border border-amber-200 bg-amber-50/60 text-xs text-amber-900 leading-relaxed">
          <div className="flex items-center gap-2 font-semibold text-amber-800 mb-1">
            <Construction className="h-3.5 w-3.5" /> Phase 1 では新規作成は無効化されています
          </div>
          現在は <Link href="/scenarios" className="underline">一覧</Link> の 1 シナリオ (hard-code) のみ配信中。新規シナリオ作成 UI は <b className="font-semibold">Phase 2 (Sprint M-2)</b> で本実装予定:
          自然言語入力 → AI で条件式に変換 / GTM 風 Visual Builder / 画像 (R2) or HTML editor / A/B/C variant 編集 / traffic split / preview 配信。
        </div>

        {/* 2-col skeleton */}
        <div className="grid grid-cols-[1.25fr_1fr] gap-4">
          {/* LEFT: condition skeleton */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <h3 className="text-sm font-semibold flex-1">条件 (誰に発火するか)</h3>
              <span className="font-mono text-[10px] text-slate-400">depth ≤ 5 / leaf ≤ 30</span>
            </div>

            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
              <div className="text-[11px] text-slate-500 mb-2 font-mono uppercase tracking-wider font-semibold">
                自然言語入力 (Phase 2)
              </div>
              <Input
                disabled
                placeholder="例: 初回訪問で 1 分以上いてカートに行ってないユーザー"
                className="h-9 text-xs disabled:opacity-100 bg-white"
              />
              <div className="flex gap-2 mt-2">
                <Button variant="outline" size="sm" disabled>
                  <Sparkles className="mr-1 h-3 w-3" /> AI で条件式に変換
                </Button>
                <span className="font-mono text-[10.5px] text-slate-400 self-center ml-auto">
                  Claude Haiku 4.5 (Phase 2)
                </span>
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] text-slate-500 mb-2 font-mono uppercase tracking-wider font-semibold">
                Visual Builder
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-1.5">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="grid grid-cols-[1.1fr_104px_1fr_24px] gap-1.5 items-center">
                    <Input disabled placeholder="field" className="h-8 text-xs disabled:opacity-100 bg-white font-mono" />
                    <Input disabled placeholder="op" className="h-8 text-xs text-center disabled:opacity-100 bg-white font-mono" />
                    <Input disabled placeholder="value" className="h-8 text-xs disabled:opacity-100 bg-white" />
                    <div className="text-slate-300 flex justify-center text-xs">×</div>
                  </div>
                ))}
                <div className="flex gap-2 pt-2 mt-2 border-t border-slate-200">
                  <Button variant="outline" size="sm" disabled className="border-dashed">
                    <Plus className="mr-1 h-3 w-3" /> 条件追加
                  </Button>
                  <Button variant="outline" size="sm" disabled className="border-dashed">
                    <Plus className="mr-1 h-3 w-3" /> グループ追加
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT: variant skeleton */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <h3 className="text-sm font-semibold flex-1">バリアント (A/B/C 最大 3 つ)</h3>
              <span className="font-mono text-[10px] text-slate-400">画像 or HTML</span>
            </div>

            <div className="flex gap-1.5 px-4 pt-2.5 border-b border-slate-100 bg-slate-50 items-end">
              <div className="px-3.5 py-2 text-xs font-semibold rounded-t-md border border-indigo-300 bg-white text-indigo-700 -mb-[1px] flex items-center gap-2">
                <span className="w-4.5 h-4.5 rounded-full bg-indigo-500 text-white font-mono text-[10px] font-bold flex items-center justify-center">
                  A
                </span>
                variant A
              </div>
              <div className="px-3.5 py-2 text-xs font-semibold border-2 border-dashed border-slate-300 rounded-t-md text-slate-400 -mb-[1px] flex items-center gap-1">
                <Plus className="h-3 w-3" /> 追加
              </div>
              <div className="ml-auto font-mono text-[10.5px] text-slate-400 pb-2">1 / 3 variants</div>
            </div>

            <div className="px-4 py-4">
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-md mb-3.5">
                <label className="flex-1 flex items-center gap-2 px-3 py-2 rounded bg-white border border-indigo-300 shadow-sm cursor-default">
                  <input type="radio" name="vtype-new" checked readOnly disabled />
                  <span className="text-xs font-semibold">画像</span>
                </label>
                <label className="flex-1 flex items-center gap-2 px-3 py-2 rounded text-slate-400 cursor-default">
                  <input type="radio" name="vtype-new" disabled />
                  <span className="text-xs font-semibold">HTML</span>
                </label>
              </div>

              <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-md p-8 text-center text-xs text-slate-400">
                <div className="font-medium mb-1">画像をアップロード</div>
                <div className="text-[10.5px]">Cloudflare R2 / 最大 2MB / JPG, PNG, WebP (Phase 2)</div>
              </div>

              <div className="grid grid-cols-[110px_1fr] gap-2.5 items-center mt-3">
                <span className="text-[11.5px] text-slate-500 font-medium">CTA URL</span>
                <Input disabled placeholder="https://example.com/promo" className="h-9 text-xs disabled:opacity-100" />
                <span className="text-[11.5px] text-slate-500 font-medium">表示位置</span>
                <Input disabled placeholder="画面中央 (POP)" className="h-9 text-xs disabled:opacity-100" />
              </div>
            </div>
          </div>
        </div>

        {/* Footer CTA */}
        <div className="mt-6 p-3 rounded border border-slate-200 bg-slate-50 text-xs text-slate-600 text-center leading-relaxed">
          Phase 2 完成までは <Link href="/scenarios" className="underline font-medium">一覧</Link> の hard-code シナリオを参照ください。 Phase 2 仕様詰めは Owner と Sprint M-2 着工時に。
        </div>
      </div>
    </>
  )
}
