'use client'

/**
 * ExperimentsView — 標準実験の一覧 / 作成 / lifecycle / 結果表示 (宝プロジェクト 残タスク②)
 *
 * 設計:
 *   - 施策は **固定 taxonomy からの選択式のみ** (自由記述フィールドは存在しない — 鉄則)。
 *   - 結果は /api/experiments/[id]/result (サーバー側 redaction 済) を fetch して
 *     ExperimentResultCard に渡すだけ。クライアントで数値を再計算・判定しない。
 *   - lifecycle: start (owner/admin、サーバーが RBAC 強制) / stop / archive。
 *   - pool_opt_in は同意チェックボックス (k≥50 匿名集約の説明付き)。
 */

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { ExperimentResultCard } from '@/components/experiments/experiment-result-card'
import {
  DEVICE_LABELS,
  INDUSTRY_LABELS,
  INTERVENTION_LABELS,
  METRIC_LABELS,
  PAGE_TYPE_LABELS,
  STATUS_LABELS,
} from '@/components/experiments/labels'
import type { ExperimentResultView } from '@/lib/experiments/result-view-model'
import {
  DEVICES,
  EXPERIMENT_WINDOWS,
  INDUSTRIES,
  INTERVENTION_TYPES,
  PAGE_TYPES,
  PRIMARY_METRICS,
} from '@/lib/experiments/taxonomy'
import type { Experiment } from '@/lib/experiments/types'
import { cn } from '@/lib/utils'

interface ExperimentsViewProps {
  siteId: string
  experiments: ReadonlyArray<Experiment>
  /** registry 未接続 (DDL 未適用 / env 未設定) の表示用 */
  registryUnavailable?: boolean
}

interface CreateFormState {
  name: string
  url_pattern: string
  intervention_type: (typeof INTERVENTION_TYPES)[number]
  page_type: (typeof PAGE_TYPES)[number]
  industry: (typeof INDUSTRIES)[number]
  device: (typeof DEVICES)[number]
  primary_metric: (typeof PRIMARY_METRICS)[number]
  window: (typeof EXPERIMENT_WINDOWS)[number]
  pool_opt_in: boolean
  /** M6: CTA selector (cta_placement / sticky_cta_mobile)。空 = A/A 計測のみ。 */
  cta_selector: string
  /** M6: 非表示にする任意項目 selector (form_field_reduction、改行区切り)。 */
  field_selectors_text: string
}

const INITIAL_FORM: CreateFormState = {
  name: '',
  url_pattern: '/',
  intervention_type: 'cta_placement',
  page_type: 'product',
  industry: 'd2c_ec',
  device: 'mobile',
  primary_metric: 'cvr',
  window: '28d',
  pool_opt_in: false,
  cta_selector: '',
  field_selectors_text: '',
}

/** form state → render_config (空入力は null = A/A)。 */
function buildRenderConfig(form: CreateFormState): Record<string, unknown> | null {
  if (form.intervention_type === 'form_field_reduction') {
    const selectors = form.field_selectors_text
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 20)
    return selectors.length > 0 ? { kind: 'form_fields', field_selectors: selectors } : null
  }
  const sel = form.cta_selector.trim()
  return sel.length > 0 ? { kind: 'cta', cta_selector: sel } : null
}

export function ExperimentsView({ siteId, experiments, registryUnavailable }: ExperimentsViewProps) {
  const router = useRouter()
  const [form, setForm] = useState<CreateFormState>(INITIAL_FORM)
  const [busy, setBusy] = useState<string | null>(null) // 実行中の操作キー
  const [error, setError] = useState<string | null>(null)
  const [resultViews, setResultViews] = useState<Record<string, ExperimentResultView>>({})
  const [openResultId, setOpenResultId] = useState<string | null>(null)

  const sorted = useMemo(
    () => [...experiments].sort((a, b) => (a.created_at > b.created_at ? -1 : 1)),
    [experiments],
  )

  const callApi = useCallback(
    async (key: string, input: string, init: RequestInit): Promise<boolean> => {
      setBusy(key)
      setError(null)
      try {
        const res = await fetch(input, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
          setError(body?.message ?? body?.error ?? `操作に失敗しました (${res.status})`)
          return false
        }
        return true
      } catch {
        setError('ネットワークエラーが発生しました')
        return false
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const handleCreate = useCallback(async () => {
    const ok = await callApi('create', '/api/experiments', {
      method: 'POST',
      body: JSON.stringify({
        site_id: siteId,
        name: form.name,
        url_pattern: form.url_pattern,
        taxonomy: {
          intervention_type: form.intervention_type,
          page_type: form.page_type,
          industry: form.industry,
          device: form.device,
          primary_metric: form.primary_metric,
          window: form.window,
        },
        pool_opt_in: form.pool_opt_in,
        render_config: buildRenderConfig(form),
      }),
    })
    if (ok) {
      setForm(INITIAL_FORM)
      router.refresh()
    }
  }, [callApi, form, router, siteId])

  const handleAction = useCallback(
    async (id: string, action: 'start' | 'stop' | 'archive') => {
      const ok = await callApi(
        `${action}:${id}`,
        `/api/experiments/${id}/status?site_id=${encodeURIComponent(siteId)}`,
        { method: 'POST', body: JSON.stringify({ action }) },
      )
      if (ok) router.refresh()
    },
    [callApi, router, siteId],
  )

  const handleShowResult = useCallback(
    async (id: string) => {
      if (openResultId === id) {
        setOpenResultId(null)
        return
      }
      setBusy(`result:${id}`)
      setError(null)
      try {
        const res = await fetch(`/api/experiments/${id}/result?site_id=${encodeURIComponent(siteId)}`)
        if (!res.ok) {
          setError(`結果の取得に失敗しました (${res.status})`)
          return
        }
        const view = (await res.json()) as ExperimentResultView
        setResultViews((prev) => ({ ...prev, [id]: view }))
        setOpenResultId(id)
      } catch {
        setError('ネットワークエラーが発生しました')
      } finally {
        setBusy(null)
      }
    },
    [openResultId, siteId],
  )

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-text-1">標準 A/B テスト</h1>
        <p className="mt-1 text-sm text-text-3">
          固定された施策タイプから選んで 2 案 (現状 A / 施策 B) を 50/50 で配信します。割付はサーバー側で行われ、
          結果の確定判定は全社の横断プールで行います (単一サイトでは断定しません)。
        </p>
      </div>

      {registryUnavailable ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          実験レジストリに接続できません (DDL 未適用または DB 設定未投入)。設定後に再読込してください。
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* ── 新規作成 (taxonomy は選択式のみ) ── */}
      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-1">新しい実験</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="実験名">
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="例: 商品ページ モバイル CTA"
            />
          </Field>
          <Field label="対象パス (prefix)">
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
              value={form.url_pattern}
              onChange={(e) => setForm((f) => ({ ...f, url_pattern: e.target.value }))}
              placeholder="/products"
            />
          </Field>
          <SelectField
            label="施策 (mechanical のみ)"
            value={form.intervention_type}
            options={INTERVENTION_TYPES.map((v) => [v, INTERVENTION_LABELS[v]])}
            onChange={(v) => setForm((f) => ({ ...f, intervention_type: v as CreateFormState['intervention_type'] }))}
          />
          <SelectField
            label="ページ種別"
            value={form.page_type}
            options={PAGE_TYPES.map((v) => [v, PAGE_TYPE_LABELS[v]])}
            onChange={(v) => setForm((f) => ({ ...f, page_type: v as CreateFormState['page_type'] }))}
          />
          <SelectField
            label="業種"
            value={form.industry}
            options={INDUSTRIES.map((v) => [v, INDUSTRY_LABELS[v]])}
            onChange={(v) => setForm((f) => ({ ...f, industry: v as CreateFormState['industry'] }))}
          />
          <SelectField
            label="デバイス"
            value={form.device}
            options={DEVICES.map((v) => [v, DEVICE_LABELS[v]])}
            onChange={(v) => setForm((f) => ({ ...f, device: v as CreateFormState['device'] }))}
          />
          <SelectField
            label="主要指標"
            value={form.primary_metric}
            options={PRIMARY_METRICS.map((v) => [v, METRIC_LABELS[v]])}
            onChange={(v) => setForm((f) => ({ ...f, primary_metric: v as CreateFormState['primary_metric'] }))}
          />
          <SelectField
            label="計測期間"
            value={form.window}
            options={EXPERIMENT_WINDOWS.map((v) => [v, v.replace('d', '日間')])}
            onChange={(v) => setForm((f) => ({ ...f, window: v as CreateFormState['window'] }))}
          />
          {form.intervention_type === 'form_field_reduction' ? (
            <Field label="非表示にする任意項目の CSS selector（改行区切り・最大20。必須項目は自動でスキップ）">
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
                rows={3}
                value={form.field_selectors_text}
                onChange={(e) => setForm((f) => ({ ...f, field_selectors_text: e.target.value }))}
                placeholder={'#company-field\n.optional-row'}
              />
            </Field>
          ) : (
            <Field label="CTA の CSS selector（アンカー要素。空なら計測のみ＝表示変更なし）">
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
                value={form.cta_selector}
                onChange={(e) => setForm((f) => ({ ...f, cta_selector: e.target.value }))}
                placeholder="#buy-button"
              />
            </Field>
          )}
        </div>
        <label className="flex items-start gap-2 text-xs text-text-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.pool_opt_in}
            onChange={(e) => setForm((f) => ({ ...f, pool_opt_in: e.target.checked }))}
          />
          <span>
            匿名の横断プールに参加する — 結果は 50 サイト以上が集まったセルでのみ匿名集計され、
            サイト名・訪問者情報は共有されません。参加すると「効く施策」の全社判定が利用できます。
          </span>
        </label>
        <button
          className="rounded-md bg-text-1 px-4 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          disabled={busy === 'create' || form.name.trim() === '' || !form.url_pattern.startsWith('/')}
          onClick={() => void handleCreate()}
        >
          {busy === 'create' ? '作成中…' : '下書きとして作成'}
        </button>
      </section>

      {/* ── 一覧 ── */}
      <section className="space-y-3">
        {sorted.length === 0 ? (
          <p className="text-sm text-text-3">まだ実験がありません。上のフォームから作成してください。</p>
        ) : null}
        {sorted.map((experiment) => (
          <div key={experiment.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-1 truncate">{experiment.name}</p>
                <p className="text-xs text-text-3">
                  {INTERVENTION_LABELS[experiment.taxonomy.intervention_type]} · {experiment.url_pattern} ·{' '}
                  {DEVICE_LABELS[experiment.taxonomy.device]} · {METRIC_LABELS[experiment.taxonomy.primary_metric]}
                </p>
              </div>
              <span
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs',
                  experiment.status === 'running'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-border bg-muted/40 text-text-2',
                )}
              >
                {STATUS_LABELS[experiment.status]}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              {experiment.status === 'draft' ? (
                <ActionButton
                  label="開始 (owner/admin)"
                  busy={busy === `start:${experiment.id}`}
                  onClick={() => void handleAction(experiment.id, 'start')}
                />
              ) : null}
              {experiment.status === 'running' ? (
                <ActionButton
                  label="停止"
                  busy={busy === `stop:${experiment.id}`}
                  onClick={() => void handleAction(experiment.id, 'stop')}
                />
              ) : null}
              {experiment.status === 'draft' || experiment.status === 'stopped' ? (
                <ActionButton
                  label="アーカイブ"
                  busy={busy === `archive:${experiment.id}`}
                  onClick={() => void handleAction(experiment.id, 'archive')}
                />
              ) : null}
              {experiment.status !== 'draft' ? (
                <ActionButton
                  label={openResultId === experiment.id ? '結果を閉じる' : '結果を見る'}
                  busy={busy === `result:${experiment.id}`}
                  onClick={() => void handleShowResult(experiment.id)}
                />
              ) : null}
            </div>

            {openResultId === experiment.id && resultViews[experiment.id] ? (
              <ExperimentResultCard view={resultViews[experiment.id]} />
            ) : null}
          </div>
        ))}
      </section>
    </div>
  )
}

interface FieldProps {
  label: string
  children: React.ReactNode
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-2">{label}</span>
      {children}
    </label>
  )
}

interface SelectFieldProps {
  label: string
  value: string
  options: ReadonlyArray<readonly [string, string]>
  onChange: (value: string) => void
}

function SelectField({ label, value, options, onChange }: SelectFieldProps) {
  return (
    <Field label={label}>
      <select
        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  )
}

interface ActionButtonProps {
  label: string
  busy: boolean
  onClick: () => void
}

function ActionButton({ label, busy, onClick }: ActionButtonProps) {
  return (
    <button
      className="rounded-md border border-border bg-background px-3 py-1 text-xs text-text-2 hover:bg-muted/60 disabled:opacity-50"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? '…' : label}
    </button>
  )
}
