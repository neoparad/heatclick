export interface AuditItem {
  id: string
  title: string
  description: string
  score: number | null       // 0-1
  displayValue?: string
  numericValue?: number
}

export interface PageSpeedData {
  performance_score: number
  accessibility_score: number
  best_practices_score: number
  seo_score: number
  lcp: number        // seconds
  cls: number
  inp: number        // milliseconds
  fcp: number        // seconds
  tbt: number        // milliseconds (Total Blocking Time)
  speed_index: number // seconds
  tti: number        // seconds (Time to Interactive)
  measured_at: string
  audit_items: AuditItem[]   // 個別監査項目（失敗・要改善のもの）
}

export interface PagePerformance {
  url: string
  sessions: number
  conversions: number
  cvr: number
  avg_scroll_depth: number
  rage_clicks: number
  pagespeed: PageSpeedData | null
}

export interface PerformanceData {
  pages: PagePerformance[]
  summary: {
    avg_score: number | null
    avg_lcp: number | null
    problem_pages: number
    avg_cvr: number
  }
}
