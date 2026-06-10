/**
 * ExperimentResultCard — 宝プロジェクト M4b 顧客向け実験結果カード (requirement D)
 *
 * 観測語彙のみで表示する。判定はサーバー (power-gate + result-view-model) が確定済みで、
 * 本コンポーネントは view をそのまま描画する (数値の再計算・独自判定をしない):
 *   - insufficient      → 「未確定（全社プールで判定中）」 + 進捗バー (観測値は API が null 済)
 *   - observed_single_site → 観測値 (参考) を表示、因果・有意性は主張しない
 *   - pool_supported    → 「効く傾向 / 逆効果の傾向」(全社プール K サイト) + Evidence: Inferred
 *
 * D-07: Evidence Level バッジ必須。inferred/planned で断定数値を出さない (redaction はサーバー側、
 * UI は view.observed_numbers_visible に従うだけ)。
 */

import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import type { ExperimentResultView, ArmView } from '@/lib/experiments/result-view-model'
import { WINDOW_DAYS } from '@/lib/experiments/taxonomy'
import { cn } from '@/lib/utils'

const INTERVENTION_LABELS: Record<string, string> = {
  cta_placement: 'CTA をファーストビューへ',
  sticky_cta_mobile: 'モバイル固定 CTA バー',
  form_field_reduction: 'フォーム項目削減',
}

const METRIC_LABELS: Record<string, string> = {
  cvr: 'CVR',
  cta_click_rate: 'CTA クリック率',
  form_submit_rate: 'フォーム送信率',
}

const STATUS_LABELS: Record<string, string> = {
  draft: '下書き',
  running: '計測中',
  stopped: '計測終了',
  archived: 'アーカイブ',
}

interface ExperimentResultCardProps {
  view: ExperimentResultView
  className?: string
}

export function ExperimentResultCard({ view, className }: ExperimentResultCardProps) {
  const { experiment, verdict, arms } = view
  const t = experiment.taxonomy

  return (
    <div
      className={cn('rounded-xl border border-border bg-card p-5 space-y-4', className)}
      data-experiment-id={experiment.id}
      data-gate-state={verdict.state}
    >
      {/* ── ヘッダ: 実験名 + status + Evidence バッジ (D-07 必須) ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-1 truncate">{experiment.name}</h3>
          <p className="mt-0.5 text-xs text-text-3">
            {INTERVENTION_LABELS[t.intervention_type] ?? t.intervention_type}
            {' · '}
            {experiment.url_pattern}
            {' · '}
            {STATUS_LABELS[experiment.status] ?? experiment.status}
          </p>
        </div>
        <EvidenceBadge
          evidence={{ level: verdict.evidence_level, confidence: 0, references: [] }}
          compact
        />
      </div>

      {/* ── 判定 (観測語彙のみ、headline/note はサーバー確定) ── */}
      <div
        className={cn(
          'rounded-lg border px-4 py-3',
          verdict.direction === 'positive' &&
            'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
          verdict.direction === 'negative' &&
            'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-300',
          verdict.direction === 'none' && 'border-border bg-muted/40 text-text-2',
        )}
      >
        <p className="text-sm font-medium">{verdict.headline}</p>
        <p className="mt-1 text-xs opacity-80">{verdict.note}</p>
        {verdict.state === 'insufficient' ? (
          <SessionsProgress current={verdict.min_arm_sessions} target={verdict.threshold} />
        ) : null}
      </div>

      {/* ── arm 別表示 (観測値は view が redact 済み。null は「蓄積中」) ── */}
      <div className="grid grid-cols-2 gap-3">
        <ArmPanel label="A（現状）" arm={arms.control} metricLabel={METRIC_LABELS[t.primary_metric] ?? t.primary_metric} />
        <ArmPanel label="B（施策）" arm={arms.treatment} metricLabel={METRIC_LABELS[t.primary_metric] ?? t.primary_metric} />
      </div>

      {/* ── taxonomy フッタ (固定分類で実験していることの可視化) ── */}
      <p className="text-[11px] text-text-3">
        {t.page_type} / {t.industry} / {t.device} / {METRIC_LABELS[t.primary_metric] ?? t.primary_metric} /{' '}
        {WINDOW_DAYS[t.window]}日間
        {view.data_unavailable ? ' · データ未接続' : ''}
      </p>
    </div>
  )
}

interface ArmPanelProps {
  label: string
  arm: ArmView
  metricLabel: string
}

function ArmPanel({ label, arm, metricLabel }: ArmPanelProps) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <p className="text-xs font-medium text-text-2">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text-1">
        {arm.cvr !== null ? (
          `${(arm.cvr * 100).toFixed(2)}%`
        ) : (
          <span className="text-sm font-normal text-text-3">蓄積中</span>
        )}
      </p>
      <p className="text-[11px] text-text-3">
        {arm.cvr !== null ? `${metricLabel}（観測値・参考）· ` : ''}
        {arm.sessions_n.toLocaleString()} sessions
        {arm.conversions !== null ? ` · ${arm.conversions.toLocaleString()} 件` : ''}
      </p>
    </div>
  )
}

interface SessionsProgressProps {
  current: number
  target: number
}

function SessionsProgress({ current, target }: SessionsProgressProps) {
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0
  return (
    <div className="mt-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-text-3/50 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-text-3">
        各 arm {current.toLocaleString()} / {target.toLocaleString()} sessions
      </p>
    </div>
  )
}
