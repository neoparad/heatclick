/**
 * HeatmapBackfillRunner — 既存 `/api/heatmap/screenshot` をブラウザから順次呼ぶだけの
 * バックフィル実行 UI。オペレータの既存ログイン Cookie をそのまま使う (新規認証なし)。
 *
 * tier は response body に含まれないため、Server-Timing レスポンスヘッダ
 * (lib/perf/server-timing.ts が付与) から `tier;desc="..."` を読み取って表示する。
 */

'use client'

import { useCallback, useRef, useState } from 'react'

import type { PageOption } from '@/lib/pages/fetch-pages'

interface HeatmapBackfillRunnerProps {
  siteId: string
  pages: PageOption[]
}

type Device = 'pc' | 'sp' | 'tab'
const DEVICES: readonly Device[] = ['pc', 'sp', 'tab']

/** Paid プランの同時ブラウザ込み枠 (10本) に収まる範囲の並列度。 */
const CONCURRENCY = 4

interface Task {
  url: string
  device: Device
}

interface RunState {
  total: number
  done: number
  tierCounts: Record<string, number>
  recentLog: string[]
  running: boolean
}

function parseTierFromServerTiming(header: string | null): string {
  if (!header) return 'unknown'
  const m = header.match(/tier;desc="([^"]*)"/)
  return m?.[1] ?? 'unknown'
}

function initialState(total: number): RunState {
  return { total, done: 0, tierCounts: {}, recentLog: [], running: false }
}

export function HeatmapBackfillRunner({ siteId, pages }: HeatmapBackfillRunnerProps) {
  const tasks = pages.flatMap((p) => DEVICES.map((device) => ({ url: p.url, device })))
  const [state, setState] = useState<RunState>(() => initialState(tasks.length))
  const stopRef = useRef(false)

  const runTask = useCallback(
    async (task: Task): Promise<void> => {
      const qs = new URLSearchParams({
        site_id: siteId,
        page_url: task.url,
        device: task.device,
      })
      let tier = 'error'
      let logLine: string
      try {
        const res = await fetch(`/api/heatmap/screenshot?${qs.toString()}`, {
          method: 'GET',
          credentials: 'same-origin',
        })
        tier = res.ok ? parseTierFromServerTiming(res.headers.get('Server-Timing')) : `error(${res.status})`
        logLine = `${tier.padEnd(12)} ${task.device} ${task.url}`
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown'
        tier = 'error'
        logLine = `error        ${task.device} ${task.url} — ${msg}`
      }
      setState((prev) => ({
        ...prev,
        done: prev.done + 1,
        tierCounts: { ...prev.tierCounts, [tier]: (prev.tierCounts[tier] ?? 0) + 1 },
        recentLog: [logLine, ...prev.recentLog].slice(0, 30),
      }))
    },
    [siteId],
  )

  const start = useCallback(async () => {
    stopRef.current = false
    setState(initialState(tasks.length))
    setState((prev) => ({ ...prev, running: true }))

    let cursor = 0
    async function worker(): Promise<void> {
      while (!stopRef.current) {
        const idx = cursor
        cursor += 1
        if (idx >= tasks.length) return
        await runTask(tasks[idx])
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    setState((prev) => ({ ...prev, running: false }))
  }, [tasks, runTask])

  const stop = useCallback(() => {
    stopRef.current = true
    setState((prev) => ({ ...prev, running: false }))
  }, [])

  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void start()}
          disabled={state.running || tasks.length === 0}
          className="rounded-md bg-[color:var(--ug-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {state.running ? '実行中…' : `開始 (${tasks.length} 件)`}
        </button>
        {state.running && (
          <button
            type="button"
            onClick={stop}
            className="rounded-md border border-[color:var(--ug-border)] px-4 py-2 text-sm"
          >
            停止 (実行中のリクエストは完了させる)
          </button>
        )}
      </div>

      <div className="space-y-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--ug-panel)]">
          <div
            className="h-full bg-[color:var(--ug-accent)] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-sm text-[color:var(--ug-text-2)]">
          {state.done} / {state.total} ({pct}%)
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        {Object.entries(state.tierCounts).map(([tier, count]) => (
          <span
            key={tier}
            className="rounded-md border border-[color:var(--ug-border)] px-2 py-1"
          >
            {tier}: {count}
          </span>
        ))}
      </div>

      <div className="max-h-96 overflow-y-auto rounded-md border border-[color:var(--ug-border)] bg-[color:var(--ug-panel)] p-3 font-mono text-xs">
        {state.recentLog.length === 0 ? (
          <div className="text-[color:var(--ug-text-2)]">(未実行)</div>
        ) : (
          state.recentLog.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  )
}
