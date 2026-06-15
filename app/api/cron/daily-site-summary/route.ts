/**
 * POST /api/cron/daily-site-summary — Daily site summary 生成 cron (続 68 W2-A、続 66 §3 M-5)
 *
 * 親 SSOT §2.2.6 LLM / §3.6.5 ClickHouse
 * 配備根拠: 続 66 §3 M-5 (Vercel Cron 毎日 02:00 JST 実行)
 *
 * セキュリティ:
 *   - Vercel Cron header (`x-vercel-cron: 1`) または `CRON_SECRET` header で認証
 *   - tenant context は持たない (全 tenant × site を loop)
 *   - LLM_PROVIDER_MODE 起動時 fail-fast (`assertLLMRuntimeConfig()`、続 64 §2a 継承)
 *
 * vercel.json 設定 (Owner 投入予定):
 *   {
 *     "crons": [{
 *       "path": "/api/cron/daily-site-summary",
 *       "schedule": "0 17 * * *"  // 02:00 JST = 17:00 UTC
 *     }]
 *   }
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

export async function POST(request: Request): Promise<NextResponse> {
  // 0. LLM runtime config fail-fast (続 64 §2a 継承、production 起動時の二重防御)
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

  // 1. 認証 (続134: CRON_SECRET 設定時は secret 必須、spoofable な x-vercel-cron 単体を廃止)
  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED' } },
      { status: 401 },
    )
  }

  const t0 = Date.now()

  // 2. 全 site の summary 再生成
  // 大規模 tenant (>1000 site) では timeout 懸念。MVP は limit なし、observation 後に分散検討。
  const result = await regenerateAllDailySummaries({})

  const elapsedMs = Date.now() - t0

  return NextResponse.json({
    success: true,
    data: {
      generated: result.generated,
      failed: result.failed,
      elapsedMs,
    },
  })
}

/**
 * GET 経路は disabled (POST のみ受付、Vercel Cron は POST で呼ぶ)。
 * 万一 GET で呼ばれたら 405。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } },
    { status: 405 },
  )
}
