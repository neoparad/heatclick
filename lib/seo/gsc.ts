/**
 * Google Search Console API client (Service Account JWT -> access_token -> REST).
 *
 * Auth config (checked in order):
 *   1. GSC_SA_KEY_JSON — raw service account JSON string
 *   2. GSC_SA_KEY_FILE — path to service account JSON file (local dev only)
 *
 * Never hardcode key filenames in the repository.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

interface ServiceAccountKey {
  client_email: string
  private_key: string
}

let cachedToken: { token: string; exp: number } | null = null

function loadKey(): ServiceAccountKey {
  if (process.env.GSC_SA_KEY_JSON) {
    return JSON.parse(process.env.GSC_SA_KEY_JSON) as ServiceAccountKey
  }
  const file = process.env.GSC_SA_KEY_FILE
  if (!file) {
    throw new Error('GSC_SA_KEY_JSON or GSC_SA_KEY_FILE not configured')
  }
  const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file)
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as ServiceAccountKey
}

export function isGscConfigured(): boolean {
  if (process.env.GSC_SA_KEY_JSON && process.env.GSC_SA_KEY_JSON.trim().length > 0) {
    return true
  }
  if (process.env.GSC_SA_KEY_FILE) {
    try {
      const resolved = path.isAbsolute(process.env.GSC_SA_KEY_FILE)
        ? process.env.GSC_SA_KEY_FILE
        : path.join(process.cwd(), process.env.GSC_SA_KEY_FILE)
      return fs.existsSync(resolved)
    } catch {
      return false
    }
  }
  return false
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.exp - 60 > now) {
    return cachedToken.token
  }
  const key = loadKey()
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  )
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const sig = b64url(signer.sign(key.private_key))
  const assertion = `${header}.${claim}.${sig}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`GSC token failed: ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number }
  cachedToken = { token: json.access_token, exp: now + (json.expires_in || 3600) }
  return cachedToken.token
}

export interface GscRow {
  keys?: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface GscSearchAnalyticsOptions {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
  dimensionFilterGroups?: unknown[]
}

export async function querySearchAnalytics(
  siteUrl: string,
  { startDate, endDate, dimensions = [], rowLimit = 1000, dimensionFilterGroups }: GscSearchAnalyticsOptions
): Promise<GscRow[]> {
  const token = await getAccessToken()
  const encoded = encodeURIComponent(siteUrl)
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`
  const body: Record<string, unknown> = { startDate, endDate, dimensions, rowLimit }
  if (dimensionFilterGroups) body.dimensionFilterGroups = dimensionFilterGroups

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`GSC query (${dimensions.join(',')}) ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as { rows?: GscRow[] }
  return json.rows || []
}

export async function inspectUrl(siteUrl: string, inspectionUrl: string): Promise<Record<string, unknown>> {
  const token = await getAccessToken()
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'ja' }),
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`URL inspection (${inspectionUrl}) ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as { inspectionResult?: { indexStatusResult?: Record<string, unknown> } }
  return json.inspectionResult?.indexStatusResult || {}
}

export async function fetchSitemapUrls(sitemapUrl: string, maxUrls = 10000): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []

  async function walk(url: string, depth: number): Promise<void> {
    if (depth > 3 || seen.has(url) || out.length >= maxUrls) return
    seen.add(url)
    const res = await fetch(url, {
      headers: { 'User-Agent': 'aiseo-sitemap-inspector/1.0' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`sitemap fetch ${url}: ${res.status}`)
    const xml = await res.text()
    const isIndex = /<sitemapindex[\s>]/i.test(xml)
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
      m[1].trim()
    )
    if (isIndex) {
      for (const child of locs) {
        if (out.length >= maxUrls) break
        await walk(child, depth + 1)
      }
    } else {
      for (const u of locs) {
        if (out.length >= maxUrls) break
        out.push(u)
      }
    }
  }

  await walk(sitemapUrl, 0)
  return out
}

export function dateStr(daysAgo: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}
