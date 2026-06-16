/**
 * lib/scenarios/schedule-utils.ts — Schedule/FrequencyCap server-side helpers (Phase 2.1)
 *
 * Next.js route.ts は名前付き export を制限する (POST/GET 等のみ)。
 * このため runtime route 内で使う schedule filter ロジックを util として切り出す。
 *
 * Browser 側 (scenario-runtime.js) は同等ロジックを vanilla JS で reimpl する
 * (test もそれぞれ独立)。
 */

import type { Scenario } from './types'

/**
 * Phase 2.1: schedule の現在時刻チェック (Server-side authoritative)。
 *
 * - schedule 未設定 / null → 期間制約なし、常に true
 * - start_at 設定あり: now >= start_at が必須
 * - end_at 設定あり:   now < end_at が必須
 *
 * 不正な ISO 文字列が紛れ込んだ場合は **false (配信しない)** に倒す (fail-closed)。
 * 外側で Zod パース済前提だが、defensive に。
 */
export function isScenarioInSchedule(
  schedule: Scenario['schedule'],
  nowMs: number,
): boolean {
  if (!schedule) return true
  if (schedule.start_at) {
    const t = Date.parse(schedule.start_at)
    if (!Number.isFinite(t)) return false
    if (nowMs < t) return false
  }
  if (schedule.end_at) {
    const t = Date.parse(schedule.end_at)
    if (!Number.isFinite(t)) return false
    if (nowMs >= t) return false
  }
  return true
}
