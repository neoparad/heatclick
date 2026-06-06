/**
 * POST /api/cron/deep-research — Deep Research 非同期ワーカー (オンデマンド polling)
 *
 * docs/ai-chat-deep-research-design.md §B / 親 SSOT §3.6.5 ClickHouse
 *
 * 役割:
 *   - analysis_jobs の status='pending' ジョブを取得 → claim → レポート生成 →
 *     proposal_tickets に書込 → job を completed/failed に更新
 *   - チャットの deep_research_enqueue が積んだジョブを数分以内に処理する
 *
 * セキュリティ:
 *   - Vercel Cron header (`x-vercel-cron: 1`) または `CRON_SECRET` header で認証
 *   - tenant context は持たない (job 行の tenant_id/site_id でスコープ)
 *
 * vercel.json (crons) 設定済: schedule は数分間隔 (Pro 以上で per-minute 可)。
 * 注: 書込は chat_writer role。Infra が新2テーブルへ grant 要
 *   (migrations/2026-06-06-deep-research-grants.sql)。
 */

import { NextResponse } from 'next/server'

import { runPendingDeepResearchJobs } from '@/lib/llm/deep-research'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min (1 stage 上限。1 回で最大 5 job 処理)

function isAuthorized(request: Request): boolean {
  const cronHeader = request.headers.get('x-vercel-cron')
  if (cronHeader === '1') return true
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('x-cron-secret') === secret) return true
  return false
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401 })
  }

  const t0 = Date.now()
  try {
    const result = await runPendingDeepResearchJobs({ limit: 5 })
    return NextResponse.json({
      success: true,
      data: { processed: result.processed, failed: result.failed, elapsedMs: Date.now() - t0 },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[cron/deep-research] failed: ${msg}`)
    return NextResponse.json({ success: false, error: { code: 'WORKER_FAILED' } }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } },
    { status: 405 },
  )
}
