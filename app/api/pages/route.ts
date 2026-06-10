/**
 * GET /api/pages?site_id=<tracking_id>
 *
 * 親 SSOT §3.6.5 / Infra 続 56 (Sprint 3 W1 ヒートマップ本接続)
 *
 * 概要:
 *   ヒートマップ画面のページセレクタに表示する候補 URL を返す。
 *   過去 7 日間で `clickinsight.events` に記録のあるページを、event 件数 DESC で最大 50 件。
 *
 * tenant isolation (§3.8.1):
 *   - middleware が JWT 検証 + site_id ⊆ tenant.site_ids を強制 (403 拒否)
 *   - 本 route は middleware が注入する x-tenant-id / x-site-ids ヘッダを信頼
 *   - ClickHouse query は必ず `WHERE tenant_id = {tenant_id:String}` 強制 (buildTenantQuery)
 *
 * rate limit:
 *   - middleware は plan tier 別 RPS を持つが、本 endpoint は「ヒートマップ画面遷移ごとに 1 回」
 *     のみ呼ぶ想定なので追加 throttling は plan 別 free=10/min で十分。
 *
 * caching:
 *   - page list は 5 分 stale-while-revalidate (`unstable_cache`)
 *   - tenant_id + site_id + limit でキー化、cross-tenant 漏洩なし
 *
 * Response shape (typescript/patterns.md ApiResponse<T>):
 *   { success: true, data: Array<{ url: string; label: string }> }
 *   { success: false, error: string }
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { fetchPagesCached } from '@/lib/pages/fetch-pages'
import { requireTenantContext, canAccessSite } from '@/lib/tenant'
import { checkRateLimit } from '@/lib/rate-limit'
import type { Plan } from '@/lib/jwt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 続122: クエリ本体 (fetchPagesUncached/Cached/deriveLabelFromUrl) は
// lib/pages/fetch-pages.ts に抽出。(proof)/heatmap の Server Component が
// HTTP 自己 fetch せず直接呼べるようにするため (失敗バナー誤表示の根治)。

const QuerySchema = z.object({
  site_id: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export async function GET(request: Request): Promise<NextResponse> {
  // 1. tenant context — middleware が注入済、なければ 401
  //    (middleware で JWT verify 済なので、ここに来た時点で認証は通っている前提)
  let ctx
  try {
    ctx = await requireTenantContext()
  } catch {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 })
  }

  // 2. query parse
  const { searchParams } = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    site_id: searchParams.get('site_id') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'invalid request' },
      { status: 400 },
    )
  }

  // 3. site_id ⊆ tenant.site_ids 検証 (middleware で既に拒否されるが defense-in-depth)
  if (!canAccessSite(ctx, parsed.data.site_id)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  // 4. rate limit (tenant 単位、plan 別)
  const rl = await checkRateLimit(`pages:${ctx.tenant_id}`, ctx.plan as Plan)
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(rl.limit),
          'X-RateLimit-Remaining': String(rl.remaining),
          'X-RateLimit-Reset': String(rl.resetTime),
        },
      },
    )
  }

  // 5. fetch + cache (5 分 swr)
  try {
    const data = await fetchPagesCached(ctx.tenant_id, parsed.data.site_id, parsed.data.limit)
    return NextResponse.json({ success: true, data })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    // ClickHouse error 詳細は client に漏らさない (連結文字列が credentials を含む経路を遮断)
    console.error(`[api/pages] ClickHouse query failed: ${msg}`)

    // 続 76 Task D (Owner 2026-05-24 09:35 JST Vercel logs 502 多数):
    //   従来は generic 'upstream_error' のみ返却 → Owner / Director が原因切り分け不能。
    //   本続 76 で root cause hint を `code` field に分類して返す (msg そのものは含めない、
    //   credentials 流出回避)。client (heatmap page / install page) はこの code から
    //   actionable な UI を出せる。
    //   - 'ch_config'  → ClickHouse env 未投入 (Owner action: Vercel env 投入)
    //   - 'ch_schema'  → table 不在 (Infra action: migration 適用)
    //   - 'ch_network' → 接続拒否 / timeout (Infra action: network 設定確認)
    //   - 'ch_unknown' → その他 ClickHouse error (Director に Vercel logs + msg 共有)
    const lowerMsg = msg.toLowerCase()
    let code: 'ch_config' | 'ch_schema' | 'ch_network' | 'ch_unknown'
    if (
      lowerMsg.includes('clickhouse_url is required') ||
      lowerMsg.includes('clickhouse_password is required') ||
      lowerMsg.includes('clickhouse_ro_password')
    ) {
      code = 'ch_config'
    } else if (
      lowerMsg.includes("doesn't exist") ||
      lowerMsg.includes('does not exist') ||
      lowerMsg.includes('unknown table') ||
      lowerMsg.includes('code: 60')
    ) {
      code = 'ch_schema'
    } else if (
      lowerMsg.includes('econnrefused') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('network') ||
      lowerMsg.includes('fetch failed') ||
      lowerMsg.includes('socket')
    ) {
      code = 'ch_network'
    } else {
      code = 'ch_unknown'
    }
    return NextResponse.json(
      { success: false, error: 'upstream_error', code },
      { status: 502 },
    )
  }
}
