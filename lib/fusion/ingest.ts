/**
 * ingest.ts — UGOKI Crawl 融合エクスポートの取り込み (経路B: HTTP pull → ClickHouse)
 *
 * UGOKI Crawl の GET /v1/fusion/export を pull → Zod 検証 → 融合5表へ INSERT。
 * MAP-owned ingestion (Codex): crawler が MAP 本番スキーマへ直書きしない。
 *
 * env:
 *   UGOKICRAWL_API_URL   — UGOKI Crawl API ベースURL (例 https://api.ugokicrawl.internal)
 *   FUSION_EXPORT_TOKEN  — /v1/fusion/export の共有トークン (X-Fusion-Token)
 *   FUSION_INGEST_TARGETS — JSON 配列 [{tenantId, siteId, jobId, days?}] (取り込み対象)
 */

import { getClickHouseClient } from '@/lib/clickhouse'
import { crawlExportV1Schema, type CrawlExportV1 } from '@/lib/fusion/crawl-export-contract'

const SCHEMA_VERSION = 'v1'

export interface FusionIngestTarget {
  tenantId: string
  siteId: string
  jobId: string
  days?: number
}

export interface FusionIngestResult {
  target: FusionIngestTarget
  ok: boolean
  counts?: { sections: number; performance: number; issues: number; section_behavior: number }
  error?: string
}

function nowCh(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

/** ISO → ClickHouse DateTime ('YYYY-MM-DD HH:MM:SS')。null/不正は now。 */
function chDateTime(iso: string | null | undefined): string {
  if (!iso) return nowCh()
  const s = String(iso).replace('T', ' ').slice(0, 19)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s : nowCh()
}

/** ISO/日付 → ClickHouse Date ('YYYY-MM-DD')。 */
function chDate(iso: string | null | undefined): string {
  if (!iso) return new Date().toISOString().slice(0, 10)
  const s = String(iso).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10)
}

export async function fetchCrawlExport(target: FusionIngestTarget): Promise<CrawlExportV1> {
  const base = process.env.UGOKICRAWL_API_URL
  const token = process.env.FUSION_EXPORT_TOKEN
  if (!base) throw new Error('UGOKICRAWL_API_URL not configured')
  if (!token) throw new Error('FUSION_EXPORT_TOKEN not configured')

  const u = new URL('/v1/fusion/export', base)
  u.searchParams.set('tenant_id', target.tenantId)
  u.searchParams.set('site_id', target.siteId)
  u.searchParams.set('job_id', target.jobId)
  u.searchParams.set('days', String(target.days ?? 30))

  const res = await fetch(u.toString(), {
    method: 'GET',
    headers: { 'X-Fusion-Token': token },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`export fetch failed: HTTP ${res.status}`)
  const json: unknown = await res.json()
  const parsed = crawlExportV1Schema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`crawl_export_v1 validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
  }
  // server 側 tenant/site が要求と一致するか (cross-tenant 混入防止)
  if (parsed.data.tenant_id !== target.tenantId || parsed.data.site_id !== target.siteId) {
    throw new Error('export tenant/site mismatch')
  }
  return parsed.data
}

export async function ingestCrawlExport(exp: CrawlExportV1): Promise<FusionIngestResult['counts']> {
  const client = getClickHouseClient('chat_writer')
  const t = exp.tenant_id
  const s = exp.site_id
  const ingested = nowCh()

  // crawl_runs (1 行/crawl)
  await client.insert({
    table: 'crawl_runs',
    values: [
      {
        crawl_id: exp.crawl.crawl_id,
        tenant_id: t,
        site_id: s,
        viewport_class: 'both',
        status: exp.crawl.status,
        page_count: exp.crawl.page_count,
        source_job_id: exp.crawl.crawl_id,
        crawled_at: chDateTime(exp.crawl.crawled_at),
        ingested_at: ingested,
        updated_at: ingested,
        schema_version: SCHEMA_VERSION,
      },
    ],
    format: 'JSONEachRow',
  })

  if (exp.sections.length > 0) {
    await client.insert({
      table: 'page_content_sections',
      values: exp.sections.map((x) => ({
        crawl_id: x.crawl_id,
        tenant_id: t,
        site_id: s,
        page_url: x.page_url,
        viewport_class: x.viewport_class,
        section_index: x.section_index,
        section_selector: x.section_selector,
        section_selector_hash: x.section_selector_hash,
        section_dom_path: x.section_dom_path,
        section_heading: x.section_heading,
        y_start: x.y_start,
        y_end: x.y_end,
        page_height: x.page_height,
        visible_text: x.visible_text,
        has_cta: x.has_cta,
        has_price: x.has_price,
        word_count: x.word_count,
        image_count: x.image_count,
        link_count: x.link_count,
        text_hash: x.text_hash,
        asset_hash: x.asset_hash,
        cta_hash: x.cta_hash,
        crawled_at: chDateTime(x.crawled_at),
        ingested_at: ingested,
        schema_version: SCHEMA_VERSION,
      })),
      format: 'JSONEachRow',
    })
  }

  if (exp.performance.length > 0) {
    await client.insert({
      table: 'page_performance',
      values: exp.performance.map((x) => ({
        crawl_id: x.crawl_id,
        tenant_id: t,
        site_id: s,
        page_url: x.page_url,
        viewport_class: x.viewport_class,
        lcp_ms: x.lcp_ms,
        lcp_element_selector: '',
        lcp_section_selector_hash: '',
        cls_score: x.cls_score,
        inp_ms: x.inp_ms,
        ttfb_ms: x.ttfb_ms,
        fcp_ms: x.fcp_ms,
        performance_score: x.performance_score,
        crawled_at: chDateTime(x.crawled_at),
        ingested_at: ingested,
        schema_version: SCHEMA_VERSION,
      })),
      format: 'JSONEachRow',
    })
  }

  if (exp.issues.length > 0) {
    await client.insert({
      table: 'page_issues',
      values: exp.issues.map((x) => ({
        crawl_id: x.crawl_id,
        tenant_id: t,
        site_id: s,
        page_url: x.page_url,
        issue_type: x.issue_type,
        issue_code: x.issue_code,
        issue_category: x.issue_category,
        severity: x.severity,
        selector: x.selector,
        selector_hash: x.selector_hash,
        section_selector_hash: x.section_selector_hash,
        metric_name: x.metric_name,
        metric_value: x.metric_value,
        metric_unit: x.metric_unit,
        evidence: x.evidence,
        recommendation: x.recommendation,
        detected_at: chDateTime(x.detected_at),
        ingested_at: ingested,
        schema_version: SCHEMA_VERSION,
      })),
      format: 'JSONEachRow',
    })
  }

  if (exp.section_behavior.length > 0) {
    await client.insert({
      table: 'section_behavior_summary',
      values: exp.section_behavior.map((x) => ({
        tenant_id: t,
        site_id: s,
        page_url: x.page_url,
        viewport_class: x.viewport_class,
        section_selector_hash: x.section_selector_hash,
        window_start: chDate(x.window_start),
        window_grain: 'day',
        reached_sessions: x.reached_sessions,
        clicks: x.clicks,
        dead_clicks: x.dead_clicks,
        rage_clicks: x.rage_clicks,
        avg_dwell_ms: x.avg_dwell_ms,
        avg_scroll_depth: x.avg_scroll_depth,
        exits: x.exits,
        conversions: x.conversions,
        friction_score: x.friction_score,
        match_confidence: x.match_confidence,
        updated_at: ingested,
        schema_version: SCHEMA_VERSION,
      })),
      format: 'JSONEachRow',
    })
  }

  return {
    sections: exp.sections.length,
    performance: exp.performance.length,
    issues: exp.issues.length,
    section_behavior: exp.section_behavior.length,
  }
}

function parseTargets(): FusionIngestTarget[] {
  const raw = process.env.FUSION_INGEST_TARGETS
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x): x is FusionIngestTarget => {
        const o = x as Record<string, unknown>
        return typeof o?.tenantId === 'string' && typeof o?.siteId === 'string' && typeof o?.jobId === 'string'
      })
      .map((x) => ({ tenantId: x.tenantId, siteId: x.siteId, jobId: x.jobId, days: x.days }))
  } catch {
    return []
  }
}

export async function runFusionIngest(): Promise<FusionIngestResult[]> {
  const targets = parseTargets()
  const out: FusionIngestResult[] = []
  for (const target of targets) {
    try {
      const exp = await fetchCrawlExport(target)
      const counts = await ingestCrawlExport(exp)
      out.push({ target, ok: true, counts })
    } catch (err: unknown) {
      out.push({ target, ok: false, error: err instanceof Error ? err.message : 'unknown' })
    }
  }
  return out
}
