/**
 * PathAnalysisCanvas — Trigger + horizontal branches + AI Agent rail (続 75 Task B)
 *
 * mockup `linkscrawl/docs/fusion/mockups/11_path_analysis.html` L549-1000+
 * 親 SSOT §3.6.x / §1.7 Anti-Features (セッション録画禁止) / Part V P-11 / D-07
 *
 * 配備履歴:
 *   - 続 74 Task B dispatch → 続 75 配備
 *
 * Phase 1 dogfood スコープ (Server から `data` props で dummy fixture 注入):
 *   - 5 tabs (フローキャンバス active のみ、他 4 つは Sprint 4 で本接続予定)
 *   - 3 経路 (A: 商品直行 / B: ランキング経由 / C: FAQ 経由) を horizontal grid 描画
 *   - 各 node に PageSpeed mini-bar (LCP score + 秒)
 *   - 右 pane: AI Insight + 経路別 dummy 解説 + chat input は disabled (続 73 /chat に統合)
 *
 * Out-of-scope (Sprint 4+):
 *   - 経路 editor (drag & drop)
 *   - ヒートマップ A/B/C 比較 drawer
 *   - リアルタイムログ tail
 *   - chat input 実装 (本 pane では link で /chat に誘導のみ)
 *
 * §1.7 Anti-Features 整合:
 *   - sequence は events table 由来の集計のみで、セッション録画は使わない
 */

'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Edit3,
  Eye,
  HelpCircle,
  ListChecks,
  Play,
  ShoppingCart,
  Sparkles,
  Trophy,
  Zap,
} from 'lucide-react'

import type {
  EvidenceLevel,
  PathAnalysisData,
  PathBranch,
  PathEdge,
  PathNode,
  PathNodePerf,
} from '@/lib/paths/types'

interface PathAnalysisCanvasProps {
  data: PathAnalysisData
  /** 編集画面への href。POC / dummy セットなど編集不可のときは undefined (編集ボタン disabled)。 */
  editHref?: string
}

const TABS = [
  { id: 'flow' as const, label: 'フローキャンバス' },
  { id: 'compare' as const, label: '経路比較', count: 3 },
  { id: 'steps' as const, label: 'ステップ別分析' },
  { id: 'logs' as const, label: 'ログ', count: 412 },
  { id: 'settings' as const, label: '設定' },
]

type TabId = (typeof TABS)[number]['id']

export function PathAnalysisCanvas({ data, editHref }: PathAnalysisCanvasProps) {
  const [tab, setTab] = useState<TabId>('flow')

  return (
    <div className="flex h-full flex-col">
      <HeadStrip data={data} tab={tab} onTabChange={setTab} editHref={editHref} />

      <div className="grid flex-1 min-h-0 grid-cols-[1fr_340px] overflow-hidden">
        <CanvasArea data={data} tab={tab} />
        <AgentRail data={data} />
      </div>
    </div>
  )
}

/* ── HeadStrip ───────────────────────────────────────────────────── */

function HeadStrip({
  data,
  tab,
  onTabChange,
  editHref,
}: {
  data: PathAnalysisData
  tab: TabId
  onTabChange: (id: TabId) => void
  editHref?: string
}) {
  return (
    <header className="border-b border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-6 pb-3 pt-3">
      {/*
        続 78 Task A: title (eyebrow + h1 + sub) は app/(proof)/paths/page.tsx の
        <PageMeta title="経路分析エージェント" eyebrow="..." /> で topbar に集約済。
        本 HeadStrip では workflow 切替用の compact pulldown のみ残す
        (mockup `11_path_analysis.html` の "workflows / 商品購入 · 3 経路" crumb 相当)。
      */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/paths"
          className="inline-flex items-center gap-1.5 rounded border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-2.5 py-1.5 text-xs font-medium text-[color:var(--ug-text-2)] hover:border-[color:var(--ug-border-strong,#d4d8e1)] hover:text-[color:var(--ug-text)]"
          aria-label="経路登録一覧へ戻る"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          一覧
        </Link>
        <WorkflowPulldown
          workflowName={data.workflowName}
          periodDays={data.meta.periodDays}
          branchesCount={data.branches.length}
          averageCvRate={data.meta.averageCvRate}
        />
        <div className="ml-auto flex gap-2">
          {editHref ? (
            <Link
              href={editHref}
              className="inline-flex items-center gap-1.5 rounded border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-3 py-1.5 text-xs font-medium hover:border-[color:var(--ug-border-strong,#d4d8e1)]"
            >
              <Edit3 className="h-3.5 w-3.5" aria-hidden />
              編集
            </Link>
          ) : (
            <button
              type="button"
              disabled
              title="このセット (POC / dummy) は編集できません"
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-3 py-1.5 text-xs font-medium opacity-50"
            >
              <Edit3 className="h-3.5 w-3.5" aria-hidden />
              編集
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded bg-gradient-to-br from-[color:var(--brand-1,#4f6bff)] to-[color:var(--brand-2,#9b5cff)] px-3 py-1.5 text-xs font-medium text-white"
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            監視 ON
          </button>
        </div>
      </div>

      <nav
        className="mt-3 -mb-3 flex gap-0 border-b border-[color:var(--ug-border)]"
        role="tablist"
        aria-label="Path analysis サブタブ"
      >
        {TABS.map((t) => {
          const active = tab === t.id
          const disabled = t.id !== 'flow'
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => !disabled && onTabChange(t.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-[12.5px] font-medium ${
                active
                  ? 'border-[color:var(--brand-1,#4f6bff)] text-[color:var(--ug-text)] font-semibold'
                  : 'border-transparent text-[color:var(--ug-text-2)] opacity-55 cursor-not-allowed'
              }`}
              title={disabled ? 'Phase 1 では「フローキャンバス」のみ active' : undefined}
            >
              {t.label}
              {t.count !== undefined ? (
                <span className="ml-1 rounded bg-[color:var(--ug-bg-2)] px-1.5 py-px font-mono text-[10px] text-[color:var(--ug-text-3)]">
                  {t.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>
    </header>
  )
}

/* ── WorkflowPulldown (続 78 Task A) ─────────────────────────────── */

/**
 * Workflow 切替用 compact pulldown。
 * Phase 1 dogfood では workflow は dummy 1 件 (`商品購入 · 3 経路比較`) のみで
 * 実切替は出来ないため disabled `<button>` で render し、tooltip で
 * 「Sprint 4 で複数 workflow に対応予定」を示す。
 * mockup `11_path_analysis.html` L574 `workflows / 商品購入 · 3 経路` crumb 準拠。
 */
function WorkflowPulldown({
  workflowName,
  periodDays,
  branchesCount,
  averageCvRate,
}: {
  workflowName: string
  periodDays: number
  branchesCount: number
  averageCvRate: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled
        title="Sprint 4 で複数 workflow 切替に対応予定 (Phase 1 dogfood は 1 件固定)"
        aria-label={`現在のワークフロー: ${workflowName}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] px-2.5 py-1.5 text-[12.5px] font-semibold text-[color:var(--ug-text)] opacity-90 cursor-not-allowed"
      >
        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-[color:var(--ug-text-3)]">
          workflows /
        </span>
        <span className="truncate">{workflowName}</span>
        <ChevronDown className="h-3.5 w-3.5 text-[color:var(--ug-text-3)]" aria-hidden />
      </button>
      <span className="text-[11.5px] text-[color:var(--ug-text-2)]">
        過去 {periodDays} 日 · {branchesCount} 経路同時監視 ·{' '}
        <span className="font-mono text-[color:var(--ug-text-3)]">平均 CV 率 {averageCvRate}</span>
      </span>
    </div>
  )
}

/* ── CanvasArea ──────────────────────────────────────────────────── */

function CanvasArea({ data, tab }: { data: PathAnalysisData; tab: TabId }) {
  if (tab !== 'flow') {
    // Phase 1 では disabled なので fall-through しないが、念のため
    return (
      <div className="flex items-center justify-center text-sm text-[color:var(--ug-text-3)]">
        このタブは Sprint 4 で配備予定です。
      </div>
    )
  }

  return (
    <div className="relative overflow-auto bg-[color:var(--ug-bg)]">
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-[color:var(--ug-bg)] via-[color:var(--ug-bg)] to-transparent px-5 pb-2 pt-3.5">
        <span className="font-mono text-[11px] text-[color:var(--ug-text-3)]">
          <strong className="text-[color:var(--ug-text)]">workflows</strong> / {data.workflowName}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded border border-[color:var(--ug-green)]/30 bg-[color:var(--ug-green)]/10 px-2 py-1 font-mono text-[10.5px] text-[color:var(--ug-green)]">
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--ug-green)]"
            aria-hidden
          />
          AI Agent 監視中 · 最終分析 2 分前
        </span>
      </div>

      {/* 続 83 §② Owner feedback: DummyBanner を撤去して main canvas の視認性向上。
          Phase 1 dummy 注釈はワークフロー header の "AI Agent 監視中" badge と
          各 node の数値表示 (実体は dummy fixture) で D-07 整合済。Sprint 4 で実 data
          切替後は DummyBanner 自体が data.isDummy=false で render されない設計。 */}
      <BranchToggles data={data} />

      <div className="min-w-max px-7 pb-16 pt-2">
        <div className="grid grid-cols-[280px_1fr]">
          <TriggerCol data={data} />
          <div className="relative flex flex-col gap-4 pl-0">
            <span
              className="absolute left-0 top-8 bottom-8 w-[2px] bg-[color:var(--ug-border-strong,#d4d8e1)]"
              aria-hidden
            />
            {data.branches.map((b) => (
              <BranchRow key={b.id} branch={b} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// 続 83 §② Owner feedback: DummyBanner function は撤去 (Info import は同ファイル内 BranchRow tooltip で再利用)。
// Phase 1 dummy 注釈は workflow header badge + node 数値で D-07 整合済。
// Sprint 4 で実 data 切替時に observed_approx badge を node 単位で付与する設計 (本 file 変更不要)。

function BranchToggles({ data }: { data: PathAnalysisData }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-7 py-2">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--ug-text-3)]">
        表示中:
      </span>
      {data.branches.map((b) => (
        <span
          key={b.id}
          className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--brand-1,#4f6bff)] px-2.5 py-1 text-[11px] text-white"
        >
          <span className={`h-[7px] w-[7px] rounded-full ${severityDot(b.severity)}`} aria-hidden />
          {b.name}
        </span>
      ))}
    </div>
  )
}

function TriggerCol({ data }: { data: PathAnalysisData }) {
  return (
    <div className="flex items-center pr-0">
      <div className="relative w-[260px] rounded-md border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] shadow-md">
        <span
          aria-hidden
          className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded bg-gradient-to-br from-[color:var(--brand-1,#4f6bff)] to-[color:var(--brand-2,#9b5cff)] shadow-[0_0_0_4px_var(--ug-bg)]"
        />
        <div className="flex items-center gap-2.5 border-b border-[color:var(--ug-border)] px-3.5 py-2.5">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[color:var(--brand-1,#4f6bff)] to-[color:var(--brand-2,#9b5cff)] text-white">
            <Zap className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="flex-1 text-[13px] font-semibold">{data.trigger.title}</div>
          <span className="rounded bg-[color:var(--ug-bg-2)] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--ug-text-3)]">
            START
          </span>
        </div>
        <div className="px-3.5 pb-3 pt-2.5">
          <div className="mb-2 font-mono text-[11px] text-[color:var(--ug-text-2)]">
            {data.trigger.url}
          </div>
          <div className="flex gap-3.5">
            <div>
              <div className="font-mono text-[17px] font-bold leading-none text-[color:var(--ug-text)]">
                {data.trigger.sessions}
              </div>
              <div className="mt-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--ug-text-3)]">
                セッション
              </div>
            </div>
            <div className="ml-auto">
              <div className="font-mono text-[17px] font-bold leading-none text-[color:var(--ug-text)]">
                {data.trigger.periodLabel}
              </div>
              <div className="mt-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--ug-text-3)]">
                期間
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function BranchRow({ branch }: { branch: PathBranch }) {
  return (
    <div className="relative grid grid-cols-[32px_180px_1fr_180px] items-stretch">
      <div className="relative">
        <span
          aria-hidden
          className={`absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 ${severityDot(
            branch.severity,
          )}`}
        />
      </div>

      <div className="flex flex-col justify-center px-3.5 py-3">
        <div className="mb-1 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${severityDot(branch.severity)}`} aria-hidden />
          <span className="text-[13px] font-semibold text-[color:var(--ug-text)]">
            {branch.name}
          </span>
        </div>
        <p className="text-[11.5px] leading-snug text-[color:var(--ug-text-2)]">
          {branch.description}
        </p>
      </div>

      <div className="flex items-center px-3 py-3">
        {branch.nodes.map((node, idx) => (
          <NodeAndEdge
            key={`${branch.id}-${node.id}`}
            node={node}
            edge={branch.edges[idx]}
            isLast={idx === branch.nodes.length - 1}
          />
        ))}
      </div>

      <BranchSum branch={branch} />
    </div>
  )
}

function NodeAndEdge({
  node,
  edge,
  isLast,
}: {
  node: PathNode
  edge: PathEdge | undefined
  isLast: boolean
}) {
  return (
    <>
      <NodeCard node={node} />
      {!isLast && edge ? <EdgeArrow label={edge.label} band={edge.band} /> : null}
    </>
  )
}

function NodeCard({ node }: { node: PathNode }) {
  const Icon = pickIcon(node.step, node.url)
  return (
    <div
      className={`relative min-w-[190px] max-w-[220px] flex-shrink-0 rounded-md border bg-[color:var(--ug-panel)] shadow-sm transition-colors ${nodeBorder(
        node.band,
      )} ${node.selected ? 'ring-2 ring-[color:var(--brand-1,#4f6bff)]/30' : ''}`}
    >
      <div className="flex items-center gap-2 border-b border-[color:var(--ug-border)] px-3 py-2">
        <span
          className={`flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded ${nodeIconBg(
            node.band,
          )}`}
          aria-hidden
        >
          <Icon className="h-3 w-3" />
        </span>
        <div className="flex-1 text-[12px] font-semibold leading-tight text-[color:var(--ug-text)]">
          {node.title}
        </div>
        <span className="rounded bg-[color:var(--ug-bg-2)] px-1.5 py-px font-mono text-[8.5px] text-[color:var(--ug-text-3)]">
          {node.step}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <div className="mb-1.5 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-[color:var(--ug-text-2)]">
          {node.url}
        </div>
        {node.stats.length > 0 ? (
          <div className="flex gap-3">
            {node.stats.map((s) => (
              <div key={s.k}>
                <div className="mb-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-[0.05em] text-[color:var(--ug-text-3)]">
                  {s.k}
                </div>
                <div
                  className={`font-mono text-[11.5px] font-bold ${
                    s.tone === 'pos'
                      ? 'text-[color:var(--ug-green)]'
                      : s.tone === 'neg'
                        ? 'text-[color:var(--ug-red,#d64545)]'
                        : 'text-[color:var(--ug-text)]'
                  }`}
                >
                  {s.v}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* D-07: 未分析ノードは数値を捏造せず「未分析」を表示 (Sprint 4 で events MV 由来に置換) */
          <div className="inline-flex items-center rounded bg-[color:var(--ug-bg-2)] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-[color:var(--ug-text-3)]">
            未分析
          </div>
        )}
      </div>
      {node.perf ? <NodePerfBar perf={node.perf} /> : null}
    </div>
  )
}

function NodePerfBar({ perf }: { perf: PathNodePerf }) {
  const tone =
    perf.band === 'ok'
      ? 'text-[color:var(--ug-green)] bg-[color:var(--ug-bg-subtle,rgba(0,0,0,0.02))]'
      : perf.band === 'warn'
        ? 'text-[color:var(--ug-yellow)] bg-[color:var(--ug-yellow)]/5'
        : 'text-[color:var(--ug-red,#d64545)] bg-[color:var(--ug-red,#d64545)]/5'
  const barBg =
    perf.band === 'ok'
      ? 'bg-[color:var(--ug-green)]'
      : perf.band === 'warn'
        ? 'bg-[color:var(--ug-yellow)]'
        : 'bg-[color:var(--ug-red,#d64545)]'

  return (
    <div
      className={`flex items-center gap-2 border-t border-[color:var(--ug-border)] px-3 py-1.5 ${tone}`}
    >
      <Zap className="h-3 w-3" aria-hidden />
      <span className="font-mono text-[11px] font-bold">{perf.score}</span>
      <span className="relative h-[3px] flex-1 overflow-hidden rounded-sm bg-[color:var(--ug-bg-2)]">
        <span className={`block h-full ${barBg}`} style={{ width: `${perf.score}%` }} />
      </span>
      <span className="font-mono text-[10px] text-[color:var(--ug-text-3)]">
        LCP <strong className="text-[color:var(--ug-text-2)]">{perf.lcp}</strong>
      </span>
    </div>
  )
}

function EdgeArrow({ label, band }: { label: string; band?: PathEdge['band'] }) {
  const lineColor =
    band === 'warn'
      ? 'bg-[color:var(--ug-yellow)]'
      : band === 'crit'
        ? 'bg-[color:var(--ug-red,#d64545)]'
        : 'bg-[color:var(--ug-border-strong,#d4d8e1)]'
  const labelTone =
    band === 'warn'
      ? 'border-[color:var(--ug-yellow)]/40 bg-[color:var(--ug-yellow)]/10 text-[color:var(--ug-yellow)]'
      : band === 'crit'
        ? 'border-[color:var(--ug-red,#d64545)]/40 bg-[color:var(--ug-red,#d64545)]/10 text-[color:var(--ug-red,#d64545)]'
        : 'border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] text-[color:var(--ug-text-2)]'
  const arrowColor =
    band === 'warn'
      ? 'text-[color:var(--ug-yellow)]'
      : band === 'crit'
        ? 'text-[color:var(--ug-red,#d64545)]'
        : 'text-[color:var(--ug-border-strong,#d4d8e1)]'
  return (
    <div className="flex min-w-[56px] flex-col items-center px-1.5">
      <span className={`relative h-[2px] w-full ${lineColor}`}>
        <ArrowRight
          className={`absolute -right-1 -top-1.5 h-3.5 w-3.5 ${arrowColor}`}
          aria-hidden
        />
      </span>
      <span
        className={`mt-1 whitespace-nowrap rounded border px-1.5 py-px font-mono text-[9.5px] ${labelTone}`}
      >
        {label}
      </span>
    </div>
  )
}

function BranchSum({ branch }: { branch: PathBranch }) {
  const cvColor =
    branch.severity === 'ok'
      ? 'text-[color:var(--ug-green)]'
      : branch.severity === 'warn'
        ? 'text-[color:var(--ug-yellow)]'
        : 'text-[color:var(--ug-red,#d64545)]'
  const deltaColor =
    branch.summary.deltaTone === 'pos'
      ? 'text-[color:var(--ug-green)]'
      : 'text-[color:var(--ug-red,#d64545)]'
  return (
    <div className="ml-2 flex flex-col justify-center rounded-md border-l border-[color:var(--ug-border)] bg-[color:var(--ug-bg-subtle,rgba(0,0,0,0.02))] px-3.5 py-3">
      <div className="mb-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--ug-text-3)]">
        最終 CV 率
      </div>
      <div className={`font-mono text-[22px] font-extrabold leading-none ${cvColor}`}>
        {branch.summary.cvRate}
      </div>
      <div className={`mt-1 font-mono text-[10.5px] ${deltaColor}`}>{branch.summary.delta}</div>
      <button
        type="button"
        className="mt-2 rounded border border-[color:var(--ug-border)] px-2.5 py-1 text-[11px] font-medium hover:border-[color:var(--ug-border-strong,#d4d8e1)]"
      >
        詳細
      </button>
    </div>
  )
}

/* ── AgentRail ───────────────────────────────────────────────────── */

function AgentRail({ data }: { data: PathAnalysisData }) {
  return (
    <aside
      className="flex h-full flex-col overflow-hidden border-l border-[color:var(--ug-border)] bg-[color:var(--ug-panel)]"
      aria-label="AI Agent rail"
    >
      <header className="border-b border-[color:var(--ug-border)] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[color:var(--brand-1,#4f6bff)] to-[color:var(--brand-2,#9b5cff)] text-white"
            aria-hidden
          >
            <Bot className="h-3.5 w-3.5" />
          </span>
          <div>
            <h3 className="text-[13.5px] font-semibold">UGOKIMAP Agent</h3>
            <div className="mt-0.5 font-mono text-[11px] text-[color:var(--ug-text-3)]">
              path-analysis · live monitor
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tag>LIVE</Tag>
          <Tag>{data.branches.length} BRANCHES</Tag>
          {/* D-07: evidence level を明示 (planned/inferred は断定数値禁止) */}
          <Tag>D-07 {evidenceBadge(data.evidenceLevel)}</Tag>
        </div>
      </header>

      <section className="flex-1 overflow-y-auto">
        {data.insights.length > 0 ? (
          data.insights.map((insight) => (
            <article
              key={insight.id}
              className="border-b border-[color:var(--ug-border)] bg-gradient-to-b from-[color:var(--brand-1,#4f6bff)]/[0.03] to-transparent px-4 py-3"
            >
              <div
                className={`mb-1.5 flex items-center gap-1.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] ${insightLabelColor(
                  insight.severity,
                )}`}
              >
                <Sparkles className="h-3 w-3" aria-hidden />
                {insight.label}
              </div>
              <p className="text-[12px] leading-relaxed text-[color:var(--ug-text)]">
                {insight.body}
              </p>
            </article>
          ))
        ) : (
          <div className="px-4 py-8 text-center text-[12px] leading-relaxed text-[color:var(--ug-text-3)]">
            まだ分析結果がありません。
            <br />
            計測データが蓄積されると AI Insight がここに表示されます。
          </div>
        )}
      </section>

      <footer className="border-t border-[color:var(--ug-border)] bg-[color:var(--ug-bg-subtle,rgba(0,0,0,0.02))] px-3.5 py-2.5">
        <form
          aria-disabled
          className="flex items-center gap-2"
          onSubmit={(e) => e.preventDefault()}
        >
          <input
            type="text"
            disabled
            placeholder="Phase 1 では chat 入力は disabled (続 73 /chat に統合)"
            className="flex-1 cursor-not-allowed rounded border border-[color:var(--ug-border)] bg-[color:var(--ug-bg-2)] px-2.5 py-1.5 text-[12px] text-[color:var(--ug-text-3)] opacity-60"
          />
          <button
            type="submit"
            disabled
            className="flex h-[30px] w-[30px] cursor-not-allowed items-center justify-center rounded bg-gradient-to-br from-[color:var(--brand-1,#4f6bff)] to-[color:var(--brand-2,#9b5cff)] text-white opacity-60"
            aria-label="送信 (Phase 1 では無効)"
          >
            <ListChecks className="h-3.5 w-3.5" aria-hidden />
          </button>
        </form>
      </footer>
    </aside>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-[color:var(--brand-1,#4f6bff)]/20 bg-[color:var(--brand-1,#4f6bff)]/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--brand-1,#4f6bff)]">
      {children}
    </span>
  )
}

/* ── Styling helpers ─────────────────────────────────────────────── */

function severityDot(s: PathBranch['severity']): string {
  switch (s) {
    case 'ok':
      return 'bg-[color:var(--ug-green)]'
    case 'warn':
      return 'bg-[color:var(--ug-yellow)]'
    case 'crit':
      return 'bg-[color:var(--ug-red,#d64545)]'
  }
}

function nodeBorder(b: PathNode['band']): string {
  switch (b) {
    case 'warn':
      return 'border-[color:var(--ug-red,#d64545)]/40'
    case 'win':
      return 'border-[color:var(--ug-green)]/40'
    default:
      return 'border-[color:var(--ug-border)]'
  }
}

function nodeIconBg(b: PathNode['band']): string {
  switch (b) {
    case 'warn':
      return 'border border-[color:var(--ug-red,#d64545)]/30 bg-[color:var(--ug-red,#d64545)]/10 text-[color:var(--ug-red,#d64545)]'
    case 'win':
      return 'border border-[color:var(--ug-green)]/30 bg-[color:var(--ug-green)]/10 text-[color:var(--ug-green)]'
    default:
      return 'border border-[color:var(--ug-border)] bg-[color:var(--ug-bg-2)] text-[color:var(--ug-text)]'
  }
}

/** D-07: evidence_level を rail バッジ用の短い英大文字に変換。 */
function evidenceBadge(level: EvidenceLevel): string {
  switch (level) {
    case 'proven':
      return 'PROVEN'
    case 'observed':
      return 'OBSERVED'
    case 'inferred':
      return 'INFERRED'
    case 'planned':
      return 'PLANNED'
  }
}

function insightLabelColor(sev: 'info' | 'warn' | 'crit'): string {
  switch (sev) {
    case 'info':
      return 'text-[color:var(--brand-1,#4f6bff)]'
    case 'warn':
      return 'text-[color:var(--ug-yellow)]'
    case 'crit':
      return 'text-[color:var(--ug-red,#d64545)]'
  }
}

/* ── Icon picker (step / url から推定) ───────────────────────────── */

type IconComponent = typeof Eye
function pickIcon(step: string, url: string): IconComponent {
  if (step === 'CV' || step.endsWith('CV')) return Check
  if (url.includes('cart')) return ShoppingCart
  if (url.includes('ranking')) return Trophy
  if (url.includes('faq')) return HelpCircle
  return Eye
}
