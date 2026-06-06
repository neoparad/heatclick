/**
 * Heatmap display-state resolver — canvas が「何を表示すべきか」を 1 箇所で判定する pure helper。
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-30 続 117 v3 frontend heatmap empty-state
 *
 * 背景 (Owner: 「ヒートマップが表示されない」):
 *   `/api/heatmap` は実 ClickHouse query が **成功** したが行が 0 件の場合
 *   (GTM が v1 tracking.js を fire し tenant_id='__legacy__' で来る → tenant-scoped query が空) に
 *   `data_source='clickhouse_events'` のまま 0 points を返す。view-model は emptyViewModel() を返し、
 *   canvas は underlay のみ描画して **blob/tag/banner/loading/error すべて無し = 無言の白紙** になる。
 *   利用者は「壊れてる」のか「データが無い」のか区別できない。これを 1 つの state に正規化して
 *   informative な empty-state を出すために本 helper を用意する。
 *
 * 純粋関数・副作用なし。
 */

import type { HeatmapTileMeta } from '@/lib/api/heatmap'

export type HeatmapDisplayState =
  /** 初回 tile 取得中 (tile がまだ 1 枚も無い) */
  | 'loading'
  /** tile fetch がエラーで終わった */
  | 'error'
  /** 実 query 成功だが hotspot 0 件 (tracking 未着 / 期間内データ無し) */
  | 'real-empty'
  /** blob / tag を表示できる (real cluster あり、または fixture parity) */
  | 'has-data'

export interface HeatmapDisplayStateInput {
  /** meta.data_source。'clickhouse_events' のみ「実 data」とみなす。 */
  dataSource: HeatmapTileMeta['data_source'] | undefined
  /** view-model の blob 数 */
  blobCount: number
  /** view-model の tag 数 */
  tagCount: number
  /** 取得済 tile 数 (初回 loading 判定用) */
  tileCount: number
  /** tile fetch 中か */
  loading: boolean
  /** tile fetch エラー (null = エラー無し) */
  error: string | null
}

/**
 * canvas の表示すべき state を 1 つに正規化する。
 *
 * 優先順位:
 *   1. error  — fetch 失敗は最優先で利用者に出す
 *   2. loading — tile が 1 枚も無く取得中 (初回スピナー)
 *   3. real-empty — 実 query 成功 (clickhouse_events) かつ blob/tag 0 かつ loading 完了
 *   4. has-data — それ以外 (real cluster あり / dummy_lcg / legacy fixture parity)
 */
export function resolveHeatmapDisplayState(
  input: HeatmapDisplayStateInput,
): HeatmapDisplayState {
  if (input.error) return 'error'
  if (input.loading && input.tileCount === 0) return 'loading'

  const isRealSource = input.dataSource === 'clickhouse_events'
  if (isRealSource && input.blobCount === 0 && input.tagCount === 0 && !input.loading) {
    return 'real-empty'
  }

  return 'has-data'
}

/**
 * 「実 query 成功だが 0 件」= empty-state を出すべきか の判定だけが欲しい呼び出し向けの薄い wrapper。
 */
export function isRealEmptyHeatmap(input: HeatmapDisplayStateInput): boolean {
  return resolveHeatmapDisplayState(input) === 'real-empty'
}
