/**
 * 宝プロジェクト — 検出力ゲート (M4, requirement D, 顧客 view の判定核)
 *
 * Reference:
 *   - handoff §作る5コンポーネント #5 (検出力ゲート) / decisions.md D-07 (Evidence Level)
 *   - CLAUDE.md §Evidence Level (proven|observed|inferred|planned)
 *   - .claude/plans/sim_pooling_power.py (単一サイトは常に過少検出力 → プール前提)
 *
 * 鉄則:
 *   - 単一サイトで有意性/因果を断定しない。「嘘の有意性」を出さない。
 *   - 確定判定は **全社横断プール** (K≥24 + CI下限>0 / CI上限<0)。それ未満は「未確定（全社プールで判定中）」。
 *   - inferred/planned では「推定 X CV/月」等の断定数値を UI に出さない (D-07)。
 */

import type { ArmStatsResult } from './arm-stats'

// CLAUDE.md §Evidence Level / lib/scenarios/types.ts EVIDENCE_LEVELS と同一の 4 値。
export const EVIDENCE_LEVELS = ['proven', 'observed', 'inferred', 'planned'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

// 単一サイトで観測値を出してよい最低 arm session 数 (sim: それ未満はノイズ → 未確定)。
export const SINGLE_SITE_MIN_ARM_SESSIONS = 2000
// 横断プールで傾向を出してよい最低サイト数 K。
export const POOL_MIN_K = 24

export type PowerGateState = 'insufficient' | 'observed_single_site' | 'pool_supported'
export type EffectDirection = 'positive' | 'negative' | 'none'

/** M5 が experiment_pool_cells から供給するセル要約 (M4 入力)。 */
export interface PoolCellSummary {
  k_sites: number
  ci_low: number
  ci_high: number
  meets_k50: boolean
}

export interface PowerGateInput {
  control_sessions: number
  treatment_sessions: number
  pool: PoolCellSummary | null
}

export interface PowerGateVerdict {
  state: PowerGateState
  evidence_level: EvidenceLevel
  /** プール支持時の効果方向 (positive=効く傾向 / negative=逆効果傾向 / none=方向なし)。 */
  direction: EffectDirection
  headline: string
  note: string
  min_arm_sessions: number
  threshold: number
  pool: PoolCellSummary | null
}

/** その主体自身の **観測値** (サイトの実測 CVR 等) を表示してよいか。observed / proven。 */
export function allowsObservedNumbers(evidence: EvidenceLevel): boolean {
  return evidence === 'observed' || evidence === 'proven'
}

/** 「推定 X CV/月」等の **断定的な投影数値** を表示してよいか (D-07: observed/inferred/planned は不可)。 */
export function allowsProjectedNumbers(evidence: EvidenceLevel): boolean {
  return evidence === 'proven'
}

// session 異常値 (NaN / 負) は 0 として扱う → minArm=0 で「未確定」に倒す (fail-closed)。
function safeSessions(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// 不正な pool 区間 (反転 / NaN / Infinity / 非整数 k) は verdict に使わない (Codex HIGH: fail-closed)。
function isValidPool(p: PoolCellSummary): boolean {
  return (
    Number.isInteger(p.k_sites) &&
    p.k_sites >= 0 &&
    Number.isFinite(p.ci_low) &&
    Number.isFinite(p.ci_high) &&
    p.ci_low <= p.ci_high
  )
}

export function evaluatePowerGate(input: PowerGateInput): PowerGateVerdict {
  // malformed は fail-closed: session→0 (= 未確定)、不正 pool → 無視 (verdict を出さない)。
  const minArm = Math.min(safeSessions(input.control_sessions), safeSessions(input.treatment_sessions))
  const pool = input.pool && isValidPool(input.pool) ? input.pool : null
  const base = { min_arm_sessions: minArm, threshold: SINGLE_SITE_MIN_ARM_SESSIONS, pool }

  // 1) 横断プールが結論を支持 (K>=24)。単一サイトの session 数に依らず最強。
  if (pool && pool.k_sites >= POOL_MIN_K) {
    if (pool.ci_low > 0) {
      return {
        ...base,
        state: 'pool_supported',
        evidence_level: 'inferred',
        direction: 'positive',
        headline: '効く傾向（全社プールで CI 下限 > 0）',
        note: `同じ施策を試した ${pool.k_sites} サイトの横断プールで改善傾向。単一サイトの断定ではありません。`,
      }
    }
    if (pool.ci_high < 0) {
      return {
        ...base,
        state: 'pool_supported',
        evidence_level: 'inferred',
        direction: 'negative',
        headline: '逆効果の傾向（全社プールで CI 上限 < 0）',
        note: `同じ施策を試した ${pool.k_sites} サイトの横断プールで悪化傾向。避けるべき可能性があります。`,
      }
    }
    // K>=24 でも CI が 0 をまたぐ → プールでも結論が出ない。単一サイトの段階表示にフォールバック。
  }

  // 2) 単一サイトの session 不足 → 未確定（全社プールで判定中）
  if (minArm < SINGLE_SITE_MIN_ARM_SESSIONS) {
    return {
      ...base,
      state: 'insufficient',
      evidence_level: 'planned',
      direction: 'none',
      headline: '未確定（全社プールで判定中）',
      note: `データ蓄積中（各 arm ${SINGLE_SITE_MIN_ARM_SESSIONS} session 未満）。単一サイトでは有意性を判定せず、全社の横断プールで判定します。`,
    }
  }

  // 3) 単一サイトの観測値はあるが確定判定はしない (観測語彙のみ)
  return {
    ...base,
    state: 'observed_single_site',
    evidence_level: 'observed',
    direction: 'none',
    headline: '観測中（あなたのサイトのデータ）',
    note: '観測値は参考です。確定判定は全社の横断プールで進行中。単一サイトでは因果を断定しません。',
  }
}

/** ArmStatsResult (M3) から検出力ゲートを評価する薄いアダプタ (API が使用)。 */
export function powerGateFromArmStats(
  stats: ArmStatsResult,
  pool: PoolCellSummary | null,
): PowerGateVerdict {
  return evaluatePowerGate({
    control_sessions: stats.control.sessions_n,
    treatment_sessions: stats.treatment.sessions_n,
    pool,
  })
}
