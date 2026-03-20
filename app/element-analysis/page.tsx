'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent } from '../../components/ui/card'
import {
  Loader2,
  AlertCircle,
  Globe,
  MousePointerClick,
  Eye,
  Clock,
  TrendingDown,
  ArrowUpDown,
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

interface PageData {
  url: string
  count: number
}

interface ElementData {
  element_selector: string
  element_tag: string
  element_text: string
  page_url: string
  avg_y: number
  avg_visible_ms: number
  avg_visible_ratio: number
  impressions: number
  unique_sessions: number
  clicks: number
  click_rate: number
  visibility_to_click: number
}

interface Summary {
  total_elements: number
  avg_click_rate: number
  avg_visible_ms: number
  worst_cta: string | null
}

type SortKey = 'click_rate' | 'avg_visible_ms' | 'impressions' | 'avg_visible_ratio'

export default function ElementAnalysisPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>('')
  const [elements, setElements] = useState<ElementData[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')
  const [sortKey, setSortKey] = useState<SortKey>('click_rate')
  const [sortAsc, setSortAsc] = useState(true) // 低い順 = 改善優先度順

  useEffect(() => {
    const fetchSites = async () => {
      setLoading(true)
      try {
        const response = await fetch('/api/sites')
        if (!response.ok) throw new Error('Failed to fetch sites')
        const result = await response.json()
        const sitesList = result.sites || []
        setSites(sitesList)
        if (sitesList.length > 0) setSelectedSite(sitesList[0])
      } catch {
        setError('サイト情報の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }
    fetchSites()
  }, [])

  useEffect(() => {
    if (!selectedSite) { setPages([]); setSelectedPageUrl(''); return }
    const fetchPages = async () => {
      try {
        const response = await fetch(`/api/pages?site_id=${selectedSite.tracking_id}`)
        if (!response.ok) throw new Error('Failed')
        const result = await response.json()
        setPages(result.data || [])
        setSelectedPageUrl('')
      } catch { setPages([]) }
    }
    fetchPages()
  }, [selectedSite])

  useEffect(() => {
    if (!selectedSite) { setElements([]); setSummary(null); return }
    const fetchData = async () => {
      setDataLoading(true)
      setError(null)
      try {
        let startDate: string | undefined, endDate: string | undefined
        if (dateRange !== 'all') {
          const end = new Date(), start = new Date()
          start.setDate(start.getDate() - (dateRange === '7days' ? 7 : dateRange === '30days' ? 30 : 90))
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
        }
        const params = new URLSearchParams({ site_id: selectedSite.tracking_id })
        if (selectedPageUrl) params.append('page_url', selectedPageUrl)
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)

        const response = await fetch(`/api/element-analysis?${params.toString()}`)
        if (!response.ok) throw new Error('Failed')
        const result = await response.json()
        setElements(result.data?.elements || [])
        setSummary(result.data?.summary || null)
      } catch {
        setElements([])
        setError('CTA分析データの取得に失敗しました')
      } finally {
        setDataLoading(false)
      }
    }
    fetchData()
  }, [selectedSite, selectedPageUrl, dateRange])

  const sortedData = [...elements].sort((a, b) => {
    const diff = (a[sortKey] || 0) - (b[sortKey] || 0)
    return sortAsc ? diff : -diff
  })

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'click_rate') }
  }

  const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

  const clickRateColor = (rate: number) => {
    if (rate >= 10) return 'text-green-600 bg-green-50'
    if (rate >= 5) return 'text-yellow-600 bg-yellow-50'
    if (rate >= 1) return 'text-orange-600 bg-orange-50'
    return 'text-red-600 bg-red-50'
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400 mr-2" />
          <span className="text-gray-500">読み込み中...</span>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">CTA・要素分析</h1>
          <p className="text-sm text-gray-500 mt-1">CTA・バナー等の視認時間とクリック率を分析。見られているのにクリックされない要素を特定</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
          </div>
        )}

        {sites.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Globe className="w-12 h-12 text-gray-300 mb-4" />
              <p className="text-gray-500 mb-4">登録されているサイトがありません</p>
              <a href="/sites" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">サイトを登録する</a>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* フィルター */}
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">サイト</label>
                    <select value={selectedSite?.id || ''}
                      onChange={(e) => { const s = sites.find(s => s.id === e.target.value); if (s) setSelectedSite(s) }}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                      {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">期間</label>
                    <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                      <option value="7days">過去7日間</option>
                      <option value="30days">過去30日間</option>
                      <option value="90days">過去90日間</option>
                      <option value="all">全期間</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">ページ</label>
                    {pages.length > 0 ? (
                      <select value={selectedPageUrl} onChange={(e) => setSelectedPageUrl(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">全ページ</option>
                        {pages.map(p => <option key={p.url} value={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '')} ({p.count.toLocaleString()})</option>)}
                      </select>
                    ) : <div className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-400">データなし</div>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* サマリー */}
            {summary && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <MousePointerClick className="w-4 h-4 text-blue-500" />
                      <span className="text-xs text-gray-500">CTA要素数</span>
                    </div>
                    <p className="text-2xl font-bold">{summary.total_elements}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Eye className="w-4 h-4 text-green-500" />
                      <span className="text-xs text-gray-500">平均クリック率</span>
                    </div>
                    <p className="text-2xl font-bold">{summary.avg_click_rate}<span className="text-sm text-gray-400">%</span></p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Clock className="w-4 h-4 text-purple-500" />
                      <span className="text-xs text-gray-500">平均視認時間</span>
                    </div>
                    <p className="text-2xl font-bold">{formatDuration(summary.avg_visible_ms)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingDown className="w-4 h-4 text-red-500" />
                      <span className="text-xs text-gray-500">要改善CTA</span>
                    </div>
                    <p className="text-sm font-bold truncate">{summary.worst_cta || '-'}</p>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* テーブル */}
            {dataLoading ? (
              <Card>
                <CardContent className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400 mr-2" />
                  <span className="text-gray-500 text-sm">データを取得中...</span>
                </CardContent>
              </Card>
            ) : sortedData.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <MousePointerClick className="w-12 h-12 text-gray-300 mb-4" />
                  <p className="text-gray-500 mb-2">CTA要素データがありません</p>
                  <p className="text-xs text-gray-400">トラッキングスクリプトの <code className="bg-gray-100 px-1 rounded">data-extensions=&quot;element&quot;</code> が有効か確認してください</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-400 border-b border-gray-200">
                          <th className="text-left py-2 pr-3">要素</th>
                          <th className="text-left py-2 pr-3">テキスト</th>
                          <th className="text-right py-2 pr-3 cursor-pointer hover:text-gray-600" onClick={() => handleSort('avg_visible_ms')}>
                            <span className="inline-flex items-center gap-1">視認時間<ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-right py-2 pr-3 cursor-pointer hover:text-gray-600" onClick={() => handleSort('avg_visible_ratio')}>
                            <span className="inline-flex items-center gap-1">視認率<ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-right py-2 pr-3 cursor-pointer hover:text-gray-600" onClick={() => handleSort('click_rate')}>
                            <span className="inline-flex items-center gap-1">クリック率<ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-right py-2 pr-3 cursor-pointer hover:text-gray-600" onClick={() => handleSort('impressions')}>
                            <span className="inline-flex items-center gap-1">表示数<ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedData.map((el, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                            <td className="py-2.5 pr-3">
                              <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">{el.element_selector.substring(0, 40)}</code>
                            </td>
                            <td className="py-2.5 pr-3 text-gray-700 max-w-[200px] truncate">{el.element_text || '-'}</td>
                            <td className="py-2.5 pr-3 text-right">{formatDuration(el.avg_visible_ms)}</td>
                            <td className="py-2.5 pr-3 text-right">{el.avg_visible_ratio}%</td>
                            <td className="py-2.5 pr-3 text-right">
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${clickRateColor(el.click_rate)}`}>
                                {el.click_rate}%
                              </span>
                            </td>
                            <td className="py-2.5 pr-3 text-right text-gray-500">{el.impressions.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
