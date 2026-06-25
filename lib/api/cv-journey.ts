/**
 * CV経路分析 API クライアント（型 + fetch）
 *
 * 親 SSOT §3.6.5 / docs/cv-journey-implementation-plan.md
 * envelope は heatmap (lib/api/heatmap.ts) と同形: success / error union。
 */

import type { EvidenceLevelV2 } from '@/types/evidence'

export type CvNodeKind = 'source' | 'page' | 'action' | 'conversion' | 'dropoff'

/** 流入メディア(step0) の 1 ノード */
export interface CvSource {
  key: string
  label: string
  sessions: number
}

/** ステップ間/ステップの摩擦シグナル（observed） */
export interface CvFriction {
  rageClicks: number
  deadClicks: number
  /** handoff 用: このステップ代表 path（PII マスク済み） */
  path: string
}

/** 固定列ファネルの 1 ステップ */
export interface CvStep {
  index: number
  label: string
  kind: CvNodeKind
  /** このステップに到達したセッション数 */
  reached: number
  /** 次ステップへ進んだ数 */
  advanced: number
  /** ここで離脱した数 */
  dropped: number
  /** 進行率 0-1（advanced / reached） */
  advanceRate: number
  /** 離脱率 0-1（dropped / reached） */
  dropRate: number
  evidenceLevel: EvidenceLevelV2
  /** observed 摩擦（heatmap handoff の根拠） */
  friction?: CvFriction
}

export interface CvNode {
  id: string
  label: string
  stepIndex: number
  kind: CvNodeKind
  sessions: number
  evidenceLevel: EvidenceLevelV2
}

export interface CvLink {
  source: string
  target: string
  sessions: number
  /** source.sessions に対する比率 0-1 */
  rate: number
  kind: 'advance' | 'dropoff'
}

export type CvrDenominator = 'all_sessions' | 'entry_sessions'

export interface CvTotals {
  totalSessions: number
  cvSessions: number
  cvrPct: number
  cvrDenominator: CvrDenominator
  biggestBottleneck: { stepIndex: number; label: string; dropRate: number } | null
}

export interface CvJourneyMeta {
  /** heatmap と同じく実データ / ダミー切替を UI バナーで示す */
  dataSource: 'clickhouse_events' | 'dummy'
  windowSec: number
  periodDays: number
  /** funnel-config の未対応ステップ等の警告 */
  warnings: string[]
}

export interface CvJourneyData {
  steps: CvStep[]
  sources: CvSource[]
  nodes: CvNode[]
  links: CvLink[]
  totals: CvTotals
}

export interface CvJourneySuccess {
  success: true
  data: CvJourneyData
  meta: CvJourneyMeta
}

export interface CvJourneyError {
  success: false
  error: {
    code: 'TENANT_FORBIDDEN' | 'BAD_REQUEST' | 'INTERNAL' | 'UNAUTHORIZED'
    message: string
  }
}

export type CvJourneyResponse = CvJourneySuccess | CvJourneyError

export interface CvJourneyQuery {
  site_id: string
  start_date?: string // YYYY-MM-DD
  end_date?: string
  device_type?: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  /** 流入メディア絞り込み（source.key） */
  source?: string
}

export async function fetchCvJourney(
  query: CvJourneyQuery,
  signal?: AbortSignal,
): Promise<CvJourneyResponse> {
  const params = new URLSearchParams()
  params.set('site_id', query.site_id)
  if (query.start_date) params.set('start_date', query.start_date)
  if (query.end_date) params.set('end_date', query.end_date)
  if (query.device_type) params.set('device_type', query.device_type)
  if (query.source && query.source !== 'all') params.set('source', query.source)

  const res = await fetch(`/api/cv-journey?${params.toString()}`, {
    method: 'GET',
    credentials: 'include',
    signal,
  })

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    if (typeof body === 'object' && body !== null && 'error' in body) {
      return body as CvJourneyError
    }
    return {
      success: false,
      error: {
        code: res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
        message: `HTTP ${res.status}`,
      },
    }
  }

  return (await res.json()) as CvJourneyResponse
}
