/**
 * POST /api/cron/fusion-ingest — UGOKI Crawl 融合エクスポートの定期取り込み (経路B)
 *
 * FUSION_INGEST_TARGETS の各サイトについて UGOKI Crawl /v1/fusion/export を pull → 検証 →
 * ClickHouse 融合5表へ INSERT。日次想定 (クロールは48h、突合は最新クロールを反映)。
 *
 * 認証: x-vercel-cron:1 または x-cron-secret。書込は chat_writer (Infra grant 要)。
 */

import { NextResponse } from 'next/server'

import { runFusionIngest } from '@/lib/fusion/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(request: Request): boolean {
  if (request.headers.get('x-vercel-cron') === '1') return true
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
    const results = await runFusionIngest()
    const ok = results.filter((r) => r.ok).length
    return NextResponse.json({
      success: true,
      data: { targets: results.length, ok, failed: results.length - ok, results, elapsedMs: Date.now() - t0 },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[cron/fusion-ingest] failed: ${msg}`)
    return NextResponse.json({ success: false, error: { code: 'INGEST_FAILED' } }, { status: 500 })
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } },
    { status: 405 },
  )
}
