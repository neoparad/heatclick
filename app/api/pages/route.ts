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
import { unstable_cache } from 'next/cache'
import { z } from 'zod'

import { getClickHouseClient } from '@/lib/clickhouse'
import { requireTenantContext, canAccessSite } from '@/lib/tenant'
import { checkRateLimit } from '@/lib/rate-limit'
import type { Plan } from '@/lib/jwt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  site_id: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

interface PageRow {
  url: string
  events: number
}

interface PageOption {
  url: string
  label: string
}

/**
 * URL から人間可読ラベルを派生させる。
 *   '/'                    → 'トップ'
 *   '/column/acne/'        → 'column/acne'
 *   '/products/foo/bar/'   → 'foo/bar' (末尾 2 セグメント)
 *   parse 失敗時            → URL そのまま
 */
function deriveLabelFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    if (path === '/' || path === '') return 'トップ'
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) return 'トップ'
    return segments.slice(-2).join('/')
  } catch {
    return url
  }
}

/**
 * ClickHouse からページ候補を取得。tenant_id + site_id で絞り込み、過去 7 日間集計。
 *
 * 注: cache key は tenant_id + site_id + limit。tenant_id を必ず含めることで
 *     cache 経由の cross-tenant 漏洩を防ぐ (§3.8.1 multi-tenant isolation)。
 */
async function fetchPagesUncached(
  tenantId: string,
  siteId: string,
  limit: number,
): Promise<PageOption[]> {
  const ch = getClickHouseClient()
  // tenant_id parameter binding は必須 (§3.8.1)。文字列連結は禁止 (Codex Round 8 Fix 5)。
  const result = await ch.query({
    query: `
      SELECT url, count() AS events
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND timestamp >= now() - INTERVAL 7 DAY
        AND url != ''
      GROUP BY url
      ORDER BY events DESC
      LIMIT {limit:UInt32}
    `,
    query_params: {
      tenant_id: tenantId,
      site_id: siteId,
      limit,
    },
    format: 'JSONEachRow',
  })
  const rows = await result.json<PageRow>()
  return rows.map((r) => ({ url: r.url, label: deriveLabelFromUrl(r.url) }))
}

function fetchPagesCached(tenantId: string, siteId: string, limit: number): Promise<PageOption[]> {
  // unstable_cache の key は引数全体 + tags。tenant_id を tag 化しておけば将来 revalidateTag で
  // tenant 単位 cache 破棄が可能 (Phase 5 deletion request 対応)。
  const cached = unstable_cache(
    async () => fetchPagesUncached(tenantId, siteId, limit),
    ['api-pages', tenantId, siteId, String(limit)],
    {
      revalidate: 300, // 5 分 stale-while-revalidate
      tags: [`tenant:${tenantId}`, `pages:${tenantId}:${siteId}`],
    },
  )
  return cached()
}

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
