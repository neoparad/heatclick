/**
 * Heatmap screenshot provider — Microlink screenshot API wrapper + SSRF/URL guards.
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend heatmap screenshot underlay Phase 2
 *   (handoff: `2026-05-29-frontend-heatmap-screenshot-underlay.md`)
 *
 * 設計:
 *   - server-only (`runtime = 'nodejs'` の API route から呼ぶ。client bundle に入れない)
 *   - SSRF guard: scheme は http/https のみ、host は private / loopback / link-local /
 *     multicast / 0.0.0.0 / "*.localhost" を拒否
 *   - device → capture width 対応: pc=1280, sp=390, tab=820
 *     (続 117 v2 root-cause fix: pc は 720 だと WP が mobile layout に reflow して
 *      「PC なのにスマホ画面」になっていた。desktop 基準幅 1280 に修正。)
 *   - cache: in-memory Map (provider 側 cache + 弊側 LRU 風 60 件 cap)
 *   - provider: Microlink (free tier OK、`MICROLINK_API_KEY` 設定時は header 付与)
 *
 * §1.7 Anti-Features: 静的 screenshot 取得のみ。session 録画 / DOM 再現 / 動画化 一切なし。
 */

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

import type { HeatmapDevice, HeatmapUnderlayCapture } from '@/lib/heatmap/types'

const MICROLINK_ENDPOINT = 'https://api.microlink.io'

/**
 * Microlink CDN host allowlist. provider 応答が任意の URL を返した場合の image src
 * (browser からのアクセス) を防御 (Codex T2 review HIGH H-2 fix)。
 *
 * 公式 docs: https://microlink.io/docs/api/parameters/screenshot
 */
const MICROLINK_CDN_HOSTS: ReadonlyArray<string> = [
  'iad.microlink.io',
  'iad.microlink.io.s3.amazonaws.com',
  'cdn.microlink.io',
  'microlink-img-cdn.imgix.net',
]

/** screenshot 画像の最小 / 最大 px (provider 応答 sanitize 用) */
const SCREENSHOT_DIM_MIN = 16
const SCREENSHOT_DIM_MAX = 50_000

/**
 * device → capture viewport width (Microlink `viewport.width`)。
 * これは screenshot を撮る時の CSS viewport 幅 (= 座標基準 referenceWidth) であり、
 * 画像実 px (naturalWidth、DPR 倍率込み) とは別物。
 *
 * 続 117 v2: pc=1280 (desktop layout を確実に出す)。720 だと多くの WP テーマが
 * mobile breakpoint に落ちて「PC なのにスマホ画面」になっていた。
 */
export const CAPTURE_WIDTH_FOR_DEVICE: Record<HeatmapDevice, number> = {
  pc: 1280,
  sp: 390,
  tab: 820,
}

/** in-memory cache, server lifetime のみ (Phase 2.5 で R2 / Vercel Blob に永続化) */
const memoryCache = new Map<string, { value: HeatmapUnderlayCapture; expiresAt: number }>()
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000 // 1h
const MEMORY_CACHE_MAX_ENTRIES = 60

/**
 * 続 116 perf: Microlink screenshot 圧縮設定。
 *   - format=jpeg は PNG (continuous-tone full page) より 5-10x 軽い
 *   - quality=75 は WP 商品ページの underlay として視認性 / size のバランス良
 * cache key に含めて、format / quality 変更時に cache miss を起こす。
 */
const SCREENSHOT_FORMAT: 'jpeg' | 'png' | 'webp' = 'jpeg'
const SCREENSHOT_QUALITY = 75

export class ScreenshotProviderError extends Error {
  readonly code:
    | 'INVALID_URL'
    | 'BLOCKED_URL'
    | 'PROVIDER_ERROR'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_TIMEOUT'

  readonly status?: number

  constructor(
    code:
      | 'INVALID_URL'
      | 'BLOCKED_URL'
      | 'PROVIDER_ERROR'
      | 'PROVIDER_RATE_LIMITED'
      | 'PROVIDER_TIMEOUT',
    message: string,
    status?: number,
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * SSRF guard: 受入可能な公開 URL かどうかを判定。host を直接 IP 文字列で渡された場合 (e.g.
 * "http://127.0.0.1/x") も DNS lookup 前にここで拒否する。
 *
 * 注: DNS rebinding 対策は本層では実施せず provider 側 (Microlink) の network 境界に委ねる。
 *     localhost 名 (`.localhost`, `*.local`) は最低限の防御として拒否する。
 */
export function validateExternalUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new ScreenshotProviderError('INVALID_URL', 'page_url is not a valid absolute URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ScreenshotProviderError('INVALID_URL', 'only http/https are allowed')
  }
  if (parsed.username || parsed.password) {
    throw new ScreenshotProviderError('INVALID_URL', 'embedded credentials are not allowed')
  }

  let host = parsed.hostname.toLowerCase()
  if (host.length === 0) {
    throw new ScreenshotProviderError('INVALID_URL', 'page_url host is empty')
  }
  // URL parser は IPv6 host を `[::1]` 形式 (角括弧付き) で返すため、isIP 判定の前に剥がす
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  // 直接 IP 文字列の場合
  const ipVersion = isIP(host)
  if (ipVersion === 4) {
    if (isPrivateOrSpecialIPv4(host)) {
      throw new ScreenshotProviderError('BLOCKED_URL', `private/loopback IPv4 not allowed: ${host}`)
    }
  } else if (ipVersion === 6) {
    if (isPrivateOrSpecialIPv6(host)) {
      throw new ScreenshotProviderError('BLOCKED_URL', `private/loopback IPv6 not allowed: ${host}`)
    }
  } else {
    if (isBlockedHostname(host)) {
      throw new ScreenshotProviderError('BLOCKED_URL', `blocked hostname: ${host}`)
    }
  }
  return parsed
}

function isPrivateOrSpecialIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  // RFC1918 / loopback / link-local / multicast / broadcast / TEST-NET / "this network"
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CG-NAT
  if (a >= 224) return true // multicast / reserved
  if (a === 192 && b === 0) return true // 192.0.0.0/24, 192.0.2.0/24 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark
  if (a === 198 && b === 51) return true // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0) return true // TEST-NET-3 203.0.113.0/24
  return false
}

function isPrivateOrSpecialIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
  if (lower.startsWith('fe80')) return true // link-local
  if (lower.startsWith('ff')) return true // multicast
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped, validate inner IPv4
    const inner = lower.slice('::ffff:'.length)
    return isPrivateOrSpecialIPv4(inner)
  }
  return false
}

function isBlockedHostname(host: string): boolean {
  if (host === 'localhost') return true
  if (host.endsWith('.localhost')) return true
  if (host.endsWith('.local')) return true
  if (host.endsWith('.internal')) return true
  // metadata services (cloud provider local introspection)
  if (host === 'metadata.google.internal') return true
  return false
}

/** scheme → default port (省略時に剥がす対象) */
const DEFAULT_PORT_FOR_SCHEME: Record<string, string> = {
  'http:': '80',
  'https:': '443',
}

/**
 * page_url の正準化 (canonicalization)。
 *
 * 設計 (続 perf R2 cache):
 *   - **cache key と ClickHouse ownership lookup の両方で同一文字列を使う**ことが CRITICAL。
 *     ここで返す文字列を route が両方に渡すことで、cache hit と ownership 判定が乖離しない。
 *   - **過剰正規化しない**:
 *       - scheme / host を lowercase (大文字小文字はサーバが区別しないため安全)
 *       - default port (http=80 / https=443) を剥がす
 *       - fragment (#...) を剥がす (サーバに送られない部分なので別ページではない)
 *   - **触らない** (= 別ページの可能性があるため):
 *       - query param の有無・順序 (?a=1&b=2 ≠ ?b=2&a=1 を別物として扱う)
 *       - trailing slash (/foo ≠ /foo/ を別物として扱う)
 *       - path の大文字小文字
 *
 * 入力は `validateExternalUrl` を通過済 URL を前提とする (本関数は SSRF 判定しない)。
 */
export function canonicalizePageUrl(rawUrl: string): string {
  const u = new URL(rawUrl)
  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase()
  if (u.port && DEFAULT_PORT_FOR_SCHEME[u.protocol] === u.port) {
    u.port = ''
  }
  u.hash = ''
  // URL.toString() は query 順序・trailing slash・path case を保持する (= 過剰正規化しない)
  return u.toString()
}

/**
 * cache key: tenant / site / url / device / width / 設定 hash。
 * tenant_id を **必ず先頭に含める** ことで cache hit でも cross-tenant 漏洩を防ぐ。
 */
export function buildCacheKey(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
}): string {
  const width = CAPTURE_WIDTH_FOR_DEVICE[input.device]
  // 続 116: format / quality を cache key に含める (perf 改修で値変更時に cache miss を起こす)
  const raw = `${input.tenantId}|${input.siteId}|${input.pageUrl}|${input.device}|${width}|fullPage|${SCREENSHOT_FORMAT}|q${SCREENSHOT_QUALITY}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * メモリ cache (server lifetime のみ)。expire 過ぎたものは取得時に lazy 破棄。
 * 60 件超過時は古い entry から間引き。
 */
function memoryCacheGet(key: string): HeatmapUnderlayCapture | null {
  const hit = memoryCache.get(key)
  if (!hit) return null
  if (hit.expiresAt < Date.now()) {
    memoryCache.delete(key)
    return null
  }
  return hit.value
}

function memoryCacheSet(key: string, value: HeatmapUnderlayCapture): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const firstKey = memoryCache.keys().next().value
    if (firstKey !== undefined) memoryCache.delete(firstKey)
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS })
}

/** test 用 (cache を空にする) — production runtime からは呼ばない */
export function _resetScreenshotMemoryCache(): void {
  memoryCache.clear()
}

/** L1 (in-memory) cache lookup。R2 cache 層から fast-path として呼ぶ。 */
export function getMemoryCachedUnderlay(cacheKey: string): HeatmapUnderlayCapture | null {
  return memoryCacheGet(cacheKey)
}

/** L1 (in-memory) cache write。R2 cache 層から hydrate 用に呼ぶ。 */
export function setMemoryCachedUnderlay(cacheKey: string, value: HeatmapUnderlayCapture): void {
  memoryCacheSet(cacheKey, value)
}

interface MicrolinkResponse {
  status: 'success' | 'error' | 'fail'
  data?: {
    screenshot?: {
      url?: string
      width?: number
      height?: number
      size_pretty?: string
    }
  }
  message?: string
}

/**
 * Microlink screenshot API を呼んで HeatmapUnderlayCapture を返す。
 *
 * Microlink params:
 *   - url: target URL
 *   - screenshot=true: screenshot mode
 *   - meta=false: meta scraping off (速度優先)
 *   - viewport.width: device 別固定 (PC 720 / SP 390 / TAB 820)
 *   - fullPage=true: page 全高を取得
 *   - waitUntil=load: ネットワーク I/O が落ち着くまで待つ (default は load なので明示)
 *
 * `MICROLINK_API_KEY` 未設定でも free tier で動作する (低 quota)。
 */
async function fetchFromMicrolink(input: {
  pageUrl: string
  device: HeatmapDevice
  apiKey?: string
  fetchImpl?: typeof fetch
}): Promise<{ imageUrl: string; naturalWidth: number; naturalHeight: number }> {
  const width = CAPTURE_WIDTH_FOR_DEVICE[input.device]
  const params = new URLSearchParams({
    url: input.pageUrl,
    screenshot: 'true',
    meta: 'false',
    'viewport.width': String(width),
    'screenshot.fullPage': 'true',
    // 続 116 perf: jpeg + quality=75 で size 5-10x 削減 (WP underlay 用途で視認性十分)
    'screenshot.type': SCREENSHOT_FORMAT,
    'screenshot.quality': String(SCREENSHOT_QUALITY),
    waitUntil: 'load',
  })
  const endpoint = `${MICROLINK_ENDPOINT}/?${params.toString()}`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (input.apiKey) headers['x-api-key'] = input.apiKey

  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 25_000)
  let res: Response
  try {
    const f = input.fetchImpl ?? fetch
    res = await f(endpoint, { method: 'GET', headers, signal: ctrl.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScreenshotProviderError('PROVIDER_TIMEOUT', 'microlink timeout (>25s)')
    }
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      err instanceof Error ? err.message : 'microlink network error',
    )
  } finally {
    clearTimeout(timeout)
  }

  if (res.status === 429) {
    throw new ScreenshotProviderError('PROVIDER_RATE_LIMITED', 'microlink rate limit', 429)
  }
  if (!res.ok) {
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      `microlink HTTP ${res.status}`,
      res.status,
    )
  }
  const body = (await res.json()) as MicrolinkResponse
  if (body.status !== 'success' || !body.data?.screenshot?.url) {
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      `microlink ${body.status}: ${body.message ?? 'no screenshot'}`,
    )
  }
  const shot = body.data.screenshot
  const safeImageUrl = sanitizeProviderImageUrl(shot.url ?? '')
  const w = sanitizeDimension(shot.width, width)
  const h = sanitizeDimension(shot.height, width * 2)
  return {
    imageUrl: safeImageUrl,
    naturalWidth: w,
    naturalHeight: h,
  }
}

/**
 * provider 応答に含まれる screenshot image URL を sanitize する。
 *   - https のみ
 *   - 認証情報 (user:pass) なし
 *   - hostname が Microlink CDN allowlist に含まれる
 * これにより、provider が侵害された場合でも client browser が任意の URL に
 * リクエストするのを防ぐ (Codex T2 review HIGH H-2 fix)。
 */
function sanitizeProviderImageUrl(rawUrl: string): string {
  if (!rawUrl) {
    throw new ScreenshotProviderError('PROVIDER_ERROR', 'microlink returned empty image url')
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new ScreenshotProviderError('PROVIDER_ERROR', 'microlink returned malformed image url')
  }
  if (parsed.protocol !== 'https:') {
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      `microlink image url is not https: ${parsed.protocol}`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      'microlink image url contains embedded credentials',
    )
  }
  const host = parsed.hostname.toLowerCase()
  if (!MICROLINK_CDN_HOSTS.some((allow) => host === allow || host.endsWith('.' + allow))) {
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      `microlink image url host not in CDN allowlist: ${host}`,
    )
  }
  return parsed.toString()
}

function sanitizeDimension(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : NaN
  if (Number.isNaN(n) || n < SCREENSHOT_DIM_MIN || n > SCREENSHOT_DIM_MAX) return fallback
  return n
}

/** `content-type` allowlist for the Microlink CDN image fetch (defense in depth). */
const ALLOWED_IMAGE_CONTENT_TYPES: ReadonlyArray<string> = ['image/jpeg', 'image/png', 'image/webp']

/** Microlink CDN から取得した screenshot 画像 bytes + content-type。 */
export interface CapturedImageBytes {
  bytes: Uint8Array
  contentType: string
}

/** Microlink で capture した結果 (meta + 取得した画像 bytes)。 */
export interface MicrolinkCaptureResult {
  /** imageUrl は Microlink CDN URL (L2 R2 が無い degrade 経路でそのまま使える) */
  capture: HeatmapUnderlayCapture
  image: CapturedImageBytes
}

/**
 * Microlink を呼んで screenshot meta を得たうえで、CDN 画像 bytes も取得して返す。
 *
 * R2 (L2) cache へ PUT するため bytes が必要。imageUrl は CDN URL のままにしておくことで、
 * R2 が未設定な degrade 経路でも従来どおり CDN 直リンクで `<img>` が動く。
 *
 * SSRF guard は呼び元 (route handler) で必ず通すこと。本関数は guarded 済 URL を前提とする。
 */
export async function captureViaMicrolink(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  cacheKey?: string
  /** capturedAt 注入 (TTL/SWR の deterministic test 用)。未指定なら wall-clock。 */
  capturedAt?: string
  fetchImpl?: typeof fetch
}): Promise<MicrolinkCaptureResult> {
  const cacheKey = input.cacheKey ?? buildCacheKey(input)
  const fetched = await runMicrolinkFetch(input.pageUrl, input.device, input.fetchImpl)
  const image = await fetchCdnImageBytes(fetched.imageUrl, input.fetchImpl)
  const capture = buildUnderlayCapture(input, fetched, cacheKey, input.capturedAt)
  return { capture, image }
}

/**
 * L1-only 経路 (R2 不要) 用の軽量 capture。CDN 画像 bytes を fetch せず meta のみ返す。
 * imageUrl は Microlink CDN URL のまま。
 */
async function captureMetaViaMicrolink(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  cacheKey: string
  fetchImpl?: typeof fetch
}): Promise<HeatmapUnderlayCapture> {
  const fetched = await runMicrolinkFetch(input.pageUrl, input.device, input.fetchImpl)
  return buildUnderlayCapture(input, fetched, input.cacheKey)
}

async function runMicrolinkFetch(
  pageUrl: string,
  device: HeatmapDevice,
  fetchImpl?: typeof fetch,
): Promise<{ imageUrl: string; naturalWidth: number; naturalHeight: number }> {
  const apiKey = process.env.MICROLINK_API_KEY
  return fetchFromMicrolink({
    pageUrl,
    device,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
    fetchImpl,
  })
}

function buildUnderlayCapture(
  input: { pageUrl: string; device: HeatmapDevice },
  fetched: { imageUrl: string; naturalWidth: number; naturalHeight: number },
  cacheKey: string,
  capturedAt?: string,
): HeatmapUnderlayCapture {
  return {
    pageUrl: input.pageUrl,
    imageUrl: fetched.imageUrl,
    viewportWidth: CAPTURE_WIDTH_FOR_DEVICE[input.device],
    viewportHeight: fetched.naturalHeight,
    naturalWidth: fetched.naturalWidth,
    naturalHeight: fetched.naturalHeight,
    device: input.device,
    capturedAt: capturedAt ?? new Date().toISOString(),
    cacheKey,
    provider: 'microlink',
    cached: false,
  }
}

/**
 * Microlink CDN の screenshot 画像 bytes を取得する。
 * imageUrl は `sanitizeProviderImageUrl` で allowlist 済の前提。
 */
async function fetchCdnImageBytes(
  imageUrl: string,
  fetchImpl?: typeof fetch,
): Promise<CapturedImageBytes> {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 20_000)
  let res: Response
  try {
    const f = fetchImpl ?? fetch
    res = await f(imageUrl, { method: 'GET', signal: ctrl.signal, redirect: 'follow' })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScreenshotProviderError('PROVIDER_TIMEOUT', 'microlink cdn image timeout (>20s)')
    }
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      err instanceof Error ? err.message : 'microlink cdn image fetch error',
    )
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) {
    throw new ScreenshotProviderError('PROVIDER_ERROR', `microlink cdn image HTTP ${res.status}`)
  }
  const rawType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const contentType = ALLOWED_IMAGE_CONTENT_TYPES.includes(rawType)
    ? rawType
    : `image/${SCREENSHOT_FORMAT === 'jpeg' ? 'jpeg' : SCREENSHOT_FORMAT}`
  const buf = await res.arrayBuffer()
  return { bytes: new Uint8Array(buf), contentType }
}

/**
 * 公開 API (後方互換): tenant / site / url / device から HeatmapUnderlayCapture を返す。
 * cache hit 時は `cached: true`、未 hit 時 (or error) は provider を呼ぶ。
 *
 * NOTE: R2 (L2) 永続化は `lib/heatmap/r2-screenshot-cache.ts` の
 *       `getHeatmapUnderlayWithR2Cache` 経由。本関数は L1 (in-memory) のみの fast path で、
 *       R2 未設定環境向けの degrade 経路 / 既存 unit test 用に残す。
 *
 * SSRF guard は呼び元 (route handler) で必ず通すこと。本関数は guarded 済 URL を前提とする。
 */
export async function fetchHeatmapUnderlay(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  fetchImpl?: typeof fetch
}): Promise<HeatmapUnderlayCapture> {
  const cacheKey = buildCacheKey(input)
  const hit = memoryCacheGet(cacheKey)
  if (hit) {
    return { ...hit, cached: true }
  }

  const capture = await captureMetaViaMicrolink({ ...input, cacheKey })
  memoryCacheSet(cacheKey, capture)
  return capture
}
