/**
 * heatmap 強度の正規化ヘルパ。
 *
 * 線形の `count / maxCount` では、外れ値1点が max を跳ね上げると他のセル/blob が
 * washed out (薄緑)になり「1点だけ濃い・他は読めない」状態になる。
 * logNormalize は log1p で高域を圧縮し中〜低域を可視域へ持ち上げる。順序は保つ
 * (最大値が最濃)。返り値は 0..1。
 *
 * 例: counts に 10 が多数 + 外れ値 500 がある場合、
 *   線形:  10/500 = 0.02 (ほぼ不可視)
 *   log :  log1p(10)/log1p(500) ≈ 0.39 (パターンが読める)、500 は 1.0 のまま。
 */
export function logNormalize(count: number, maxCount: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0
  const denom = Math.log1p(Math.max(maxCount, 1))
  if (denom <= 0) return 0
  const v = Math.log1p(count) / denom
  return Math.min(1, Math.max(0, v))
}
