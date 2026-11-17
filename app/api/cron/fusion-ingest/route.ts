/**
 * /api/cron/fusion-ingest — UGOKI Crawl 融合エクスポートの定期取り込み (経路B)
 *
 * FUSION_INGEST_TARGETS の各サイトについて UGOKI Crawl /v1/fusion/export を pull → 検証 →
 * ClickHouse 融合5表へ INSERT。日次想定 (クロールは48h、突合は最新クロールを反映)。
 *
 * 起動経路:
 *   - GET  : **Vercel Cron**。Vercel Cron は常に GET で呼び、CRON_SECRET 設定時は
 *            `Authorization: Bearer <CRON_SECRET>` を付ける。
 *   - POST : 手動実行 (`x-cron-secret: <CRON_SECRET>`)。
 *   どちらも同じ処理・同じ認証 (`lib/cron-auth.ts`)。
 *
 * セキュリティ:
 *   - middleware では api-public (cron は JWT を持たない)。**認証はこの route 自身が行う**。
 *   - 書込は chat_writer (Infra grant 要)。
 *
 * 応答:
 *   - 件数のみ返す。対象ごとの tenant/site/job とエラー本文はサーバーログにだけ残す。
 *   - 対象が 1 件も成功せず失敗だけだった場合は 500 (`ALL_FAILED`)。200 で隠すと Vercel の
 *     実行ログ上は成功に見え、止まっていることに気づけない。
 *   - 取り込み対象が未設定 (0 件) は 200 (何もしない)。
 */

import { NextResponse } from 'next/server'

import { isCronAuthorized } from '@/lib/cron-auth'
import { runFusionIngest } from '@/lib/fusion/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function handle(request: Request): Promise<NextResponse> {
  // 続134: CRON_SECRET 設定時は secret 必須 (spoofable な x-vercel-cron 単体を廃止)
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401 })
  }
  const t0 = Date.now()
  try {
    const results = await runFusionIngest()
    const ok = results.filter((r) => r.ok).length
    const failed = results.length - ok
    // 応答は件数のみ。対象の tenant/site/job とエラー本文は応答に載せず、サーバーログに残す。
    for (const r of results) {
      if (!r.ok) {
        console.error(
          `[cron/fusion-ingest] target failed tenant=${r.target.tenantId} site=${r.target.siteId} ` +
            `job=${r.target.jobId}: ${r.error ?? 'unknown'}`,
        )
      }
    }
    const data = { targets: results.length, ok, failed, elapsedMs: Date.now() - t0 }

    if (ok === 0 && failed > 0) {
      console.error(`[cron/fusion-ingest] all ${failed} target(s) failed`)
      return NextResponse.json(
        { success: false, error: { code: 'ALL_FAILED' }, data },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[cron/fusion-ingest] failed: ${msg}`)
    return NextResponse.json({ success: false, error: { code: 'INGEST_FAILED' } }, { status: 500 })
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
