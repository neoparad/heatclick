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
  domain: string
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')

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
    if (!selectedSite) return

    const fetchStatistics = async () => {
      try {
        // 期間の計算
        let startDate: string | undefined = undefined
        let endDate: string | undefined = undefined
        
        if (dateRange !== 'all') {
          const end = new Date()
          const start = new Date()
          
          switch (dateRange) {
            case '7days':
              start.setDate(start.getDate() - 7)
              break
            case '30days':
              start.setDate(start.getDate() - 30)
              break
            case '90days':
              start.setDate(start.getDate() - 90)
              break
          }
          
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
        }
        
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
      } catch (err) {
        console.error('Error fetching statistics:', err)
        setError('統計情報の取得に失敗しました')
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

  // KPIデータを計算
  const kpiData = statistics ? {
    totalClicks: Number(statistics.clicks) || 0,
    pageViews: Number(statistics.page_views) || 0,
    // クリック率: 総クリック数 / ユニークセッション数 * 100（セッションあたりの平均クリック数）
    clickRate: statistics.unique_sessions > 0 
      ? ((Number(statistics.clicks) / Number(statistics.unique_sessions)) * 100).toFixed(1) 
      : '0',
    avgTimeOnPage: Number(statistics.avg_time_on_page) || 0,
    bounceRate: Number(statistics.bounce_rate) || 0,
    uniqueSessions: Number(statistics.unique_sessions) || 0,
    // 平均スクロール深度: 0-100%の範囲で表示
    avgScrollDepth: Math.min(100, Math.max(0, Number(statistics.avg_scroll_depth) || 0)).toFixed(1),
  } : {
    totalClicks: 0,
    pageViews: 0,
    clickRate: '0',
    avgTimeOnPage: 0,
    bounceRate: 0,
    uniqueSessions: 0,
    avgScrollDepth: '0',
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
                    {site.name} ({site.domain})
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
              <span className="text-gray-500">アクセス数（ページビュー）</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">セッション数</span>
              <Users className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.uniqueSessions.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-gray-500">ユニークセッション数</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">総クリック数</span>
              <MousePointerClick className="w-5 h-5 text-purple-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.totalClicks.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-gray-500">全クリックイベントの合計</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">クリック率</span>
              <Zap className="w-5 h-5 text-yellow-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.clickRate}%</div>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-gray-500">セッションあたりの平均クリック数</span>
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
              <span className="text-gray-500">
                {kpiData.avgTimeOnPage > 0 
                  ? 'セッションあたりの平均滞在時間' 
                  : 'セッションデータがありません'}
              </span>
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
              <span className="text-gray-500">
                {kpiData.bounceRate > 0 
                  ? '1ページビューのセッション割合' 
                  : 'セッションデータがありません'}
              </span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">平均スクロール深度</span>
              <Activity className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.avgScrollDepth}%</div>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-gray-500">ページビューあたりの平均スクロール位置（0-100%）</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">総イベント数</span>
              <BarChart3 className="w-5 h-5 text-purple-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{(statistics?.total_events || 0).toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-gray-500">クリック・スクロール・ホバー</span>
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
