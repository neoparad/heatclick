import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, verifySiteAccess } from '@/lib/api-utils'
import { executeAxis, executeAllAxes, analysisAxes } from '@/lib/analysis-axes'

// POST /api/v1/insights/{site_id}/multi — 複数軸一括実行
export async function POST(
  request: NextRequest,
  { params }: { params: { site_id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  const siteId = params.site_id

  try {
    const ch = await getClickHouseClientAsync()
    const { authorized } = await verifySiteAccess(request, siteId, ch)
    if (!authorized) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const requestedAxes: string[] | undefined = body.axes

    let results: Map<string, any>

    if (!requestedAxes || requestedAxes.length === 0) {
      // 全軸実行
      results = await executeAllAxes(ch, { site_id: siteId })
    } else {
      // 指定軸のみ実行
      results = new Map()
      for (const axisId of requestedAxes) {
        try {
          const result = await executeAxis(ch, axisId, { site_id: siteId })
          if (result && result.data.length > 0) {
            results.set(axisId, result)
          }
        } catch (e: any) {
          results.set(axisId, { error: e?.message })
        }
      }
    }

    const output: Record<string, any> = {}
    results.forEach((value, key) => {
      if (value.error) {
        output[key] = { error: value.error }
      } else {
        output[key] = {
          name: value.axis.name,
          category: value.axis.category,
          cost: value.axis.cost,
          data_count: value.data.length,
          data: value.data,
          ai_prompt_hint: value.axis.aiPromptHint,
        }
      }
    })

    return NextResponse.json({
      site_id: siteId,
      axes_executed: results.size,
      results: output,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Internal error' }, { status: 500 })
  }
}
