import { getClickHouseClientAsync, resetClickHouseConnection } from './client'
import type { ClickEvent, ClickHouseClient } from './types'
import { normalizeEndDate } from '../utils'

function handleConnectionError(error: any): void {
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.message?.includes('connection')) {
    resetClickHouseConnection()
  }
}

export async function insertClickEvent(event: ClickEvent): Promise<void> {
  try {
    const client = await getClickHouseClientAsync()
    await client.insert({ table: 'clickinsight.events', values: [event], format: 'JSONEachRow' })
  } catch (error: any) {
    console.error('Error inserting click event:', { error: error?.message, code: error?.code, eventId: event.id })
    handleConnectionError(error)
    if (process.env.NODE_ENV === 'development') throw error
  }
}

export async function getClickEvents(
  siteId: string, startDate?: string, endDate?: string, limit: number = 1000
): Promise<ClickEvent[]> {
  try {
    let query = `SELECT * FROM clickinsight.events WHERE site_id = {site_id:String}`
    const params: Record<string, any> = { site_id: siteId }

    if (startDate) { query += ` AND timestamp >= {start_date:String}`; params.start_date = startDate }
    if (endDate) { query += ` AND timestamp <= {end_date:String}`; params.end_date = normalizeEndDate(endDate) }
    query += ` ORDER BY timestamp DESC LIMIT {limit:UInt32}`
    params.limit = limit

    const client = await getClickHouseClientAsync()
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' })
    return await result.json()
  } catch (error: any) {
    console.error('Error fetching click events:', { error: error?.message, code: error?.code, siteId })
    handleConnectionError(error)
    throw error
  }
}

export async function getHeatmapData(
  siteId: string, pageUrl: string, deviceType?: string,
  startDate?: string, endDate?: string,
  heatmapType: 'click' | 'scroll' | 'read' = 'click'
): Promise<any[]> {
  try {
    const client = await getClickHouseClientAsync()
    if (endDate) endDate = normalizeEndDate(endDate)

    if (heatmapType === 'click') {
      return await queryClickHeatmap(client, siteId, pageUrl, deviceType, startDate, endDate)
    }
    if (heatmapType === 'scroll') {
      return await queryScrollHeatmap(client, siteId, pageUrl, startDate, endDate)
    }
    if (heatmapType === 'read') {
      return await queryReadHeatmap(client, siteId, pageUrl, startDate, endDate)
    }
    return []
  } catch (error: any) {
    console.error('Error fetching heatmap data:', { error: error?.message, code: error?.code, siteId, pageUrl, heatmapType })
    handleConnectionError(error)
    throw error
  }
}

async function queryClickHeatmap(
  client: ClickHouseClient, siteId: string, pageUrl: string, deviceType?: string, startDate?: string, endDate?: string
): Promise<any[]> {
  let query = `
    SELECT click_x, click_y, count() as click_count, max(timestamp) as last_click,
      argMax(element_tag_name, timestamp) as element_tag_name,
      argMax(element_id, timestamp) as element_id,
      argMax(element_class_name, timestamp) as element_class_name
    FROM clickinsight.events
    WHERE site_id = {site_id:String} AND url = {page_url:String} AND event_type = 'click'
  `
  const params: Record<string, any> = { site_id: siteId, page_url: pageUrl }
  if (deviceType) { query += ` AND device_type = {device_type:String}`; params.device_type = deviceType }
  if (startDate) { query += ` AND timestamp >= {start_date:String}`; params.start_date = startDate }
  if (endDate) { query += ` AND timestamp <= {end_date:String}`; params.end_date = endDate }
  query += ` GROUP BY click_x, click_y ORDER BY click_count DESC LIMIT 10000`

  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' })
  return await result.json()
}

async function queryScrollHeatmap(
  client: ClickHouseClient, siteId: string, pageUrl: string, startDate?: string, endDate?: string
): Promise<any[]> {
  const params: Record<string, any> = { site_id: siteId, page_url: pageUrl }
  let dateFilter = ''
  if (startDate) { dateFilter += ` AND timestamp >= {start_date:String}`; params.start_date = startDate }
  if (endDate) { dateFilter += ` AND timestamp <= {end_date:String}`; params.end_date = endDate }

  const query = `
    SELECT bucket as scroll_y, countIf(max_y >= bucket) as unique_sessions, 0 as session_count, 0 as avg_scroll_percentage, 0 as max_scroll_percentage
    FROM (SELECT intDiv(number, 1) * 100 as bucket FROM numbers(500)) AS buckets
    CROSS JOIN (
      SELECT session_id, max(scroll_y) as max_y
      FROM clickinsight.events
      WHERE url = {page_url:String} AND event_type IN ('scroll', 'scroll_depth') AND site_id = {site_id:String} AND scroll_y > 0 ${dateFilter}
      GROUP BY session_id
    ) AS sessions
    GROUP BY bucket HAVING unique_sessions > 0 ORDER BY scroll_y ASC
  `
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' })
  const scrollData = await result.json() as any[]

  // Total sessions for reach rate
  const totalParams: Record<string, any> = { site_id: siteId, page_url: pageUrl }
  let totalDateFilter = ''
  if (startDate) { totalDateFilter += ` AND timestamp >= {start_date:String}`; totalParams.start_date = startDate }
  if (endDate) { totalDateFilter += ` AND timestamp <= {end_date:String}`; totalParams.end_date = endDate }

  const totalResult = await client.query({
    query: `SELECT uniq(session_id) as total_sessions FROM clickinsight.events WHERE site_id = {site_id:String} AND url = {page_url:String} AND (event_type = 'pageview' OR event_type = 'page_view') ${totalDateFilter}`,
    query_params: totalParams,
    format: 'JSONEachRow',
  })
  const totalData = await totalResult.json() as any[]
  const totalSessions = Number(totalData[0]?.total_sessions) || 1

  return scrollData.map(item => ({
    scroll_y: Number(item.scroll_y) || 0,
    session_count: Number(item.session_count) || 0,
    unique_sessions: Number(item.unique_sessions) || 0,
    reach_rate: totalSessions > 0 ? ((Number(item.unique_sessions) / totalSessions) * 100) : 0,
    avg_scroll_percentage: Number(item.avg_scroll_percentage) || 0,
    max_scroll_percentage: Number(item.max_scroll_percentage) || 0,
  }))
}

async function queryReadHeatmap(
  client: ClickHouseClient, siteId: string, pageUrl: string, startDate?: string, endDate?: string
): Promise<any[]> {
  const params: Record<string, any> = { site_id: siteId, page_url: pageUrl }
  let dateFilter = ''
  if (startDate) { dateFilter += ` AND timestamp >= {start_date:String}`; params.start_date = startDate }
  if (endDate) { dateFilter += ` AND timestamp <= {end_date:String}`; params.end_date = endDate }

  const query = `
    SELECT intDiv(read_y, 100) * 100 as read_y, sum(read_duration) as total_duration,
      avg(read_duration) as avg_duration, max(read_duration) as max_duration,
      count() as read_count, uniq(session_id) as unique_sessions
    FROM clickinsight.events
    WHERE url = {page_url:String} AND event_type = 'read_area' AND site_id = {site_id:String} AND read_y > 0 ${dateFilter}
    GROUP BY read_y ORDER BY total_duration DESC
  `
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' })
  const readData = await result.json() as any[]
  const maxDuration = Math.max(...readData.map(item => Number(item.total_duration) || 0), 1)

  return readData.map(item => ({
    read_y: Number(item.read_y) || 0,
    total_duration: Number(item.total_duration) || 0,
    avg_duration: Number(item.avg_duration) || 0,
    max_duration: Number(item.max_duration) || 0,
    read_count: Number(item.read_count) || 0,
    unique_sessions: Number(item.unique_sessions) || 0,
    intensity: maxDuration > 0 ? (Number(item.total_duration) / maxDuration) : 0,
  }))
}

export async function getStatistics(siteId: string, startDate?: string, endDate?: string): Promise<any> {
  try {
    if (endDate) endDate = normalizeEndDate(endDate)
    const client = await getClickHouseClientAsync()
    const params: Record<string, any> = { site_id: siteId }

    let query = `
      SELECT count() as total_events, countIf(event_type = 'click') as clicks,
        countIf(event_type = 'scroll') as scrolls, countIf(event_type = 'hover') as hovers,
        countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views,
        uniq(session_id) as unique_sessions, avg(scroll_percentage) as avg_scroll_depth,
        countIf(viewport_width >= 1024) as desktop_events,
        countIf(viewport_width >= 768 AND viewport_width < 1024) as tablet_events,
        countIf(viewport_width < 768) as mobile_events,
        min(timestamp) as first_event_time, max(timestamp) as last_event_time
      FROM clickinsight.events WHERE site_id = {site_id:String}
    `
    if (startDate) { query += ` AND timestamp >= {start_date:String}`; params.start_date = startDate }
    if (endDate) { query += ` AND timestamp <= {end_date:String}`; params.end_date = endDate }

    let sessionQuery = `
      SELECT count() as total_sessions,
        avg(dateDiff('second', session_start, session_end)) as avg_duration_seconds,
        countIf(page_views <= 1) as bounce_sessions
      FROM (
        SELECT session_id, min(timestamp) as session_start, max(timestamp) as session_end,
          countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
        FROM clickinsight.events WHERE site_id = {site_id:String}
    `
    if (startDate) sessionQuery += ` AND timestamp >= {start_date:String}`
    if (endDate) sessionQuery += ` AND timestamp <= {end_date:String}`
    sessionQuery += ` GROUP BY session_id)`

    // 並列実行
    const [eventResult, sessionResult] = await Promise.all([
      client.query({ query, query_params: params, format: 'JSONEachRow' }),
      client.query({ query: sessionQuery, query_params: params, format: 'JSONEachRow' }).catch(() => null),
    ])

    const eventStats = ((await eventResult.json()) as any[])[0] || {}

    let sessionStats = { avg_time_on_page: 0, bounce_sessions: 0, total_sessions: 0, bounce_rate: 0 }
    if (sessionResult) {
      const sessionData = (await sessionResult.json()) as any[]
      if (sessionData?.[0]) {
        const s = sessionData[0]
        const totalSessions = Number(s.total_sessions) || 0
        const avgDuration = Number(s.avg_duration_seconds) || 0
        const bounceS = Number(s.bounce_sessions) || 0
        sessionStats = {
          avg_time_on_page: totalSessions > 0 ? Number((avgDuration / 60).toFixed(1)) : 0,
          bounce_sessions: bounceS,
          total_sessions: totalSessions,
          bounce_rate: totalSessions > 0 ? Number(((bounceS / totalSessions) * 100).toFixed(1)) : 0,
        }
      }
    }

    return { ...eventStats, ...sessionStats }
  } catch (error) {
    console.error('Error fetching statistics:', error)
    throw error
  }
}

export async function getTrafficSources(siteId: string, startDate?: string, endDate?: string): Promise<any> {
  try {
    if (endDate) endDate = normalizeEndDate(endDate)
    const client = await getClickHouseClientAsync()
    const params: Record<string, any> = { site_id: siteId }
    let dateFilter = ''
    if (startDate) { dateFilter += ` AND timestamp >= {start_date:String}`; params.start_date = startDate }
    if (endDate) { dateFilter += ` AND timestamp <= {end_date:String}`; params.end_date = endDate }

    const [referrerResult, utmResult] = await Promise.all([
      client.query({
        query: `SELECT CASE WHEN referrer = '' OR referrer IS NULL THEN 'direct' ELSE referrer END as referrer,
          count() as sessions, uniq(session_id) as unique_sessions,
          countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
          FROM clickinsight.events WHERE site_id = {site_id:String} AND (event_type = 'page_view' OR event_type = 'pageview') ${dateFilter}
          GROUP BY referrer ORDER BY sessions DESC LIMIT 20`,
        query_params: params, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT CASE WHEN utm_source = '' OR utm_source IS NULL THEN 'direct' ELSE utm_source END as utm_source,
          CASE WHEN utm_medium = '' OR utm_medium IS NULL THEN 'none' ELSE utm_medium END as utm_medium,
          count() as sessions, uniq(session_id) as unique_sessions,
          countIf(event_type = 'page_view' OR event_type = 'pageview') as page_views
          FROM clickinsight.events WHERE site_id = {site_id:String} AND (event_type = 'page_view' OR event_type = 'pageview') ${dateFilter}
          GROUP BY utm_source, utm_medium ORDER BY sessions DESC LIMIT 20`,
        query_params: params, format: 'JSONEachRow',
      }),
    ])

    const referrerData = await referrerResult.json() as any[]
    const utmData = await utmResult.json() as any[]

    return {
      referrers: referrerData.map(item => ({
        referrer: item.referrer || 'direct',
        sessions: Number(item.sessions) || 0,
        unique_sessions: Number(item.unique_sessions) || 0,
        page_views: Number(item.page_views) || 0,
      })),
      utm_sources: utmData.map(item => ({
        utm_source: item.utm_source || 'direct',
        utm_medium: item.utm_medium || 'none',
        sessions: Number(item.sessions) || 0,
        unique_sessions: Number(item.unique_sessions) || 0,
        page_views: Number(item.page_views) || 0,
      })),
    }
  } catch (error: any) {
    console.error('Error fetching traffic sources:', { error: error?.message, siteId })
    return { referrers: [], utm_sources: [] }
  }
}
