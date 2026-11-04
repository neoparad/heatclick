/**
 * M-Director Stage 1 (続 M-7/M-8) — Cloudflare KV REST API client for scenarios
 *
 * Key prefix discipline (続 M-7 §3):
 *   - scenarios:        `scenarios/{tenant_id}/{site_id}/{scenario_id}`
 *   - scenario assets:  `scenario_assets/{tenant_id}/{scenario_id}/{asset_id}`
 */

import { POC_SCENARIOS } from './poc-scenario'

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

/**
 * In-memory fallback KV storage used when CF_ACCOUNT_ID / CF_API_TOKEN / RULE_BUNDLES_KV_NS_ID
 * are not configured in local dev or preview environments. Pre-seeded with POC_SCENARIOS so
 * editing/saving existing POC scenarios or creating new scenarios works seamlessly without 502/404.
 */
export class InMemoryFallbackKvStorage implements KvStorage {
  private readonly store = new Map<string, string>()

  constructor(seedPoc = true) {
    if (seedPoc) {
      for (const s of POC_SCENARIOS) {
        const key = `scenarios/${s.tenant_id}/${s.site_id}/${s.id}`
        this.store.set(key, JSON.stringify(s))
        const idxKey = `scenario-index/${s.tenant_id}/${s.site_id}`
        const existing = this.store.get(idxKey)
        const ids: string[] = existing ? (JSON.parse(existing) as string[]) : []
        if (!ids.includes(s.id)) {
          ids.push(s.id)
          this.store.set(idxKey, JSON.stringify(ids))
        }
      }
    }
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const raw = this.store.get(key)
    if (raw === undefined) return null
    return JSON.parse(raw) as T
  }

  async putJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value))
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const out: string[] = []
    for (const k of this.store.keys()) {
      if (!prefix || k.startsWith(prefix)) {
        out.push(k)
      }
    }
    return out
  }
}

export class CloudflareKvStorage implements KvStorage {
  constructor(
    private readonly config: CloudflareKvConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private keyUrl(key: string): string {
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

let _storage: KvStorage | null = null
let _fallbackStorage: InMemoryFallbackKvStorage | null = null

export function getDefaultStorage(): KvStorage {
  if (_storage) return _storage
  const accountId = process.env.CF_ACCOUNT_ID
  const apiToken = process.env.CF_API_TOKEN
  const namespaceId = process.env.RULE_BUNDLES_KV_NS_ID
  if (accountId && apiToken && namespaceId) {
    _storage = new CloudflareKvStorage({ accountId, apiToken, namespaceId })
    return _storage
  }
  if (!_fallbackStorage) {
    _fallbackStorage = new InMemoryFallbackKvStorage(true)
  }
  return _fallbackStorage
}

export function setStorageForTesting(storage: KvStorage | null): void {
  _storage = storage
}
