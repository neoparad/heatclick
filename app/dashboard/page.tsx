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
  Calendar,
  Eye,
  Globe
} from 'lucide-react'
import KPICard from '../../components/ui/kpi-card'

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
  const [trafficSources, setTrafficSources] = useState<any>(null)
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

  // 流入元情報を取得
  useEffect(() => {
    if (!selectedSite) {
      setTrafficSources(null)
      return
    }

    const fetchTrafficSources = async () => {
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

        const response = await fetch(`/api/traffic-sources?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Failed to fetch traffic sources')
        }
        const data = await response.json()
        setTrafficSources(data.data || { referrers: [], utm_sources: [] })
      } catch (err) {
        console.error('Error fetching traffic sources:', err)
        setTrafficSources({ referrers: [], utm_sources: [] })
      }
    }

    fetchTrafficSources()
  }, [selectedSite, dateRange])

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
          <KPICard title="ページビュー数" value={kpiData.pageViews} icon={Eye} iconColor="text-blue-600"
            change={kpiData.pageViewsChange} description="アクセス数（ページビュー）" />
          <KPICard title="セッション数" value={kpiData.uniqueSessions} icon={Users} iconColor="text-green-600"
            change={kpiData.sessionsChange} description="ユニークセッション数" />
          <KPICard title="総クリック数" value={kpiData.totalClicks} icon={MousePointerClick} iconColor="text-purple-600"
            change={kpiData.clicksChange} description="全クリックイベントの合計" />
          <KPICard title="クリック率" value={`${kpiData.clickRate}%`} icon={Zap} iconColor="text-yellow-600"
            change={kpiData.clickRateChange} description="セッションあたりの平均クリック数" />
          <KPICard title="平均滞在時間"
            value={kpiData.avgTimeOnPage > 0 ? `${kpiData.avgTimeOnPage}分` : 'データなし'}
            icon={Clock} iconColor="text-green-600"
            change={kpiData.avgTimeOnPage > 0 ? kpiData.avgTimeOnPageChange : null}
            description={kpiData.avgTimeOnPage > 0 ? 'セッションあたりの平均滞在時間' : 'セッションデータがありません'} />
          <KPICard title="直帰率"
            value={kpiData.bounceRate > 0 ? `${kpiData.bounceRate}%` : 'データなし'}
            icon={TrendingDown} iconColor="text-red-600"
            change={kpiData.bounceRate > 0 ? kpiData.bounceRateChange : null}
            invertChangeColor={true}
            description={kpiData.bounceRate > 0 ? '1ページビューのセッション割合' : 'セッションデータがありません'} />
          <KPICard title="平均スクロール深度" value={`${kpiData.avgScrollDepth}%`}
            icon={Activity} iconColor="text-green-600"
            change={kpiData.avgScrollDepthChange} description="平均スクロール位置（0-100%）" />
          <KPICard title="総イベント数" value={kpiData.totalEvents} icon={BarChart3} iconColor="text-purple-600"
            change={kpiData.totalEventsChange} description="クリック・スクロール・ホバー" />
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

        {/* 流入元情報 */}
        {trafficSources && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* リファラー別統計 */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h3 className="text-lg font-semibold mb-4 flex items-center">
                <Globe className="w-5 h-5 mr-2" />
                流入元（リファラー）
              </h3>
              {trafficSources.referrers && trafficSources.referrers.length > 0 ? (
                <div className="space-y-3">
                  {trafficSources.referrers.slice(0, 10).map((ref: any, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-gray-900 truncate">
                          {ref.referrer === 'direct' || ref.referrer === '(direct)' ? '直接アクセス' : ref.referrer}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {Number(ref.sessions || 0).toLocaleString()} セッション · {Number(ref.page_views || 0).toLocaleString()} PV
                        </div>
                      </div>
                      <div className="ml-4 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-sm font-bold text-blue-600">
                            {((Number(ref.sessions || 0) / trafficSources.referrers.reduce((sum: number, r: any) => sum + Number(r.sessions || 0), 0)) * 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  リファラーデータがありません
                </div>
              )}
            </div>

            {/* UTMソース別統計 */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h3 className="text-lg font-semibold mb-4 flex items-center">
                <BarChart3 className="w-5 h-5 mr-2" />
                流入チャネル（UTMソース）
              </h3>
              {trafficSources.utm_sources && trafficSources.utm_sources.length > 0 ? (
                <div className="space-y-3">
                  {trafficSources.utm_sources.slice(0, 10).map((utm: any, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-gray-900 truncate">
                          {utm.utm_source === 'direct' || utm.utm_source === '(not set)' ? '直接アクセス' : utm.utm_source}
                          {utm.utm_medium && utm.utm_medium !== '(not set)' && (
                            <span className="text-xs text-gray-500 ml-2">/ {utm.utm_medium}</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {Number(utm.sessions || 0).toLocaleString()} セッション · {Number(utm.page_views || 0).toLocaleString()} PV
                        </div>
                      </div>
                      <div className="ml-4 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-sm font-bold text-green-600">
                            {((Number(utm.sessions || 0) / trafficSources.utm_sources.reduce((sum: number, u: any) => sum + Number(u.sessions || 0), 0)) * 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  UTMソースデータがありません
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
