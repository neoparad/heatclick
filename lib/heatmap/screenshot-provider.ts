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

import { readImageDimensions } from '@/lib/heatmap/image-dimensions'
import type {
  HeatmapDevice,
  HeatmapUnderlayCapture,
  ScreenshotProvider,
} from '@/lib/heatmap/types'

const MICROLINK_ENDPOINT = 'https://api.microlink.io'

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * Cloudflare Browser Rendering の deviceScaleFactor (DPR)。
 *
 * **1 に固定する理由 (overlay 座標整合)**:
 *   既存 Microlink 経路は naturalWidth ≒ viewportWidth (DPR=1 相当) を返す。座標系
 *   (stage-layout.ts) は `pageCssHeight = naturalHeight * referenceWidth / naturalWidth`、
 *   `displayScale = actualOuterWidth / referenceWidth` で計算し、referenceWidth は
 *   viewportWidth (= CAPTURE_WIDTH_FOR_DEVICE) に等しい。
 *   DPR=1 にすると naturalWidth = viewportWidth * 1 = referenceWidth となり、Microlink 経路と
 *   `naturalWidth/referenceWidth` が完全一致するため overlay が同一 displayScale で整列する。
 *   (DPR を 2 にしても上式は CSS px を正しく復元するが、Microlink fallback と挙動を揃え、
 *    画像 size も抑えるため 1 を選択。)
 */
const CLOUDFLARE_DEVICE_SCALE_FACTOR = 1

/** Cloudflare gotoOptions.timeout (page load 待ち上限)。fullPage の lazy load も待つ。 */
const CLOUDFLARE_GOTO_TIMEOUT_MS = 30_000

/**
 * 続 119 (B-2) lazy-load 画像対策スクリプト (CF `addScriptTag` で注入)。
 *   - 全 img を loading='eager' に変え、data-src / data-srcset (WP lazyload plugin 慣習) を解決
 *   - data-bg / data-background の CSS 背景 lazy も解決
 *   - 最下部→最上部にスクロールして native lazy / IntersectionObserver を誘発
 * 注: CF REST には「スクリプト実行後の追加 wait」が無く、networkidle0 後に走るため完全保証では
 *     ない。不十分な場合は Worker(Puppeteer) で autoScroll + waitForNetworkIdle 方式へ移行する。
 */
const CLOUDFLARE_LAZY_LOAD_SCRIPT =
  "document.querySelectorAll('img').forEach(function(i){i.loading='eager';" +
  'if(i.dataset.src)i.src=i.dataset.src;if(i.dataset.srcset)i.srcset=i.dataset.srcset;});' +
  "document.querySelectorAll('[data-bg],[data-background]').forEach(function(e){" +
  "var b=e.dataset.bg||e.dataset.background;if(b)e.style.backgroundImage='url('+b+')';});" +
  'window.scrollTo(0,document.body.scrollHeight);window.scrollTo(0,0);'

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
  const raw = `${input.tenantId}|${input.siteId}|${input.pageUrl}|${input.device}|${width}|fullPage-ni2-lz|${SCREENSHOT_FORMAT}|q${SCREENSHOT_QUALITY}`
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
    // 続 119 (B) スクショ切れ修正: 'load' は遅延読み込み(lazy)前に発火し、長い記事ページの
    //   下部が撮れず上部だけの短いスクショになる。'networkidle2' でネットワークが概ね落ち着く
    //   まで待ち、fullPage の自動スクロールで下部の lazy コンテンツも読み込ませてから撮影する。
    waitUntil: 'networkidle2',
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

/** screenshot capture の結果 (meta + 画像 bytes)。provider 非依存。 */
export interface ScreenshotCaptureResult {
  /**
   * imageUrl は degrade 経路 (R2 未設定) で `<img>` が使える URL。
   *   - microlink: CDN URL
   *   - cloudflare: data: URL (bytes を inline、外部依存なし)
   * R2 cache 層は PUT 後にこれを短命 signed GET URL へ差し替える。
   */
  capture: HeatmapUnderlayCapture
  image: CapturedImageBytes
}

/** @deprecated 後方互換 alias。新規コードは {@link ScreenshotCaptureResult} を使う。 */
export type MicrolinkCaptureResult = ScreenshotCaptureResult

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
}): Promise<ScreenshotCaptureResult> {
  const cacheKey = input.cacheKey ?? buildCacheKey(input)
  const fetched = await runMicrolinkFetch(input.pageUrl, input.device, input.fetchImpl)
  const image = await fetchCdnImageBytes(fetched.imageUrl, input.fetchImpl)
  const capture = buildUnderlayCapture(input, fetched, cacheKey, 'microlink', input.capturedAt)
  return { capture, image }
}

// ── Cloudflare Browser Rendering (PRIMARY provider) ────────────────────────────

/** Cloudflare Browser Rendering の env 設定 (account id + API token)。 */
export interface CloudflareBRConfig {
  accountId: string
  apiToken: string
}

/**
 * env から Cloudflare Browser Rendering 設定を解決する。両方揃っていなければ null
 * (= Microlink fallback)。accountId は専用 `CLOUDFLARE_ACCOUNT_ID` を優先し、無ければ
 * 既存 `R2_ACCOUNT_ID` を流用する (同一 Cloudflare account のため安全)。
 */
export function getCloudflareBRConfig(): CloudflareBRConfig | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID
  if (!apiToken || apiToken.length === 0) return null
  if (!accountId || accountId.length === 0) return null
  return { accountId, apiToken }
}

/**
 * Cloudflare Browser Rendering REST API で screenshot (binary JPEG) を取得し、bytes から
 * 実 px dimension を抽出して返す。
 *
 * Endpoint:
 *   POST /accounts/{accountId}/browser-rendering/screenshot
 *   Authorization: Bearer {apiToken}
 *
 * Request body (JSON):
 *   - url               : 対象ページ (SSRF guard 済前提)
 *   - viewport          : { width = CSS px 基準幅, height, deviceScaleFactor }
 *   - screenshotOptions : { fullPage: true, type: 'jpeg', quality }
 *   - gotoOptions       : { waitUntil: 'networkidle0', timeout }
 *
 * Response: **binary image bytes** (image/jpeg)。JSON ではない。
 *   200 以外 (CF は失敗時 JSON を返す) は ScreenshotProviderError に変換する。
 */
export async function fetchFromCloudflareBR(input: {
  pageUrl: string
  device: HeatmapDevice
  config: CloudflareBRConfig
  fetchImpl?: typeof fetch
}): Promise<{ bytes: Uint8Array; contentType: string; naturalWidth: number; naturalHeight: number }> {
  const width = CAPTURE_WIDTH_FOR_DEVICE[input.device]
  const body = buildCloudflareBRRequestBody({ pageUrl: input.pageUrl, device: input.device })
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(
    input.config.accountId,
  )}/browser-rendering/screenshot`

  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 30_000)
  let res: Response
  try {
    const f = input.fetchImpl ?? fetch
    res = await f(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.config.apiToken}`,
        'content-type': 'application/json',
        // 失敗時に CF が JSON error を返せるよう accept は両方許容する。
        accept: 'image/jpeg, application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScreenshotProviderError('PROVIDER_TIMEOUT', 'cloudflare BR timeout (>30s)')
    }
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      err instanceof Error ? err.message : 'cloudflare BR network error',
    )
  } finally {
    clearTimeout(timeout)
  }

  if (res.status === 429) {
    throw new ScreenshotProviderError('PROVIDER_RATE_LIMITED', 'cloudflare BR rate limit', 429)
  }
  if (!res.ok) {
    // CF は失敗時 JSON {success:false, errors:[...]} を返す。message を抽出する。
    const detail = await extractCloudflareError(res)
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      `cloudflare BR HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
    )
  }

  const rawType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (rawType.startsWith('application/json')) {
    // 200 でも JSON が返るケース (CF が error を 200 で返す等) を防御的に拒否する。
    const detail = await extractCloudflareErrorFromJson(await res.json().catch(() => null))
    throw new ScreenshotProviderError(
      'PROVIDER_ERROR',
      `cloudflare BR returned JSON, not an image${detail ? `: ${detail}` : ''}`,
    )
  }

  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes.length === 0) {
    throw new ScreenshotProviderError('PROVIDER_ERROR', 'cloudflare BR returned empty image')
  }
  const contentType = ALLOWED_IMAGE_CONTENT_TYPES.includes(rawType)
    ? rawType
    : `image/${SCREENSHOT_FORMAT === 'jpeg' ? 'jpeg' : SCREENSHOT_FORMAT}`

  // bytes から dimension を抽出 (CF は JSON で size を返さない)。判別不能なら fallback。
  const dims = readImageDimensions(bytes)
  const naturalWidth = sanitizeDimension(dims?.width, width)
  const naturalHeight = sanitizeDimension(dims?.height, width * 2)
  return { bytes, contentType, naturalWidth, naturalHeight }
}

/**
 * Cloudflare Browser Rendering の request body を組み立てる (pure、test 可能)。
 * viewport.width は device の CSS 基準幅 (= referenceWidth)、deviceScaleFactor は overlay
 * 整合のため 1 固定 (上 CLOUDFLARE_DEVICE_SCALE_FACTOR の注釈参照)。
 */
export function buildCloudflareBRRequestBody(input: {
  pageUrl: string
  device: HeatmapDevice
}): {
  url: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  screenshotOptions: { fullPage: true; type: 'jpeg'; quality: number }
  gotoOptions: { waitUntil: 'networkidle0'; timeout: number }
  addScriptTag: Array<{ content: string }>
} {
  const width = CAPTURE_WIDTH_FOR_DEVICE[input.device]
  return {
    url: input.pageUrl,
    viewport: {
      width,
      // 初期 viewport 高。fullPage:true なので最終画像高はページ全高で決まる (この値は初期描画用)。
      height: Math.round(width * 1.5),
      deviceScaleFactor: CLOUDFLARE_DEVICE_SCALE_FACTOR,
    },
    screenshotOptions: {
      fullPage: true,
      // quality は jpeg のみ有効。既存 perf 設定 (q75) を踏襲し size を抑える。
      type: 'jpeg',
      quality: SCREENSHOT_QUALITY,
    },
    gotoOptions: {
      // networkidle0: 全 network が落ち着くまで待ち、fullPage 自動 scroll で lazy 下部も撮る。
      waitUntil: 'networkidle0',
      timeout: CLOUDFLARE_GOTO_TIMEOUT_MS,
    },
    // 続 119 (B-2): lazy-load 画像を撮影前にロードさせる注入スクリプト。
    addScriptTag: [{ content: CLOUDFLARE_LAZY_LOAD_SCRIPT }],
  }
}

/** CF 失敗 response (JSON) から errors[].message を best-effort で取り出す。 */
async function extractCloudflareError(res: Response): Promise<string | null> {
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!type.includes('application/json')) return null
  const json = await res.json().catch(() => null)
  return extractCloudflareErrorFromJson(json)
}

function extractCloudflareErrorFromJson(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null
  const errors = (json as { errors?: unknown }).errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  const first = errors[0]
  if (typeof first === 'object' && first !== null && 'message' in first) {
    const msg = (first as { message?: unknown }).message
    return typeof msg === 'string' ? msg : null
  }
  return null
}

/**
 * Cloudflare Browser Rendering で capture し、bytes + meta を返す (R2 PUT 用)。
 *
 * imageUrl は degrade 経路 (R2 未設定) で `<img>` が即使えるよう data: URL を埋め込む
 * (CF の画像は外部 CDN URL を持たないため)。R2 cache 層は PUT 後に signed GET URL へ差し替える。
 *
 * SSRF guard は呼び元 (route handler) で必ず通すこと。本関数は guarded 済 URL を前提とする。
 */
export async function captureViaCloudflareBR(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  config: CloudflareBRConfig
  cacheKey?: string
  capturedAt?: string
  fetchImpl?: typeof fetch
}): Promise<ScreenshotCaptureResult> {
  const cacheKey = input.cacheKey ?? buildCacheKey(input)
  const fetched = await fetchFromCloudflareBR({
    pageUrl: input.pageUrl,
    device: input.device,
    config: input.config,
    fetchImpl: input.fetchImpl,
  })
  const image: CapturedImageBytes = { bytes: fetched.bytes, contentType: fetched.contentType }
  const dataUrl = toDataUrl(fetched.bytes, fetched.contentType)
  const capture = buildUnderlayCapture(
    input,
    {
      imageUrl: dataUrl,
      naturalWidth: fetched.naturalWidth,
      naturalHeight: fetched.naturalHeight,
    },
    cacheKey,
    'cloudflare',
    input.capturedAt,
  )
  return { capture, image }
}

/** bytes を base64 data: URL に変換する (degrade 経路の `<img src>` 用)。 */
function toDataUrl(bytes: Uint8Array, contentType: string): string {
  const base64 = Buffer.from(bytes).toString('base64')
  return `data:${contentType};base64,${base64}`
}

/**
 * provider を選択して capture する統合エントリ。
 *   - Cloudflare env (CLOUDFLARE_API_TOKEN + account id) が揃っていれば Browser Rendering を使う。
 *   - 揃っていなければ Microlink へ fallback (後方互換、CF 未設定環境で何も壊さない)。
 *
 * R2 cache 層 (lib/heatmap/r2-screenshot-cache.ts) はこの関数を呼ぶ。
 */
export async function captureScreenshot(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
  cacheKey?: string
  capturedAt?: string
  fetchImpl?: typeof fetch
  /** test 用 CF config override (未指定なら env から解決) */
  cloudflareConfig?: CloudflareBRConfig | null
}): Promise<ScreenshotCaptureResult> {
  const cf =
    input.cloudflareConfig !== undefined ? input.cloudflareConfig : getCloudflareBRConfig()
  if (cf) {
    return captureViaCloudflareBR({ ...input, config: cf })
  }
  return captureViaMicrolink(input)
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
  return buildUnderlayCapture(input, fetched, input.cacheKey, 'microlink')
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
  provider: ScreenshotProvider,
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
    provider,
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
