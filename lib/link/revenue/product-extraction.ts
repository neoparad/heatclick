/**
 * UGOKI LINK v2 — 束 4-D (§8.5): 商品属性抽出 & 人ラベル 200 件・下限 ≥0.90 品質ゲート
 *
 * 設計書 §8.5:
 * - 構造化データ (JSON-LD `Product` / `Offer`)・アフィリエイト登録簿・比較表スペック行から
 *   商品属性（商品名・SKU・価格・通貨・ブランド・カテゴリ・スペック・アフィリエイトキー）を抽出する。
 * - 抽出精度は人が付けた 200 件以上のラベルに対する 95% 下限が `>= 0.90` であることをゲート検証する。
 */

import { computeBoundedRate } from '@/lib/link/join/claim-gates'

import { extractAffiliateKeyFromUrl } from './affiliate'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRODUCT_EXTRACTION_MIN_HUMAN_LABELS = 200
export const PRODUCT_EXTRACTION_MIN_LOWER_95 = 0.9

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedProductAttributes {
  readonly product_name: string | null
  readonly sku: string | null
  readonly price: number | null
  readonly currency: string | null
  readonly brand: string | null
  readonly category: string | null
  readonly affiliate_key: string | null
  readonly specs: Readonly<Record<string, string>>
  readonly sources_used: readonly ('json_ld' | 'affiliate_registry' | 'comparison_table')[]
}

export interface ProductExtractionInput {
  readonly json_ld_objects?: readonly Record<string, unknown>[]
  readonly affiliate_links?: readonly string[]
  readonly comparison_table_rows?: readonly {
    readonly attribute: string
    readonly value: string
  }[]
}

export interface HumanLabeledExtractionSample {
  readonly sample_id: string
  readonly exact_match: boolean
}

export interface ProductExtractionGateResult {
  readonly gate_id: 'ml.product_extraction_precision'
  readonly passed: boolean
  readonly status: 'pass' | 'fail' | 'insufficient_data'
  readonly total_samples: number
  readonly exact_matches: number
  readonly accuracy: number | null
  readonly lower_95: number | null
  readonly min_required_samples: number
  readonly min_required_lower_95: number
  readonly unmet_reasons: readonly string[]
}

// ---------------------------------------------------------------------------
// Attribute Extractor
// ---------------------------------------------------------------------------

export function extractProductAttributes(
  input: ProductExtractionInput,
): ExtractedProductAttributes {
  let productName: string | null = null
  let sku: string | null = null
  let price: number | null = null
  let currency: string | null = null
  let brand: string | null = null
  let category: string | null = null
  let affiliateKey: string | null = null
  const specs: Record<string, string> = {}
  const sources = new Set<'json_ld' | 'affiliate_registry' | 'comparison_table'>()

  // 1. JSON-LD Product / Offer extraction
  for (const obj of input.json_ld_objects ?? []) {
    const typeVal = obj['@type']
    const isProduct =
      typeVal === 'Product' ||
      (Array.isArray(typeVal) && typeVal.includes('Product'))
    if (!isProduct) continue

    sources.add('json_ld')
    if (typeof obj.name === 'string' && obj.name.trim()) productName = obj.name.trim()
    if (typeof obj.sku === 'string' && obj.sku.trim()) sku = obj.sku.trim()
    if (typeof obj.category === 'string' && obj.category.trim()) category = obj.category.trim()

    if (typeof obj.brand === 'string' && obj.brand.trim()) {
      brand = obj.brand.trim()
    } else if (
      obj.brand &&
      typeof obj.brand === 'object' &&
      typeof (obj.brand as Record<string, unknown>).name === 'string'
    ) {
      brand = String((obj.brand as Record<string, unknown>).name).trim()
    }

    const rawOffers = obj.offers
    const offer = Array.isArray(rawOffers)
      ? (rawOffers[0] as Record<string, unknown> | undefined)
      : (rawOffers as Record<string, unknown> | undefined)
    if (offer && typeof offer === 'object') {
      const parsedPrice = Number(offer.price)
      if (Number.isFinite(parsedPrice) && parsedPrice >= 0) price = parsedPrice
      if (typeof offer.priceCurrency === 'string' && offer.priceCurrency.trim()) {
        currency = offer.priceCurrency.trim().toUpperCase()
      }
    }
  }

  // 2. Affiliate registry extraction
  for (const link of input.affiliate_links ?? []) {
    const parsed = extractAffiliateKeyFromUrl(link)
    if (parsed.matched && parsed.affiliate_key) {
      affiliateKey = parsed.affiliate_key
      if (!sku && parsed.product_id) sku = parsed.product_id
      sources.add('affiliate_registry')
      break
    }
  }

  // 3. Comparison table spec rows
  for (const row of input.comparison_table_rows ?? []) {
    const attr = row.attribute.trim()
    const val = row.value.trim()
    if (!attr || !val) continue
    specs[attr] = val
    sources.add('comparison_table')

    if (price === null && /価格|料金|price/i.test(attr)) {
      const numMatch = /([0-9,]+)/.exec(val)
      if (numMatch) {
        const n = Number(numMatch[1].replace(/,/g, ''))
        if (Number.isFinite(n)) {
          price = n
          if (!currency && /円|¥|JPY/i.test(val)) currency = 'JPY'
        }
      }
    }
    if (!brand && /メーカー|ブランド|brand/i.test(attr)) {
      brand = val
    }
    if (!category && /カテゴリ|種別|category/i.test(attr)) {
      category = val
    }
  }

  return Object.freeze({
    product_name: productName,
    sku,
    price,
    currency,
    brand,
    category,
    affiliate_key: affiliateKey,
    specs: Object.freeze(specs),
    sources_used: Object.freeze([...sources]),
  })
}

// ---------------------------------------------------------------------------
// 200-Sample >= 0.90 Lower-Bound Gate (§8.5)
// ---------------------------------------------------------------------------

export function evaluateProductExtractionGate(
  samples: readonly HumanLabeledExtractionSample[],
  options?: {
    readonly min_samples?: number
    readonly min_lower_95?: number
  },
): ProductExtractionGateResult {
  const minSamples = options?.min_samples ?? PRODUCT_EXTRACTION_MIN_HUMAN_LABELS
  const minLower95 = options?.min_lower_95 ?? PRODUCT_EXTRACTION_MIN_LOWER_95
  const total = samples.length
  const matches = samples.filter((s) => s.exact_match).length
  const bounded = computeBoundedRate(matches, total)

  const unmet: string[] = []
  if (total < minSamples) {
    unmet.push(`human_labels_lt_${minSamples}:${total}`)
  }
  if (bounded.lower_95 === null || bounded.lower_95 < minLower95) {
    unmet.push(
      `lower_95_lt_${minLower95}:${bounded.lower_95 === null ? 'null' : bounded.lower_95.toFixed(4)}`,
    )
  }

  const passed = unmet.length === 0
  const status: ProductExtractionGateResult['status'] = passed
    ? 'pass'
    : total < minSamples
      ? 'insufficient_data'
      : 'fail'

  return Object.freeze({
    gate_id: 'ml.product_extraction_precision',
    passed,
    status,
    total_samples: total,
    exact_matches: matches,
    accuracy: bounded.rate,
    lower_95: bounded.lower_95,
    min_required_samples: minSamples,
    min_required_lower_95: minLower95,
    unmet_reasons: Object.freeze(unmet),
  })
}
