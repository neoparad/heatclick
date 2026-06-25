/**
 * CV経路分析 — ダミーデータ（ClickHouse 未接続 / 失敗時のフォールバック）
 *
 * heatmap (data_source: 'dummy_lcg') と同思想。UI バナーで「ダミー」を明示する。
 * 数値はモック 04_cv_journey.html に準拠（landing→product→cart→purchase）。
 */

import { DEFAULT_FUNNEL, type FunnelConfig } from './funnel-config'
import { assembleFunnel, stepsFromReached } from './query'
import type { CvJourneyData, CvSource } from '@/lib/api/cv-journey'

const DUMMY_REACHED = [19_766, 12_685, 1_648, 428]

const DUMMY_SOURCES: CvSource[] = [
  { key: 'google / organic', label: 'google / organic', sessions: 6_820 },
  { key: 'x.com / referral', label: 'x.com / referral', sessions: 4_210 },
  { key: 'direct / none', label: 'direct / none', sessions: 3_140 },
  { key: 'google / cpc', label: 'google / cpc', sessions: 2_890 },
  { key: 'instagram / social', label: 'instagram / social', sessions: 1_446 },
  { key: 'other / referral', label: 'other / referral', sessions: 1_260 },
]

const DUMMY_FRICTIONS = [
  null,
  { rageClicks: 38, deadClicks: 12 },
  { rageClicks: 127, deadClicks: 64 }, // カート追加: モックの rage_click 集中
  null,
]

export function buildDummyData(config: FunnelConfig = DEFAULT_FUNNEL): CvJourneyData {
  const reached = DUMMY_REACHED.slice(0, config.steps.length)
  const frictions = DUMMY_FRICTIONS.slice(0, config.steps.length)
  const steps = stepsFromReached(config, reached, frictions)
  return assembleFunnel(steps, DUMMY_SOURCES, {
    totalSessions: 19_766,
    cvSessions: reached[reached.length - 1] ?? 428,
  })
}
