'use client'

/**
 * ScenarioNewView — 新規シナリオ作成 Phase 2.1 (M-Director、2026-06-07)
 *
 * Phase 2.1 で旧 ScenarioNewSkeleton (全 disabled) → 実機能化:
 *   - 条件 (左カラム): NlConditionInput + ConditionVisualBuilder + DryRunPreviewPanel
 *   - バリアント (右カラム): VariantSetEditor で A/B/C + image_url/HTML + traffic_split
 *   - 保存ボタン: POST /api/scenarios で draft 保存 → /scenarios/[id] 遷移
 *
 * 画像の R2 アップロードは保存後の編集画面 (/scenarios/[id]) で行う:
 *   - sign-url が scenario_id を必須にするため、新規 flow では URL 直接入力 or HTML
 *   - 保存して scenario_id が確定したあと、編集画面で VariantImageUpload を使う
 *
 * 親 SSOT: linkscrawl/docs/fusion/team/m-director/prd.md §6 (Phase 2)
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, Save } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConditionVisualBuilder } from './condition-visual-builder'
import { DryRunPreviewPanel } from './dry-run-preview-panel'
import { NlConditionInput, type NlGenerationMeta } from './nl-condition-input'
import {
  VariantSetEditor,
  makeInitialVariants,
  validateVariantsForSubmit,
} from './variant-set-editor'
import { emptyConditionAst } from '@/lib/scenarios/condition-ast-ops'
import { validateConditionAst, type ConditionNode, type Variant } from '@/lib/scenarios/types'

interface ScenarioNewViewProps {
  /** JWT 由来の許可済 site_ids (server component から注入)。空配列 = 利用可能サイトなし。 */
  availableSiteIds: ReadonlyArray<string>
}

export function ScenarioNewView({ availableSiteIds }: ScenarioNewViewProps) {
  const router = useRouter()

  const [ast, setAst] = useState<ConditionNode>(emptyConditionAst())
  const [variants, setVariants] = useState<Variant[]>(makeInitialVariants())
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [siteId, setSiteId] = useState<string>(availableSiteIds[0] ?? '')
  const [nlMeta, setNlMeta] = useState<NlGenerationMeta | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const astErrors = validateConditionAst(ast)
  const variantErrors = validateVariantsForSubmit(variants)
  const nameError = name.trim().length === 0 ? '名前は必須' : null

  const canSubmit =
    !isSaving &&
    siteId.length > 0 &&
    nameError === null &&
    astErrors.length === 0 &&
    variantErrors.length === 0

  function handleNlGenerated(newAst: ConditionNode, meta: NlGenerationMeta): void {
    setAst(newAst)
    setNlMeta(meta)
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return
    setIsSaving(true)
    setSubmitError(null)

    try {
      const body = {
        site_id: siteId,
        name: name.trim(),
        description: description.trim() || undefined,
        condition_ast: ast,
        variants,
        // 新規作成は常に draft で開始 (Owner が編集画面で live に昇格)
        status: 'draft' as const,
        evidence_level: 'planned' as const,
      }
      const res = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status !== 201) {
        const errorBody = await res.json().catch(() => ({ error: 'unknown' }))
        const issues = Array.isArray(errorBody.issues)
          ? errorBody.issues
              .map((i: { path: string; message: string }) => `${i.path}: ${i.message}`)
              .join(' / ')
          : ''
        throw new Error(
          `保存に失敗しました (HTTP ${res.status}${issues ? ': ' + issues : errorBody.message ? ': ' + errorBody.message : ''})`,
        )
      }
      const created = (await res.json()) as { id: string }
      toast.success('保存しました', { description: '編集画面に移動します' })
      // /scenarios/[id] page は JWT-derived tenant + site_id クエリで scenario をロードする。
      // 保存直後の遷移先で tenant/site ミスマッチ 404 を避けるため、site_id を明示的に渡す
      // (Codex T2 dual review 指摘 C 反映)。
      router.push(
        `/scenarios/${encodeURIComponent(created.id)}?site_id=${encodeURIComponent(siteId)}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : '通信エラー'
      setSubmitError(msg)
      toast.error('保存に失敗', { description: msg })
    } finally {
      setIsSaving(false)
    }
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
            className="font-mono text-[10px] uppercase tracking-wider bg-emerald-50 text-emerald-700 border-emerald-300"
          >
            Phase 2.1 (条件 + バリアント + 保存)
          </Badge>
          <div className="ml-auto flex gap-2 items-center">
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={handleSubmit}
              title={
                canSubmit
                  ? 'draft として保存し、編集画面に移動します'
                  : '名前・条件・バリアントを揃えてください'
              }
            >
              {isSaving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}
              {isSaving ? '保存中...' : '保存 (draft)'}
            </Button>
          </div>
        </div>

        {/* Name / description / site selector */}
        <div className="mb-3 grid grid-cols-[80px_1fr] gap-y-2 gap-x-2 items-center max-w-3xl">
          <span className="text-xs font-medium text-slate-600">名前 *</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 初回訪問者向けクーポン"
            maxLength={255}
            className={`h-9 text-xs ${nameError ? 'border-rose-300' : ''}`}
          />
          <span className="text-xs font-medium text-slate-600">説明</span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="(任意) 内部メモ"
            maxLength={2000}
            className="h-9 text-xs"
          />
          <span className="text-xs font-medium text-slate-600">対象サイト</span>
          {availableSiteIds.length === 0 ? (
            <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-300 inline-flex self-start">
              利用可能サイトなし — Owner にお問い合わせください
            </Badge>
          ) : (
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="h-9 px-2.5 text-xs font-mono border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 max-w-md"
              aria-label="対象サイト"
            >
              {availableSiteIds.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>

        {submitError ? (
          <div className="mb-3 p-2.5 rounded border border-rose-200 bg-rose-50 text-[11.5px] text-rose-700">
            保存エラー: {submitError}
          </div>
        ) : null}

        <div className="grid grid-cols-[1.25fr_1fr] gap-4">
          {/* LEFT: 条件 */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <h3 className="text-sm font-semibold flex-1">条件 (誰に発火するか)</h3>
              <span className="font-mono text-[10px] text-slate-400">depth ≤ 5 / leaf ≤ 30</span>
              {astErrors.length > 0 ? (
                <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-300">
                  {astErrors.length} errors
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

              {astErrors.length > 0 ? (
                <ul className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5 space-y-0.5">
                  {astErrors.map((err, i) => (
                    <li key={i}>
                      <span className="font-mono">{err.code}</span>: {err.message}
                      {err.field ? ` (${err.field})` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* Dry-run preview */}
            {siteId ? (
              <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                <DryRunPreviewPanel
                  conditionAst={ast}
                  siteId={siteId}
                  hasValidationErrors={astErrors.length > 0}
                />
              </div>
            ) : null}
          </div>

          {/* RIGHT: バリアント */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <h3 className="text-sm font-semibold flex-1">バリアント (A/B/C 最大 3 つ)</h3>
              {variantErrors.length > 0 ? (
                <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-300">
                  {variantErrors.length} errors
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-300">
                  valid
                </Badge>
              )}
            </div>

            <div className="px-4 py-3">
              <VariantSetEditor variants={variants} onChange={setVariants} />

              {variantErrors.length > 0 ? (
                <ul className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5 space-y-0.5">
                  {variantErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 text-[10.5px] text-slate-500 leading-relaxed">
              💡 画像の <b>R2 アップロード</b> は保存後の編集画面 (/scenarios/[id]) で行います。
              ここでは画像 URL を直接入力するか、HTML バリアントを使ってください。
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
