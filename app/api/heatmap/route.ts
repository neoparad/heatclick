/**
 * GET /api/heatmap — Sprint 1 dummy stub (Infrastructure Engineer S1-04 で本実装に置換)
 *
 * 親 SSOT §3.6.5 / Infra heatmap-pagination.md §2 / §3
 *
 * Sprint 1 用途:
 *   - Frontend P-04 のローカル / Preview deploy で UI が動作するための最小実装
 *   - tile pagination (cursor) 規約だけ守って、データは決定論的ダミー
 *   - tenant_id 検証等の認可は本実装で Infra が strict 化
 *
 * 本実装は Infra `heatmap-pagination.md` §3-4 (ClickHouse query + middleware 認可) に
 * 沿って Sprint 1 W2 で置換される予定。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { headers } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * B-4 fix (Reviewer T1 dual 続 10):
 * cursor query_hash は **HMAC-SHA256 with server secret (env HEATMAP_CURSOR_SECRET)** で署名する。
 * 旧実装の決定論的ハッシュは攻撃者が再現可能で、y_start 改ざんによる任意範囲 fetch / DoS の
 * 余地があった。Infra S1-04 本実装でも同じ契約 (HMAC + server secret) を採用する。
 *
 * env が未設定の場合は起動時に throw — silent fail でセキュリティ降格を起こさない。
 */
function getCursorSecret(): string {
  const v = process.env.HEATMAP_CURSOR_SECRET
  if (!v || v.length < 16) {
    throw new Error(
      'HEATMAP_CURSOR_SECRET must be set (>=16 chars). See decisions.md B-4 fix (続 10).',
    )
  }
  return v
}

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  page_url: z.string().url().max(2000),
  heatmap_type: z.enum(['click', 'scroll', 'read']).default('click'),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tile_size: z.coerce.number().int().min(800).max(6000).default(2400),
  cursor: z.string().max(2000).optional(),
})

const PAGE_HEIGHT_ESTIMATE = 30_000

interface CursorPayload {
  y_start: number
  query_hash: string
  exp: number
}

function buildQueryHash(params: {
  site_id: string
  page_url: string
  heatmap_type: string
  tile_size: number
  device_type?: string
  start_date?: string
  end_date?: string
}): string {
  // B-4: HMAC-SHA256 with server secret。改ざんは secret なしには再生成不能。
  const raw = `${params.site_id}|${params.page_url}|${params.heatmap_type}|${params.device_type ?? ''}|${params.start_date ?? ''}|${params.end_date ?? ''}|${params.tile_size}`
  const hmac = createHmac('sha256', getCursorSecret()).update(raw).digest('hex')
  // 先頭 32 hex char (128bit) で衝突確率は無視可能、cursor 文字数も適度に抑制
  return hmac.slice(0, 32)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8')
    const parsed = JSON.parse(json)
    if (
      typeof parsed !== 'object' ||
      parsed == null ||
      typeof parsed.y_start !== 'number' ||
      typeof parsed.query_hash !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null
    }
    return parsed as CursorPayload
  } catch {
    return null
  }
}

/** decisions.md tenant 越境テスト用: site_id allowlist */
function tenantHasSite(headerSiteIds: string | null, siteId: string): boolean {
  if (!headerSiteIds) return false
  return headerSiteIds.split(',').map((s) => s.trim()).includes(siteId)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    site_id: url.searchParams.get('site_id') ?? undefined,
    page_url: url.searchParams.get('page_url') ?? undefined,
    heatmap_type: url.searchParams.get('heatmap_type') ?? undefined,
    device_type: url.searchParams.get('device_type') ?? undefined,
    start_date: url.searchParams.get('start_date') ?? undefined,
    end_date: url.searchParams.get('end_date') ?? undefined,
    tile_size: url.searchParams.get('tile_size') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
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

  // tenant 検証 — middleware が x-tenant-id / x-site-ids を inject 済
  const h = await headers()
  const tenantId = h.get('x-tenant-id')
  const siteIds = h.get('x-site-ids')
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

  const queryHash = buildQueryHash(params)

  // cursor 検証
  let yStart = 0
  if (params.cursor) {
    const cur = decodeCursor(params.cursor)
    if (!cur) {
      return NextResponse.json(
        { success: false, error: { code: 'CURSOR_INVALID', message: 'cursor decode failed' } },
        { status: 400 },
      )
    }
    // 定数時間比較で query_hash 一致を検証 (timing attack 防御、B-4)
    if (!constantTimeEqual(cur.query_hash, queryHash)) {
      return NextResponse.json(
        { success: false, error: { code: 'CURSOR_INVALID', message: 'query condition changed' } },
        { status: 400 },
      )
    }
    if (cur.exp < Date.now() / 1000) {
      return NextResponse.json(
        { success: false, error: { code: 'CURSOR_INVALID', message: 'cursor expired' } },
        { status: 400 },
      )
    }
    yStart = cur.y_start
  }

  const tileEnd = Math.min(yStart + params.tile_size, PAGE_HEIGHT_ESTIMATE + params.tile_size)
  const isLast = tileEnd >= PAGE_HEIGHT_ESTIMATE

  // 決定論的ダミー hotspot 生成 (LCG)
  const points = generateDummyPoints(params.site_id, params.page_url, yStart, tileEnd, params.heatmap_type)

  const tile = {
    y_start: yStart,
    y_end: tileEnd,
    points,
    truncated: false,
  }

  const next_cursor = isLast
    ? null
    : encodeCursor({
        y_start: tileEnd,
        query_hash: queryHash,
        exp: Math.floor(Date.now() / 1000) + 600,
      })

  return NextResponse.json({
    success: true,
    data: {
      tiles: [tile],
      next_cursor,
    },
    meta: {
      tile_size: params.tile_size,
      page_height_estimate: PAGE_HEIGHT_ESTIMATE,
      cached: false,
      cache_ttl_sec: 7200,
      query_hash: queryHash,
    },
  })
}

function generateDummyPoints(
  siteId: string,
  pageUrl: string,
  yStart: number,
  yEnd: number,
  layer: string,
): Array<{ x: number; y: number; count: number; sessions: number }> {
  let seed = 0
  for (const s of [siteId, pageUrl, layer, String(yStart)].join('|')) {
    seed = (seed * 31 + s.charCodeAt(0)) | 0
  }
  function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  const tileHeight = yEnd - yStart
  // 20 - 40 hotspots per tile
  const count = 20 + Math.floor(rand() * 20)
  const points: Array<{ x: number; y: number; count: number; sessions: number }> = []
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand() * 1280)
    const y = yStart + Math.floor(rand() * tileHeight)
    const c = 3 + Math.floor(rand() * 60)
    points.push({ x, y, count: c, sessions: Math.max(1, Math.floor(c * 0.6)) })
  }
  return points
}
