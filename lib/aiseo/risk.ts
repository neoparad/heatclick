/**
 * AI訪問のリスク導出（純粋ロジック・UI非依存）。
 * collector の観測（agent別/URL別ヒット）から、確証できる範囲のフラグだけを作る。
 * なりすまし「確定」は collector 分類(spoof)のみ。UA だけでの断定はしない（過大主張しない）。
 * robots違反は robots日次スナップショット enrichment 待ち。
 */

export type RiskType =
  | 'spoof'
  | 'scan_probe'
  | 'unknown_ua'
  | 'known_crawler'
  | 'overcollection'
  | 'robots'

export type RiskSeverity = 'high' | 'med' | 'low'

export interface AgentStat {
  agent: string
  category?: string
  hits: number
  urls_count?: number
}

export interface UrlStat {
  url: string
  hits: number
  top_agents?: Array<{ agent: string; count: number }>
}

export interface ObsEvent {
  seq?: number
  ingest_ts?: number
  origin_ts?: number | null
  url?: string
  status_code?: number
  agent?: string
  category?: string
  claim?: string
  raw_ua?: string | null
  asn?: number | null
}

export interface RiskFlag {
  type: RiskType
  severity: RiskSeverity
  agent: string
  category?: string
  hits: number
  evidence: string
  status: string
  [key: string]: unknown
}

export interface RiskSummary {
  total_hits: number
  unknown_hits: number
  spoof_count: number
  overcollection_count: number
  robots_count: number
}

const LEGIT_AI = new Set([
  'rag_fetcher',
  'training_crawler',
  'agent_executor',
  'search_crawler',
  'web_search',
])
const UNKNOWN_RE = /^(other|empty-?ua|unknown|-|)$/i

export const RISK_LABEL: Record<string, string> = {
  spoof: 'なりすまし確定',
  scan_probe: '脆弱性スキャン',
  unknown_ua: '正体不明UA',
  known_crawler: '既知クローラー(未登録)',
  overcollection: '過剰収集',
  robots: 'robots違反',
}

const SEV_RANK: Record<RiskSeverity, number> = { high: 0, med: 1, low: 2 }

export function sortFlags<T extends { severity: RiskSeverity; hits?: number }>(
  flags: ReadonlyArray<T>,
): T[] {
  return flags
    .slice()
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.hits || 0) - (a.hits || 0))
}

export function deriveRisk(
  agents: ReadonlyArray<AgentStat> = [],
  _urls: ReadonlyArray<UrlStat> = [],
): { summary: RiskSummary; flags: RiskFlag[] } {
  const totalHits = agents.reduce((s, a) => s + (a.hits || 0), 0)
  const flags: RiskFlag[] = []

  for (const a of agents) {
    const cat = a.category || 'unknown'
    if (cat === 'spoof') {
      flags.push({
        type: 'spoof',
        severity: 'high',
        agent: a.agent,
        category: cat,
        hits: a.hits,
        evidence: `collector分類=spoof（UA詐称の確定疑い）・${a.hits}件 / ${a.urls_count ?? 0}URL`,
        status: '実測',
      })
    } else if (cat === 'unknown' || UNKNOWN_RE.test(a.agent || '')) {
      flags.push({
        type: 'unknown_ua',
        severity: a.hits >= 50 ? 'high' : 'med',
        agent: a.agent || '(空UA)',
        category: cat,
        hits: a.hits,
        evidence: `UA不明/未分類・${a.hits}件。なりすまし・無申告ボットの温床（IPレンジ/署名照合で要確認）`,
        status: '実測',
      })
    }
  }

  for (const a of agents) {
    if (!LEGIT_AI.has(a.category || '')) continue
    const intensity = a.urls_count ? a.hits / a.urls_count : a.hits
    if (a.hits >= 20 && intensity >= 3) {
      flags.push({
        type: 'overcollection',
        severity: intensity >= 8 ? 'high' : 'med',
        agent: a.agent,
        category: a.category,
        hits: a.hits,
        evidence: `${a.urls_count ?? 0}URLに${a.hits}件（${intensity.toFixed(1)}件/URL）＝特定ページへの集中収集`,
        status: '実測',
      })
    }
  }

  // robots違反は enrichment（robots日次スナップショット×クロール突合）未接続。
  flags.push({
    type: 'robots',
    severity: 'low',
    agent: '—',
    category: '—',
    hits: 0,
    evidence: 'robots日次スナップショット＋アクセス突合が未接続。配信後に Disallow 違反を判定。',
    status: 'enrichment待ち',
  })

  const sorted = sortFlags(flags)
  return finalize(sorted, totalHits)
}

const KIND_RULES: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: /python-requests|aiohttp|httpx\b/i, kind: 'Pythonスクリプト' },
  { re: /\bcurl\//i, kind: 'curl' },
  { re: /\bwget\b/i, kind: 'wget' },
  { re: /scrapy/i, kind: 'Scrapy' },
  { re: /go-http-client/i, kind: 'Goクライアント' },
  { re: /okhttp|apache-httpclient|\bjava\//i, kind: 'Java/HTTPクライアント' },
  { re: /node-fetch|axios|undici/i, kind: 'Node.jsクライアント' },
  { re: /headless|puppeteer|playwright|phantomjs/i, kind: 'ヘッドレスブラウザ' },
  { re: /\b(bot|crawler|spider|fetch)\b/i, kind: '自称ボット(未登録)' },
]

const KNOWN_CRAWLERS =
  /\b(Ahrefs\w*|SemrushBot|DotBot|MJ12bot|BLEXBot|DataForSeoBot|PetalBot|YandexBot|Baiduspider|SeznamBot|rogerbot|Barkrowler|Bytespider|ImagesiftBot|Timpibot|Diffbot|SiteAuditBot|ScreamingFrog)\b/i

const PROBE_RE =
  /(wp-login|wp-admin|wp-content|wp-includes|xmlrpc\.php|\/\.env\b|\/admin\b|phpmyadmin|\/\.git\/|configuration\.php|\/vendor\/|\.aws\/)/i
const COLLECT_RE =
  /\/(sitemap[\w.-]*\.xml|sitemap_index\.xml|robots\.txt|feed\b|\/rss|atom\.xml|wp-json)/i
const CONTENT_RE =
  /\/(entry|column|item|brand|ranking|guide|product|blog|news|category)\//i

function pn(u: string | undefined): string {
  try {
    return new URL(u || '').pathname || '/'
  } catch {
    return String(u || '/')
  }
}

export type UrlBucketKind = 'probe' | 'collect' | 'content' | 'other'

export function urlBucket(url: string | undefined): UrlBucketKind {
  const u = String(url || '')
  if (PROBE_RE.test(u)) return 'probe'
  if (COLLECT_RE.test(u)) return 'collect'
  if (CONTENT_RE.test(u)) return 'content'
  return 'other'
}

export function eventTs(e: ObsEvent): number {
  return e.origin_ts != null ? Number(e.origin_ts) : Number(e.ingest_ts) || 0
}

export interface BurstInfo {
  count: number
  start: number
  end: number
  spanMs: number
  perMin: number
}

export function detectBurst(
  timestamps: ReadonlyArray<number>,
  windowMs = 60000,
): BurstInfo | null {
  const ts = timestamps
    .map(Number)
    .filter(Boolean)
    .sort((a, b) => a - b)
  if (ts.length < 3) return null
  let best = { count: 1, start: ts[0], end: ts[0] }
  let j = 0
  for (let i = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] > windowMs) j++
    const count = i - j + 1
    if (count > best.count) best = { count, start: ts[j], end: ts[i] }
  }
  if (best.count < 3) return null
  const spanMs = Math.max(best.end - best.start, 0)
  const perMin = spanMs > 0 ? Math.round((best.count / spanMs) * 60000) : best.count * 60
  return { count: best.count, start: best.start, end: best.end, spanMs, perMin }
}

export interface BlankUAProfile {
  hits: number
  uniqueUrls: number
  buckets: Record<UrlBucketKind, number>
  status: { ok: number; redir: number; notfound: number; err: number }
  notFoundRate: number
  burst: BurstInfo | null
  tsSource: 'origin' | 'ingest'
  verdict: string
  verdictSev: 'high' | 'med'
  topProbes: Array<[string, number]>
}

export function profileBlankUA(events: ReadonlyArray<ObsEvent> = []): BlankUAProfile | null {
  const rows = events.filter((e) => e.raw_ua != null && String(e.raw_ua).trim() === '')
  const hits = rows.length
  if (!hits) return null
  const buckets: Record<UrlBucketKind, number> = { probe: 0, collect: 0, content: 0, other: 0 }
  const status = { ok: 0, redir: 0, notfound: 0, err: 0 }
  const urlSet = new Set<string>()
  const probePaths = new Map<string, number>()
  for (const e of rows) {
    const b = urlBucket(e.url)
    buckets[b]++
    if (b === 'probe') {
      const p = pn(e.url)
      probePaths.set(p, (probePaths.get(p) || 0) + 1)
    }
    const c = Number(e.status_code) || 0
    if (c >= 500) status.err++
    else if (c === 404) status.notfound++
    else if (c >= 300) status.redir++
    else status.ok++
    if (e.url) urlSet.add(e.url)
  }
  const hasOrigin = rows.some((e) => e.origin_ts != null)
  const burst = detectBurst(rows.map(eventTs))
  const notFoundRate = status.notfound / hits
  let verdict: string
  let verdictSev: 'high' | 'med'
  if (buckets.probe >= 3 || notFoundRate >= 0.4) {
    verdict = '機械的な脆弱性スキャン'
    verdictSev = 'high'
  } else if (buckets.collect >= buckets.content && buckets.collect > 0) {
    verdict = '無差別クロール/収集'
    verdictSev = 'med'
  } else {
    verdict = '無申告の自動アクセス'
    verdictSev = 'med'
  }
  return {
    hits,
    uniqueUrls: urlSet.size,
    buckets,
    status,
    notFoundRate,
    burst,
    tsSource: hasOrigin ? 'origin' : 'ingest',
    verdict,
    verdictSev,
    topProbes: Array.from(probePaths.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
  }
}

export function guessKind(ua: string | null | undefined): string {
  const u = String(ua || '')
  if (!u.trim()) return 'UAなし'
  const known = u.match(KNOWN_CRAWLERS)
  if (known) return `既知クローラー: ${known[1]}（未登録）`
  for (const r of KIND_RULES) {
    if (r.re.test(u)) return r.kind
  }
  const named = u.match(/(?:^|[\s(;])([A-Za-z][A-Za-z0-9._-]{2,}(?:bot|crawler|spider))[/ ;)]/i)
  if (named) return `自称ボット(未登録): ${named[1]}`
  if (/mozilla\/5\.0/i.test(u)) return 'ブラウザ偽装/一般UA'
  return '不明'
}

export interface UnknownUAGroup {
  raw_ua: string | null
  label: string
  kind: string
  hits: number
  probeHits: number
  asns: number[]
  topUrls: Array<{ url: string; c: number }>
  statuses: Array<{ code: number; c: number }>
  firstTs: number
  lastTs: number
}

export function groupUnknownUA(events: ReadonlyArray<ObsEvent> = []): UnknownUAGroup[] {
  const map = new Map<
    string,
    {
      raw_ua: string | null
      hits: number
      probeHits: number
      asns: Set<number>
      urls: Map<string, number>
      statuses: Map<number, number>
      firstTs: number
      lastTs: number
    }
  >()
  for (const e of events) {
    const ua = e.raw_ua != null ? String(e.raw_ua) : null
    const key = ua === null ? '__noexpose__' : ua.trim() === '' ? '__empty__' : ua
    let g = map.get(key)
    if (!g) {
      g = {
        raw_ua: ua,
        hits: 0,
        probeHits: 0,
        asns: new Set(),
        urls: new Map(),
        statuses: new Map(),
        firstTs: Infinity,
        lastTs: 0,
      }
      map.set(key, g)
    }
    g.hits++
    if (PROBE_RE.test(String(e.url || ''))) g.probeHits++
    if (e.asn != null) g.asns.add(Number(e.asn))
    const u = String(e.url || '')
    g.urls.set(u, (g.urls.get(u) || 0) + 1)
    const code = Number(e.status_code) || 0
    g.statuses.set(code, (g.statuses.get(code) || 0) + 1)
    const ts = Number(e.ingest_ts) || 0
    if (ts) {
      g.firstTs = Math.min(g.firstTs, ts)
      g.lastTs = Math.max(g.lastTs, ts)
    }
  }
  return Array.from(map.values())
    .map((g) => ({
      raw_ua: g.raw_ua,
      label:
        g.raw_ua === null
          ? '(UA非公開 — collector未デプロイ)'
          : g.raw_ua.trim() === ''
            ? '(空UA)'
            : g.raw_ua,
      kind: g.raw_ua === null ? '—' : guessKind(g.raw_ua),
      hits: g.hits,
      probeHits: g.probeHits,
      asns: Array.from(g.asns),
      topUrls: Array.from(g.urls.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([url, c]) => ({ url, c })),
      statuses: Array.from(g.statuses.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([code, c]) => ({ code, c })),
      firstTs: g.firstTs === Infinity ? 0 : g.firstTs,
      lastTs: g.lastTs,
    }))
    .sort((a, b) => b.hits - a.hits)
}

export function unknownFlags(events: ReadonlyArray<ObsEvent> = []): RiskFlag[] {
  const groups = groupUnknownUA(events)
  const flags: RiskFlag[] = []
  for (const g of groups) {
    if (g.raw_ua === null) continue
    const known = g.kind.startsWith('既知クローラー')
    const empty = g.raw_ua.trim() === ''
    if (g.probeHits > 0) {
      flags.push({
        type: 'scan_probe',
        severity: g.probeHits >= 10 ? 'high' : 'med',
        agent: empty ? '(空UA)' : g.kind,
        hits: g.probeHits,
        evidence: `${g.probeHits}/${g.hits}件が wp-login / wp-content / .env 等の探索（脆弱性スキャン痕跡）`,
        status: '実測',
      })
    }
    if (known) {
      flags.push({
        type: 'known_crawler',
        severity: 'low',
        agent: g.kind.replace('既知クローラー: ', '').replace('（未登録）', ''),
        hits: g.hits,
        evidence:
          '既知のクローラーだが collector の classify ルール未登録。ルール追加で正体不明から外れる。',
        status: '実測',
      })
    } else if (empty) {
      flags.push({
        type: 'unknown_ua',
        severity: g.hits >= 50 ? 'high' : 'med',
        agent: '(空UA)',
        hits: g.hits,
        evidence: `UAなし・${g.hits}件。無申告の自動アクセス（IP/署名照合で要確認）。`,
        status: '実測',
      })
    } else {
      flags.push({
        type: 'unknown_ua',
        severity: 'med',
        agent: g.raw_ua.slice(0, 48),
        hits: g.hits,
        evidence: `未分類UA・${g.hits}件（推定: ${g.kind}）。`,
        status: '実測',
      })
    }
  }
  return sortFlags(flags)
}

function finalize(flags: RiskFlag[], totalHits: number): { summary: RiskSummary; flags: RiskFlag[] } {
  const sum = (t: RiskType) =>
    flags.filter((f) => f.type === t && f.status === '実測').reduce((s, f) => s + f.hits, 0)
  const cnt = (t: RiskType) => flags.filter((f) => f.type === t && f.status === '実測').length
  return {
    summary: {
      total_hits: totalHits,
      unknown_hits: sum('unknown_ua'),
      spoof_count: cnt('spoof'),
      overcollection_count: cnt('overcollection'),
      robots_count: 0,
    },
    flags,
  }
}
