'use client'

/**
 * PathsListView — 経路 (比較セット) 登録一覧 UI
 *
 * scenarios-list-view.tsx と同方針のテーブル UI。各行は 1 比較セット (PathSet) で、
 * クリックで /paths/[id] の詳細フローキャンバスへ遷移する。
 *
 * D-07: isDummy=false / 未分析セットは CV 率などを '—' で表示し、断定数値を出さない。
 * POC seed (isDummy=true) のみ INFERRED バッジ付きで dummy 数値を見せる。
 */

import Link from 'next/link'
import { useState } from 'react'
import { ArrowRight, GitBranch, Plus, Search } from 'lucide-react'

import { PageMeta } from '@/components/layout/page-meta'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { summarizePathSet } from '@/lib/paths/poc-pathset'
import type { PathSet, PathSetStatus } from '@/lib/paths/types'

interface PathsListViewProps {
  pathSets: ReadonlyArray<PathSet>
  siteId: string
}

const STATUS_META: Record<PathSetStatus, { className: string; label: string }> = {
  monitoring: {
    className: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    label: '監視中',
  },
  draft: {
    className: 'bg-slate-100 text-slate-500 border-slate-300',
    label: '下書き',
  },
  paused: {
    className: 'bg-amber-50 text-amber-700 border-amber-300',
    label: '一時停止',
  },
  archived: {
    className: 'bg-slate-100 text-slate-400 border-slate-200',
    label: 'アーカイブ',
  },
}

const SEVERITY_META: Record<'ok' | 'warn' | 'crit', { dot: string; label: string }> = {
  ok: { dot: 'bg-emerald-500', label: '健全' },
  warn: { dot: 'bg-amber-500', label: '要注意' },
  crit: { dot: 'bg-rose-500', label: '危険' },
}

export function PathsListView({ pathSets, siteId }: PathsListViewProps) {
  const [filter, setFilter] = useState<'all' | PathSetStatus>('all')
  const [query, setQuery] = useState('')

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = pathSets.filter((p) => {
    if (filter !== 'all' && p.status !== filter) return false
    if (normalizedQuery && !p.name.toLowerCase().includes(normalizedQuery)) return false
    return true
  })

  const total = pathSets.length
  const monitoringCount = pathSets.filter((p) => p.status === 'monitoring').length
  const totalBranches = pathSets.reduce((acc, p) => acc + p.branches.length, 0)

  return (
    <>
      <PageMeta title="経路分析エージェント" eyebrow="行動分析 · Path Analysis" />

      <div className="px-8 pt-4 pb-16">
        {/* header */}
        <div className="mb-3 flex items-center gap-2">
          <p className="text-[12.5px] text-slate-600">
            特定の経路（比較セット）を登録し、各経路の有効性を継続的に調査します。
          </p>
          <div className="ml-auto">
            <Link
              href="/paths/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-110"
            >
              <Plus className="h-3 w-3" /> 新規経路を登録
            </Link>
          </div>
        </div>

        {/* KPI strip */}
        <div className="mb-4 grid grid-cols-3 gap-2.5">
          <KpiCard label="登録経路" value={String(total)} unit="セット" />
          <KpiCard label="監視中" value={String(monitoringCount)} unit={`/ ${total} セット`} />
          <KpiCard label="比較パス総数" value={String(totalBranches)} unit="経路" />
        </div>

        {/* filter */}
        <div className="mb-3.5 flex items-center gap-2.5">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              className="h-9 pl-8 text-sm"
              placeholder="経路名で絞り込み..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="inline-flex rounded-md border border-slate-200 bg-slate-100 p-0.5">
            {(['all', 'monitoring', 'draft', 'paused'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  filter === s
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {s === 'all' ? 'すべて' : STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* table */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-[1fr_96px_80px_80px_96px_36px] gap-2.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
            <div>経路 / 説明</div>
            <div>ステータス</div>
            <div className="text-right">比較パス</div>
            <div className="text-right">ステップ</div>
            <div className="text-right">平均 CV 率</div>
            <div></div>
          </div>

          {filtered.map((p) => {
            const status = STATUS_META[p.status]
            const sum = summarizePathSet(p)
            const sev = SEVERITY_META[sum.worstSeverity]
            return (
              <Link
                key={p.id}
                href={`/paths/${p.id}?site_id=${encodeURIComponent(siteId)}`}
                className="grid grid-cols-[1fr_96px_80px_80px_96px_36px] items-center gap-2.5 border-b border-slate-100 px-4 py-3 transition-colors last:border-b-0 hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${sev.dot}`} aria-hidden />
                    <span className="truncate text-sm font-semibold text-slate-900">{p.name}</span>
                    {p.isDummy ? (
                      <Badge
                        variant="outline"
                        className="border-indigo-300 bg-indigo-50 font-mono text-[9px] uppercase tracking-wider text-indigo-700"
                      >
                        inferred
                      </Badge>
                    ) : !sum.analyzed ? (
                      <Badge
                        variant="outline"
                        className="border-slate-300 bg-slate-50 font-mono text-[9px] uppercase tracking-wider text-slate-500"
                      >
                        未分析
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
                    {p.description || `トリガー: ${p.trigger.url}`}
                  </div>
                </div>
                <div>
                  <Badge
                    variant="outline"
                    className={`${status.className} font-mono text-[10px] uppercase tracking-wider`}
                  >
                    {status.label}
                  </Badge>
                </div>
                <div className="flex items-center justify-end gap-1 font-mono text-sm font-semibold text-slate-700">
                  <GitBranch className="h-3 w-3 text-slate-400" aria-hidden />
                  {sum.branchCount}
                </div>
                <div className="text-right font-mono text-sm font-semibold text-slate-700">
                  {sum.stepCount}
                </div>
                <div className="text-right font-mono text-sm font-semibold text-slate-900">
                  {p.averageCvRate}
                </div>
                <div className="flex justify-end text-slate-300">
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </div>
              </Link>
            )
          })}

          {filtered.length === 0 ? (
            <div className="px-4 py-16 text-center text-sm text-slate-500">
              {total === 0
                ? 'まだ経路が登録されていません。「新規経路を登録」から最初の比較セットを作成してください。'
                : '条件に一致する経路がありません。'}
            </div>
          ) : null}
        </div>

        {/* note */}
        <div className="mt-5 rounded border border-dashed border-slate-300 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">
          <b className="font-semibold text-slate-900">経路 (比較セット) とは</b>: 1
          つのトリガー（例: TOP 訪問）から CV までの複数の到達経路をまとめて監視・比較する単位です。
          登録時は「定義」（経路名・トリガー・各経路のステップ URL）を入力します。 通過率 / 離脱 /
          CV 率 / PageSpeed などの
          <b className="font-semibold text-slate-900">数値は計測データ蓄積後</b>に
          各経路の詳細へ反映されます（それまでは「未分析」表示）。
        </div>
      </div>
    </>
  )
}

interface KpiCardProps {
  label: string
  value: string
  unit?: string
}

function KpiCard({ label, value, unit }: KpiCardProps) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
      <div className="mb-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="font-mono text-xl font-bold leading-none tracking-tight text-slate-900">
        {value}
        {unit ? <span className="ml-1 text-xs font-medium text-slate-500">{unit}</span> : null}
      </div>
    </div>
  )
}
