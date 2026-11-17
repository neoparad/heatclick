/**
 * /api/cron/daily-site-summary — Daily site summary 生成 cron (続 68 W2-A、続 66 §3 M-5)
 *
 * 親 SSOT §2.2.6 LLM / §3.6.5 ClickHouse
 * 配備根拠: 続 66 §3 M-5 (Vercel Cron 毎日 02:00 JST 実行)
 *
 * 起動経路:
 *   - GET  : **Vercel Cron**。Vercel Cron は常に GET で呼び、CRON_SECRET 設定時は
 *            `Authorization: Bearer <CRON_SECRET>` を付ける。
 *   - POST : 手動実行 (`x-cron-secret: <CRON_SECRET>`)。
 *   どちらも同じ処理・同じ認証 (`lib/cron-auth.ts`)。
 *
 * セキュリティ:
 *   - middleware では api-public (cron は JWT を持たない)。**認証はこの route 自身が行う**。
 *   - 認証が最初。認証前に設定状態 (503) を返さない。
 *   - tenant context は持たない (全 tenant × site を loop)
 *   - LLM_PROVIDER_MODE fail-fast (`assertLLMRuntimeConfig()`、続 64 §2a 継承)
 *
 * vercel.json:
 *   { "path": "/api/cron/daily-site-summary", "schedule": "0 17 * * *" }  // 02:00 JST = 17:00 UTC
 *
 * 応答:
 *   - 1 件も生成できず失敗だけがあった場合は 500 (`ALL_FAILED`)。200 で隠すと Vercel の
 *     実行ログ上は成功に見え、止まっていることに気づけない。
 *
 * W2-A scope:
 *   - cron handler 配備 + stub mode で動作 (実 LLM call ゼロ、template summary を INSERT)
 *   - Infra 続 67 D-2 (`daily_site_summaries` table) 着地後そのまま稼働
 * W2-B 拡張:
 *   - 実 LLM 呼出 (Haiku via Gateway)
 *   - per-tenant scheduling (大規模 tenant は分散)
 */

import { NextResponse } from 'next/server'

import { isCronAuthorized } from '@/lib/cron-auth'
import { assertLLMRuntimeConfig, LLMRuntimeConfigError } from '@/lib/llm/gateway'
import { regenerateAllDailySummaries } from '@/lib/llm/daily-summary'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min (Vercel function 上限内、site 数 × 2 query で十分)

async function handle(request: Request): Promise<NextResponse> {
  // 1. 認証 (続134: CRON_SECRET 設定時は secret 必須、spoofable な x-vercel-cron 単体を廃止)
  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED' } },
      { status: 401 },
    )
  }

  // 2. LLM runtime config fail-fast (続 64 §2a 継承、production 起動時の二重防御)
  try {
    assertLLMRuntimeConfig()
  } catch (err) {
    if (err instanceof LLMRuntimeConfigError) {
      console.error(`[cron/daily-site-summary] runtime config: ${err.message}`)
      return NextResponse.json(
        { success: false, error: { code: 'LLM_RUNTIME_CONFIG' } },
        { status: 503 },
      )
    }
    throw err
  }

  const t0 = Date.now()

  // 3. 全 site の summary 再生成
  // 大規模 tenant (>1000 site) では timeout 懸念。MVP は limit なし、observation 後に分散検討。
  try {
    const result = await regenerateAllDailySummaries({})
    const data = { generated: result.generated, failed: result.failed, elapsedMs: Date.now() - t0 }

    if (result.generated === 0 && result.failed > 0) {
      console.error(`[cron/daily-site-summary] all ${result.failed} site(s) failed`)
      return NextResponse.json(
        { success: false, error: { code: 'ALL_FAILED' }, data },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, data })
  } catch (err: unknown) {
    // 対象サイトの洗い出し自体の失敗 (ClickHouse 障害等)。詳細はログのみ、応答には載せない。
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[cron/daily-site-summary] failed: ${msg}`)
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
