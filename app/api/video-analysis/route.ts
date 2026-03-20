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
    const videoSrc = searchParams.get('video_src')

    if (!siteId) {
      return badRequest('site_id is required')
    }

    const clickhouse = await getClickHouseClientAsync()

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

    // 特定動画のマイルストーン詳細
    if (videoSrc) {
      params.video_src = videoSrc
      const milestoneResult = await clickhouse.query({
        query: `
          SELECT
            video_milestone,
            count() as reached
          FROM clickinsight.video_events
          WHERE site_id = {site_id:String}
            AND video_src = {video_src:String}
            AND event_type = 'video_milestone'
            ${dateFilter}
            ${pageFilter}
          GROUP BY video_milestone
          ORDER BY video_milestone
        `,
        query_params: params,
        format: 'JSONEachRow',
      })
      const milestones = await milestoneResult.json() as Record<string, string | number>[]

      return NextResponse.json({
        success: true,
        data: { milestones: milestones.map(m => ({ milestone: Number(m.video_milestone), reached: Number(m.reached) })) },
      })
    }

    // 動画一覧
    const result = await clickhouse.query({
      query: `
        SELECT
          video_src,
          any(page_url) as page_url,
          countIf(event_type = 'video_play') as plays,
          countIf(event_type = 'video_complete') as completions,
          avg(video_played_ms) as avg_played_ms,
          max(video_duration) as video_duration,
          avg(video_interactions) as avg_interactions,
          uniq(session_id) as unique_sessions
        FROM clickinsight.video_events
        WHERE site_id = {site_id:String}
          ${dateFilter}
          ${pageFilter}
        GROUP BY video_src
        ORDER BY plays DESC
        LIMIT 50
      `,
      query_params: params,
      format: 'JSONEachRow',
    })

    const rawData = await result.json() as Record<string, string | number>[]

    const videos = rawData.map(item => {
      const plays = Number(item.plays) || 0
      const completions = Number(item.completions) || 0
      const avgPlayedMs = Number(item.avg_played_ms) || 0
      const videoDuration = Number(item.video_duration) || 0

      return {
        video_src: item.video_src,
        page_url: item.page_url || '',
        plays,
        completions,
        completion_rate: plays > 0 ? Math.round((completions / plays) * 1000) / 10 : 0,
        avg_played_ms: Math.round(avgPlayedMs),
        video_duration: videoDuration,
        avg_watch_percent: videoDuration > 0 ? Math.round((avgPlayedMs / (videoDuration * 1000)) * 100) : 0,
        avg_interactions: Math.round(Number(item.avg_interactions) || 0),
        unique_sessions: Number(item.unique_sessions) || 0,
      }
    })

    const totalPlays = videos.reduce((s, v) => s + v.plays, 0)
    const totalCompletions = videos.reduce((s, v) => s + v.completions, 0)
    const avgCompletionRate = videos.length > 0
      ? Math.round(videos.reduce((s, v) => s + v.completion_rate, 0) / videos.length * 10) / 10
      : 0
    const avgWatchTime = videos.length > 0
      ? Math.round(videos.reduce((s, v) => s + v.avg_played_ms, 0) / videos.length)
      : 0

    return NextResponse.json({
      success: true,
      data: {
        videos,
        summary: {
          total_videos: videos.length,
          total_plays: totalPlays,
          total_completions: totalCompletions,
          avg_completion_rate: avgCompletionRate,
          avg_watch_time_ms: avgWatchTime,
        },
      },
    })
  } catch (error: any) {
    console.error('Error in video-analysis API:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error?.message },
      { status: 500 }
    )
  }
}
