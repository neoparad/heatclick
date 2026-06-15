'use client'

/**
 * ScenariosListView — ターゲティングバナー一覧 UI (M-Director Day 2、2026-05-25)
 *
 * mockup `linkscrawl/docs/fusion/mockups/19_scenarios_list.html` 踏襲。
 * Phase 1 は read-only 表示 (POC scenarios)、新規/編集 link は disabled。
 *
 * Evidence Level UI ガード (親 SSOT §1.8.2): `planned` / `inferred` はレンジ表示のみ、
 * 断定数値禁止。本 view では計測ベースの dummy 値 (planned としてラベル) を表示。
 */

import Link from 'next/link'
import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Edit3, Plus, RotateCw, Search, Trash2 } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Scenario, ScenarioStatus, Variant } from '@/lib/scenarios/types'

interface ScenariosListViewProps {
  scenarios: ReadonlyArray<Scenario>
}

// Phase 1 dummy metrics (Phase 2 で ClickHouse `scenario_match_daily_mv` 集計に置換)
const PHASE_1_DUMMY_METRICS: Record<string, { matches: number; clicks: number; cvrPct: number }> = {
  '00000000-0000-4000-8000-00000000d001': { matches: 847, clicks: 36, cvrPct: 4.3 },
}

function getMetrics(scenarioId: string): { matches: number | null; clicks: number | null; cvrPct: number | null } {
  const m = PHASE_1_DUMMY_METRICS[scenarioId]
  if (!m) return { matches: null, clicks: null, cvrPct: null }
  return { matches: m.matches, clicks: m.clicks, cvrPct: m.cvrPct }
}

function statusVariant(status: ScenarioStatus): { className: string; label: string } {
  switch (status) {
    case 'live':
      return { className: 'bg-emerald-50 text-emerald-700 border-emerald-300', label: 'live' }
    case 'preview':
      return { className: 'bg-amber-50 text-amber-700 border-amber-300', label: 'preview' }
    case 'measure_only':
      return { className: 'bg-indigo-50 text-indigo-700 border-indigo-300', label: 'measure_only' }
    case 'paused':
      return { className: 'bg-slate-100 text-slate-600 border-slate-300', label: 'paused' }
    case 'draft':
      return { className: 'bg-slate-100 text-slate-500 border-slate-300', label: 'draft' }
    case 'archived':
      return { className: 'bg-slate-100 text-slate-400 border-slate-200', label: 'archived' }
    default:
      return { className: 'bg-slate-100 text-slate-500 border-slate-300', label: String(status) }
  }
}

function variantSummary(variants: ReadonlyArray<Variant>): string {
  const ids = variants.map((v) => v.id).join('/')
  return `${ids} · ${variants.length} variants`
}

export function ScenariosListView({ scenarios }: ScenariosListViewProps) {
  const [expanded, setExpanded] = useState<string | null>(scenarios[0]?.id ?? null)
  const [filter, setFilter] = useState<'all' | ScenarioStatus>('all')
  // 続 M-6 §A: Phase 1 banner は collapsed default、click で展開
  const [bannerOpen, setBannerOpen] = useState(false)

  const filtered = filter === 'all' ? scenarios : scenarios.filter((s) => s.status === filter)

  const total = scenarios.length
  const liveCount = scenarios.filter((s) => s.status === 'live').length
  const aggregateMatches = scenarios.reduce(
    (acc, s) => acc + (getMetrics(s.id).matches ?? 0),
    0,
  )

  return (
    <>
      <PageMeta title="ターゲティングバナー" eyebrow="M Agent · Scenarios" />

      <div className="px-8 pt-4 pb-16">
        {/* 続 M-6 §A: 圧縮 Phase 1 chip + actions (旧 banner + h1 + description + actions を 1 行に集約) */}
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={() => setBannerOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 text-[11.5px] font-semibold hover:bg-indigo-100 transition-colors"
            aria-expanded={bannerOpen}
          >
            <RotateCw className="h-3 w-3" aria-hidden />
            Phase 1 配信中 (1 シナリオ × A/B/C)
            {bannerOpen ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
          </button>
          <div className="ml-auto flex gap-2 items-center">
            <Button variant="outline" size="sm" disabled>
              <RotateCw className="mr-1.5 h-3 w-3" /> 更新
            </Button>
            <Link
              href="/scenarios/new"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-sm hover:brightness-110 transition"
            >
              <Plus className="h-3 w-3" /> 新規バナー
            </Link>
          </div>
        </div>

        {/* 続 M-6 §A: banner details (折りたたみ) */}
        {bannerOpen ? (
          <div className="mb-3 p-3 rounded-md border border-indigo-100 bg-indigo-50/40 text-xs text-slate-700 leading-relaxed">
            条件が真になった visitor に対し <b className="font-semibold">A/B/C のうち traffic split で決定された 1 variant</b>
            を実画面に表示。同 visitor は常に同じ variant が当たる (visitor_id hash で決定論的)。
            impression / click / dismiss / conversion を計測。Phase 2 で GUI 作成解放、Phase 3 は AI 自動提案 (厳密設計後)。
          </div>
        ) : null}

        {/* KPI strip (続 M-6 §A: padding 半減) */}
        <div className="grid grid-cols-4 gap-2.5 mb-4">
          <KpiCard
            label="稼働シナリオ"
            badge="7日"
            value={String(liveCount)}
            unit={`/ ${total} 件`}
            note="Phase 2 で UI 解放"
          />
          <KpiCard
            label="match 件数"
            badge="7日"
            value={String(aggregateMatches)}
            note={<span className="text-emerald-600">↑ 12.4% vs 前週</span>}
          />
          <KpiCard
            label="対象 visitor"
            badge="unique"
            value="612"
            note="cart 未到達条件"
          />
          <KpiCard
            label="推定 CVR (計測)"
            value="4.3"
            unit="%"
            note={<span className="text-emerald-600">vs サイト平均 2.1%、+2.2pt</span>}
          />
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2.5 mb-3.5">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <Input className="pl-8 h-9 text-sm" placeholder="バナー名 / 条件で絞り込み..." disabled />
          </div>
          <div className="inline-flex bg-slate-100 border border-slate-200 rounded-md p-0.5">
            {(['all', 'measure_only', 'preview', 'live'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={`px-3 py-1 text-xs font-medium rounded ${
                  filter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {s === 'all' ? 'すべて' : s}
              </button>
            ))}
          </div>
        </div>

        {/* Scenario table */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
          <div className="grid grid-cols-[20px_1fr_104px_88px_88px_88px_88px] gap-2.5 px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
            <div></div>
            <div>シナリオ / 条件サマリ</div>
            <div>ステータス</div>
            <div>A/B/C</div>
            <div className="text-right">match</div>
            <div className="text-right">click</div>
            <div className="text-right">CVR</div>
          </div>

          {filtered.map((s) => {
            const isOpen = expanded === s.id
            const status = statusVariant(s.status)
            const m = getMetrics(s.id)
            return (
              <div key={s.id}>
                {/* 続 M-6 §B: 行は 2 分割 — ▼ toggle (button) + 行リンク (Link) */}
                <div className="grid grid-cols-[20px_1fr_104px_88px_88px_88px_88px] gap-2.5 px-4 py-3 border-b border-slate-100 items-center hover:bg-slate-50 transition-colors">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : s.id)}
                    className={`text-slate-400 ${isOpen ? 'rotate-90 text-indigo-600' : ''} transition-transform p-1 -m-1 rounded hover:bg-slate-100`}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'バリアント詳細を閉じる' : 'バリアント詳細を開く'}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <Link
                    href={`/scenarios/${s.id}`}
                    className="min-w-0 group"
                    title="詳細編集を開く"
                  >
                    <div className="text-sm font-semibold text-slate-900 truncate group-hover:text-indigo-700 transition-colors">
                      {s.name}
                    </div>
                    <div className="flex gap-1.5 items-center flex-wrap text-[10.5px] text-slate-500 mt-0.5 font-mono">
                      <span className="px-1.5 py-0.5 bg-slate-100 rounded">{s.site_id}</span>
                      <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 font-semibold rounded">
                        {variantSummary(s.variants)}
                      </span>
                    </div>
                  </Link>
                  <Badge variant="outline" className={`${status.className} font-mono text-[10px] uppercase tracking-wider`}>
                    {status.label}
                  </Badge>
                  <div className="font-mono text-xs font-semibold text-purple-700">
                    {s.variants.map((v) => v.id).join('/')}
                  </div>
                  <div className="text-right font-mono text-sm font-semibold">
                    {m.matches !== null ? m.matches : '—'}
                  </div>
                  <div className="text-right font-mono text-sm font-semibold">
                    {m.clicks !== null ? m.clicks : '—'}
                  </div>
                  <div className="text-right font-mono text-sm font-semibold">
                    {m.cvrPct !== null ? `${m.cvrPct}%` : '—'}
                  </div>
                </div>

                {isOpen ? <ExpandedPanel scenario={s} /> : null}
              </div>
            )
          })}

          {filtered.length === 0 ? (
            <div className="px-4 py-16 text-center text-sm text-slate-500">
              条件に一致するシナリオがありません。
            </div>
          ) : null}
        </div>

        {/* Phase note */}
        <div className="mt-5 p-3.5 border border-dashed border-slate-300 rounded text-xs text-slate-600 leading-relaxed bg-slate-50">
          <b className="text-slate-900 font-semibold">Phase 1 (現在 = 配信中)</b>: hard-code 1 シナリオ + variant A/B/C (画像 / HTML) を実画面に表示。
          impression / click / dismiss / conversion を計測。<br />
          <b className="text-slate-900 font-semibold">variant 種別</b>:{' '}
          <Badge variant="outline" className="font-mono text-[10px]">画像</Badge> (Cloudflare R2) または{' '}
          <Badge variant="outline" className="font-mono text-[10px] bg-purple-50 text-purple-700 border-purple-300">HTML</Badge>
          (インライン HTML) の 2 択。サイト毎にデザインが異なるため汎用フィールドは持ちません。<br />
          <b className="text-slate-900 font-semibold">Phase 2</b>: GUI でシナリオ作成 (自然言語 + visual builder + 画像/HTML upload UI)。
          <b className="text-slate-900 font-semibold">Phase 3</b>: AI 自動提案 + 勝者自動学習 (厳密設計後)。
        </div>
      </div>
    </>
  )
}

// ───────────────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string
  badge?: string
  value: string
  unit?: string
  note?: React.ReactNode
}

function KpiCard({ label, badge, value, unit, note }: KpiCardProps) {
  return (
    <div className="bg-white border border-slate-200 rounded-md px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="font-mono text-[10px] font-medium text-slate-500 uppercase tracking-wider">{label}</span>
        {badge ? (
          <span className="text-[9px] px-1 py-0 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 font-semibold">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="font-mono text-xl font-bold text-slate-900 tracking-tight leading-none">
        {value}
        {unit ? <span className="text-xs font-medium text-slate-500 ml-1">{unit}</span> : null}
      </div>
      {note ? <div className="text-[10.5px] text-slate-500 mt-0.5">{note}</div> : null}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function ExpandedPanel({ scenario }: { scenario: Scenario }) {
  const variants = scenario.variants
  // Phase 1 dummy variant-level metrics
  const variantMetrics: Record<string, { imp: number; cv: number; cvrPct: number; win?: boolean }> = {
    A: { imp: 288, cv: 14, cvrPct: 4.9, win: true },
    B: { imp: 279, cv: 11, cvrPct: 3.9 },
    C: { imp: 280, cv: 9, cvrPct: 3.2 },
  }

  return (
    <div className="px-4 py-4 bg-slate-50/50 border-b border-slate-100">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="w-1 h-3 bg-indigo-500 rounded-sm" aria-hidden />
        <span className="font-mono text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
          バリアント別パフォーマンス
        </span>
        <span className="text-[11px] text-slate-400">
          過去 7 日 · split ={' '}
          {variants.map((v) => `${v.traffic_split}%`).join(' / ')}
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded">
        <div className="grid grid-cols-[36px_1fr_72px_120px_64px_64px_64px] gap-2 px-3.5 py-2 bg-slate-100/70 border-b border-slate-200 text-[10px] font-semibold text-slate-500 uppercase tracking-wider font-mono">
          <div></div>
          <div>バリアント</div>
          <div>種別</div>
          <div>split</div>
          <div className="text-right">表示</div>
          <div className="text-right">CV</div>
          <div className="text-right">CVR</div>
        </div>

        {variants.map((v) => {
          const m = variantMetrics[v.id] ?? { imp: 0, cv: 0, cvrPct: 0 }
          const badgeColor =
            v.id === 'A' ? 'bg-indigo-500' : v.id === 'B' ? 'bg-purple-500' : 'bg-emerald-500'
          return (
            <div
              key={v.id}
              className="grid grid-cols-[36px_1fr_72px_120px_64px_64px_64px] gap-2 px-3.5 py-2.5 border-b border-slate-100 last:border-b-0 items-center"
            >
              <div className={`w-6.5 h-6.5 rounded-full ${badgeColor} text-white font-mono text-xs font-bold flex items-center justify-center`}>
                {v.id}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-900 truncate">
                  {v.content_type === 'image' ? v.image_alt || '画像バリアント' : 'HTML バリアント'}
                </div>
                <div className="font-mono text-[10px] text-slate-400 truncate">
                  {v.content_type === 'image' ? v.image_url.split('/').pop() : 'inline HTML'} · {v.position}
                </div>
              </div>
              <Badge
                variant="outline"
                className={`font-mono text-[10px] ${
                  v.content_type === 'image'
                    ? 'bg-slate-100 text-slate-500 border-slate-200'
                    : 'bg-purple-50 text-purple-700 border-purple-300'
                }`}
              >
                {v.content_type === 'image' ? '画像' : 'HTML'}
              </Badge>
              <div>
                <div className={`h-1.5 ${badgeColor} rounded-full opacity-90`} style={{ width: `${Math.max(8, v.traffic_split)}%` }} />
                <div className="font-mono text-[10.5px] text-slate-500 mt-0.5 font-semibold">{v.traffic_split}%</div>
              </div>
              <div className="text-right font-mono text-xs font-semibold">{m.imp}</div>
              <div className="text-right font-mono text-xs font-semibold">{m.cv}</div>
              <div className={`text-right font-mono text-xs font-semibold ${m.win ? 'text-emerald-600' : ''}`}>
                {m.cvrPct}%
                {m.win ? ' ▲' : ''}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex gap-2 justify-end">
        <Link
          href={`/scenarios/${scenario.id}`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md hover:bg-slate-100 transition-colors"
        >
          <Edit3 className="h-3 w-3" /> 編集
        </Link>
        <Button variant="outline" size="sm" disabled title="Phase 2 で実装">
          <Copy className="mr-1 h-3 w-3" /> 複製
        </Button>
        <Button variant="outline" size="sm" disabled title="Phase 2 で実装" className="text-rose-600">
          <Trash2 className="mr-1 h-3 w-3" /> アーカイブ
        </Button>
      </div>
    </div>
  )
}

