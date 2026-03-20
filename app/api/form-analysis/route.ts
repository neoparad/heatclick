import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const pageUrl = searchParams.get('page_url')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')

    if (!siteId) {
      return badRequest('site_id is required')
    }

    const clickhouse = await getClickHouseClientAsync()

    // サイトアクセス権限チェック
    const { authorized } = await verifySiteAccess(request, siteId, clickhouse)
    if (!authorized) return forbidden('Access denied to this site')

    const params: Record<string, any> = { site_id: siteId }
    let dateFilter = ''
    if (startDate) {
      dateFilter += ' AND created_at >= {start_date:String}'
      params.start_date = startDate
    }
    if (endDate) {
      dateFilter += ' AND created_at <= {end_date:String}'
      params.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }
    let pageFilter = ''
    if (pageUrl) {
      pageFilter = ' AND page_url = {page_url:String}'
      params.page_url = pageUrl
    }

    // 3クエリを並列実行
    const [formsResult, fieldsResult, funnelResult] = await Promise.all([
      // 1. フォーム一覧 + 送信/離脱数
      clickhouse.query({
        query: `
          SELECT
            form_id,
            any(form_action) as form_action,
            any(page_url) as page_url,
            countIf(event_type = 'form_view') as views,
            uniqIf(session_id, event_type = 'form_field_focus') as started,
            countIf(event_type = 'form_submit') as submitted,
            countIf(event_type = 'form_abandon') as abandoned,
            maxIf(field_count, event_type = 'form_view') as field_count
          FROM clickinsight.form_interactions
          WHERE site_id = {site_id:String}
            ${dateFilter}
            ${pageFilter}
          GROUP BY form_id
          ORDER BY views DESC
          LIMIT 50
        `,
        query_params: params,
        format: 'JSONEachRow',
      }),

      // 2. フィールド別分析
      clickhouse.query({
        query: `
          SELECT
            form_id,
            field_name,
            field_type,
            count() as interactions,
            avg(field_duration_ms) as avg_duration_ms,
            max(field_duration_ms) as max_duration_ms,
            countIf(field_filled = 1) as filled_count,
            countIf(field_filled = 0) as unfilled_count,
            uniq(session_id) as unique_sessions
          FROM clickinsight.form_interactions
          WHERE site_id = {site_id:String}
            AND event_type = 'form_field_blur'
            AND field_name != ''
            ${dateFilter}
            ${pageFilter}
          GROUP BY form_id, field_name, field_type
          ORDER BY form_id, interactions DESC
        `,
        query_params: params,
        format: 'JSONEachRow',
      }),

      // 3. 離脱ポイント（最後に触れたフィールド）
      clickhouse.query({
        query: `
          SELECT
            form_id,
            last_field,
            count() as abandon_count
          FROM clickinsight.form_interactions
          WHERE site_id = {site_id:String}
            AND event_type = 'form_abandon'
            AND last_field != ''
            ${dateFilter}
            ${pageFilter}
          GROUP BY form_id, last_field
          ORDER BY abandon_count DESC
        `,
        query_params: params,
        format: 'JSONEachRow',
      }),
    ])

    const forms = await formsResult.json() as Record<string, string | number>[]
    const fields = await fieldsResult.json() as Record<string, string | number>[]
    const abandonPoints = await funnelResult.json() as Record<string, string | number>[]

    // フォームごとにフィールドデータと離脱ポイントをグループ化
    const formMap: Record<string, any> = {}
    for (const form of forms) {
      const views = Number(form.views) || 0
      const started = Number(form.started) || 0
      const submitted = Number(form.submitted) || 0
      const abandoned = Number(form.abandoned) || 0

      formMap[form.form_id] = {
        form_id: form.form_id,
        form_action: form.form_action || '',
        page_url: form.page_url || '',
        field_count: Number(form.field_count) || 0,
        views,
        started,
        submitted,
        abandoned,
        completion_rate: started > 0 ? Math.round((submitted / started) * 1000) / 10 : 0,
        abandon_rate: started > 0 ? Math.round((abandoned / started) * 1000) / 10 : 0,
        fields: [] as Record<string, string | number>[],
        abandon_points: [] as Record<string, string | number>[],
      }
    }

    // フィールドデータをフォームに紐付け
    for (const field of fields) {
      if (!formMap[field.form_id]) continue
      const interactions = Number(field.interactions) || 0
      const filledCount = Number(field.filled_count) || 0
      const unfilledCount = Number(field.unfilled_count) || 0

      formMap[field.form_id].fields.push({
        field_name: field.field_name,
        field_type: field.field_type,
        interactions,
        avg_duration_ms: Math.round(Number(field.avg_duration_ms) || 0),
        max_duration_ms: Number(field.max_duration_ms) || 0,
        filled_rate: interactions > 0 ? Math.round((filledCount / interactions) * 1000) / 10 : 0,
        unfilled_count: unfilledCount,
        unique_sessions: Number(field.unique_sessions) || 0,
      })
    }

    // 離脱ポイントをフォームに紐付け
    for (const point of abandonPoints) {
      if (!formMap[point.form_id]) continue
      formMap[point.form_id].abandon_points.push({
        field_name: point.last_field,
        abandon_count: Number(point.abandon_count) || 0,
      })
    }

    const formList = Object.values(formMap)

    // サマリー
    const totalForms = formList.length
    const totalViews = formList.reduce((s, f) => s + f.views, 0)
    const totalSubmitted = formList.reduce((s, f) => s + f.submitted, 0)
    const totalAbandoned = formList.reduce((s, f) => s + f.abandoned, 0)
    const avgCompletionRate = formList.length > 0
      ? Math.round(formList.reduce((s, f) => s + f.completion_rate, 0) / formList.length * 10) / 10
      : 0

    return NextResponse.json({
      success: true,
      data: {
        forms: formList,
        summary: {
          total_forms: totalForms,
          total_views: totalViews,
          total_submitted: totalSubmitted,
          total_abandoned: totalAbandoned,
          avg_completion_rate: avgCompletionRate,
        },
      },
    })
  } catch (error: any) {
    console.error('Error in form-analysis API:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error?.message },
      { status: 500 }
    )
  }
}
