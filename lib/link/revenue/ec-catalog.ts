/**
 * UGOKI LINK v2 — 束 4-D (§8.13 1・2・3): 物販 EC 受け口・在庫状態・注文通知・粗利分離・3重売り切れ除外
 *
 * 設計書 §8.13 (1・2・3):
 * 1. **3 つの受け口**:
 *    (a) 全件商品フィード取込 (`ingestFullProductFeed`)
 *    (b) SKU 単位差分 Webhook (`ingestSkuDeltaWebhook`):
 *        - 秘密鍵スコープ `products:write` + HMAC-SHA256 署名検証必須
 *        - 全項目スナップショット＋単調増加 `sku_version` のみ受理（部分更新・古い版は拒否/無視）
 *        - `event_id` 重複排除
 *        - 親商品の販売可否は子 SKU の状態から自動導出
 *        - 強い整合性ストア書込確定後にのみ `http_status: 200`、失敗時は `503`（EC側再送）
 *    (c) 注文通知 (`ingestOrderNotification`):
 *        - スコープ `orders:write` + 署名検証・返品/キャンセル遅延反映
 * 2. **鮮度期限 & 連番欠番フェイルクローズ**:
 *    - 死活合図 (heartbeat) または SKU 更新が鮮度期限超過、あるいは連番欠番が検知された場合は
 *      即座に `unavailable` へ倒す（期限切れ商品 0 件露出ゲート）。
 *    - 価格鮮度超過時は `hide_price: true`（古い価格を出さず名前＋画像のみ）。
 * 3. **粗利機密分離**:
 *    - `gross_margin` はサーバー専用ストアへ完全隔離。ブラウザ投影 DTO (`toBrowserProductProjection`) には
 *      型・実行時両面で決して含めない (`assertNoGrossMarginLeak`)。
 * 4. **3 重売り切れ除外支援 API**:
 *    - (1) ブラウザ直前確認口 (`checkPageProductsForBrowser`: `page_id` のみ受取・訪問者情報 0・同意 `off` でも動作)
 *    - (2) エッジ応答時 HTML 除去 (`filterUnavailableProductsAtEdge`)
 *    - (3) 売り切れ商品掲載 URL 逆引き索引 (`getPagesFeaturingProduct`: 7 日 1 回制限非カウント)
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { computeUrlKeyV2 } from '@/packages/contract/urlkey'

import type { EcMemberSummaryStore } from './ec-member-store'

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

export const DEFAULT_STOCK_FRESHNESS_TTL_MS = 60 * 60 * 1000 // 1 hour
export const DEFAULT_PRICE_FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
export const DEFAULT_HEARTBEAT_TTL_MS = 15 * 60 * 1000 // 15 minutes

export type EcApiKeyScope = 'products:write' | 'orders:write'
export type ProductDurabilityKind = 'durable' | 'consumable' | 'unknown'

export interface EcSkuFullPayload {
  readonly sku_id: string
  readonly parent_product_id: string
  readonly sku_version: number
  readonly title: string
  readonly product_url: string
  readonly image_url: string | null
  readonly in_stock: boolean
  readonly stock_quantity?: number | null
  readonly published: boolean
  readonly sale_start_at: string | null
  readonly sale_end_at: string | null
  readonly price: number
  readonly currency: string
  readonly category: string
  readonly brand: string | null
  readonly durability: ProductDurabilityKind
  readonly repurchase_cycle_days: number | null
  readonly sensitive_category: boolean
  /** Server-only confidential field — stripped from public catalog & browser projection (§8.13 #1) */
  readonly gross_margin?: number | null
  readonly updated_at: string
}

export interface StoredPublicSku {
  readonly tenant_id: string
  readonly site_id: string
  readonly sku_id: string
  readonly parent_product_id: string
  readonly sku_version: number
  readonly title: string
  readonly product_url_key_v2: string
  readonly image_url: string | null
  readonly in_stock: boolean
  readonly stock_quantity: number | null
  readonly published: boolean
  readonly sale_start_at: string | null
  readonly sale_end_at: string | null
  readonly price: number
  readonly currency: string
  readonly category: string
  readonly brand: string | null
  readonly durability: ProductDurabilityKind
  readonly repurchase_cycle_days: number | null
  readonly sensitive_category: boolean
  readonly updated_at: string
}

export interface BrowserProductProjection {
  readonly product_id: string
  readonly title: string
  readonly product_url_key_v2: string
  readonly image_url: string | null
  readonly available: boolean
  readonly hide_price: boolean
  readonly price: number | null
  readonly currency: string | null
  readonly category: string
  readonly brand: string | null
}

export interface EcWebhookAuthHeaders {
  readonly scope: EcApiKeyScope
  readonly signature: string
  readonly timestamp_sec: number
}

export interface EcSkuDeltaWebhookRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly event_id: string
  readonly sequence_no?: number
  /** MUST be full SKU payload (partial patch payloads rejected per §8.13 #1) */
  readonly sku: Partial<EcSkuFullPayload>
  readonly auth: EcWebhookAuthHeaders
  readonly raw_body: string
}

export interface EcOrderLineItem {
  readonly product_id: string
  readonly sku_id: string
  readonly quantity: number
  readonly unit_price: number
}

export interface EcOrderNotificationRequest {
  readonly tenant_id: string
  readonly site_id: string
  readonly order_event_id: string
  readonly order_id: string
  readonly order_status: 'placed' | 'returned' | 'cancelled'
  readonly member_key?: string | null
  readonly data_epoch?: number
  readonly items: readonly EcOrderLineItem[]
  readonly occurred_at: string
  readonly auth: EcWebhookAuthHeaders
  readonly raw_body: string
}

export interface StrongStoreCommitAdapter {
  /** Commits unavailable-product set synchronously/strongly. Return false or throw to trigger 503. */
  commitUnavailableSet(
    tenantId: string,
    siteId: string,
    unavailableProductIds: readonly string[],
  ): boolean
}

export class InMemoryStrongUnavailableStore implements StrongStoreCommitAdapter {
  private readonly sets = new Map<string, ReadonlySet<string>>()
  public failNextCommit = false

  commitUnavailableSet(
    tenantId: string,
    siteId: string,
    unavailableProductIds: readonly string[],
  ): boolean {
    if (this.failNextCommit) {
      this.failNextCommit = false
      return false
    }
    this.sets.set(`${tenantId}|${siteId}`, new Set(unavailableProductIds))
    return true
  }

  getCommittedUnavailable(tenantId: string, siteId: string): ReadonlySet<string> {
    return this.sets.get(`${tenantId}|${siteId}`) ?? new Set()
  }
}

// ---------------------------------------------------------------------------
// Webhook Signing & Gross Margin Leak Guard
// ---------------------------------------------------------------------------

export function signEcWebhookPayload(params: {
  readonly tenant_id: string
  readonly site_id: string
  readonly scope: EcApiKeyScope
  readonly timestamp_sec: number
  readonly raw_body: string
  readonly secret: string | Buffer
}): string {
  const payload = `${params.tenant_id}|${params.site_id}|${params.scope}|${params.timestamp_sec}|${params.raw_body}`
  return `v1=${createHmac('sha256', params.secret).update(payload, 'utf8').digest('hex')}`
}

function verifyEcWebhookAuth(
  reqAuth: EcWebhookAuthHeaders,
  expectedScope: EcApiKeyScope,
  tenantId: string,
  siteId: string,
  rawBody: string,
  secret: string | Buffer,
): boolean {
  if (reqAuth.scope !== expectedScope) return false
  if (!Number.isFinite(reqAuth.timestamp_sec) || reqAuth.timestamp_sec <= 0) return false
  if (!reqAuth.signature || !reqAuth.signature.startsWith('v1=')) return false
  const expected = signEcWebhookPayload({
    tenant_id: tenantId,
    site_id: siteId,
    scope: expectedScope,
    timestamp_sec: reqAuth.timestamp_sec,
    raw_body: rawBody,
    secret,
  })
  const a = Buffer.from(reqAuth.signature, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJsonValue(a[i], b[i])) return false
    }
    return true
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined)
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false
    if (!deepEqualJsonValue(objA[k], objB[k])) return false
  }
  return true
}

/**
 * Bounded LRU + TTL cache to prevent unbounded memory growth of webhook event_ids and order logs (§8.13).
 */
class BoundedTtlCache<V> {
  private readonly store = new Map<string, { readonly value: V; readonly expiresAtMs: number }>()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  private pruneExpired(nowMs: number): void {
    for (const [k, entry] of this.store.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.store.delete(k)
      }
    }
  }

  has(key: string, nowMs: number): boolean {
    const entry = this.store.get(key)
    if (!entry) return false
    if (entry.expiresAtMs <= nowMs) {
      this.store.delete(key)
      return false
    }
    // Refresh LRU order
    this.store.delete(key)
    this.store.set(key, entry)
    return true
  }

  get(key: string, nowMs: number): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAtMs <= nowMs) {
      this.store.delete(key)
      return undefined
    }
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: string, value: V, nowMs: number): void {
    this.pruneExpired(nowMs)
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }
    this.store.set(key, { value, expiresAtMs: nowMs + this.ttlMs })
  }

  get size(): number {
    return this.store.size
  }
}

const FORBIDDEN_MARGIN_KEYS = new Set(['gross_margin', 'margin_rate', 'cost_price', 'unit_cost'])

export function assertNoGrossMarginLeak(payload: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_MARGIN_KEYS.has(k.toLowerCase())) {
        throw new Error(
          `Confidential gross margin field "${k}" leaked into browser/public projection at ${path}.${k} (§8.13 #1)`,
        )
      }
      walk(v, `${path}.${k}`)
    }
  }
  walk(payload, '$')
}

function isFullSkuPayload(sku: Partial<EcSkuFullPayload>): sku is EcSkuFullPayload {
  return (
    typeof sku.sku_id === 'string' &&
    sku.sku_id.trim().length > 0 &&
    typeof sku.parent_product_id === 'string' &&
    sku.parent_product_id.trim().length > 0 &&
    typeof sku.sku_version === 'number' &&
    Number.isInteger(sku.sku_version) &&
    sku.sku_version >= 1 &&
    typeof sku.title === 'string' &&
    typeof sku.product_url === 'string' &&
    typeof sku.in_stock === 'boolean' &&
    typeof sku.published === 'boolean' &&
    typeof sku.price === 'number' &&
    Number.isFinite(sku.price) &&
    sku.price >= 0 &&
    typeof sku.currency === 'string' &&
    typeof sku.category === 'string' &&
    typeof sku.durability === 'string' &&
    typeof sku.sensitive_category === 'boolean' &&
    typeof sku.updated_at === 'string' &&
    !Number.isNaN(Date.parse(sku.updated_at))
  )
}

export const DEFAULT_MAX_WEBHOOK_DEDUPE_ENTRIES = 10_000
export const DEFAULT_WEBHOOK_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const DEFAULT_MAX_ORDER_LOG_ENTRIES = 10_000
export const DEFAULT_ORDER_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ---------------------------------------------------------------------------
// EC Catalog & Inventory State Engine
// ---------------------------------------------------------------------------

export interface EcCatalogServiceOptions {
  readonly products_write_secret: string | Buffer
  readonly orders_write_secret: string | Buffer
  readonly strong_store?: StrongStoreCommitAdapter
  readonly member_store?: EcMemberSummaryStore
  readonly stock_freshness_ttl_ms?: number
  readonly price_freshness_ttl_ms?: number
  readonly heartbeat_ttl_ms?: number
  readonly max_dedupe_entries?: number
  readonly dedupe_ttl_ms?: number
  readonly max_order_log_entries?: number
  readonly order_log_ttl_ms?: number
}

export class EcCatalogService {
  private readonly strongStore: StrongStoreCommitAdapter
  private readonly skus = new Map<string, StoredPublicSku>() // tenant|site|sku_id
  private readonly serverOnlyGrossMargin = new Map<string, number>() // tenant|site|sku_id (ISOLATED)
  private readonly processedEventIds: BoundedTtlCache<true>
  private readonly siteHeartbeats = new Map<string, number>() // tenant|site -> epoch ms
  private readonly siteLastSeq = new Map<string, number>()
  private readonly siteGapActive = new Map<string, boolean>()
  private readonly pageProductIndex = new Map<string, Set<string>>() // tenant|site|page_id -> product_ids
  private readonly productPageReverseIndex = new Map<string, Set<string>>() // tenant|site|product_id -> page_urls
  private readonly orders: BoundedTtlCache<EcOrderNotificationRequest>

  constructor(private readonly options: EcCatalogServiceOptions) {
    this.strongStore = options.strong_store ?? new InMemoryStrongUnavailableStore()
    this.processedEventIds = new BoundedTtlCache<true>(
      options.max_dedupe_entries ?? DEFAULT_MAX_WEBHOOK_DEDUPE_ENTRIES,
      options.dedupe_ttl_ms ?? DEFAULT_WEBHOOK_DEDUPE_TTL_MS,
    )
    this.orders = new BoundedTtlCache<EcOrderNotificationRequest>(
      options.max_order_log_entries ?? DEFAULT_MAX_ORDER_LOG_ENTRIES,
      options.order_log_ttl_ms ?? DEFAULT_ORDER_LOG_TTL_MS,
    )
  }

  getDedupeCacheSize(): number {
    return this.processedEventIds.size
  }

  getOrderLogSize(): number {
    return this.orders.size
  }

  private siteKey(tenantId: string, siteId: string): string {
    return `${tenantId}|${siteId}`
  }

  private skuKey(tenantId: string, siteId: string, skuId: string): string {
    return `${tenantId}|${siteId}|${skuId}`
  }

  recordSiteHeartbeat(tenantId: string, siteId: string, atIso: string): void {
    this.siteHeartbeats.set(this.siteKey(tenantId, siteId), Date.parse(atIso))
  }

  registerPageProductPlacement(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly page_url: string
    readonly product_ids: readonly string[]
  }): void {
    const pKey = `${params.tenant_id}|${params.site_id}|${params.page_id}`
    const pSet = new Set(params.product_ids)
    this.pageProductIndex.set(pKey, pSet)

    const normPageUrl = computeUrlKeyV2(params.page_url).url_key_v2
    for (const pid of params.product_ids) {
      const rKey = `${params.tenant_id}|${params.site_id}|${pid}`
      const urls = this.productPageReverseIndex.get(rKey) ?? new Set<string>()
      urls.add(normPageUrl)
      this.productPageReverseIndex.set(rKey, urls)
    }
  }

  private storeSkuInternal(tenantId: string, siteId: string, payload: EcSkuFullPayload): void {
    const k = this.skuKey(tenantId, siteId, payload.sku_id)
    const pubSku: StoredPublicSku = Object.freeze({
      tenant_id: tenantId,
      site_id: siteId,
      sku_id: payload.sku_id,
      parent_product_id: payload.parent_product_id,
      sku_version: payload.sku_version,
      title: payload.title,
      product_url_key_v2: computeUrlKeyV2(payload.product_url).url_key_v2,
      image_url: payload.image_url,
      in_stock: payload.in_stock,
      stock_quantity: payload.stock_quantity ?? null,
      published: payload.published,
      sale_start_at: payload.sale_start_at,
      sale_end_at: payload.sale_end_at,
      price: payload.price,
      currency: payload.currency,
      category: payload.category,
      brand: payload.brand,
      durability: payload.durability,
      repurchase_cycle_days: payload.repurchase_cycle_days,
      sensitive_category: payload.sensitive_category,
      updated_at: payload.updated_at,
    })
    this.skus.set(k, pubSku)

    // Store gross margin ONLY in isolated server-only map (§8.13 #1);
    // explicitly delete prior margin when updated SKU omits or nulls gross_margin!
    if (typeof payload.gross_margin === 'number' && Number.isFinite(payload.gross_margin)) {
      this.serverOnlyGrossMargin.set(k, payload.gross_margin)
    } else {
      this.serverOnlyGrossMargin.delete(k)
    }
  }

  private shouldAcceptIncomingSku(
    existing: StoredPublicSku | undefined,
    incoming: EcSkuFullPayload,
    mode: 'feed' | 'delta',
  ): { readonly accept: boolean; readonly reason: string } {
    if (!existing) return { accept: true, reason: 'new_sku' }
    if (incoming.sku_version < existing.sku_version) {
      return {
        accept: false,
        reason: `stale_sku_version:${incoming.sku_version}<${existing.sku_version}`,
      }
    }
    const prevTs = Date.parse(existing.updated_at)
    const nextTs = Date.parse(incoming.updated_at)
    if (Number.isFinite(prevTs) && Number.isFinite(nextTs) && nextTs < prevTs) {
      return {
        accept: false,
        reason: `stale_updated_at:${incoming.updated_at}<${existing.updated_at}`,
      }
    }
    if (mode === 'delta' && incoming.sku_version === existing.sku_version) {
      return {
        accept: false,
        reason: `stale_sku_version:${incoming.sku_version}<=${existing.sku_version}`,
      }
    }
    return { accept: true, reason: 'monotonic_advance' }
  }

  /**
   * 受け口 (a): 全件商品フィード取込。
   * - 単調増加 `(sku_version, updated_at)` を満たす項目のみ反映（未掲載の他 SKU は消去しない）
   * - 強い整合性ストア確定失敗 (`503` / 例外) 時はメモリ上の全変更を完全ロールバックする。
   */
  ingestFullProductFeed(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly items: readonly EcSkuFullPayload[]
    readonly synced_at: string
  }): { readonly http_status: 200 | 503; readonly ingested_count: number; readonly gap_cleared: boolean } {
    const sk = this.siteKey(params.tenant_id, params.site_id)
    const prevSkus = new Map<string, StoredPublicSku | undefined>()
    const prevMargins = new Map<string, number | undefined>()
    const prevGap = this.siteGapActive.get(sk)
    const prevHb = this.siteHeartbeats.get(sk)

    let appliedCount = 0
    for (const item of params.items) {
      if (!isFullSkuPayload(item)) continue
      const k = this.skuKey(params.tenant_id, params.site_id, item.sku_id)
      const prev = this.skus.get(k)
      if (this.shouldAcceptIncomingSku(prev, item, 'feed').accept) {
        if (!prevSkus.has(k)) {
          prevSkus.set(k, prev)
          prevMargins.set(k, this.serverOnlyGrossMargin.get(k))
        }
        this.storeSkuInternal(params.tenant_id, params.site_id, item)
        appliedCount++
      }
    }

    this.siteGapActive.set(sk, false)
    this.siteHeartbeats.set(sk, Date.parse(params.synced_at))

    const unavailable = this.computeUnavailableProductIds(
      params.tenant_id,
      params.site_id,
      params.synced_at,
    )
    let committed = false
    try {
      committed = this.strongStore.commitUnavailableSet(
        params.tenant_id,
        params.site_id,
        unavailable,
      )
    } catch {
      committed = false
    }

    if (!committed) {
      // Full atomic rollback of all mutated SKUs, margins, gap state, and heartbeat!
      for (const [k, oldSku] of prevSkus.entries()) {
        if (oldSku !== undefined) this.skus.set(k, oldSku)
        else this.skus.delete(k)
      }
      for (const [k, oldMargin] of prevMargins.entries()) {
        if (oldMargin !== undefined) this.serverOnlyGrossMargin.set(k, oldMargin)
        else this.serverOnlyGrossMargin.delete(k)
      }
      if (prevGap !== undefined) this.siteGapActive.set(sk, prevGap)
      else this.siteGapActive.delete(sk)
      if (prevHb !== undefined) this.siteHeartbeats.set(sk, prevHb)
      else this.siteHeartbeats.delete(sk)

      return Object.freeze({ http_status: 503, ingested_count: 0, gap_cleared: false })
    }
    return Object.freeze({
      http_status: 200,
      ingested_count: appliedCount,
      gap_cleared: true,
    })
  }

  /**
   * 受け口 (b): SKU 単位差分 Webhook。
   * - `products:write` 署名認証必須
   * - 署名検証済みの `raw_body` から JSON を直接復元し、`req.sku` との乖離を `400` 拒否
   * - 全項目必須（部分更新は `400` 拒否）
   * - 単調増加 `(sku_version, updated_at)`（古い版・古い時刻は無害に無視）
   * - `event_id` 重複排除（LRU + TTL 上限付き）
   * - 強い整合性ストア書込確定後にのみ `200`、失敗時は全状態を完全ロールバックし `503`
   */
  ingestSkuDeltaWebhook(
    req: EcSkuDeltaWebhookRequest,
    nowIso: string,
  ): {
    readonly http_status: 200 | 400 | 401 | 503
    readonly applied: boolean
    readonly deduplicated: boolean
    readonly stale_version_ignored: boolean
    readonly sequence_gap_detected: boolean
    readonly reason: string
  } {
    if (
      !verifyEcWebhookAuth(
        req.auth,
        'products:write',
        req.tenant_id,
        req.site_id,
        req.raw_body,
        this.options.products_write_secret,
      )
    ) {
      return Object.freeze({
        http_status: 401,
        applied: false,
        deduplicated: false,
        stale_version_ignored: false,
        sequence_gap_detected: false,
        reason: 'unauthorized_products_write_signature',
      })
    }

    // Parse SKU directly from HMAC-verified raw_body so caller-constructed DTO can NEVER diverge!
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(req.raw_body)
    } catch {
      return Object.freeze({
        http_status: 400,
        applied: false,
        deduplicated: false,
        stale_version_ignored: false,
        sequence_gap_detected: false,
        reason: 'invalid_raw_body_json',
      })
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return Object.freeze({
        http_status: 400,
        applied: false,
        deduplicated: false,
        stale_version_ignored: false,
        sequence_gap_detected: false,
        reason: 'invalid_raw_body_object',
      })
    }

    const bodyObj = parsedBody as Record<string, unknown>
    const isEnvelope =
      typeof bodyObj.sku === 'object' && bodyObj.sku !== null && !Array.isArray(bodyObj.sku)
    if (isEnvelope) {
      if (bodyObj.event_id !== undefined && bodyObj.event_id !== req.event_id) {
        return Object.freeze({
          http_status: 400,
          applied: false,
          deduplicated: false,
          stale_version_ignored: false,
          sequence_gap_detected: false,
          reason: 'raw_body_event_id_mismatch',
        })
      }
      if (bodyObj.sequence_no !== undefined && bodyObj.sequence_no !== req.sequence_no) {
        return Object.freeze({
          http_status: 400,
          applied: false,
          deduplicated: false,
          stale_version_ignored: false,
          sequence_gap_detected: false,
          reason: 'raw_body_sequence_no_mismatch',
        })
      }
      if (bodyObj.tenant_id !== undefined && bodyObj.tenant_id !== req.tenant_id) {
        return Object.freeze({
          http_status: 400,
          applied: false,
          deduplicated: false,
          stale_version_ignored: false,
          sequence_gap_detected: false,
          reason: 'raw_body_tenant_id_mismatch',
        })
      }
      if (bodyObj.site_id !== undefined && bodyObj.site_id !== req.site_id) {
        return Object.freeze({
          http_status: 400,
          applied: false,
          deduplicated: false,
          stale_version_ignored: false,
          sequence_gap_detected: false,
          reason: 'raw_body_site_id_mismatch',
        })
      }
    }

    const authoritativeSku = (isEnvelope ? bodyObj.sku : bodyObj) as Partial<EcSkuFullPayload>
    if (!deepEqualJsonValue(authoritativeSku, req.sku)) {
      return Object.freeze({
        http_status: 400,
        applied: false,
        deduplicated: false,
        stale_version_ignored: false,
        sequence_gap_detected: false,
        reason: 'raw_body_sku_payload_mismatch',
      })
    }

    const nowMs = Date.parse(nowIso)
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now()
    const dedupeKey = `${req.tenant_id}|${req.site_id}|sku|${req.event_id}`
    if (this.processedEventIds.has(dedupeKey, safeNowMs)) {
      return Object.freeze({
        http_status: 200,
        applied: false,
        deduplicated: true,
        stale_version_ignored: false,
        sequence_gap_detected: false,
        reason: 'duplicate_event_id',
      })
    }

    // Reject partial updates — MUST contain full SKU fields + monotonic sku_version (§8.13 #1)
    if (!isFullSkuPayload(authoritativeSku)) {
      return Object.freeze({
        http_status: 400,
        applied: false,
        deduplicated: false,
        stale_version_ignored: false,
        sequence_gap_detected: false,
        reason: 'partial_sku_update_rejected_full_snapshot_required',
      })
    }

    const sk = this.siteKey(req.tenant_id, req.site_id)
    const prevSeq = this.siteLastSeq.get(sk)
    const prevGap = this.siteGapActive.get(sk)
    const prevHb = this.siteHeartbeats.get(sk)

    let gapDetected = false
    if (typeof req.sequence_no === 'number') {
      if (prevSeq !== undefined && req.sequence_no > prevSeq + 1) {
        gapDetected = true
      }
    }

    const k = this.skuKey(req.tenant_id, req.site_id, authoritativeSku.sku_id)
    const existing = this.skus.get(k)
    const ordering = this.shouldAcceptIncomingSku(existing, authoritativeSku, 'delta')
    if (!ordering.accept) {
      if (gapDetected) this.siteGapActive.set(sk, true)
      if (typeof req.sequence_no === 'number' && (prevSeq === undefined || req.sequence_no > prevSeq)) {
        this.siteLastSeq.set(sk, req.sequence_no)
      }
      this.processedEventIds.set(dedupeKey, true, safeNowMs)
      return Object.freeze({
        http_status: 200,
        applied: false,
        deduplicated: false,
        stale_version_ignored: true,
        sequence_gap_detected: gapDetected,
        reason: ordering.reason,
      })
    }

    // Stage & strongly commit unavailable-product set before returning 200!
    const prevSnapshot = existing
    const prevMargin = this.serverOnlyGrossMargin.get(k)

    if (gapDetected) {
      this.siteGapActive.set(sk, true)
    }
    if (typeof req.sequence_no === 'number' && (prevSeq === undefined || req.sequence_no > prevSeq)) {
      this.siteLastSeq.set(sk, req.sequence_no)
    }
    this.storeSkuInternal(req.tenant_id, req.site_id, authoritativeSku)
    this.siteHeartbeats.set(sk, safeNowMs)

    const unavailable = this.computeUnavailableProductIds(req.tenant_id, req.site_id, nowIso)
    let committed = false
    try {
      committed = this.strongStore.commitUnavailableSet(req.tenant_id, req.site_id, unavailable)
    } catch {
      committed = false
    }

    if (!committed) {
      // Full atomic rollback of SKU, margin, heartbeat, sequence, and gap state on 503!
      if (prevSnapshot !== undefined) this.skus.set(k, prevSnapshot)
      else this.skus.delete(k)
      if (prevMargin !== undefined) this.serverOnlyGrossMargin.set(k, prevMargin)
      else this.serverOnlyGrossMargin.delete(k)
      if (prevHb !== undefined) this.siteHeartbeats.set(sk, prevHb)
      else this.siteHeartbeats.delete(sk)
      if (prevSeq !== undefined) this.siteLastSeq.set(sk, prevSeq)
      else this.siteLastSeq.delete(sk)
      if (prevGap !== undefined) this.siteGapActive.set(sk, prevGap)
      else this.siteGapActive.delete(sk)

      return Object.freeze({
        http_status: 503,
        applied: false,
        deduplicated: false,
        stale_version_ignored: false,
        sequence_gap_detected: gapDetected,
        reason: 'strong_store_commit_failed_retry',
      })
    }

    this.processedEventIds.set(dedupeKey, true, safeNowMs)
    return Object.freeze({
      http_status: 200,
      applied: true,
      deduplicated: false,
      stale_version_ignored: false,
      sequence_gap_detected: gapDetected,
      reason: 'applied_and_committed',
    })
  }

  /**
   * 受け口 (c): 注文通知 (`orders:write`)・返品/キャンセル遅延反映。
   * `raw_body` の JSON と DTO の整合性を厳密検査し、LRU+TTL 上限付きログへ記録する。
   */
  ingestOrderNotification(req: EcOrderNotificationRequest): {
    readonly http_status: 200 | 400 | 401
    readonly recorded: boolean
    readonly deduplicated: boolean
    readonly member_update_status: 'not_applicable' | 'updated' | 'rejected_by_suppression_epoch'
  } {
    if (
      !verifyEcWebhookAuth(
        req.auth,
        'orders:write',
        req.tenant_id,
        req.site_id,
        req.raw_body,
        this.options.orders_write_secret,
      )
    ) {
      return Object.freeze({
        http_status: 401,
        recorded: false,
        deduplicated: false,
        member_update_status: 'not_applicable',
      })
    }

    let parsedOrder: unknown
    try {
      parsedOrder = JSON.parse(req.raw_body)
    } catch {
      return Object.freeze({
        http_status: 400,
        recorded: false,
        deduplicated: false,
        member_update_status: 'not_applicable',
      })
    }
    if (!parsedOrder || typeof parsedOrder !== 'object' || Array.isArray(parsedOrder)) {
      return Object.freeze({
        http_status: 400,
        recorded: false,
        deduplicated: false,
        member_update_status: 'not_applicable',
      })
    }
    const orderObj = parsedOrder as Record<string, unknown>
    if (
      (orderObj.order_event_id !== undefined && orderObj.order_event_id !== req.order_event_id) ||
      (orderObj.order_id !== undefined && orderObj.order_id !== req.order_id) ||
      (orderObj.order_status !== undefined && orderObj.order_status !== req.order_status) ||
      (orderObj.member_key !== undefined && orderObj.member_key !== req.member_key) ||
      (orderObj.data_epoch !== undefined && orderObj.data_epoch !== req.data_epoch) ||
      (orderObj.occurred_at !== undefined && orderObj.occurred_at !== req.occurred_at) ||
      (orderObj.items !== undefined && !deepEqualJsonValue(orderObj.items, req.items))
    ) {
      return Object.freeze({
        http_status: 400,
        recorded: false,
        deduplicated: false,
        member_update_status: 'not_applicable',
      })
    }

    const occurredMs = Date.parse(req.occurred_at)
    const safeNowMs = Number.isFinite(occurredMs) ? occurredMs : req.auth.timestamp_sec * 1000
    const dedupeKey = `${req.tenant_id}|${req.site_id}|order|${req.order_event_id}`
    if (this.processedEventIds.has(dedupeKey, safeNowMs)) {
      return Object.freeze({
        http_status: 200,
        recorded: false,
        deduplicated: true,
        member_update_status: 'not_applicable',
      })
    }

    this.processedEventIds.set(dedupeKey, true, safeNowMs)
    this.orders.set(`${req.tenant_id}|${req.site_id}|${req.order_id}`, req, safeNowMs)

    let memberStatus: 'not_applicable' | 'updated' | 'rejected_by_suppression_epoch' =
      'not_applicable'
    if (req.member_key && this.options.member_store) {
      const mRes = this.options.member_store.applyOrderNotification({
        tenant_id: req.tenant_id,
        site_id: req.site_id,
        member_key: req.member_key,
        order_status: req.order_status,
        product_ids: req.items.map((it) => it.product_id),
        data_epoch: req.data_epoch ?? 1,
        occurred_at: req.occurred_at,
      })
      memberStatus = mRes.accepted ? 'updated' : 'rejected_by_suppression_epoch'
    }

    return Object.freeze({
      http_status: 200,
      recorded: true,
      deduplicated: false,
      member_update_status: memberStatus,
    })
  }

  /**
   * サーバー側内部専用の粗利取得（ブラウザへは絶対に返さない）。
   */
  getServerOnlyGrossMargin(tenantId: string, siteId: string, skuId: string): number | null {
    return this.serverOnlyGrossMargin.get(this.skuKey(tenantId, siteId, skuId)) ?? null
  }

  /**
   * 粗利が `null` / `undefined` / `<= 0` の場合は `0` ブーストへ保守フォールバックする推薦重み計算 (§8.13)。
   */
  computeConservativeMarginBoost(
    tenantId: string,
    siteId: string,
    skuId: string,
    options?: { readonly reference_margin?: number; readonly max_boost?: number },
  ): number {
    const margin = this.getServerOnlyGrossMargin(tenantId, siteId, skuId)
    if (margin === null || !Number.isFinite(margin) || margin <= 0) {
      return 0
    }
    const ref = options?.reference_margin ?? 10_000
    const maxBoost = options?.max_boost ?? 0.25
    if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(maxBoost) || maxBoost <= 0) {
      return 0
    }
    return Math.min(maxBoost, (margin / ref) * maxBoost)
  }

  /**
   * 親商品の販売可否を子 SKU 状態・鮮度期限・死活合図・連番欠番からフェイルクローズ評価する。
   */
  evaluateParentProductState(
    tenantId: string,
    siteId: string,
    parentProductId: string,
    nowIso: string,
  ): {
    readonly product_id: string
    readonly available: boolean
    readonly hide_price: boolean
    readonly price_sensitive_recommendation_eligible: boolean
    readonly representative_sku: StoredPublicSku | null
    readonly reason: string
  } {
    const nowMs = Date.parse(nowIso)
    const sk = this.siteKey(tenantId, siteId)
    const stockTtl = this.options.stock_freshness_ttl_ms ?? DEFAULT_STOCK_FRESHNESS_TTL_MS
    const priceTtl = this.options.price_freshness_ttl_ms ?? DEFAULT_PRICE_FRESHNESS_TTL_MS
    const hbTtl = this.options.heartbeat_ttl_ms ?? DEFAULT_HEARTBEAT_TTL_MS

    const children: StoredPublicSku[] = []
    for (const sku of this.skus.values()) {
      if (
        sku.tenant_id === tenantId &&
        sku.site_id === siteId &&
        sku.parent_product_id === parentProductId
      ) {
        children.push(sku)
      }
    }

    if (children.length === 0) {
      return Object.freeze({
        product_id: parentProductId,
        available: false,
        hide_price: true,
        price_sensitive_recommendation_eligible: false,
        representative_sku: null,
        reason: 'no_child_skus',
      })
    }

    const rep = children[0]

    // Fail-closed on sequence gap (§8.13 #1)
    if (this.siteGapActive.get(sk) === true) {
      return Object.freeze({
        product_id: parentProductId,
        available: false,
        hide_price: true,
        price_sensitive_recommendation_eligible: false,
        representative_sku: rep,
        reason: 'sequence_gap_fail_closed',
      })
    }

    // Fail-closed on expired site heartbeat (§8.13 #1)
    const lastHb = this.siteHeartbeats.get(sk)
    if (!Number.isFinite(nowMs) || lastHb === undefined || nowMs - lastHb > hbTtl) {
      return Object.freeze({
        product_id: parentProductId,
        available: false,
        hide_price: true,
        price_sensitive_recommendation_eligible: false,
        representative_sku: rep,
        reason: 'site_heartbeat_expired_fail_closed',
      })
    }

    let anySellable = false
    let sellableFreshPriceCandidate: StoredPublicSku | null = null
    let sellableAnyCandidate: StoredPublicSku | null = null

    for (const sku of children) {
      const updatedMs = Date.parse(sku.updated_at)
      if (!Number.isFinite(updatedMs)) continue
      const ageMs = nowMs - updatedMs
      const stockFresh = ageMs <= stockTtl
      const priceFresh = ageMs <= priceTtl

      const withinSaleWindow =
        (sku.sale_start_at === null || nowMs >= Date.parse(sku.sale_start_at)) &&
        (sku.sale_end_at === null || nowMs <= Date.parse(sku.sale_end_at))

      if (stockFresh && sku.published && sku.in_stock && withinSaleWindow) {
        anySellable = true
        sellableAnyCandidate = sku
        if (priceFresh) {
          sellableFreshPriceCandidate = sku
        }
      }
    }

    // Prefer a sellable SKU with fresh price; otherwise check price freshness strictly on the chosen representative SKU
    // (NEVER let a sold-out sibling SKU's fresh timestamp unmask a stale price on the sellable representative SKU!)
    const chosenRep = sellableFreshPriceCandidate ?? sellableAnyCandidate ?? rep
    const chosenAgeMs = nowMs - Date.parse(chosenRep.updated_at)
    const hidePrice = !Number.isFinite(chosenAgeMs) || chosenAgeMs > priceTtl

    return Object.freeze({
      product_id: parentProductId,
      available: anySellable,
      hide_price: hidePrice,
      price_sensitive_recommendation_eligible: anySellable && !hidePrice,
      representative_sku: chosenRep,
      reason: anySellable ? 'available' : 'all_child_skus_unavailable_or_stale',
    })
  }

  private computeUnavailableProductIds(
    tenantId: string,
    siteId: string,
    nowIso: string,
  ): readonly string[] {
    const parentIds = new Set<string>()
    for (const sku of this.skus.values()) {
      if (sku.tenant_id === tenantId && sku.site_id === siteId) {
        parentIds.add(sku.parent_product_id)
      }
    }
    const unavailable: string[] = []
    for (const pid of parentIds) {
      if (!this.evaluateParentProductState(tenantId, siteId, pid, nowIso).available) {
        unavailable.push(pid)
      }
    }
    return Object.freeze(unavailable.sort())
  }

  /**
   * 粗利を完全に排除したブラウザ向け安全投影 DTO (§8.13 #1)。
   */
  toBrowserProductProjection(
    tenantId: string,
    siteId: string,
    parentProductId: string,
    nowIso: string,
  ): BrowserProductProjection | null {
    const state = this.evaluateParentProductState(tenantId, siteId, parentProductId, nowIso)
    if (!state.representative_sku) return null
    const sku = state.representative_sku
    const dto: BrowserProductProjection = Object.freeze({
      product_id: parentProductId,
      title: sku.title,
      product_url_key_v2: sku.product_url_key_v2,
      image_url: sku.image_url,
      available: state.available,
      hide_price: state.hide_price,
      price: state.hide_price ? null : sku.price,
      currency: state.hide_price ? null : sku.currency,
      category: sku.category,
      brand: sku.brand,
    })
    assertNoGrossMarginLeak(dto)
    return dto
  }

  // -------------------------------------------------------------------------
  // Triple Sold-Out Exclusion Support APIs (§8.13 #2)
  // -------------------------------------------------------------------------

  /**
   * 1重目: ブラウザ表示直前確認口。
   * `page_id` のみ受け取り訪問者情報は 0。同意 `off` でもそのまま動作する。
   */
  checkPageProductsForBrowser(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly page_id: string
    readonly now_iso: string
  }): {
    readonly page_id: string
    readonly checked_at: string
    readonly requires_visitor_info: false
    readonly works_under_consent_off: true
    readonly unavailable_product_ids: readonly string[]
    readonly hide_price_product_ids: readonly string[]
  } {
    const pKey = `${params.tenant_id}|${params.site_id}|${params.page_id}`
    const pids = this.pageProductIndex.get(pKey) ?? new Set<string>()
    const unavailable: string[] = []
    const hidePrice: string[] = []

    for (const pid of pids) {
      const state = this.evaluateParentProductState(
        params.tenant_id,
        params.site_id,
        pid,
        params.now_iso,
      )
      if (!state.available) unavailable.push(pid)
      if (state.hide_price) hidePrice.push(pid)
    }

    return Object.freeze({
      page_id: params.page_id,
      checked_at: params.now_iso,
      requires_visitor_info: false,
      works_under_consent_off: true,
      unavailable_product_ids: Object.freeze(unavailable.sort()),
      hide_price_product_ids: Object.freeze(hidePrice.sort()),
    })
  }

  /**
   * 3重目: 売り切れ商品を掲載しているページ URL の逆引き索引。
   * §8.13 #2: 売り切れ商品除外のための元サーバー再生成は「7日に1回」並べ替え上限にカウントしない。
   */
  getPagesFeaturingProduct(
    tenantId: string,
    siteId: string,
    productId: string,
  ): {
    readonly product_id: string
    readonly affected_page_urls: readonly string[]
    readonly counts_against_7day_reorder_limit: false
  } {
    const rKey = `${tenantId}|${siteId}|${productId}`
    const urls = this.productPageReverseIndex.get(rKey)
    return Object.freeze({
      product_id: productId,
      affected_page_urls: Object.freeze(urls ? [...urls].sort() : []),
      counts_against_7day_reorder_limit: false,
    })
  }
}

/**
 * 2重目: エッジ Worker 応答時 HTML 除去フック (§8.13 #2)。
 * `data-ugk-product-id="<id>"` を持つカード要素を非JS訪問者・検索クローラー向け応答から除去する。
 */
export function filterUnavailableProductsAtEdge(
  html: string,
  unavailableProductIds: readonly string[],
): { readonly html: string; readonly removed_count: number } {
  if (unavailableProductIds.length === 0) {
    return Object.freeze({ html, removed_count: 0 })
  }
  const unavailableSet = new Set(unavailableProductIds)
  let removed = 0
  const elementRe =
    /<([a-z][a-z0-9-]*)\b[^>]*\bdata-ugk-product-id\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/\1>/gi

  const filtered = html.replace(elementRe, (match, _tag: string, pid: string) => {
    if (unavailableSet.has(pid)) {
      removed++
      return ''
    }
    return match
  })

  return Object.freeze({ html: filtered, removed_count: removed })
}
