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
import {
  getHeatmapUnderlayWithR2Cache,
  lookupHeatmapUnderlayCacheOnly,
} from '@/lib/heatmap/r2-screenshot-cache'
import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'
import {
  ScreenshotProviderError,
  validateExternalUrl,
  validateExternalUrlResolved,
} from '@/lib/heatmap/screenshot-provider'
import { createRouteTimer, type RouteTimer } from '@/lib/perf/server-timing'
import { resolveTenantSite } from '@/lib/sites/site-registry'
import { normalizeHost } from '@/lib/url/normalize-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// コールド capture が platform 既定 timeout で 504 になるのを防ぐ。
// provider 側 timeout (60s) より長くし、route 側が制御された応答を返せるようにする。
export const maxDuration = 90

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  page_url: z.string().url().max(2000),
  device: z.enum(['pc', 'sp', 'tab']).default('pc'),
  cache_only: z.enum(['0', '1', 'true', 'false']).optional(),
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
})

function tenantHasSite(headerSiteIds: string | null, siteId: string): boolean {
  if (!headerSiteIds) return false
  return headerSiteIds.split(',').map((s) => s.trim()).includes(siteId)
}

/**
 * 正規化ホスト (`www.` 除去・小文字) を抽出する。
 */
function extractCanonicalHost(rawUrlOrHost: string | null | undefined): string | null {
  return normalizeHost(rawUrlOrHost)
}

/**
 * 対象ホストが登録サイトホストと一致 (またはサブドメイン一致) するか検証する。
 */
function isTargetHostMatchedWithSite(targetHost: string | null, siteHost: string | null): boolean {
  if (!targetHost || !siteHost) return false
  return targetHost === siteHost || targetHost.endsWith('.' + siteHost)
}

/**
 * テナントのサイト所有権および clickinsight.sites (または FusionSiteRecord) の登録 URL ホストを取得する。
 */
async function tenantVerifySiteAccess(
  tenantId: string,
  siteId: string,
  sessionSiteIds: string | null,
  perfReqId?: string,
): Promise<{ allowed: boolean; registeredHost: string | null }> {
  if (!tenantId || tenantId.trim() === '' || !tenantHasSite(sessionSiteIds, siteId)) {
    return { allowed: false, registeredHost: null }
  }

  // 1) Control Plane Site Registry (dogfood / Postgres tenant_sites) から canonicalHost を確認
  try {
    const siteRecord = await resolveTenantSite(tenantId, siteId)
    if (siteRecord) {
      const regHost = extractCanonicalHost(siteRecord.canonicalHost ?? siteRecord.siteUrl)
      if (regHost) {
        return { allowed: true, registeredHost: regHost }
      }
    }
  } catch {
    // fall through to ClickHouse sites lookup
  }

  // 2) ClickHouse clickinsight.sites テーブルから登録 url を確認
  try {
    const ch = getClickHouseClient('analytics_reader')
    const rs = await ch.query({
      query: `
        SELECT tenant_id, url
        FROM clickinsight.sites
        WHERE tenant_id = {tenant_id:String} AND tracking_id = {site_id:String}
        LIMIT 1
      `,
      query_params: { tenant_id: tenantId, site_id: siteId },
      format: 'JSONEachRow',
      ...(perfReqId
        ? { clickhouse_settings: perfLogComment('heatmap-screenshot', 'own-site', perfReqId) }
        : {}),
    })
    const rows = (await rs.json()) as Array<{ tenant_id?: string; url?: string }>
    const row = rows[0]
    if (row) {
      if (row.tenant_id && row.tenant_id !== tenantId) {
        return { allowed: false, registeredHost: null }
      }
      return { allowed: true, registeredHost: extractCanonicalHost(row.url) }
    }
  } catch {
    // ClickHouse sites lookup error: session.user.site_ids で既に所有権確認済みのため続行し、
    // registeredHost=null として後段の tenantTracksUrl フォールバックに委ねる
  }

  return { allowed: true, registeredHost: null }
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
  /** P0 計測: CH query_log 突合用 (route/reqId が揃った時のみ log_comment を付与) */
  perfReqId?: string
}): Promise<boolean> {
  const ch = getClickHouseClient('analytics_reader')
  const rs = await ch.query({
    query: `
      SELECT 1 AS hit
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND ${canonicalUrlSql('url')} = {page_url:String}
        AND timestamp >= now() - INTERVAL 30 DAY
      LIMIT 1
    `,
    query_params: {
      tenant_id: input.tenantId,
      site_id: input.siteId,
      page_url: input.pageUrl,
    },
    format: 'JSONEachRow',
    ...(input.perfReqId
      ? { clickhouse_settings: perfLogComment('heatmap-screenshot', 'own-ch', input.perfReqId) }
      : {}),
  })
  const rows = (await rs.json()) as Array<{ hit: number }>
  return rows.length > 0
}

// ── P0 計測 (docs/heatmap/SONNET_PROMPT_P0_instrumentation_2026-07-19.md §3) ──
// 挙動変更ゼロ (絶対条件1): 以下 helper は計測専用でレスポンス body/status を変えない。

/** CH query_log 突合用 log_comment。URL・tenant 値は含めない (絶対条件5)。 */
function perfLogComment(route: string, span: string, reqId: string): { log_comment: string } {
  try {
    return { log_comment: JSON.stringify({ app: 'heatmap', route, span, req: reqId }) }
  } catch {
    return { log_comment: '' }
  }
}

/** 既存の NextResponse.json 呼び出しに Server-Timing ヘッダ + 計測ログを足すだけの薄いラッパ。 */
function jsonWithTiming(
  t: RouteTimer,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  // eslint-disable-next-line no-console
  console.info(t.logLine())
  return NextResponse.json(body, {
    ...init,
    headers: { ...(init.headers ?? {}), 'Server-Timing': t.headerValue() },
  })
}

export async function GET(request: Request) {
  // P0 計測: レスポンス内容・ステータスには影響しない (絶対条件1)。
  const t = createRouteTimer('heatmap-screenshot')
  const reqId = t.reqId()
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    site_id: url.searchParams.get('site_id') ?? undefined,
    page_url: url.searchParams.get('page_url') ?? undefined,
    device: url.searchParams.get('device') ?? undefined,
    cache_only: url.searchParams.get('cache_only') ?? undefined,
    refresh: url.searchParams.get('refresh') ?? undefined,
  })
  if (!parsed.success) {
    return jsonWithTiming(
      t,
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
  const isCacheOnly = params.cache_only === '1' || params.cache_only === 'true'
  const isForceRefresh = params.refresh === '1' || params.refresh === 'true'

  // tenant 検証 — REQ-SEC-126 (§13.7): getServerSession 経由で Layer 2 失効照合を通す
  const session = await t.span('auth', async () => getServerSession())
  const tenantId = session?.tenant_id ?? null
  const siteIds = session ? session.user.site_ids.join(',') : null
  if (!tenantId) {
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'UNAUTHORIZED', message: 'tenant context missing' } },
      { status: 401 },
    )
  }

  // SSRF guard (before any network egress)
  let canonicalUrl: string
  try {
    validateExternalUrl(params.page_url)
    // CRITICAL: cache key と ownership lookup の両方で **同一の canonical 文字列**を使う。
    // 続135: tile/elements/page-stats と同一規則 (canonicalizeHeatmapUrl = query/fragment 除去) に統一。
    canonicalUrl = canonicalizeHeatmapUrl(params.page_url)
  } catch (err) {
    if (err instanceof ScreenshotProviderError) {
      return jsonWithTiming(
        t,
        { success: false, error: { code: err.code, message: err.message } },
        { status: err.code === 'BLOCKED_URL' ? 403 : 400 },
      )
    }
    throw err
  }

  // 1) テナントのサイト所有権を確認
  const siteAccess = await t.span('own-site', async () =>
    tenantVerifySiteAccess(tenantId, params.site_id, siteIds, reqId),
  )
  if (!siteAccess.allowed) {
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'TENANT_FORBIDDEN', message: 'site not in tenant' } },
      { status: 403 },
    )
  }

  // 2) 登録サイトホスト (canonicalHost / clickinsight.sites.url) がある場合は、
  //    キャッシュ確認より前にホスト一致 (サブドメイン含む) を検証し、無関係な第三者サイトを即座に 403 拒否する。
  const targetHost = extractCanonicalHost(canonicalUrl)
  if (siteAccess.registeredHost) {
    if (!isTargetHostMatchedWithSite(targetHost, siteAccess.registeredHost)) {
      return jsonWithTiming(
        t,
        {
          success: false,
          error: {
            code: 'URL_NOT_OWNED',
            message: `page_url host (${targetHost ?? 'unknown'}) does not match registered site host (${siteAccess.registeredHost})`,
          },
        },
        { status: 403 },
      )
    }
  }

  // 3) refresh=1 でない限り、ClickHouse の重い 30 日イベントスキャンより先に L1/R2 キャッシュヒット判定を実行
  //    (キャッシュキー自体が tenantId + siteId スコープを持ち、ドメイン検証も通過済みのため安全)
  if (!isForceRefresh) {
    const cachedHit = await t.span('cache-pre', async () =>
      lookupHeatmapUnderlayCacheOnly({
        tenantId,
        siteId: params.site_id,
        pageUrl: canonicalUrl,
        device: params.device,
      }),
    )
    if (cachedHit) {
      t.mark('tier', cachedHit.tier)
      return jsonWithTiming(
        t,
        { success: true, data: cachedHit.capture },
        { headers: { 'Cache-Control': 'private, max-age=240' } },
      )
    }
  }

  // 4) cache_only=1 のときはキャッシュミス時に新規撮影を行わず即座に 204 No Content を返す
  //    (バックグラウンド先読みで Cloudflare Browser Rendering 429 自爆 & Microlink 汚染を防止)
  if (isCacheOnly) {
    t.mark('tier', 'cache-miss-skip')
    // eslint-disable-next-line no-console
    console.info(t.logLine())
    return new NextResponse(null, {
      status: 204,
      headers: { 'Server-Timing': t.headerValue() },
    })
  }

  // 5) キャッシュミス時 (新規撮影時) の URL 所有権検証フォールバック:
  //    登録サイトホストが存在しない場合のみ tenantTracksUrl() (ClickHouse 30日イベントスキャン) で確認。
  if (!siteAccess.registeredHost) {
    try {
      const owns = await t.span('own-ch', async () =>
        tenantTracksUrl({
          tenantId,
          siteId: params.site_id,
          pageUrl: canonicalUrl,
          perfReqId: reqId,
        }),
      )
      if (!owns) {
        return jsonWithTiming(
          t,
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
      // CH 不可達はフェイル open せず 503 を返し、Frontend は fallback (Mock underlay) を表示する。
      console.error('[heatmap/screenshot] tenant ownership check failed:', err)
      return jsonWithTiming(
        t,
        {
          success: false,
          error: { code: 'OWNERSHIP_CHECK_UNAVAILABLE', message: 'analytics lookup failed' },
        },
        { status: 503 },
      )
    }
  }

  // 5) 新規撮影前の DNS Rebinding SSRF 防御 (解決された全 IPv4/IPv6 がプライベート/メタデータ IP でないか検証)
  try {
    await t.span('ssrf-dns', async () => validateExternalUrlResolved(canonicalUrl))
  } catch (err) {
    if (err instanceof ScreenshotProviderError) {
      return jsonWithTiming(
        t,
        { success: false, error: { code: err.code, message: err.message } },
        { status: err.code === 'BLOCKED_URL' ? 403 : 400 },
      )
    }
    throw err
  }

  // 6) Provider 呼び出し (capture → R2 PUT + L1 hydrate)
  try {
    const { capture, tier } = await t.span('cache', async () =>
      getHeatmapUnderlayWithR2Cache({
        tenantId,
        siteId: params.site_id,
        pageUrl: canonicalUrl,
        device: params.device,
        forceRefresh: isForceRefresh,
      }),
    )
    t.mark('tier', tier)
    return jsonWithTiming(
      t,
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
      return jsonWithTiming(
        t,
        { success: false, error: { code: err.code, message: err.message } },
        { status },
      )
    }
    console.error('[heatmap/screenshot] unknown error:', err)
    return jsonWithTiming(
      t,
      { success: false, error: { code: 'INTERNAL', message: 'screenshot pipeline failed' } },
      { status: 502 },
    )
  }
}
