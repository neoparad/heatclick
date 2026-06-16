/**
 * Inngest config (durable jobs + cron)
 *
 * 親 SSOT §3.7.1 / §6.3 S0-10 / §4.6 Data Quality Monitoring (毎時 cron)
 * Sprint 0 S0-10 skeleton。Sprint 1+ で job 追加。
 */

import { Inngest } from 'inngest'

export const inngest = new Inngest({
  id: 'ugokimap-saas',
  name: 'UGOKI MAP SaaS',
  eventKey: process.env.INNGEST_EVENT_KEY,
})

// ===== Sprint 1+ で追加予定の jobs =====

/**
 * 毎時 Data Quality Gate チェック (§4.6.1)
 * TODO Sprint 2: 9 メトリクス監視 + 閾値違反時 Slack 通知 (lib/notify/incident.ts 経由)
 */
// export const dataQualityCheck = inngest.createFunction(
//   { id: 'data-quality-check' },
//   { cron: '0 * * * *' },
//   async ({ event, step }) => {
//     // ...
//   },
// )

/**
 * 毎日 03:00 JST ClickHouse バックアップ (§3.7.5 / §3.2.4)
 * TODO Sprint 0 後半 〜 Sprint 1: Hetzner SSH 経由で clickhouse-backup 実行
 */
// export const dailyBackup = inngest.createFunction(
//   { id: 'daily-backup' },
//   { cron: '0 18 * * *' }, // UTC 18:00 = JST 03:00
//   async ({ event, step }) => {
//     // ...
//   },
// )

/**
 * 削除請求 14 日後の HARD DELETE 実行 (§3.8.3)
 * TODO Sprint 3 S3-06: 削除請求テーブル監視 + ClickHouse 全テーブル削除
 */
// export const executeDeleteRequest = inngest.createFunction(
//   { id: 'execute-delete-request' },
//   { event: 'delete-request/scheduled' },
//   async ({ event, step }) => {
//     // ...
//   },
// )

/**
 * 日次 ML 学習 (Sprint 2+)
 * TODO: persona_classifier / cvr_predictor 等
 */

export const functions: ReturnType<typeof inngest.createFunction>[] = [
  // dataQualityCheck,
  // dailyBackup,
  // executeDeleteRequest,
]
