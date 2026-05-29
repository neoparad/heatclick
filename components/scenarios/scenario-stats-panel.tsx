'use client'

/**
 * ScenarioStatsPanel — impression / click / CVR ダッシュボード (Stage 7、続 M-12、2026-05-28)
 *
 * Features:
 *   - 24h / 7d / 30d toggle
 *   - KPI cards: match / impression / click / conversion / CTR / CVR
 *   - 時系列 area chart (recharts、stacked impression + click)
 *   - scenario_match table 未作成時は "データ蓄積待ち" 表示
 *
 * Reference:
 *   - app/api/scenarios/[id]/stats/route.ts (GET endpoint)
 *   - data-model.md §3 (scenario_match schema)
 */

import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type RangePreset = '24h' | '7d' | '30d'

interface StatsResponse {
  scenario_id: string
  tenant_id: string
  range_from: string
  range_to: string
  bucket: 'hour' | 'day'
  totals: {
    match_count: number
    impression_count: number
    click_count: number
    conversion_count: number
    dismiss_count: number
    click_through_rate: number
    conversion_rate: number
  }
  series: Array<{
    ts: string
    match_count: number
    impression_count: number
    click_count: number
    conversion_count: number
  }>
  data_unavailable: boolean
  data_unavailable_reason?: string
}

export interface ScenarioStatsPanelProps {
  scenarioId: string
  tenantId: string
  siteId: string
}

export function ScenarioStatsPanel({ scenarioId, tenantId, siteId }: ScenarioStatsPanelProps) {
  const [range, setRange] = useState<RangePreset>('24h')
  const [data, setData] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const url =
      `/api/scenarios/${encodeURIComponent(scenarioId)}/stats` +
      `?tenant_id=${encodeURIComponent(tenantId)}` +
      `&site_id=${encodeURIComponent(siteId)}` +
      `&range=${range}`
    fetch(url, { cache: 'no-store' })
      .then(async (resp) => {
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({ error: 'unknown' }))
          throw new Error(body.error ?? `HTTP ${resp.status}`)
        }
        const body = (await resp.json()) as StatsResponse
        if (!cancelled) setData(body)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scenarioId, tenantId, siteId, range])

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
      {/* Range toggle */}
      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
          範囲
        </span>
        <div className="inline-flex bg-slate-50 border border-slate-200 rounded p-0.5">
          {(['24h', '7d', '30d'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2.5 py-0.5 font-mono text-[10.5px] font-bold rounded transition-colors ${
                range === r
                  ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
              aria-pressed={range === r}
            >
              {r}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10.5px] text-slate-400 font-mono">
          bucket: {data?.bucket ?? '—'}
        </span>
      </div>

      {/* States */}
      {loading ? (
        <div className="h-32 flex items-center justify-center text-xs text-slate-400">
          読み込み中...
        </div>
      ) : error ? (
        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-[12px] text-red-700">
          stats 取得失敗: {error}
        </div>
      ) : !data ? null : data.data_unavailable ? (
        <div className="px-3 py-3 bg-amber-50 border border-amber-200 rounded text-[12.5px] text-amber-800">
          <div className="font-semibold mb-0.5">📊 データ蓄積待ち</div>
          <div className="text-[11.5px] leading-relaxed">
            scenario_match テーブルが ClickHouse 側でまだ未作成、または scenario に対する match event がまだ発生していません。
            tracking.js が match を送信し始めれば自動で表示されます。
          </div>
          {data.data_unavailable_reason ? (
            <div className="mt-1 text-[10.5px] font-mono text-amber-600">
              詳細: {data.data_unavailable_reason}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-6 gap-2 mb-4">
            <KpiCard label="match" value={data.totals.match_count} />
            <KpiCard label="impression" value={data.totals.impression_count} valueClassName="text-indigo-600" />
            <KpiCard label="click" value={data.totals.click_count} valueClassName="text-purple-600" />
            <KpiCard label="conversion" value={data.totals.conversion_count} valueClassName="text-emerald-600" />
            <KpiCard
              label="CTR"
              value={`${(data.totals.click_through_rate * 100).toFixed(1)}%`}
              valueClassName="text-purple-700"
            />
            <KpiCard
              label="CVR"
              value={`${(data.totals.conversion_rate * 100).toFixed(2)}%`}
              valueClassName="text-emerald-700"
            />
          </div>

          {/* Time-series chart */}
          {data.series.length > 0 ? (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.series.map((s) => ({ ...s, label: formatTs(s.ts, data.bucket) }))}>
                  <defs>
                    <linearGradient id="impressionFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="clickFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a855f7" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#a855f7" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 6, borderColor: '#e2e8f0' }}
                    labelStyle={{ fontWeight: 600 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="impression_count"
                    stroke="#6366f1"
                    strokeWidth={1.5}
                    fillOpacity={1}
                    fill="url(#impressionFill)"
                    name="impression"
                  />
                  <Area
                    type="monotone"
                    dataKey="click_count"
                    stroke="#a855f7"
                    strokeWidth={1.5}
                    fillOpacity={1}
                    fill="url(#clickFill)"
                    name="click"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-24 flex items-center justify-center text-xs text-slate-400">
              この範囲ではまだイベントがありません
            </div>
          )}
        </>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  valueClassName = '',
}: {
  label: string
  value: number | string
  valueClassName?: string
}) {
  const displayValue = typeof value === 'number' ? value.toLocaleString() : value
  return (
    <div>
      <div className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">{label}</div>
      <div className={`font-mono text-base font-bold mt-0.5 ${valueClassName}`}>{displayValue}</div>
    </div>
  )
}

function formatTs(ts: string, bucket: 'hour' | 'day'): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  if (bucket === 'hour') {
    return `${d.getUTCHours().toString().padStart(2, '0')}:00`
  }
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}
