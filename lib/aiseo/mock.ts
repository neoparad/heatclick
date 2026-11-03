/**
 * AIアクセス・リスク・ジャーニーの決定論的 mock（collector 未接続時のフォールバック / デモ）。
 */

import { deriveRisk, type AgentStat, type ObsEvent, type RiskFlag, type RiskSummary, type UrlStat } from './risk'

const AGENTS: AgentStat[] = [
  { agent: 'AhrefsSiteAudit', category: 'seo_crawler', hits: 107, urls_count: 64 },
  { agent: 'AhrefsBot', category: 'seo_crawler', hits: 28, urls_count: 22 },
  { agent: 'facebookexternalhit', category: 'social_unfurl', hits: 14, urls_count: 12 },
  { agent: 'Twitterbot', category: 'social_unfurl', hits: 6, urls_count: 6 },
  { agent: 'GPTBot', category: 'training_crawler', hits: 142, urls_count: 9 },
  { agent: 'ChatGPT-User', category: 'rag_fetcher', hits: 35, urls_count: 31 },
  { agent: 'Claude-SearchBot', category: 'search_crawler', hits: 12, urls_count: 11 },
  { agent: 'PerplexityBot', category: 'rag_fetcher', hits: 8, urls_count: 8 },
  { agent: 'ClaudeBot', category: 'training_crawler', hits: 5, urls_count: 5 },
  { agent: 'GPTBot(詐称疑い)', category: 'spoof', hits: 21, urls_count: 2 },
  { agent: 'empty-ua', category: 'unknown', hits: 63, urls_count: 40 },
  { agent: 'other', category: 'unknown', hits: 141, urls_count: 120 },
]

const URLS: UrlStat[] = [
  {
    url: 'https://bihadashop.jp/robots.txt',
    hits: 68,
    top_agents: [
      { agent: 'GPTBot', count: 32 },
      { agent: 'AhrefsSiteAudit', count: 24 },
      { agent: 'Claude-SearchBot', count: 12 },
    ],
  },
  {
    url: 'https://bihadashop.jp/sitemap.xml',
    hits: 54,
    top_agents: [
      { agent: 'GPTBot', count: 28 },
      { agent: 'AhrefsBot', count: 18 },
      { agent: 'PerplexityBot', count: 8 },
    ],
  },
  {
    url: 'https://bihadashop.jp/entry/tirtir-cushion-foundation',
    hits: 49,
    top_agents: [
      { agent: 'GPTBot', count: 29 },
      { agent: 'ChatGPT-User', count: 14 },
      { agent: 'PerplexityBot', count: 6 },
    ],
  },
  {
    url: 'https://bihadashop.jp/entry/anua-serum',
    hits: 38,
    top_agents: [
      { agent: 'GPTBot', count: 21 },
      { agent: 'ChatGPT-User', count: 11 },
      { agent: 'Claude-SearchBot', count: 6 },
    ],
  },
  {
    url: 'https://bihadashop.jp/entry/vt-reedle-all',
    hits: 31,
    top_agents: [
      { agent: 'GPTBot', count: 19 },
      { agent: 'ChatGPT-User', count: 10 },
      { agent: 'ClaudeBot', count: 2 },
    ],
  },
  {
    url: 'https://bihadashop.jp/column/retinol',
    hits: 22,
    top_agents: [
      { agent: 'GPTBot', count: 13 },
      { agent: 'Claude-SearchBot', count: 6 },
      { agent: 'ClaudeBot', count: 3 },
    ],
  },
]

const T0_RISK = Date.UTC(2026, 5, 20, 3, 0, 0)

function ue(
  seq: number,
  tSec: number,
  ua: string,
  asn: number,
  path: string,
  status = 200,
): ObsEvent {
  return {
    seq,
    ingest_ts: T0_RISK + tSec * 1000 + 60000,
    origin_ts: T0_RISK + tSec * 1000,
    url: 'https://bihadashop.jp' + path,
    status_code: status,
    agent: ua.trim() === '' ? 'empty-ua' : 'other',
    category: 'unknown',
    claim: 'received_origin_log',
    raw_ua: ua,
    asn,
  }
}

const PROBE_PATHS = ['/wp-login.php', '/.env', '/xmlrpc.php', '/.git/config', '/wp-admin/', '/']

const UNKNOWN_EVENTS: ObsEvent[] = [
  ...Array.from({ length: 40 }, (_, i) =>
    ue(
      5000 + i,
      i * 600,
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      14618,
      ['/', '/robots.txt', '/entry/anua-serum'][i % 3],
    ),
  ),
  ...Array.from({ length: 28 }, (_, i) =>
    ue(
      6000 + i,
      100000 + i * 3,
      '',
      0,
      PROBE_PATHS[i % PROBE_PATHS.length],
      i % PROBE_PATHS.length === 5 ? 200 : 404,
    ),
  ),
  ...Array.from({ length: 18 }, (_, i) =>
    ue(
      7000 + i,
      i * 900,
      'Mozilla/5.0 (compatible; SomeScraper/1.2; +http://example.com/about)',
      4837,
      ['/column/retinol', '/entry/vt-mask-all'][i % 2],
    ),
  ),
  ...Array.from({ length: 9 }, (_, i) =>
    ue(8000 + i, i * 1200, 'python-requests/2.31.0', 16509, '/entry/anua-serum'),
  ),
]

export interface VisitRiskPayload {
  updatedAt: string
  site_label: string
  source: 'mock' | 'live'
  range: { from: string; to: string }
  summary: RiskSummary
  flags: RiskFlag[]
  agents: AgentStat[]
  unknown_events: ObsEvent[]
}

export function generateMockVisitRisk(siteLabel = 'bihadashop.jp (mock)'): VisitRiskPayload {
  const { summary, flags } = deriveRisk(AGENTS, [])
  return {
    updatedAt: '2026-06-28T00:00:00Z',
    site_label: siteLabel,
    source: 'mock',
    range: { from: '2026-05-30', to: '2026-06-28' },
    summary,
    flags,
    agents: AGENTS,
    unknown_events: UNKNOWN_EVENTS,
  }
}

export interface AnalyticsPayload {
  source: 'mock' | 'live'
  site_label: string
  fetched_at: string
  urls: {
    period: { dates: string[] }
    ruleset_version: string
    total: number
    urls: UrlStat[]
  }
  agents: {
    period: { dates: string[] }
    ruleset_version: string
    total: number
    agents: AgentStat[]
  }
}

export function generateMockAnalytics(siteLabel = 'bihadashop.jp (mock)'): AnalyticsPayload {
  const dates = ['2026-05-30', '2026-06-28']
  return {
    source: 'mock',
    site_label: siteLabel,
    fetched_at: '2026-06-28T00:00:00Z',
    urls: {
      period: { dates },
      ruleset_version: 'r3-mock',
      total: URLS.length,
      urls: URLS,
    },
    agents: {
      period: { dates },
      ruleset_version: 'r3-mock',
      total: AGENTS.length,
      agents: AGENTS,
    },
  }
}

const BASE = 'https://bihadashop.jp'
const T0_JOURNEY = Date.UTC(2026, 5, 26, 9, 0, 0)

function ev(
  seq: number,
  tOffsetSec: number,
  path: string,
  agent: string,
  category: string,
  status = 200,
): ObsEvent {
  return {
    seq,
    ingest_ts: T0_JOURNEY + tOffsetSec * 1000 + 60000,
    origin_ts: T0_JOURNEY + tOffsetSec * 1000,
    url: BASE + path,
    status_code: status,
    agent,
    category,
    claim: 'received_origin_log',
  }
}

export interface JourneyPayload {
  updatedAt: string
  site_label: string
  source: 'mock' | 'live'
  range: { from: string; to: string }
  agents: AgentStat[]
  events: ObsEvent[]
  truncated: boolean
}

export function generateMockJourney(siteLabel = 'bihadashop.jp (mock)'): JourneyPayload {
  let seq = 1000
  const next = () => ++seq
  const events: ObsEvent[] = []

  const gptPaths = [
    '/sitemap.xml',
    '/entry/tirtir-cushion-foundation',
    '/entry/vt-reedle-all',
    '/entry/vt-mask-all',
    '/entry/anua-serum',
    '/robots.txt',
  ]
  gptPaths.forEach((p, i) => events.push(ev(next(), i * 12, p, 'GPTBot', 'training_crawler', 200)))

  ;['/entry/tirtir-cushion-foundation', '/ranking/best-foundation'].forEach((p, i) =>
    events.push(ev(next(), 4000 + i * 8, p, 'ChatGPT-User', 'rag_fetcher')),
  )
  ;['/entry/vt-reedle-all', '/column/retinol', '/entry/vt-reedle-all'].forEach((p, i) =>
    events.push(ev(next(), 9000 + i * 15, p, 'ChatGPT-User', 'rag_fetcher')),
  )

  events.push(ev(next(), 6000, '/entry/anua-serum', 'PerplexityBot', 'rag_fetcher'))

  const agents: AgentStat[] = [
    { agent: 'GPTBot', category: 'training_crawler', hits: 6, urls_count: 6 },
    { agent: 'ChatGPT-User', category: 'rag_fetcher', hits: 5, urls_count: 4 },
    { agent: 'PerplexityBot', category: 'rag_fetcher', hits: 1, urls_count: 1 },
  ]

  return {
    updatedAt: '2026-06-28T00:00:00Z',
    site_label: siteLabel,
    source: 'mock',
    range: { from: '2026-05-30', to: '2026-06-28' },
    agents,
    events,
    truncated: false,
  }
}
