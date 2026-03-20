import { NextRequest, NextResponse } from 'next/server'
import { runAnalysis, isAIAvailable } from '@/lib/claude'
import { executeAxis, executeAllAxes } from '@/lib/analysis-axes'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

export const maxDuration = 120 // AI分析は時間がかかるため2分に設定

export async function POST(request: NextRequest) {
  try {
    // 認証チェック（middlewareで注入されたヘッダーから取得）
    const userId = request.headers.get('x-user-id')
    if (!userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    if (!isAIAvailable()) {
      return NextResponse.json({ error: 'AI analysis is not configured' }, { status: 503 })
    }

    const body = await request.json()
    const { site_id, analysis_type, axis_ids, page_url } = body

    if (!site_id) {
      return NextResponse.json({ error: 'site_id is required' }, { status: 400 })
    }

    const ch = await getClickHouseClientAsync()

    // サイト情報を取得
    const siteResult = await ch.query({
      query: 'SELECT name, url FROM clickinsight.sites WHERE id = {site_id:String} OR tracking_id = {site_id:String} LIMIT 1',
      query_params: { site_id },
      format: 'JSONEachRow',
    })
    const sites = await siteResult.json() as any[]
    const site = sites[0] || { name: site_id, url: '' }

    let analysisData: Record<string, unknown> = {}

    switch (analysis_type) {
      case 'ux_diagnosis': {
        // 複数軸を実行してUX診断用データを収集
        const targetAxes = axis_ids || [
          'cognitive_load_score',
          'engagement_decay_curve',
          'exit_intent_pattern',
          'rage_dead_clicks',
          'form_friction',
          'cta_visibility_clickrate',
          'price_sensitivity_signal',
        ]

        const results: Record<string, unknown> = {}
        for (const axisId of targetAxes) {
          try {
            const result = await executeAxis(ch, axisId, { site_id })
            if (result && result.data.length > 0) {
              results[axisId] = {
                name: result.axis.name,
                data: result.data.slice(0, 20),
                ai_hint: result.axis.aiPromptHint,
              }
            }
          } catch (e) {
            console.error(`Axis ${axisId} failed:`, e)
          }
        }

        analysisData = { axes_results: results }
        break
      }

      case 'persona_generation': {
        // ペルソナ生成用データを収集
        const [profileResult, intentResult, summaryResult] = await Promise.all([
          executeAxis(ch, 'persona_behavior_profile', { site_id }),
          executeAxis(ch, 'persona_query_intent', { site_id }),
          ch.query({
            query: `SELECT uniq(session_id) as total_sessions, countIf(conversion_type IS NOT NULL) as conversions, countIf(conversion_type IS NOT NULL) / greatest(uniq(session_id), 1) * 100 as cvr FROM clickinsight.events WHERE site_id = {site_id:String}`,
            query_params: { site_id },
            format: 'JSONEachRow',
          }),
        ])

        const summary = await summaryResult.json() as any[]
        analysisData = {
          site_summary: summary[0] || {},
          behavior_profiles: profileResult?.data || [],
          query_intent_by_page: intentResult?.data?.slice(0, 30) || [],
        }
        break
      }

      case 'page_analysis': {
        if (!page_url) {
          return NextResponse.json({ error: 'page_url is required for page analysis' }, { status: 400 })
        }

        // ページ単位の分析データを収集
        const [heatmapResult, scrollResult, readResult] = await Promise.all([
          ch.query({
            query: `SELECT click_x, click_y, count() as clicks, any(element_text) as element_text FROM clickinsight.events WHERE site_id = {site_id:String} AND url = {page_url:String} AND event_type = 'click' GROUP BY click_x, click_y ORDER BY clicks DESC LIMIT 50`,
            query_params: { site_id, page_url },
            format: 'JSONEachRow',
          }),
          ch.query({
            query: `SELECT intDiv(scroll_y, 100) * 100 as y_zone, uniq(session_id) as sessions FROM clickinsight.events WHERE site_id = {site_id:String} AND url = {page_url:String} AND event_type IN ('scroll','scroll_depth') AND scroll_y > 0 GROUP BY y_zone ORDER BY y_zone`,
            query_params: { site_id, page_url },
            format: 'JSONEachRow',
          }),
          ch.query({
            query: `SELECT intDiv(read_y, 100) * 100 as y_zone, sum(read_duration) as total_ms, uniq(session_id) as sessions FROM clickinsight.events WHERE site_id = {site_id:String} AND url = {page_url:String} AND event_type = 'read_area' AND read_y > 0 GROUP BY y_zone ORDER BY y_zone`,
            query_params: { site_id, page_url },
            format: 'JSONEachRow',
          }),
        ])

        analysisData = {
          page_url,
          click_heatmap: await heatmapResult.json(),
          scroll_depth: await scrollResult.json(),
          read_areas: await readResult.json(),
        }
        break
      }

      default:
        return NextResponse.json({ error: 'Invalid analysis_type. Use: ux_diagnosis, persona_generation, page_analysis' }, { status: 400 })
    }

    // Claude APIで分析を実行
    const result = await runAnalysis({
      siteId: site_id,
      siteName: site.name,
      siteUrl: site.url,
      analysisType: analysis_type,
      data: analysisData,
    })

    return NextResponse.json({
      success: true,
      analysis_type,
      site_id,
      result: {
        text: result.analysis,
        model: result.model,
        tokens: result.usage,
      },
    })
  } catch (error: any) {
    console.error('AI analysis error:', error)

    if (error?.message?.includes('CLAUDE_API_KEY')) {
      return NextResponse.json({ error: 'AI analysis is not configured. Set CLAUDE_API_KEY in environment.' }, { status: 503 })
    }

    return NextResponse.json(
      { error: error?.message || 'AI analysis failed' },
      { status: 500 }
    )
  }
}

// AI分析の利用可能状態を返す
export async function GET() {
  return NextResponse.json({
    available: isAIAvailable(),
    axes_count: 32,
    analysis_types: ['ux_diagnosis', 'persona_generation', 'page_analysis'],
  })
}
