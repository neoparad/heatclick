import { NextRequest, NextResponse } from 'next/server'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { getAuthContext, unauthorized, badRequest, verifySiteAccess, forbidden } from '@/lib/api-utils'

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const format = searchParams.get('format') // 'sankey' for Sankey data
    const limit = parseInt(searchParams.get('limit') || '50')

    if (!siteId) return badRequest('site_id is required')

    const clickhouse = await getClickHouseClientAsync()

    const { authorized } = await verifySiteAccess(request, siteId, clickhouse)
    if (!authorized) return forbidden('Access denied to this site')

    const params: Record<string, any> = { site_id: siteId }
    let dateFilter = ''
    if (startDate) {
      dateFilter += ' AND timestamp >= {start_date:String}'
      params.start_date = startDate
    }
    if (endDate) {
      dateFilter += ' AND timestamp <= {end_date:String}'
      params.end_date = endDate.length === 10 ? endDate + ' 23:59:59' : endDate
    }

    if (format === 'sankey') {
      return await getSankeyData(clickhouse, params, dateFilter)
    }

    // CV経路: CVしたユーザーの全セッションを時系列で取得
    const result = await clickhouse.query({
      query: `
        WITH cv_users AS (
          SELECT DISTINCT user_id
          FROM clickinsight.events
          WHERE site_id = {site_id:String}
            AND conversion_type IS NOT NULL AND conversion_type != ''
            AND user_id IS NOT NULL AND user_id != ''
            ${dateFilter}
        )
        SELECT
          e.user_id,
          e.session_id,
          min(e.timestamp) as session_start,
          argMin(e.url, e.timestamp) as landing_page,
          anyIf(e.utm_medium, e.utm_medium IS NOT NULL AND e.utm_medium != '') as utm_medium,
          anyIf(e.utm_source, e.utm_source IS NOT NULL AND e.utm_source != '') as utm_source,
          any(e.device_type) as device_type,
          groupArray(e.url) as pages_visited,
          countIf(e.event_type IN ('pageview', 'page_view')) as page_views,
          maxIf(e.conversion_type, e.conversion_type IS NOT NULL AND e.conversion_type != '') as conversion_type,
          sumIf(e.conversion_value, e.conversion_value > 0) as conversion_value
        FROM clickinsight.events e
        INNER JOIN cv_users cu ON e.user_id = cu.user_id
        WHERE e.site_id = {site_id:String}
          AND e.event_type IN ('pageview', 'page_view', 'conversion')
          ${dateFilter}
        GROUP BY e.user_id, e.session_id
        ORDER BY e.user_id, session_start
        LIMIT 500
      `,
      query_params: params,
      format: 'JSONEachRow',
    })

    const rawData = await result.json() as Record<string, string | number>[]

    // user_id別にグループ化
    const userPaths: Record<string, any> = {}
    for (const row of rawData) {
      const userId = row.user_id
      if (!userPaths[userId]) {
        userPaths[userId] = {
          user_id: userId,
          sessions: [],
          total_sessions: 0,
          conversion_type: null,
          conversion_value: 0,
        }
      }
      const pagesVisited = Array.isArray(row.pages_visited) ? row.pages_visited : []
      // ページURLからパスのみ抽出（重複除去）
      const uniquePages = Array.from(new Set(pagesVisited.map((u: string) => {
        try { return new URL(u).pathname } catch { return u }
      })))

      userPaths[userId].sessions.push({
        session_id: row.session_id,
        visit_number: userPaths[userId].sessions.length + 1,
        session_start: row.session_start,
        landing_page: row.landing_page,
        utm_medium: row.utm_medium || 'direct',
        utm_source: row.utm_source || '',
        device_type: row.device_type || 'desktop',
        pages_visited: uniquePages,
        page_views: Number(row.page_views) || 0,
        conversion_type: row.conversion_type || null,
        conversion_value: Number(row.conversion_value) || 0,
      })
      userPaths[userId].total_sessions = userPaths[userId].sessions.length
      if (row.conversion_type) {
        userPaths[userId].conversion_type = row.conversion_type
        userPaths[userId].conversion_value += Number(row.conversion_value) || 0
      }
    }

    const paths = Object.values(userPaths).slice(0, limit)

    // サマリー
    const totalCvUsers = paths.length
    const avgSessionsToConvert = paths.length > 0
      ? Math.round(paths.reduce((s: number, p: any) => s + p.total_sessions, 0) / paths.length * 10) / 10
      : 0
    const mediumBreakdown: Record<string, number> = {}
    for (const p of paths) {
      const firstMedium = p.sessions[0]?.utm_medium || 'direct'
      mediumBreakdown[firstMedium] = (mediumBreakdown[firstMedium] || 0) + 1
    }

    return NextResponse.json({
      success: true,
      data: {
        paths,
        summary: {
          total_cv_users: totalCvUsers,
          avg_sessions_to_convert: avgSessionsToConvert,
          medium_breakdown: mediumBreakdown,
        },
      },
    })
  } catch (error: any) {
    console.error('Error in cv-paths API:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error?.message },
      { status: 500 }
    )
  }
}

async function getSankeyData(
  clickhouse: any,
  params: Record<string, any>,
  dateFilter: string
) {
  // Sankeyデータ: utm_medium → landing_page → 次ページ → CV のフロー
  // Step 1: CVセッションの流入元→ランディングページ
  const flowResult = await clickhouse.query({
    query: `
      WITH cv_sessions AS (
        SELECT DISTINCT session_id
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
          AND conversion_type IS NOT NULL AND conversion_type != ''
          ${dateFilter}
      ),
      session_pages AS (
        SELECT
          e.session_id,
          anyIf(e.utm_medium, e.utm_medium IS NOT NULL AND e.utm_medium != '') as utm_medium,
          arraySort(x -> x.1, groupArray((e.timestamp, e.url))) as page_sequence
        FROM clickinsight.events e
        INNER JOIN cv_sessions cs ON e.session_id = cs.session_id
        WHERE e.site_id = {site_id:String}
          AND e.event_type IN ('pageview', 'page_view')
          ${dateFilter}
        GROUP BY e.session_id
      )
      SELECT
        if(utm_medium IS NULL OR utm_medium = '', 'direct', utm_medium) as medium,
        page_sequence
      FROM session_pages
      LIMIT 500
    `,
    query_params: params,
    format: 'JSONEachRow',
  })

  const rawFlows = await flowResult.json() as Record<string, string | number>[]

  // ノードとリンクを構築
  const nodeSet = new Set<string>()
  const linkMap: Record<string, number> = {}

  for (const row of rawFlows) {
    const medium = `[${row.medium}]`
    nodeSet.add(medium)

    const pages = Array.isArray(row.page_sequence) ? row.page_sequence : []
    if (pages.length === 0) continue

    // ページURLからパスのみ抽出
    const pagePaths = pages.map((p: any) => {
      const url = Array.isArray(p) ? p[1] : (typeof p === 'string' ? p : '')
      try { return new URL(url).pathname } catch { return url }
    })

    // 重複する連続ページを除去
    const dedupedPages: string[] = []
    for (const page of pagePaths) {
      if (dedupedPages.length === 0 || dedupedPages[dedupedPages.length - 1] !== page) {
        dedupedPages.push(page)
      }
    }

    // 最大5ステップに制限
    const limitedPages = dedupedPages.slice(0, 5)

    // medium → 最初のページ
    if (limitedPages.length > 0) {
      const firstPage = limitedPages[0]
      nodeSet.add(firstPage)
      const key1 = `${medium}|||${firstPage}`
      linkMap[key1] = (linkMap[key1] || 0) + 1
    }

    // ページ間遷移
    for (let i = 0; i < limitedPages.length - 1; i++) {
      const from = limitedPages[i]
      const to = limitedPages[i + 1]
      nodeSet.add(from)
      nodeSet.add(to)
      const key = `${from}|||${to}`
      linkMap[key] = (linkMap[key] || 0) + 1
    }
  }

  // ノード配列作成
  const nodes = Array.from(nodeSet).map(name => ({ name }))
  const nodeIndex: Record<string, number> = {}
  nodes.forEach((n, i) => { nodeIndex[n.name] = i })

  // リンク配列作成（value >= 2 のみ、ノイズ除去）
  const links = Object.entries(linkMap)
    .filter(([, value]) => value >= 2)
    .map(([key, value]) => {
      const [source, target] = key.split('|||')
      return {
        source: nodeIndex[source],
        target: nodeIndex[target],
        value,
      }
    })
    .filter(l => l.source !== undefined && l.target !== undefined && l.source !== l.target)
    .sort((a, b) => b.value - a.value)
    .slice(0, 100) // 上位100リンクに制限

  // 使われていないノードを除去
  const usedNodeIndices = new Set<number>()
  for (const l of links) {
    usedNodeIndices.add(l.source)
    usedNodeIndices.add(l.target)
  }

  // インデックスを詰め直す
  const oldToNew: Record<number, number> = {}
  const filteredNodes: { name: string }[] = []
  for (const idx of Array.from(usedNodeIndices).sort((a, b) => a - b)) {
    oldToNew[idx] = filteredNodes.length
    filteredNodes.push(nodes[idx])
  }
  const remappedLinks = links.map(l => ({
    source: oldToNew[l.source],
    target: oldToNew[l.target],
    value: l.value,
  }))

  return NextResponse.json({
    success: true,
    data: {
      nodes: filteredNodes,
      links: remappedLinks,
      total_cv_sessions: rawFlows.length,
    },
  })
}
