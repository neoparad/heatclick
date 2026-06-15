/**
 * M-Director Stage 1 (続 M-7/M-8) — Cloudflare KV REST API client for scenarios
 *
 * Reference:
 *   - 続 M-7 §2 (Storage 判断変更 PostgreSQL → KV)
 *   - 続 M-7 §3 (KV key 設計)
 *   - Main Director 続 91 `cf_kv_client.py` (Python 同等実装、parity 維持)
 *
 * Why fetch over @cloudflare/workers-types KV binding:
 *   - This module runs on Vercel Functions (Next.js API routes), not on Cloudflare Workers.
 *   - CF Worker KV binding is unavailable; must use REST API via fetch().
 *   - CF_API_TOKEN scope: Workers KV Storage > Edit (続 99 で発行済の wrangler token を再利用)。
 *
 * Key prefix discipline (続 M-7 §3):
 *   - scenarios:        `scenarios/{tenant_id}/{site_id}/{scenario_id}`
 *   - scenario assets:  `scenario_assets/{tenant_id}/{scenario_id}/{asset_id}`
 *   - 既存 Main Director namespace (RULE_BUNDLES_KV id=e956e76f...) を共有、prefix 分離で衝突回避。
 */

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareKvConfig {
  accountId: string
  apiToken: string
  namespaceId: string
}

export class CloudflareKvError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cfErrors?: unknown,
  ) {
    super(message)
    this.name = 'CloudflareKvError'
  }
}

export function getKvConfigFromEnv(): CloudflareKvConfig {
  const accountId = process.env.CF_ACCOUNT_ID
  const apiToken = process.env.CF_API_TOKEN
  const namespaceId = process.env.RULE_BUNDLES_KV_NS_ID
  if (!accountId || !apiToken || !namespaceId) {
    throw new CloudflareKvError(
      'Cloudflare KV env missing: CF_ACCOUNT_ID / CF_API_TOKEN / RULE_BUNDLES_KV_NS_ID',
    )
  }
  return { accountId, apiToken, namespaceId }
}

/**
 * Minimal interface used by `repository.ts`. Tests can supply an in-memory
 * implementation via dependency injection instead of HTTP-mocking.
 */
export interface KvStorage {
  getJson<T = unknown>(key: string): Promise<T | null>
  putJson(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  listKeys(prefix?: string): Promise<string[]>
}

export class CloudflareKvStorage implements KvStorage {
  constructor(
    private readonly config: CloudflareKvConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private keyUrl(key: string): string {
    // Cloudflare KV REST API allows `/` inside the key portion; encode the
    // rest of the path components but preserve slashes.
    const safeKey = encodeURI(key)
    return (
      `${CLOUDFLARE_API_BASE}/accounts/${this.config.accountId}/storage/kv/namespaces/` +
      `${this.config.namespaceId}/values/${safeKey}`
    )
  }

  private nsUrl(suffix: string): string {
    return (
      `${CLOUDFLARE_API_BASE}/accounts/${this.config.accountId}/storage/kv/namespaces/` +
      `${this.config.namespaceId}${suffix}`
    )
  }

  private authHeaders(extra: Record<string, string> = {}): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.apiToken}`,
      ...extra,
    }
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const resp = await this.fetchImpl(this.keyUrl(key), {
      method: 'GET',
      headers: this.authHeaders(),
      cache: 'no-store',
    })
    if (resp.status === 404) return null
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new CloudflareKvError(
        `GET ${key} failed: status=${resp.status} body=${body.slice(0, 256)}`,
        resp.status,
      )
    }
    const text = await resp.text()
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new CloudflareKvError(
        `GET ${key} returned non-JSON body: ${(e as Error).message}`,
        resp.status,
      )
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value)
    const resp = await this.fetchImpl(this.keyUrl(key), {
      method: 'PUT',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new CloudflareKvError(
        `PUT ${key} failed: status=${resp.status} body=${text.slice(0, 256)}`,
        resp.status,
      )
    }
  }

  async delete(key: string): Promise<boolean> {
    const resp = await this.fetchImpl(this.keyUrl(key), {
      method: 'DELETE',
      headers: this.authHeaders(),
    })
    if (resp.status === 404) return false
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new CloudflareKvError(
        `DELETE ${key} failed: status=${resp.status} body=${text.slice(0, 256)}`,
        resp.status,
      )
    }
    return true
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const collected: string[] = []
    let cursor: string | null = null
    // Loop with cursor; CF returns max 1000 keys per page.
    // Phase 2 scenarios row count <= 10k (data-model.md §1) → at most ~10 pages.
    for (;;) {
      const params = new URLSearchParams({ limit: '1000' })
      if (prefix !== undefined && prefix.length > 0) params.set('prefix', prefix)
      if (cursor) params.set('cursor', cursor)
      const resp = await this.fetchImpl(this.nsUrl(`/keys?${params.toString()}`), {
        method: 'GET',
        headers: this.authHeaders(),
        cache: 'no-store',
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new CloudflareKvError(
          `LIST prefix=${prefix ?? ''} failed: status=${resp.status} body=${text.slice(0, 256)}`,
          resp.status,
        )
      }
      const body = (await resp.json()) as {
        result?: Array<{ name: string }>
        result_info?: { cursor?: string | null }
      }
      for (const entry of body.result ?? []) {
        if (typeof entry?.name === 'string') collected.push(entry.name)
      }
      const next = body.result_info?.cursor ?? ''
      if (!next) break
      cursor = next
    }
    return collected
  }
}

/**
 * Default storage built from env at call time. Tests inject `InMemoryKvStorage`
 * instead via `setStorageForTesting`. Production paths call this directly.
 */
let _storage: KvStorage | null = null

export function getDefaultStorage(): KvStorage {
  if (_storage) return _storage
  _storage = new CloudflareKvStorage(getKvConfigFromEnv())
  return _storage
}

export function setStorageForTesting(storage: KvStorage | null): void {
  _storage = storage
}
