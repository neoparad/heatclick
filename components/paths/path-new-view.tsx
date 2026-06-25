'use client'

/**
 * PathNewView — 新規 経路 (比較セット) 登録フォーム (経路ビルダー)
 *
 * ユーザーは「定義」のみ入力する (path-builder-form 共有 UI):
 *   - セット名 / 説明 / トリガー / 経路(steps)
 * 数値 (通過/離脱/CV率/PageSpeed) は分析結果なので入力しない (server が空で埋め、UI は「未分析」表示)。
 * 送信 → POST /api/paths → 成功で /paths/[id] へ遷移。
 *
 * 親 SSOT: scenarios/scenario-new-view.tsx と同方針 / D-07。
 */

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { PageMeta } from '@/components/layout/page-meta'
import { Button } from '@/components/ui/button'
import {
  Field,
  PathBuilderFields,
  defaultBuilderValue,
  draftToBranchInputs,
  usePathBuilder,
  validateBuilder,
} from '@/components/paths/path-builder-form'

interface PathNewViewProps {
  availableSiteIds: ReadonlyArray<string>
}

export function PathNewView({ availableSiteIds }: PathNewViewProps) {
  const router = useRouter()
  const [siteId, setSiteId] = useState(availableSiteIds[0] ?? '')
  const [submitting, setSubmitting] = useState(false)
  const { value, handlers } = usePathBuilder(defaultBuilderValue())

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!siteId) {
      toast.error('サイトが選択されていません')
      return
    }
    const error = validateBuilder(value)
    if (error) {
      toast.error(error)
      return
    }

    const body = {
      site_id: siteId,
      name: value.name.trim(),
      description: value.description.trim() || undefined,
      trigger: {
        title: value.triggerTitle.trim(),
        url: value.triggerUrl.trim(),
        periodDays: value.periodDays,
      },
      branches: draftToBranchInputs(value.branches),
    }

    setSubmitting(true)
    try {
      const resp = await fetch('/api/paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          message?: string
          error?: string
        }
        toast.error(`登録に失敗しました: ${data.message ?? data.error ?? resp.status}`)
        return
      }
      const created = (await resp.json()) as { id: string }
      toast.success('経路を登録しました')
      router.push(`/paths/${created.id}?site_id=${encodeURIComponent(siteId)}`)
    } catch (err) {
      toast.error(`通信エラー: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageMeta title="新規経路を登録" eyebrow="行動分析 · Path Analysis" />

      <form onSubmit={handleSubmit} className="mx-auto max-w-3xl px-8 pt-4 pb-20">
        <div className="mb-4 flex items-center gap-2">
          <Link
            href="/paths"
            className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 一覧へ戻る
          </Link>
        </div>

        <PathBuilderFields
          value={value}
          handlers={handlers}
          basicExtra={
            availableSiteIds.length > 1 ? (
              <Field label="対象サイト" htmlFor="site">
                <select
                  id="site"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {availableSiteIds.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null
          }
        />

        {/* 注記 + 送信 */}
        <div className="mt-5 rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[11.5px] leading-relaxed text-slate-600">
          登録するのは経路の「定義」のみです。通過率 / 離脱 / CV 率 / PageSpeed
          などの数値は計測データが蓄積された後に各経路の詳細へ反映されます（それまで「未分析」表示・D-07）。
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Link
            href="/paths"
            className="inline-flex items-center rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            キャンセル
          </Link>
          <Button type="submit" variant="gradient" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> 登録中...
              </>
            ) : (
              '経路を登録'
            )}
          </Button>
        </div>
      </form>
    </>
  )
}
