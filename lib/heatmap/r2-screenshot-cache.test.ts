/**
 * Unit tests: r2-screenshot-cache (L2 R2 cache + TTL + SWR + dedupe + key schema)
 *
 * 親 SSOT §3.6.5 / §3.8.1
 * Dispatch: 続 perf heatmap screenshot R2 cache (Phase 1 MVP)
 *
 * 戦略: Microlink + R2 への fetch を in-memory store で mock し、tier 判定 (l1 / r2-fresh /
 *       r2-stale / capture / degraded) と TTL/SWR/dedupe/tenant-isolation を検証する。
 */

import {
  buildR2Keys,
  getHeatmapUnderlayWithR2Cache,
  type R2CacheHooks,
} from './r2-screenshot-cache'
import { _resetScreenshotMemoryCache } from './screenshot-provider'
import type { R2Config } from '@/lib/scenarios/r2-signed-url'

const R2_CONFIG: R2Config = {
  accountId: '76c9d366fabdcc59d4bc9008c7936584',
  bucket: 'banner-assets',
  accessKeyId: 'TEST_KEY',
  secretAccessKey: 'TEST_SECRET',
}

const MICROLINK_API = 'https://api.microlink.io'
const R2_HOST = `${R2_CONFIG.accountId}.r2.cloudflarestorage.com`

interface FakeR2Store {
  objects: Map<string, { body: string | Uint8Array; contentType: string }>
}

/**
 * Microlink + R2 を同時に handle する fake fetch を作る。
 *   - api.microlink.io     → screenshot meta JSON
 *   - cdn.microlink.io     → 画像 bytes
 *   - R2 host (PUT)        → store に格納
 *   - R2 host (GET .json)  → store から meta を返す (なければ 404)
 *   - R2 host (GET .jpg)   → store から bytes を返す (signed GET、ここでは中身不問)
 */
function makeFakeFetch(store: FakeR2Store, counters: { microlink: number }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.startsWith(MICROLINK_API)) {
      counters.microlink += 1
      return new Response(
        JSON.stringify({
          status: 'success',
          data: { screenshot: { url: 'https://cdn.microlink.io/shot.jpg', width: 1280, height: 4000 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.startsWith('https://cdn.microlink.io')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (url.includes(R2_HOST)) {
      const path = new URL(url).pathname // /{bucket}/{key}
      const key = decodeURIComponent(path.replace(`/${R2_CONFIG.bucket}/`, ''))
      if (method === 'PUT') {
        const body = init?.body
        const stored =
          typeof body === 'string' ? body : body instanceof Uint8Array ? body : new Uint8Array()
        store.objects.set(key, {
          body: stored,
          contentType: String((init?.headers as Record<string, string>)?.['content-type'] ?? ''),
        })
        return new Response('', { status: 200 })
      }
      // GET
      const obj = store.objects.get(key)
      if (!obj) return new Response('not found', { status: 404 })
      return new Response(obj.body as BodyInit, { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
}

function baseHooks(
  store: FakeR2Store,
  counters: { microlink: number },
  overrides: Partial<R2CacheHooks> = {},
): R2CacheHooks {
  return {
    r2Config: R2_CONFIG,
    fetchImpl: makeFakeFetch(store, counters),
    // tests は lock を deterministic に: 既定は常に取得成功
    acquireLock: async () => true,
    releaseLock: async () => undefined,
    // Cloudflare は無効化 (null) し、この suite は Microlink fallback 経路を検証する。
    cloudflareConfig: null,
    ...overrides,
  }
}

const INPUT = {
  tenantId: 'tenant-A',
  siteId: 'site-1',
  pageUrl: 'https://bihadashop.jp/entry/tirtir',
  device: 'pc' as const,
}

describe('buildR2Keys (key schema + tenant isolation)', () => {
  it('uses heatmap-screenshots/v11/{tenant}/{site}/{device}/{urlHash}/v11 + .jpg/.json', () => {
    // CAPTURE_VERSION (現行 v11、P2 capped full-height で bump) で key prefix が決まる。
    // bump 時は本テストも追従更新する。
    const keys = buildR2Keys(INPUT)
    expect(keys.imageKey).toMatch(
      /^heatmap-screenshots\/v11\/tenant-A\/site-1\/pc\/[0-9a-f]{32}\/v11\.jpg$/,
    )
    expect(keys.metaKey).toMatch(
      /^heatmap-screenshots\/v11\/tenant-A\/site-1\/pc\/[0-9a-f]{32}\/v11\.json$/,
    )
  })

  it('changes urlHash when pageUrl differs', () => {
    const a = buildR2Keys(INPUT)
    const b = buildR2Keys({ ...INPUT, pageUrl: 'https://bihadashop.jp/entry/other' })
    expect(a.imageKey).not.toBe(b.imageKey)
  })

  it('keys are tenant-scoped (different tenant → different key prefix)', () => {
    const a = buildR2Keys(INPUT)
    const b = buildR2Keys({ ...INPUT, tenantId: 'tenant-B' })
    expect(a.imageKey).toContain('/tenant-A/')
    expect(b.imageKey).toContain('/tenant-B/')
    expect(a.imageKey).not.toBe(b.imageKey)
  })

  it('sanitizes unsafe key segments (no path injection via tenant/site id)', () => {
    const keys = buildR2Keys({ ...INPUT, tenantId: '../../etc', siteId: 'a/b' })
    expect(keys.imageKey).not.toContain('..')
    expect(keys.imageKey).toContain('/______etc/') // 6 unsafe chars → 6 underscores
    expect(keys.imageKey).toContain('/a_b/')
  })
})

describe('getHeatmapUnderlayWithR2Cache (tier selection + TTL/SWR)', () => {
  beforeEach(() => {
    _resetScreenshotMemoryCache()
  })

  it('degraded tier when R2 not configured (falls back to L1-only capture)', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    const fetchImpl = makeFakeFetch(store, counters)
    const res = await getHeatmapUnderlayWithR2Cache(INPUT, {
      fetchImpl,
      cloudflareConfig: null, // Microlink fallback 経路を検証
      // r2Config 省略 + env 無し → degrade
    })
    expect(res.tier).toBe('degraded')
    expect(counters.microlink).toBe(1)
    // degrade 経路は CDN URL をそのまま使う
    expect(res.capture.imageUrl).toBe('https://cdn.microlink.io/shot.jpg')
  })

  it('R2 miss → synchronous capture, PUTs bytes + meta to R2, serves signed GET URL', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    const res = await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters))
    expect(res.tier).toBe('capture')
    expect(counters.microlink).toBe(1)
    // R2 に image + meta が PUT された
    const keys = buildR2Keys(INPUT)
    expect(store.objects.has(keys.imageKey)).toBe(true)
    expect(store.objects.has(keys.metaKey)).toBe(true)
    // serve URL は R2 signed GET (CDN ではなく R2 host)
    expect(res.capture.imageUrl).toContain(R2_HOST)
    expect(res.capture.imageUrl).toContain('X-Amz-Signature=')
  })

  it('R2 fresh (within 24h) → r2-fresh tier, no new capture', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    // 1st call: capture + populate R2
    await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters))
    expect(counters.microlink).toBe(1)
    // reset L1 so 2nd call must hit R2 (L2)
    _resetScreenshotMemoryCache()
    const res = await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters))
    expect(res.tier).toBe('r2-fresh')
    expect(counters.microlink).toBe(1) // no extra capture
    expect(res.capture.cached).toBe(true)
  })

  it('L1 hit on immediate repeat (same instance) → l1 tier', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters))
    const res = await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters))
    expect(res.tier).toBe('l1')
    expect(counters.microlink).toBe(1)
  })

  it('R2 stale (older than 24h, within 7d) → r2-stale tier returns immediately + schedules revalidate', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    // populate at t0
    const t0 = Date.parse('2026-06-01T00:00:00.000Z')
    await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters, { now: () => t0 }))
    expect(counters.microlink).toBe(1)
    _resetScreenshotMemoryCache()

    // read 2 days later → stale
    const t2d = t0 + 2 * 24 * 60 * 60 * 1000
    const scheduled: Array<() => Promise<void>> = []
    const res = await getHeatmapUnderlayWithR2Cache(
      INPUT,
      baseHooks(store, counters, {
        now: () => t2d,
        schedule: (task) => {
          scheduled.push(task)
        },
      }),
    )
    expect(res.tier).toBe('r2-stale')
    // 即時 response は新規 capture を待たない
    expect(counters.microlink).toBe(1)
    expect(scheduled).toHaveLength(1)

    // background revalidate を実行すると capture が走る
    await scheduled[0]!()
    expect(counters.microlink).toBe(2)
  })

  it('SWR revalidate respects dedupe lock (no capture when lock not acquired)', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    const t0 = Date.parse('2026-06-01T00:00:00.000Z')
    await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters, { now: () => t0 }))
    _resetScreenshotMemoryCache()

    const t2d = t0 + 2 * 24 * 60 * 60 * 1000
    const scheduled: Array<() => Promise<void>> = []
    await getHeatmapUnderlayWithR2Cache(
      INPUT,
      baseHooks(store, counters, {
        now: () => t2d,
        schedule: (task) => {
          scheduled.push(task)
        },
        acquireLock: async () => false, // 別リクエストが既に再取得中
      }),
    )
    await scheduled[0]!()
    expect(counters.microlink).toBe(1) // lock 取れず → 再 capture しない
  })

  it('R2 beyond staleTtl (> 7d) → synchronous re-capture (capture tier)', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    const t0 = Date.parse('2026-06-01T00:00:00.000Z')
    await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters, { now: () => t0 }))
    _resetScreenshotMemoryCache()

    const t8d = t0 + 8 * 24 * 60 * 60 * 1000
    const res = await getHeatmapUnderlayWithR2Cache(
      INPUT,
      baseHooks(store, counters, { now: () => t8d }),
    )
    expect(res.tier).toBe('capture')
    expect(counters.microlink).toBe(2)
  })

  it('tenant isolation: tenant-B cannot read tenant-A R2 object', async () => {
    const store: FakeR2Store = { objects: new Map() }
    const counters = { microlink: 0 }
    // tenant-A populates
    await getHeatmapUnderlayWithR2Cache(INPUT, baseHooks(store, counters))
    expect(counters.microlink).toBe(1)
    _resetScreenshotMemoryCache()
    // tenant-B with same site/url must MISS (different key) → its own capture
    const resB = await getHeatmapUnderlayWithR2Cache(
      { ...INPUT, tenantId: 'tenant-B' },
      baseHooks(store, counters),
    )
    expect(resB.tier).toBe('capture')
    expect(counters.microlink).toBe(2)
  })
})
