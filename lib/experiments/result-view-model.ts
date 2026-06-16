/**
 * 宝プロジェクト — 顧客向け実験結果 view model (M4b, pure)
 *
 * requirement D「観測語彙のみ・嘘の有意性を出さない」を **サーバー側で強制** する層。
 * UI の規律に依存せず、API 応答の時点で出してよい数値だけを含める。
 *
 * ルール:
 *   - sessions_n は常に返す (データ蓄積の進捗表示。これは件数であり効果の主張ではない)。
 *   - conversions / cvr (観測値) は **自サイトの min arm が閾値 (2000) 以上のときのみ** 返す。
 *     不足時は null — 「未確定 (全社プールで判定中)」で数値比較を見せない (ノイズ比較の誘導防止)。
 *   - effect (logRR / SE) は **顧客応答に決して含めない** (推論量。M5 pool への内部入力のみ)。
 *   - pool verdict (効く傾向) は power-gate (K≥24) + 開示ゲート (meets_k50、pool-cells.ts) を
 *     通過したものだけが verdict.pool として載る。
 */

import type { ArmStatsResult } from './arm-stats'
import type { PowerGateVerdict } from './power-gate'
import type { Experiment } from './types'

export interface ArmView {
  sessions_n: number
  /** 観測値。表示許可がない場合は null (サーバー側 redaction)。 */
  conversions: number | null
  cvr: number | null
}

export interface ExperimentResultView {
  experiment: {
    id: string
    name: string
    status: Experiment['status']
    url_pattern: string
    taxonomy: Experiment['taxonomy']
    dates: Experiment['dates']
  }
  verdict: PowerGateVerdict
  arms: {
    control: ArmView
    treatment: ArmView
  }
  total_sessions: number
  /** 観測値 (conversions/cvr) を表示してよいか。UI はこれに従う (再計算しない)。 */
  observed_numbers_visible: boolean
  data_unavailable: boolean
  /** 顧客向けの安定コードのみ (内部 reason は API がサーバーログに残す。Codex M4b MEDIUM)。 */
  data_unavailable_reason?: 'measurement_data_unavailable'
}

function toArmView(
  arm: { sessions_n: number; conversions: number; cvr: number },
  visible: boolean,
): ArmView {
  return {
    sessions_n: arm.sessions_n,
    conversions: visible ? arm.conversions : null,
    cvr: visible ? arm.cvr : null,
  }
}

/**
 * 観測値の表示可否: 自サイトの min arm が閾値以上 (= power-gate の単一サイト充足基準)。
 * verdict.state ではなく min/threshold で判定する — pool_supported (inferred) でも自サイトの
 * データが充足していれば「観測値 (参考)」は描写として出してよい (D-07 が禁じるのは
 * inferred/planned の **断定的投影数値** であり、実測の描写ではない)。
 */
export function observedNumbersVisible(verdict: PowerGateVerdict): boolean {
  return verdict.min_arm_sessions >= verdict.threshold
}

export function buildExperimentResultView(
  experiment: Experiment,
  stats: ArmStatsResult,
  verdict: PowerGateVerdict,
): ExperimentResultView {
  const visible = observedNumbersVisible(verdict) && !stats.data_unavailable
  return {
    experiment: {
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      url_pattern: experiment.url_pattern,
      taxonomy: experiment.taxonomy,
      dates: experiment.dates,
    },
    verdict,
    arms: {
      control: toArmView(stats.control, visible),
      treatment: toArmView(stats.treatment, visible),
    },
    total_sessions: stats.total_sessions,
    observed_numbers_visible: visible,
    data_unavailable: stats.data_unavailable,
    // 内部 reason ('migration 未適用' 等の運用詳細) は顧客に出さず安定コードに正規化
    // (詳細は route がサーバーログへ。Codex M4b MEDIUM)。
    ...(stats.data_unavailable ? { data_unavailable_reason: 'measurement_data_unavailable' as const } : {}),
    // 注: stats.effect (logRR/SE) は意図的に展開しない (顧客応答に含めない)。
  }
}
