/**
 * 宝プロジェクト — 実験割付の解決 (M2b, pure / route から分離してテスト可能化)
 *
 * running かつ計測 window 内の実験に対し、visitor の **server-arm** を解決する。
 * route handler は薄いグルー (query parse → repo.list → 本関数 → response) に保つ。
 */

import { computeArm, type Arm } from './assignment'
import type { InterventionType } from './taxonomy'
import type { Experiment, RenderConfig } from './types'

export interface Assignment {
  experiment_id: string
  arm: Arm
  url_pattern: string
  /**
   * M6: treatment のみに付与されるレンダリング指示 (control には付けない = 露出最小化)。
   * render_config 未設定の実験では treatment でも省略 (A/A 計測のみ)。
   */
  render?: {
    intervention_type: InterventionType
    config: RenderConfig
  }
}

/** 実験が計測 window 内か (start <= now < end、null 端は無制限)。 */
export function isWithinWindow(exp: Pick<Experiment, 'dates'>, nowMs: number): boolean {
  const { start_at, end_at } = exp.dates
  if (start_at) {
    const s = Date.parse(start_at)
    if (Number.isFinite(s) && nowMs < s) return false
  }
  if (end_at) {
    const e = Date.parse(end_at)
    if (Number.isFinite(e) && nowMs >= e) return false
  }
  return true
}

/**
 * running かつ window 内の実験について server-arm を解決する。
 * draft / stopped / archived や window 外は **割付しない** (新規 visitor を入れない)。
 */
export function resolveActiveAssignments(
  experiments: ReadonlyArray<Experiment>,
  visitorId: string,
  nowMs: number,
  salt: string,
): Assignment[] {
  return experiments
    .filter(
      // running でも start_at/end_at が null の行は fail-closed で除外 (Codex M2b: 有界 window 必須)。
      (e) =>
        e.status === 'running' &&
        e.dates.start_at !== null &&
        e.dates.end_at !== null &&
        isWithinWindow(e, nowMs),
    )
    .map((e) => {
      const arm = computeArm({ experimentId: e.id, visitorId, salt, saltVersion: e.salt_version })
      const assignment: Assignment = {
        experiment_id: e.id,
        arm,
        url_pattern: e.url_pattern,
      }
      if (arm === 'treatment' && e.render_config) {
        assignment.render = {
          intervention_type: e.taxonomy.intervention_type,
          config: e.render_config,
        }
      }
      return assignment
    })
}
