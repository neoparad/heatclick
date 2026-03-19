import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, verifySiteAccess, badRequest } from '@/lib/api-utils'
import { executeAxis, listAxes } from '@/lib/analysis-axes'

// GET /api/v1/insights/{site_id}/axis/{axis_id} — 単軸分析
export async function GET(
  request: NextRequest,
  { params }: { params: { site_id: string; axis_id: string } }
) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  const { site_id: siteId, axis_id: axisId } = params

  if (axisId === '_list') {
    return NextResponse.json({ axes: listAxes() })
  }

  try {
    const ch = await getClickHouseClientAsync()
    const { authorized } = await verifySiteAccess(request, siteId, ch)
    if (!authorized) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

    const result = await executeAxis(ch, axisId, { site_id: siteId })
    if (!result) return badRequest(`Unknown axis: ${axisId}. Use /axis/_list to see available axes.`)

    return NextResponse.json({
      axis: {
        id: result.axis.id,
        name: result.axis.name,
        category: result.axis.category,
        cost: result.axis.cost,
      },
      data: result.data,
      count: result.data.length,
      ai_prompt_hint: result.axis.aiPromptHint,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Internal error' }, { status: 500 })
  }
}
