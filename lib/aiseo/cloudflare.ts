/**
 * Cloudflare GraphQL Analytics（読み取り専用）で、検索エンジンのクローラーの取得を集計する。
 * トークンは顧客が発行した「Zone → Analytics → Read」だけのもの。サーバ内でのみ使う。
 */

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'

export interface CloudflareClientOptions {
  token?: string
  zoneId?: string
}

function getCfConfig(opts: CloudflareClientOptions = {}) {
  const token = opts.token ?? process.env.CLOUDFLARE_ANALYTICS_TOKEN ?? ''
  const zoneId = opts.zoneId ?? process.env.CLOUDFLARE_ZONE_ID ?? ''
  return { token, zoneId }
}

export function cloudflareConfigured(opts: CloudflareClientOptions = {}): boolean {
  const { token, zoneId } = getCfConfig(opts)
  return Boolean(token && zoneId)
}

export interface SearchBotDef {
  family: 'Google' | 'Bing'
  agent: string
  like: string
}

export const SEARCH_BOTS: ReadonlyArray<SearchBotDef> = [
  { family: 'Google', agent: 'Google-InspectionTool', like: '%Google-InspectionTool%' },
  { family: 'Google', agent: 'Storebot-Google', like: '%Storebot-Google%' },
  { family: 'Google', agent: 'AdsBot-Google', like: '%AdsBot-Google%' },
  { family: 'Google', agent: 'Googlebot', like: '%Googlebot%' },
  { family: 'Bing', agent: 'AdIdxBot', like: '%adidxbot%' },
  { family: 'Bing', agent: 'BingPreview', like: '%BingPreview%' },
  { family: 'Bing', agent: 'Bingbot', like: '%bingbot%' },
]

export function botOf(ua = ''): SearchBotDef | null {
  const u = ua.toLowerCase()
  for (const b of SEARCH_BOTS) {
    if (u.includes(b.like.replace(/%/g, '').toLowerCase())) return b
  }
  return null
}

const QUERY = `
query SearchCrawlers($zone: String!, $since: Time!, $until: Time!, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      byUa: httpRequestsAdaptiveGroups(limit: 200, filter: $filter, orderBy: [count_DESC]) {
        count
        dimensions { userAgent edgeResponseStatus }
      }
      byDay: httpRequestsAdaptiveGroups(limit: 500, filter: $filter, orderBy: [date_ASC]) {
        count
        dimensions { date userAgent }
      }
      byPath: httpRequestsAdaptiveGroups(limit: 50, filter: $filter, orderBy: [count_DESC]) {
        count
        dimensions { clientRequestPath }
      }
    }
  }
}`

export interface CloudflareCrawlerSummary {
  period: { since: string; until: string; days: number }
  agents: Array<{
    agent: string
    family: 'Google' | 'Bing'
    hits: number
    status: Record<string, number>
  }>
  daily: Array<{ date: string; Google: number; Bing: number }>
  paths: Array<{ path: string; hits: number }>
}

export async function fetchSearchCrawlers(
  days = 7,
  opts: CloudflareClientOptions = {},
): Promise<CloudflareCrawlerSummary> {
  const { token, zoneId } = getCfConfig(opts)
  const d = Math.min(30, Math.max(1, Number(days) || 7))
  const until = new Date()
  const since = new Date(until.getTime() - d * 86400000)
  const filter = {
    datetime_geq: since.toISOString(),
    datetime_lt: until.toISOString(),
    requestSource: 'eyeball',
    OR: SEARCH_BOTS.map((b) => ({ userAgent_like: b.like })),
  }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        zone: zoneId,
        since: since.toISOString(),
        until: until.toISOString(),
        filter,
      },
    }),
    cache: 'no-store',
  })
  const body = (await r.json().catch(() => ({}))) as {
    errors?: Array<{ message: string }>
    data?: {
      viewer?: {
        zones?: Array<{
          byUa?: Array<{
            count: number
            dimensions: { userAgent: string; edgeResponseStatus: number }
          }>
          byDay?: Array<{
            count: number
            dimensions: { date: string; userAgent: string }
          }>
          byPath?: Array<{
            count: number
            dimensions: { clientRequestPath: string }
          }>
        }>
      }
    }
  }
  if (!r.ok || body.errors?.length) {
    const msg = body.errors?.map((e) => e.message).join(' / ') || `HTTP ${r.status}`
    throw new Error(`Cloudflare GraphQL: ${msg}`)
  }
  const z = body.data?.viewer?.zones?.[0] || {}
  return summarize(z, { since: since.toISOString(), until: until.toISOString(), days: d })
}

function summarize(
  z: {
    byUa?: Array<{ count: number; dimensions: { userAgent: string; edgeResponseStatus: number } }>
    byDay?: Array<{ count: number; dimensions: { date: string; userAgent: string } }>
    byPath?: Array<{ count: number; dimensions: { clientRequestPath: string } }>
  },
  period: { since: string; until: string; days: number },
): CloudflareCrawlerSummary {
  const agents = new Map<
    string,
    { agent: string; family: 'Google' | 'Bing'; hits: number; status: Record<string, number> }
  >()
  for (const row of z.byUa || []) {
    const b = botOf(row.dimensions.userAgent)
    if (!b) continue
    const a = agents.get(b.agent) || {
      agent: b.agent,
      family: b.family,
      hits: 0,
      status: {},
    }
    a.hits += row.count
    const cls = statusClass(row.dimensions.edgeResponseStatus)
    a.status[cls] = (a.status[cls] || 0) + row.count
    agents.set(b.agent, a)
  }
  const daily = new Map<string, { date: string; Google: number; Bing: number }>()
  for (const row of z.byDay || []) {
    const b = botOf(row.dimensions.userAgent)
    if (!b) continue
    const key = row.dimensions.date
    const e = daily.get(key) || { date: key, Google: 0, Bing: 0 }
    e[b.family] += row.count
    daily.set(key, e)
  }
  return {
    period,
    agents: Array.from(agents.values()).sort((x, y) => y.hits - x.hits),
    daily: Array.from(daily.values()).sort((x, y) => (x.date < y.date ? -1 : 1)),
    paths: (z.byPath || []).map((row) => ({
      path: row.dimensions.clientRequestPath,
      hits: row.count,
    })),
  }
}

function statusClass(s: number): string {
  if (s >= 500) return '5xx'
  if (s === 429) return '429'
  if (s >= 400) return '4xx'
  if (s >= 300) return '3xx'
  return '2xx'
}
