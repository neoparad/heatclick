/**
 * 宝プロジェクト — experiment_pool_cells 読み出し + 開示ゲート (M4b)
 *
 * Reference:
 *   - migrations/2026-06-10-experiments-registry.sql §experiment_pool_cells (二層しきい値)
 *   - 鉄則「k≥50 匿名・同意」/ handoff §マイルストーン4
 *
 * 二層しきい値の役割分担:
 *   - K≥24 (行の存在): 「効く傾向」を計算してよい統計 floor。corpus 内部 (M5) の世界。
 *   - meets_k50 (= k_sites≥50): **顧客への開示・集約ゲート**。cross-customer の pooled 値や
 *     サイト数を顧客 view に出してよいのはこのフラグが立つセルのみ。
 *   → 本 module は顧客 view (M4b result API) 用なので **meets_k50 のセルだけ** を返す。
 *     24≤K<50 のセルは存在しても顧客には null (=「未確定 (全社プールで判定中)」のまま)。
 */

import { experimentsQuery } from './db'
import type { PoolCellSummary } from './power-gate'
import { cellKey, type CellDimensions, type PrimaryMetric } from './taxonomy'

export interface PoolCellRow {
  k_sites: number
  ci_low: number | string | null
  ci_high: number | string | null
  meets_k50: boolean
}

/**
 * 顧客開示用の PoolCellSummary へ変換 (pure)。
 * meets_k50 でない / CI が欠損・非有限・反転 のセルは null (fail-closed、開示しない)。
 */
export function toDisclosablePoolSummary(row: PoolCellRow | null | undefined): PoolCellSummary | null {
  if (!row) return null
  if (!row.meets_k50) return null
  // CI 欠損・空文字は明示拒否 (Number(null)=0 / Number('')=0 で「CI=0」に化ける fail-open を防ぐ)。
  if (!isPresentNumberLike(row.ci_low) || !isPresentNumberLike(row.ci_high)) return null
  const kSites = Number(row.k_sites)
  const ciLow = Number(row.ci_low)
  const ciHigh = Number(row.ci_high)
  if (!Number.isInteger(kSites) || kSites < 50) return null
  if (!Number.isFinite(ciLow) || !Number.isFinite(ciHigh) || ciLow > ciHigh) return null
  return { k_sites: kSites, ci_low: ciLow, ci_high: ciHigh, meets_k50: true }
}

/**
 * 実験のセル (taxonomy 4 次元 × primary_metric) の開示可能な pool 要約を読む。
 * 行なし / meets_k50 未達 / table 未作成 / DB 不通 はすべて null (顧客 view は graceful に
 * 「未確定」へ倒れる。pool が読めないことで result API を落とさない)。
 */
export async function readDisclosablePoolCell(
  dims: CellDimensions,
  primaryMetric: PrimaryMetric,
): Promise<PoolCellSummary | null> {
  try {
    const rows = await experimentsQuery<PoolCellRow>(
      `SELECT k_sites, ci_low, ci_high, meets_k50
         FROM experiment_pool_cells
        WHERE cell_key = $1 AND primary_metric = $2
        LIMIT 1`,
      [cellKey(dims), primaryMetric],
    )
    return toDisclosablePoolSummary(rows[0])
  } catch (e) {
    // graceful: pool 読み出し失敗は「プール情報なし」に倒す (開示は fail-closed、result view を壊さない)。
    // 回帰が「証拠なし」に見えないよう error class も残す (Codex M4b LOW)。
    const err = e as Error
    // eslint-disable-next-line no-console
    console.warn(`[experiments/pool-cells] read failed (${err.name}), treating as no pool: ${err.message}`)
    return null
  }
}

// null/undefined/空白文字列を拒否した上で数値化できる値のみ通す (forged row 硬化)。
function isPresentNumberLike(v: number | string | null | undefined): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  return true
}
