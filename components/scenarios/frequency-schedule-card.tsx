'use client'

/**
 * FrequencyScheduleCard — frequency cap + schedule の設定 UI (Phase 2.1、2026-06-07)
 *
 * 新規 / 編集どちらでも使えるよう scenario-id を要求しない small card。
 * Owner / Marketer が「同じ user に何回まで表示」「いつからいつまで配信」を直感的に設定する。
 *
 * Reference:
 *   - lib/scenarios/types.ts (FrequencyCapSchema / ScheduleSchema)
 *   - public/scenario-runtime.js (browser 側で respect)
 *   - app/api/scenarios/runtime/route.ts (server-side schedule filter)
 */

import { Calendar, Gauge } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  FREQUENCY_CAP_PERIODS,
  type FrequencyCap,
  type FrequencyCapPeriod,
  type Schedule,
} from '@/lib/scenarios/types'

interface FrequencyScheduleCardProps {
  frequencyCap: FrequencyCap | null | undefined
  schedule: Schedule | null | undefined
  onFrequencyCapChange: (next: FrequencyCap | null) => void
  onScheduleChange: (next: Schedule | null) => void
  disabled?: boolean
}

const PERIOD_LABEL: Record<FrequencyCapPeriod, string> = {
  session: 'セッション内',
  day: '1 日',
  week: '1 週間',
}

export function FrequencyScheduleCard({
  frequencyCap,
  schedule,
  onFrequencyCapChange,
  onScheduleChange,
  disabled = false,
}: FrequencyScheduleCardProps) {
  const capEnabled = !!frequencyCap
  const schedEnabled = !!schedule

  function handleToggleCap(enable: boolean): void {
    if (disabled) return
    if (enable) {
      onFrequencyCapChange({ per_period: 'day', max_impressions: 3 })
    } else {
      onFrequencyCapChange(null)
    }
  }

  function handleToggleSchedule(enable: boolean): void {
    if (disabled) return
    if (enable) {
      onScheduleChange({ start_at: null, end_at: null })
    } else {
      onScheduleChange(null)
    }
  }

  function handleStartAtChange(local: string): void {
    if (disabled || !schedule) return
    const iso = local ? new Date(local).toISOString() : null
    onScheduleChange({ ...schedule, start_at: iso })
  }

  function handleEndAtChange(local: string): void {
    if (disabled || !schedule) return
    const iso = local ? new Date(local).toISOString() : null
    onScheduleChange({ ...schedule, end_at: iso })
  }

  const scheduleError =
    schedule && schedule.start_at && schedule.end_at && schedule.start_at >= schedule.end_at
      ? '開始時刻は終了時刻より前である必要があります'
      : null

  return (
    <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2">
        <Gauge className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-xs font-semibold">表示頻度 / 配信期間</span>
        <Badge variant="outline" className="text-[9.5px] bg-emerald-50 text-emerald-700 border-emerald-200">
          Phase 2.1
        </Badge>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Frequency cap */}
        <div>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={capEnabled}
              onChange={(e) => handleToggleCap(e.target.checked)}
              disabled={disabled}
              className="rounded border-slate-300"
            />
            <span>表示頻度を制限する</span>
          </label>
          {frequencyCap ? (
            <div className="mt-1.5 ml-6 grid grid-cols-[80px_1fr] gap-x-2 gap-y-1.5 items-center">
              <span className="text-[11.5px] text-slate-500">期間</span>
              <select
                value={frequencyCap.per_period}
                onChange={(e) =>
                  onFrequencyCapChange({
                    ...frequencyCap,
                    per_period: e.target.value as FrequencyCapPeriod,
                  })
                }
                disabled={disabled}
                className="h-8 px-2 text-[11.5px] font-mono border border-slate-200 rounded bg-white max-w-[140px]"
              >
                {FREQUENCY_CAP_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABEL[p]}
                  </option>
                ))}
              </select>

              <span className="text-[11.5px] text-slate-500">最大回数</span>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={String(frequencyCap.max_impressions)}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10)
                    if (!Number.isFinite(n)) return
                    onFrequencyCapChange({
                      ...frequencyCap,
                      max_impressions: Math.max(1, Math.min(100, n)),
                    })
                  }}
                  disabled={disabled}
                  className="h-8 w-20 text-[11.5px] text-right font-mono"
                />
                <span className="text-[11px] text-slate-500">回まで</span>
              </div>
            </div>
          ) : (
            <div className="ml-6 mt-0.5 text-[10.5px] text-slate-400">
              制限なし: 1 セッションにつき 1 回 (既存の dedup)。複数回出したい / 1 日 N 回などはチェックを入れる。
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 pt-3" />

        {/* Schedule */}
        <div>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={schedEnabled}
              onChange={(e) => handleToggleSchedule(e.target.checked)}
              disabled={disabled}
              className="rounded border-slate-300"
            />
            <Calendar className="h-3 w-3 text-slate-500" />
            <span>配信期間を指定する</span>
          </label>
          {schedule ? (
            <div className="mt-1.5 ml-6 grid grid-cols-[80px_1fr] gap-x-2 gap-y-1.5 items-center">
              <span className="text-[11.5px] text-slate-500">開始</span>
              <Input
                type="datetime-local"
                value={schedule.start_at ? toLocalDateTime(schedule.start_at) : ''}
                onChange={(e) => handleStartAtChange(e.target.value)}
                disabled={disabled}
                className="h-8 text-[11.5px] max-w-[220px]"
              />
              <span className="text-[11.5px] text-slate-500">終了</span>
              <Input
                type="datetime-local"
                value={schedule.end_at ? toLocalDateTime(schedule.end_at) : ''}
                onChange={(e) => handleEndAtChange(e.target.value)}
                disabled={disabled}
                className="h-8 text-[11.5px] max-w-[220px]"
              />
              {scheduleError ? (
                <span className="col-span-2 text-[10.5px] text-rose-700">{scheduleError}</span>
              ) : (
                <span className="col-span-2 text-[10.5px] text-slate-400">
                  時刻はブラウザのローカルタイムゾーン入力 → 保存時 UTC ISO に変換。
                  サーバ側が期間外の scenario を payload から除外、ブラウザ側で ±5min skew を許容して再チェック。
                </span>
              )}
            </div>
          ) : (
            <div className="ml-6 mt-0.5 text-[10.5px] text-slate-400">
              未指定: 即時開始・終了なし。Owner が status=live にした瞬間から配信開始。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function toLocalDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${y}-${m}-${day}T${hh}:${mm}`
  } catch {
    return ''
  }
}
