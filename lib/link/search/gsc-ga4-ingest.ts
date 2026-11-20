/**
 * UGOKI LINK v2 — 束 4-E (手順 15, §6.6, §11.10): GSC 取込 & GA4 ページ×日同期
 *
 * 設計書 §6.6 & §11.10:
 * 1. **Search Console (GSC) 取込**:
 *    `page × query × date × device × country` 行を `computeUrlKeyV2` でページ ID (`url_id`) に結合し、
 *    冪等 upsert する（未計測は必ず `null`）。
 * 2. **GA4 同期 (§11.10)**:
 *    - オーナー接続許可 (`owner_connection_approved: true` + 承認トークン) が無ければ `NotEntitledError` で拒否。
 *    - **`page × day` 集計のみ**を受理（訪問者単位行・`client_id`/`user_id`/`session_id`/`visitor_id` 等の ID 列を厳格拒否）。
 *    - 全指標に `evidence: 'observed'`, `source: 'external_ga4'` を付与。
 *    - PV・成果の独立突き合わせおよび移行前 AI 参照元流入履歴の取込を提供。
 */

import { NotEntitledError } from '@/packages/contract/ledgers'
import { computeUrlKeyV2, type UrlKeyV2Rules } from '@/packages/contract/urlkey'

// ---------------------------------------------------------------------------
// 1. Google Search Console (GSC) Store (§6.6)
// ---------------------------------------------------------------------------

export type GscDeviceType = 'DESKTOP' | 'MOBILE' | 'TABLET'

export interface GscRawRowInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly page_url: string
  readonly query: string
  /** UTC YYYY-MM-DD */
  readonly date: string
  readonly device: GscDeviceType
  readonly country: string
  readonly clicks: number | null
  readonly impressions: number | null
  readonly ctr: number | null
  readonly position: number | null
}

export interface StoredGscRow {
  readonly row_key: string
  readonly tenant_id: string
  readonly site_id: string
  readonly url_id: string
  readonly url_key_v2: string
  readonly query: string
  readonly date: string
  readonly device: GscDeviceType
  readonly country: string
  readonly clicks: number | null
  readonly impressions: number | null
  readonly ctr: number | null
  readonly position: number | null
  readonly evidence: 'observed'
  readonly source: 'google_search_console'
}

export class GscIngestStore {
  private readonly rows = new Map<string, StoredGscRow>()

  upsertBatch(
    inputs: readonly GscRawRowInput[],
    urlKeyRules?: Partial<UrlKeyV2Rules>,
  ): { readonly inserted: number; readonly updated: number; readonly rows: readonly StoredGscRow[] } {
    let inserted = 0
    let updated = 0
    const out: StoredGscRow[] = []

    for (const r of inputs) {
      if (!r.tenant_id.trim() || !r.site_id.trim()) {
        throw new Error('tenant_id and site_id are required for GSC ingest')
      }
      const uk = computeUrlKeyV2(r.page_url, urlKeyRules)
      const normQuery = r.query.trim()
      const normCountry = r.country.trim().toUpperCase()
      const key = `${r.tenant_id}|${r.site_id}|${uk.url_id}|${normQuery}|${r.date}|${r.device}|${normCountry}`

      if (this.rows.has(key)) updated++
      else inserted++

      const stored: StoredGscRow = Object.freeze({
        row_key: key,
        tenant_id: r.tenant_id,
        site_id: r.site_id,
        url_id: uk.url_id,
        url_key_v2: uk.url_key_v2,
        query: normQuery,
        date: r.date,
        device: r.device,
        country: normCountry,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
        evidence: 'observed',
        source: 'google_search_console',
      })
      this.rows.set(key, stored)
      out.push(stored)
    }

    return Object.freeze({ inserted, updated, rows: Object.freeze(out) })
  }

  listByPage(tenantId: string, siteId: string, urlId: string): readonly StoredGscRow[] {
    const out: StoredGscRow[] = []
    for (const row of this.rows.values()) {
      if (row.tenant_id === tenantId && row.site_id === siteId && row.url_id === urlId) {
        out.push(row)
      }
    }
    return Object.freeze(out)
  }

  listBySite(tenantId: string, siteId: string): readonly StoredGscRow[] {
    const out: StoredGscRow[] = []
    for (const row of this.rows.values()) {
      if (row.tenant_id === tenantId && row.site_id === siteId) {
        out.push(row)
      }
    }
    return Object.freeze(out)
  }
}

// ---------------------------------------------------------------------------
// 2. GA4 Page × Day Sync (§11.10)
// ---------------------------------------------------------------------------

export interface Ga4ConnectionAuthorization {
  readonly tenant_id: string
  readonly site_id: string
  readonly property_id: string
  readonly owner_connection_approved: boolean
  readonly connection_token: string | null
  readonly approved_at: string | null
}

const FORBIDDEN_GA4_VISITOR_COLUMNS = new Set([
  'client_id',
  'ga_client_id',
  'user_id',
  'user_pseudo_id',
  'visitor_id',
  'session_id',
  'ga_session_id',
  'pseudo_user_id',
  'member_id',
])

export interface Ga4PageDayRowInput {
  readonly page_url: string
  /** UTC YYYY-MM-DD */
  readonly date: string
  readonly screen_page_views: number | null
  readonly conversions: number | null
  /** Optional extra raw keys checked against visitor-ID rejection guard */
  readonly [extraKey: string]: unknown
}

export interface StoredGa4PageDayRow {
  readonly row_key: string
  readonly tenant_id: string
  readonly site_id: string
  readonly property_id: string
  readonly url_id: string
  readonly url_key_v2: string
  readonly date: string
  readonly screen_page_views: number | null
  readonly conversions: number | null
  readonly evidence: 'observed'
  readonly source: 'external_ga4'
}

export interface Ga4PreMigrationAiReferrerInput {
  readonly page_url: string
  readonly date: string
  readonly referrer_host: string
  readonly sessions: number | null
  readonly conversions: number | null
  readonly [extraKey: string]: unknown
}

export interface StoredGa4AiReferrerRow {
  readonly tenant_id: string
  readonly site_id: string
  readonly url_id: string
  readonly url_key_v2: string
  readonly date: string
  readonly referrer_host: string
  readonly sessions: number | null
  readonly conversions: number | null
  readonly evidence: 'observed'
  readonly source: 'external_ga4'
  readonly historical_pre_migration: true
}

function assertNoGa4VisitorColumns(row: Record<string, unknown>): void {
  for (const k of Object.keys(row)) {
    if (FORBIDDEN_GA4_VISITOR_COLUMNS.has(k.toLowerCase())) {
      throw new Error(
        `GA4 sync accepts ONLY page × day aggregates; visitor-level column "${k}" is strictly prohibited (§11.10)`,
      )
    }
  }
}

function assertGa4OwnerAuthorized(auth: Ga4ConnectionAuthorization): void {
  if (!auth.owner_connection_approved || !auth.connection_token?.trim()) {
    throw new NotEntitledError({
      entitled: false,
      status: 'not_entitled',
      decisionId: 'GA4_OWNER_AUTH',
      reason: 'decision_pending',
      message: `GA4 sync for site "${auth.site_id}" requires explicit owner connection authorization (§11.10)`,
      unlockRequirement: 'Owner must approve GA4 property connection and supply OAuth/service token',
    })
  }
}

export class Ga4SyncService {
  private readonly pageDayRows = new Map<string, StoredGa4PageDayRow>()
  private readonly aiReferrerRows: StoredGa4AiReferrerRow[] = []

  ingestPageDayAggregates(
    auth: Ga4ConnectionAuthorization,
    rows: readonly Ga4PageDayRowInput[],
    urlKeyRules?: Partial<UrlKeyV2Rules>,
  ): { readonly ingested: number; readonly rows: readonly StoredGa4PageDayRow[] } {
    assertGa4OwnerAuthorized(auth)
    const out: StoredGa4PageDayRow[] = []

    for (const raw of rows) {
      assertNoGa4VisitorColumns(raw)
      const uk = computeUrlKeyV2(raw.page_url, urlKeyRules)
      const key = `${auth.tenant_id}|${auth.site_id}|${uk.url_id}|${raw.date}`
      const stored: StoredGa4PageDayRow = Object.freeze({
        row_key: key,
        tenant_id: auth.tenant_id,
        site_id: auth.site_id,
        property_id: auth.property_id,
        url_id: uk.url_id,
        url_key_v2: uk.url_key_v2,
        date: raw.date,
        screen_page_views: raw.screen_page_views,
        conversions: raw.conversions,
        evidence: 'observed',
        source: 'external_ga4',
      })
      this.pageDayRows.set(key, stored)
      out.push(stored)
    }

    return Object.freeze({ ingested: out.length, rows: Object.freeze(out) })
  }

  ingestPreMigrationAiReferrerHistory(
    auth: Ga4ConnectionAuthorization,
    rows: readonly Ga4PreMigrationAiReferrerInput[],
    urlKeyRules?: Partial<UrlKeyV2Rules>,
  ): readonly StoredGa4AiReferrerRow[] {
    assertGa4OwnerAuthorized(auth)
    const out: StoredGa4AiReferrerRow[] = []
    for (const raw of rows) {
      assertNoGa4VisitorColumns(raw)
      const uk = computeUrlKeyV2(raw.page_url, urlKeyRules)
      const stored: StoredGa4AiReferrerRow = Object.freeze({
        tenant_id: auth.tenant_id,
        site_id: auth.site_id,
        url_id: uk.url_id,
        url_key_v2: uk.url_key_v2,
        date: raw.date,
        referrer_host: raw.referrer_host.trim().toLowerCase(),
        sessions: raw.sessions,
        conversions: raw.conversions,
        evidence: 'observed',
        source: 'external_ga4',
        historical_pre_migration: true,
      })
      this.aiReferrerRows.push(stored)
      out.push(stored)
    }
    return Object.freeze(out)
  }

  /**
   * 独立カウント突き合わせ: 自社 PV・成果 vs GA4 (`external_ga4`) の page × day 比較。
   */
  reconcileWithInternalMetrics(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly url_id: string
    readonly date: string
    readonly internal_pvs: number
    readonly internal_conversions: number
  }): {
    readonly matched: boolean
    readonly ga4_pvs: number | null
    readonly ga4_conversions: number | null
    readonly pv_ratio_internal_over_ga4: number | null
    readonly conversion_ratio_internal_over_ga4: number | null
    readonly evidence: 'observed'
    readonly source: 'external_ga4'
  } {
    const key = `${params.tenant_id}|${params.site_id}|${params.url_id}|${params.date}`
    const row = this.pageDayRows.get(key)
    if (!row) {
      return Object.freeze({
        matched: false,
        ga4_pvs: null,
        ga4_conversions: null,
        pv_ratio_internal_over_ga4: null,
        conversion_ratio_internal_over_ga4: null,
        evidence: 'observed',
        source: 'external_ga4',
      })
    }

    return Object.freeze({
      matched: true,
      ga4_pvs: row.screen_page_views,
      ga4_conversions: row.conversions,
      pv_ratio_internal_over_ga4:
        row.screen_page_views && row.screen_page_views > 0
          ? params.internal_pvs / row.screen_page_views
          : null,
      conversion_ratio_internal_over_ga4:
        row.conversions && row.conversions > 0
          ? params.internal_conversions / row.conversions
          : null,
      evidence: 'observed',
      source: 'external_ga4',
    })
  }
}
