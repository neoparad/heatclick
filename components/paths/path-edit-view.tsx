'use client'

/**
 * PathEditView — 既存 経路 (比較セット) の編集フォーム
 *
 * path-builder-form の共有 UI を流用し、PUT /api/paths/[id] で更新する。
 * 新規との差分:
 *   - 初期値を既存 PathSet から復元 (pathSetToDraft)
 *   - ステータス (draft / monitoring / paused / archived) を編集可能
 *   - 削除 (DELETE /api/paths/[id]) ボタン
 *
 * 注意 (Phase 1): 経路の構造 (steps) を変更すると分析数値はリセットされる。
 * Phase 1 の KV セットは未分析 (空 stats) のため実害なし。Sprint 4 で再計測される。
 */

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { PageMeta } from '@/components/layout/page-meta'
import { Button } from '@/components/ui/button'
import {
  Field,
  PathBuilderFields,
  draftToBranchInputs,
  pathSetToDraft,
  usePathBuilder,
  validateBuilder,
} from '@/components/paths/path-builder-form'
import {
  PATHSET_STATUSES,
  buildBranchesFromInput,
  type PathSet,
  type PathSetStatus,
} from '@/lib/paths/types'

interface PathEditViewProps {
  pathSet: PathSet
}

const STATUS_LABELS: Record<PathSetStatus, string> = {
  draft: '下書き',
  monitoring: '監視中',
  paused: '一時停止',
  archived: 'アーカイブ',
}

export function PathEditView({ pathSet }: PathEditViewProps) {
  const router = useRouter()
  const siteId = pathSet.site_id
  const detailHref = `/paths/${pathSet.id}?site_id=${encodeURIComponent(siteId)}`

  const { value, handlers } = usePathBuilder(pathSetToDraft(pathSet))
  const [status, setStatus] = useState<PathSetStatus>(pathSet.status)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const error = validateBuilder(value)
    if (error) {
      toast.error(error)
      return
    }

    const body = {
      name: value.name.trim(),
      description: value.description.trim(),
      status,
      trigger: {
        title: value.triggerTitle.trim(),
        url: value.triggerUrl.trim(),
        periodDays: value.periodDays,
        // 既存の計測値 (sessions) は構造定義の編集では保持する
        sessions: pathSet.trigger.sessions,
      },
      branches: buildBranchesFromInput(draftToBranchInputs(value.branches)),
    }

    setSubmitting(true)
    try {
      const resp = await fetch(`/api/paths/${pathSet.id}?site_id=${encodeURIComponent(siteId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          message?: string
          error?: string
        }
        toast.error(`更新に失敗しました: ${data.message ?? data.error ?? resp.status}`)
        return
      }
      toast.success('経路を更新しました')
      router.push(detailHref)
      router.refresh()
    } catch (err) {
      toast.error(`通信エラー: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!window.confirm(`「${pathSet.name}」を削除します。よろしいですか？`)) {
      return
    }
    setDeleting(true)
    try {
      const resp = await fetch(`/api/paths/${pathSet.id}?site_id=${encodeURIComponent(siteId)}`, {
        method: 'DELETE',
      })
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          message?: string
          error?: string
        }
        toast.error(`削除に失敗しました: ${data.message ?? data.error ?? resp.status}`)
        return
      }
      toast.success('経路を削除しました')
      router.push('/paths')
      router.refresh()
    } catch (err) {
      toast.error(`通信エラー: ${(err as Error).message}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <PageMeta title="経路を編集" eyebrow="行動分析 · Path Analysis" />

      <form onSubmit={handleSubmit} className="mx-auto max-w-3xl px-8 pt-4 pb-20">
        <div className="mb-4 flex items-center gap-2">
          <Link
            href={detailHref}
            className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 詳細へ戻る
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            className="ml-auto text-rose-600 hover:bg-rose-50 hover:text-rose-700"
          >
            {deleting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1 h-3.5 w-3.5" />
            )}
            削除
          </Button>
        </div>

        <PathBuilderFields
          value={value}
          handlers={handlers}
          basicExtra={
            <Field label="ステータス" htmlFor="status">
              <select
                id="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as PathSetStatus)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {PATHSET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          }
        />

        <div className="mt-5 rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[11.5px] leading-relaxed text-slate-600">
          経路の構造（ステップ）を変更すると、蓄積済みの分析数値はリセットされ「未分析」に戻ります（D-07）。
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Link
            href={detailHref}
            className="inline-flex items-center rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            キャンセル
          </Link>
          <Button type="submit" variant="gradient" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> 更新中...
              </>
            ) : (
              '変更を保存'
            )}
          </Button>
        </div>
      </form>
    </>
  )
}
