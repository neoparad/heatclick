import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { publishRealtimeData, pushEventBuffer } from '@/lib/redis'
import { checkRateLimitAsync } from '@/lib/rate-limit'
import { anonymizeIp } from '@/lib/privacy'
import { buildTrackingCorsHeaders as buildCorsHeaders } from '@/lib/api-utils'

// Vercel Serverless タイムアウト設定（秒）
export const maxDuration = 60

// メモリ内データストレージ（フォールバック用、上限1000件で古いものを破棄）
const MAX_MEMORY_EVENTS = 1000
let trackingData: any[] = []

export async function OPTIONS(request: NextRequest) {
  const headers = buildCorsHeaders(request)
  return new NextResponse(null, { headers })
}

export async function POST(request: NextRequest) {
  try {
    // Rate Limiting（IP匿名化）
    const rawIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const clientIp = anonymizeIp(rawIp)
    const rateLimit = await checkRateLimitAsync(`track:${clientIp}`)
    
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { 
          status: 429,
          headers: {
            ...buildCorsHeaders(request),
            'X-RateLimit-Limit': '100',
            'X-RateLimit-Remaining': rateLimit.remaining.toString(),
            'X-RateLimit-Reset': new Date(rateLimit.resetTime).toISOString(),
            'Retry-After': Math.ceil((rateLimit.resetTime - Date.now()) / 1000).toString(),
          }
        }
      )
    }

    const data = await request.json()

    // Support both single event and batch events
    const events = data.events || [data]

    // Validate events
    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ error: 'Invalid data' }, { status: 400, headers: buildCorsHeaders(request) })
    }

    // Validate each event
    for (const event of events) {
      if (!event.site_id || !event.event_type) {
        console.error('ClickInsight Pro - Invalid event data:', {
          site_id: event.site_id,
          event_type: event.event_type,
          hasSiteId: !!event.site_id,
          hasEventType: !!event.event_type
        })
        return NextResponse.json({ 
          error: 'Invalid event data: site_id and event_type are required',
          details: {
            site_id: event.site_id || 'missing',
            event_type: event.event_type || 'missing'
          }
        }, { status: 400, headers: buildCorsHeaders(request) })
      }
      
      // Validate site_id format (should be a non-empty string)
      if (typeof event.site_id !== 'string' || event.site_id.trim() === '') {
        console.error('ClickInsight Pro - Invalid site_id format:', event.site_id)
        return NextResponse.json({ 
          error: 'Invalid site_id format: must be a non-empty string',
          site_id: event.site_id
        }, { status: 400, headers: buildCorsHeaders(request) })
      }
    }

    // Prepare events for ClickHouse（収益・広告連携対応）
    const clickHouseEvents = events.map(event => ({
      id: event.id || crypto.randomUUID(),
      site_id: event.site_id || event.siteId,
      session_id: event.session_id || event.sessionId,
      user_id: event.user_id || event.userId || null,
      event_type: event.event_type || event.eventType,
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString().replace('T', ' ').replace('Z', '').substring(0, 19) : new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
      url: event.url || event.page_url || '',
      referrer: event.referrer || null,
      user_agent: event.user_agent || event.userAgent || '',
      viewport_width: event.viewport_width || event.viewportWidth || 0,
      viewport_height: event.viewport_height || event.viewportHeight || 0,
      element_tag_name: event.element?.tagName || event.element_tag_name || event.element_tag || null,
      element_id: event.element?.id || event.element_id || null,
      element_class_name: event.element?.className || event.element_class_name || event.element_class || null,
      element_text: event.element?.text || event.element_text || null,
      element_href: event.element?.href || event.element_href || null,
      click_x: event.position?.x || event.click_x || 0,
      click_y: event.position?.y || event.click_y || 0,
      scroll_y: event.scroll_y || 0,
      scroll_percentage: event.scroll_percentage || 0,
      read_y: event.read_y || 0,
      read_duration: event.read_duration || 0,
      event_revenue: event.event_revenue || event.revenue || 0,
      utm_source: event.utm_source || null,
      utm_medium: event.utm_medium || null,
      utm_campaign: event.utm_campaign || null,
      utm_term: event.utm_term || null,
      utm_content: event.utm_content || null,
      gclid: event.gclid || null,
      fbclid: event.fbclid || null,
      conversion_type: event.conversion_type || null,
      conversion_value: event.conversion_value || event.conversionValue || 0,
      search_query: event.search_query || null,
      device_type: event.device_type || null,
      ga_client_id: event.ga_client_id || null,
      external_id: event.external_id || null,
      element_selector: event.element_selector || null,
      sequence_id: event.sequence_id || 0,
      previous_url: event.previous_url || null,
      navigation_trigger: event.navigation_trigger || null,
    }))

    // Prepare image_visibility events
    const imageVisibilityEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'image_visibility' && event.image_src) {
        imageVisibilityEvents.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId,
          session_id: event.session_id || event.sessionId,
          page_url: event.url || event.page_url || '',
          image_src: event.image_src || '',
          image_alt: event.image_alt || '',
          element_path: event.element_path || '',
          image_y: event.image_y || 0,
          image_width: event.image_width || 0,
          image_height: event.image_height || 0,
          visible_duration_ms: event.visible_duration_ms || 0,
          max_visible_ratio: event.max_visible_ratio || 0,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare form_interactions events
    const formEvents: any[] = []
    const formEventTypes = ['form_view', 'form_field_focus', 'form_field_blur', 'form_submit', 'form_abandon']
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (formEventTypes.includes(eventType)) {
        formEvents.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          event_type: eventType,
          form_id: event.form_id || '',
          form_action: event.form_action || '',
          field_name: event.field_name || '',
          field_type: event.field_type || '',
          field_duration_ms: event.field_duration_ms || 0,
          field_filled: event.field_filled || 0,
          field_count: event.field_count || 0,
          filled_count: event.filled_count || 0,
          fields_touched: event.fields_touched || 0,
          last_field: event.last_field || '',
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare video_events
    const videoEvents: any[] = []
    const videoEventTypes = ['video_play', 'video_pause', 'video_complete', 'video_milestone', 'video_summary']
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (videoEventTypes.includes(eventType)) {
        videoEvents.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          event_type: eventType,
          video_src: event.video_src || '',
          element_path: event.element_path || '',
          video_current_time: event.video_current_time || 0,
          video_duration: event.video_duration || 0,
          video_progress: event.video_progress || 0,
          video_milestone: event.video_milestone || 0,
          video_played_ms: event.video_played_ms || 0,
          video_completed: event.video_completed || 0,
          video_interactions: event.video_interactions || 0,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare element_visibility events
    const elementVisibilityEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'element_visibility' && event.element_selector) {
        elementVisibilityEvents.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          element_selector: event.element_selector || '',
          element_tag: event.element_tag || '',
          element_text: event.element_text || '',
          element_y: event.element_y || 0,
          visible_duration_ms: event.visible_duration_ms || 0,
          max_visible_ratio: event.max_visible_ratio || 0,
          element_clicked: event.element_clicked || 0,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare behavior_signals events (emotion inference signals)
    const behaviorEvents: any[] = []
    const behaviorEventTypes = ['text_copy', 'scroll_reversal', 'tab_return', 'browser_back', 'pinch_zoom', 'cta_hover']
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (behaviorEventTypes.includes(eventType)) {
        behaviorEvents.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          event_type: eventType,
          // text_copy
          copied_text: event.copied_text || null,
          copied_length: event.copied_length || 0,
          copy_y: event.copy_y || 0,
          // scroll_reversal
          reversal_count: event.reversal_count || 0,
          final_scroll_y: event.final_scroll_y || 0,
          // tab_return
          away_duration_ms: event.away_duration_ms || 0,
          tab_switch_count: event.tab_switch_count || 0,
          return_scroll_y: event.return_scroll_y || 0,
          // browser_back
          from_url: event.from_url || null,
          scroll_y_at_back: event.scroll_y_at_back || 0,
          scroll_depth_at_back: event.scroll_depth_at_back || 0,
          // pinch_zoom
          zoom_scale: event.zoom_scale || 0,
          zoom_y: event.zoom_y || 0,
          target_tag: event.target_tag || null,
          target_src: event.target_src || null,
          target_alt: event.target_alt || null,
          pinch_zoom_count: event.pinch_zoom_count || 0,
          // cta_hover
          hover_duration_ms: event.hover_duration_ms || 0,
          hover_y: event.hover_y || 0,
          hover_clicked: event.hover_clicked ? 1 : 0,
          // common
          element_path: event.element_path || null,
          element_text: event.element_text || null,
          device_type: event.device_type || null,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare scroll_timeline events (scroll position time series)
    const scrollTimelineEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'scroll_timeline' && event.scroll_points) {
        const points = Array.isArray(event.scroll_points) ? event.scroll_points : []
        for (const point of points) {
          scrollTimelineEvents.push({
            id: crypto.randomUUID(),
            site_id: event.site_id || event.siteId || '',
            session_id: event.session_id || event.sessionId || '',
            page_url: event.url || event.page_url || '',
            timestamp_ms: point.timestamp_ms || 0,
            scroll_y: point.scroll_y || 0,
            viewport_height: event.viewport_height || 0,
            created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
          })
        }
      }
    }

    // Prepare element_visibility_v2 events (broad content element visibility)
    const elementVisibilityV2Events: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'element_visibility_v2' && event.element_selector) {
        elementVisibilityV2Events.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          element_selector: event.element_selector || '',
          element_tag: event.element_tag || '',
          element_text: (event.element_text || '').substring(0, 100),
          visible_start_ms: event.visible_start_ms || 0,
          visible_end_ms: event.visible_end_ms || 0,
          visible_duration_ms: event.visible_duration_ms || 0,
          viewport_percent: event.viewport_percent || 0,
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare web_vitals events (Core Web Vitals + connection info)
    const webVitalsEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'web_vitals') {
        webVitalsEvents.push({
          id: crypto.randomUUID(),
          site_id: event.site_id || event.siteId || '',
          session_id: event.session_id || event.sessionId || '',
          page_url: event.url || event.page_url || '',
          lcp_ms: event.lcp_ms || 0,
          lcp_element: (event.lcp_element || '').substring(0, 200),
          cls_score: event.cls_score || 0,
          inp_ms: event.inp_ms || 0,
          ttfb_ms: event.ttfb_ms || 0,
          fcp_ms: event.fcp_ms || 0,
          connection_type: event.connection_type || '',
          downlink_mbps: event.downlink_mbps || 0,
          rtt_ms: event.rtt_ms || 0,
          device_type: event.device_type || '',
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Prepare user_mappings for identify events
    const identifyEvents: any[] = []
    for (const event of events) {
      const eventType = event.event_type || event.eventType
      if (eventType === 'identify' && event.external_id) {
        identifyEvents.push({
          site_id: event.site_id || event.siteId || '',
          anonymous_id: event.user_id || event.userId || '',
          external_id: event.external_id || '',
          metadata: event.user_metadata || '',
          created_at: new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 19),
        })
      }
    }

    // Redisバッファ経由でClickHouseに書き込み（即レスポンス返却）
    // Inngest flushEventBuffer が毎分Redisからバッチ取得してClickHouseにINSERT
    try {
      const bufferPromises: Promise<void>[] = [
        pushEventBuffer('clickinsight.events', clickHouseEvents),
      ]

      if (imageVisibilityEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.image_visibility', imageVisibilityEvents))
      }
      if (formEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.form_interactions', formEvents))
      }
      if (videoEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.video_events', videoEvents))
      }
      if (elementVisibilityEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.element_visibility', elementVisibilityEvents))
      }
      if (behaviorEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.behavior_signals', behaviorEvents))
      }
      if (scrollTimelineEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.scroll_timeline', scrollTimelineEvents))
      }
      if (elementVisibilityV2Events.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.element_visibility_v2', elementVisibilityV2Events))
      }
      if (webVitalsEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.web_vitals', webVitalsEvents))
      }
      if (identifyEvents.length > 0) {
        bufferPromises.push(pushEventBuffer('clickinsight.user_mappings', identifyEvents))
      }

      await Promise.all(bufferPromises)

      // リアルタイム通知はRedis Pub/Subで即時配信（バッファとは別）
      for (const event of events) {
        const siteId = event.site_id || event.siteId
        if (siteId) {
          await publishRealtimeData(siteId, event)
        }
      }
    } catch (error) {
      console.error('Redis buffer error, falling back to direct ClickHouse insert:', error)
      // Redisが落ちている場合はClickHouseに直接書き込み（フォールバック）
      try {
        const clickhouse = await getClickHouseClientAsync()
        const insertPromises: Promise<any>[] = [
          clickhouse.insert({ table: 'clickinsight.events', values: clickHouseEvents, format: 'JSONEachRow' }),
        ]
        if (imageVisibilityEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.image_visibility', values: imageVisibilityEvents, format: 'JSONEachRow' }))
        }
        if (formEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.form_interactions', values: formEvents, format: 'JSONEachRow' }))
        }
        if (videoEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.video_events', values: videoEvents, format: 'JSONEachRow' }))
        }
        if (elementVisibilityEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.element_visibility', values: elementVisibilityEvents, format: 'JSONEachRow' }))
        }
        if (behaviorEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.behavior_signals', values: behaviorEvents, format: 'JSONEachRow' }))
        }
        if (scrollTimelineEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.scroll_timeline', values: scrollTimelineEvents, format: 'JSONEachRow' }))
        }
        if (elementVisibilityV2Events.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.element_visibility_v2', values: elementVisibilityV2Events, format: 'JSONEachRow' }))
        }
        if (webVitalsEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.web_vitals', values: webVitalsEvents, format: 'JSONEachRow' }))
        }
        if (identifyEvents.length > 0) {
          insertPromises.push(clickhouse.insert({ table: 'clickinsight.user_mappings', values: identifyEvents, format: 'JSONEachRow' }))
        }
        await Promise.all(insertPromises)
      } catch (chError) {
        console.error('ClickHouse direct insert also failed:', chError)
        events.forEach(event => {
          trackingData.push({ ...event, received_at: new Date().toISOString() })
        })
        // メモリ上限を超えたら古いデータを破棄
        if (trackingData.length > MAX_MEMORY_EVENTS) {
          trackingData = trackingData.slice(-MAX_MEMORY_EVENTS)
        }
      }
    }

    // Debug log
    if (process.env.NODE_ENV === 'development') {
      const uniqueEventTypes = Array.from(new Set(events.map(e => e.event_type)))
      console.log('ClickInsight Pro - Received batch:', {
        count: events.length,
        siteId: events[0]?.site_id,
        eventTypes: uniqueEventTypes,
      })
    }

    return NextResponse.json({
      success: true,
      received: events.length
    }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('ClickInsight Pro - API Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}

export async function GET(request: NextRequest) {
  // GET /api/track は認証必須（他人のトラッキングデータ閲覧を防止）
  const { getAuthContext, unauthorized, verifySiteAccess, forbidden } = await import('@/lib/api-utils')
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('siteId')
    const eventType = searchParams.get('eventType')
    const limit = parseInt(searchParams.get('limit') || '100')

    // サイトアクセス権限チェック
    if (siteId) {
      const ch = await getClickHouseClientAsync()
      const { authorized } = await verifySiteAccess(request, siteId, ch)
      if (!authorized) return forbidden('Access denied to this site')
    }

    // ClickHouseからデータを取得を試みる
    let events: any[] = []

    try {
      const clickhouse = await getClickHouseClientAsync()
      
      let query = `
        SELECT 
          id,
          site_id as siteId,
          session_id as sessionId,
          user_id as userId,
          event_type as eventType,
          timestamp,
          url as page_url,
          referrer,
          user_agent as userAgent,
          viewport_width as viewportWidth,
          viewport_height as viewportHeight,
          element_tag_name as elementTag,
          element_id as elementId,
          element_class_name as elementClass,
          element_text as elementText,
          click_x as clickX,
          click_y as clickY,
          scroll_y as scrollY,
          scroll_percentage as scrollPercentage,
          device_type as deviceType
        FROM clickinsight.events
        WHERE 1=1
      `
      
      const params: Record<string, any> = {}
      
      if (siteId) {
        query += ` AND site_id = {site_id:String}`
        params.site_id = siteId
      }
      
      if (eventType) {
        query += ` AND event_type = {event_type:String}`
        params.event_type = eventType
      }
      
      query += ` ORDER BY timestamp DESC LIMIT {limit:UInt32}`
      params.limit = limit
      
      const result = await clickhouse.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      })
      
      events = await result.json()
    } catch (error) {
      console.error('Error fetching events from ClickHouse:', error)
      // フォールバック: メモリ内データを使用
      events = trackingData
      
      if (siteId) {
        events = events.filter(item => item.siteId === siteId || item.site_id === siteId)
      }
      
      if (eventType) {
        events = events.filter(item => item.eventType === eventType || item.event_type === eventType)
      }
      
      events = events
        .sort((a, b) => {
          const timeA = new Date(a.timestamp || a.received_at || 0).getTime()
          const timeB = new Date(b.timestamp || b.received_at || 0).getTime()
          return timeB - timeA
        })
        .slice(0, limit)
    }

    return NextResponse.json({
      data: events,
      total: events.length,
      filtered: events.length,
      source: events.length > 0 && events[0].id ? 'clickhouse' : 'memory'
    }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('Error in GET /api/track:', error)
    return NextResponse.json(
      { error: 'Internal server error', data: [] },
      { status: 500, headers: buildCorsHeaders(request) }
    )
  }
}



