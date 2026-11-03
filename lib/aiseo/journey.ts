/**
 * エージェント・ジャーニー復元（純粋ロジック・UI非依存）。
 * collector /v0/analytics/events（seq順・時刻つき）を、エージェント単位＋時間ギャップでセッション化する。
 */

import type { ObsEvent } from './risk'

const DEFAULT_GAP_MS = 30 * 60 * 1000 // 30分

export function eventTs(e: ObsEvent): number {
  return e.origin_ts != null ? Number(e.origin_ts) : Number(e.ingest_ts) || 0
}

export function pathOf(url: string | undefined): string {
  try {
    return new URL(url || '').pathname || '/'
  } catch {
    return String(url || '/')
  }
}

export interface AgentJourneySession {
  id: number
  startTs: number
  endTs: number
  durationMs: number
  pages: number
  uniquePages: number
  entry: string
  exit: string
  steps: ObsEvent[]
}

export function buildJourneys(
  events: ReadonlyArray<ObsEvent> = [],
  agent: string,
  gapMs = DEFAULT_GAP_MS,
): AgentJourneySession[] {
  const seq = events
    .filter((e) => e.agent === agent)
    .slice()
    .sort((a, b) => eventTs(a) - eventTs(b) || (Number(a.seq) || 0) - (Number(b.seq) || 0))

  const sessions: Array<{ steps: ObsEvent[]; startTs: number; lastTs: number }> = []
  let cur: { steps: ObsEvent[]; startTs: number; lastTs: number } | null = null
  for (const e of seq) {
    const ts = eventTs(e)
    if (!cur || ts - cur.lastTs > gapMs) {
      cur = { steps: [], startTs: ts, lastTs: ts }
      sessions.push(cur)
    }
    cur.steps.push(e)
    cur.lastTs = ts
  }

  return sessions.map((s, i) => ({
    id: i + 1,
    startTs: s.startTs,
    endTs: s.lastTs,
    durationMs: Math.max(0, s.lastTs - s.startTs),
    pages: s.steps.length,
    uniquePages: new Set(s.steps.map((x) => x.url || '')).size,
    entry: s.steps[0]?.url || '',
    exit: s.steps[s.steps.length - 1]?.url || '',
    steps: s.steps,
  }))
}

export interface JourneySummary {
  sessionCount: number
  totalPages: number
  uniquePages: number
  firstTs: number
  lastTs: number
}

export function summarizeJourneys(
  sessions: ReadonlyArray<AgentJourneySession> = [],
): JourneySummary {
  const pages = sessions.reduce((s, j) => s + j.pages, 0)
  const uniq = new Set<string>()
  sessions.forEach((j) => j.steps.forEach((st) => st.url && uniq.add(st.url)))
  const starts = sessions.map((j) => j.startTs).filter(Boolean)
  return {
    sessionCount: sessions.length,
    totalPages: pages,
    uniquePages: uniq.size,
    firstTs: starts.length ? Math.min(...starts) : 0,
    lastTs: sessions.length ? Math.max(...sessions.map((j) => j.endTs)) : 0,
  }
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms < 1000) return '0秒'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}分${rs}秒` : `${m}分`
  const h = Math.floor(m / 60)
  return `${h}時間${m % 60}分`
}
