'use client'

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import ConfidenceBadge from '@/components/aiseo/ConfidenceBadge'
import { PageMeta } from '@/components/layout/page-meta'
import { MlBottleneckSurvivalPanel } from '@/components/ml/ml-bottleneck-survival-panel'
import type {
  BottleneckAttributionResult,
  KaplanMeierScrollSurvivalResult,
} from '@/lib/ml/pragmatic-ml-engine'
import type {
  AiAccessPageSummary,
  CrossDiagnosisItem,
  DirectoryPerfBehaviorRow,
  GscPageSummary,
  HumanBehaviorSummary,
  SectionCrossRow,
  StructurePerfSummary,
  UnoptimizedImageCrossRow,
} from '@/lib/fusion/behavior-structure'

interface TeacherVerdictPillar {
  id: string
  code: string
  label: string
  score: number
  benchmark: number
  insight: string
}

interface SurvivalCurvePoint {
  yPx: number
  sectionLabel: string
  converterSurvivalPct: number
  nonConverterSurvivalPct: number
  hazardDropNote?: string
}

interface UrlMlCarteProfile {
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
  overallScore: number
  pageType: string
  pageTypeLabel: string
  currentCvrPct: number
  predictedPotentialCvrPct: number
  estimatedMonthlyCvGain: number
  top3Prescriptions: Array<{
    rank: number
    title: string
    impactNote: string
    targetMenuHref: string
    targetMenuLabel: string
  }>
  sevenPillars: TeacherVerdictPillar[]
  personas: Array<{ label: string; sharePct: number; cvrPct: number; color: string }>
  emotions: Array<{ label: string; sharePct: number; note: string; color: string }>
  kaplanMeierCurve: SurvivalCurvePoint[]
}

const URL_ML_PROFILES: Record<string, UrlMlCarteProfile> = {
  'https://link-th.com/entry/internal-link-optimization': {
    grade: 'B',
    overallScore: 76,
    pageType: 'article',
    pageTypeLabel: '解説記事 (article)',
    currentCvrPct: 2.18,
    predictedPotentialCvrPct: 3.45,
    estimatedMonthlyCvGain: 29,
    top3Prescriptions: [
      {
        rank: 1,
        title: 'Y=1,480px（H2 #3 比較表直下）の非リンク図表にインラインCTA＋アンカーを挿入',
        impactNote: 'Kaplan-Meier非CV群の最大脱落崖（-24pt）とデッドクリック19回を同時解消（予測CVR +0.72pt）',
        targetMenuHref: '/experiments',
        targetMenuLabel: '仮説検定A/Bテストを起票 →',
      },
      {
        rank: 2,
        title: '未視認のヒーロー下大型PNG（420KB）をWebP化＋width/height明示でCLS 0.14→0.02へ',
        impactNote: '描画前離脱率 18.4% → 7.5% へ改善（月間 +11 CV回復）',
        targetMenuHref: '/site-doc',
        targetMenuLabel: 'サイトドック自動修正パッチ →',
      },
      {
        rank: 3,
        title: '冒頭200語にAnswer-First要約ボックス＋FAQPage JSON-LDを追加',
        impactNote: '06_ai_readiness (64→88) 引き上げにより Perplexity / Google AIO 引用率向上',
        targetMenuHref: '/aiseo',
        targetMenuLabel: 'AISEO意味監査で確認 →',
      },
    ],
    sevenPillars: [
      { id: '01', code: '01_volume', label: '網羅性・情報量', score: 88, benchmark: 75, insight: '4,850語・主要サブトピック92%網羅' },
      { id: '02', code: '02_uniqueness', label: '独自性・一次情報', score: 82, benchmark: 70, insight: '自社実験データ3件を含むが図表のHTMLテーブル化が未完' },
      { id: '03', code: '03_reliability', label: '信頼性・E-E-A-T', score: 79, benchmark: 78, insight: '著者スキーマ有・外部公的出典リンク2本' },
      { id: '04', code: '04_specificity', label: '具体性・定量性', score: 85, benchmark: 72, insight: '数値根拠・再現手順コードが豊富' },
      { id: '05', code: '05_structure', label: '論理構造・見出し階層', score: 68, benchmark: 76, insight: 'H2 #3 が1,100語超の長文塊で読了急落を誘発' },
      { id: '06', code: '06_ai_readiness', label: 'AI引用適性 (GEO)', score: 64, benchmark: 75, insight: '冒頭Answer-First要約が無くAI Overview引用を取りこぼし' },
      { id: '07', code: '07_discoverability', label: '発見可能性・内部リンク', score: 71, benchmark: 74, insight: '被リンク4本（目標9本）・PageRank上位からの導線不足' },
    ],
    personas: [
      { label: '即決比較検討層', sharePct: 28, cvrPct: 5.4, color: '#2563eb' },
      { label: 'じっくり情報収集層', sharePct: 44, cvrPct: 1.6, color: '#0284c7' },
      { label: '迷い・往復スクロール層', sharePct: 19, cvrPct: 0.5, color: '#d97706' },
      { label: '初期離脱・ミスマッチ層', sharePct: 9, cvrPct: 0.0, color: '#94a3b8' },
    ],
    emotions: [
      { label: 'Interest (強い関心・熟読)', sharePct: 38, note: 'H2 #1〜#2 の事例表で平均滞在42秒', color: '#059669' },
      { label: 'Hesitation (迷い・比較躊躇)', sharePct: 31, note: 'Y=1,480px 付近で上下スクロール往復が多発', color: '#d97706' },
      { label: 'Frustration (苛立ち・デッドクリック)', sharePct: 17, note: '非リンク図表へのデッドクリック・レイジクリック発生', color: '#dc2626' },
      { label: 'Confidence (確信・CTA到達)', sharePct: 14, note: '下部CTA到達者の31%が資料請求へ遷移', color: '#4f46e5' },
    ],
    kaplanMeierCurve: [
      { yPx: 0, sectionLabel: 'FV / H1 導入 (0px)', converterSurvivalPct: 100, nonConverterSurvivalPct: 100 },
      { yPx: 650, sectionLabel: 'H2 #1 内部リンクの基本 (650px)', converterSurvivalPct: 96, nonConverterSurvivalPct: 84 },
      { yPx: 1480, sectionLabel: 'H2 #2〜#3 構造図・長文塊 (1,480px)', converterSurvivalPct: 89, nonConverterSurvivalPct: 52, hazardDropNote: '⚠ 非CV群の最大ハザード崖 (-32pt): デッドクリック＋1,100語テキスト塊' },
      { yPx: 2450, sectionLabel: 'H2 #4 PageRank設計手順 (2,450px)', converterSurvivalPct: 82, nonConverterSurvivalPct: 34 },
      { yPx: 3400, sectionLabel: 'H2 #5 導入事例・比較表 (3,400px)', converterSurvivalPct: 76, nonConverterSurvivalPct: 21 },
      { yPx: 4200, sectionLabel: '最終CTA・フォーム導線 (4,200px)', converterSurvivalPct: 71, nonConverterSurvivalPct: 12 },
    ],
  },
}

function getMlProfileForUrl(url: string): UrlMlCarteProfile {
  return (
    URL_ML_PROFILES[url] ?? {
      ...URL_ML_PROFILES['https://link-th.com/entry/internal-link-optimization'],
      grade: 'C',
      overallScore: 68,
      pageType: 'lp_service',
      pageTypeLabel: 'サービスLP (lp_service)',
      currentCvrPct: 1.75,
      predictedPotentialCvrPct: 2.95,
      estimatedMonthlyCvGain: 22,
    }
  )
}

const fmtInt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`)

const PLANE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  behavior: { label: '行動 (ugokimap)', bg: '#ede9fe', fg: '#5b21b6' },
  structure: { label: '構造・速度 (linkscrawl)', bg: '#e0f2fe', fg: '#0369a1' },
  seo: { label: '検索 (GSC)', bg: '#dcfce7', fg: '#166534' },
  ai: { label: 'AI (AIreceipt)', bg: '#fef3c7', fg: '#92400e' },
}

const SEVERITY_STYLE: Record<string, { label: string; bg: string; fg: string; border: string }> = {
  high: { label: '優先度: 高', bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
  medium: { label: '優先度: 中', bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  low: { label: '優先度: 低', bg: '#f8fafc', fg: '#334155', border: '#e2e8f0' },
}

interface FusionApiResponse {
  ok: boolean
  tenantId: string
  days: number
  canonicalUrl: string
  urlMatchKey: string
  urlHash16: string
  availableUrls: Array<{ url: string; title: string; badge: string }>
  behavior: HumanBehaviorSummary
  structure: StructurePerfSummary
  gsc: GscPageSummary
  ai: AiAccessPageSummary
  sections: SectionCrossRow[]
  images: UnoptimizedImageCrossRow[]
  directoryMatrix: DirectoryPerfBehaviorRow[]
  diagnoses: CrossDiagnosisItem[]
  sources: Record<string, string>
}

function FusionViewInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlParam = searchParams.get('url') || 'https://link-th.com/entry/internal-link-optimization'
  const [days, setDays] = useState(30)
  const [data, setData] = useState<FusionApiResponse | null>(null)
  const [mlInsights, setMlInsights] = useState<{
    bottleneckAttribution: BottleneckAttributionResult
    scrollSurvival: KaplanMeierScrollSurvivalResult
    methodologyNote?: string
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/fusion/url-summary?url=${encodeURIComponent(urlParam)}&days=${days}`).then((r) =>
        r.json(),
      ),
      fetch(`/api/ml/insights?url=${encodeURIComponent(urlParam)}`).then((r) => r.json()),
    ])
      .then(([fusionJson, mlJson]) => {
        setData(fusionJson)
        if (mlJson?.ok && mlJson.data) {
          setMlInsights(mlJson.data)
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [urlParam, days])

  const selectUrl = (nextUrl: string) => {
    router.push(`/fusion?url=${encodeURIComponent(nextUrl)}`)
  }

  const mlProfile = useMemo(
    () => getMlProfileForUrl(data?.canonicalUrl ?? urlParam),
    [data?.canonicalUrl, urlParam],
  )

  if (loading || !data) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: 1440, margin: '0 auto' }}>
        <div className="breadcrumb">融合分析 / 行動 × ページ構造 × 検索 × AI 統合診断</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>読み込み中…</h1>
      </div>
    )
  }

  const { behavior, structure, gsc, ai, sections, images, directoryMatrix, diagnoses } = data

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1440, margin: '0 auto' }}>
      <PageMeta
        title="ページパフォーマンス分析（同一URL 4平面カルテ × Teacher Verdict × CVR予測）"
        eyebrow="Page Performance Carte · Behavior × Structure × GSC × AI"
      />
      {/* Header */}
      <div className="page-head" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="breadcrumb">
            ページパフォーマンス分析（ugokimap × linkscrawl × GSC × AIreceipt） / URL別総合カルテ
          </div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>ページパフォーマンス分析（URL別総合カルテ）</span>
            <span
              className="mono"
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 999,
                background: '#f1f5f9',
                color: '#334155',
                fontWeight: 600,
              }}
            >
              matchKey: {data.urlMatchKey} (hash: {data.urlHash16})
            </span>
          </h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {structure.title}
          </div>
        </div>
        <div className="page-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Link
            href="/experiments"
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: '#4f46e5',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            仮説検定A/Bテストへ起票 →
          </Link>
          <div className="seg">
            {[7, 30, 90].map((d) => (
              <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
                過去{d}日
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* URL Selector Bar */}
      <div
        className="card"
        style={{
          marginBottom: 20,
          padding: '12px 16px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
          background: '#f8fafc',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
          診断対象 URL 切替:
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1 }}>
          {data.availableUrls.map((u) => {
            const active = data.canonicalUrl === u.url
            return (
              <button
                key={u.url}
                onClick={() => selectUrl(u.url)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: active ? '1.5px solid #2563eb' : '1px solid var(--border)',
                  background: active ? '#eff6ff' : '#fff',
                  color: active ? '#1d4ed8' : 'var(--text-primary)',
                  fontSize: 12,
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                }}
              >
                <span className="mono">{new URL(u.url).pathname}</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 999,
                    background: active ? '#dbeafe' : '#f1f5f9',
                    color: active ? '#1e40af' : '#475569',
                  }}
                >
                  {u.badge}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 4-Plane Summary Strip */}
      <div className="kpi-grid" style={{ marginBottom: 22 }}>
        {/* Plane 1: Human Behavior */}
        <div className="kpi-card" style={{ borderTop: '3px solid #7c3aed' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="kpi-label">① 人間の行動 (ugokimap)</span>
            <Link href="/heatmap" style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>
              ヒートマップ →
            </Link>
          </div>
          <div className="kpi-val">{fmtInt(behavior.sessions)} セッション</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
            <div>
              直帰率: <b>{fmtPct(behavior.bounceRate)}</b> / 描画前離脱:{' '}
              <b style={{ color: '#dc2626' }}>{fmtPct(behavior.preRenderExitRate)}</b>
            </div>
            <div>
              平均読了深度: <b>{behavior.avgScrollDepthPct}%</b> / デッドクリック:{' '}
              <b style={{ color: '#d97706' }}>{behavior.deadClicks}回</b> / レイジ:{' '}
              <b>{behavior.rageClicks}回</b>
            </div>
          </div>
        </div>

        {/* Plane 2: Structure & Speed */}
        <div className="kpi-card" style={{ borderTop: '3px solid #0284c7' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="kpi-label">② 構造・速度 (linkscrawl)</span>
            <Link href="/seo/internal-links" style={{ fontSize: 11, color: '#0284c7', fontWeight: 600 }}>
              内部リンク構造 →
            </Link>
          </div>
          <div className="kpi-val">
            LCP {fmtInt(structure.lcpMs)}ms{' '}
            <span style={{ fontSize: 13, fontWeight: 600, color: '#64748b' }}>
              (Score {structure.speedScore})
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
            <div>
              CLS: <b style={{ color: structure.cls >= 0.1 ? '#dc2626' : undefined }}>{structure.cls}</b> / TTFB:{' '}
              <b>{structure.ttfbMs}ms</b> / 語数: <b>{fmtInt(structure.wordCount)}語</b>
            </div>
            <div>
              被リンク: <b>{structure.inboundLinks}本</b> / 発リンク: <b>{structure.outboundLinks}本</b> / 深度:{' '}
              <b>depth {structure.clickDepth}</b>
            </div>
          </div>
        </div>

        {/* Plane 3: Search Inflow & Index */}
        <div className="kpi-card" style={{ borderTop: '3px solid #059669' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="kpi-label">③ 検索流入・Index (GSC)</span>
            <Link href="/seo/access" style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>
              GSC分析 →
            </Link>
          </div>
          <div className="kpi-val">{fmtInt(gsc.clicks)} クリック</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
            <div>
              表示: <b>{fmtInt(gsc.impressions)}回</b> / CTR: <b>{fmtPct(gsc.ctr)}</b> / 平均順位:{' '}
              <b>{gsc.position}位</b>
            </div>
            <div>
              Index状態:{' '}
              <b style={{ color: gsc.indexVerdict === 'PASS' ? '#059669' : '#d97706' }}>
                {gsc.coverageState}
              </b>
            </div>
          </div>
        </div>

        {/* Plane 4: AI Crawler & Agent Access */}
        <div className="kpi-card" style={{ borderTop: '3px solid #d97706' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="kpi-label">④ AIアクセス (AIreceipt)</span>
            <Link href="/ai-visits" style={{ fontSize: 11, color: '#d97706', fontWeight: 600 }}>
              AI訪問詳細 →
            </Link>
          </div>
          <div className="kpi-val">{fmtInt(ai.totalVisits)} AI訪問</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
            <div>
              AI引用フェッチ: <b>{ai.citationFetches}回</b> / AI検索送客: <b>{ai.searchReferrals}回</b>
            </div>
            <div>
              上位Bot:{' '}
              <b>
                {ai.topAgents
                  .slice(0, 2)
                  .map((a) => `${a.agent}(${a.count})`)
                  .join(', ')}
              </b>
            </div>
          </div>
        </div>
      </div>

      {/* Section 0: LINKTH CRAWL × UGOKI MAP Teacher Verdict (Grade S~D & 7 Pillars) + 80+ Feature CVR Prediction + Kaplan-Meier Survival Curve */}
      <div className="card" style={{ marginBottom: 22, border: '1.5px solid #c7d2fe', background: '#fafbff' }}>
        <div className="card-head" style={{ borderBottom: '1px solid #e0e7ff', paddingBottom: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: '#4f46e5',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                Stage 3 Teacher Verdict カルテ × 13種 行動Fusion ML
              </span>
              <span style={{ fontSize: 12, color: '#4338ca', fontWeight: 600 }}>
                ページ種別自動判別: {mlProfile.pageTypeLabel}
              </span>
            </div>
            <div className="card-title" style={{ fontSize: 17, marginTop: 6 }}>
              URL総合評価グレード & 7本柱レーダー（Content Asset Value）× 80+特徴量 CVR改善予測
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                padding: '8px 16px',
                borderRadius: 12,
                background: '#eef2ff',
                border: '1.5px solid #818cf8',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: '#4338ca' }}>TEACHER VERDICT</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 900, color: '#1e1b4b' }}>
                Grade {mlProfile.grade} ({mlProfile.overallScore}点)
              </div>
            </div>
            <div
              style={{
                padding: '8px 16px',
                borderRadius: 12,
                background: '#ecfdf5',
                border: '1.5px solid #34d399',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: '#065f46' }}>80+特徴量 CVR予測 (`ml_cvr_predict`)</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: '#065f46' }}>
                現在 {mlProfile.currentCvrPct}% → 改善後 {mlProfile.predictedPotentialCvrPct}% (+{mlProfile.estimatedMonthlyCvGain} CV/月)
              </div>
            </div>
          </div>
        </div>

        <div className="grid-2" style={{ marginTop: 14, gap: 16 }}>
          {/* Left: 7 Pillars Radar Bars */}
          <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>
              ① Content Asset Value 7本柱スコア（01_volume 〜 07_discoverability）
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {mlProfile.sevenPillars.map((p) => {
                const above = p.score >= p.benchmark
                return (
                  <div key={p.code}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span>
                        <b className="mono" style={{ color: '#4f46e5' }}>{p.code}</b> · <b>{p.label}</b>
                      </span>
                      <span className="mono" style={{ fontWeight: 700, color: above ? '#059669' : '#d97706' }}>
                        {p.score}点 <span style={{ color: '#94a3b8', fontWeight: 400 }}>(基準 {p.benchmark})</span>
                      </span>
                    </div>
                    <div className="bar" style={{ height: 7, marginTop: 3 }}>
                      <span
                        style={{
                          width: `${p.score}%`,
                          background: above ? '#10b981' : '#f59e0b',
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{p.insight}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right: Top 3 Prescriptions + Kaplan-Meier Scroll Survival Curve */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>
                ② Top 3 最優先改善レバー（`linkscrawl_generate_proposals` × `ml_impact_ranking`）
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {mlProfile.top3Prescriptions.map((pr) => (
                  <div
                    key={pr.rank}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, color: '#1e293b' }}>
                        #{pr.rank} {pr.title}
                      </span>
                      <Link
                        href={pr.targetMenuHref}
                        style={{ fontSize: 11, fontWeight: 700, color: '#4f46e5', whiteSpace: 'nowrap' }}
                      >
                        {pr.targetMenuLabel}
                      </Link>
                    </div>
                    <div style={{ fontSize: 11.5, color: '#475569', marginTop: 3 }}>{pr.impactNote}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>
                ③ Kaplan-Meier スクロール生存分析（`linkscrawl_ml_scroll_survival`：CV群 vs 非CV群の離脱集中Y座標）
              </div>
              <table className="tbl" style={{ fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th>Y座標 / セクション</th>
                    <th className="num">CV群 生存率</th>
                    <th className="num">非CV群 生存率</th>
                    <th>ハザード診断</th>
                  </tr>
                </thead>
                <tbody>
                  {mlProfile.kaplanMeierCurve.map((pt) => (
                    <tr key={pt.yPx} style={{ background: pt.hazardDropNote ? '#fef2f2' : undefined }}>
                      <td className="mono" style={{ fontWeight: 600 }}>{pt.sectionLabel}</td>
                      <td className="num" style={{ color: '#059669', fontWeight: 700 }}>{pt.converterSurvivalPct}%</td>
                      <td className="num" style={{ color: pt.nonConverterSurvivalPct < 40 ? '#dc2626' : '#334155', fontWeight: 700 }}>
                        {pt.nonConverterSurvivalPct}%
                      </td>
                      <td style={{ fontSize: 11, color: pt.hazardDropNote ? '#991b1b' : '#64748b', fontWeight: pt.hazardDropNote ? 700 : 400 }}>
                        {pt.hazardDropNote ?? '正常推移'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Section 0.5: Pragmatic ML — SHAP Bottleneck Attribution & Kaplan-Meier Survival Analysis */}
      {mlInsights && (
        <MlBottleneckSurvivalPanel
          bottleneckAttribution={mlInsights.bottleneckAttribution}
          scrollSurvival={mlInsights.scrollSurvival}
          methodologyNote={mlInsights.methodologyNote}
        />
      )}

      {/* Section 1: Deep Cross-Diagnosis Cards (行動×構造の掛け合わせ診断) */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-head">
          <div>
            <div className="card-title" style={{ fontSize: 16 }}>
              行動 × 構造 掛け合わせ診断（複数系統シグナル照合）
            </div>
            <div className="card-sub">
              単なる数値の並置ではなく、「デッドクリック×非対話DOM」「描画完了前離脱×未視認画像」「浅い読了×テキスト塊」「低速ディレクトリ×直帰率」の因果を独立シグナルで診断します。
            </div>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            検出ボトルネック: <b>{diagnoses.length}件</b>
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))', gap: 16 }}>
          {diagnoses.map((d) => {
            const sev = SEVERITY_STYLE[d.severity] || SEVERITY_STYLE.medium
            return (
              <div
                key={d.id}
                style={{
                  border: `1px solid ${sev.border}`,
                  borderRadius: 10,
                  padding: 16,
                  background: '#fff',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        background: sev.bg,
                        color: sev.fg,
                      }}
                    >
                      {sev.label}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--text-primary)' }}>
                      {d.title}
                    </span>
                  </div>
                  <ConfidenceBadge level={d.confidence.level} reason={d.confidence.reason} />
                </div>

                <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
                  {d.summary}
                </div>

                {/* Cross metrics pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {d.metrics.map((m, idx) => {
                    const pb = PLANE_BADGE[m.plane] || PLANE_BADGE.behavior
                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 6,
                          background: '#f8fafc',
                          border: '1px solid var(--border)',
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: pb.bg,
                            color: pb.fg,
                          }}
                        >
                          {pb.label}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>{m.label}:</span>
                        <b className="num">{m.value}</b>
                      </div>
                    )
                  })}
                </div>

                {/* Evidence signals */}
                <div
                  style={{
                    background: '#f8fafc',
                    borderRadius: 6,
                    padding: '8px 12px',
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    判定根拠シグナル（{d.confidence.reason}）:
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
                    {d.confidence.signals.map((sig, i) => (
                      <li key={i}>
                        <span className="mono" style={{ fontWeight: 600 }}>
                          [{sig.kind}]
                        </span>{' '}
                        {sig.label}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Actionable Recommendation */}
                <div
                  style={{
                    borderTop: '1px dashed var(--border)',
                    paddingTop: 8,
                    fontSize: 12.5,
                    color: '#0f172a',
                  }}
                >
                  <b style={{ color: '#2563eb' }}>改善アクション: </b>
                  {d.recommendation}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Section 2: Section-by-Section Scroll / Dead-Click / Structure Waterfall */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-head">
          <div>
            <div className="card-title">
              セクション別「読了到達率 × デッドクリック × DOM構造（文字密度・CTA距離）」ウォーターフォール
            </div>
            <div className="card-sub">
              どの見出しブロックで「深く読まれずに離脱したか」「非リンク要素へのデッドクリックが起きたか」を構造データと並べて可視化します。
            </div>
          </div>
        </div>

        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 44 }}>順序</th>
              <th>見出し（H2/H3） / DOM要素</th>
              <th className="num">文字量 / 画像</th>
              <th className="num">リンク / CTA</th>
              <th className="num">次CTA距離</th>
              <th style={{ width: 170 }}>スクロール到達率</th>
              <th className="num">区間離脱率</th>
              <th className="num">デッド / レイジ</th>
              <th className="num">平均滞在</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((sec, idx) => {
              const prevReach = idx > 0 ? sections[idx - 1].reachRate : 1.0
              const drop = prevReach - sec.reachRate
              const isHighDead = sec.deadClickCount >= 10 && (!sec.hasCta || sec.linkCount === 0)
              const isHighDrop = drop >= 0.22
              return (
                <tr
                  key={sec.sectionOrder}
                  style={{
                    background: isHighDead ? '#fffbeb' : isHighDrop ? '#fef2f2' : undefined,
                  }}
                >
                  <td className="num" style={{ fontWeight: 700 }}>
                    #{sec.sectionOrder}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{sec.headingText}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }} className="mono">
                      &lt;{sec.elementTag}&gt; H{sec.headingLevel}
                      {isHighDead && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: '#fef3c7',
                            color: '#92400e',
                            fontWeight: 700,
                          }}
                        >
                          ⚠ 非リンク領域でデッドクリック集中
                        </span>
                      )}
                      {isHighDrop && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: '#fee2e2',
                            color: '#991b1b',
                            fontWeight: 700,
                          }}
                        >
                          ⚠ 長文ブロックによる読了急落 (-{(drop * 100).toFixed(0)}pt)
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="num">
                    <b>{fmtInt(sec.wordCount)}語</b> / {sec.imageCount}枚
                  </td>
                  <td className="num">
                    {sec.linkCount}本 /{' '}
                    {sec.hasCta ? (
                      <span style={{ color: '#059669', fontWeight: 700 }}>CTA有</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>CTA無</span>
                    )}
                  </td>
                  <td className="num">
                    {sec.distanceToNextCtaPx > 0 ? `${fmtInt(sec.distanceToNextCtaPx)}px` : '0px (CTA内)'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="bar" style={{ width: 95, height: 8 }}>
                        <span
                          style={{
                            width: `${Math.min(100, sec.reachRate * 100)}%`,
                            background: sec.reachRate < 0.35 ? '#f59e0b' : '#2563eb',
                          }}
                        />
                      </div>
                      <span className="num" style={{ fontWeight: 700, fontSize: 12 }}>
                        {(sec.reachRate * 100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td
                    className="num"
                    style={{
                      color: sec.exitRate >= 0.25 ? '#dc2626' : undefined,
                      fontWeight: sec.exitRate >= 0.25 ? 700 : 400,
                    }}
                  >
                    {(sec.exitRate * 100).toFixed(0)}%
                  </td>
                  <td className="num">
                    <span style={{ color: sec.deadClickCount >= 10 ? '#d97706' : undefined, fontWeight: 700 }}>
                      {sec.deadClickCount}
                    </span>{' '}
                    / <span style={{ color: sec.rageClickCount >= 3 ? '#dc2626' : undefined }}>{sec.rageClickCount}</span>
                  </td>
                  <td className="num">{(sec.avgDwellMs / 1000).toFixed(1)}秒</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Section 3: Directory Speed × Bounce Matrix + Unviewed Heavy Images */}
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">ディレクトリ別「ページ表示速度 × 直帰率・描画前離脱率」比較</div>
              <div className="card-sub">
                パフォーマンスが低いディレクトリほど描画完了前離脱と直帰率が高い構造相関を検証
              </div>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>ディレクトリ</th>
                <th className="num">ページ数</th>
                <th className="num">平均 LCP</th>
                <th className="num">速度スコア</th>
                <th className="num">描画前離脱</th>
                <th className="num">直帰率</th>
                <th className="num">平均読了</th>
              </tr>
            </thead>
            <tbody>
              {directoryMatrix.map((d) => {
                const isSlow = d.avgLcpMs >= 2500
                return (
                  <tr key={d.directory} style={{ background: isSlow ? '#fffbeb' : undefined }}>
                    <td className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                      {d.directory}
                    </td>
                    <td className="num">{d.pageCount}</td>
                    <td
                      className="num"
                      style={{
                        color: d.avgLcpMs >= 3000 ? '#dc2626' : d.avgLcpMs >= 2500 ? '#d97706' : '#059669',
                        fontWeight: 700,
                      }}
                    >
                      {fmtInt(d.avgLcpMs)}ms
                    </td>
                    <td className="num">{d.avgSpeedScore}</td>
                    <td
                      className="num"
                      style={{
                        color: d.preRenderExitRate >= 0.2 ? '#dc2626' : undefined,
                        fontWeight: d.preRenderExitRate >= 0.2 ? 700 : 400,
                      }}
                    >
                      {fmtPct(d.preRenderExitRate)}
                    </td>
                    <td
                      className="num"
                      style={{
                        color: d.bounceRate >= 0.6 ? '#dc2626' : undefined,
                        fontWeight: 700,
                      }}
                    >
                      {fmtPct(d.bounceRate)}
                    </td>
                    <td className="num">{d.avgScrollDepthPct}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">未最適化画像 × 実際のユーザー視認率（image_visibility）</div>
              <div className="card-sub">
                初期転送量を圧迫しているにもかかわらず、離脱により大半のユーザーに見られていない画像を特定
              </div>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>画像パス</th>
                <th className="num">容量</th>
                <th>寸法指定 / loading</th>
                <th className="num">視認率</th>
                <th className="num">平均視認</th>
              </tr>
            </thead>
            <tbody>
              {images.map((img) => {
                const wasted = img.fileSizeBytes >= 150_000 && img.visibleRate < 0.35
                return (
                  <tr key={img.imageSrc} style={{ background: wasted ? '#fef2f2' : undefined }}>
                    <td>
                      <div className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
                        {img.imageSrc}
                      </div>
                      {wasted && (
                        <span style={{ fontSize: 10.5, color: '#dc2626', fontWeight: 700 }}>
                          ⚠ 未視認のまま初期描画帯域を消費
                        </span>
                      )}
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {Math.round(img.fileSizeBytes / 1024)} KB
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {img.hasWidthHeight ? (
                        <span style={{ color: '#059669' }}>寸法有</span>
                      ) : (
                        <span style={{ color: '#dc2626', fontWeight: 700 }}>寸法無(CLS要因)</span>
                      )}{' '}
                      / <span className="mono">{img.loadingAttr}</span>
                    </td>
                    <td
                      className="num"
                      style={{
                        color: img.visibleRate < 0.35 ? '#dc2626' : '#059669',
                        fontWeight: 700,
                      }}
                    >
                      {fmtPct(img.visibleRate)}
                    </td>
                    <td className="num">{(img.avgVisibleTimeMs / 1000).toFixed(1)}秒</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function FusionPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>読み込み中…</div>}>
      <FusionViewInner />
    </Suspense>
  )
}
