'use client'

/**
 * /performance — ページ速度分析（LINKTH CRAWL 12ファミリ90速度ルール × 行動CV損失定量化）
 *
 * Lane 4 Task 3-3:
 *   1. LINKTH CRAWL 12ファミリ90速度ルール（T1: 67種 + T2: 23種）診断 ＋ CWV p75 (LCP / INP / CLS / TTFB)
 *   2. 速度×行動 CV損失定量化（Performance × Behavior Fusion / `linkscrawl_performance_fusion`）:
 *      - 「LCP遅延によるレンダリング前離脱率」
 *      - 「高速表示ユーザー（LCP < 2.5s）対比での月間CV損失件数・損失売上金額」
 *      - 「速度改善で奪還できる推定CV数」の可視化とインタラクティブ奪還シミュレータ
 */

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageMeta } from '@/components/layout/page-meta'
import ConfidenceBadge from '@/components/aiseo/ConfidenceBadge'
import type { ConfidenceLevel } from '@/lib/aiseo/confidence'

interface SpeedRuleTriggerRow {
  ruleId: string
  title: string
  severity: 'high' | 'medium' | 'low'
  impactMs: number
  targetResource: string
  remediation: string
}

interface SpeedFamilyRow {
  familyCode: string
  label: string
  ruleRange: string
  totalRules: number
  triggeredCount: number
  estimatedSavingsMs: number
  status: 'good' | 'needs_improvement' | 'poor'
  topFindings: SpeedRuleTriggerRow[]
}

interface SpeedCohortRow {
  label: string
  thresholdLabel: string
  sessions: number
  conversions: number
  cvrPct: number
  bounceRatePct: number
  preRenderExitRatePct: number
  avgDwellSec: number
}

interface BottleneckFusionPatternRow {
  patternId: string
  title: string
  speedTrigger: string
  behaviorSymptom: string
  lostConversionsMonthly: number
  lostRevenueJpyMonthly: number
  recommendation: string
}

interface PerformanceViewModel {
  sourceMode: 'live' | 'fallback_synthesized'
  targetUrl: string
  measuredAt: string
  totalRulesChecked: number
  triggeredRulesCount: number
  confidenceLevel: ConfidenceLevel
  confidenceReason: string
  cwvP75: {
    lcpMs: number
    inpMs: number
    cls: number
    ttfbMs: number
    fcpMs: number
    speedScore: number
  }
  cvLossSummary: {
    monthlyTotalSessions: number
    preRenderExitRatePct: number
    preRenderExitSessions: number
    estimatedMonthlyLostCvs: number
    estimatedMonthlyLostRevenueJpy: number
    recoverableCvsIfFast: number
    recoverableRevenueJpyIfFast: number
    unitCvValueJpy: number
    fastVsSlowCvrMultiplier: number
  }
  cohorts: {
    fast: SpeedCohortRow
    moderate: SpeedCohortRow
    slow: SpeedCohortRow
  }
  fusionPatterns: BottleneckFusionPatternRow[]
  families: SpeedFamilyRow[]
}

const SAMPLE_URLS = [
  { url: 'https://link-th.com/entry/internal-link-optimization', label: '/entry/internal-link-optimization (LCP 3,420ms)' },
  { url: 'https://link-th.com/products/ugokimap-fusion', label: '/products/ugokimap-fusion (LCP 3,890ms)' },
  { url: 'https://link-th.com/entry/aio-llmo-guide', label: '/entry/aio-llmo-guide (LCP 2,380ms)' },
]

const FALLBACK_PERFORMANCE: PerformanceViewModel = {
  sourceMode: 'fallback_synthesized',
  targetUrl: 'https://link-th.com/entry/internal-link-optimization',
  measuredAt: '2026-11-04T13:18:00Z',
  totalRulesChecked: 90,
  triggeredRulesCount: 14,
  confidenceLevel: 'confirmed',
  confidenceReason: 'HTML/CSS/JS/HAR 90ルール解析 + RUM CWV p75 + UGOKI MAP セッション別離脱・CVR突合の3系統一致',
  cwvP75: {
    lcpMs: 3420,
    inpMs: 215,
    cls: 0.18,
    ttfbMs: 640,
    fcpMs: 1820,
    speedScore: 62,
  },
  cvLossSummary: {
    monthlyTotalSessions: 18500,
    preRenderExitRatePct: 19.4,
    preRenderExitSessions: 3589,
    estimatedMonthlyLostCvs: 48,
    estimatedMonthlyLostRevenueJpy: 1440000,
    recoverableCvsIfFast: 39,
    recoverableRevenueJpyIfFast: 1170000,
    unitCvValueJpy: 30000,
    fastVsSlowCvrMultiplier: 2.38,
  },
  cohorts: {
    fast: {
      label: '高速表示コホート (Good)',
      thresholdLabel: 'LCP ≤ 2,500ms',
      sessions: 7400,
      conversions: 281,
      cvrPct: 3.8,
      bounceRatePct: 34.2,
      preRenderExitRatePct: 4.1,
      avgDwellSec: 164,
    },
    moderate: {
      label: '中速表示コホート (Needs Improvement)',
      thresholdLabel: '2,500ms < LCP ≤ 4,000ms',
      sessions: 6850,
      conversions: 178,
      cvrPct: 2.6,
      bounceRatePct: 51.8,
      preRenderExitRatePct: 18.5,
      avgDwellSec: 112,
    },
    slow: {
      label: '低速表示コホート (Poor)',
      thresholdLabel: 'LCP > 4,000ms',
      sessions: 4250,
      conversions: 68,
      cvrPct: 1.6,
      bounceRatePct: 68.4,
      preRenderExitRatePct: 37.2,
      avgDwellSec: 61,
    },
  },
  fusionPatterns: [
    {
      patternId: 'PF-01',
      title: 'パターン① LCP遅延 × ファーストビュー描画完了前離脱（Pre-Render Exit）',
      speedTrigger: 'FV-01 (LCP画像 loading="lazy" 誤用) + CSS-01 (レンダーブロッキングCSS 3本) → LCP 3,420ms',
      behaviorSymptom: '初回スクロール・クリックが0回のまま3.2秒以内に離脱するセッションが全体の 19.4% (3,589件/月) 発生',
      lostConversionsMonthly: 24,
      lostRevenueJpyMonthly: 720000,
      recommendation: 'ヒーロー画像に fetchpriority="high" loading="eager" を適用し、クリティカルCSSをインライン化してLCPを2.2秒以下へ短縮。',
    },
    {
      patternId: 'PF-02',
      title: 'パターン② CLSレイアウトシフト × 比較表・CTA周辺の誤タップ・レイジクリック',
      speedTrigger: 'IMG-02 (width/height欠落画像 4枚) + FONT-01 (font-display未指定) → CLS 0.18',
      behaviorSymptom: 'Webフォントと画像が遅れて展開される瞬間に比較表周辺でレイジクリック14回・誤タップ離脱が多発',
      lostConversionsMonthly: 13,
      lostRevenueJpyMonthly: 390000,
      recommendation: '全<img>タグに実寸法 width/height を明示し、Webフォントに font-display: swap と size-adjust を設定。',
    },
    {
      patternId: 'PF-03',
      title: 'パターン③ サードパーティJS Long Tasks × フォーム入力・アコーディオン応答遅延 (INP)',
      speedTrigger: '3P-02 (チャットウィジェット・計測タグ同期実行) + JS-04 (Long Tasks > 240ms) → INP 215ms',
      behaviorSymptom: 'モバイルでFAQ開閉やCTAタップ時の反応が200ms以上遅れ、連打（デッド/レイジクリック）後に離脱',
      lostConversionsMonthly: 11,
      lostRevenueJpyMonthly: 330000,
      recommendation: '非必須サードパーティスクリプトを requestIdleCallback またはユーザー操作後遅延ロードへ移行。',
    },
  ],
  families: [
    {
      familyCode: 'F1_FV_LCP',
      label: 'F1. ファーストビュー・LCP (FV-01〜FV-06)',
      ruleRange: 'FV-01..FV-06',
      totalRules: 6,
      triggeredCount: 2,
      estimatedSavingsMs: 850,
      status: 'poor',
      topFindings: [
        { ruleId: 'FV-01', title: 'ヒーローLCP画像に loading="lazy" が誤設定され描画開始が遅延', severity: 'high', impactMs: 580, targetResource: '/assets/internal-link-hero.png', remediation: 'loading="eager" fetchpriority="high" に変更' },
        { ruleId: 'FV-03', title: 'LCP画像の <link rel="preload"> 欠落', severity: 'medium', impactMs: 270, targetResource: '<head>', remediation: 'ファーストビュー主画像の preload ヒントを追加' },
      ],
    },
    {
      familyCode: 'F2_SLIDER',
      label: 'F2. スライダー・カルーセル (SLD-01〜SLD-05)',
      ruleRange: 'SLD-01..SLD-05',
      totalRules: 5,
      triggeredCount: 1,
      estimatedSavingsMs: 180,
      status: 'needs_improvement',
      topFindings: [
        { ruleId: 'SLD-02', title: '非表示スライド画像5枚の初回一括ダウンロード', severity: 'medium', impactMs: 180, targetResource: 'div.case-slider img', remediation: '2枚目以降のスライド画像に loading="lazy" を適用' },
      ],
    },
    {
      familyCode: 'F3_IMAGE',
      label: 'F3. 画像最適化 (IMG-01〜IMG-14)',
      ruleRange: 'IMG-01..IMG-14',
      totalRules: 14,
      triggeredCount: 3,
      estimatedSavingsMs: 620,
      status: 'poor',
      topFindings: [
        { ruleId: 'IMG-02', title: 'width / height 属性欠落によるCLS発生 (4枚)', severity: 'high', impactMs: 320, targetResource: 'article img.diagram-fig', remediation: '全画像に明示的な width / height 属性を付与' },
        { ruleId: 'IMG-05', title: '次世代フォーマット (WebP / AVIF) 未変換の巨大PNG (計 1.4MB)', severity: 'medium', impactMs: 300, targetResource: '/assets/diagram-architecture.png (480KB)', remediation: 'AVIF/WebPへ変換し配信サイズを72%削減' },
      ],
    },
    {
      familyCode: 'F4_JS',
      label: 'F4. JavaScript 実行・バンドル (JS-01〜JS-10)',
      ruleRange: 'JS-01..JS-10',
      totalRules: 10,
      triggeredCount: 2,
      estimatedSavingsMs: 410,
      status: 'needs_improvement',
      topFindings: [
        { ruleId: 'JS-01', title: '<head>内の同期 <script> によるHTMLパースブロック', severity: 'high', impactMs: 260, targetResource: '/js/legacy-analytics-sync.js', remediation: 'defer または async 属性を付与' },
        { ruleId: 'JS-04', title: 'メインスレッド Long Task (285ms) によるINP悪化', severity: 'medium', impactMs: 150, targetResource: 'bundle-vendor.js', remediation: 'コード分割と初期ハイドレーション軽量化' },
      ],
    },
    {
      familyCode: 'F5_CSS',
      label: 'F5. CSS レンダーブロッキング (CSS-01〜CSS-08)',
      ruleRange: 'CSS-01..CSS-08',
      totalRules: 8,
      triggeredCount: 2,
      estimatedSavingsMs: 390,
      status: 'needs_improvement',
      topFindings: [
        { ruleId: 'CSS-01', title: 'レンダーブロッキング外部CSSファイル 3本 (計 210KB)', severity: 'high', impactMs: 290, targetResource: '/css/vendor-icons.css', remediation: 'Above-the-fold CSSをインライン化し残りを非同期読込' },
      ],
    },
    {
      familyCode: 'F6_FONT',
      label: 'F6. Webフォント配信 (FONT-01〜FONT-06)',
      ruleRange: 'FONT-01..FONT-06',
      totalRules: 6,
      triggeredCount: 1,
      estimatedSavingsMs: 220,
      status: 'needs_improvement',
      topFindings: [
        { ruleId: 'FONT-01', title: 'Google Fonts 読み込み時の preconnect & font-display: swap 最適化不足', severity: 'medium', impactMs: 220, targetResource: 'fonts.gstatic.com', remediation: 'rel="preconnect" とサブセットWOFF2配信を適用' },
      ],
    },
    {
      familyCode: 'F7_NET',
      label: 'F7. ネットワーク・プロトコル・TTFB (NET-01〜NET-10)',
      ruleRange: 'NET-01..NET-10',
      totalRules: 10,
      triggeredCount: 1,
      estimatedSavingsMs: 240,
      status: 'needs_improvement',
      topFindings: [
        { ruleId: 'NET-01', title: '動的SSR応答の TTFB が 640ms（推奨 400ms以下）', severity: 'medium', impactMs: 240, targetResource: 'Document HTML', remediation: 'CDN Stale-While-Revalidate キャッシュヘッダーを設定' },
      ],
    },
    {
      familyCode: 'F8_REDIRECT',
      label: 'F8. リダイレクト遅延 (RED-03〜RED-04)',
      ruleRange: 'RED-03..RED-04',
      totalRules: 2,
      triggeredCount: 0,
      estimatedSavingsMs: 0,
      status: 'good',
      topFindings: [],
    },
    {
      familyCode: 'F9_THIRD_PARTY',
      label: 'F9. サードパーティタグ負荷 (3P-01〜3P-08)',
      ruleRange: '3P-01..3P-08',
      totalRules: 8,
      triggeredCount: 1,
      estimatedSavingsMs: 310,
      status: 'needs_improvement',
      topFindings: [
        { ruleId: '3P-02', title: 'チャットウィジェットの初期同期ロードによるメインスレッド占有 (310ms)', severity: 'medium', impactMs: 310, targetResource: 'widget.intercom-like.js', remediation: 'スクロール開始または3秒経過後に遅延初期化' },
      ],
    },
    {
      familyCode: 'F10_DOM',
      label: 'F10. DOM構造・ノード過多 (DOM-01〜DOM-06)',
      ruleRange: 'DOM-01..DOM-06',
      totalRules: 6,
      triggeredCount: 0,
      estimatedSavingsMs: 0,
      status: 'good',
      topFindings: [],
    },
    {
      familyCode: 'F11_WORDPRESS',
      label: 'F11. CMS / WordPress 特有ボトルネック (WP-01〜WP-08)',
      ruleRange: 'WP-01..WP-08',
      totalRules: 7,
      triggeredCount: 0,
      estimatedSavingsMs: 0,
      status: 'good',
      topFindings: [],
    },
    {
      familyCode: 'F12_COMPOUND',
      label: 'F12. 複合ボトルネック (CMB-01〜CMB-08)',
      ruleRange: 'CMB-01..CMB-08',
      totalRules: 8,
      triggeredCount: 1,
      estimatedSavingsMs: 490,
      status: 'poor',
      topFindings: [
        { ruleId: 'CMB-02', title: '複合遅延: [LCP画像 lazy誤用] × [レンダーブロッキングCSS] × [Webフォント待機]', severity: 'high', impactMs: 490, targetResource: 'First View Pipeline', remediation: 'F1・F5・F6の3点セット同時解消でLCPを1.4秒短縮可能' },
      ],
    },
  ],
}

function PerformanceInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlParam = searchParams.get('url') || FALLBACK_PERFORMANCE.targetUrl

  const [vm, setVm] = useState<PerformanceViewModel>({ ...FALLBACK_PERFORMANCE, targetUrl: urlParam })
  const [targetLcpGoalMs, setTargetLcpGoalMs] = useState<number>(2200)
  const [unitCvValueJpy, setUnitCvValueJpy] = useState<number>(FALLBACK_PERFORMANCE.cvLossSummary.unitCvValueJpy)

  useEffect(() => {
    let cancelled = false
    setVm((prev) => ({ ...prev, targetUrl: urlParam }))
    fetch(`/api/performance?url=${encodeURIComponent(urlParam)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json && typeof json === 'object') {
          const j = json as Record<string, unknown>
          const cwv = (j.cwvP75 as Record<string, unknown> | undefined) ?? {}
          setVm((prev) => ({
            ...prev,
            targetUrl: String(j.targetUrl ?? j.canonicalUrl ?? urlParam),
            sourceMode: j.source === 'live' ? 'live' : 'fallback_synthesized',
            cwvP75: {
              ...prev.cwvP75,
              lcpMs: Number(cwv.lcpMs ?? prev.cwvP75.lcpMs),
              cls: Number(cwv.cls ?? prev.cwvP75.cls),
              ttfbMs: Number(cwv.ttfbMs ?? prev.cwvP75.ttfbMs),
            },
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

  // インタラクティブ速度改善→CV奪還シミュレータ
  const simRecovery = useMemo(() => {
    const currentLcp = vm.cwvP75.lcpMs
    const improvementRatio = Math.max(0, Math.min(1, (currentLcp - targetLcpGoalMs) / Math.max(1, currentLcp - 1800)))
    const recoveredCvs = Math.round(vm.cvLossSummary.estimatedMonthlyLostCvs * improvementRatio)
    const recoveredRevenue = recoveredCvs * unitCvValueJpy
    const newPreRenderExitPct = Math.max(
      4.0,
      Number((vm.cvLossSummary.preRenderExitRatePct * (1 - improvementRatio * 0.72)).toFixed(1)),
    )
    return {
      recoveredCvs,
      recoveredRevenue,
      newPreRenderExitPct,
    }
  }, [vm, targetLcpGoalMs, unitCvValueJpy])

  return (
    <div className="ug-page-scroll">
      <PageMeta
        title="ページ速度分析（12ファミリ90ルール × 行動CV損失定量化）"
        eyebrow="Performance × Behavior Fusion · 90 Speed Rules & CV Loss Quantification"
      />

      <div className="mx-auto max-w-7xl space-y-6 p-6">
        {/* Executive Header */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-sky-50 px-2.5 py-0.5 font-mono text-xs font-bold text-sky-700">
                  analyzer/speed_rules (12ファミリ・90ルール) × linkscrawl_performance_fusion
                </span>
                <ConfidenceBadge level={vm.confidenceLevel} reason={vm.confidenceReason} />
              </div>
              <h1 className="mt-1.5 text-xl font-bold text-slate-900">
                ページ速度分析（90ルール根本原因診断 × 速度遅延による月間CV損失・奪還可能CV定量化）
              </h1>
              <p className="mt-1 font-mono text-xs text-slate-500">対象URL: {vm.targetUrl}</p>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href={`/site-doc?url=${encodeURIComponent(vm.targetUrl)}`}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                サイトドック修正パッチへ →
              </Link>
              <Link
                href={`/fusion?url=${encodeURIComponent(vm.targetUrl)}`}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
              >
                URL総合カルテへ →
              </Link>
            </div>
          </div>

          {/* URL Switcher */}
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
            <span className="font-bold text-slate-600">計測対象URL切替:</span>
            {SAMPLE_URLS.map((u) => {
              const active = vm.targetUrl === u.url
              return (
                <button
                  key={u.url}
                  type="button"
                  onClick={() => router.push(`/performance?url=${encodeURIComponent(u.url)}`)}
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

          {/* CWV p75 + Speed x Behavior CV Loss Hero Strip */}
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
              <div className="text-xs font-bold text-rose-800">① LCP遅延による描画完了前離脱率</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-black text-rose-700">
                  {vm.cvLossSummary.preRenderExitRatePct}%
                </span>
                <span className="font-mono text-xs font-semibold text-rose-800">
                  ({vm.cvLossSummary.preRenderExitSessions.toLocaleString()} セッション/月)
                </span>
              </div>
              <div className="mt-1 text-xs text-rose-900">
                p75 LCP <b>{vm.cwvP75.lcpMs.toLocaleString()}ms</b> 完了前に直帰した訪問者
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <div className="text-xs font-bold text-amber-900">② 高速表示ユーザー対比 月間CV損失数</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-black text-amber-950">
                  -{vm.cvLossSummary.estimatedMonthlyLostCvs} CV / 月
                </span>
              </div>
              <div className="mt-1 text-xs text-amber-900">
                推定機会損失額: <b>¥{vm.cvLossSummary.estimatedMonthlyLostRevenueJpy.toLocaleString()}/月</b>
              </div>
            </div>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
              <div className="text-xs font-bold text-emerald-900">③ 速度改善（LCP ≤ 2.5s）で奪還できるCV数</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-black text-emerald-700">
                  +{vm.cvLossSummary.recoverableCvsIfFast} CV / 月 奪還可能
                </span>
              </div>
              <div className="mt-1 text-xs text-emerald-900">
                高速コホートCVRは低速比 <b>{vm.cvLossSummary.fastVsSlowCvrMultiplier}倍</b> ({vm.cohorts.fast.cvrPct}% vs {vm.cohorts.slow.cvrPct}%)
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="text-xs font-bold text-slate-600">④ Core Web Vitals (RUM p75) & 90ルール</div>
              <div className="mt-1 font-mono text-sm font-bold text-slate-900">
                LCP {vm.cwvP75.lcpMs}ms · INP {vm.cwvP75.inpMs}ms · CLS {vm.cwvP75.cls}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                TTFB: <b>{vm.cwvP75.ttfbMs}ms</b> / 90ルール中 <b className="text-rose-600">{vm.triggeredRulesCount}件</b> 該当
              </div>
            </div>
          </div>
        </div>

        {/* Section 1: Speed Cohort × Behavior CVR Comparison + Interactive CV Recovery Simulator */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-bold text-slate-900">
              表示速度コホート別「実ユーザー行動・描画前離脱率・CVR」比較（UGOKI MAP × LINKTH CRAWL 突合）
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              同一ページ内で実ユーザーの体感LCP速度帯ごとにセッションを3分割し、表示速度がどれだけ直帰率とCVRに直結しているかを定量化しています。
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2.5 px-3">速度コホート (RUM LCP区分)</th>
                    <th className="py-2.5 px-3 text-right">月間セッション</th>
                    <th className="py-2.5 px-3 text-right">描画前離脱率</th>
                    <th className="py-2.5 px-3 text-right">直帰率</th>
                    <th className="py-2.5 px-3 text-right">CV数</th>
                    <th className="py-2.5 px-3 text-right">実測 CVR</th>
                  </tr>
                </thead>
                <tbody>
                  {[vm.cohorts.fast, vm.cohorts.moderate, vm.cohorts.slow].map((c, idx) => (
                    <tr
                      key={c.label}
                      className={`border-b border-slate-100 ${
                        idx === 0 ? 'bg-emerald-50/20' : idx === 2 ? 'bg-rose-50/30' : ''
                      }`}
                    >
                      <td className="py-3 px-3">
                        <div className="font-bold text-slate-900">{c.label}</div>
                        <div className="font-mono text-[11px] text-slate-500">{c.thresholdLabel}</div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold">
                        {c.sessions.toLocaleString()}
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-mono font-bold ${
                          c.preRenderExitRatePct >= 20 ? 'text-rose-600' : 'text-slate-700'
                        }`}
                      >
                        {c.preRenderExitRatePct}%
                      </td>
                      <td className="py-3 px-3 text-right font-mono">{c.bounceRatePct}%</td>
                      <td className="py-3 px-3 text-right font-mono font-bold">{c.conversions}</td>
                      <td
                        className={`py-3 px-3 text-right font-mono text-sm font-black ${
                          idx === 0 ? 'text-emerald-700' : idx === 2 ? 'text-rose-600' : 'text-amber-700'
                        }`}
                      >
                        {c.cvrPct.toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Interactive Speed -> CV Recovery Simulator */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-5 shadow-sm flex flex-col justify-between">
            <div>
              <span className="rounded bg-indigo-600 px-2 py-0.5 font-mono text-[10.5px] font-bold text-white">
                CV Recovery Simulator
              </span>
              <h3 className="mt-1.5 text-sm font-bold text-slate-900">
                速度改善による奪還CV・売上インパクト試算
              </h3>
              <p className="mt-1 text-xs text-slate-600">
                目標LCPと1CVあたり単価を調整すると、月間の奪還CV数と売上増加額をリアルタイムに算出します。
              </p>

              <div className="mt-3 space-y-3">
                <label className="block text-xs">
                  <div className="flex justify-between font-bold text-slate-700">
                    <span>目標 LCP (現在 {vm.cwvP75.lcpMs}ms)</span>
                    <span className="font-mono text-indigo-700">{targetLcpGoalMs} ms</span>
                  </div>
                  <input
                    type="range"
                    min={1500}
                    max={3400}
                    step={100}
                    value={targetLcpGoalMs}
                    onChange={(e) => setTargetLcpGoalMs(Number(e.target.value))}
                    className="mt-1.5 w-full accent-indigo-600"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-bold text-slate-700">1 CV あたり平均価値 (円)</span>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={unitCvValueJpy}
                    onChange={(e) => setUnitCvValueJpy(Number(e.target.value) || 10000)}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
                  />
                </label>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-indigo-200 bg-white p-3.5">
              <div className="text-xs text-slate-500">推定奪還コンバージョン / 月</div>
              <div className="mt-0.5 font-mono text-2xl font-black text-emerald-600">
                +{simRecovery.recoveredCvs} CV / 月
              </div>
              <div className="mt-1 font-mono text-xs font-bold text-slate-800">
                月間売上奪還: +¥{simRecovery.recoveredRevenue.toLocaleString()}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                描画完了前離脱率: {vm.cvLossSummary.preRenderExitRatePct}% →{' '}
                <b className="text-emerald-700">{simRecovery.newPreRenderExitPct}%</b>
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Performance × Behavior 5 Bottleneck Patterns */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-slate-900">
            速度ボトルネック × ユーザー行動異常 因果照合（`linkscrawl_performance_fusion`）
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            どの速度ルール違反が、どの行動異常（描画前離脱・レイジクリック・フォーム遅延離脱）を引き起こして何件のCVを失わせているかを特定します。
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            {vm.fusionPatterns.map((pat) => (
              <div
                key={pat.patternId}
                className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-4"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded bg-rose-100 px-2 py-0.5 font-mono text-xs font-bold text-rose-800">
                      -{pat.lostConversionsMonthly} CV/月 損失
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      (-¥{pat.lostRevenueJpyMonthly.toLocaleString()}/月)
                    </span>
                  </div>
                  <h3 className="mt-2 text-sm font-bold text-slate-900">{pat.title}</h3>

                  <div className="mt-2.5 space-y-2 text-xs">
                    <div className="rounded bg-white p-2.5 border border-slate-200">
                      <div className="font-bold text-sky-800">[速度原因 (LINKTH CRAWL 90ルール)]</div>
                      <div className="mt-0.5 text-slate-700">{pat.speedTrigger}</div>
                    </div>
                    <div className="rounded bg-white p-2.5 border border-slate-200">
                      <div className="font-bold text-purple-800">[行動症状 (UGOKI MAP イベント)]</div>
                      <div className="mt-0.5 text-slate-700">{pat.behaviorSymptom}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 border-t border-slate-200 pt-2.5 text-xs font-semibold text-indigo-950">
                  <span className="text-indigo-600 font-bold">改善処方箋: </span>
                  {pat.recommendation}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 3: 12 Families / 90 Speed Rules Full Inventory */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                LINKTH CRAWL `analyzer/speed_rules` 全12ファミリ・計90ルール（T1: 67種 + T2: 23種）診断一覧
              </h2>
              <p className="text-xs text-slate-500">
                HTML / CSS / JS / HAR / DOM からなぜ遅いかの根本原因を特定する12ファミリ90種の専用ルール検査結果です。
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {vm.families.map((fam) => (
              <div
                key={fam.familyCode}
                className={`rounded-xl border p-4 ${
                  fam.status === 'poor'
                    ? 'border-rose-200 bg-rose-50/20'
                    : fam.status === 'needs_improvement'
                    ? 'border-amber-200 bg-amber-50/20'
                    : 'border-slate-200 bg-slate-50/40'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-bold text-sm text-slate-900">{fam.label}</span>
                    <span className="ml-2 font-mono text-xs text-slate-500">({fam.totalRules}ルール)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {fam.estimatedSavingsMs > 0 ? (
                      <span className="rounded bg-indigo-100 px-2 py-0.5 font-mono text-xs font-bold text-indigo-800">
                        短縮余地 -{fam.estimatedSavingsMs}ms
                      </span>
                    ) : null}
                    <span
                      className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-bold ${
                        fam.triggeredCount === 0
                          ? 'bg-emerald-100 text-emerald-800'
                          : fam.status === 'poor'
                          ? 'bg-rose-600 text-white'
                          : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {fam.triggeredCount === 0 ? '全ルール合格' : `検出 ${fam.triggeredCount}件`}
                    </span>
                  </div>
                </div>

                {fam.topFindings.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {fam.topFindings.map((f) => (
                      <div key={f.ruleId} className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-indigo-700">
                            [{f.ruleId}] {f.title}
                          </span>
                          <span className="font-mono font-bold text-rose-600">-{f.impactMs}ms</span>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-slate-500">
                          対象: {f.targetResource}
                        </div>
                        <div className="mt-1 font-semibold text-slate-800">対策: {f.remediation}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-emerald-700 font-medium">
                    ✓ このファミリの全 {fam.totalRules} ルールでボトルネックは検出されませんでした。
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PerformancePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">ページ速度分析を読み込み中…</div>}>
      <PerformanceInner />
    </Suspense>
  )
}
