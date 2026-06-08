/**
 * GET /api/heatmap/screenshot — page screenshot meta (Phase 2 underlay)
 *
 * 親 SSOT §3.6.5 / §3.8.1 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap screenshot underlay
 *   (handoff: `2026-05-29-frontend-heatmap-screenshot-underlay.md`)
 *
 * 役割:
 *   - tenant が「自分の tracking が観測された URL」のみ screenshot を取得できる
 *     (tenant_id + site_id + url 一致を ClickHouse で照合、cross-tenant fetch を防ぐ)
 *   - SSRF guard: http/https only、private / loopback / link-local IP 拒否
 *   - Microlink (server-side) で screenshot 取得、in-memory cache (1h / 60 entries)
 *
 * §1.7 Anti-Features: 静的 screenshot のみ取得 (DOM 再現 / session 録画なし)。
 *
 * NOTE: middleware が `x-tenant-id` / `x-site-ids` を inject 済前提 (`api-tenant` region)。
 *
 * 既知の制約 (Codex T2 review HIGH H-1、Phase 2.5 で fix 予定):
 *   - DNS rebinding: 本層の SSRF guard は request 時点での URL host を検証する。
 *     Microlink fetch は数秒後に行われ、その時点での DNS 解決は provider 側。
 *     mitigation: Microlink は documented で private network blocking を提供している
 *     (https://microlink.io/docs)。本層は加えて exact `url` match で tenant ownership を要求。
 *   - 「site の権威 hostname allowlist」は現状未配備 (sites table の verified_hostnames 列
 *     が tenant onboarding flow で配備されたら、page_url.hostname を強制照合する)。
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'

import { getClickHouseClient } from '@/lib/clickhouse'
import { getHeatmapUnderlayWithR2Cache } from '@/lib/heatmap/r2-screenshot-cache'
import {
  canonicalizePageUrl,
  ScreenshotProviderError,
  validateExternalUrl,
} from '@/lib/heatmap/screenshot-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// コールド capture が platform 既定 timeout で 504 になるのを防ぐ。
// provider 側 timeout (60s) より長くし、route 側が制御された応答を返せるようにする。
export const maxDuration = 90

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  page_url: z.string().url().max(2000),
  device: z.enum(['pc', 'sp', 'tab']).default('pc'),
})

function tenantHasSite(headerSiteIds: string | null, siteId: string): boolean {
  if (!headerSiteIds) return false
  return headerSiteIds.split(',').map((s) => s.trim()).includes(siteId)
}

/**
 * tenant_id + site_id + url の組合せで ClickHouse `events` に過去 30 日間で
 * 1 行でも tracking 履歴があるか照合。
 * 0 行 = この tenant はこの URL を tracking していない = 403 (cross-tenant fetch 防止)。
 */
async function tenantTracksUrl(input: {
  tenantId: string
  siteId: string
  pageUrl: string
}): Promise<boolean> {
  const ch = getClickHouseClient('analytics_reader')
  const rs = await ch.query({
    query: `
      SELECT 1 AS hit
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND url = {page_url:String}
        AND timestamp >= now() - INTERVAL 30 DAY
      LIMIT 1
    `,
    query_params: {
      tenant_id: input.tenantId,
      site_id: input.siteId,
      page_url: input.pageUrl,
    },
    format: 'JSONEachRow',
  })
  const rows = (await rs.json()) as Array<{ hit: number }>
  return rows.length > 0
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    site_id: url.searchParams.get('site_id') ?? undefined,
    page_url: url.searchParams.get('page_url') ?? undefined,
    device: url.searchParams.get('device') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: parsed.error.issues[0]?.message ?? 'invalid request',
        },
      },
      { status: 400 },
    )
  }
  const params = parsed.data

  // tenant 検証 — REQ-SEC-126 (§13.7): getServerSession 経由で Layer 2 失効照合を通す
  const session = await getServerSession()
  const tenantId = session?.tenant_id ?? null
  const siteIds = session ? session.user.site_ids.join(',') : null
  if (!tenantId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }
  if (!tenantHasSite(siteIds, params.site_id)) {
    return NextResponse.json(
      { success: false, error: { code: 'TENANT_FORBIDDEN', message: 'site not in tenant' } },
      { status: 403 },
    )
  }

  // SSRF guard (before any network egress)
  let canonicalUrl: string
  try {
    validateExternalUrl(params.page_url)
    // CRITICAL: cache key と ownership lookup の両方で **同一の canonical 文字列**を使う。
    // 1 箇所で正準化し、以降 canonicalUrl を一貫して渡すことで両者が乖離しないことを保証する。
    canonicalUrl = canonicalizePageUrl(params.page_url)
  } catch (err) {
    if (err instanceof ScreenshotProviderError) {
      return NextResponse.json(
        { success: false, error: { code: err.code, message: err.message } },
        { status: err.code === 'BLOCKED_URL' ? 403 : 400 },
      )
    }
    throw err
  }

  // Tenant-owned URL check: 自分の tracking が無い URL の screenshot は撮らせない
  try {
    const owns = await tenantTracksUrl({
      tenantId,
      siteId: params.site_id,
      pageUrl: canonicalUrl,
    })
    if (!owns) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'URL_NOT_OWNED',
            message: 'page_url not observed for this tenant/site in the last 30 days',
          },
        },
        { status: 403 },
      )
    }
  } catch (err) {
    // CH 不可達は **拒否** ではなく **不確実だが SSRF guard 通過したのでフェイル open しない**。
    // 確実にユーザー操作を止めるため 503 を返し、Frontend は fallback (Mock underlay) を表示する。
    console.error('[heatmap/screenshot] tenant ownership check failed:', err)
    return NextResponse.json(
      {
        success: false,
        error: { code: 'OWNERSHIP_CHECK_UNAVAILABLE', message: 'analytics lookup failed' },
      },
      { status: 503 },
    )
  }

  // Provider 呼び出し (L1 in-memory → R2 L2 → capture、TTL/SWR/dedupe は cache 層が担う)
  try {
    const { capture } = await getHeatmapUnderlayWithR2Cache({
      tenantId,
      siteId: params.site_id,
      pageUrl: canonicalUrl,
      device: params.device,
    })
    return NextResponse.json(
      { success: true, data: capture },
      {
        // capture.imageUrl は 5min の署名URL。warm 再ナビで function + ClickHouse を
        // 再実行しないよう、署名寿命より短い max-age でブラウザにのみ (private) キャッシュ。
        // SWR は付けない (失効した署名URL を配らないため)。
        headers: { 'Cache-Control': 'private, max-age=240' },
      },
    )
  } catch (err) {
    if (err instanceof ScreenshotProviderError) {
      const status =
        err.code === 'PROVIDER_RATE_LIMITED'
          ? 429
          : err.code === 'PROVIDER_TIMEOUT'
            ? 504
            : err.code === 'BLOCKED_URL'
              ? 403
              : err.code === 'INVALID_URL'
                ? 400
                : 502
      return NextResponse.json(
        { success: false, error: { code: err.code, message: err.message } },
        { status },
      )
    }
    console.error('[heatmap/screenshot] unknown error:', err)
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: 'screenshot pipeline failed' } },
      { status: 502 },
    )
  }
}
