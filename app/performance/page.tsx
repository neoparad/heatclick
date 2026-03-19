'use client'

import React, { useState, useEffect, useMemo } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import {
  Zap,
  Clock,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  LayoutGrid,
  FileText,
  Link as LinkIcon,
  Loader2,
} from 'lucide-react'
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { PagePerformance, PerformanceData, PageSpeedData, AuditItem } from '@/types/performance'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

// スコアの色クラス
function getScoreColor(score: number): string {
  if (score >= 90) return 'text-green-600'
  if (score >= 50) return 'text-amber-500'
  return 'text-red-600'
}

function getScoreBg(score: number): string {
  if (score >= 90) return 'bg-green-100 text-green-700'
  if (score >= 50) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

function getMetricClass(value: number, goodThreshold: number, poorThreshold: number, lower = true): string {
  if (lower) {
    if (value <= goodThreshold) return 'text-green-600'
    if (value <= poorThreshold) return 'text-amber-600'
    return 'text-red-600'
  }
  if (value >= goodThreshold) return 'text-green-600'
  if (value >= poorThreshold) return 'text-amber-600'
  return 'text-red-600'
}

function getMetricBorder(value: number, goodThreshold: number, poorThreshold: number, lower = true): string {
  if (lower) {
    if (value <= goodThreshold) return 'metric-good'
    if (value <= poorThreshold) return 'metric-avg'
    return 'metric-poor'
  }
  if (value >= goodThreshold) return 'metric-good'
  if (value >= poorThreshold) return 'metric-avg'
  return 'metric-poor'
}

function getMetricLabel(value: number, goodThreshold: number, poorThreshold: number, lower = true): string {
  if (lower) {
    if (value <= goodThreshold) return 'GOOD'
    if (value <= poorThreshold) return 'NEEDS IMPROVEMENT'
    return 'POOR'
  }
  if (value >= goodThreshold) return 'GOOD'
  if (value >= poorThreshold) return 'NEEDS IMPROVEMENT'
  return 'POOR'
}

function getMetricLabelBg(value: number, goodThreshold: number, poorThreshold: number, lower = true): string {
  if (lower) {
    if (value <= goodThreshold) return 'bg-green-100 text-green-700'
    if (value <= poorThreshold) return 'bg-amber-100 text-amber-700'
    return 'bg-red-100 text-red-700'
  }
  if (value >= goodThreshold) return 'bg-green-100 text-green-700'
  if (value >= poorThreshold) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

// ピアソン相関係数
function pearsonCorrelation(data: { x: number; y: number }[]): number {
  const n = data.length
  if (n < 2) return 0
  const sumX = data.reduce((s, d) => s + d.x, 0)
  const sumY = data.reduce((s, d) => s + d.y, 0)
  const sumXY = data.reduce((s, d) => s + d.x * d.y, 0)
  const sumX2 = data.reduce((s, d) => s + d.x * d.x, 0)
  const sumY2 = data.reduce((s, d) => s + d.y * d.y, 0)
  const numerator = n * sumXY - sumX * sumY
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
  if (denominator === 0) return 0
  return numerator / denominator
}

// 診断メッセージ生成
function getDiagnostics(page: PagePerformance): { level: 'error' | 'warning'; title: string; description: string }[] {
  const diagnostics: { level: 'error' | 'warning'; title: string; description: string }[] = []
  const ps = page.pagespeed
  if (!ps) return diagnostics

  if (ps.lcp > 2.5 && page.avg_scroll_depth < 50) {
    diagnostics.push({
      level: 'error',
      title: `LCP ${ps.lcp.toFixed(1)}s → スクロール到達率${Math.round(page.avg_scroll_depth)}%と強い相関`,
      description: 'ページ表示が遅いためユーザーがCTAに到達する前に離脱している可能性があります。',
    })
  }

  if (ps.cls > 0.1 && page.rage_clicks > 10) {
    diagnostics.push({
      level: 'error',
      title: `CLS ${ps.cls.toFixed(2)} → レイジクリック${page.rage_clicks}回と一致`,
      description: 'レイアウトシフトにより、ボタンやリンクの位置がずれてクリックできない状態が発生している可能性があります。',
    })
  }

  if (ps.inp > 200 && page.rage_clicks > 5) {
    diagnostics.push({
      level: 'warning',
      title: `INP ${ps.inp}ms → フォーム操作時の遅延`,
      description: 'JSの重さがフォーム応答性に影響している可能性があります。',
    })
  }

  return diagnostics
}

// 改善インパクト試算
function getImprovementImpact(pages: PagePerformance[]): {
  url: string
  score: number
  metric: string
  current: string
  target: string
  estimatedCvrFrom: number
  estimatedCvrTo: number
  estimatedCvIncrease: number
}[] {
  return pages
    .filter(p => p.pagespeed && p.pagespeed.performance_score < 80 && p.sessions > 0)
    .sort((a, b) => (a.pagespeed?.performance_score || 0) - (b.pagespeed?.performance_score || 0))
    .slice(0, 3)
    .map(p => {
      const ps = p.pagespeed!
      // LCPが最も悪い場合はLCP改善、CLSが悪い場合はCLS改善
      let metric = 'LCP'
      let current = `${ps.lcp.toFixed(1)}s`
      let target = '2.0s'
      if (ps.cls > 0.1 && ps.lcp <= 2.5) {
        metric = 'CLS'
        current = ps.cls.toFixed(2)
        target = '0.05'
      }

      // 推定CVR改善（簡易計算: スコアが90に改善した場合の比例）
      const improvementRatio = Math.min(90, ps.performance_score + 40) / Math.max(ps.performance_score, 1)
      const estimatedCvrTo = Number((p.cvr * improvementRatio).toFixed(1))
      const monthlySessionEstimate = p.sessions // 選択期間のセッション数をそのまま使用
      const estimatedCvIncrease = Math.round(monthlySessionEstimate * (estimatedCvrTo - p.cvr) / 100)

      return {
        url: p.url,
        score: ps.performance_score,
        metric,
        current,
        target,
        estimatedCvrFrom: Number(p.cvr.toFixed(1)),
        estimatedCvrTo,
        estimatedCvIncrease: Math.max(0, estimatedCvIncrease),
      }
    })
}

export default function PerformancePage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [device, setDevice] = useState<'mobile' | 'desktop'>('mobile')
  const [dateRange, setDateRange] = useState<'7days' | '30days' | '90days'>('30days')
  const [activeTab, setActiveTab] = useState<'overview' | 'detail'>('overview')
  const [data, setData] = useState<PerformanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [measuringUrl, setMeasuringUrl] = useState<string | null>(null)
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>('')

  // サイト一覧取得
  useEffect(() => {
    const fetchSites = async () => {
      try {
        const response = await fetch('/api/sites')
        if (response.ok) {
          const result = await response.json()
          const siteList = result.sites || []
          setSites(siteList)
          if (siteList.length > 0) {
            setSelectedSite(siteList[0])
          } else {
            setLoading(false)
          }
        } else {
          setLoading(false)
        }
      } catch (err) {
        console.error('Error fetching sites:', err)
        setLoading(false)
      }
    }
    fetchSites()
  }, [])

  // パフォーマンスデータ取得
  useEffect(() => {
    if (!selectedSite) return
    const fetchData = async () => {
      setLoading(true)
      try {
        const now = new Date()
        let startDate = ''
        if (dateRange === '7days') {
          startDate = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]
        } else if (dateRange === '30days') {
          startDate = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0]
        } else if (dateRange === '90days') {
          startDate = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0]
        }
        const endDate = now.toISOString().split('T')[0]

        const params = new URLSearchParams({
          site_id: selectedSite.id,
          device,
        })
        if (startDate) {
          params.set('start_date', startDate)
          params.set('end_date', endDate)
        }

        const response = await fetch(`/api/performance?${params}`)
        const result = await response.json()
        if (response.ok && result.success) {
          setData(result.data)
          setError(null)
          // 初期ページ選択
          if (result.data?.pages?.length > 0 && !selectedPageUrl) {
            setSelectedPageUrl(result.data.pages[0].url)
          }
        } else {
          console.error('Performance API error:', result)
          setError(result.error || 'データの取得に失敗しました')
          // エラー時でも空データをセットして表示を出す
          setData({ pages: [], summary: { avg_score: null, avg_lcp: null, problem_pages: 0, avg_cvr: 0 } })
        }
      } catch (err) {
        console.error('Error fetching performance data:', err)
        setError('サーバーとの通信に失敗しました')
        setData({ pages: [], summary: { avg_score: null, avg_lcp: null, problem_pages: 0, avg_cvr: 0 } })
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [selectedSite, device, dateRange])

  // PageSpeed計測
  const measurePage = async (pageUrl: string) => {
    if (!selectedSite || measuringUrl) return
    setMeasuringUrl(pageUrl)
    try {
      const fullUrl = pageUrl.startsWith('http') ? pageUrl : `${selectedSite.url}${pageUrl}`
      const params = new URLSearchParams({ url: fullUrl, device })
      const response = await fetch(`/api/pagespeed?${params}`)
      if (response.ok) {
        // データ再取得
        const now = new Date()
        let startDate = ''
        if (dateRange === '7days') startDate = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]
        else if (dateRange === '30days') startDate = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0]
        else if (dateRange === '90days') startDate = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0]
        const endDate = now.toISOString().split('T')[0]

        const perfParams = new URLSearchParams({ site_id: selectedSite.id, device })
        if (startDate) { perfParams.set('start_date', startDate); perfParams.set('end_date', endDate) }
        const perfResponse = await fetch(`/api/performance?${perfParams}`)
        if (perfResponse.ok) {
          const result = await perfResponse.json()
          setData(result.data)
        }
      }
    } catch (err) {
      console.error('Error measuring page:', err)
    } finally {
      setMeasuringUrl(null)
    }
  }

  // 散布図用データ
  const scatterData = useMemo(() => {
    if (!data) return []
    return data.pages
      .filter(p => p.pagespeed !== null && p.sessions > 0)
      .map(p => ({
        x: p.pagespeed!.performance_score,
        y: Number(p.cvr.toFixed(2)),
        url: p.url,
        sessions: p.sessions,
      }))
  }, [data])

  const correlation = useMemo(() => {
    if (scatterData.length < 2) return null
    return pearsonCorrelation(scatterData)
  }, [scatterData])

  // 選択中ページ
  const selectedPage = useMemo(() => {
    if (!data || !selectedPageUrl) return null
    return data.pages.find(p => p.url === selectedPageUrl) || null
  }, [data, selectedPageUrl])

  // 改善インパクト
  const improvements = useMemo(() => {
    if (!data) return []
    return getImprovementImpact(data.pages)
  }, [data])

  // 診断
  const diagnostics = useMemo(() => {
    if (!selectedPage) return []
    return getDiagnostics(selectedPage)
  }, [selectedPage])

  return (
    <DashboardLayout>
      <style jsx>{`
        .metric-good { background: #f0fdf4; border-left: 4px solid #16a34a; }
        .metric-avg { background: #fffbeb; border-left: 4px solid #f59e0b; }
        .metric-poor { background: #fef2f2; border-left: 4px solid #dc2626; }
        .score-ring {
          width: 80px; height: 80px;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 24px; font-weight: 700;
          position: relative;
        }
        .score-ring::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 50%;
          border: 6px solid #e5e7eb;
        }
        .score-good { color: #16a34a; }
        .score-good::before { border-color: #bbf7d0; border-top-color: #16a34a; border-right-color: #16a34a; }
        .score-average { color: #f59e0b; }
        .score-average::before { border-color: #fef3c7; border-top-color: #f59e0b; border-right-color: #f59e0b; }
        .score-poor { color: #dc2626; }
        .score-poor::before { border-color: #fecaca; border-top-color: #dc2626; }
      `}</style>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">パフォーマンス</h1>
            <p className="text-sm text-gray-500 mt-1">PageSpeed Insights × ユーザー行動データの統合分析</p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Filter Bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">サイトを選択</label>
              <select
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={selectedSite?.id || ''}
                onChange={(e) => {
                  const site = sites.find(s => s.id === e.target.value)
                  if (site) setSelectedSite(site)
                }}
              >
                {sites.map(site => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.url})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">デバイス</label>
              <select
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={device}
                onChange={(e) => setDevice(e.target.value as 'mobile' | 'desktop')}
              >
                <option value="mobile">モバイル</option>
                <option value="desktop">デスクトップ</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">行動データ期間</label>
              <select
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as '7days' | '30days' | '90days')}
              >
                <option value="7days">過去7日間</option>
                <option value="30days">過去30日間</option>
                <option value="90days">過去90日間</option>
              </select>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-6 py-3 text-sm font-medium flex items-center gap-2 ${
                activeTab === 'overview'
                  ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
              サイト全体
            </button>
            <button
              onClick={() => setActiveTab('detail')}
              className={`px-6 py-3 text-sm font-medium flex items-center gap-2 ${
                activeTab === 'detail'
                  ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <FileText className="w-4 h-4" />
              ページ別
            </button>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
              <p className="text-gray-500">データを読み込み中...</p>
            </div>
          ) : (
            <>
              {/* エラー表示 */}
              {error && (
                <div className="p-6">
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium text-amber-800">データ取得エラー</div>
                      <div className="text-sm text-amber-600 mt-1">{error}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 1: サイト全体 */}
              {activeTab === 'overview' && data && (
                <div className="p-6 space-y-6">
                  {/* 空データ表示 */}
                  {data.pages.length === 0 && !error && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
                      <Zap className="w-10 h-10 text-blue-400 mx-auto mb-3" />
                      <h3 className="text-lg font-medium text-gray-700 mb-2">行動データがまだありません</h3>
                      <p className="text-sm text-gray-500">
                        選択中のサイトにトラッキングデータが蓄積されると、ここにページ別のパフォーマンス分析が表示されます。<br />
                        サイトにトラッキングスクリプトが正しく設置されていることを確認してください。
                      </p>
                    </div>
                  )}

                  {/* Summary Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-white rounded-lg border border-gray-200 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-gray-600">平均スコア</span>
                        <Zap className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className={`text-3xl font-bold ${data.summary.avg_score !== null ? getScoreColor(data.summary.avg_score) : 'text-gray-400'}`}>
                        {data.summary.avg_score !== null ? data.summary.avg_score : '—'}
                      </div>
                      <div className="text-sm text-gray-500 mt-1">Performance</div>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-gray-600">平均LCP</span>
                        <Clock className="w-5 h-5 text-amber-500" />
                      </div>
                      <div className={`text-3xl font-bold ${data.summary.avg_lcp !== null ? getMetricClass(data.summary.avg_lcp, 2.5, 4.0) : 'text-gray-400'}`}>
                        {data.summary.avg_lcp !== null ? `${data.summary.avg_lcp}s` : '—'}
                      </div>
                      <div className="text-sm text-gray-500 mt-1">目標: &lt; 2.5s</div>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-gray-600">問題ページ</span>
                        <AlertTriangle className="w-5 h-5 text-red-500" />
                      </div>
                      <div className={`text-3xl font-bold ${data.summary.problem_pages > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {data.summary.problem_pages}
                      </div>
                      <div className="text-sm text-gray-500 mt-1">Score &lt; 50 のページ</div>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-gray-600">平均CVR</span>
                        <CheckCircle className="w-5 h-5 text-green-600" />
                      </div>
                      <div className="text-3xl font-bold">{data.summary.avg_cvr}%</div>
                      <div className="text-sm text-gray-500 mt-1">全ページ平均</div>
                    </div>
                  </div>

                  {/* Page List Table */}
                  <div className="bg-white rounded-lg border border-gray-200">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h3 className="text-lg font-semibold">ページ別パフォーマンス一覧</h3>
                      <p className="text-sm text-gray-500 mt-1">行クリックでページ詳細を表示</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-gray-50">
                            <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">ページURL</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Score</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">LCP</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">CLS</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">INP</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">CVR</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Sessions</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Scroll到達</th>
                            <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Rage Click</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {data.pages.map((page) => (
                            <tr
                              key={page.url}
                              className="hover:bg-gray-50 cursor-pointer"
                              onClick={() => {
                                setSelectedPageUrl(page.url)
                                setActiveTab('detail')
                              }}
                            >
                              <td className="px-6 py-4 text-sm font-medium text-blue-600">{page.url}</td>
                              <td className="px-4 py-4 text-center">
                                {page.pagespeed ? (
                                  <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-bold ${getScoreBg(page.pagespeed.performance_score)}`}>
                                    {page.pagespeed.performance_score}
                                  </span>
                                ) : (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); measurePage(page.url) }}
                                    className="px-2 py-1 text-xs text-blue-600 border border-blue-300 rounded hover:bg-blue-50 flex items-center gap-1 mx-auto"
                                    disabled={measuringUrl !== null}
                                  >
                                    {measuringUrl === page.url ? (
                                      <><Loader2 className="w-3 h-3 animate-spin" /> 計測中</>
                                    ) : (
                                      '計測'
                                    )}
                                  </button>
                                )}
                              </td>
                              <td className="px-4 py-4 text-center text-sm">
                                {page.pagespeed ? (
                                  <span className={`font-medium ${getMetricClass(page.pagespeed.lcp, 2.5, 4.0)}`}>
                                    {page.pagespeed.lcp.toFixed(1)}s
                                  </span>
                                ) : '—'}
                              </td>
                              <td className="px-4 py-4 text-center text-sm">
                                {page.pagespeed ? (
                                  <span className={`font-medium ${getMetricClass(page.pagespeed.cls, 0.1, 0.25)}`}>
                                    {page.pagespeed.cls.toFixed(2)}
                                  </span>
                                ) : '—'}
                              </td>
                              <td className="px-4 py-4 text-center text-sm">
                                {page.pagespeed ? (
                                  <span className={`font-medium ${getMetricClass(page.pagespeed.inp, 200, 500)}`}>
                                    {Math.round(page.pagespeed.inp)}ms
                                  </span>
                                ) : '—'}
                              </td>
                              <td className={`px-4 py-4 text-center text-sm font-bold ${page.cvr >= 2 ? 'text-green-600' : page.cvr >= 1 ? 'text-amber-600' : 'text-red-600'}`}>
                                {page.cvr.toFixed(1)}%
                              </td>
                              <td className="px-4 py-4 text-center text-sm text-gray-700">
                                {page.sessions.toLocaleString()}
                              </td>
                              <td className="px-4 py-4 text-center text-sm text-gray-700">
                                {Math.round(page.avg_scroll_depth)}%
                              </td>
                              <td className={`px-4 py-4 text-center text-sm ${page.rage_clicks > 10 ? 'text-red-600 font-bold' : page.rage_clicks > 5 ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>
                                {page.rage_clicks}
                              </td>
                            </tr>
                          ))}
                          {data.pages.length === 0 && (
                            <tr>
                              <td colSpan={9} className="px-6 py-8 text-center text-gray-500">
                                データがありません
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Scatter Chart + Improvement Impact */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Scatter Chart */}
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                      <h3 className="text-lg font-semibold mb-2">Performance Score × CVR 相関</h3>
                      <p className="text-sm text-gray-500 mb-4">スコアが高いページほどCVRが高い傾向</p>
                      {scatterData.length >= 2 ? (
                        <>
                          <ResponsiveContainer width="100%" height={260}>
                            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" />
                              <XAxis
                                type="number"
                                dataKey="x"
                                name="Score"
                                domain={[0, 100]}
                                tick={{ fontSize: 12 }}
                                label={{ value: 'Performance Score', position: 'insideBottom', offset: -5, fontSize: 11 }}
                              />
                              <YAxis
                                type="number"
                                dataKey="y"
                                name="CVR"
                                unit="%"
                                tick={{ fontSize: 12 }}
                                label={{ value: 'CVR (%)', angle: -90, position: 'insideLeft', fontSize: 11 }}
                              />
                              <Tooltip
                                cursor={{ strokeDasharray: '3 3' }}
                                content={({ payload }) => {
                                  if (!payload || payload.length === 0) return null
                                  const d = payload[0].payload
                                  return (
                                    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-md text-sm">
                                      <p className="font-medium text-gray-900">{d.url}</p>
                                      <p className="text-gray-600">Score: {d.x}</p>
                                      <p className="text-gray-600">CVR: {d.y}%</p>
                                      <p className="text-gray-600">Sessions: {d.sessions}</p>
                                    </div>
                                  )
                                }}
                              />
                              <Scatter data={scatterData}>
                                {scatterData.map((entry, index) => (
                                  <Cell
                                    key={index}
                                    fill={entry.x >= 90 ? '#16a34a' : entry.x >= 50 ? '#f59e0b' : '#dc2626'}
                                    opacity={0.8}
                                  />
                                ))}
                              </Scatter>
                            </ScatterChart>
                          </ResponsiveContainer>
                          {correlation !== null && (
                            <div className="mt-3 flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-600">相関係数:</span>
                              <span className="text-sm font-bold text-blue-600">
                                {correlation.toFixed(2)}
                                {correlation >= 0.7 ? '（強い正の相関）' : correlation >= 0.4 ? '（中程度の正の相関）' : correlation > 0 ? '（弱い正の相関）' : '（相関なし）'}
                              </span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="bg-gray-50 rounded-lg p-8 text-center text-gray-500 text-sm">
                          散布図を表示するには2ページ以上のPageSpeedデータが必要です。<br />
                          各ページの「計測」ボタンをクリックしてデータを取得してください。
                        </div>
                      )}
                    </div>

                    {/* Improvement Impact */}
                    <div className="bg-white rounded-lg border border-gray-200 p-6">
                      <h3 className="text-lg font-semibold mb-2">改善インパクト試算 TOP3</h3>
                      <p className="text-sm text-gray-500 mb-4">パフォーマンス改善による推定CV増加数</p>
                      {improvements.length > 0 ? (
                        <div className="space-y-4">
                          {improvements.map((imp, i) => (
                            <div key={i} className={`${imp.score < 50 ? 'metric-poor' : 'metric-avg'} rounded-lg p-4`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium text-gray-900">{imp.url}</span>
                                <span className={`text-xs px-2 py-1 rounded-full font-medium ${getScoreBg(imp.score)}`}>
                                  Score: {imp.score}
                                </span>
                              </div>
                              <div className="text-sm text-gray-600 mb-2">
                                {imp.metric} {imp.current} → {imp.target} に改善した場合
                              </div>
                              <div className="flex items-center gap-4">
                                <div>
                                  <span className="text-xs text-gray-500">推定CVR</span>
                                  <div className="text-sm">
                                    <span className="text-red-600">{imp.estimatedCvrFrom}%</span>
                                    {' → '}
                                    <span className="text-green-600 font-bold">{imp.estimatedCvrTo}%</span>
                                  </div>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">推定CV増</span>
                                  <div className="text-lg font-bold text-green-600">+{imp.estimatedCvIncrease}件</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="bg-gray-50 rounded-lg p-8 text-center text-gray-500 text-sm">
                          PageSpeedデータが計測されると改善インパクトが表示されます。
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: ページ別 */}
              {activeTab === 'detail' && data && (
                <div className="p-6 space-y-6">
                  {/* Page Selector */}
                  <div className="flex items-center gap-4">
                    <label className="text-sm font-medium text-gray-700">ページ選択:</label>
                    <select
                      className="flex-1 max-w-md px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      value={selectedPageUrl}
                      onChange={(e) => setSelectedPageUrl(e.target.value)}
                    >
                      {data.pages.map(p => (
                        <option key={p.url} value={p.url}>
                          {p.url} {p.pagespeed ? `（Score: ${p.pagespeed.performance_score} | CVR: ${p.cvr.toFixed(1)}%）` : '（未計測）'}
                        </option>
                      ))}
                    </select>
                    {selectedPage && !selectedPage.pagespeed && (
                      <button
                        onClick={() => measurePage(selectedPage.url)}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center gap-2"
                        disabled={measuringUrl !== null}
                      >
                        {measuringUrl === selectedPage.url ? (
                          <><Loader2 className="w-4 h-4 animate-spin" /> 計測中...</>
                        ) : (
                          <><RefreshCw className="w-4 h-4" /> 計測</>
                        )}
                      </button>
                    )}
                  </div>

                  {selectedPage && (
                    <>
                      {/* Lighthouse Scores */}
                      {selectedPage.pagespeed ? (
                        <>
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                            {[
                              { label: 'Performance', score: selectedPage.pagespeed.performance_score },
                              { label: 'Accessibility', score: selectedPage.pagespeed.accessibility_score },
                              { label: 'Best Practices', score: selectedPage.pagespeed.best_practices_score },
                              { label: 'SEO', score: selectedPage.pagespeed.seo_score },
                            ].map(item => (
                              <div key={item.label} className="bg-white rounded-lg border border-gray-200 p-5 text-center">
                                <div className={`score-ring ${item.score >= 90 ? 'score-good' : item.score >= 50 ? 'score-average' : 'score-poor'} mx-auto mb-2`}>
                                  {item.score}
                                </div>
                                <div className="text-sm font-medium text-gray-700">{item.label}</div>
                              </div>
                            ))}
                          </div>

                          {/* Core Web Vitals */}
                          <div className="bg-white rounded-lg border border-gray-200 p-6">
                            <h3 className="text-lg font-semibold mb-4">Core Web Vitals</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              {/* LCP */}
                              <div className={`${getMetricBorder(selectedPage.pagespeed.lcp, 2.5, 4.0)} rounded-lg p-4`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-gray-700">LCP</span>
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${getMetricLabelBg(selectedPage.pagespeed.lcp, 2.5, 4.0)}`}>
                                    {getMetricLabel(selectedPage.pagespeed.lcp, 2.5, 4.0)}
                                  </span>
                                </div>
                                <div className={`text-2xl font-bold ${getMetricClass(selectedPage.pagespeed.lcp, 2.5, 4.0)}`}>
                                  {selectedPage.pagespeed.lcp.toFixed(1)}s
                                </div>
                                <div className="text-xs text-gray-500 mt-1">目標: &lt; 2.5s</div>
                                <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
                                  <div
                                    className={`h-1.5 rounded-full ${selectedPage.pagespeed.lcp <= 2.5 ? 'bg-green-500' : selectedPage.pagespeed.lcp <= 4.0 ? 'bg-amber-500' : 'bg-red-500'}`}
                                    style={{ width: `${Math.min(100, (selectedPage.pagespeed.lcp / 6) * 100)}%` }}
                                  />
                                </div>
                              </div>
                              {/* CLS */}
                              <div className={`${getMetricBorder(selectedPage.pagespeed.cls, 0.1, 0.25)} rounded-lg p-4`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-gray-700">CLS</span>
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${getMetricLabelBg(selectedPage.pagespeed.cls, 0.1, 0.25)}`}>
                                    {getMetricLabel(selectedPage.pagespeed.cls, 0.1, 0.25)}
                                  </span>
                                </div>
                                <div className={`text-2xl font-bold ${getMetricClass(selectedPage.pagespeed.cls, 0.1, 0.25)}`}>
                                  {selectedPage.pagespeed.cls.toFixed(2)}
                                </div>
                                <div className="text-xs text-gray-500 mt-1">目標: &lt; 0.1</div>
                                <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
                                  <div
                                    className={`h-1.5 rounded-full ${selectedPage.pagespeed.cls <= 0.1 ? 'bg-green-500' : selectedPage.pagespeed.cls <= 0.25 ? 'bg-amber-500' : 'bg-red-500'}`}
                                    style={{ width: `${Math.min(100, (selectedPage.pagespeed.cls / 0.5) * 100)}%` }}
                                  />
                                </div>
                              </div>
                              {/* INP */}
                              <div className={`${getMetricBorder(selectedPage.pagespeed.inp, 200, 500)} rounded-lg p-4`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-gray-700">INP</span>
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${getMetricLabelBg(selectedPage.pagespeed.inp, 200, 500)}`}>
                                    {getMetricLabel(selectedPage.pagespeed.inp, 200, 500)}
                                  </span>
                                </div>
                                <div className={`text-2xl font-bold ${getMetricClass(selectedPage.pagespeed.inp, 200, 500)}`}>
                                  {Math.round(selectedPage.pagespeed.inp)}ms
                                </div>
                                <div className="text-xs text-gray-500 mt-1">目標: &lt; 200ms</div>
                                <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
                                  <div
                                    className={`h-1.5 rounded-full ${selectedPage.pagespeed.inp <= 200 ? 'bg-green-500' : selectedPage.pagespeed.inp <= 500 ? 'bg-amber-500' : 'bg-red-500'}`}
                                    style={{ width: `${Math.min(100, (selectedPage.pagespeed.inp / 600) * 100)}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Additional Metrics: TBT / Speed Index / TTI */}
                          <div className="bg-white rounded-lg border border-gray-200 p-6">
                            <h3 className="text-lg font-semibold mb-4">その他のパフォーマンス指標</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div className={`${getMetricBorder(selectedPage.pagespeed.tbt, 200, 600)} rounded-lg p-4`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-gray-700">TBT</span>
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${getMetricLabelBg(selectedPage.pagespeed.tbt, 200, 600)}`}>
                                    {getMetricLabel(selectedPage.pagespeed.tbt, 200, 600)}
                                  </span>
                                </div>
                                <div className={`text-2xl font-bold ${getMetricClass(selectedPage.pagespeed.tbt, 200, 600)}`}>
                                  {Math.round(selectedPage.pagespeed.tbt)}ms
                                </div>
                                <div className="text-xs text-gray-500 mt-1">合計ブロック時間 / 目標: &lt; 200ms</div>
                              </div>
                              <div className={`${getMetricBorder(selectedPage.pagespeed.speed_index, 3.4, 5.8)} rounded-lg p-4`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-gray-700">Speed Index</span>
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${getMetricLabelBg(selectedPage.pagespeed.speed_index, 3.4, 5.8)}`}>
                                    {getMetricLabel(selectedPage.pagespeed.speed_index, 3.4, 5.8)}
                                  </span>
                                </div>
                                <div className={`text-2xl font-bold ${getMetricClass(selectedPage.pagespeed.speed_index, 3.4, 5.8)}`}>
                                  {selectedPage.pagespeed.speed_index.toFixed(1)}s
                                </div>
                                <div className="text-xs text-gray-500 mt-1">目標: &lt; 3.4s</div>
                              </div>
                              <div className={`${getMetricBorder(selectedPage.pagespeed.tti, 3.8, 7.3)} rounded-lg p-4`}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-gray-700">TTI</span>
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${getMetricLabelBg(selectedPage.pagespeed.tti, 3.8, 7.3)}`}>
                                    {getMetricLabel(selectedPage.pagespeed.tti, 3.8, 7.3)}
                                  </span>
                                </div>
                                <div className={`text-2xl font-bold ${getMetricClass(selectedPage.pagespeed.tti, 3.8, 7.3)}`}>
                                  {selectedPage.pagespeed.tti.toFixed(1)}s
                                </div>
                                <div className="text-xs text-gray-500 mt-1">操作可能時間 / 目標: &lt; 3.8s</div>
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
                          <Zap className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                          <h3 className="text-lg font-medium text-gray-700 mb-2">PageSpeedデータ未取得</h3>
                          <p className="text-sm text-gray-500 mb-4">「計測」ボタンをクリックしてPageSpeed Insightsのスコアを取得してください。</p>
                          <button
                            onClick={() => measurePage(selectedPage.url)}
                            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium inline-flex items-center gap-2"
                            disabled={measuringUrl !== null}
                          >
                            {measuringUrl === selectedPage.url ? (
                              <><Loader2 className="w-4 h-4 animate-spin" /> 計測中...</>
                            ) : (
                              <><RefreshCw className="w-4 h-4" /> PageSpeed計測</>
                            )}
                          </button>
                        </div>
                      )}

                      {/* Behavior Data */}
                      <div className="bg-white rounded-lg border border-gray-200 p-6">
                        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                          <LinkIcon className="w-5 h-5 text-blue-600" />
                          行動データとの相関（HeatClick連携）
                        </h3>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                          <div className="bg-gray-50 rounded-lg p-4">
                            <div className="text-sm text-gray-500 mb-1">セッション数</div>
                            <div className="text-xl font-bold">{selectedPage.sessions.toLocaleString()}</div>
                            <div className="text-xs text-gray-400">選択期間</div>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-4">
                            <div className="text-sm text-gray-500 mb-1">CVR</div>
                            <div className={`text-xl font-bold ${selectedPage.cvr >= (data.summary.avg_cvr || 0) ? 'text-green-600' : 'text-red-600'}`}>
                              {selectedPage.cvr.toFixed(1)}%
                            </div>
                            <div className="text-xs text-gray-400">サイト平均: {data.summary.avg_cvr}%</div>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-4">
                            <div className="text-sm text-gray-500 mb-1">スクロール到達率</div>
                            <div className={`text-xl font-bold ${selectedPage.avg_scroll_depth >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                              {Math.round(selectedPage.avg_scroll_depth)}%
                            </div>
                            <div className="text-xs text-gray-400">平均スクロール深度</div>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-4">
                            <div className="text-sm text-gray-500 mb-1">レイジクリック</div>
                            <div className={`text-xl font-bold ${selectedPage.rage_clicks > 10 ? 'text-red-600' : 'text-gray-900'}`}>
                              {selectedPage.rage_clicks}回
                            </div>
                            <div className="text-xs text-gray-400">異常クリック検知</div>
                          </div>
                        </div>

                        {/* Diagnostics */}
                        {diagnostics.length > 0 && (
                          <div className="space-y-3">
                            {diagnostics.map((diag, i) => (
                              <div
                                key={i}
                                className={`flex items-start gap-3 p-3 rounded-lg ${
                                  diag.level === 'error' ? 'bg-red-50' : 'bg-amber-50'
                                }`}
                              >
                                <AlertTriangle className={`w-5 h-5 mt-0.5 flex-shrink-0 ${
                                  diag.level === 'error' ? 'text-red-500' : 'text-amber-500'
                                }`} />
                                <div>
                                  <div className={`font-medium ${diag.level === 'error' ? 'text-red-800' : 'text-amber-800'}`}>
                                    {diag.title}
                                  </div>
                                  <div className={`text-sm mt-1 ${diag.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
                                    {diag.description}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {selectedPage.pagespeed && diagnostics.length === 0 && (
                          <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                            <CheckCircle className="w-5 h-5 text-green-500" />
                            <div className="font-medium text-green-800">
                              パフォーマンスと行動データに重大な問題は検出されませんでした。
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Audit Items - データ駆動の改善提案 */}
                      {selectedPage.pagespeed && selectedPage.pagespeed.audit_items && selectedPage.pagespeed.audit_items.length > 0 && (
                        <div className="bg-white rounded-lg border border-gray-200 p-6">
                          <h3 className="text-lg font-semibold mb-2">Lighthouse 監査項目</h3>
                          <p className="text-sm text-gray-500 mb-4">PageSpeed Insightsが検出した改善が必要な項目（スコア順）</p>
                          <div className="space-y-3">
                            {selectedPage.pagespeed.audit_items.map((audit, i) => {
                              const scorePercent = Math.round((audit.score ?? 0) * 100)
                              const isFailure = scorePercent < 50
                              const isWarning = scorePercent >= 50 && scorePercent < 90
                              return (
                                <div key={audit.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                                  <div className="flex items-center gap-4">
                                    <span className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${
                                      isFailure ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                                    }`}>
                                      {i + 1}
                                    </span>
                                    <div>
                                      <div className="font-medium text-gray-900">{audit.title}</div>
                                      {audit.displayValue && (
                                        <div className="text-sm text-gray-500 mt-0.5">{audit.displayValue}</div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <div className="w-20 bg-gray-200 rounded-full h-2">
                                      <div
                                        className={`h-2 rounded-full ${isFailure ? 'bg-red-500' : 'bg-amber-500'}`}
                                        style={{ width: `${scorePercent}%` }}
                                      />
                                    </div>
                                    <span className={`px-2 py-1 text-xs rounded font-medium min-w-[60px] text-center ${
                                      isFailure ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                                    }`}>
                                      {scorePercent}点
                                    </span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
