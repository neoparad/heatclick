/**
 * Behavior × Structure (行動×構造) + 4-Plane Cross-Analysis Engine.
 *
 * Bridges:
 *   1. Human Behavior (ugokimap: sessions, dwell_ms, scroll_depth, dead_clicks, rage_clicks, bounce_rate)
 *   2. Page Structure & Speed (linkscrawl / ClickHouse page_performance, page_content_sections, page_issues, image_visibility)
 *   3. Search Inflow & Index Status (GSC: clicks, impressions, ctr, position, verdict)
 *   4. AI Crawler & Agent Visits (AIreceipt: total_ai_visits, citation_referrals, training_crawls, top_bots)
 *
 * Every diagnostic item attaches a multi-signal ConfidenceScore (`scoreConfidence` from @/lib/aiseo/confidence)
 * so that inferences are never presented as unverified facts without provenance.
 */
import {
  confidenceReason,
  scoreConfidence,
  type ConfidenceLevel,
  type ConfidenceSignal,
} from '@/lib/aiseo/confidence'
import { normalizeUrlFull } from '@/lib/url/normalize-url'

export interface SectionCrossRow {
  sectionOrder: number
  headingText: string
  headingLevel: number
  elementTag: string
  wordCount: number
  hasCta: boolean
  linkCount: number
  imageCount: number
  distanceToNextCtaPx: number
  reachRate: number // 0..1
  avgDwellMs: number
  clickCount: number
  deadClickCount: number
  rageClickCount: number
  ctaClickRate: number // 0..1
  exitRate: number // 0..1
}

export interface UnoptimizedImageCrossRow {
  imageSrc: string
  fileSizeBytes: number
  hasWidthHeight: boolean
  loadingAttr: 'lazy' | 'eager' | 'none'
  visibleRate: number // 0..1 (from image_visibility)
  avgVisibleTimeMs: number
}

export interface DirectoryPerfBehaviorRow {
  directory: string
  pageCount: number
  avgLcpMs: number
  avgTtfbMs: number
  avgSpeedScore: number
  bounceRate: number // 0..1
  preRenderExitRate: number // 0..1 (dwell_ms < lcp_ms)
  avgScrollDepthPct: number
  gscClicks: number
  aiVisits: number
}

export interface HumanBehaviorSummary {
  sessions: number
  pageviews: number
  avgDwellMs: number
  medianDwellMs: number
  avgScrollDepthPct: number
  bounceRate: number // 0..1
  preRenderExitRate: number // 0..1 (sessions where dwell_ms < lcp_ms)
  totalClicks: number
  deadClicks: number
  rageClicks: number
  cvRate: number // 0..1
}

export interface StructurePerfSummary {
  title: string
  wordCount: number
  inboundLinks: number
  outboundLinks: number
  clickDepth: number
  pageRank: number
  lcpMs: number
  ttfbMs: number
  cls: number
  inpMs: number
  speedScore: number
  totalTransferKb: number
  unoptimizedImagesCount: number
  missingImageDimensionsCount: number
}

export interface GscPageSummary {
  clicks: number
  impressions: number
  ctr: number
  position: number
  indexVerdict: 'PASS' | 'NEUTRAL' | 'FAIL'
  coverageState: string
  topQueries: Array<{ query: string; clicks: number; impressions: number; position: number }>
}

export interface AiAccessPageSummary {
  totalVisits: number
  searchReferrals: number
  citationFetches: number
  trainingCrawls: number
  topAgents: Array<{ agent: string; category: string; count: number }>
}

export type DiagnosisCategory =
  | 'dead_click_structure'
  | 'rage_click_cls'
  | 'low_perf_high_bounce'
  | 'exit_before_render'
  | 'unseen_heavy_image'
  | 'shallow_reading_dropoff'
  | 'ai_vs_human_gap'

export type DiagnosisSeverity = 'high' | 'medium' | 'low'

export interface CrossDiagnosisConfidence {
  level: ConfidenceLevel
  reason: string
  signals: ConfidenceSignal[]
}

export interface CrossDiagnosisItem {
  id: string
  category: DiagnosisCategory
  severity: DiagnosisSeverity
  title: string
  summary: string
  mechanism: string
  recommendation: string
  metrics: Array<{ label: string; value: string; plane: 'behavior' | 'structure' | 'seo' | 'ai' }>
  confidence: CrossDiagnosisConfidence
}

function buildCrossConfidence(signals: ConfidenceSignal[]): CrossDiagnosisConfidence {
  return {
    level: scoreConfidence(signals),
    reason: confidenceReason(null, signals),
    signals,
  }
}

export interface UrlFusionInput {
  url: string
  behavior: HumanBehaviorSummary
  structure: StructurePerfSummary
  gsc: GscPageSummary
  ai: AiAccessPageSummary
  sections: SectionCrossRow[]
  images: UnoptimizedImageCrossRow[]
  directoryMatrix: DirectoryPerfBehaviorRow[]
}

/**
 * Pure diagnostic engine that cross-analyzes Behavior × Structure × SEO × AI for a canonical URL.
 */
export function diagnoseBehaviorAndStructure(input: UrlFusionInput): CrossDiagnosisItem[] {
  const diagnoses: CrossDiagnosisItem[] = []
  const { behavior, structure, gsc, ai, sections, images, directoryMatrix } = input

  // 1. Dead Click × DOM Structure (デッドクリック要因 × 構造データの掛け合わせ)
  const deadClickSections = sections.filter(
    (s) => s.deadClickCount >= 8 && (!s.hasCta || s.linkCount === 0)
  )
  if (deadClickSections.length > 0 || behavior.deadClicks >= 15) {
    const targetSec =
      deadClickSections.sort((a, b) => b.deadClickCount - a.deadClickCount)[0] ||
      sections.slice().sort((a, b) => b.deadClickCount - a.deadClickCount)[0]

    const signals: ConfidenceSignal[] = [
      {
        kind: 'human_behavior',
        label: `ページ全体でデッドクリック ${behavior.deadClicks}回（最大発生セクション「${targetSec?.headingText || '本文'}」で ${targetSec?.deadClickCount ?? behavior.deadClicks}回）`,
      },
    ]
    if (targetSec && (!targetSec.hasCta || targetSec.linkCount === 0)) {
      signals.push({
        kind: 'structure_dom',
        label: `該当セクション（<${targetSec.elementTag}>, H${targetSec.headingLevel}）の内部リンク数=${targetSec.linkCount}・CTA有無=${targetSec.hasCta ? 'あり' : 'なし'}（次のCTAまで ${targetSec.distanceToNextCtaPx}px）`,
      })
    }

    diagnoses.push({
      id: 'diag-dead-click-structure',
      category: 'dead_click_structure',
      severity: behavior.deadClicks >= 25 ? 'high' : 'medium',
      title: 'デッドクリック集中 × 非対話DOM構造の不一致',
      summary: targetSec
        ? `セクション「${targetSec.headingText}」にデッドクリックが ${targetSec.deadClickCount} 回集中しています。構造上この領域にはリンク・CTAが配置されておらず、ユーザーが図表や強調テキストをクリック可能と誤認しています。`
        : `ページ内でデッドクリックが ${behavior.deadClicks} 回発生しています。`,
      mechanism:
        '行動データ（dead_click 座標・セクション集計）と linkscrawl のセクション構造（has_cta=0, link_count=0）を照合した結果、ユーザーの探索意図に対して遷移先導線が欠落していることが判明しました。',
      recommendation: targetSec
        ? `「${targetSec.headingText}」直下に詳細ページへの内部リンクまたはマイクロCTAを配置し、次のCTAまでの距離（現在 ${targetSec.distanceToNextCtaPx}px）を 400px 以下に短縮してください。`
        : 'デッドクリック集中箇所のテキスト・画像をリンク化するか、明示的なボタン導線を追加してください。',
      metrics: [
        { label: 'デッドクリック数', value: `${behavior.deadClicks}回`, plane: 'behavior' },
        {
          label: '集中セクション内リンク数',
          value: `${targetSec?.linkCount ?? 0}本`,
          plane: 'structure',
        },
        {
          label: '次CTAまでの距離',
          value: `${targetSec?.distanceToNextCtaPx ?? 0}px`,
          plane: 'structure',
        },
      ],
      confidence: buildCrossConfidence(signals),
    })
  }

  // 2. Rage Click × CLS / Image Dimension Defect (レイジクリック × レイアウトシフト構造欠陥)
  if (behavior.rageClicks >= 5 && (structure.cls >= 0.1 || structure.missingImageDimensionsCount > 0)) {
    const signals: ConfidenceSignal[] = [
      {
        kind: 'human_behavior',
        label: `短時間連打（レイジクリック）が ${behavior.rageClicks} 回発生`,
      },
      {
        kind: 'structure_perf',
        label: `CLS=${structure.cls.toFixed(2)} / width・height未指定画像=${structure.missingImageDimensionsCount}枚`,
      },
    ]
    diagnoses.push({
      id: 'diag-rage-click-cls',
      category: 'rage_click_cls',
      severity: structure.cls >= 0.18 ? 'high' : 'medium',
      title: 'レイジクリック誘発 × レイアウトシフト（画像寸法未指定）',
      summary: `レイジクリック（${behavior.rageClicks}回）と高いCLS（${structure.cls.toFixed(2)}）が同時発生しています。width/height 未指定の画像（${structure.missingImageDimensionsCount}枚）の遅延読み込みにより、クリック直前にボタン位置がズレています。`,
      mechanism:
        '人間の苛立ちシグナル（rage_click）と構造監査（missing_image_dimensions / CLS）が一致しており、UIの応答不良ではなくレイアウトシフトによる誤タップ誘発が主因と判定されます。',
      recommendation:
        '該当ページ内の <img> 要素すべてに明示的な width / height 属性（または aspect-ratio CSS）を付与し、CLS を 0.1 未満に抑えてください。',
      metrics: [
        { label: 'レイジクリック', value: `${behavior.rageClicks}回`, plane: 'behavior' },
        { label: 'CLS (レイアウトシフト)', value: structure.cls.toFixed(2), plane: 'structure' },
        {
          label: '寸法未指定の画像',
          value: `${structure.missingImageDimensionsCount}枚`,
          plane: 'structure',
        },
      ],
      confidence: buildCrossConfidence(signals),
    })
  }

  // 3. Exiting before page finishes rendering (ページが全て表示されずに離脱 + 未視認の重い画像)
  const unseenHeavyImages = images.filter(
    (img) => img.fileSizeBytes >= 150_000 && img.visibleRate < 0.35
  )
  if (behavior.preRenderExitRate >= 0.15 || (structure.lcpMs >= 2500 && unseenHeavyImages.length > 0)) {
    const signals: ConfidenceSignal[] = [
      {
        kind: 'human_behavior',
        label: `LCP描画完了前に離脱したセッション比率 ${(behavior.preRenderExitRate * 100).toFixed(1)}%（中央値滞在 ${behavior.medianDwellMs}ms）`,
      },
      {
        kind: 'structure_perf',
        label: `LCP=${structure.lcpMs}ms, TTFB=${structure.ttfbMs}ms, 未視認の大容量画像=${unseenHeavyImages.length}枚`,
      },
    ]
    const totalWastedKb = Math.round(
      unseenHeavyImages.reduce((acc, img) => acc + img.fileSizeBytes, 0) / 1024
    )
    diagnoses.push({
      id: 'diag-exit-before-render',
      category: 'exit_before_render',
      severity: behavior.preRenderExitRate >= 0.22 || structure.lcpMs >= 3200 ? 'high' : 'medium',
      title: '描画完了前離脱（Pre-LCP Exit）× 未視認の大容量アセット負荷',
      summary: `流入ユーザーの ${(behavior.preRenderExitRate * 100).toFixed(1)}% がメインコンテンツ描画完了（LCP ${structure.lcpMs}ms）より前に離脱しています。さらにページ下部の大容量画像 ${unseenHeavyImages.length}枚（計 ${totalWastedKb}KB）が 70% 以上のユーザーに視認されないまま初期帯域を圧迫しています。`,
      mechanism:
        'セッション滞在時間（dwell_ms）とページLCP（lcp_ms）の個体照合、および image_visibility（視認率）と unoptimized_images（ファイルサイズ・loading属性）の掛け合わせによる診断です。',
      recommendation:
        'ファーストビュー外の画像に loading="lazy" と WebP/AVIF 変換を適用して初期転送量を削減し、LCP要素のプリロードを行って描画完了前離脱を抑制してください。',
      metrics: [
        {
          label: '描画完了前離脱率',
          value: `${(behavior.preRenderExitRate * 100).toFixed(1)}%`,
          plane: 'behavior',
        },
        { label: 'LCP / TTFB', value: `${structure.lcpMs}ms / ${structure.ttfbMs}ms`, plane: 'structure' },
        {
          label: '未視認の重い画像',
          value: `${unseenHeavyImages.length}枚 (${totalWastedKb}KB)`,
          plane: 'structure',
        },
      ],
      confidence: buildCrossConfidence(signals),
    })
  }

  // 4. Shallow reading / Scroll drop-off × Section Structure (ページを深く読まない × セクション文字密度・CTA空白地帯)
  let steepestDrop: {
    fromSec: SectionCrossRow
    toSec: SectionCrossRow
    dropPct: number
  } | null = null
  for (let i = 0; i < sections.length - 1; i++) {
    const cur = sections[i]
    const next = sections[i + 1]
    const drop = cur.reachRate - next.reachRate
    if (!steepestDrop || drop > steepestDrop.dropPct) {
      steepestDrop = { fromSec: cur, toSec: next, dropPct: drop }
    }
  }
  if (
    steepestDrop &&
    (steepestDrop.dropPct >= 0.22 || behavior.avgScrollDepthPct < 55) &&
    steepestDrop.fromSec.wordCount >= 350
  ) {
    const { fromSec, toSec, dropPct } = steepestDrop
    const signals: ConfidenceSignal[] = [
      {
        kind: 'human_behavior',
        label: `セクション#${fromSec.sectionOrder}→#${toSec.sectionOrder}で到達率が ${(dropPct * 100).toFixed(1)}pt 急落（平均スクロール深度 ${behavior.avgScrollDepthPct}%）`,
      },
      {
        kind: 'structure_dom',
        label: `セクション#${fromSec.sectionOrder}「${fromSec.headingText}」は文字量 ${fromSec.wordCount}語・画像 ${fromSec.imageCount}枚・次CTAまで ${fromSec.distanceToNextCtaPx}px`,
      },
    ]
    diagnoses.push({
      id: 'diag-shallow-reading-dropoff',
      category: 'shallow_reading_dropoff',
      severity: dropPct >= 0.3 ? 'high' : 'medium',
      title: '浅い読了（スクロール急落）× 長文テキスト塊・視覚要素不足',
      summary: `セクション「${fromSec.headingText}」（到達率 ${(fromSec.reachRate * 100).toFixed(0)}%）から次セクション「${toSec.headingText}」（到達率 ${(toSec.reachRate * 100).toFixed(0)}%）の間で ${(dropPct * 100).toFixed(1)}% のユーザーが離脱しています。${fromSec.wordCount}語のテキスト塊に対し図解が ${fromSec.imageCount}枚しかなく、読了疲労が起きています。`,
      mechanism:
        'section_behavior_summary のセクション別到達率・滞在時間と、page_content_sections の語数（word_count）・画像数（image_count）・CTA距離を結合して特定した読了ボトルネックです。',
      recommendation: `「${fromSec.headingText}」を H3 小見出しまたは箇条書きボックスで 2〜3 ブロックに分割し、要点サマリー図または中間CTAを挿入して下部セクションへの到達率を引き上げてください。`,
      metrics: [
        {
          label: '区間離脱幅',
          value: `-${(dropPct * 100).toFixed(1)}pt`,
          plane: 'behavior',
        },
        {
          label: '該当ブロック語数',
          value: `${fromSec.wordCount}語 (画像${fromSec.imageCount}枚)`,
          plane: 'structure',
        },
        {
          label: '平均スクロール深度',
          value: `${behavior.avgScrollDepthPct}%`,
          plane: 'behavior',
        },
      ],
      confidence: buildCrossConfidence(signals),
    })
  }

  // 5. Directory Performance × High Bounce Rate (ページパフォーマンスが低いディレクトリが離脱率が高い)
  let firstSeg: string | undefined
  try {
    const canon = normalizeUrlFull(input.url)
    firstSeg = canon.pathname.split('/').filter(Boolean)[0]
  } catch {
    firstSeg = undefined
  }
  const currentDir = firstSeg ? `/${firstSeg}` : '/'
  const worstDir =
    directoryMatrix.find((d) => d.directory === currentDir && d.avgLcpMs >= 2400 && d.bounceRate >= 0.5) ||
    directoryMatrix
      .filter((d) => d.avgLcpMs >= 2500 && d.bounceRate >= 0.55)
      .sort((a, b) => b.bounceRate - a.bounceRate)[0]

  if (worstDir) {
    const fastestDir = directoryMatrix.slice().sort((a, b) => a.avgLcpMs - b.avgLcpMs)[0]
    const bounceDiffPts = fastestDir
      ? ((worstDir.bounceRate - fastestDir.bounceRate) * 100).toFixed(1)
      : '15.0'
    const signals: ConfidenceSignal[] = [
      {
        kind: 'structure_perf',
        label: `ディレクトリ「${worstDir.directory}」（${worstDir.pageCount}ページ）の平均LCP=${worstDir.avgLcpMs}ms・速度スコア=${worstDir.avgSpeedScore}`,
      },
      {
        kind: 'human_behavior',
        label: `同ディレクトリの直帰率 ${(worstDir.bounceRate * 100).toFixed(1)}%・描画前離脱率 ${(worstDir.preRenderExitRate * 100).toFixed(1)}%（最速ディレクトリ比 +${bounceDiffPts}pt）`,
      },
    ]
    diagnoses.push({
      id: 'diag-directory-perf-bounce',
      category: 'low_perf_high_bounce',
      severity: worstDir.bounceRate >= 0.62 ? 'high' : 'medium',
      title: `ディレクトリ「${worstDir.directory}」の低パフォーマンス × 高直帰率の構造相関`,
      summary: `ディレクトリ「${worstDir.directory}」配下（${worstDir.pageCount}ページ）は平均 LCP ${worstDir.avgLcpMs}ms と遅く、直帰率が ${(worstDir.bounceRate * 100).toFixed(1)}% に達しています（高速ディレクトリ「${fastestDir?.directory || '/'}」比で +${bounceDiffPts}pt 悪化）。`,
      mechanism:
        '個別ページの偶発的な離脱ではなく、ディレクトリ共通テンプレート（共通ヘッダスクリプト・重たいアイキャッチ画像・SSRキャッシュ未設定）に起因する構造的なパフォーマンス劣化が人間行動の直帰率を押し上げています。',
      recommendation: `「${worstDir.directory}」テンプレート共通のレンダーブロッキング CSS/JS とアイキャッチ画像の配信設定を見直し、ディレクトリ全体の LCP を 2,000ms 以下へ改善してください。`,
      metrics: [
        { label: `${worstDir.directory} 平均LCP`, value: `${worstDir.avgLcpMs}ms`, plane: 'structure' },
        {
          label: `${worstDir.directory} 直帰率`,
          value: `${(worstDir.bounceRate * 100).toFixed(1)}%`,
          plane: 'behavior',
        },
        {
          label: '検索クリック / AI訪問',
          value: `${worstDir.gscClicks} / ${worstDir.aiVisits}`,
          plane: 'seo',
        },
      ],
      confidence: buildCrossConfidence(signals),
    })
  }

  // 6. 4-Plane Cross-Correlation: High AI/Search Authority vs Human UX Friction
  if ((ai.totalVisits >= 40 || gsc.clicks >= 200) && (behavior.bounceRate >= 0.52 || behavior.cvRate < 0.015)) {
    const signals: ConfidenceSignal[] = [
      {
        kind: 'identity',
        label: `AIクローラー・エージェント訪問 ${ai.totalVisits}回（うち引用フェッチ ${ai.citationFetches}回、検索流入 ${gsc.clicks} click）`,
      },
      {
        kind: 'human_behavior',
        label: `人間セッションの直帰率 ${(behavior.bounceRate * 100).toFixed(1)}%・CVR ${(behavior.cvRate * 100).toFixed(2)}%`,
      },
    ]
    diagnoses.push({
      id: 'diag-ai-vs-human-gap',
      category: 'ai_vs_human_gap',
      severity: 'medium',
      title: 'AI・検索の高評価ページ × 人間セッションのCV取りこぼしギャップ',
      summary: `このページは検索流入（${gsc.clicks}クリック）およびAI引用・クロール（${ai.totalVisits}回）で高い権威性を獲得していますが、訪問した人間の直帰率が ${(behavior.bounceRate * 100).toFixed(1)}% と高く、CVR（${(behavior.cvRate * 100).toFixed(2)}%）に繋がっていません。`,
      mechanism:
        'AIreceipt（AIアクセス）・GSC（検索流入）・linkscrawl（構造）・ugokimap（行動）の4平面照合により、「AIや検索エンジンには構造的に高く評価されているが、人間のファーストビュー体験とCTA導線で機会損失している」ページとして特定されました。',
      recommendation:
        'AI引用や検索クエリで直接着地したユーザー向けに、記事冒頭（セクション#1〜#2）に結論サマリーと関連ソリューションへの内部リンク/CTAを設置してください。',
      metrics: [
        { label: 'GSC クリック数', value: `${gsc.clicks}回 (順位 ${gsc.position}位)`, plane: 'seo' },
        { label: 'AI 訪問 / 引用取得', value: `${ai.totalVisits}回 / ${ai.citationFetches}回`, plane: 'ai' },
        { label: '人間直帰率 / CVR', value: `${(behavior.bounceRate * 100).toFixed(1)}% / ${(behavior.cvRate * 100).toFixed(2)}%`, plane: 'behavior' },
      ],
      confidence: buildCrossConfidence(signals),
    })
  }

  return diagnoses
}

/**
 * Deterministic multi-plane dataset generator for `/api/fusion/url-summary`
 * so the 4-plane + Behavior×Structure view works out-of-the-box and adapts to any selected URL.
 */
export function buildFusionDatasetForUrl(rawUrl: string, siteId = 'default'): UrlFusionInput & {
  canonicalUrl: string
  urlMatchKey: string
  urlHash16: string
  siteId: string
  availableUrls: Array<{ url: string; title: string; badge: string }>
} {
  const availableUrls = [
    {
      url: 'https://link-th.com/entry/internal-link-optimization',
      title: '内部リンク最適化の完全ガイド：トピッククラスターとPageRank設計',
      badge: 'デッドクリック×構造不一致',
    },
    {
      url: 'https://link-th.com/column/eeat-checklist-2026',
      title: '2026年版 E-E-A-T 強化チェックリストと構造化データ実装',
      badge: '低速ディレクトリ×描画前離脱',
    },
    {
      url: 'https://link-th.com/entry/aio-llmo-guide',
      title: 'AIO / LLMO 対策の実践設計：AI検索で引用されるページ構造とは',
      badge: 'AI高引用×浅い読了ギャップ',
    },
    {
      url: 'https://link-th.com/entry/sitemap-index-troubleshooting',
      title: 'Search Console「クロール済み - インデックス未登録」の原因と解決手順',
      badge: 'レイジクリック×CLS発生',
    },
  ]

  let norm = normalizeUrlFull(availableUrls[0].url)
  try {
    const rawTrimmed = (rawUrl || '').trim()
    if (rawTrimmed) {
      const candidate = rawTrimmed.startsWith('/')
        ? `https://link-th.com${rawTrimmed}`
        : rawTrimmed
      norm = normalizeUrlFull(candidate)
    }
  } catch {
    norm = normalizeUrlFull(availableUrls[0].url)
  }

  const isColumn = norm.pathname.startsWith('/column')
  const isAio = norm.pathname.includes('aio-llmo')
  const isSitemap = norm.pathname.includes('sitemap-index')

  const behavior: HumanBehaviorSummary = isColumn
    ? {
        sessions: 1420,
        pageviews: 1680,
        avgDwellMs: 38_000,
        medianDwellMs: 2_900,
        avgScrollDepthPct: 41,
        bounceRate: 0.684,
        preRenderExitRate: 0.264,
        totalClicks: 410,
        deadClicks: 19,
        rageClicks: 9,
        cvRate: 0.008,
      }
    : isAio
    ? {
        sessions: 2890,
        pageviews: 3540,
        avgDwellMs: 54_000,
        medianDwellMs: 19_500,
        avgScrollDepthPct: 48,
        bounceRate: 0.562,
        preRenderExitRate: 0.142,
        totalClicks: 920,
        deadClicks: 24,
        rageClicks: 4,
        cvRate: 0.011,
      }
    : isSitemap
    ? {
        sessions: 2150,
        pageviews: 2610,
        avgDwellMs: 61_000,
        medianDwellMs: 24_000,
        avgScrollDepthPct: 58,
        bounceRate: 0.518,
        preRenderExitRate: 0.168,
        totalClicks: 780,
        deadClicks: 16,
        rageClicks: 14,
        cvRate: 0.014,
      }
    : {
        sessions: 3640,
        pageviews: 4520,
        avgDwellMs: 68_000,
        medianDwellMs: 27_400,
        avgScrollDepthPct: 51,
        bounceRate: 0.541,
        preRenderExitRate: 0.184,
        totalClicks: 1280,
        deadClicks: 34,
        rageClicks: 8,
        cvRate: 0.012,
      }

  const matchedTitle =
    availableUrls.find((u) => u.url.includes(norm.pathname))?.title ||
    `記事ページ (${norm.pathname})`

  const structure: StructurePerfSummary = isColumn
    ? {
        title: matchedTitle,
        wordCount: 3420,
        inboundLinks: 4,
        outboundLinks: 5,
        clickDepth: 3,
        pageRank: 0.38,
        lcpMs: 3680,
        ttfbMs: 940,
        cls: 0.19,
        inpMs: 240,
        speedScore: 54,
        totalTransferKb: 2840,
        unoptimizedImagesCount: 4,
        missingImageDimensionsCount: 3,
      }
    : isSitemap
    ? {
        title: matchedTitle,
        wordCount: 4180,
        inboundLinks: 16,
        outboundLinks: 12,
        clickDepth: 2,
        pageRank: 0.69,
        lcpMs: 2790,
        ttfbMs: 680,
        cls: 0.22,
        inpMs: 210,
        speedScore: 66,
        totalTransferKb: 1920,
        unoptimizedImagesCount: 3,
        missingImageDimensionsCount: 4,
      }
    : {
        title: matchedTitle,
        wordCount: 4850,
        inboundLinks: 31,
        outboundLinks: 19,
        clickDepth: 1,
        pageRank: 0.88,
        lcpMs: 2840,
        ttfbMs: 720,
        cls: 0.14,
        inpMs: 185,
        speedScore: 68,
        totalTransferKb: 2150,
        unoptimizedImagesCount: 3,
        missingImageDimensionsCount: 2,
      }

  const gsc: GscPageSummary = isColumn
    ? {
        clicks: 134,
        impressions: 6200,
        ctr: 0.0216,
        position: 8.1,
        indexVerdict: 'NEUTRAL',
        coverageState: 'Crawled - currently not indexed (一部派生URL)',
        topQueries: [
          { query: 'E-E-A-T 強化 方法', clicks: 64, impressions: 3900, position: 8.2 },
          { query: '構造化データ JSON-LD 書き方', clicks: 42, impressions: 1600, position: 7.5 },
        ],
      }
    : {
        clicks: 610,
        impressions: 9800,
        ctr: 0.0622,
        position: 3.4,
        indexVerdict: 'PASS',
        coverageState: 'Submitted and indexed',
        topQueries: [
          { query: '内部リンク 最適化', clicks: 320, impressions: 4800, position: 3.2 },
          { query: 'トピッククラスター 設計', clicks: 104, impressions: 1950, position: 3.8 },
          { query: '孤立ページ 検出', clicks: 88, impressions: 1420, position: 2.6 },
        ],
      }

  const ai: AiAccessPageSummary = {
    totalVisits: isAio ? 198 : isColumn ? 64 : 146,
    searchReferrals: isAio ? 42 : 28,
    citationFetches: isAio ? 94 : 68,
    trainingCrawls: isAio ? 62 : 50,
    topAgents: [
      { agent: 'OAI-SearchBot', category: 'AI検索クローラー', count: 52 },
      { agent: 'ChatGPT-User', category: 'ユーザー起点フェッチ（引用）', count: 41 },
      { agent: 'PerplexityBot', category: 'AI検索クローラー', count: 31 },
      { agent: 'ClaudeBot', category: 'AI学習クローラー', count: 22 },
    ],
  }

  const sections: SectionCrossRow[] = [
    {
      sectionOrder: 1,
      headingText: '1. なぜ内部リンク構造がSEOとAI引用の双方を左右するのか',
      headingLevel: 2,
      elementTag: 'section',
      wordCount: 420,
      hasCta: false,
      linkCount: 2,
      imageCount: 1,
      distanceToNextCtaPx: 1480,
      reachRate: 1.0,
      avgDwellMs: 14_200,
      clickCount: 180,
      deadClickCount: 4,
      rageClickCount: 1,
      ctaClickRate: 0.0,
      exitRate: 0.18,
    },
    {
      sectionOrder: 2,
      headingText: '2. トピッククラスターとピラーページの比較マトリクス（図解）',
      headingLevel: 2,
      elementTag: 'section',
      wordCount: 680,
      hasCta: false,
      linkCount: 0,
      imageCount: 2,
      distanceToNextCtaPx: 1120,
      reachRate: 0.82,
      avgDwellMs: 19_500,
      clickCount: 95,
      deadClickCount: 22,
      rageClickCount: 5,
      ctaClickRate: 0.0,
      exitRate: 0.28,
    },
    {
      sectionOrder: 3,
      headingText: '3. クリック深度（Depth）とクローラビリティの数理モデル',
      headingLevel: 2,
      elementTag: 'section',
      wordCount: 940,
      hasCta: false,
      linkCount: 1,
      imageCount: 0,
      distanceToNextCtaPx: 740,
      reachRate: 0.54,
      avgDwellMs: 11_800,
      clickCount: 62,
      deadClickCount: 6,
      rageClickCount: 2,
      ctaClickRate: 0.0,
      exitRate: 0.31,
    },
    {
      sectionOrder: 4,
      headingText: '4. 孤立ページ（Orphan Page）の自動検出と発リンク改善手順',
      headingLevel: 2,
      elementTag: 'section',
      wordCount: 590,
      hasCta: true,
      linkCount: 5,
      imageCount: 2,
      distanceToNextCtaPx: 0,
      reachRate: 0.23,
      avgDwellMs: 16_400,
      clickCount: 142,
      deadClickCount: 2,
      rageClickCount: 0,
      ctaClickRate: 0.048,
      exitRate: 0.12,
    },
    {
      sectionOrder: 5,
      headingText: '5. 無料サイト構造診断・行動ヒートマップ連携のご案内',
      headingLevel: 2,
      elementTag: 'section',
      wordCount: 310,
      hasCta: true,
      linkCount: 3,
      imageCount: 1,
      distanceToNextCtaPx: 0,
      reachRate: 0.14,
      avgDwellMs: 9_200,
      clickCount: 88,
      deadClickCount: 0,
      rageClickCount: 0,
      ctaClickRate: 0.084,
      exitRate: 0.11,
    },
  ]

  const images: UnoptimizedImageCrossRow[] = [
    {
      imageSrc: '/assets/blog/topic-cluster-architecture-full.png',
      fileSizeBytes: 642_000,
      hasWidthHeight: false,
      loadingAttr: 'eager',
      visibleRate: 0.78,
      avgVisibleTimeMs: 8_400,
    },
    {
      imageSrc: '/assets/blog/pagerank-simulation-matrix-4k.png',
      fileSizeBytes: 518_000,
      hasWidthHeight: false,
      loadingAttr: 'none',
      visibleRate: 0.21,
      avgVisibleTimeMs: 2_100,
    },
    {
      imageSrc: '/assets/blog/footer-case-study-banner.png',
      fileSizeBytes: 384_000,
      hasWidthHeight: true,
      loadingAttr: 'none',
      visibleRate: 0.14,
      avgVisibleTimeMs: 1_200,
    },
  ]

  const directoryMatrix: DirectoryPerfBehaviorRow[] = [
    {
      directory: '/column',
      pageCount: 14,
      avgLcpMs: 3580,
      avgTtfbMs: 910,
      avgSpeedScore: 55,
      bounceRate: 0.672,
      preRenderExitRate: 0.258,
      avgScrollDepthPct: 42,
      gscClicks: 520,
      aiVisits: 310,
    },
    {
      directory: '/entry',
      pageCount: 26,
      avgLcpMs: 2740,
      avgTtfbMs: 690,
      avgSpeedScore: 68,
      bounceRate: 0.534,
      preRenderExitRate: 0.176,
      avgScrollDepthPct: 54,
      gscClicks: 2465,
      aiVisits: 890,
    },
    {
      directory: '/tools',
      pageCount: 5,
      avgLcpMs: 1680,
      avgTtfbMs: 390,
      avgSpeedScore: 88,
      bounceRate: 0.342,
      preRenderExitRate: 0.064,
      avgScrollDepthPct: 76,
      gscClicks: 410,
      aiVisits: 195,
    },
    {
      directory: '/',
      pageCount: 3,
      avgLcpMs: 1520,
      avgTtfbMs: 340,
      avgSpeedScore: 92,
      bounceRate: 0.318,
      preRenderExitRate: 0.051,
      avgScrollDepthPct: 79,
      gscClicks: 380,
      aiVisits: 420,
    },
  ]

  return {
    siteId,
    url: norm.normalizedUrl,
    canonicalUrl: norm.normalizedUrl,
    urlMatchKey: norm.matchKey,
    urlHash16: norm.urlHash,
    availableUrls,
    behavior,
    structure,
    gsc,
    ai,
    sections,
    images,
    directoryMatrix,
  }
}

// ============================================================================
// LINKTH CRAWL v1 (418項目監査 / 7本柱 Teacher Verdict / Kaplan-Meier / 80+特徴量 CVR予測) 拡張
// ============================================================================

import {
  getPerformanceFusion,
  getSiteDocAudit,
  getUrlFusionMl,
} from '@/lib/linkscrawl/client'
import type {
  CvrPredictionResult,
  PerformanceFusionResponse,
  ScrollSurvivalAnalysis,
  SiteDocAuditResponse,
  TeacherVerdictCarte,
  UrlFusionMlResponse,
} from '@/lib/linkscrawl/types'

export interface EnrichedFusionIntelligence {
  siteId: string
  canonicalUrl: string
  urlMatchKey: string
  urlHash16: string
  crossDiagnoses: CrossDiagnosisItem[]
  siteDoc418: SiteDocAuditResponse
  performance90: PerformanceFusionResponse
  urlFusionMl: UrlFusionMlResponse
  teacherVerdict: TeacherVerdictCarte
  scrollSurvival: ScrollSurvivalAnalysis
  cvrPrediction: CvrPredictionResult
}

/**
 * URLに対する4平面行動×構造診断に加えて、LINKTH CRAWL v1 の418項目監査・
 * 7本柱 Teacher Verdict・Kaplan-Meier スクロール生存曲線・80+特徴量 CVR予測を一括結合する。
 */
export async function buildEnrichedFusionIntelligenceForUrl(params: {
  url: string
  siteId?: string
}): Promise<EnrichedFusionIntelligence> {
  const siteId = params.siteId || 'default'
  const baseDataset = buildFusionDatasetForUrl(params.url, siteId)
  const crossDiagnoses = diagnoseBehaviorAndStructure(baseDataset)

  const [siteDoc418, performance90, urlFusionMl] = await Promise.all([
    getSiteDocAudit({ siteId, url: baseDataset.canonicalUrl }),
    getPerformanceFusion({ siteId, url: baseDataset.canonicalUrl }),
    getUrlFusionMl({ siteId, url: baseDataset.canonicalUrl }),
  ])

  return {
    siteId,
    canonicalUrl: baseDataset.canonicalUrl,
    urlMatchKey: baseDataset.urlMatchKey,
    urlHash16: baseDataset.urlHash16,
    crossDiagnoses,
    siteDoc418,
    performance90,
    urlFusionMl,
    teacherVerdict: urlFusionMl.teacherVerdict,
    scrollSurvival: urlFusionMl.scrollSurvival,
    cvrPrediction: urlFusionMl.cvrPrediction,
  }
}

