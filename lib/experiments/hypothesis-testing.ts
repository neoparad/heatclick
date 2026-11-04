/**
 * 統計的仮説検定付き A/Bテストエンジン (Lane 4 Task 2)
 *
 * 「なんとなくCVRが高い」で早期終了・偽陽性（まぐれ当たり）を出すのを防ぐため、
 * Control群 (n_c, cv_c) と Variant群 (n_v, cv_v) に対して以下を厳密に算出する：
 *
 *   1. Control / Variant の CVR、絶対CVR差 (p_v - p_c)、相対リフト率 (Relative Lift %)
 *   2. 二標本比率のZ検定 (Two-proportion Z-test, pooled variance under H0) による両側 p値 (pValue)
 *   3. CVR差の 95%信頼区間 [ci95Low, ci95High] および 相対リフトの 95%信頼区間
 *   4. 最小検出効果量 (MDE, 既定20%相対改善) に基づく必要最小サンプルサイズ (requiredSessionsPerArm)、
 *      現在の目標サンプル到達率 (sampleProgressPct)、および事後・目標検出力 (Statistical Power 1 - β)
 *   5. 判定ステータス (Verdict Gate):
 *      - underpowered: サンプル不足（「検出力不足：あとNセッション必要。早期終了による偽陽性リスクあり」）
 *      - significant_winner: p < 0.05 かつ Power >= 0.8 かつ Lift > 0（「統計的有意に改善（p < 0.05）」）
 *      - significant_loser: p < 0.05 かつ Lift < 0（「統計的有意に悪化」）
 *      - inconclusive: それ以外（「有意差なし」）
 */

export type HypothesisVerdict =
  | 'underpowered'
  | 'significant_winner'
  | 'significant_loser'
  | 'inconclusive'

export interface HypothesisTestInput {
  /** Control群のセッション数 (n_c) */
  controlSessions?: number
  /** Control群の訪問者数エイリアス (visitorsC) */
  visitorsC?: number
  /** Control群のコンバージョン数 (cv_c) */
  controlConversions?: number
  /** Control群のコンバージョン数エイリアス (conversionsC) */
  conversionsC?: number
  /** Variant群のセッション数 (n_v) */
  variantSessions?: number
  /** Variant群の訪問者数エイリアス (visitorsV) */
  visitorsV?: number
  /** Variant群のコンバージョン数 (cv_v) */
  variantConversions?: number
  /** Variant群のコンバージョン数エイリアス (conversionsV) */
  conversionsV?: number
  /** 有意水準 α (既定 0.05) */
  alpha?: number
  /** 目標検出力 1 - β (既定 0.80) */
  targetPower?: number
  /** 最小検出相対効果量 MDE (既定 0.15 = +15% 相対改善を検出できるサンプルサイズを要求) */
  mdeRelative?: number
  /** 1群あたりの最低必須セッション数フロア (既定 400) */
  minSessionsFloorPerArm?: number
}

export interface HypothesisTestResult {
  control: {
    sessions: number
    conversions: number
    cvr: number
  }
  variant: {
    sessions: number
    conversions: number
    cvr: number
  }
  /** 絶対CVR差 (p_v - p_c) */
  absoluteDiff: number
  /** 相対リフト率 ((p_v - p_c) / p_c) — 例: +0.284 は +28.4% */
  relativeLift: number
  /** 相対リフト (%) — 例: 28.4 */
  relativeLiftPct: number
  /** 二標本比率Z検定の Z統計量 */
  zScore: number
  /** 両側 p値 (0〜1) */
  pValue: number
  /** 絶対CVR差の 95%信頼区間下限 */
  ci95Low: number
  /** 絶対CVR差の 95%信頼区間上限 */
  ci95High: number
  /** 相対リフト(%)の 95%信頼区間下限 */
  relativeCi95LowPct: number
  /** 相対リフト(%)の 95%信頼区間上限 */
  relativeCi95HighPct: number
  /** 観測効果に対する統計的検出力 (1 - β, 0〜1) */
  statisticalPower: number
  /** MDEと基準CVRから算出された1群あたり必要サンプルサイズ */
  requiredSessionsPerArm: number
  /** requiredSessionsPerArm のエイリアス */
  requiredSamplePerArm: number
  /** 現在の最小群セッション数 */
  currentMinArmSessions: number
  /** 必要サンプルに対する残りセッション数 (両群合計の不足分) */
  remainingSessionsNeeded: number
  /** 目標サンプル到達率 (0〜100%) */
  sampleProgressPct: number
  /** 仮説検定ゲート判定 */
  verdict: HypothesisVerdict
  /** UI表示用ヘッドライン */
  verdictHeadline: string
  /** UI表示用詳細説明 */
  verdictSummary: string
}

/**
 * 標準正規分布の累積分布関数 Φ(x) (Abramowitz & Stegun 7.1.26 高精度近似、最大誤差 < 1.5e-7)
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.SQRT2
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1.0 / (1.0 + p * absX)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return 0.5 * (1.0 + sign * y)
}

/**
 * 標準正規分布の逆累積分布関数 Φ^{-1}(p) (Peter Acklam の有理関数近似)
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  if (Math.abs(p - 0.5) < 1e-15) return 0

  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ]

  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  )
}

/**
 * 基準CVR (baselineCvr) と最小検出相対リフト (mdeRelative) から、
 * 両側水準 alpha・目標検出力 targetPower を達成するために必要な1群あたりのサンプルサイズを算出
 */
export function computeRequiredSampleSizePerArm(opts: {
  baselineCvr: number
  mdeRelative?: number
  alpha?: number
  targetPower?: number
  minFloor?: number
}): number {
  const alpha = opts.alpha ?? 0.05
  const targetPower = opts.targetPower ?? 0.8
  const mdeRelative = opts.mdeRelative ?? 0.15
  const minFloor = opts.minFloor ?? 400

  const p1 = Math.min(Math.max(opts.baselineCvr, 0.005), 0.95)
  const p2 = Math.min(p1 * (1 + Math.max(mdeRelative, 0.05)), 0.99)
  const delta = Math.abs(p2 - p1)
  if (delta <= 1e-6) return minFloor

  const zAlpha = normalQuantile(1 - alpha / 2)
  const zBeta = normalQuantile(targetPower)
  const pBar = (p1 + p2) / 2

  const numerator = Math.pow(
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
      zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
    2,
  )
  const n = Math.ceil(numerator / (delta * delta))
  // 実務的な下限・上限キャップ（MDE計算が極端な低CVRで発散しすぎないよう調整）
  return Math.max(minFloor, Math.min(n, 25000))
}

/**
 * 二標本比率のZ検定 + 95%信頼区間 + 検出力 + Verdict Gate 評価
 */
export function runHypothesisTest(input: HypothesisTestInput): HypothesisTestResult {
  const alpha = input.alpha ?? 0.05
  const targetPower = input.targetPower ?? 0.8
  const mdeRelative = input.mdeRelative ?? 0.15
  const minFloor = input.minSessionsFloorPerArm ?? 400

  const rawNc = input.controlSessions ?? input.visitorsC ?? 0
  const rawNv = input.variantSessions ?? input.visitorsV ?? 0
  const rawCvc = input.controlConversions ?? input.conversionsC ?? 0
  const rawCvv = input.variantConversions ?? input.conversionsV ?? 0

  const nc = Math.max(0, Math.floor(Number.isFinite(rawNc) ? rawNc : 0))
  const nv = Math.max(0, Math.floor(Number.isFinite(rawNv) ? rawNv : 0))
  const cvc = Math.min(nc, Math.max(0, Math.floor(Number.isFinite(rawCvc) ? rawCvc : 0)))
  const cvv = Math.min(nv, Math.max(0, Math.floor(Number.isFinite(rawCvv) ? rawCvv : 0)))

  const pc = nc > 0 ? cvc / nc : 0
  const pv = nv > 0 ? cvv / nv : 0
  const absoluteDiff = pv - pc
  const relativeLift = pc > 0 ? absoluteDiff / pc : 0
  const relativeLiftPct = Number((relativeLift * 100).toFixed(2))

  // Pooled proportion under H0: p_c = p_v
  const totalN = nc + nv
  const pooledP = totalN > 0 ? (cvc + cvv) / totalN : 0
  const sePooled =
    nc > 0 && nv > 0 && pooledP > 0 && pooledP < 1
      ? Math.sqrt(pooledP * (1 - pooledP) * (1 / nc + 1 / nv))
      : 0

  const zScore = sePooled > 0 ? absoluteDiff / sePooled : 0
  const pValue = sePooled > 0 ? Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(zScore))))) : 1

  // Unpooled Wald 95% confidence interval for difference (p_v - p_c)
  const zCrit = normalQuantile(1 - alpha / 2)
  const seUnpooled =
    nc > 0 && nv > 0
      ? Math.sqrt((pc * (1 - pc)) / nc + (pv * (1 - pv)) / nv)
      : 0
  const ci95Low = absoluteDiff - zCrit * seUnpooled
  const ci95High = absoluteDiff + zCrit * seUnpooled

  const relativeCi95LowPct = pc > 0 ? Number(((ci95Low / pc) * 100).toFixed(2)) : 0
  const relativeCi95HighPct = pc > 0 ? Number(((ci95High / pc) * 100).toFixed(2)) : 0

  // Statistical Power (1 - β)
  let statisticalPower = 0
  if (seUnpooled > 0 && sePooled > 0) {
    const nonCentrality = Math.abs(absoluteDiff) / seUnpooled
    statisticalPower = Math.min(
      1,
      Math.max(0, normalCdf(nonCentrality - zCrit) + normalCdf(-nonCentrality - zCrit)),
    )
  }

  const baselineForSample = pc > 0 ? pc : 0.03
  const requiredSessionsPerArm = computeRequiredSampleSizePerArm({
    baselineCvr: baselineForSample,
    mdeRelative,
    alpha,
    targetPower,
    minFloor,
  })

  const currentMinArmSessions = Math.min(nc, nv)
  const deficitControl = Math.max(0, requiredSessionsPerArm - nc)
  const deficitVariant = Math.max(0, requiredSessionsPerArm - nv)
  const remainingSessionsNeeded = deficitControl + deficitVariant
  const sampleProgressPct = Math.min(
    100,
    Math.round((currentMinArmSessions / Math.max(1, requiredSessionsPerArm)) * 100),
  )

  // Verdict Gate
  let verdict: HypothesisVerdict
  let verdictHeadline: string
  let verdictSummary: string

  const hasEnoughSample = currentMinArmSessions >= minFloor && (currentMinArmSessions >= requiredSessionsPerArm || statisticalPower >= targetPower)

  if (!hasEnoughSample) {
    verdict = 'underpowered'
    const needed = Math.max(remainingSessionsNeeded, Math.max(0, minFloor - nc) + Math.max(0, minFloor - nv))
    verdictHeadline = `検出力不足：あと ${needed.toLocaleString()} セッション必要。早期終了による偽陽性リスクあり`
    verdictSummary = `現在の検出力は ${(statisticalPower * 100).toFixed(1)}%（目標 ${(targetPower * 100).toFixed(0)}%）。サンプル蓄積途中の p値 (${pValue.toFixed(3)}) で判定すると偽陽性（まぐれ当たり）のリスクが高いため結論を保留しています。`
  } else if (pValue < alpha && statisticalPower >= targetPower && relativeLift > 0) {
    verdict = 'significant_winner'
    verdictHeadline = `統計的有意に改善（p = ${pValue < 0.001 ? '< 0.001' : pValue.toFixed(4)} < ${alpha}）`
    verdictSummary = `Variant群が Control群に対して相対リフト +${relativeLiftPct}%（95%信頼区間: ${relativeCi95LowPct >= 0 ? '+' : ''}${relativeCi95LowPct}% 〜 +${relativeCi95HighPct}%）、検出力 ${(statisticalPower * 100).toFixed(1)}% で帰無仮説を棄却しました。本番100%展開を推奨します。`
  } else if (pValue < alpha && relativeLift < 0) {
    verdict = 'significant_loser'
    verdictHeadline = `統計的有意に悪化（p = ${pValue < 0.001 ? '< 0.001' : pValue.toFixed(4)} < ${alpha}）`
    verdictSummary = `Variant群のCVRが相対 ${relativeLiftPct}% 低下しており、偶然のブレではない悪化が検出されました。直ちにVariant配信を停止しControlへ戻すことを推奨します。`
  } else {
    verdict = 'inconclusive'
    verdictHeadline = `有意差なし（p = ${pValue.toFixed(3)} ≥ ${alpha}）`
    verdictSummary = `必要サンプル数に到達しましたが、95%信頼区間（${relativeCi95LowPct}% 〜 +${relativeCi95HighPct}%）が 0% を跨いでおり、帰無仮説（両群に差がない）を棄却できません。仮説の再設計を推奨します。`
  }

  return {
    control: { sessions: nc, conversions: cvc, cvr: pc },
    variant: { sessions: nv, conversions: cvv, cvr: pv },
    absoluteDiff,
    relativeLift,
    relativeLiftPct,
    zScore,
    pValue,
    ci95Low,
    ci95High,
    relativeCi95LowPct,
    relativeCi95HighPct,
    statisticalPower,
    requiredSessionsPerArm,
    requiredSamplePerArm: requiredSessionsPerArm,
    currentMinArmSessions,
    remainingSessionsNeeded,
    sampleProgressPct,
    verdict,
    verdictHeadline,
    verdictSummary,
  }
}
