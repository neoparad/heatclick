/**
 * 宝プロジェクト — k匿名横断プールの統計核 (M5, T1, requirement E)
 *
 * DerSimonian-Laird (DL) random-effects メタ分析 + Knapp-Hartung (KH) 補正。
 *
 * Reference (oracle):
 *   - .claude/plans/sim_pooling_power.py L32-44 — DL 部分は同実装と **数値一致** すること
 *     (pooling.test.ts が同式の独立移植と突き合わせる)。
 *   - KH 補正は sim に無い追加 (確定設計): 小 K で τ² が不安定なときの偽陽性 (sim 検証で
 *     K=5 → 5-7%) を抑える。SE_KH = √( Σw(θ-θ̂)² / ((K-1)·Σw) )、CI は t_{K-1,0.975} ×
 *     max(SE_KH, SE_classic) の保守的 truncation。
 *
 * 鉄則:
 *   - 入力は (site, arm) 集計から導いた {logRR, variance} のみ。visitor / tenant を持ち込まない。
 *   - τ² / I² (異質性) を必ず保存する (密なセルの健全性監視)。
 *   - K≥24 で初めて「効く傾向 (CI下限>0)」— その gating は呼出側 (pool-aggregate) が行い、
 *     本 module は K≥2 から計算可能な純関数として実装する。
 */

// 各サイト (=1実験、site 単位に dedupe 済み) の効果量。arm-stats の ArmEffect から作る。
export interface SiteEffect {
  log_rr: number
  variance: number
}

export interface PooledResult {
  k: number
  pooled_log_rr: number
  se: number
  ci_low: number
  ci_high: number
  tau2: number
  i2: number
  q: number
  method: 'DL+KH'
}

/**
 * DL random-effects + KH 補正。K < 2 / 不正入力 (非有限・variance<=0) は null (fail-closed)。
 */
export function poolSiteEffects(effects: ReadonlyArray<SiteEffect>): PooledResult | null {
  const valid = effects.filter(
    (e) => Number.isFinite(e.log_rr) && Number.isFinite(e.variance) && e.variance > 0,
  )
  const k = valid.length
  if (k < 2) return null

  // ── fixed-effects 重み (sim L33-35) ──
  const wf = valid.map((e) => 1 / e.variance)
  const sw = sum(wf)
  const pooledF = sum(valid.map((e, i) => wf[i] * e.log_rr)) / sw

  // ── Cochran's Q + DL τ² (sim L36-38) ──
  const q = sum(valid.map((e, i) => wf[i] * (e.log_rr - pooledF) ** 2))
  const c = sw - sum(wf.map((w) => w * w)) / sw
  const tau2 = c > 0 ? Math.max(0, (q - (k - 1)) / c) : 0

  // ── random-effects プール (sim L39-42) ──
  const w = valid.map((e) => 1 / (e.variance + tau2))
  const sw2 = sum(w)
  const pooled = sum(valid.map((e, i) => w[i] * e.log_rr)) / sw2
  const seClassic = Math.sqrt(1 / sw2)

  // ── Knapp-Hartung 補正 (sim に無い追加、確定設計) ──
  const qStar = sum(valid.map((e, i) => w[i] * (e.log_rr - pooled) ** 2))
  const seKh = Math.sqrt(qStar / ((k - 1) * sw2))
  // 保守的 truncation: KH が classic より狭くなるケースで反有意方向に絞らない。
  const se = Math.max(seKh, seClassic)

  const t = tQuantile975(k - 1)
  const i2 = q > 0 ? Math.max(0, (q - (k - 1)) / q) : 0

  return {
    k,
    pooled_log_rr: pooled,
    se,
    ci_low: pooled - t * se,
    ci_high: pooled + t * se,
    tau2,
    i2,
    q,
    method: 'DL+KH',
  }
}

function sum(xs: ReadonlyArray<number>): number {
  let acc = 0
  for (const x of xs) acc += x
  return acc
}

// ── Student-t 97.5% 分位 (両側 95% CI 用) ────────────────────────────────────
// df 1..10 は既知表の exact 値。df>10 は Cornish-Fisher 漸近展開 (df≥11 で誤差 <0.005、
// 運用域 df≥23 (K≥24) では <0.001)。外部依存を増やさないための自前実装。
const T_975_TABLE: ReadonlyArray<number> = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
]

const Z_975 = 1.959963985

export function tQuantile975(df: number): number {
  if (!Number.isFinite(df) || df < 1) return Number.NaN
  const n = Math.floor(df)
  if (n <= 10) return T_975_TABLE[n - 1]
  const z = Z_975
  const z2 = z * z
  const z3 = z2 * z
  const z5 = z3 * z2
  const z7 = z5 * z2
  const g1 = (z3 + z) / 4
  const g2 = (5 * z5 + 16 * z3 + 3 * z) / 96
  const g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384
  return z + g1 / n + g2 / n ** 2 + g3 / n ** 3
}
