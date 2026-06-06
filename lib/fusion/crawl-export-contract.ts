/**
 * crawl-export-contract.ts — UGOKI Crawl → UGOKI MAP 融合 contract (crawl_export_v1)
 *
 * 経路B (HTTP pull): UGOKI Crawl の GET /v1/fusion/export が返す JSON の Zod 契約。
 * linkscrawl/mcp_tools/crawl_export.py の出力と 1:1 で整合させること (additive-only、破壊変更は v2)。
 */

import { z } from 'zod'

const boolish = z.union([z.boolean(), z.number()]).transform((v) => (v ? 1 : 0))
const nstr = z.string().nullable().optional().transform((v) => v ?? null)

export const crawlSectionSchema = z.object({
  crawl_id: z.string(),
  page_url: z.string(),
  viewport_class: z.string().default('desktop'),
  section_index: z.number().int().default(0),
  section_selector: z.string().default(''),
  section_selector_hash: z.string().default(''),
  section_dom_path: z.string().default(''),
  section_heading: z.string().default(''),
  y_start: z.number().int().default(0),
  y_end: z.number().int().default(0),
  page_height: z.number().int().default(0),
  visible_text: z.string().default(''),
  has_cta: boolish.default(0),
  has_price: boolish.default(0),
  word_count: z.number().int().default(0),
  image_count: z.number().int().default(0),
  link_count: z.number().int().default(0),
  text_hash: z.string().default(''),
  asset_hash: z.string().default(''),
  cta_hash: z.string().default(''),
  crawled_at: nstr,
})

export const crawlPerformanceSchema = z.object({
  crawl_id: z.string(),
  page_url: z.string(),
  viewport_class: z.string().default('desktop'),
  lcp_ms: z.number().int().default(0),
  cls_score: z.number().default(0),
  inp_ms: z.number().int().default(0),
  ttfb_ms: z.number().int().default(0),
  fcp_ms: z.number().int().default(0),
  performance_score: z.number().int().default(0),
  crawled_at: nstr,
})

export const crawlIssueSchema = z.object({
  crawl_id: z.string(),
  page_url: z.string().default(''),
  issue_type: z.string().default(''),
  issue_code: z.string().default(''),
  issue_category: z.string().default('seo'),
  severity: z.string().default('medium'),
  selector: z.string().default(''),
  selector_hash: z.string().default(''),
  section_selector_hash: z.string().default(''),
  metric_name: z.string().default(''),
  metric_value: z.number().default(0),
  metric_unit: z.string().default(''),
  evidence: z.string().default(''),
  recommendation: z.string().default(''),
  detected_at: nstr,
})

export const crawlSectionBehaviorSchema = z.object({
  page_url: z.string(),
  viewport_class: z.string().default('desktop'),
  section_selector_hash: z.string(),
  window_start: z.string(),
  reached_sessions: z.number().int().default(0),
  clicks: z.number().int().default(0),
  dead_clicks: z.number().int().default(0),
  rage_clicks: z.number().int().default(0),
  avg_dwell_ms: z.number().default(0),
  avg_scroll_depth: z.number().default(0),
  exits: z.number().int().default(0),
  conversions: z.number().int().default(0),
  friction_score: z.number().default(0),
  match_confidence: z.number().default(0),
})

export const crawlExportV1Schema = z.object({
  schema_version: z.literal('v1'),
  source_system: z.string(),
  source_version: z.string(),
  generated_at: z.string(),
  tenant_id: z.string().min(1),
  site_id: z.string().min(1),
  crawl: z.object({
    crawl_id: z.string().min(1),
    crawled_at: nstr,
    page_count: z.number().int().default(0),
    status: z.string().default('completed'),
  }),
  sections: z.array(crawlSectionSchema).default([]),
  performance: z.array(crawlPerformanceSchema).default([]),
  issues: z.array(crawlIssueSchema).default([]),
  section_behavior: z.array(crawlSectionBehaviorSchema).default([]),
})

export type CrawlExportV1 = z.infer<typeof crawlExportV1Schema>
export type CrawlSection = z.infer<typeof crawlSectionSchema>
export type CrawlIssue = z.infer<typeof crawlIssueSchema>
export type CrawlPerformance = z.infer<typeof crawlPerformanceSchema>
export type CrawlSectionBehavior = z.infer<typeof crawlSectionBehaviorSchema>
