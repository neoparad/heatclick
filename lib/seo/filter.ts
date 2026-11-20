/**
 * Pure filter / aggregation helpers for the SEO Access page (ported from aiseo/web/src/app/seo/access/filter.js).
 * Browser-safe pathname normalization (avoids importing node:crypto into client bundles).
 */

export interface SeoPageRow {
  page: string
  clicks: number
  impressions: number
  ctr?: number
  position: number
  clicksDelta?: number | null
  impressionsDelta?: number | null
  positionDelta?: number | null
  queryCount?: number
  topQueries?: Array<{ query: string; clicks: number; impressions: number; position: number }>
  [key: string]: unknown
}

export interface SeoQueryRow {
  query: string
  clicks: number
  impressions: number
  ctr?: number
  position: number
  clicksDelta?: number | null
  impressionsDelta?: number | null
  positionDelta?: number | null
  [key: string]: unknown
}

export interface SeoPairRow {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface SeoDirRow {
  dir: string
  pages: number
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export function pathnameOf(u: string): string {
  const raw = String(u || '').trim()
  if (!raw) return ''
  try {
    const withScheme = /^https?:\/\//i.test(raw)
      ? raw
      : raw.startsWith('/')
      ? `https://example.invalid${raw}`
      : `https://${raw}`
    const parsed = new URL(withScheme)
    const collapsed = parsed.pathname.replace(/\/{2,}/g, '/')
    if (collapsed.length > 1 && collapsed.endsWith('/')) {
      return collapsed.slice(0, -1)
    }
    return collapsed || '/'
  } catch {
    return raw
  }
}

export function dirOf(u: string): string {
  const p = pathnameOf(u)
  const seg = p.split('/').filter(Boolean)[0]
  return seg ? `/${seg}/` : '/'
}

export function groupDirectories(pages: SeoPageRow[] = []): SeoDirRow[] {
  const m = new Map<
    string,
    { dir: string; pages: number; clicks: number; impressions: number; posWeighted: number }
  >()
  for (const p of pages) {
    const dir = dirOf(p.page)
    const cur = m.get(dir) || { dir, pages: 0, clicks: 0, impressions: 0, posWeighted: 0 }
    cur.pages += 1
    cur.clicks += p.clicks || 0
    cur.impressions += p.impressions || 0
    cur.posWeighted += (p.position || 0) * (p.impressions || 0)
    m.set(dir, cur)
  }
  return Array.from(m.values())
    .map((d) => ({
      dir: d.dir,
      pages: d.pages,
      clicks: d.clicks,
      impressions: d.impressions,
      ctr: d.impressions > 0 ? d.clicks / d.impressions : 0,
      position: d.impressions > 0 ? +(d.posWeighted / d.impressions).toFixed(1) : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks)
}

export interface FilterPagesCriteria {
  dir?: string | null
  q?: string
}

export function filterPages(
  pages: SeoPageRow[] = [],
  { dir = null, q = '' }: FilterPagesCriteria = {}
): SeoPageRow[] {
  const qlc = (q || '').trim().toLowerCase()
  return pages.filter((p) => {
    if (dir && dirOf(p.page) !== dir) return false
    if (qlc && !pathnameOf(p.page).toLowerCase().includes(qlc)) return false
    return true
  })
}

export interface FilterQueriesCriteria {
  dir?: string | null
  page?: string | null
  q?: string
  pairs?: SeoPairRow[]
}

export function filterQueries(
  queries: SeoQueryRow[] = [],
  { dir = null, page = null, q = '', pairs = [] }: FilterQueriesCriteria = {}
): SeoQueryRow[] {
  const qlc = (q || '').trim().toLowerCase()

  if (!dir && !page) {
    return qlc ? queries.filter((r) => (r.query || '').toLowerCase().includes(qlc)) : queries
  }

  const byQuery = new Map<
    string,
    { query: string; clicks: number; impressions: number; posWeighted: number }
  >()
  for (const r of pairs) {
    if (page && r.page !== page) continue
    if (dir && dirOf(r.page) !== dir) continue
    if (qlc && !(r.query || '').toLowerCase().includes(qlc)) continue
    const cur = byQuery.get(r.query) || { query: r.query, clicks: 0, impressions: 0, posWeighted: 0 }
    cur.clicks += r.clicks || 0
    cur.impressions += r.impressions || 0
    cur.posWeighted += (r.position || 0) * (r.impressions || 0)
    byQuery.set(r.query, cur)
  }

  const deltaByQ = new Map(queries.map((x) => [x.query, x]))
  return Array.from(byQuery.values())
    .map((cur) => {
      const base = deltaByQ.get(cur.query)
      const ctr = cur.impressions > 0 ? cur.clicks / cur.impressions : 0
      const position = cur.impressions > 0 ? +(cur.posWeighted / cur.impressions).toFixed(1) : 0
      return {
        query: cur.query,
        clicks: cur.clicks,
        impressions: cur.impressions,
        ctr,
        position,
        clicksDelta: page || dir ? null : base?.clicksDelta ?? null,
        impressionsDelta: page || dir ? null : base?.impressionsDelta ?? null,
        positionDelta: page || dir ? null : base?.positionDelta ?? null,
      }
    })
    .sort((a, b) => b.clicks - a.clicks)
}

export function rollupTotals(rows: Array<{ clicks?: number; impressions?: number; position?: number }> = []) {
  let clicks = 0
  let impressions = 0
  let posW = 0
  for (const r of rows) {
    clicks += r.clicks || 0
    impressions += r.impressions || 0
    posW += (r.position || 0) * (r.impressions || 0)
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? +(posW / impressions).toFixed(1) : 0,
  }
}
