/**
 * GET /api/cv-journey — CV経路分析（固定列ファネル + 流入メディア step0 + 摩擦）
 *
 * 親 SSOT §3.6.5 / §3.8.1 / docs/cv-journey-implementation-plan.md
 *
 * 認可（heatmap route と同方式・canonical）:
 *   - getServerSession() で JWT 検証
 *   - session.user.site_ids に site_id が含まれるか（cross-tenant 拒否）→ TENANT_FORBIDDEN
 *   - 全クエリで tenant_id を binding（§3.8.1）
 *
 * フォールバック（heatmap と同思想）:
 *   - ClickHouse 失敗 / 接続不可 → ダミーデータ（meta.dataSource='dummy'）
 *   - env CV_JOURNEY_DUMMY_ONLY='1' で常時ダミー
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { DEFAULT_FUNNEL } from '@/lib/cv-journey/funnel-config'
import { buildFunnelData } from '@/lib/cv-journey/query'
import { buildDummyData } from '@/lib/cv-journey/fixtures'
import type { CvJourneyError, CvJourneySuccess } from '@/lib/api/cv-journey'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const querySchema = z.object({
  site_id: z.string().min(1).max(128),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.string().max(200).optional(),
})

function errorResponse(code: CvJourneyError['error']['code'], message: string, status: number) {
  return NextResponse.json<CvJourneyError>({ success: false, error: { code, message } }, { status })
}

function periodDays(start?: string, end?: string): number {
  if (!start || !end) return 7
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (Number.isNaN(s) || Number.isNaN(e)) return 7
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1)
}

export async function GET(request: Request) {
  // 認証
  const session = await getServerSession()
  if (!session) return errorResponse('UNAUTHORIZED', 'Authentication required', 401)

  // 入力検証
  const { searchParams } = new URL(request.url)
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams.entries()))
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query', 400)
  }
  const q = parsed.data

  // tenant isolation: site_ids 包含チェック
  if (!session.user.site_ids.includes(q.site_id)) {
    return errorResponse('TENANT_FORBIDDEN', 'Access denied to this site', 403)
  }

  const days = periodDays(q.start_date, q.end_date)

  // 強制ダミー
  if (process.env.CV_JOURNEY_DUMMY_ONLY === '1') {
    return NextResponse.json<CvJourneySuccess>({
      success: true,
      data: buildDummyData(DEFAULT_FUNNEL),
      meta: { dataSource: 'dummy', windowSec: DEFAULT_FUNNEL.windowSec, periodDays: days, warnings: [] },
    })
  }

  try {
    const client = getClickHouseClient('analytics_reader')
    const { data, warnings } = await buildFunnelData({
      client,
      tenantId: session.tenant_id,
      siteId: q.site_id,
      startDate: q.start_date,
      endDate: q.end_date,
      deviceType: q.device_type,
      source: q.source,
      config: DEFAULT_FUNNEL,
    })

    return NextResponse.json<CvJourneySuccess>({
      success: true,
      data,
      meta: { dataSource: 'clickhouse_events', windowSec: DEFAULT_FUNNEL.windowSec, periodDays: days, warnings },
    })
  } catch (e: unknown) {
    // ClickHouse 接続不可 / 列不在 / timeout → ダミーにフォールバック（heatmap と同思想）
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error(`[cv-journey] query failed, falling back to dummy: ${msg}`)
    return NextResponse.json<CvJourneySuccess>({
      success: true,
      data: buildDummyData(DEFAULT_FUNNEL),
      meta: {
        dataSource: 'dummy',
        windowSec: DEFAULT_FUNNEL.windowSec,
        periodDays: days,
        warnings: ['ClickHouse 接続不可のためダミーデータを表示しています'],
      },
    })
  }
}
