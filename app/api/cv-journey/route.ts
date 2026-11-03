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
 *
 * 期間: 日付未指定の境界は resolvePeriod (lib/cv-journey/period.ts) で確定させ、
 * クエリ条件と meta.periodDays を常に一致させる（旧実装は未指定時に全履歴を集計
 * しながら periodDays=7 を返す不一致があった）。
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getServerSession } from '@/lib/auth/server-session'
import { getClickHouseClient } from '@/lib/clickhouse'
import { createCvDefinitionRepository } from '@/lib/conversions/repository'
import { DEFAULT_FUNNEL } from '@/lib/cv-journey/funnel-config'
import { resolvePeriod } from '@/lib/cv-journey/period'
import { buildFunnelData } from '@/lib/cv-journey/query'
import { buildDummyData } from '@/lib/cv-journey/fixtures'
import { recordDummyFallback } from '@/lib/monitoring/dummy-fallback-counter'
import type { CvJourneyError, CvJourneySuccess } from '@/lib/api/cv-journey'

/**
 * C2 (docs/cv/CV_DEFINITIONS_DESIGN.md §7): サイトの有効なCV定義を取得する。
 * CV定義は Cloudflare KV (ClickHouseとは別インフラ) に保存されており、その障害で
 * cv-journey 全体 (既存のCH失敗ダミーフォールバックとは別経路) を巻き込まないよう、
 * 取得失敗はログのみで空配列にfallbackする (完全後方互換の生conversion_type判定になる)。
 */
async function fetchEnabledCvDefinitions(tenantId: string, siteId: string) {
  try {
    const repo = createCvDefinitionRepository()
    const all = await repo.listCvDefinitions(tenantId, siteId)
    return all.filter((d) => d.enabled).map((d) => ({ cvKey: d.cvKey, trigger: d.trigger, scope: d.scope }))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error(`[cv-journey] cv definitions fetch failed, falling back to raw conversion_type: ${msg}`)
    return []
  }
}

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

  // 期間の正規化: 未指定境界を確定させ、クエリと meta.periodDays を一致させる
  const period = resolvePeriod(q.start_date, q.end_date)

  // 強制ダミー
  if (process.env.CV_JOURNEY_DUMMY_ONLY === '1') {
    return NextResponse.json<CvJourneySuccess>({
      success: true,
      data: buildDummyData(DEFAULT_FUNNEL),
      meta: { dataSource: 'dummy', windowSec: DEFAULT_FUNNEL.windowSec, periodDays: period.days, warnings: [] },
    })
  }

  try {
    const client = getClickHouseClient('analytics_reader')
    const cvDefinitions = await fetchEnabledCvDefinitions(session.tenant_id, q.site_id)
    const { data, warnings } = await buildFunnelData({
      client,
      tenantId: session.tenant_id,
      siteId: q.site_id,
      startDate: period.startDate,
      endDate: period.endDate,
      deviceType: q.device_type,
      source: q.source,
      config: DEFAULT_FUNNEL,
      cvDefinitions,
    })

    return NextResponse.json<CvJourneySuccess>({
      success: true,
      data,
      meta: { dataSource: 'clickhouse_events', windowSec: DEFAULT_FUNNEL.windowSec, periodDays: period.days, warnings },
    })
  } catch (e: unknown) {
    // ClickHouse 接続不可 / 列不在 / timeout → ダミーにフォールバック（heatmap と同思想）
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error(`[cv-journey] query failed, falling back to dummy: ${msg}`)
    await recordDummyFallback('cv-journey')
    return NextResponse.json<CvJourneySuccess>({
      success: true,
      data: buildDummyData(DEFAULT_FUNNEL),
      meta: {
        dataSource: 'dummy',
        windowSec: DEFAULT_FUNNEL.windowSec,
        periodDays: period.days,
        warnings: ['ClickHouse 接続不可のためダミーデータを表示しています'],
      },
    })
  }
}
