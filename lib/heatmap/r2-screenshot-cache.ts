/**
 * Heatmap screenshot — R2 永続 cache layer (L2) + lazy capture + TTL + SWR + dedupe lock。
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / §3.8.1 multi-tenant isolation
 * Dispatch: 続 perf heatmap screenshot R2 cache (Phase 1 MVP)
 *
 * 役割 (in-memory L1 cache の手前に R2 L2 を足す):
 *   1. L1 (in-memory, 同一 serverless instance のみ) → hit なら即返す
 *   2. L2 (R2, instance 横断で永続) → fresh なら R2 から read して返す
 *        - stale (freshTtl 超過 but staleTtl 以内) → 即返しつつ background 再 capture (SWR)
 *        - miss / staleTtl 超過 → 同期 capture
 *   3. capture (Microlink) → 画像 bytes + meta JSON を R2 に PUT してから返す
 *
 * dedupe: 同一 {tenant,site,url,device} の concurrent capture を Redis lock (SET NX EX) で 1 本化。
 *         Redis 不達時は fail-open (余分な 1 capture は許容、コードベースの fail-open 方針に整合)。
 *
 * tenant isolation: R2 key は tenant/site/device/urlHash scoped。cross-tenant key を一切生成しない。
 *
 * 後方互換: R2 env 未設定なら L2 を完全 skip し、従来の L1-only capture へ degrade する
 *           (`fetchHeatmapUnderlay` 同等)。何も壊れない。
 */

import { createHash } from 'node:crypto'

import {
  CAPTURE_WIDTH_FOR_DEVICE,
  captureScreenshot,
  getMemoryCachedUnderlay,
  setMemoryCachedUnderlay,
  buildCacheKey,
  type CapturedImageBytes,
  type CloudflareBRConfig,
} from '@/lib/heatmap/screenshot-provider'
import type {
  HeatmapDevice,
  HeatmapUnderlayCapture,
  ScreenshotProvider,
} from '@/lib/heatmap/types'
import { redis } from '@/lib/redis'
import {
  R2ConfigError,
  getR2ConfigFromEnv,
  signR2GetUrl,
  signR2PutUrl,
  type R2Config,
} from '@/lib/scenarios/r2-signed-url'

/** R2 key prefix + 内容バージョン (capture pipeline 変更時に bump して cache 全体を無効化) */
const KEY_PREFIX = 'heatmap-screenshots'
// 続 119 (B): waitUntil 'networkidle2' 化で v2、Cloudflare Browser Rendering 移行で v3。
// 続 119 (B-2): lazy-load 画像対策 (addScriptTag で eager 化+scroll) で撮影内容が変わったため v4。
//   旧 v3 (CF だが lazy 画像が空) を全 cache miss にして再撮影させる。
// 続120: lazy script 強化 (noscript / data-lazy-src / class 除去 / scroll event) で撮影内容が
//   変わったため v5。旧 v4 (lazy 画像が依然空) を全 cache miss にして再撮影させる。
// fix/login-bounce-whitescreen-117: Puppeteer Worker (autoScroll + waitForNetworkIdle) 移行で v6。
//   旧 v5 (CF REST で lazy 画像が依然空になりうる) を全 cache miss にして再撮影させる。
// 続121: SCREENSHOT_WORKER_URL を本番投入。Microlink 時代の空画像キャッシュ (v6) を全 miss に
//   して Worker 経由で再撮影させるため v7。provider は cache key に含まれないため version bump で flush。
// 続129: SCREENSHOT_WORKER_URL/TOKEN の本番 env 投入 (3日前) より前に v7 で撮られた
//   CF REST 経路の空画像キャッシュが凍結残存していたため v8 で全 miss にし、Worker 経由で再撮影。
// 続133: Worker に高さ上限 (面積 clip) + lazy 強化 (data-src 昇格 / naturalWidth 待ち) を投入。
//   旧 v8 (巨大ページで Worker timeout → 劣化 fallback → lazy 画像が空白) を全 miss にし、
//   新 Worker で撮り直す。**worker の wrangler deploy 後に**この bump 版を deploy すること。
// 続135: Microlink fallback の waitUntil='networkidle2' を撤去 (ビジーページで上部1枚しか
//   撮れていなかった = 症状①)。旧 v9 で凍結した短尺 Microlink 画像を全 miss にして撮り直す。
// P2 (⑤⑥ full-height): Worker の x-capture-capped / x-capture-full-height を capture+metadata に
//   通すようになった。旧 v10 cache は capped 情報を持たないため (= capped ページの scroll/exit が
//   画像高で頭打ちのまま) v11 に bump し、Worker 経由で metadata 付きに撮り直す。
const CAPTURE_VERSION = 'v11'

/** TTL (capturedAt 比較) */
const FRESH_TTL_MS = 24 * 60 * 60 * 1000 // 24h: これ以内なら即返す
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d: これ以内なら返しつつ background 再取得
/**
 * 劣化経路 (microlink fallback) capture の fresh 窓。
 * Microlink は autoScroll/lazy 昇格をしないため「lazy 画像が空白」「上部のみ」になりやすい。
 * これを 24h fresh で固定すると、Worker が復旧しても劣化画像を丸1日配り続ける
 * (=「画像が出ない」が何度も再発して見える主因)。1h に短縮し、SWR 再撮影で
 * Worker capture へ自動置換されるようにする (自己修復)。
 */
const DEGRADED_FRESH_TTL_MS = 60 * 60 * 1000 // 1h

/** signed GET URL の寿命 (`<img>` 表示用、短命) */
const SIGNED_GET_TTL_SEC = 300 // 5 min

/** dedupe lock の寿命 (capture が長引いても確実に解放される上限) */
const LOCK_TTL_SEC = 60

/**
 * R2 に保存する metadata JSON。座標系が必要とする値一式 + cache key inputs を含む。
 * 画像 bytes (.jpg) と対で `{...}.json` に保存する。
 */
export interface R2ScreenshotMetadata {
  /** schema version (将来の後方互換用) */
  schemaVersion: 1
  tenantId: string
  siteId: string
  /** canonical page URL (cache key 入力、ownership lookup と同一文字列) */
  pageUrl: string
  device: HeatmapDevice
  /** capture viewport 幅 = CSS px 基準幅 (DPR 非依存) */
  viewportWidth: number
  /** image 実 px 幅 */
  naturalWidth: number
  /** image 実 px 高 */
  naturalHeight: number
  /** ISO timestamp (TTL/SWR 判定の基準) */
  capturedAt: string
  /** capture を撮った provider (cloudflare = Browser Rendering、microlink = fallback) */
  provider: ScreenshotProvider
  captureVersion: string
  /** R2 object content-type (.jpg / .png / .webp) */
  imageContentType: string
  /** P2: Worker が巨大ページを上端 clip したか (capped 画像) */
  capped?: boolean
  /** P2: 実ページの CSS px 全高 (capped 時の真の document 高) */
  fullPageCssHeight?: number
}

export type R2CacheTier = 'l1' | 'r2-fresh' | 'r2-stale' | 'capture' | 'degraded'

export interface HeatmapUnderlayWithR2 {
  capture: HeatmapUnderlayCapture
  /** どの層から返ったか (observability / test 用) */
  tier: R2CacheTier
}

/** test / DI 用の hook (Redis lock + clock 差し替え) */
export interface R2CacheHooks {
  /** 現在時刻 (TTL 判定) — default Date.now() */
  now?: () => number
  /** background revalidate を scheduler に積む — default `scheduleBackgroundTask` */
  schedule?: (task: () => Promise<void>) => void
  /** lock 取得 — default Redis SET NX EX。true=取得成功 */
  acquireLock?: (lockKey: string, ttlSec: number) => Promise<boolean>
  /** lock 解放 — default Redis DEL */
  releaseLock?: (lockKey: string) => Promise<void>
  /** R2 config override (test 用) */
  r2Config?: R2Config
  /** fetch 差し替え (test 用) */
  fetchImpl?: typeof fetch
  /**
   * Cloudflare Browser Rendering config override (test 用)。
   *   - undefined: env から解決 (本番)
   *   - null     : CF を無効化し Microlink fallback を強制 (test 用)
   *   - object   : 指定 config で CF を使う
   */
  cloudflareConfig?: CloudflareBRConfig | null
}

/**
 * R2 (L2) cache を前段に置いた screenshot 取得の公開 API。
 * route handler はこれを呼ぶ。SSRF guard / ownership check は呼び元の責務。
 *
 * pageUrl は **canonicalize 済** (ownership lookup と同一文字列) を渡すこと。
 */
export async function getHeatmapUnderlayWithR2Cache(
  input: {
    tenantId: string
    siteId: string
    pageUrl: string
    device: HeatmapDevice
  },
  hooks: R2CacheHooks = {},
): Promise<HeatmapUnderlayWithR2> {
  const now = hooks.now ?? (() => Date.now())
  const cacheKey = buildCacheKey(input)
  const r2 = resolveR2Config(hooks.r2Config)

  // ── L1: in-memory ────────────────────────────────────────────────────────
  const l1 = getMemoryCachedUnderlay(cacheKey)
  if (l1) {
    // 署名 GET URL は短命 (5min) だが L1 TTL はそれより長い。失効した署名URLを配らない
    // よう、R2 由来 capture は毎ヒットで鍵から再署名する (CDN/data URL の degrade 分は据置)。
    const served = await reSignR2Url(input, l1, r2)
    return { capture: { ...served, cached: true }, tier: 'l1' }
  }

  // R2 未設定なら L2 を skip して degrade (L1-only capture)
  if (!r2) {
    const capture = await captureAndCacheL1Only(input, cacheKey, hooks)
    return { capture, tier: 'degraded' }
  }

  // ── L2: R2 lookup ─────────────────────────────────────────────────────────
  const r2Hit = await readFromR2(input, r2, hooks.fetchImpl).catch(() => null)
  if (r2Hit) {
    const ageMs = now() - Date.parse(r2Hit.metadata.capturedAt)
    // microlink (劣化 fallback) capture は fresh 窓を 1h に短縮 → SWR で自己修復
    const freshTtlMs =
      r2Hit.metadata.provider === 'cloudflare' ? FRESH_TTL_MS : DEGRADED_FRESH_TTL_MS
    if (Number.isFinite(ageMs) && ageMs <= freshTtlMs) {
      setMemoryCachedUnderlay(cacheKey, r2Hit.capture)
      return { capture: { ...r2Hit.capture, cached: true }, tier: 'r2-fresh' }
    }
    if (Number.isFinite(ageMs) && ageMs <= STALE_TTL_MS) {
      // stale-while-revalidate: 即返しつつ background 再 capture (lock 尊重)
      setMemoryCachedUnderlay(cacheKey, r2Hit.capture)
      scheduleRevalidate(input, cacheKey, r2, hooks, now)
      return { capture: { ...r2Hit.capture, cached: true }, tier: 'r2-stale' }
    }
    // staleTtl 超過 → fall through to synchronous capture
  }

  // ── capture (synchronous), then PUT to R2 ──────────────────────────────────
  const capture = await captureStoreAndCacheL1(input, cacheKey, r2, hooks, now)
  return { capture, tier: 'capture' }
}

// ── capture orchestration ────────────────────────────────────────────────────

async function captureAndCacheL1Only(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  cacheKey: string,
  hooks: R2CacheHooks,
): Promise<HeatmapUnderlayCapture> {
  const { capture } = await captureScreenshot({
    ...input,
    cacheKey,
    fetchImpl: hooks.fetchImpl,
    cloudflareConfig: hooks.cloudflareConfig,
  })
  setMemoryCachedUnderlay(cacheKey, capture)
  return capture
}

/**
 * 同期 capture: Microlink で撮り、R2 に bytes + meta JSON を PUT し、
 * imageUrl を R2 の short-lived signed GET URL に差し替えて返す。L1 にも hydrate。
 */
async function captureStoreAndCacheL1(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  cacheKey: string,
  r2: R2Config,
  hooks: R2CacheHooks,
  now: () => number,
): Promise<HeatmapUnderlayCapture> {
  const { capture, image } = await captureScreenshot({
    ...input,
    cacheKey,
    capturedAt: new Date(now()).toISOString(),
    fetchImpl: hooks.fetchImpl,
    cloudflareConfig: hooks.cloudflareConfig,
  })
  // R2 write/sign が失敗しても screenshot 自体は返す (perf 改修で可用性を落とさない)。
  // その場合は capture の CDN imageUrl をそのまま使い、L1 にだけ hydrate する。
  try {
    await storeInR2(input, capture, image, r2, hooks.fetchImpl)
    const served = await toR2ServedCapture(input, capture, r2)
    setMemoryCachedUnderlay(cacheKey, served)
    return served
  } catch (err) {
    // P3 (③⑦ root cause): R2 PUT/sign の失敗を握り潰すと R2 に永続せず L1 (per-instance memory)
    //   のみになり、別インスタンス/TTL 失効で「毎回 cold capture」に戻る。可用性は保ちつつ
    //   (capture は返す)、静かな失敗を必ず可視化して運用で気づけるようにする。
    console.error(
      '[heatmap-cache] R2 store failed; capture served but NOT persisted (will re-capture next time):',
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    )
    setMemoryCachedUnderlay(cacheKey, capture)
    return capture
  }
}

/**
 * background 再 capture を scheduler に積む。lock を尊重 (concurrent 多重 capture を防ぐ)。
 * lock 取得失敗 = 別リクエストが既に再取得中なので no-op。
 */
function scheduleRevalidate(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  cacheKey: string,
  r2: R2Config,
  hooks: R2CacheHooks,
  now: () => number,
): void {
  const schedule = hooks.schedule ?? scheduleBackgroundTask
  const lockKey = buildLockKey(cacheKey)
  schedule(async () => {
    const acquire = hooks.acquireLock ?? defaultAcquireLock
    const release = hooks.releaseLock ?? defaultReleaseLock
    const got = await acquire(lockKey, LOCK_TTL_SEC)
    if (!got) return // 別リクエストが再取得中
    try {
      const { capture, image } = await captureScreenshot({
        ...input,
        cacheKey,
        capturedAt: new Date(now()).toISOString(),
        fetchImpl: hooks.fetchImpl,
        cloudflareConfig: hooks.cloudflareConfig,
      })
      await storeInR2(input, capture, image, r2, hooks.fetchImpl)
      const served = await toR2ServedCapture(input, capture, r2)
      setMemoryCachedUnderlay(cacheKey, served)
    } catch (err) {
      // P3 (③⑦): SWR background の静かな失敗を可視化。stale capture は既に返済済みのため
      //   ユーザー影響は無い (致命ではない) が、永続更新が止まり続けるのを運用で検知できるようにする。
      console.error(
        '[heatmap-cache] background revalidate failed (stale capture kept, R2 not refreshed):',
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      )
    } finally {
      await release(lockKey).catch(() => undefined)
    }
  })
}

// ── R2 read / write ──────────────────────────────────────────────────────────

interface R2ReadResult {
  capture: HeatmapUnderlayCapture
  metadata: R2ScreenshotMetadata
}

/**
 * R2 から metadata JSON を read し、fresh/stale 判定用に capture を組み立てる。
 * imageUrl は短命 signed GET URL に設定する (private bucket からの直接 read 用)。
 * object 不在 (404) や parse 失敗時は null を返す (= miss 扱い)。
 */
async function readFromR2(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  r2: R2Config,
  fetchImpl?: typeof fetch,
): Promise<R2ReadResult | null> {
  const keys = buildR2Keys(input)
  const metaSigned = await signR2GetUrl({ key: keys.metaKey, ttlSec: SIGNED_GET_TTL_SEC, config: r2 })
  const f = fetchImpl ?? fetch
  const res = await f(metaSigned.downloadUrl, { method: 'GET' })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) return null
  let metadata: R2ScreenshotMetadata
  try {
    const json: unknown = await res.json()
    metadata = parseMetadata(json)
  } catch {
    return null
  }
  if (metadata.captureVersion !== CAPTURE_VERSION) return null

  const imageSigned = await signR2GetUrl({
    key: keys.imageKey,
    ttlSec: SIGNED_GET_TTL_SEC,
    config: r2,
  })
  const capture: HeatmapUnderlayCapture = {
    pageUrl: metadata.pageUrl,
    imageUrl: imageSigned.downloadUrl,
    viewportWidth: metadata.viewportWidth,
    viewportHeight: metadata.naturalHeight,
    naturalWidth: metadata.naturalWidth,
    naturalHeight: metadata.naturalHeight,
    device: metadata.device,
    capturedAt: metadata.capturedAt,
    cacheKey: buildCacheKey(input),
    provider: metadata.provider,
    cached: true,
    // P2: cache HIT でも capped 情報を復元しないと scroll/exit が画像高で頭打ちに戻る。
    ...(metadata.capped ? { capped: true } : {}),
    ...(metadata.fullPageCssHeight ? { fullPageCssHeight: metadata.fullPageCssHeight } : {}),
  }
  return { capture, metadata }
}

/** capture 結果 (bytes + meta) を R2 に PUT する (image → meta の順)。 */
async function storeInR2(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  capture: HeatmapUnderlayCapture,
  image: CapturedImageBytes,
  r2: R2Config,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const keys = buildR2Keys(input)
  const f = fetchImpl ?? fetch

  const imageSigned = await signR2PutUrl({
    key: keys.imageKey,
    contentType: image.contentType,
    config: r2,
  })
  const imgPut = await f(imageSigned.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': image.contentType },
    // Uint8Array は BodyInit 互換 (ArrayBufferView)。型差異は cast で吸収。
    body: image.bytes as unknown as BodyInit,
  })
  if (!imgPut.ok) {
    throw new Error(`R2 image PUT failed: HTTP ${imgPut.status}`)
  }

  const metadata: R2ScreenshotMetadata = {
    schemaVersion: 1,
    tenantId: input.tenantId,
    siteId: input.siteId,
    pageUrl: capture.pageUrl,
    device: capture.device,
    viewportWidth: capture.viewportWidth,
    naturalWidth: capture.naturalWidth,
    naturalHeight: capture.naturalHeight,
    capturedAt: capture.capturedAt,
    provider: capture.provider,
    captureVersion: CAPTURE_VERSION,
    imageContentType: image.contentType,
    // P2: undefined のフィールドは JSON.stringify で省略される (後方互換)。
    capped: capture.capped,
    fullPageCssHeight: capture.fullPageCssHeight,
  }
  const metaSigned = await signR2PutUrl({
    key: keys.metaKey,
    contentType: 'application/json',
    config: r2,
  })
  const metaPut = await f(metaSigned.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  })
  if (!metaPut.ok) {
    throw new Error(`R2 metadata PUT failed: HTTP ${metaPut.status}`)
  }
}

/** capture の imageUrl を R2 signed GET URL に差し替えた serve 用 capture を返す。 */
async function toR2ServedCapture(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  capture: HeatmapUnderlayCapture,
  r2: R2Config,
): Promise<HeatmapUnderlayCapture> {
  const keys = buildR2Keys(input)
  const imageSigned = await signR2GetUrl({
    key: keys.imageKey,
    ttlSec: SIGNED_GET_TTL_SEC,
    config: r2,
  })
  return { ...capture, imageUrl: imageSigned.downloadUrl }
}

/**
 * L1 capture を serve する際の imageUrl 再署名。
 * 短命署名URL (5min) を長命 L1 (>=1h) が抱えると失効 URL を配ってしまうため、R2 由来
 * (署名URL ホスト一致) の capture は鍵から都度再署名する。
 * R2 未設定、または CDN / data: URL (degrade / R2 書込失敗フォールバック) はそのまま返す。
 */
async function reSignR2Url(
  input: { tenantId: string; siteId: string; pageUrl: string; device: HeatmapDevice },
  capture: HeatmapUnderlayCapture,
  r2: R2Config | null,
): Promise<HeatmapUnderlayCapture> {
  if (!r2) return capture
  const r2Host = `${r2.accountId}.r2.cloudflarestorage.com`
  if (!capture.imageUrl.includes(r2Host)) return capture
  try {
    const keys = buildR2Keys(input)
    const signed = await signR2GetUrl({
      key: keys.imageKey,
      ttlSec: SIGNED_GET_TTL_SEC,
      config: r2,
    })
    return { ...capture, imageUrl: signed.downloadUrl }
  } catch {
    return capture
  }
}

// ── R2 key schema ─────────────────────────────────────────────────────────────

interface R2Keys {
  imageKey: string
  metaKey: string
}

/**
 * R2 key schema:
 *   heatmap-screenshots/v1/{tenantId}/{siteId}/{device}/{urlHash}/{captureVersion}.jpg
 *   heatmap-screenshots/v1/{tenantId}/{siteId}/{device}/{urlHash}/{captureVersion}.json
 *
 * tenantId / siteId / device で scope し、cross-tenant key を生成しない。
 * urlHash は canonical pageUrl の sha256 (path/query をそのまま反映、衝突回避)。
 */
export function buildR2Keys(input: {
  tenantId: string
  siteId: string
  pageUrl: string
  device: HeatmapDevice
}): R2Keys {
  const urlHash = createHash('sha256').update(input.pageUrl).digest('hex').slice(0, 32)
  const tenant = sanitizeKeySegment(input.tenantId)
  const site = sanitizeKeySegment(input.siteId)
  const device = sanitizeKeySegment(input.device)
  const base = `${KEY_PREFIX}/${CAPTURE_VERSION}/${tenant}/${site}/${device}/${urlHash}/${CAPTURE_VERSION}`
  return { imageKey: `${base}.jpg`, metaKey: `${base}.json` }
}

/**
 * R2 key segment (tenant / site / device ID) は [A-Za-z0-9_-] のみ許可。
 * それ以外 (slash や dot を含む) は `_` に置換し、key injection / 紛らわしい `..` を排除する。
 * これらは ID であってファイル名ではないため dot を許可する必要がない。
 */
function sanitizeKeySegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 128) : '_'
}

function buildLockKey(cacheKey: string): string {
  return `heatmap:screenshot:lock:${cacheKey}`
}

// ── metadata parse ─────────────────────────────────────────────────────────────

function parseMetadata(raw: unknown): R2ScreenshotMetadata {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('metadata is not an object')
  }
  const o = raw as Record<string, unknown>
  const device = o.device
  if (device !== 'pc' && device !== 'sp' && device !== 'tab') {
    throw new Error('metadata.device invalid')
  }
  const pageUrl = o.pageUrl
  const capturedAt = o.capturedAt
  if (typeof pageUrl !== 'string' || typeof capturedAt !== 'string') {
    throw new Error('metadata.pageUrl / capturedAt invalid')
  }
  const viewportWidth = numberOr(o.viewportWidth, CAPTURE_WIDTH_FOR_DEVICE[device])
  const naturalWidth = numberOr(o.naturalWidth, viewportWidth)
  const naturalHeight = numberOr(o.naturalHeight, viewportWidth * 2)
  return {
    schemaVersion: 1,
    tenantId: typeof o.tenantId === 'string' ? o.tenantId : '',
    siteId: typeof o.siteId === 'string' ? o.siteId : '',
    pageUrl,
    device,
    viewportWidth,
    naturalWidth,
    naturalHeight,
    capturedAt,
    // 不明 / legacy 値は microlink 扱い (旧 cache の後方互換、v3 bump で実質再撮影される)。
    provider: o.provider === 'cloudflare' ? 'cloudflare' : 'microlink',
    captureVersion: typeof o.captureVersion === 'string' ? o.captureVersion : '',
    imageContentType: typeof o.imageContentType === 'string' ? o.imageContentType : 'image/jpeg',
    // P2: 欠落 (旧 cache) は undefined → 後方互換 (naturalHeight を全高とみなす)。
    capped: o.capped === true ? true : undefined,
    fullPageCssHeight:
      typeof o.fullPageCssHeight === 'number' && Number.isFinite(o.fullPageCssHeight)
        ? o.fullPageCssHeight
        : undefined,
  }
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

// ── R2 config resolution ─────────────────────────────────────────────────────

function resolveR2Config(override?: R2Config): R2Config | null {
  if (override) return override
  try {
    return getR2ConfigFromEnv()
  } catch (err) {
    if (err instanceof R2ConfigError) return null
    throw err
  }
}

// ── dedupe lock (Redis SET NX EX, fail-open) ──────────────────────────────────

async function defaultAcquireLock(lockKey: string, ttlSec: number): Promise<boolean> {
  try {
    const res = await redis().set(lockKey, '1', 'EX', ttlSec, 'NX')
    return res === 'OK'
  } catch {
    // Redis 不達 → fail-open (余分な 1 capture を許容)
    return true
  }
}

async function defaultReleaseLock(lockKey: string): Promise<void> {
  try {
    await redis().del(lockKey)
  } catch {
    // best-effort: lock は TTL で自然解放される
  }
}

// ── background scheduler (Next.js after() があれば使う、無ければ detached promise) ──

/**
 * background task を scheduler に積む。
 *
 * Next.js 15+ では `after()` (response 後に実行、serverless が freeze しない) が使えるが、
 * 本リポジトリは Next 14.2 で `after()` 未提供。よって runtime feature-detect し、
 * 無ければ detached promise (fire-and-forget) に degrade する。
 * (Next 15 へ上げれば自動で `after()` 経路に切り替わる。)
 */
function scheduleBackgroundTask(task: () => Promise<void>): void {
  const after = tryGetNextAfter()
  if (after) {
    after(() => {
      void task().catch(() => undefined)
    })
    return
  }
  // fallback: detached promise (unhandled rejection を握りつぶす)
  void task().catch(() => undefined)
}

type AfterFn = (callback: () => void) => void

/** next/server から `after` / `unstable_after` を runtime に探す (静的依存にしない)。 */
function tryGetNextAfter(): AfterFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('next/server') as Record<string, unknown>
    const candidate = mod.after ?? mod.unstable_after
    if (typeof candidate === 'function') {
      return candidate as AfterFn
    }
  } catch {
    // ignore — fallback to detached promise
  }
  return null
}
