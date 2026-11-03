/**
 * CV経路分析 — 期間の正規化
 *
 * 旧バグ (2026-07-14 発見、「静かな失敗」6件目): /api/cv-journey は日付未指定時に
 * 全履歴を集計するのに meta.periodDays=7 を返しており、クエリと表示が不一致だった。
 * 未指定の境界をここで確定させ、クエリ条件と meta.periodDays を常に一致させる。
 *
 * 規則 (すべて UTC の暦日、YYYY-MM-DD):
 *   - start / end 両方指定 → そのまま
 *   - 両方未指定           → end=今日, start=6日前 (7日間ウィンドウ)
 *   - start のみ           → end=今日
 *   - end のみ             → start=end-6日 (7日間ウィンドウ)
 *   - 期間は最大 365 日 (paths stats-query と同基準)。超過時は start を
 *     end-364日 へ切り詰め、events の無制限フルスキャンを防ぐ。
 */

const DAY_MS = 86_400_000

/** 期間上限 (日)。lib/paths/stats-query.ts の validateQueryArgs と同じ 365 日。 */
export const MAX_PERIOD_DAYS = 365

export interface ResolvedPeriod {
  /** クエリに渡す実効開始日 (YYYY-MM-DD) */
  startDate: string
  /** クエリに渡す実効終了日 (YYYY-MM-DD、当日を含む) */
  endDate: string
  /** meta.periodDays に返す日数 (両端含む) */
  days: number
}

function toDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function resolvePeriod(
  start: string | undefined,
  end: string | undefined,
  now: Date = new Date(),
): ResolvedPeriod {
  const today = toDateString(now.getTime())
  const endDate = end ?? today
  const endMs = Date.parse(endDate)
  let startDate =
    start ?? (Number.isNaN(endMs) ? today : toDateString(endMs - 6 * DAY_MS))

  const s = Date.parse(startDate)
  const e = Date.parse(endDate)
  let days =
    Number.isNaN(s) || Number.isNaN(e) ? 7 : Math.max(1, Math.round((e - s) / DAY_MS) + 1)

  // 期間上限: 超過時は start を切り詰める (meta.periodDays も切り詰め後を返す = 表示と一致)
  if (days > MAX_PERIOD_DAYS && !Number.isNaN(e)) {
    startDate = toDateString(e - (MAX_PERIOD_DAYS - 1) * DAY_MS)
    days = MAX_PERIOD_DAYS
  }

  return { startDate, endDate, days }
}
