/**
 * /api/cron/deep-research — Deep Research 非同期ワーカー (オンデマンド polling)
 *
 * docs/ai-chat-deep-research-design.md §B / 親 SSOT §3.6.5 ClickHouse
 *
 * 役割:
 *   - analysis_jobs の status='pending' ジョブを取得 → claim → レポート生成 →
 *     proposal_tickets に書込 → job を completed/failed に更新
 *   - チャットの deep_research_enqueue が積んだジョブを数分以内に処理する
 *
 * 起動経路:
 *   - GET  : **Vercel Cron**。Vercel Cron は常に GET で呼び、CRON_SECRET 設定時は
 *            `Authorization: Bearer <CRON_SECRET>` を付ける。
 *   - POST : 手動実行 (`x-cron-secret: <CRON_SECRET>`)。
 *   どちらも同じ処理・同じ認証 (`lib/cron-auth.ts`)。
 *
 * セキュリティ:
 *   - middleware では api-public (cron は JWT を持たない)。**認証はこの route 自身が行う**。
 *   - tenant context は持たない (job 行の tenant_id/site_id でスコープ)
 *
 * 応答:
 *   - 取り出したジョブが 1 件も完了せず失敗だけだった場合は 500 (`ALL_FAILED`)。
 *     200 で隠すと Vercel の実行ログ上は成功に見え、止まっていることに気づけない。
 *
 * vercel.json (crons) 設定済: schedule は数分間隔 (Pro 以上で per-minute 可)。
 * 注: 書込は chat_writer role。Infra が新2テーブルへ grant 要
 *   (migrations/2026-06-06-deep-research-grants.sql)。
 */

import { NextResponse } from 'next/server'

import { isCronAuthorized } from '@/lib/cron-auth'
import { runPendingDeepResearchJobs } from '@/lib/llm/deep-research'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min (1 stage 上限。1 回で最大 5 job 処理)

async function handle(request: Request): Promise<NextResponse> {
  // 続134: CRON_SECRET 設定時は secret 必須 (spoofable な x-vercel-cron 単体を廃止)
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401 })
  }

  const t0 = Date.now()
  try {
    const result = await runPendingDeepResearchJobs({ limit: 5 })
    const data = { processed: result.processed, failed: result.failed, elapsedMs: Date.now() - t0 }

    if (result.processed === 0 && result.failed > 0) {
      console.error(`[cron/deep-research] all ${result.failed} job(s) failed`)
      return NextResponse.json(
        { success: false, error: { code: 'ALL_FAILED' }, data },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[cron/deep-research] failed: ${msg}`)
    return NextResponse.json({ success: false, error: { code: 'WORKER_FAILED' } }, { status: 500 })
  }
}

/** Vercel Cron 起動 (GET)。 */
export async function GET(request: Request): Promise<NextResponse> {
  return handle(request)
}

/** 手動実行 (POST)。 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(request)
}
