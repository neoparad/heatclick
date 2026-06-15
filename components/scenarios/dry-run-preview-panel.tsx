'use client'

/**
 * DryRunPreviewPanel — 条件 AST の過去 events 再生プレビュー (M-Director Phase 2、2026-06-07)
 *
 * scenario-new-view から呼ばれ、条件 AST が直近 N 日でどれだけ session にマッチしたかを表示する。
 * Evidence Level バッジ必須 (D-07): 過去スナップショットなので 'inferred'。
 */

import { useState } from 'react'
import { AlertTriangle, BarChart3, Loader2, Play } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ConditionNode } from '@/lib/scenarios/types'

interface DryRunPreviewPanelProps {
  conditionAst: ConditionNode
  siteId: string
  /** 直近何日のデータを集計するか (1-30、default 7) */
  defaultDays?: number
  /** AST に schema error がある場合、preview ボタンを disable */
  hasValidationErrors?: boolean
}

interface ApiSuccess {
  success: true
  data: {
    period: { startDate: string; endDate: string; days: number }
    totalSessions: number
    matchedSessions: number
    matchRate: number
    daily: Array<{ date: string; sessions: number; matched: number; matchRate: number }>
    sampleMatches: Array<{
      sessionId: string
      deviceType: string
      utmSource: string
      utmMedium: string
      sessionDurationSec: number
      pageViewsInSession: number
      urlPath: string
      isFirstVisit: boolean
    }>
    unsupportedFields: string[]
    evidenceLevel: 'inferred'
    queryMs: number
  }
}

interface ApiError {
  success: false
  error: { code: string; message: string }
}

const DAYS_OPTIONS = [3, 7, 14, 30] as const

export function DryRunPreviewPanel({
  conditionAst,
  siteId,
  defaultDays = 7,
  hasValidationErrors = false,
}: DryRunPreviewPanelProps) {
  const [days, setDays] = useState<number>(defaultDays)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ApiSuccess['data'] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRun(): Promise<void> {
    if (loading || hasValidationErrors) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/scenarios/dry-run-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: siteId, condition_ast: conditionAst, days }),
      })
      const json = (await res.json()) as ApiSuccess | ApiError
      if (!res.ok || !json.success) {
        setError(!json.success ? json.error.message : `HTTP ${res.status}`)
        return
      }
      setResult(json.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '通信エラー')
    } finally {
      setLoading(false)
    }
  }

  const matchRatePct = result ? Math.round(result.matchRate * 1000) / 10 : 0

  return (
    <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2">
        <BarChart3 className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-xs font-semibold">過去データでプレビュー</span>
        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[9.5px]">
          Evidence: inferred
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="inline-flex bg-slate-50 border border-slate-200 rounded p-0.5">
            {DAYS_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                disabled={loading}
                className={`px-2 py-0.5 text-[10.5px] font-mono rounded transition-colors ${
                  days === d
                    ? 'bg-indigo-500 text-white'
                    : 'text-slate-500 hover:text-slate-700'
                } disabled:opacity-50`}
                aria-pressed={days === d}
              >
                {d}d
              </button>
            ))}
          </div>
          <Button
            size="sm"
            disabled={loading || hasValidationErrors}
            onClick={handleRun}
            title={hasValidationErrors ? 'AST に検証エラーがあります' : `過去 ${days} 日の events で再生`}
          >
            {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            {loading ? '集計中...' : 'プレビュー実行'}
          </Button>
        </div>
      </div>

      <div className="p-3 space-y-2">
        {error ? (
          <div className="flex items-start gap-1.5 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!result && !error && !loading ? (
          <div className="text-[11px] text-slate-500 leading-relaxed">
            「プレビュー実行」を押すと、ClickHouse の events table から直近の session を取り出し、
            この条件式が何 session に当たったかを過去スナップショットで計算します。
            未来の挙動を保証するものではなく、Evidence Level は常に「inferred (推定)」です。
          </div>
        ) : null}

        {result ? (
          <>
            {/* メイン KPI 行 */}
            <div className="grid grid-cols-3 gap-2">
              <KpiCard label="期間内 session" value={result.totalSessions.toLocaleString()} sub={`${result.period.startDate} 〜 ${result.period.endDate}`} />
              <KpiCard label="マッチ session" value={result.matchedSessions.toLocaleString()} sub={`${matchRatePct}% match`} highlight />
              <KpiCard label="クエリ時間" value={`${result.queryMs} ms`} sub={`${result.period.days} days`} />
            </div>

            {/* unsupported_fields warning */}
            {result.unsupportedFields.length > 0 ? (
              <div className="text-[10.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                <span className="font-semibold">⚠ プレビュー対象外フィールド: </span>
                <code className="font-mono">{result.unsupportedFields.join(', ')}</code>
                <div className="text-amber-700 mt-0.5">
                  これらは events table に列が無いため本プレビューでは 0 / 空文字として扱われ、過小マッチします。
                  実 traffic では正しい値で評価されます。
                </div>
              </div>
            ) : null}

            {/* 日次 */}
            {result.daily.length > 0 ? (
              <div>
                <div className="text-[10.5px] text-slate-500 font-mono uppercase tracking-wider font-semibold mb-1">
                  日次推移
                </div>
                <div className="space-y-0.5">
                  {result.daily.slice(-7).map((d) => {
                    const pct = d.sessions > 0 ? Math.round(d.matchRate * 100) : 0
                    return (
                      <div key={d.date} className="grid grid-cols-[80px_1fr_60px_50px] gap-2 text-[11px] items-center">
                        <span className="font-mono text-slate-500">{d.date}</span>
                        <div className="bg-slate-100 rounded-sm overflow-hidden h-2 relative">
                          <div
                            className="bg-indigo-400 h-full"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="text-slate-600 text-right tabular-nums">
                          {d.matched}/{d.sessions}
                        </span>
                        <span className="text-slate-700 font-medium text-right">{pct}%</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {/* sample matches */}
            {result.sampleMatches.length > 0 ? (
              <div>
                <div className="text-[10.5px] text-slate-500 font-mono uppercase tracking-wider font-semibold mb-1">
                  マッチ例 ({result.sampleMatches.length} 件)
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded p-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                  {result.sampleMatches.map((s, i) => (
                    <div key={s.sessionId + i} className="text-[10.5px] text-slate-600 font-mono leading-tight">
                      [{s.deviceType}] {s.utmSource || '-'}/{s.utmMedium || '-'} ·
                      {' '}{s.sessionDurationSec}s · {s.pageViewsInSession}pv · {s.isFirstVisit ? '初回' : 'リピート'}
                      {' · '}<span className="text-slate-500">{s.urlPath || '(no path)'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 italic">
                サンプル対象 session が 0 件でした。条件を緩めるか、期間を延ばしてみてください。
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

interface KpiCardProps {
  label: string
  value: string
  sub: string
  highlight?: boolean
}

function KpiCard({ label, value, sub, highlight = false }: KpiCardProps) {
  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 ${
        highlight ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider font-mono text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${highlight ? 'text-indigo-700' : 'text-slate-800'}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-500">{sub}</div>
    </div>
  )
}
