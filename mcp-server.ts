/**
 * UGOKI MAP MCP Server
 *
 * Usage:
 *   npx ts-node mcp-server.ts
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   { "mcpServers": { "ugokimap": { "command": "npx", "args": ["ts-node", "mcp-server.ts"], "env": { "UGOKIMAP_API_URL": "https://your-domain.com", "UGOKIMAP_API_KEY": "your-key" } } } }
 */

import { executeAxis, executeAllAxes, listAxes } from './lib/analysis-axes'
import { getClickHouseClientAsync } from './lib/clickhouse'

// MCP protocol types (stdio-based JSON-RPC)
interface MCPRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: any
}

interface MCPResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: any
  error?: { code: number; message: string }
}

// Tool definitions
const TOOLS = [
  {
    name: 'ugokimap_list_sites',
    description: 'ユーザーが管理しているサイトの一覧を取得',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ugokimap_site_summary',
    description: 'サイトのアクセス概要（セッション数、CVR、平均滞在時間、スクロール深度）を取得',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'サイトID' },
        start_date: { type: 'string', description: '開始日 (YYYY-MM-DD)' },
        end_date: { type: 'string', description: '終了日 (YYYY-MM-DD)' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'ugokimap_list_axes',
    description: '利用可能な分析軸の一覧を取得（ID、名前、説明、カテゴリ、コスト）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ugokimap_analyze',
    description: '指定した分析軸でサイトのユーザー行動を分析。20軸から選択可能。',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'サイトID' },
        axis_id: { type: 'string', description: '分析軸ID（例: image_cv_correlation, form_friction, page_journey）' },
      },
      required: ['site_id', 'axis_id'],
    },
  },
  {
    name: 'ugokimap_multi_analyze',
    description: '複数の分析軸を一括実行し、総合的なUX診断の材料を取得。heavyな軸は直列実行される。',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'サイトID' },
        axes: { type: 'array', items: { type: 'string' }, description: '軸IDの配列。省略時は全軸実行' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'ugokimap_heatmap',
    description: '指定ページのヒートマップデータ（クリック座標、スクロール深度、熟読エリア）を取得',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'サイトID' },
        page_url: { type: 'string', description: 'ページURL' },
        heatmap_type: { type: 'string', enum: ['click', 'scroll', 'read'], description: 'ヒートマップタイプ（デフォルト: click）' },
        device_type: { type: 'string', enum: ['all', 'desktop', 'tablet', 'mobile'], description: 'デバイス（デフォルト: all）' },
      },
      required: ['site_id', 'page_url'],
    },
  },
  {
    name: 'ugokimap_page_friction',
    description: '指定ページのUX摩擦ポイント（rage click、dead click、迷い行動、フォーム離脱）をまとめて取得',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'サイトID' },
        page_url: { type: 'string', description: 'ページURL' },
      },
      required: ['site_id', 'page_url'],
    },
  },
]

// Tool handlers
async function handleTool(name: string, args: any): Promise<any> {
  const ch = await getClickHouseClientAsync()

  switch (name) {
    case 'ugokimap_list_sites': {
      const result = await ch.query({
        query: 'SELECT id, name, url, tracking_id, status FROM clickinsight.sites ORDER BY created_at DESC',
        format: 'JSONEachRow',
      })
      return await result.json()
    }

    case 'ugokimap_site_summary': {
      const params: Record<string, string> = { site_id: args.site_id }
      let dateFilter = ''
      if (args.start_date) { dateFilter += ` AND timestamp >= {start_date:String}`; params.start_date = args.start_date }
      if (args.end_date) { dateFilter += ` AND timestamp <= {end_date:String}`; params.end_date = args.end_date }

      const result = await ch.query({
        query: `
          SELECT
            count() as total_events,
            uniq(session_id) as total_sessions,
            countIf(conversion_type IS NOT NULL) as conversions,
            countIf(conversion_type IS NOT NULL) / greatest(uniq(session_id), 1) * 100 as cvr,
            avg(scroll_percentage) as avg_scroll_depth,
            count(CASE WHEN event_type IN ('rage_click','dead_click') THEN 1 END) as friction_events
          FROM clickinsight.events
          WHERE site_id = {site_id:String} ${dateFilter}
        `,
        query_params: params,
        format: 'JSONEachRow',
      })
      const data = await result.json() as any[]
      return data[0] || {}
    }

    case 'ugokimap_list_axes': {
      return listAxes()
    }

    case 'ugokimap_analyze': {
      const result = await executeAxis(ch, args.axis_id, { site_id: args.site_id })
      if (!result) return { error: `Unknown axis: ${args.axis_id}` }
      return {
        axis: { id: result.axis.id, name: result.axis.name, category: result.axis.category, cost: result.axis.cost },
        data: result.data,
        ai_hint: result.axis.aiPromptHint,
      }
    }

    case 'ugokimap_multi_analyze': {
      const results = await executeAllAxes(ch, { site_id: args.site_id })
      const output: Record<string, any> = {}
      results.forEach((value, key) => {
        output[key] = {
          name: value.axis.name,
          category: value.axis.category,
          data_count: value.data.length,
          data: value.data.slice(0, 20), // MCPコンテキスト制限: 各軸最大20行
          ai_hint: value.axis.aiPromptHint,
        }
      })
      return output
    }

    case 'ugokimap_heatmap': {
      const heatmapType = args.heatmap_type || 'click'
      const deviceFilter = args.device_type && args.device_type !== 'all' ? ` AND device_type = {device_type:String}` : ''
      const params: Record<string, string> = { site_id: args.site_id, page_url: args.page_url }
      if (args.device_type && args.device_type !== 'all') params.device_type = args.device_type

      if (heatmapType === 'click') {
        const result = await ch.query({
          query: `
            SELECT click_x, click_y, count() as click_count, uniq(session_id) as sessions
            FROM clickinsight.events
            WHERE site_id = {site_id:String} AND url = {page_url:String}
              AND event_type = 'click' AND click_x > 0 AND click_y > 0 ${deviceFilter}
            GROUP BY click_x, click_y
            HAVING click_count >= 2
            ORDER BY click_count DESC LIMIT 500
          `,
          query_params: params, format: 'JSONEachRow',
        })
        return await result.json()
      }

      if (heatmapType === 'scroll') {
        const result = await ch.query({
          query: `
            SELECT intDiv(scroll_y, 100) * 100 as y_zone,
              uniq(session_id) as sessions, avg(scroll_percentage) as avg_pct
            FROM clickinsight.events
            WHERE site_id = {site_id:String} AND url = {page_url:String}
              AND event_type IN ('scroll','scroll_depth') AND scroll_y > 0 ${deviceFilter}
            GROUP BY y_zone ORDER BY y_zone
          `,
          query_params: params, format: 'JSONEachRow',
        })
        return await result.json()
      }

      if (heatmapType === 'read') {
        const result = await ch.query({
          query: `
            SELECT intDiv(read_y, 100) * 100 as y_zone,
              sum(read_duration) as total_ms, avg(read_duration) as avg_ms, uniq(session_id) as sessions
            FROM clickinsight.events
            WHERE site_id = {site_id:String} AND url = {page_url:String}
              AND event_type = 'read_area' AND read_y > 0 ${deviceFilter}
            GROUP BY y_zone ORDER BY total_ms DESC
          `,
          query_params: params, format: 'JSONEachRow',
        })
        return await result.json()
      }

      return { error: 'Invalid heatmap_type' }
    }

    case 'ugokimap_page_friction': {
      const params = { site_id: args.site_id, page_url: args.page_url }

      const [rageDeadResult, formResult] = await Promise.all([
        ch.query({
          query: `
            SELECT event_type, element_text, element_tag_name,
              intDiv(click_y, 100) * 100 as y_zone, count() as count
            FROM clickinsight.events
            WHERE site_id = {site_id:String} AND url = {page_url:String}
              AND event_type IN ('rage_click', 'dead_click')
            GROUP BY event_type, element_text, element_tag_name, y_zone
            HAVING count >= 2
            ORDER BY count DESC LIMIT 20
          `,
          query_params: params, format: 'JSONEachRow',
        }),
        ch.query({
          query: `
            SELECT form_id, field_name, field_type,
              countIf(event_type = 'form_abandon') as abandons,
              countIf(event_type = 'form_submit') as submits,
              avg(field_duration_ms) as avg_field_ms
            FROM clickinsight.form_interactions
            WHERE site_id = {site_id:String} AND page_url = {page_url:String}
            GROUP BY form_id, field_name, field_type
            HAVING abandons > 0
            ORDER BY abandons DESC LIMIT 20
          `,
          query_params: params, format: 'JSONEachRow',
        }),
      ])

      return {
        rage_dead_clicks: await rageDeadResult.json(),
        form_friction: await formResult.json(),
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// MCP stdio protocol handler
function send(response: MCPResponse) {
  const json = JSON.stringify(response)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
}

async function handleRequest(request: MCPRequest) {
  try {
    switch (request.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0', id: request.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'ugokimap', version: '1.0.0' },
          },
        })
        break

      case 'tools/list':
        send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } })
        break

      case 'tools/call': {
        const { name, arguments: args } = request.params
        const result = await handleTool(name, args || {})
        send({
          jsonrpc: '2.0', id: request.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        })
        break
      }

      default:
        send({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
    }
  } catch (error: any) {
    send({
      jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message: error?.message || String(error) },
    })
  }
}

// stdin reader
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = buffer.substring(0, headerEnd)
    const match = header.match(/Content-Length: (\d+)/)
    if (!match) { buffer = buffer.substring(headerEnd + 4); continue }
    const contentLength = parseInt(match[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + contentLength) break
    const body = buffer.substring(bodyStart, bodyStart + contentLength)
    buffer = buffer.substring(bodyStart + contentLength)
    try {
      const request = JSON.parse(body) as MCPRequest
      handleRequest(request)
    } catch (e) {
      console.error('Failed to parse MCP request:', e)
    }
  }
})

process.stderr.write('UGOKI MAP MCP Server started\n')
