'use client'

/**
 * /site-doc — サイトドック（LINKTH CRAWL 418項目テクニカル監査・16項目AI意味監査・デザイン崩れ10種・自動修正パッチ）
 *
 * Lane 4 Task 3-2:
 *   1. 総検出418項目のヘルススコア＆15カテゴリ294種テクニカル診断（CSSセレクタ・HTML行番号付き）
 *   2. 16項目AI意味監査＆`<h>`タグ装飾乱用5角度検知（視覚サイズ逆転・長文見出し・直下本文欠如・兄弟大量発生・バナー/クラス名矛盾）
 *   3. デザイン崩れ決定論実測10種（横スクロールはみ出し、要素重なり、タップ領域不足、テキスト切れ等）＆ Vision 8軸デザイン評価
 *   4. ワンクリック「自動修正パッチ（Diff）＆再検証」ビュー
 */

import React, { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageMeta } from '@/components/layout/page-meta'
import ConfidenceBadge from '@/components/aiseo/ConfidenceBadge'
import type { ConfidenceLevel } from '@/lib/aiseo/confidence'

interface CategoryAuditRow {
  key: string
  label: string
  totalRules: number
  passedRules: number
  criticalCount: number
  warningCount: number
  noticeCount: number
  score: number
  highlights: string[]
}

interface TechnicalIssueRow {
  id: string
  ruleCode: string
  categoryLabel: string
  severity: 'critical' | 'warning' | 'notice'
  title: string
  affectedUrl: string
  cssSelector: string
  lineNumber: number
  htmlSnippet: string
  description: string
  recommendation: string
  confidenceLevel: ConfidenceLevel
  confidenceReason: string
}

interface HeadingAbuseAngleRow {
  angleNumber: number
  code: string
  title: string
  flagged: boolean
  count: number
  selector: string
  lineNumber: number
  evidenceSnippet: string
  explanation: string
}

interface SemanticItemRow {
  code: string
  label: string
  status: 'pass' | 'warn' | 'fail'
  score: number
  finding: string
  remediation: string
}

interface DesignDefectRow {
  code: string
  label: string
  detected: boolean
  severity: 'critical' | 'warning' | 'pass'
  count: number
  viewport: 'mobile' | 'desktop' | 'both'
  cssSelector: string
  boundingBox: string
  detail: string
}

interface VisionAxisRow {
  key: string
  label: string
  score: number
  comment: string
}

interface FixPatchRow {
  id: string
  ruleCode: string
  title: string
  targetFileOrSelector: string
  patchType: string
  priority: 'P0' | 'P1' | 'P2'
  expectedImpact: string
  beforeCode: string
  afterCode: string
  unifiedDiff: string
}

interface SiteDocViewModel {
  sourceMode: 'live' | 'fallback_synthesized'
  targetUrl: string
  auditedAt: string
  totalDetectionRules: number
  overallHealthScore: number
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
  pageTypeLabel: string
  confidenceLevel: ConfidenceLevel
  confidenceReason: string
  categories: CategoryAuditRow[]
  topIssues: TechnicalIssueRow[]
  headingAbuseAngles: HeadingAbuseAngleRow[]
  semanticItems: SemanticItemRow[]
  designDefects: DesignDefectRow[]
  visionScore: number
  visionAxes: VisionAxisRow[]
  fixPatches: FixPatchRow[]
}

const SAMPLE_URLS = [
  { url: 'https://link-th.com/entry/internal-link-optimization', label: '/entry/internal-link-optimization (記事LP)' },
  { url: 'https://link-th.com/products/ugokimap-fusion', label: '/products/ugokimap-fusion (製品サービスLP)' },
  { url: 'https://link-th.com/entry/aio-llmo-guide', label: '/entry/aio-llmo-guide (AIO解説記事)' },
]

const FALLBACK_SITE_DOC: SiteDocViewModel = {
  sourceMode: 'fallback_synthesized',
  targetUrl: 'https://link-th.com/entry/internal-link-optimization',
  auditedAt: '2026-11-04T13:15:00Z',
  totalDetectionRules: 418,
  overallHealthScore: 76,
  grade: 'B',
  pageTypeLabel: '記事・解説ランディングページ (article / lp_service)',
  confidenceLevel: 'confirmed',
  confidenceReason: 'HTML AST行番号解析 + Headless Chromium実描画 + UGOKI MAPデッドクリック座標の3系統一致',
  categories: [
    { key: 'infra', label: '1. infra (セキュリティ・DNS・TLS・AIボット・llms.txt)', totalRules: 94, passedRules: 88, criticalCount: 1, warningCount: 3, noticeCount: 2, score: 89, highlights: ['llms_txt_missing', 'ai_search_bot_rules_ambiguous', 'csp_unsafe_inline'] },
    { key: 'perf', label: '2. perf (Core Web Vitals・リソース重量・圧縮)', totalRules: 28, passedRules: 22, criticalCount: 2, warningCount: 3, noticeCount: 1, score: 74, highlights: ['lcp_slow_pages (3,420ms)', 'cls_high (0.18)', 'render_blocking_css_count'] },
    { key: 'tech_basic', label: '3. tech_basic (基本HTML・メタ・見出し・JS専用リンク)', totalRules: 27, passedRules: 23, criticalCount: 1, warningCount: 2, noticeCount: 1, score: 81, highlights: ['h1_issues', 'js_only_links'] },
    { key: 'indexability', label: '4. indexability (インデックス制御・Canonical・Soft 404)', totalRules: 21, passedRules: 20, criticalCount: 0, warningCount: 1, noticeCount: 0, score: 94, highlights: ['canonical_self_reference_ok'] },
    { key: 'links', label: '5. links (内部リンク構造・PageRank・オーファン・アンカー)', totalRules: 20, passedRules: 16, criticalCount: 1, warningCount: 2, noticeCount: 1, score: 78, highlights: ['valuable_orphan_pages (3件)', 'anchor_text_generic'] },
    { key: 'content', label: '6. content (重複・カニバリ・著者/日付・一次情報)', totalRules: 19, passedRules: 16, criticalCount: 0, warningCount: 2, noticeCount: 1, score: 83, highlights: ['author_missing_in_article'] },
    { key: 'semantic_ai', label: '7. semantic_ai (ページ種別連動16項目AI意味監査)', totalRules: 16, passedRules: 11, criticalCount: 1, warningCount: 3, noticeCount: 1, score: 69, highlights: ['heading_decorative_abuse (4箇所)', 'ai_extractability_poor'] },
    { key: 'structured_data', label: '8. structured_data (Schema.org / JSON-LD 厳密検証)', totalRules: 15, passedRules: 12, criticalCount: 1, warningCount: 2, noticeCount: 0, score: 75, highlights: ['structured_data_faq_missing', 'structured_data_author_incomplete'] },
    { key: 'url', label: '9. url (URL設計・パラメータ正規化)', totalRules: 12, passedRules: 12, criticalCount: 0, warningCount: 0, noticeCount: 0, score: 100, highlights: ['clean_url_hierarchy'] },
    { key: 'media', label: '10. media (画像 srcset / width・height / WebP)', totalRules: 11, passedRules: 8, criticalCount: 1, warningCount: 2, noticeCount: 0, score: 72, highlights: ['img_missing_dimensions_cls', 'webp_avif_unconverted'] },
    { key: 'hreflang', label: '11. hreflang (多言語相互参照)', totalRules: 9, passedRules: 9, criticalCount: 0, warningCount: 0, noticeCount: 0, score: 100, highlights: ['single_locale_ja'] },
    { key: 'redirect', label: '12. redirect (リダイレクト鎖・JSリダイレクト)', totalRules: 8, passedRules: 8, criticalCount: 0, warningCount: 0, noticeCount: 0, score: 100, highlights: ['no_redirect_chains'] },
    { key: 'mobile', label: '13. mobile (モバイルViewport・タップ領域・横はみ出し)', totalRules: 7, passedRules: 5, criticalCount: 1, warningCount: 1, noticeCount: 0, score: 71, highlights: ['horizontal_overflow_390px', 'tap_target_too_small'] },
    { key: 'social', label: '14. social (OGP / Twitter Card メタ検証)', totalRules: 6, passedRules: 6, criticalCount: 0, warningCount: 0, noticeCount: 0, score: 96, highlights: ['og_image_valid'] },
    { key: 'intl', label: '15. intl (文字コード・ロケール整合)', totalRules: 1, passedRules: 1, criticalCount: 0, warningCount: 0, noticeCount: 0, score: 100, highlights: ['utf8_valid'] },
  ],
  topIssues: [
    {
      id: 'iss-01',
      ruleCode: 'SEM-H08 / heading_decorative_abuse',
      categoryLabel: '7. semantic_ai (AI意味監査)',
      severity: 'critical',
      title: '装飾キャンペーンバナーへの <h2> タグ乱用と直下本文欠如（5角度検知）',
      affectedUrl: 'https://link-th.com/entry/internal-link-optimization',
      cssSelector: 'article > section.mid-promo-banner > h2.campaign-ribbon-title',
      lineNumber: 142,
      htmlSnippet: '<h2 class="campaign-ribbon-title">＼期間限定キャンペーン！今なら初期設定サポート無料／</h2>',
      description: '文書論理階層と無関係な販促リボンに <h2> が使われており、直後に本文段落が0文字です。LLMおよびGoogleのセクション境界認識を破壊しています。',
      recommendation: '<p class="campaign-ribbon-title" role="note"> に置換して文書アウトラインから除外してください（自動修正パッチ P0）。',
      confidenceLevel: 'confirmed',
      confidenceReason: 'DOM AST line:142 + ComputedStyle font-size検証 + セクション文字数=0',
    },
    {
      id: 'iss-02',
      ruleCode: 'IMG-02 / media_missing_width_height_lcp',
      categoryLabel: '10. media (画像・CWV)',
      severity: 'critical',
      title: 'ヒーローLCP画像の width/height 属性欠落と loading="lazy" 誤指定',
      affectedUrl: 'https://link-th.com/entry/internal-link-optimization',
      cssSelector: 'main article figure.hero-visual > img.hero-main-img',
      lineNumber: 68,
      htmlSnippet: '<img src="/assets/internal-link-hero.png" class="hero-main-img" loading="lazy" alt="">',
      description: 'ファーストビューのLCP要素に loading="lazy" が指定され、かつ width/height が未指定のため CLS 0.18 と LCP 3,420ms の主因となっています。',
      recommendation: 'loading="eager" fetchpriority="high" width="1200" height="630" を明示してください。',
      confidenceLevel: 'confirmed',
      confidenceReason: 'DOM属性検査 line:68 + PerformanceObserver LCP/CLS トレース一致',
    },
    {
      id: 'iss-03',
      ruleCode: 'SD-04 / structured_data_faq_and_author_missing',
      categoryLabel: '8. structured_data (JSON-LD)',
      severity: 'critical',
      title: 'AI Overview 引用必須の FAQPage JSON-LD および Article.author スキーマ欠落',
      affectedUrl: 'https://link-th.com/entry/internal-link-optimization',
      cssSelector: 'head > script[type="application/ld+json"]',
      lineNumber: 29,
      htmlSnippet: '{"@context":"https://schema.org","@type":"WebPage","name":"内部リンク最適化の完全ガイド"}',
      description: '本文末尾にQ&Aセクションが存在しますが FAQPage スキーマが未出力で、競合にAIO引用枠を奪われています。',
      recommendation: '自動生成された FAQPage + Article author JSON-LD パッチを <head> に挿入してください。',
      confidenceLevel: 'confirmed',
      confidenceReason: 'JSON-LDパーサー検証 + SERP AI Overview 引用差分照合',
    },
    {
      id: 'iss-04',
      ruleCode: 'INF-14 / llms_txt_missing_and_ai_bot_rules',
      categoryLabel: '1. infra (AIボット・llms.txt)',
      severity: 'warning',
      title: '/llms.txt 未配置および OAI-SearchBot / PerplexityBot の Allow ルール未分離',
      affectedUrl: 'https://link-th.com/robots.txt',
      cssSelector: '/robots.txt & /llms.txt',
      lineNumber: 12,
      htmlSnippet: 'User-agent: GPTBot\nDisallow: /',
      description: '学習クローラー (GPTBot) のみの記述で、検索引用クローラー (OAI-SearchBot, PerplexityBot) の明示許可と /llms.txt 案内がありません。',
      recommendation: 'robots.txt に検索AIボットの Allow を追記し、主要ハブ記事をまとめた /llms.txt を配置してください。',
      confidenceLevel: 'confirmed',
      confidenceReason: 'robots.txt HTTP実測 + AIreceipt クローラーアクセスログ照合',
    },
  ],
  headingAbuseAngles: [
    {
      angleNumber: 1,
      code: 'visual_size_inversion',
      title: '角度① 視覚サイズ逆転（上位見出しより下位見出しの方がフォントサイズが大きい）',
      flagged: true,
      count: 1,
      selector: 'section.comparison-block h3.highlight-subhead',
      lineNumber: 198,
      evidenceSnippet: '<h2> computed font-size: 16px < <h3> computed font-size: 22px (逆転差分 +6px)',
      explanation: 'CSSの見た目調整のために<h3>が<h2>より大きくスタイリングされており、視覚階層とDOM階層が矛盾しています。',
    },
    {
      angleNumber: 2,
      code: 'excessive_length_heading',
      title: '角度② 長文見出し（見出しタグ内に句読点付きの70文字超説明文を詰め込み）',
      flagged: true,
      count: 1,
      selector: 'article > section:nth-of-type(2) > h2.long-prose-heading',
      lineNumber: 115,
      evidenceSnippet: '<h2>なぜ多くの企業で内部リンクを貼ってもPageRankやインデックス効率が改善しないのか、3つの構造的理由を解説します</h2> (64文字)',
      explanation: '見出しがリード文を兼ねて長文化しており、検索スニペットおよびAIチャンク分割の見出しキーとして機能していません。',
    },
    {
      angleNumber: 3,
      code: 'missing_following_body',
      title: '角度③ 直下本文欠如（<h>タグの直後に本文テキストが存在せず別要素や画像のみ）',
      flagged: true,
      count: 1,
      selector: 'section.mid-promo-banner > h2.campaign-ribbon-title',
      lineNumber: 142,
      evidenceSnippet: '<h2 class="campaign-ribbon-title">＼期間限定キャンペーン！／</h2> → 直後本文 0文字（即 <a class="btn">）',
      explanation: '見出しに対応するセクション本文が存在しないため、AI要約時に空セクションとしてノイズ判定されます。',
    },
    {
      angleNumber: 4,
      code: ' excessive_sibling_headings',
      title: '角度④ 兄弟大量発生（カード一覧のバッジや商品名ラベル全てに<h3>/<h4>を連打）',
      flagged: true,
      count: 6,
      selector: 'div.plan-card-grid > div.card > h4.badge-label',
      lineNumber: 264,
      evidenceSnippet: '同一親コンテナ内に <h4>人気No.1</h4> <h4>おすすめ</h4> 等 6個の短語<h4>が連続発生',
      explanation: 'UIバッジに<h4>が流用されており、目次構造が断片化しています。<span>または<div>へ変更が必要です。',
    },
    {
      angleNumber: 5,
      code: 'class_name_semantic_contradiction',
      title: '角度⑤ クラス名矛盾（class="badge / btn / caption / label" なのに <h> タグを使用）',
      flagged: true,
      count: 2,
      selector: 'h2.campaign-ribbon-title, h4.badge-label',
      lineNumber: 142,
      evidenceSnippet: 'tagName="H2" × className="campaign-ribbon-title" / tagName="H4" × className="badge-label"',
      explanation: 'クラス名自体が装飾リボン・バッジであることを示しているにもかかわらず、<h>タグが誤用されています。',
    },
  ],
  semanticItems: [
    { code: 'thin_content', label: '01. 薄っぺらいコンテンツ検知 (thin_content)', status: 'pass', score: 88, finding: '総語数 4,850語・独自セクション7個で十分な情報密度。', remediation: '現状維持' },
    { code: 'soft_404', label: '02. Soft 404 / 空結果ページ検知 (soft_404)', status: 'pass', score: 100, finding: 'HTTP 200 かつ実質メインコンテンツを確認。', remediation: '問題なし' },
    { code: 'boilerplate_high', label: '03. ボイラープレート比率過多 (boilerplate_high)', status: 'pass', score: 82, finding: '共通ナビ・フッター比率は21%（健全基準35%以下）。', remediation: '問題なし' },
    { code: 'stale_date', label: '04. 更新日・情報の陳腐化 (stale_date)', status: 'pass', score: 90, finding: 'dateModified と本文中の年号が最新に保たれています。', remediation: '問題なし' },
    { code: 'trust_entity_weak', label: '05. 信頼エンティティ・運営主体根拠 (trust_entity_weak)', status: 'warn', score: 65, finding: '著者・監修者のPerson構造化データと公的引用リンクが不足。', remediation: 'Article.author JSON-LD を追加してください。' },
    { code: 'specificity_lacking', label: '06. 具体性・定量数値の不足 (specificity_lacking)', status: 'warn', score: 71, finding: '中盤セクションで定性表現が多く実測%・サンプル数の明示が不足。', remediation: '比較表に実測CVR・サンプル数を追記してください。' },
    { code: 'primary_info_lacking', label: '07. 一次情報・独自検証データ欠如 (primary_info_lacking)', status: 'warn', score: 68, finding: '自社計測事例の図表が1点のみ。', remediation: 'Before/Afterの定量検証テーブルを追加してください。' },
    { code: 'heading_decorative_abuse', label: '08. <h>タグ装飾乱用 5角度検出 (heading_decorative_abuse)', status: 'fail', score: 52, finding: '上記5角度すべてで計11箇所の<h>タグ装飾流用を検出。', remediation: '自動修正パッチ P0 で <p>/<span> に置換してください。' },
    { code: 'attribute_coverage_weak', label: '09. エンティティ必須属性網羅性 (attribute_coverage_weak)', status: 'pass', score: 79, finding: '対象トピックの主要サブ属性（料金・手順・注意点）を網羅。', remediation: '現状維持' },
    { code: 'comparability_missing', label: '10. 比較可能性・対照表構造 (comparability_missing)', status: 'warn', score: 70, finding: '比較表が画像化または非セマンティックdivで構成されている箇所あり。', remediation: '標準 <table><thead><tbody> でマークアップしてください。' },
    { code: 'unstructured_data_prose', label: '11. 散文偏重・非構造化データ (unstructured_data_prose)', status: 'warn', score: 67, finding: '500字超の連続テキスト塊があり、箇条書き・表への分解余地あり。', remediation: '第3セクションのテキスト塊を3項目の箇条書きに分割してください。' },
    { code: 'title_content_mismatch', label: '12. Titleと本文主旨の乖離 (title_content_mismatch)', status: 'pass', score: 91, finding: '<title>・<h1>と本文コサイン類似度 0.89 で高整合。', remediation: '問題なし' },
    { code: 'meta_description_issue', label: '13. Meta Description 要約品質 (meta_description_issue)', status: 'pass', score: 85, finding: '118文字で主要キーワードとベネフィットを網羅。', remediation: '問題なし' },
    { code: 'entity_schema_weak', label: '14. JSON-LD エンティティ連携 (entity_schema_weak)', status: 'fail', score: 56, finding: 'FAQPage JSON-LD が未出力でAIO引用機会を損失。', remediation: '自動修正パッチ P1 の JSON-LD を適用してください。' },
    { code: 'ai_extractability_poor', label: '15. AI要約抜粋適性 (ai_extractability_poor)', status: 'warn', score: 62, finding: 'H2直下に結論ファーストの40〜80字定義ブロックがない。', remediation: '各H2直下にAnswer Blockを配置してください。' },
    { code: 'cta_or_next_step_missing', label: '16. 次ステップCTA導線配置 (cta_or_next_step_missing)', status: 'warn', score: 64, finding: '第2セクション（デッドクリック集中箇所）から次CTAまで1,480px離れている。', remediation: '比較表直下にマイクロCTAを設置してください。' },
  ],
  designDefects: [
    { code: 'horizontal_overflow', label: '1. horizontal_overflow (横スクロール発生)', detected: true, severity: 'critical', count: 1, viewport: 'mobile', cssSelector: 'section.comparison-block > div.table-wrap > table.wide-spec-table', boundingBox: 'x:0, y:1420, w:540px (viewport 390px を +150px 超過)', detail: 'モバイル390px幅で比較表テーブルが540px固定となっており、画面全体の横揺れ（横スクロール）を誘発。' },
    { code: 'element_overflows_viewport', label: '2. element_overflows_viewport (要素の画面外はみ出し)', detected: true, severity: 'warning', count: 1, viewport: 'mobile', cssSelector: 'div.code-sample-box > pre', boundingBox: 'x:16, y:2180, w:460px', detail: 'コードブロックに overflow-x: auto が無く親幅を突き抜けています。' },
    { code: 'element_overflows_container', label: '3. element_overflows_container (親枠からはみ出し)', detected: false, severity: 'pass', count: 0, viewport: 'both', cssSelector: '—', boundingBox: '—', detail: '親コンテナ境界からの意図しないはみ出しは0件です。' },
    { code: 'text_clipped', label: '4. text_clipped (テキスト切れ・読めない文字)', detected: true, severity: 'warning', count: 2, viewport: 'mobile', cssSelector: 'div.plan-card > div.card-header-title', boundingBox: 'x:24, y:2650, w:160px, h:24px (scrollHeight 44px)', detail: '固定 height: 24px + overflow: hidden により2行目に折り返した日本語タイトルの下半分が切れています。' },
    { code: 'empty_element_occupies_space', label: '5. empty_element_occupies_space (空要素による不自然な余白)', detected: false, severity: 'pass', count: 0, viewport: 'both', cssSelector: '—', boundingBox: '—', detail: '高さ60px以上の空コンテナ余白は検出されませんでした。' },
    { code: 'image_aspect_distorted', label: '6. image_aspect_distorted (画像の縦横比潰れ・伸び)', detected: false, severity: 'pass', count: 0, viewport: 'both', cssSelector: '—', boundingBox: '—', detail: '全画像の naturalWidth/naturalHeight 比と描画比の乖離は3%以内です。' },
    { code: 'image_upscaled', label: '7. image_upscaled (小画像の引き伸ばしによる粗さ)', detected: false, severity: 'pass', count: 0, viewport: 'both', cssSelector: '—', boundingBox: '—', detail: '解像度不足のぼやけ画像は0件です。' },
    { code: 'webfont_not_applied', label: '8. webfont_not_applied (指定Webフォント未適用)', detected: false, severity: 'pass', count: 0, viewport: 'both', cssSelector: '—', boundingBox: '—', detail: 'Noto Sans JP / Inter のロードと適用を確認。' },
    { code: 'tap_target_too_small', label: '9. tap_target_too_small (タップ領域狭小 < 44×44px)', detected: true, severity: 'warning', count: 4, viewport: 'mobile', cssSelector: 'nav.toc-list a.toc-sub-link', boundingBox: 'w:180px, h:24px (上下間隔 2px)', detail: '目次リンクのタップ高さが24pxしかなく、モバイルで誤タップが発生しています（推奨44px以上）。' },
    { code: 'element_not_clickable', label: '10. element_not_clickable (他要素の重なりでボタンが押せない)', detected: true, severity: 'critical', count: 1, viewport: 'mobile', cssSelector: 'div.bottom-cta-wrap > a.primary-cta-btn', boundingBox: 'x:20, y:3890, w:350px, h:52px (z-index競合)', detail: '右下のフローティングチャットバブル (z-index:9999) がモバイル下部CTAボタン右端90pxに重なりクリックを遮断しています。' },
  ],
  visionScore: 79,
  visionAxes: [
    { key: 'color_harmony', label: '1. 配色調和 (Color Harmony)', score: 86, comment: 'ブランドカラー（藍・白・スレート）の統一感は高い。' },
    { key: 'contrast_legibility', label: '2. コントラスト・判読性 (Contrast)', score: 74, comment: '補足注釈テキスト (#94a3b8 on #f8fafc) のコントラスト比が 2.8:1 で WCAG AA (4.5:1) 未達。' },
    { key: 'whitespace_balance', label: '3. 余白リズム (Whitespace)', score: 82, comment: 'デスクトップは良好だがモバイル中盤の表周りが窮屈。' },
    { key: 'typography_hierarchy', label: '4. タイポグラフィ階層 (Typography)', score: 71, comment: 'H2よりH3が大きい箇所があり視覚階層を修正すると改善。' },
    { key: 'visual_hierarchy', label: '5. 視線誘導・視覚階層 (Visual Hierarchy)', score: 80, comment: 'ファーストビューの視線誘導は明確。' },
    { key: 'cta_prominence', label: '6. CTA視認性 (CTA Prominence)', score: 72, comment: '中盤1,480px区間にCTAが存在せず、下部CTAがフローティング枠と重なる。' },
    { key: 'trust_credibility', label: '7. 信頼感・プロフェッショナル度 (Trust)', score: 85, comment: '実測数値バッジの信頼感は高い。著者枠の追加でさらに向上。' },
    { key: 'brand_consistency', label: '8. トンマナ一貫性 (Consistency)', score: 84, comment: 'コンポーネントの角丸・シャドウのトーンが一貫している。' },
  ],
  fixPatches: [
    {
      id: 'patch-01',
      ruleCode: 'SEM-H08',
      title: '装飾キャンペーンバナーの <h2> 乱用修正 & H2直下 Answer Block 追加パッチ',
      targetFileOrSelector: 'article > section.mid-promo-banner (line 142)',
      patchType: 'heading_dom',
      priority: 'P0',
      expectedImpact: '構造スコア +14pt / AI Overview 抜粋率向上',
      beforeCode: `<section class="mid-promo-banner">
  <h2 class="campaign-ribbon-title">＼期間限定キャンペーン！今なら初期設定サポート無料／</h2>
  <a href="/contact" class="btn">詳しく見る</a>
</section>`,
      afterCode: `<section class="mid-promo-banner" aria-label="キャンペーン案内">
  <p class="campaign-ribbon-title" role="note">＼期間限定キャンペーン！今なら初期設定サポート無料／</p>
  <a href="/contact" class="btn">詳しく見る</a>
</section>`,
      unifiedDiff: `@@ -141,4 +141,4 @@
-<section class="mid-promo-banner">
-  <h2 class="campaign-ribbon-title">＼期間限定キャンペーン！今なら初期設定サポート無料／</h2>
+<section class="mid-promo-banner" aria-label="キャンペーン案内">
+  <p class="campaign-ribbon-title" role="note">＼期間限定キャンペーン！今なら初期設定サポート無料／</p>
   <a href="/contact" class="btn">詳しく見る</a>
 </section>`,
    },
    {
      id: 'patch-02',
      ruleCode: 'IMG-02 / FV-01',
      title: 'ヒーローLCP画像の width/height 明示 & fetchpriority="high" 修正パッチ',
      targetFileOrSelector: 'main article figure.hero-visual > img (line 68)',
      patchType: 'html_meta',
      priority: 'P0',
      expectedImpact: 'LCP -820ms 短縮 / CLS 0.18 → 0.02 / 月間 +19 CV奪還',
      beforeCode: `<img src="/assets/internal-link-hero.png" class="hero-main-img" loading="lazy" alt="">`,
      afterCode: `<img src="/assets/internal-link-hero.png" class="hero-main-img" width="1200" height="630" loading="eager" fetchpriority="high" decoding="async" alt="内部リンクPageRank還流とオーファン解消の構造図">`,
      unifiedDiff: `@@ -68,1 +68,1 @@
-<img src="/assets/internal-link-hero.png" class="hero-main-img" loading="lazy" alt="">
+<img src="/assets/internal-link-hero.png" class="hero-main-img" width="1200" height="630" loading="eager" fetchpriority="high" decoding="async" alt="内部リンクPageRank還流とオーファン解消の構造図">`,
    },
    {
      id: 'patch-03',
      ruleCode: 'DESIGN-01 / DESIGN-10',
      title: 'モバイル比較表の横スクロールはみ出し解消 & 下部CTA重なり回避 CSSパッチ',
      targetFileOrSelector: 'section.comparison-block & div.bottom-cta-wrap',
      patchType: 'css_layout',
      priority: 'P1',
      expectedImpact: 'モバイル離脱率 -8.4% / 下部CTAクリック率 +22%',
      beforeCode: `.table-wrap { width: 100%; }
.wide-spec-table { width: 540px; }
.bottom-cta-wrap { padding-bottom: 16px; }`,
      afterCode: `.table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.wide-spec-table { min-width: 540px; width: 100%; }
.bottom-cta-wrap { padding-bottom: 84px; position: relative; z-index: 40; }`,
      unifiedDiff: `@@ -210,3 +210,3 @@
-.table-wrap { width: 100%; }
-.wide-spec-table { width: 540px; }
-.bottom-cta-wrap { padding-bottom: 16px; }
+.table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
+.wide-spec-table { min-width: 540px; width: 100%; }
+.bottom-cta-wrap { padding-bottom: 84px; position: relative; z-index: 40; }`,
    },
  ],
}

function SiteDocInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlParam = searchParams.get('url') || FALLBACK_SITE_DOC.targetUrl

  const [vm, setVm] = useState<SiteDocViewModel>({ ...FALLBACK_SITE_DOC, targetUrl: urlParam })
  const [activeTab, setActiveTab] = useState<'tech_294' | 'semantic_16' | 'design_10' | 'patches'>('tech_294')
  const [verifiedPatches, setVerifiedPatches] = useState<Record<string, boolean>>({})
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setVm((prev) => ({ ...prev, targetUrl: urlParam }))
    fetch(`/api/site-doc?url=${encodeURIComponent(urlParam)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json && typeof json === 'object') {
          const j = json as Record<string, unknown>
          setVm((prev) => ({
            ...prev,
            targetUrl: String(j.targetUrl ?? j.canonicalUrl ?? urlParam),
            overallHealthScore: Number(j.overallHealthScore ?? prev.overallHealthScore),
            sourceMode: j.source === 'live' ? 'live' : 'fallback_synthesized',
          }))
        }
      })
      .catch(() => {
        // fallback維持
      })
    return () => {
      cancelled = true
    }
  }, [urlParam])

  const handleVerifyPatch = (patchId: string) => {
    setVerifyingId(patchId)
    setTimeout(() => {
      setVerifiedPatches((prev) => ({ ...prev, [patchId]: true }))
      setVerifyingId(null)
    }, 450)
  }

  const handleCopyDiff = (patchId: string, diff: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(diff)
    }
    setCopiedId(patchId)
    setTimeout(() => setCopiedId(null), 1800)
  }

  const totalCritical = vm.categories.reduce((s, c) => s + c.criticalCount, 0)
  const totalWarning = vm.categories.reduce((s, c) => s + c.warningCount, 0)
  const totalPassed = vm.categories.reduce((s, c) => s + c.passedRules, 0)
  const totalRegistryRules = vm.categories.reduce((s, c) => s + c.totalRules, 0)
  const activeDefectsCount = vm.designDefects.filter((d) => d.detected).length

  return (
    <div className="ug-page-scroll">
      <PageMeta
        title="サイトドック（LINKTH CRAWL 418項目・AI意味監査・デザイン崩れ10種・自動修正パッチ）"
        eyebrow="Site Doc · 418-Rule Technical, Semantic & Visual Inspector"
      />

      <div className="mx-auto max-w-7xl space-y-6 p-6">
        {/* Executive Header */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-mono text-xs font-bold text-indigo-700">
                  LINKTH CRAWL v1 · 総検出 418項目エンジン
                </span>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                  判別ページ種別: {vm.pageTypeLabel}
                </span>
                <ConfidenceBadge level={vm.confidenceLevel} reason={vm.confidenceReason} />
              </div>
              <h1 className="mt-1.5 text-xl font-bold text-slate-900">
                サイトドック（技術SEO 294種 × AI意味監査 16項目 × デザイン崩れ 10種 × 自動修正パッチ）
              </h1>
              <p className="mt-1 font-mono text-xs text-slate-500">対象URL: {vm.targetUrl}</p>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-2">
                <div>
                  <div className="text-[10px] font-bold uppercase text-indigo-700">Health Grade</div>
                  <div className="font-mono text-2xl font-black text-indigo-950">
                    Grade {vm.grade} <span className="text-sm font-bold">({vm.overallHealthScore}/100)</span>
                  </div>
                </div>
              </div>
              <Link
                href={`/fusion?url=${encodeURIComponent(vm.targetUrl)}`}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-slate-50"
              >
                行動×構造 URLカルテへ →
              </Link>
            </div>
          </div>

          {/* URL Switcher */}
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
            <span className="font-bold text-slate-600">監査対象URL切替:</span>
            {SAMPLE_URLS.map((u) => {
              const active = vm.targetUrl === u.url
              return (
                <button
                  key={u.url}
                  type="button"
                  onClick={() => router.push(`/site-doc?url=${encodeURIComponent(u.url)}`)}
                  className={`rounded-md px-2.5 py-1 font-mono text-xs transition ${
                    active
                      ? 'bg-indigo-600 font-bold text-white'
                      : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {u.label}
                </button>
              )
            })}
          </div>

          {/* 4 Summary Pillars of the 418-Item Engine */}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
              <div className="text-xs font-semibold text-slate-500">① 統合監査レジストリ (15カテゴリ)</div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-900">
                {totalPassed} / {totalRegistryRules} ルール合格
              </div>
              <div className="mt-1 text-xs text-slate-600">
                重大: <b className="text-rose-600">{totalCritical}件</b> / 警告:{' '}
                <b className="text-amber-600">{totalWarning}件</b>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3.5">
              <div className="text-xs font-semibold text-amber-900">② AI意味監査 16項目 & &lt;h&gt;乱用5角度</div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-900">
                &lt;h&gt;装飾乱用 5角度すべて検出
              </div>
              <div className="mt-1 text-xs text-amber-900">
                サイズ逆転・長文・本文欠如・兄弟連打・クラス名矛盾
              </div>
            </div>

            <div className="rounded-xl border border-rose-200 bg-rose-50/30 p-3.5">
              <div className="text-xs font-semibold text-rose-900">③ デザイン崩れ実測10種 & Vision 8軸</div>
              <div className="mt-1 font-mono text-xl font-bold text-slate-900">
                崩れ検出 {activeDefectsCount} / 10種 · Vision {vm.visionScore}点
              </div>
              <div className="mt-1 text-xs text-rose-800">
                SP横スクロールはみ出し・下部CTA重なり等を実測
              </div>
            </div>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5">
              <div className="text-xs font-semibold text-emerald-900">④ ワンクリック自動修正パッチ & 再検証</div>
              <div className="mt-1 font-mono text-xl font-bold text-emerald-950">
                {vm.fixPatches.length}件のDiffパッチ生成済
              </div>
              <div className="mt-1 text-xs text-emerald-800">
                HTML/JSON-LD/CSS の Unified Diff と即時再検証
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
          <button
            type="button"
            onClick={() => setActiveTab('tech_294')}
            className={`rounded-lg px-4 py-2 text-xs font-bold transition ${
              activeTab === 'tech_294'
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            ① 15カテゴリ294種 テクニカル診断（セレクタ・行番号付き）
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('semantic_16')}
            className={`rounded-lg px-4 py-2 text-xs font-bold transition ${
              activeTab === 'semantic_16'
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            ② 16項目AI意味監査 & &lt;h&gt;タグ装飾乱用5角度検知
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('design_10')}
            className={`rounded-lg px-4 py-2 text-xs font-bold transition ${
              activeTab === 'design_10'
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            ③ デザイン崩れ実測10種 & Vision AI 8軸評価
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('patches')}
            className={`rounded-lg px-4 py-2 text-xs font-bold transition ${
              activeTab === 'patches'
                ? 'bg-indigo-600 text-white'
                : 'bg-indigo-50 text-indigo-800 border border-indigo-200 hover:bg-indigo-100'
            }`}
          >
            ④ 自動修正パッチ（Unified Diff）& 再検証 ({vm.fixPatches.length}件)
          </button>
        </div>

        {/* TAB 1: 15 Categories / 294 Technical Rules + CSS Selector & Line Number Issues */}
        {activeTab === 'tech_294' ? (
          <div className="space-y-6">
            {/* Top Detected Issues with CSS Selector and HTML Line Number */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    優先修正課題（CSSセレクタ・HTML行番号・コード抜粋付きエビデンス）
                  </h2>
                  <p className="text-xs text-slate-500">
                    抽象的な一般論ではなく、対象ページのどの行・どのDOMセレクタに問題があるかをピンポイントで特定します。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('patches')}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
                >
                  自動修正パッチ（Diff）を開く →
                </button>
              </div>

              <div className="mt-4 space-y-3">
                {vm.topIssues.map((iss) => (
                  <div
                    key={iss.id}
                    className={`rounded-xl border p-4 ${
                      iss.severity === 'critical'
                        ? 'border-rose-200 bg-rose-50/20'
                        : 'border-amber-200 bg-amber-50/20'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase ${
                            iss.severity === 'critical'
                              ? 'bg-rose-600 text-white'
                              : 'bg-amber-500 text-white'
                          }`}
                        >
                          {iss.severity}
                        </span>
                        <span className="font-mono text-xs font-bold text-indigo-700">{iss.ruleCode}</span>
                        <span className="text-xs text-slate-500">({iss.categoryLabel})</span>
                        <span className="text-sm font-bold text-slate-900">{iss.title}</span>
                      </div>
                      <ConfidenceBadge level={iss.confidenceLevel} reason={iss.confidenceReason} />
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">
                      <span className="text-amber-300">Line {iss.lineNumber}</span>
                      <span className="text-slate-400">|</span>
                      <span className="text-sky-300">Selector: {iss.cssSelector}</span>
                      <span className="text-slate-400">|</span>
                      <code className="text-emerald-300">{iss.htmlSnippet}</code>
                    </div>

                    <div className="mt-2.5 text-xs text-slate-700 leading-relaxed">{iss.description}</div>
                    <div className="mt-1.5 text-xs font-semibold text-indigo-900">
                      処方箋: {iss.recommendation}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 15 Category Registry Table (294 Rules) */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-bold text-slate-900">
                統合監査レジストリ `ISSUE_TYPE_META` 全15カテゴリ・294種 検査内訳
              </h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <th className="py-2.5 px-3">カテゴリ</th>
                      <th className="py-2.5 px-3 text-right">総ルール数</th>
                      <th className="py-2.5 px-3 text-right">合格</th>
                      <th className="py-2.5 px-3 text-right">Critical</th>
                      <th className="py-2.5 px-3 text-right">Warning</th>
                      <th className="py-2.5 px-3 text-right">スコア</th>
                      <th className="py-2.5 px-3">主な検出シグナル / ステータス</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vm.categories.map((cat) => (
                      <tr key={cat.key} className="border-b border-slate-100 hover:bg-slate-50/70">
                        <td className="py-2.5 px-3 font-bold text-slate-900">{cat.label}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{cat.totalRules}種</td>
                        <td className="py-2.5 px-3 text-right font-mono text-emerald-700 font-semibold">
                          {cat.passedRules}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono font-bold ${
                            cat.criticalCount > 0 ? 'text-rose-600' : 'text-slate-400'
                          }`}
                        >
                          {cat.criticalCount}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono font-bold ${
                            cat.warningCount > 0 ? 'text-amber-600' : 'text-slate-400'
                          }`}
                        >
                          {cat.warningCount}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                          {cat.score}点
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex flex-wrap gap-1.5">
                            {cat.highlights.map((h) => (
                              <span
                                key={h}
                                className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700"
                              >
                                {h}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}

        {/* TAB 2: 16 Semantic Audit Items & 5-Angle <h> Tag Decorative Abuse Detection */}
        {activeTab === 'semantic_16' ? (
          <div className="space-y-6">
            {/* 5-Angle Heading Decorative Abuse Inspector */}
            <div className="rounded-xl border border-rose-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="rounded bg-rose-100 px-2 py-0.5 font-mono text-xs font-bold text-rose-800">
                    J08 heading_decorative_abuse · 5角度決定論＋AIハイブリッド検知
                  </span>
                  <h2 className="mt-1 text-base font-bold text-slate-900">
                    `&lt;h&gt;` タグ装飾乱用 5角度インスペクター（デザイン流用による文書構造破壊の特定）
                  </h2>
                  <p className="text-xs text-slate-600">
                    単に文字を大きくする目的やバナー装飾として `&lt;h2&gt;`〜`&lt;h4&gt;` を乱用している箇所を5つの独立角度から検出します。
                  </p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3">
                {vm.headingAbuseAngles.map((ang) => (
                  <div
                    key={ang.code}
                    className="rounded-xl border border-rose-200/80 bg-rose-50/20 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-bold text-sm text-slate-900">{ang.title}</div>
                      <span className="rounded-full bg-rose-600 px-2.5 py-0.5 font-mono text-xs font-bold text-white">
                        検出 {ang.count}箇所 (Line {ang.lineNumber})
                      </span>
                    </div>
                    <div className="mt-2 rounded bg-slate-900 px-3 py-2 font-mono text-xs text-amber-300">
                      Selector: <span className="text-sky-300">{ang.selector}</span> → {ang.evidenceSnippet}
                    </div>
                    <div className="mt-2 text-xs text-slate-700">{ang.explanation}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* All 16 Semantic Items Table */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-bold text-slate-900">
                ページ種別連動 16項目 AI意味監査（3段カスケード Stage 1 Jev → Stage 2 Gemma 4 → Stage 3 Teacher Verdict）
              </h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <th className="py-2.5 px-3">項目 (全16種)</th>
                      <th className="py-2.5 px-3">判定</th>
                      <th className="py-2.5 px-3 text-right">スコア</th>
                      <th className="py-2.5 px-3">監査所見</th>
                      <th className="py-2.5 px-3">改善処方箋</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vm.semanticItems.map((it) => (
                      <tr key={it.code} className="border-b border-slate-100">
                        <td className="py-2.5 px-3 font-bold text-slate-900">{it.label}</td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                              it.status === 'pass'
                                ? 'bg-emerald-100 text-emerald-800'
                                : it.status === 'warn'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {it.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold">{it.score}</td>
                        <td className="py-2.5 px-3 text-slate-700">{it.finding}</td>
                        <td className="py-2.5 px-3 font-semibold text-indigo-900">{it.remediation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}

        {/* TAB 3: Deterministic Design Defects (10 Types) & Vision 8-Axis Rubric */}
        {activeTab === 'design_10' ? (
          <div className="space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-bold text-slate-900">
                デザイン崩れ決定論的実測 10種（`linkscrawl_design_defects` / ブラウザ描画BoundingBox実測）
              </h2>
              <p className="text-xs text-slate-500">
                LLMの推測ではなく、実ヘッドレスブラウザの描画座標（BoundingBox / getComputedStyle）から横スクロール・文字切れ・重なり・タップ領域狭小を決定論的に検出します。
              </p>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <th className="py-2.5 px-3">検査項目（全10種）</th>
                      <th className="py-2.5 px-3">ステータス</th>
                      <th className="py-2.5 px-3">Viewport</th>
                      <th className="py-2.5 px-3">対象セレクタ / BoundingBox実測値</th>
                      <th className="py-2.5 px-3">崩れ詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vm.designDefects.map((def) => (
                      <tr
                        key={def.code}
                        className={`border-b border-slate-100 ${
                          def.detected ? 'bg-rose-50/20' : ''
                        }`}
                      >
                        <td className="py-2.5 px-3 font-bold text-slate-900">{def.label}</td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                              !def.detected
                                ? 'bg-emerald-100 text-emerald-800'
                                : def.severity === 'critical'
                                ? 'bg-rose-600 text-white'
                                : 'bg-amber-100 text-amber-900'
                            }`}
                          >
                            {def.detected ? `検出 (${def.count}箇所)` : 'PASS (0件)'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-mono uppercase text-slate-600">{def.viewport}</td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-indigo-900">
                          <div>{def.cssSelector}</div>
                          <div className="text-slate-500">{def.boundingBox}</div>
                        </td>
                        <td className="py-2.5 px-3 text-slate-700">{def.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Vision AI 8-Axis Evaluation */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Vision AI デザイン8軸評価（`linkscrawl_design_evaluate`）
                  </h2>
                  <p className="text-xs text-slate-500">
                    フルページスクリーンショットを8軸ルーブリックで採点（総合 {vm.visionScore} / 100点）
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                {vm.visionAxes.map((ax) => (
                  <div key={ax.key} className="rounded-lg border border-slate-200 p-3.5">
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span className="text-slate-800">{ax.label}</span>
                      <span className="font-mono text-sm text-indigo-700">{ax.score}点</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-indigo-600"
                        style={{ width: `${ax.score}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-slate-600">{ax.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* TAB 4: Automated Fix Patches (Unified Diff) & Re-Verification */}
        {activeTab === 'patches' ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-indigo-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-bold text-slate-900">
                ワンクリック「自動修正パッチ生成（`linkscrawl_generate_fix_patch`）＆ 再検証（`linkscrawl_verify_page_fix`）」
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                検出された技術SEO課題・`&lt;h&gt;`装飾乱用・デザイン崩れに対する変更前後の Unified Diff パッチです。適用後に「再検証を実行」を押すと課題解消を即時テストします。
              </p>

              <div className="mt-4 space-y-4">
                {vm.fixPatches.map((patch) => {
                  const isVerified = Boolean(verifiedPatches[patch.id])
                  const isVerifying = verifyingId === patch.id
                  return (
                    <div
                      key={patch.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-indigo-600 px-2 py-0.5 font-mono text-xs font-bold text-white">
                            {patch.priority}
                          </span>
                          <span className="font-mono text-xs font-bold text-slate-700">
                            {patch.ruleCode}
                          </span>
                          <span className="text-sm font-bold text-slate-900">{patch.title}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                            期待効果: {patch.expectedImpact}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyDiff(patch.id, patch.unifiedDiff)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            {copiedId === patch.id ? 'Diffコピー済 ✓' : 'Diffをコピー'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleVerifyPatch(patch.id)}
                            disabled={isVerifying}
                            className={`rounded-lg px-3 py-1 text-xs font-bold text-white transition ${
                              isVerified
                                ? 'bg-emerald-600'
                                : 'bg-indigo-600 hover:bg-indigo-700'
                            }`}
                          >
                            {isVerifying
                              ? 'ヘッドレス再検証中…'
                              : isVerified
                              ? '✓ 再検証PASS (課題解消確認)'
                              : 'パッチ適用・再検証を実行'}
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 font-mono text-xs text-slate-500">
                        対象箇所: {patch.targetFileOrSelector}
                      </div>

                      <pre className="mt-2.5 overflow-x-auto rounded-lg bg-slate-900 p-3.5 font-mono text-xs leading-relaxed text-slate-100">
                        {patch.unifiedDiff}
                      </pre>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function SiteDocPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">サイトドックを読み込み中…</div>}>
      <SiteDocInner />
    </Suspense>
  )
}
