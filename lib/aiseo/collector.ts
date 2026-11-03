/**
 * AIreceipt collector read API クライアント（共通）。
 *
 * 認証モード (PLAN.md D3 / S3):
 *   1. 推奨 (SaaS BFF read-only): `AIRECEIPT_READ_KEY` + 対象サイトの `aireceiptSiteId`
 *      Header: `X-Aireceipt-Principal: saas-read`, `X-Aireceipt-Site: <siteId>`
 *      署名対象パス: `${pathname}:${siteId}`（サイトIDを暗号学的に束縛）
 *   2. フォールバック (レガシー per-install): `AIRECEIPT_INSTALL_ID` + `AIRECEIPT_INSTALL_KEY`
 *      Header: `X-Aireceipt-Install: <installId>`
 *      署名対象パス: `${pathname}`
 */

import crypto from 'node:crypto'

export interface CollectorClientOptions {
  baseUrl?: string
  readKey?: string
  siteId?: string
  installId?: string
  installKey?: string
}

function getEnvConfig(opts: CollectorClientOptions = {}) {
  const baseUrl = (opts.baseUrl ?? process.env.AIRECEIPT_COLLECTOR_URL ?? '').replace(/\/$/, '')
  const readKey = opts.readKey ?? process.env.AIRECEIPT_READ_KEY ?? ''
  const siteId = opts.siteId ?? process.env.AIRECEIPT_SITE_ID ?? ''
  const installId = opts.installId ?? process.env.AIRECEIPT_INSTALL_ID ?? ''
  const installKey = opts.installKey ?? process.env.AIRECEIPT_INSTALL_KEY ?? ''
  return { baseUrl, readKey, siteId, installId, installKey }
}

export function collectorConfigured(opts: CollectorClientOptions = {}): boolean {
  const { baseUrl, readKey, siteId, installId, installKey } = getEnvConfig(opts)
  if (!baseUrl) return false
  if (readKey && siteId) return true
  if (installId && installKey) return true
  return false
}

const b64u = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function signCollectorRequest(
  keyB64: string,
  ts: string,
  method: string,
  boundPath: string,
  body = '',
): string {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex')
  const canonical = `${ts}\n${method}\n${boundPath}\n${bodyHash}`
  const mac = crypto
    .createHmac('sha256', Buffer.from(keyB64, 'base64'))
    .update(canonical)
    .digest()
  return b64u(mac)
}

export function buildCollectorAuthHeaders(
  pathname: string,
  opts: CollectorClientOptions & { ts?: string; method?: string; body?: string } = {},
): Record<string, string> {
  const { readKey, siteId, installId, installKey } = getEnvConfig(opts)
  const ts = opts.ts ?? String(Date.now())
  const method = opts.method ?? 'GET'
  const body = opts.body ?? ''

  if (readKey && siteId) {
    const boundPath = `${pathname}:${siteId}`
    const sig = signCollectorRequest(readKey, ts, method, boundPath, body)
    return {
      'X-Aireceipt-Principal': 'saas-read',
      'X-Aireceipt-Site': siteId,
      'X-Aireceipt-Ts': ts,
      'X-Aireceipt-Sig': sig,
    }
  }

  if (installId && installKey) {
    const sig = signCollectorRequest(installKey, ts, method, pathname, body)
    return {
      'X-Aireceipt-Install': installId,
      'X-Aireceipt-Ts': ts,
      'X-Aireceipt-Sig': sig,
    }
  }

  throw new Error('AIreceipt collector credentials are not configured')
}

export async function collectorGet<T = Record<string, unknown>>(
  pathname: string,
  query = '',
  opts: CollectorClientOptions = {},
): Promise<T> {
  const { baseUrl } = getEnvConfig(opts)
  if (!baseUrl) {
    throw new Error('AIRECEIPT_COLLECTOR_URL is not configured')
  }
  const headers = buildCollectorAuthHeaders(pathname, { ...opts, method: 'GET', body: '' })
  const r = await fetch(`${baseUrl}${pathname}${query}`, {
    headers,
    cache: 'no-store',
  })
  if (!r.ok) {
    throw new Error(`${pathname} -> ${r.status}`)
  }
  return (await r.json()) as T
}

export function rangeQuery(days = 30): { from: string; to: string; q: string } {
  const d = Math.min(90, Math.max(1, Number(days) || 30))
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - (d - 1) * 86400000).toISOString().slice(0, 10)
  return { from, to, q: `?from=${from}&to=${to}` }
}
