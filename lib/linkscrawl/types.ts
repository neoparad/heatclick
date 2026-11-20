/**
 * LINKTH CRAWL v1 (418+ Detections, 107 MCP Tools, 180 REST Endpoints)
 * TypeScript Data Models & BFF Response Contracts for UGOKI MAP Fusion SaaS.
 */

import type { ConfidenceLevel, ConfidenceSignal } from '@/lib/aiseo/confidence'

export type DataSourceMode = 'live' | 'not_collected' | 'insufficient_data'
export type CollectionStatus = 'ok' | 'not_collected' | 'insufficient_data'

export interface LinkscrawlConfidenceMeta {
  level: ConfidenceLevel
  reason: string
  signals: ConfidenceSignal[]
}

// ============================================================================
// 1. Site Doc Audit (`getSiteDocAudit`) — 418+ Detections
//    - 15 Categories (294 rules in ISSUE_TYPE_META)
//    - Page-type adaptive 16 items x 7 pillars Semantic AI Audit
//    - Deterministic Design Defects (10 types) & Vision Design Evaluation (8 axes)
//    - Automated Fix Patches (HTML/Config Diff + Expected Impact)
// ============================================================================

export type AuditIssueCategoryKey =
  | 'infra'
  | 'perf'
  | 'tech_basic'
  | 'indexability'
  | 'links'
  | 'content'
  | 'semantic_ai'
  | 'structured_data'
  | 'url'
  | 'media'
  | 'hreflang'
  | 'redirect'
  | 'mobile'
  | 'social'
  | 'intl'

export type IssueSeverity = 'critical' | 'warning' | 'notice' | 'pass'

export interface AuditCategorySummary {
  key: AuditIssueCategoryKey
  label: string
  totalRules: number
  passedRules: number
  criticalCount: number
  warningCount: number
  noticeCount: number
  score: number // 0..100
  highlights: string[]
}

export interface AuditIssueDetail {
  id: string
  ruleCode: string
  category: AuditIssueCategoryKey
  severity: IssueSeverity
  title: string
  description: string
  affectedUrl: string
  cssSelector?: string
  htmlSnippet?: string
  lineNumber?: number
  evidence: string
  recommendation: string
  confidence: LinkscrawlConfidenceMeta
}

export type SemanticPageType =
  | 'top'
  | 'lp_service'
  | 'listing'
  | 'company'
  | 'article'
  | 'contact'
  | 'faq'
  | 'legal'

export type SemanticAuditItemCode =
  | 'thin_content'
  | 'soft_404'
  | 'boilerplate_high'
  | 'stale_date'
  | 'trust_entity_weak'
  | 'specificity_lacking'
  | 'primary_info_lacking'
  | 'heading_decorative_abuse'
  | 'attribute_coverage_weak'
  | 'comparability_missing'
  | 'unstructured_data_prose'
  | 'title_content_mismatch'
  | 'meta_description_issue'
  | 'entity_schema_weak'
  | 'ai_extractability_poor'
  | 'cta_or_next_step_missing'

export interface HeadingDecorativeAbuseDetail {
  detected: boolean
  totalCheckedHeadings: number
  abusedCount: number
  angles: {
    visualSizingOnly: boolean // CSS見た目サイズ目的の<h>使用
    nonHeadingCardLabel: boolean // カードUIラベル・バッジへの<h>乱用
    hierarchySkip: boolean // h1 -> h4 等の階層スキップ
    excessiveLengthOrCta: boolean // ボタン文言・長文キャッチコピーへの<h>使用
    repeatedBoilerplateHeading: boolean // 共通フッター/サイドバーでの重複<h>
  }
  examples: Array<{
    tag: string
    text: string
    cssSelector: string
    lineNumber: number
    reason: string
  }>
}

export interface SemanticAuditItemResult {
  code: SemanticAuditItemCode
  label: string
  status: 'pass' | 'warn' | 'fail'
  score: number // 0..100
  finding: string
  evidenceSnippet?: string
  remediation: string
}

export type ContentAssetPillarKey =
  | '01_volume'
  | '02_uniqueness'
  | '03_reliability'
  | '04_specificity'
  | '05_structure'
  | '06_ai_readiness'
  | '07_discoverability'

export interface ContentAssetPillarScore {
  key: ContentAssetPillarKey
  label: string
  score: number // 0..100
  benchmark: number // 0..100
  rationale: string
}

export interface SemanticCascadeAudit {
  detectedPageType: SemanticPageType
  pageTypeLabel: string
  cascadeStageReached: 'stage1_jev' | 'stage2_gemma4' | 'stage3_teacher_verdict'
  overallSemanticScore: number // 0..100
  topicalCoherenceScore: number // 0..100
  pillars: ContentAssetPillarScore[]
  items: SemanticAuditItemResult[]
  headingDecorativeAbuse: HeadingDecorativeAbuseDetail
}

export type DesignDefectCode =
  | 'horizontal_overflow'
  | 'element_overflows_viewport'
  | 'element_overflows_container'
  | 'text_clipped'
  | 'empty_element_occupies_space'
  | 'image_aspect_distorted'
  | 'image_upscaled'
  | 'webfont_not_applied'
  | 'tap_target_too_small'
  | 'element_not_clickable'

export interface DesignDefectItem {
  code: DesignDefectCode
  label: string
  detected: boolean
  severity: IssueSeverity
  count: number
  viewport: 'mobile' | 'desktop' | 'both'
  cssSelector?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  detail: string
}

export type VisionDesignAxisKey =
  | 'color_harmony'
  | 'contrast_legibility'
  | 'whitespace_balance'
  | 'typography_hierarchy'
  | 'visual_hierarchy'
  | 'cta_prominence'
  | 'trust_credibility'
  | 'brand_consistency'

export interface VisionDesignAxisScore {
  key: VisionDesignAxisKey
  label: string
  score: number // 0..100
  comment: string
}

export interface FixPatchItem {
  id: string
  issueId: string
  ruleCode: string
  title: string
  targetFileOrSelector: string
  patchType: 'html_meta' | 'json_ld' | 'heading_dom' | 'headers_csp' | 'llms_txt' | 'css_layout'
  beforeCode: string
  afterCode: string
  unifiedDiff: string
  expectedImpact: {
    metric: string
    estimatedLift: string
    priority: 'P0' | 'P1' | 'P2'
  }
  verifiable: boolean
}

export interface SiteDocAuditResponse {
  status?: CollectionStatus
  reason?: string
  source: DataSourceMode
  siteId: string
  targetUrl: string
  canonicalUrl: string
  urlMatchKey: string
  auditedAt: string
  totalDetectionRules: number // 418 (0 when not_collected)
  overallHealthScore: number // 0..100
  grade: 'S' | 'A' | 'B' | 'C' | 'D' | 'N/A'
  confidence: LinkscrawlConfidenceMeta
  registrySummary: {
    totalCategories: number // 15
    totalRegistryRules: number // 294
    criticalTotal: number
    warningTotal: number
    noticeTotal: number
    passedTotal: number
    categories: AuditCategorySummary[]
  }
  topIssues: AuditIssueDetail[]
  semanticAudit: SemanticCascadeAudit
  designAudit: {
    deterministicDefectsTotal: number // 10 types checked
    activeDefectTypes: number
    defects: DesignDefectItem[]
    visionOverallScore: number // 0..100
    visionAxes: VisionDesignAxisScore[]
  }
  fixPatches: FixPatchItem[]
}

// ============================================================================
// 2. Performance Fusion (`getPerformanceFusion`)
//    - 12 Families / 90 Speed Rules (T1: 67 + T2: 23)
//    - CWV p75 (LCP / INP / CLS / TTFB)
//    - UGOKI MAP Speed x Behavior CV Loss Fusion (`linkscrawl_performance_fusion`)
// ============================================================================

export type SpeedRuleFamilyCode =
  | 'F1_FV_LCP'
  | 'F2_SLIDER'
  | 'F3_IMAGE'
  | 'F4_JS'
  | 'F5_CSS'
  | 'F6_FONT'
  | 'F7_NET'
  | 'F8_REDIRECT'
  | 'F9_THIRD_PARTY'
  | 'F10_DOM'
  | 'F11_WORDPRESS'
  | 'F12_COMPOUND'

export interface SpeedFamilySummary {
  familyCode: SpeedRuleFamilyCode
  label: string
  ruleRange: string
  totalRules: number
  triggeredCount: number
  estimatedSavingsMs: number
  status: 'good' | 'needs_improvement' | 'poor'
  topFindings: Array<{
    ruleId: string
    title: string
    severity: 'high' | 'medium' | 'low'
    impactMs: number
    targetResource?: string
    remediation: string
  }>
}

export interface CwvP75Metrics {
  lcpMs: number
  inpMs: number
  cls: number
  ttfbMs: number
  fcpMs: number
  speedScore: number // 0..100
  status: {
    lcp: 'good' | 'needs_improvement' | 'poor'
    inp: 'good' | 'needs_improvement' | 'poor'
    cls: 'good' | 'needs_improvement' | 'poor'
    ttfb: 'good' | 'needs_improvement' | 'poor'
  }
}

export interface SpeedCohortCvrComparison {
  fastCohort: {
    label: string // LCP < 2.5s
    thresholdLabel: string
    sessions: number
    conversions: number
    cvr: number // 0..1
    bounceRate: number // 0..1
    avgDwellMs: number
  }
  moderateCohort: {
    label: string // 2.5s <= LCP <= 4.0s
    thresholdLabel: string
    sessions: number
    conversions: number
    cvr: number
    bounceRate: number
    avgDwellMs: number
  }
  slowCohort: {
    label: string // LCP > 4.0s
    thresholdLabel: string
    sessions: number
    conversions: number
    cvr: number // 0..1
    bounceRate: number // 0..1
    avgDwellMs: number
  }
  fastVsSlowCvrMultiplier: number
}

export interface BehaviorCvLossFusion {
  monthlyTotalSessions: number
  preRenderExitRate: number // 0..1
  preRenderExitSessions: number
  cohortComparison: SpeedCohortCvrComparison
  estimatedMonthlyLostConversions: number
  estimatedMonthlyLostRevenueJpy: number
  recoverableConversionsIfFast: number
  recoverableRevenueJpyIfFast: number
  unitConversionValueJpy: number
  bottleneckPatterns: Array<{
    patternId: string
    title: string
    speedTrigger: string
    behaviorSymptom: string
    lostConversions: number
    recommendation: string
  }>
}

export interface PerformanceFusionResponse {
  status?: CollectionStatus
  reason?: string
  source: DataSourceMode
  siteId: string
  targetUrl: string
  canonicalUrl: string
  urlMatchKey: string
  measuredAt: string
  totalSpeedRulesChecked: number // 90 (12 families)
  triggeredRulesCount: number
  cwvP75: CwvP75Metrics
  families: SpeedFamilySummary[]
  behaviorCvLossFusion: BehaviorCvLossFusion
  confidence: LinkscrawlConfidenceMeta
}

// ============================================================================
// 3. UGOKI MAP Fusion & ML 13 Tools (`getUrlFusionMl`)
//    - contentMap (Section Y-coordinate bounds x dwell time x exit rate)
//    - frictionHotspots (Rage/Dead click x DOM cause)
//    - scrollSurvival (Kaplan-Meier survival curve & 50% drop-off Y coordinate)
//    - cvrPrediction (80+ features CVR prediction & Top improvement levers)
//    - teacherVerdict (7 Pillars Radar Chart & Overall Grade S..D)
// ============================================================================

export interface ContentMapSectionItem {
  sectionIndex: number
  sectionId: string
  headingText: string
  headingTag: string
  yStartPx: number
  yEndPx: number
  heightPx: number
  reachRate: number // 0..1
  avgDwellMs: number
  exitRate: number // 0..1
  clickCount: number
  deadClickCount: number
  rageClickCount: number
  hasCta: boolean
  dominantEmotion: 'interest' | 'confidence' | 'hesitation' | 'frustration'
}

export interface FrictionHotspotItem {
  id: string
  type: 'rage_click' | 'dead_click' | 'dead_button' | 'layout_shift_misclick'
  severity: 'high' | 'medium' | 'low'
  yCoordinatePx: number
  xCoordinatePx: number
  sectionHeading: string
  eventCount: number
  affectedSessions: number
  cssSelector: string
  domCause: string
  fixRecommendation: string
  estimatedCvrLiftPct: number
}

export interface KaplanMeierSurvivalPoint {
  yPx: number
  scrollPct: number
  allUsersSurvival: number // 0..1
  convertersSurvival: number // 0..1
  nonConvertersSurvival: number // 0..1
  hazardRate: number // instantaneous drop-off hazard
  nearestHeading?: string
}

export interface ScrollSurvivalAnalysis {
  pageTotalHeightPx: number
  medianDropoffYpx: number // 50%離脱Y座標
  medianDropoffScrollPct: number
  steepestCliffYpx: number
  steepestCliffSection: string
  converterSurvivalAtCta: number // 0..1
  nonConverterSurvivalAtCta: number // 0..1
  curve: KaplanMeierSurvivalPoint[]
}

export interface CvrPredictionLever {
  rank: number
  featureName: string
  featureCategory: 'structure' | 'behavior' | 'speed' | 'semantic_ai'
  currentValue: string
  targetValue: string
  shapImportance: number // 0..1
  predictedCvrDeltaPct: number // relative lift %
  estimatedAdditionalMonthlyConversions: number
  actionSummary: string
}

export interface CvrPredictionResult {
  featureCountUsed: number // 80+
  modelVersion: string
  currentObservedCvr: number // 0..1
  predictedBaselineCvr: number // 0..1
  potentialOptimizedCvr: number // 0..1
  upliftMultiplier: number
  sessionQualityScore: number // 0..100
  sessionQualityGrade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'N/A'
  personaDistribution: Array<{
    personaId: string
    label: string
    share: number // 0..1
    cvr: number // 0..1
    dominantEmotion: string
  }>
  topLevers: CvrPredictionLever[]
}

export interface TeacherVerdictCarte {
  overallScore: number // 0..100
  grade: 'S' | 'A' | 'B' | 'C' | 'D' | 'N/A'
  headlineVerdict: string
  executiveSummary: string
  pillars: ContentAssetPillarScore[]
  priorityPrescriptions: Array<{
    step: number
    area: string
    diagnosis: string
    prescription: string
    expectedOutcome: string
  }>
}

export interface UrlFusionMlResponse {
  status?: CollectionStatus
  reason?: string
  source: DataSourceMode
  siteId: string
  targetUrl: string
  canonicalUrl: string
  urlMatchKey: string
  analyzedAt: string
  activeMlTools: string[] // 13 tools list
  contentMap: ContentMapSectionItem[]
  frictionHotspots: FrictionHotspotItem[]
  scrollSurvival: ScrollSurvivalAnalysis
  cvrPrediction: CvrPredictionResult
  teacherVerdict: TeacherVerdictCarte
  confidence: LinkscrawlConfidenceMeta
}

// ============================================================================
// 4. AIO Citation Diff & Answer Engine 18-Tool Autonomous RAG
// ============================================================================

export interface AioCitationDiffItem {
  query: string
  monthlySearchVolume: number
  aioPresent: boolean
  selfCited: boolean
  selfOrganicRank: number | null
  citedCompetitors: Array<{
    domain: string
    url: string
    citationPosition: number
    extractedSnippet: string
  }>
  missingHeadingsOrFacts: string[]
  eeatSignalGap: string[]
  recommendedAdditionHtml: string
  priority: 'high' | 'medium' | 'low'
}

export interface AnswerEngineCitation {
  index: number // [1], [2]...
  sourcePlane: 'linkscrawl_rag' | 'ugokimap_behavior' | 'gsc_search' | 'ga4_ai_traffic' | 'aireceipt_bot'
  title: string
  url: string
  verbatimQuote: string
  verified: boolean
  evidenceRef: string // HMAC-like deterministic ref
}

export interface AnswerEngineToolExecution {
  toolName: string
  category: 'rag_retrieval' | 'structure_audit' | 'speed_fusion' | 'behavior_ml' | 'serp_aio' | 'ai_traffic'
  status: 'executed' | 'not_collected'
  durationMs: number
  summary: string
}

export interface FusionAnswerEngineResponse {
  status?: CollectionStatus
  reason?: string
  source: DataSourceMode
  siteId: string
  targetUrl: string
  question: string
  answer: string
  citations: AnswerEngineCitation[]
  usedTools: AnswerEngineToolExecution[]
  suggestedActions: Array<{
    title: string
    category: 'seo_structure' | 'ux_behavior' | 'page_speed' | 'aio_semantic'
    expectedImpact: string
    commandOrPatchHint: string
  }>
  confidence: LinkscrawlConfidenceMeta
}
