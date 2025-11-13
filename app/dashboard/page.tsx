'use client'

import React, { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import {
  BarChart3,
  MousePointerClick,
  Zap,
  TrendingUp,
  TrendingDown,
  Clock,
  Users,
  Activity,
  Settings,
  FileText,
  Brain,
  ChevronDown,
  Calendar,
  Download,
  Filter,
  Search,
  Eye,
  Map,
  Globe
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string  // APIはurlを返す
  domain?: string  // 後方互換性のため残す
  tracking_id: string
  created_at: string
}

interface Statistics {
  total_events: number
  clicks: number
  scrolls: number
  hovers: number
  page_views?: number
  unique_sessions: number
  avg_scroll_depth: number
  desktop_events: number
  tablet_events: number
  mobile_events: number
  avg_time_on_page?: number
  bounce_rate?: number
  total_sessions?: number
  bounce_sessions?: number
  first_event_time?: string
  last_event_time?: string
}

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [statistics, setStatistics] = useState<Statistics | null>(null)
  const [previousStatistics, setPreviousStatistics] = useState<Statistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('all')

  // サイトリストを取得
  useEffect(() => {
    const fetchSites = async () => {
      try {
        const response = await fetch('/api/sites')
        if (!response.ok) {
          throw new Error('Failed to fetch sites')
        }
        const data = await response.json()
        setSites(data.sites || [])
        if (data.sites && data.sites.length > 0) {
          setSelectedSite(data.sites[0])
        }
      } catch (err) {
        console.error('Error fetching sites:', err)
        setError('サイト情報の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }

    fetchSites()
  }, [])

  // 選択されたサイトの統計を取得
  useEffect(() => {
    if (!selectedSite) {
      setStatistics(null)
      return
    }

    const fetchStatistics = async () => {
      try {
        setError(null)
        // 期間の計算
        let startDate: string | undefined = undefined
        let endDate: string | undefined = undefined
        let prevStartDate: string | undefined = undefined
        let prevEndDate: string | undefined = undefined
        
        if (dateRange !== 'all') {
          const end = new Date()
          const start = new Date()
          let days = 0
          
          switch (dateRange) {
            case '7days':
              days = 7
              start.setDate(start.getDate() - 7)
              break
            case '30days':
              days = 30
              start.setDate(start.getDate() - 30)
              break
            case '90days':
              days = 90
              start.setDate(start.getDate() - 90)
              break
          }
          
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
          
          // 前期間の計算（同じ日数分、前の期間）
          const prevEnd = new Date(start)
          prevEnd.setDate(prevEnd.getDate() - 1) // 現在期間の1日前まで
          const prevStart = new Date(prevEnd)
          prevStart.setDate(prevStart.getDate() - days + 1) // 同じ日数分前
          
          prevStartDate = prevStart.toISOString().split('T')[0]
          prevEndDate = prevEnd.toISOString().split('T')[0]
        }
        
        // 現在期間の統計を取得
        const params = new URLSearchParams({
          site_id: selectedSite.tracking_id,
        })
        
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)
        
        const response = await fetch(`/api/statistics?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Failed to fetch statistics')
        }
        const data = await response.json()
        setStatistics(data.data || null)
        
        // 前期間の統計を取得（期間選択時のみ）
        if (dateRange !== 'all' && prevStartDate && prevEndDate) {
          const prevParams = new URLSearchParams({
            site_id: selectedSite.tracking_id,
            start_date: prevStartDate,
            end_date: prevEndDate,
          })
          
          const prevResponse = await fetch(`/api/statistics?${prevParams.toString()}`)
          if (prevResponse.ok) {
            const prevData = await prevResponse.json()
            setPreviousStatistics(prevData.data || null)
          } else {
            setPreviousStatistics(null)
          }
        } else {
          setPreviousStatistics(null)
        }
      } catch (err) {
        console.error('Error fetching statistics:', err)
        setError('統計情報の取得に失敗しました')
        setStatistics(null)
        setPreviousStatistics(null)
      }
    }

    fetchStatistics()
  }, [selectedSite, dateRange])

  // 期間表示の文字列を生成
  const getDateRangeText = () => {
    switch (dateRange) {
      case 'all':
        return '全期間'
      case '7days':
        return '過去7日間'
      case '30days':
        return '過去30日間'
      case '90days':
        return '過去90日間'
      default:
        return '過去30日間'
    }
  }

  // データ期間の表示
  const getDataPeriodText = () => {
    if (!statistics || !statistics.first_event_time || !statistics.last_event_time) {
      return null
    }
    
    const firstDate = new Date(statistics.first_event_time)
    const lastDate = new Date(statistics.last_event_time)
    
    const formatDate = (date: Date) => {
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    }
    
    if (firstDate.getTime() === lastDate.getTime()) {
      return formatDate(firstDate)
    }
    
    return `${formatDate(firstDate)} ～ ${formatDate(lastDate)}`
  }

  // 増減率を計算する関数
  const calculateChange = (current: number, previous: number): { value: string; isPositive: boolean } => {
    if (!previous || previous === 0) {
      return { value: 'N/A', isPositive: false }
    }
    const change = ((current - previous) / previous) * 100
    const isPositive = change >= 0
    return {
      value: `${isPositive ? '+' : ''}${change.toFixed(1)}%`,
      isPositive
    }
  }

  // KPIデータを計算（前期間との比較を含む）
  const kpiData = statistics ? {
    totalClicks: Number(statistics.clicks) || 0,
    pageViews: Number(statistics.page_views) || 0,
    clickRate: statistics.unique_sessions > 0 
      ? ((Number(statistics.clicks) / Number(statistics.unique_sessions)) * 100).toFixed(1) 
      : '0',
    avgTimeOnPage: Number(statistics.avg_time_on_page) || 0,
    bounceRate: Number(statistics.bounce_rate) || 0,
    uniqueSessions: Number(statistics.unique_sessions) || 0,
    avgScrollDepth: Math.min(100, Math.max(0, Number(statistics.avg_scroll_depth) || 0)).toFixed(1),
    totalEvents: Number(statistics.total_events) || 0,
    // 前期間との比較
    clicksChange: previousStatistics 
      ? calculateChange(Number(statistics.clicks) || 0, Number(previousStatistics.clicks) || 0)
      : null,
    pageViewsChange: previousStatistics 
      ? calculateChange(Number(statistics.page_views) || 0, Number(previousStatistics.page_views) || 0)
      : null,
    sessionsChange: previousStatistics 
      ? calculateChange(Number(statistics.unique_sessions) || 0, Number(previousStatistics.unique_sessions) || 0)
      : null,
    clickRateChange: previousStatistics && previousStatistics.unique_sessions > 0
      ? calculateChange(
          parseFloat(statistics.unique_sessions > 0 
            ? ((Number(statistics.clicks) / Number(statistics.unique_sessions)) * 100).toFixed(1) 
            : '0'),
          parseFloat(((Number(previousStatistics.clicks) / Number(previousStatistics.unique_sessions)) * 100).toFixed(1))
        )
      : null,
    avgTimeOnPageChange: previousStatistics 
      ? calculateChange(Number(statistics.avg_time_on_page) || 0, Number(previousStatistics.avg_time_on_page) || 0)
      : null,
    bounceRateChange: previousStatistics 
      ? calculateChange(Number(statistics.bounce_rate) || 0, Number(previousStatistics.bounce_rate) || 0)
      : null,
    avgScrollDepthChange: previousStatistics 
      ? calculateChange(
          parseFloat(Math.min(100, Math.max(0, Number(statistics.avg_scroll_depth) || 0)).toFixed(1)),
          parseFloat(Math.min(100, Math.max(0, Number(previousStatistics.avg_scroll_depth) || 0)).toFixed(1))
        )
      : null,
    totalEventsChange: previousStatistics 
      ? calculateChange(Number(statistics.total_events) || 0, Number(previousStatistics.total_events) || 0)
      : null,
  } : {
    totalClicks: 0,
    pageViews: 0,
    clickRate: '0',
    avgTimeOnPage: 0,
    bounceRate: 0,
    uniqueSessions: 0,
    avgScrollDepth: '0',
    totalEvents: 0,
    clicksChange: null,
    pageViewsChange: null,
    sessionsChange: null,
    clickRateChange: null,
    avgTimeOnPageChange: null,
    bounceRateChange: null,
    avgScrollDepthChange: null,
    totalEventsChange: null,
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">読み込み中...</div>
        </div>
      </DashboardLayout>
    )
  }

  if (sites.length === 0) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-64 space-y-4">
          <div className="text-gray-500">登録されているサイトがありません</div>
          <a
            href="/sites"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            サイトを登録する
          </a>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* サイト選択と期間選択 */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                サイトを選択
              </label>
              <select
                value={selectedSite?.id || ''}
                onChange={(e) => {
                  const site = sites.find(s => s.id === e.target.value)
                  if (site) setSelectedSite(site)
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.url || site.domain || 'N/A'})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                期間を選択
              </label>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as 'all' | '7days' | '30days' | '90days')}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="7days">過去7日間</option>
                <option value="30days">過去30日間</option>
                <option value="90days">過去90日間</option>
                <option value="all">全期間</option>
              </select>
            </div>
          </div>
          {getDataPeriodText() && (
            <div className="mt-3 text-sm text-gray-600">
              <Calendar className="w-4 h-4 inline mr-1" />
              データ期間: {getDataPeriodText()} ({getDateRangeText()})
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
            {error}
          </div>
        )}

        {/* KPIカード */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 lg:gap-6">
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">ページビュー数</span>
              <Eye className="w-5 h-5 text-blue-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.pageViews.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.pageViewsChange && (
                <div className={`flex items-center gap-1 ${kpiData.pageViewsChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.pageViewsChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.pageViewsChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.pageViewsChange && (
                <span className="text-gray-500">アクセス数（ページビュー）</span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">セッション数</span>
              <Users className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.uniqueSessions.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.sessionsChange && (
                <div className={`flex items-center gap-1 ${kpiData.sessionsChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.sessionsChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.sessionsChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.sessionsChange && (
                <span className="text-gray-500">ユニークセッション数</span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">総クリック数</span>
              <MousePointerClick className="w-5 h-5 text-purple-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.totalClicks.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.clicksChange && (
                <div className={`flex items-center gap-1 ${kpiData.clicksChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.clicksChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.clicksChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.clicksChange && (
                <span className="text-gray-500">全クリックイベントの合計</span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">クリック率</span>
              <Zap className="w-5 h-5 text-yellow-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.clickRate}%</div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.clickRateChange && (
                <div className={`flex items-center gap-1 ${kpiData.clickRateChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.clickRateChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.clickRateChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.clickRateChange && (
                <span className="text-gray-500">セッションあたりの平均クリック数</span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">平均滞在時間</span>
              <Clock className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold mb-2">
              {kpiData.avgTimeOnPage > 0 ? `${kpiData.avgTimeOnPage}分` : 'データなし'}
            </div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.avgTimeOnPageChange && kpiData.avgTimeOnPage > 0 && (
                <div className={`flex items-center gap-1 ${kpiData.avgTimeOnPageChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.avgTimeOnPageChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.avgTimeOnPageChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.avgTimeOnPageChange && (
                <span className="text-gray-500">
                  {kpiData.avgTimeOnPage > 0 
                    ? 'セッションあたりの平均滞在時間' 
                    : 'セッションデータがありません'}
                </span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">直帰率</span>
              <TrendingDown className="w-5 h-5 text-red-600" />
            </div>
            <div className="text-3xl font-bold mb-2">
              {kpiData.bounceRate > 0 ? `${kpiData.bounceRate}%` : 'データなし'}
            </div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.bounceRateChange && kpiData.bounceRate > 0 && (
                <div className={`flex items-center gap-1 ${kpiData.bounceRateChange.isPositive ? 'text-red-600' : 'text-green-600'}`}>
                  {/* 直帰率は低い方が良いので、増加は赤、減少は緑 */}
                  {kpiData.bounceRateChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.bounceRateChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.bounceRateChange && (
                <span className="text-gray-500">
                  {kpiData.bounceRate > 0 
                    ? '1ページビューのセッション割合' 
                    : 'セッションデータがありません'}
                </span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">平均スクロール深度</span>
              <Activity className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.avgScrollDepth}%</div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.avgScrollDepthChange && (
                <div className={`flex items-center gap-1 ${kpiData.avgScrollDepthChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.avgScrollDepthChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.avgScrollDepthChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.avgScrollDepthChange && (
                <span className="text-gray-500">ページビューあたりの平均スクロール位置（0-100%）</span>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">総イベント数</span>
              <BarChart3 className="w-5 h-5 text-purple-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.totalEvents.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              {kpiData.totalEventsChange && (
                <div className={`flex items-center gap-1 ${kpiData.totalEventsChange.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                  {kpiData.totalEventsChange.isPositive ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  <span className="font-medium">{kpiData.totalEventsChange.value}</span>
                  <span className="text-gray-500">vs 前期間</span>
                </div>
              )}
              {!kpiData.totalEventsChange && (
                <span className="text-gray-500">クリック・スクロール・ホバー</span>
              )}
            </div>
          </div>
        </div>

        {/* データがない場合のメッセージ */}
        {statistics && statistics.total_events === 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-blue-900 mb-2">
              トラッキングタグを設置してデータ収集を開始しましょう
            </h3>
            <p className="text-blue-700 mb-4">
              現在、このサイトのデータがありません。サイト管理ページからトラッキングコードをコピーして、Webサイトに設置してください。
            </p>
            <a
              href="/sites"
              className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              サイト管理ページへ
            </a>
          </div>
        )}

        {/* デバイス内訳 */}
        {statistics && statistics.total_events > 0 && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-lg font-semibold mb-4">デバイス別イベント数</h3>
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-600">デスクトップ</span>
                  <span className="text-sm font-bold">{statistics.desktop_events.toLocaleString()}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full"
                    style={{ width: `${(statistics.desktop_events / statistics.total_events) * 100}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-600">タブレット</span>
                  <span className="text-sm font-bold">{statistics.tablet_events.toLocaleString()}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-green-600 h-2 rounded-full"
                    style={{ width: `${(statistics.tablet_events / statistics.total_events) * 100}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-600">モバイル</span>
                  <span className="text-sm font-bold">{statistics.mobile_events.toLocaleString()}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-yellow-600 h-2 rounded-full"
                    style={{ width: `${(statistics.mobile_events / statistics.total_events) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* イベント種別内訳 */}
        {statistics && statistics.total_events > 0 && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-lg font-semibold mb-4">イベント種別</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <div className="text-sm font-medium text-blue-900 mb-1">クリック</div>
                <div className="text-2xl font-bold text-blue-600">{statistics.clicks.toLocaleString()}</div>
              </div>
              <div className="p-4 bg-green-50 rounded-lg">
                <div className="text-sm font-medium text-green-900 mb-1">スクロール</div>
                <div className="text-2xl font-bold text-green-600">{statistics.scrolls.toLocaleString()}</div>
              </div>
              <div className="p-4 bg-yellow-50 rounded-lg">
                <div className="text-sm font-medium text-yellow-900 mb-1">ホバー</div>
                <div className="text-2xl font-bold text-yellow-600">{statistics.hovers.toLocaleString()}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
