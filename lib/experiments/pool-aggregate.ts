/**
 * 宝プロジェクト — 横断プール セル集約 orchestrator (M5, T1)
 *
 * 流れ: poolable 実験の列挙 (cross-tenant、pool_opt_in のみ) → site 単位 dedupe →
 * セル (taxonomy 4次元 × primary_metric) ごとに arm 計測 (M3) → DL+KH (pooling.ts) →
 * K≥24 なら experiment_pool_cells へ upsert (meets_k50 = K≥50)、K<24 なら既存行を削除
 * (古い「効く傾向」を残さない = stale verdict 防止)。
 *
 * k匿名境界:
 *   - 本 module が扱う cross-tenant データは {site 単位の logRR, variance, sessions} のみ。
 *     visitor_id は M3 内で消費済みでここへ届かない。pool 行に tenant_id を書かない。
 *   - 同一サイトの複数実験は 1 本に dedupe (最新 start_at)。DL は独立研究を仮定するため。
 *
 * 注入設計: source / measure / store を DI してユニットテスト可能にする (PG/ClickHouse 実体は
 * pool-store.ts と arm-stats.ts が提供)。
 */

import type { ArmStatsResult } from './arm-stats'
import { computeArmEffect } from './arm-stats'
import { poolSiteEffects, type SiteEffect } from './pooling'
import { cellKey, type PrimaryMetric } from './taxonomy'
import type { Experiment } from './types'

// セル行の存在 floor (handoff §マイルストーン4 / migration CHECK k_sites>=24 と一致)。
export const POOL_PUBLISH_MIN_K = 24
// 開示 (meets_k50) の同意/匿名閾値。
export const POOL_DISCLOSE_MIN_K = 50
// 1実験がプールに寄与できる最低 arm sessions (衛生 floor)。これ未満は logRR が病的になるため
// 除外。DL 重みは分散で自動調整されるが、極小 n の連続性補正バイアスを入れない。
export const MIN_POOL_ARM_SESSIONS = 100
// 計測失敗率がこれを超えたら run 全体を abort し corpus に一切書かない (Codex M5 HIGH:
// ClickHouse 障害等の systemic 失敗で K が見かけ上崩れ、既存セルが削除されて顧客表示が
// 「未確定」へ巻き戻る corpus churn を防ぐ)。
export const POOL_MAX_MEASURE_FAILURE_RATE = 0.1

export interface PoolCellUpsert {
  cell_key: string
  intervention_type: string
  page_type: string
  industry: string
  device: string
  primary_metric: PrimaryMetric
  k_sites: number
  total_sessions: number
  pooled_log_rr: number
  ci_low: number
  ci_high: number
  tau2: number
  i2: number
  meets_k50: boolean
}

export interface PoolCellWriteStore {
  upsert(row: PoolCellUpsert): Promise<void>
  /** 行があれば削除して true。 */
  remove(cellKeyValue: string, primaryMetric: PrimaryMetric): Promise<boolean>
}

export interface PoolableExperimentSource {
  /** cross-tenant 読み (内部 pipeline 専用)。pool_opt_in かつ running/stopped のみ返す実装契約。 */
  listPoolable(): Promise<Experiment[]>
}

export interface RecomputeDeps {
  source: PoolableExperimentSource
  /** 実験 1 本の arm 計測 (M3 queryArmStats を salt 閉包で包んだもの)。 */
  measure: (experiment: Experiment) => Promise<ArmStatsResult>
  store: PoolCellWriteStore
}

export interface RecomputeSummary {
  experiments_considered: number
  experiments_contributed: number
  /** 計測の失敗数 (throw + data_unavailable)。systemic 障害の検知用。 */
  measure_failures: number
  cells_considered: number
  cells_published: number
  cells_removed: number
  /** 失敗率 > POOL_MAX_MEASURE_FAILURE_RATE で true (corpus へ一切書いていない)。 */
  aborted: boolean
}

/** 同一サイト (tenant|site) の複数実験は最新 start_at の 1 本に dedupe (DL の独立性仮定)。 */
export function dedupePerSite(experiments: ReadonlyArray<Experiment>): Experiment[] {
  const bySite = new Map<string, Experiment>()
  for (const e of experiments) {
    const key = `${e.tenant_id}|${e.site_id}`
    const prev = bySite.get(key)
    if (!prev || (e.dates.start_at ?? '') > (prev.dates.start_at ?? '')) {
      bySite.set(key, e)
    }
  }
  return [...bySite.values()]
}

/** セル (taxonomy 4次元 + primary_metric) ごとにグループ化。 */
export function groupByCell(experiments: ReadonlyArray<Experiment>): Map<string, Experiment[]> {
  const groups = new Map<string, Experiment[]>()
  for (const e of experiments) {
    const key = `${cellKey(e.taxonomy)}::${e.taxonomy.primary_metric}`
    const arr = groups.get(key)
    if (arr) arr.push(e)
    else groups.set(key, [e])
  }
  return groups
}

/** 計測結果から寄与可能な site effect を作る (衛生 floor + effect 有のみ)。null = 寄与不可。 */
export function toSiteEffect(stats: ArmStatsResult): (SiteEffect & { sessions: number }) | null {
  if (stats.data_unavailable) return null
  if (
    stats.control.sessions_n < MIN_POOL_ARM_SESSIONS ||
    stats.treatment.sessions_n < MIN_POOL_ARM_SESSIONS
  ) {
    return null
  }
  const effect = computeArmEffect(
    { sessions_n: stats.control.sessions_n, conversions: stats.control.conversions },
    { sessions_n: stats.treatment.sessions_n, conversions: stats.treatment.conversions },
  )
  if (!effect) return null
  return { log_rr: effect.log_rr, variance: effect.variance, sessions: stats.total_sessions }
}

interface CellPlan {
  keyValue: string
  metric: PrimaryMetric
  sample: Experiment
  effects: Array<SiteEffect & { sessions: number }>
  /** このセル内で計測に失敗した実験数 (throw + data_unavailable)。 */
  failures: number
}

/**
 * 全セルを再計算して corpus (experiment_pool_cells) を更新する (two-phase、Codex M5 HIGH)。
 *
 * Phase 1 (計測): 全セルの寄与を収集。個別失敗は寄与スキップで継続 (部分故障耐性)。
 * Phase 2 (書込): 全体の計測失敗率が POOL_MAX_MEASURE_FAILURE_RATE を超えたら **一切書かず abort**
 *   (systemic 障害で corpus を churn させない)。健全な run でも、**削除はそのセルの計測が
 *   全成功したときのみ** (失敗を含むセルの K 低下は「データが消えた」ではなく「測れなかった」
 *   可能性があるため、既存行を保持する)。
 */
export async function recomputePoolCells(deps: RecomputeDeps): Promise<RecomputeSummary> {
  const poolable = await deps.source.listPoolable()
  const deduped = dedupePerSite(poolable)
  const cells = groupByCell(deduped)

  const summary: RecomputeSummary = {
    experiments_considered: deduped.length,
    experiments_contributed: 0,
    measure_failures: 0,
    cells_considered: cells.size,
    cells_published: 0,
    cells_removed: 0,
    aborted: false,
  }

  // ── Phase 1: 計測 (書込はまだしない) ──
  const plans: CellPlan[] = []
  for (const [, cellExperiments] of cells) {
    const sample = cellExperiments[0]
    const plan: CellPlan = {
      keyValue: cellKey(sample.taxonomy),
      metric: sample.taxonomy.primary_metric,
      sample,
      effects: [],
      failures: 0,
    }

    for (const experiment of cellExperiments) {
      try {
        const stats = await deps.measure(experiment)
        if (stats.data_unavailable) {
          // 計測基盤に届かなかった (systemic 候補)。「不適格」ではなく「失敗」として数える。
          plan.failures += 1
          continue
        }
        const effect = toSiteEffect(stats)
        if (effect) {
          plan.effects.push(effect)
          summary.experiments_contributed += 1
        }
        // effect=null (衛生 floor 未達等) は正当な不適格 — 失敗には数えない。
      } catch (e) {
        plan.failures += 1
        // eslint-disable-next-line no-console
        console.warn(
          `[experiments/pool] measure failed for ${experiment.id}, skipping contribution: ${(e as Error).message}`,
        )
      }
    }
    summary.measure_failures += plan.failures
    plans.push(plan)
  }

  // ── Phase 2: 健全性ゲート → 書込 ──
  if (
    summary.experiments_considered > 0 &&
    summary.measure_failures / summary.experiments_considered > POOL_MAX_MEASURE_FAILURE_RATE
  ) {
    summary.aborted = true
    // eslint-disable-next-line no-console
    console.error(
      `[experiments/pool] aborting recompute: ${summary.measure_failures}/${summary.experiments_considered} measurements failed (systemic failure suspected); corpus left untouched`,
    )
    return summary
  }

  for (const plan of plans) {
    const k = plan.effects.length

    if (k < POOL_PUBLISH_MIN_K) {
      // floor 未達。削除は「セル内の計測が全成功して K<24 が確定」したときのみ
      // (失敗込みの K 低下では既存行を保持 = 化石化防止と障害耐性の両立)。
      if (plan.failures === 0) {
        const removed = await deps.store.remove(plan.keyValue, plan.metric)
        if (removed) summary.cells_removed += 1
      }
      continue
    }

    const pooled = poolSiteEffects(plan.effects)
    if (!pooled) continue // K>=24 で null は起きないが防御

    await deps.store.upsert({
      cell_key: plan.keyValue,
      intervention_type: plan.sample.taxonomy.intervention_type,
      page_type: plan.sample.taxonomy.page_type,
      industry: plan.sample.taxonomy.industry,
      device: plan.sample.taxonomy.device,
      primary_metric: plan.metric,
      k_sites: pooled.k,
      total_sessions: plan.effects.reduce((a, e) => a + e.sessions, 0),
      pooled_log_rr: pooled.pooled_log_rr,
      ci_low: pooled.ci_low,
      ci_high: pooled.ci_high,
      tau2: pooled.tau2,
      i2: pooled.i2,
      meets_k50: pooled.k >= POOL_DISCLOSE_MIN_K,
    })
    summary.cells_published += 1
  }

  return summary
}
