'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import {
  Image as ImageIcon,
  Loader2,
  AlertCircle,
  Globe,
  Eye,
  Clock,
  TrendingUp,
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

interface ImageData {
  image_src: string
  image_alt: string
  element_path: string
  image_y: number
  image_width: number
  image_height: number
  avg_duration_ms: number
  max_duration_ms: number
  total_duration_ms: number
  avg_max_ratio: number
  unique_sessions: number
  view_count: number
  view_rate: number
  visibility_score: number
}

type SortKey = 'visibility_score' | 'avg_duration_ms' | 'view_rate' | 'avg_max_ratio' | 'image_y'

export default function ImageVisibilityPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>('')
  const [data, setData] = useState<ImageData[]>([])
  const [totalSessions, setTotalSessions] = useState(0)
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')
  const [sortKey, setSortKey] = useState<SortKey>('visibility_score')
  const [sortAsc, setSortAsc] = useState(false)

  // サイトリスト取得
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
      } catch (err) {
        setError('サイト情報の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }
    fetchSites()
  }, [])

  // ページリスト取得
  useEffect(() => {
    if (!selectedSite) { setPages([]); setSelectedPageUrl(''); return }
    const fetchPages = async () => {
      try {
        const response = await fetch(`/api/pages?site_id=${selectedSite.tracking_id}`)
        if (!response.ok) throw new Error('Failed to fetch pages')
        const result = await response.json()
        const pageList = result.data || []
        setPages(pageList)
        setSelectedPageUrl(pageList.length > 0 ? pageList[0].url : '')
      } catch {
        setPages([])
        setSelectedPageUrl('')
      }
    }
    fetchPages()
  }, [selectedSite])

  // 画像視認データ取得
  useEffect(() => {
    if (!selectedSite) { setData([]); return }
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

        const response = await fetch(`/api/image-visibility?${params.toString()}`)
        if (!response.ok) throw new Error('Failed to fetch data')
        const result = await response.json()
        setData(result.data || [])
        setTotalSessions(result.total_sessions || 0)
      } catch {
        setData([])
        setError('画像視認データの取得に失敗しました')
      } finally {
        setDataLoading(false)
      }
    }
    fetchData()
  }, [selectedSite, selectedPageUrl, dateRange])

  // ソート
  const sortedData = [...data].sort((a, b) => {
    const diff = (a[sortKey] || 0) - (b[sortKey] || 0)
    return sortAsc ? diff : -diff
  })

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  // スコアに応じた色
  const scoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600 bg-green-50'
    if (score >= 50) return 'text-yellow-600 bg-yellow-50'
    if (score >= 20) return 'text-orange-600 bg-orange-50'
    return 'text-red-600 bg-red-50'
  }

  const scoreLabel = (score: number) => {
    if (score >= 80) return 'よく見られている'
    if (score >= 50) return 'まずまず'
    if (score >= 20) return '見られにくい'
    return 'ほぼスルー'
  }

  // 表示時間フォーマット
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  // 画像ファイル名を抽出
  const getImageName = (src: string) => {
    try {
      const url = new URL(src)
      const path = url.pathname
      return path.split('/').pop() || src
    } catch {
      return src.split('/').pop() || src
    }
  }

  // サマリー
  const avgScore = data.length > 0 ? Math.round(data.reduce((s, d) => s + d.visibility_score, 0) / data.length) : 0
  const avgDuration = data.length > 0 ? Math.round(data.reduce((s, d) => s + d.avg_duration_ms, 0) / data.length) : 0
  const avgViewRate = data.length > 0 ? Math.round(data.reduce((s, d) => s + d.view_rate, 0) / data.length * 10) / 10 : 0

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
          <h1 className="text-2xl font-bold">画像閲覧分析</h1>
          <p className="text-sm text-gray-500 mt-1">ページ内の各画像がどの程度ユーザーに見られているかを数値化</p>
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
                      <select value={selectedPageUrl}
                        onChange={(e) => setSelectedPageUrl(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">全ページ</option>
                        {pages.map(p => <option key={p.url} value={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '')} ({p.count.toLocaleString()})</option>)}
                      </select>
                    ) : <div className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-400">データなし</div>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* サマリーカード */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <ImageIcon className="w-4 h-4 text-blue-500" />
                    <span className="text-xs text-gray-500">画像数</span>
                  </div>
                  <p className="text-2xl font-bold">{data.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="w-4 h-4 text-green-500" />
                    <span className="text-xs text-gray-500">平均閲覧スコア</span>
                  </div>
                  <p className="text-2xl font-bold">{avgScore}<span className="text-sm text-gray-400">/100</span></p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="w-4 h-4 text-orange-500" />
                    <span className="text-xs text-gray-500">平均視認時間</span>
                  </div>
                  <p className="text-2xl font-bold">{formatDuration(avgDuration)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Eye className="w-4 h-4 text-purple-500" />
                    <span className="text-xs text-gray-500">平均閲覧率</span>
                  </div>
                  <p className="text-2xl font-bold">{avgViewRate}<span className="text-sm text-gray-400">%</span></p>
                </CardContent>
              </Card>
            </div>

            {/* データテーブル */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ImageIcon className="w-5 h-5" />
                  画像別閲覧ランキング
                  {dataLoading && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.length === 0 && !dataLoading ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <ImageIcon className="w-12 h-12 text-gray-300 mb-4" />
                    <p className="text-gray-500 mb-2">画像視認データがありません</p>
                    <p className="text-xs text-gray-400">トラッキングスクリプトが設置されたページにアクセスがあると、データが蓄積されます。</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left py-2 px-3 text-gray-500 font-medium w-8">#</th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium">画像</th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700"
                            onClick={() => handleSort('visibility_score')}>
                            <span className="flex items-center gap-1">スコア <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700"
                            onClick={() => handleSort('avg_duration_ms')}>
                            <span className="flex items-center gap-1">平均視認時間 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700"
                            onClick={() => handleSort('avg_max_ratio')}>
                            <span className="flex items-center gap-1">最大表示率 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700"
                            onClick={() => handleSort('view_rate')}>
                            <span className="flex items-center gap-1">閲覧率 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700"
                            onClick={() => handleSort('image_y')}>
                            <span className="flex items-center gap-1">Y座標 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedData.map((item, i) => (
                          <tr key={item.image_src} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-3 px-3 text-gray-400">{i + 1}</td>
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-3">
                                <div className="w-12 h-12 rounded border border-gray-200 overflow-hidden flex-shrink-0 bg-gray-50">
                                  <img
                                    src={item.image_src}
                                    alt={item.image_alt}
                                    className="w-full h-full object-cover"
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                  />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-gray-700 truncate max-w-[200px]" title={getImageName(item.image_src)}>
                                    {getImageName(item.image_src)}
                                  </p>
                                  {item.image_alt && (
                                    <p className="text-xs text-gray-400 truncate max-w-[200px]" title={item.image_alt}>
                                      {item.image_alt}
                                    </p>
                                  )}
                                  <p className="text-xs text-gray-300">{item.image_width}x{item.image_height}</p>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${scoreColor(item.visibility_score)}`}>
                                  {item.visibility_score}
                                </span>
                                <span className="text-xs text-gray-400">{scoreLabel(item.visibility_score)}</span>
                              </div>
                            </td>
                            <td className="py-3 px-3 font-medium">{formatDuration(item.avg_duration_ms)}</td>
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-2">
                                <div className="w-16 bg-gray-100 rounded-full h-2">
                                  <div
                                    className="bg-blue-500 h-2 rounded-full"
                                    style={{ width: `${Math.round(item.avg_max_ratio * 100)}%` }}
                                  />
                                </div>
                                <span className="text-xs text-gray-500">{Math.round(item.avg_max_ratio * 100)}%</span>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <span className="text-sm font-medium">{item.view_rate}%</span>
                              <span className="text-xs text-gray-400 ml-1">({item.unique_sessions}/{totalSessions})</span>
                            </td>
                            <td className="py-3 px-3 text-xs text-gray-500">{item.image_y.toLocaleString()}px</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
