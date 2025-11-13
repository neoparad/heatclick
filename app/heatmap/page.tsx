'use client'

import { useState, useEffect, useRef } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import {
  Map,
  MousePointer,
  Eye,
  ScrollText,
  Download,
  Filter,
  Globe,
  BarChart3,
  Calendar
} from 'lucide-react'
import dynamic from 'next/dynamic'

// Dynamically import heatmap.js to avoid SSR issues
let h337: any = null
let heatmapLoadError: Error | null = null

if (typeof window !== 'undefined') {
  try {
    h337 = require('heatmap.js')
    heatmapLoadError = null
  } catch (error) {
    console.error('Failed to load heatmap.js:', error)
    heatmapLoadError = error as Error
  }
}

interface Site {
  id: string
  name: string
  url: string  // APIはurlを返す
  domain?: string  // 後方互換性のため残す
  tracking_id: string
  created_at: string
}

interface PageData {
  url: string
  count: number
}

interface HeatmapPoint {
  click_x: number
  click_y: number
  element_tag_name?: string
  element_id?: string
  element_class_name?: string
  count?: number
  click_count?: number
}

export default function HeatmapPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>('')
  const [heatmapData, setHeatmapData] = useState<HeatmapPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerHeight, setContainerHeight] = useState(3000)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('all')
  const heatmapContainerRef = useRef<HTMLDivElement>(null)
  const heatmapInstanceRef = useRef<any>(null)

  // サイトリストを取得
  useEffect(() => {
    const fetchSites = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch('/api/sites')
        if (!response.ok) {
          throw new Error('Failed to fetch sites')
        }
        const data = await response.json()
        const sitesList = data.sites || []
        setSites(sitesList)
        if (sitesList.length > 0) {
          setSelectedSite(sitesList[0])
        } else {
          setError('登録されているサイトがありません')
        }
      } catch (err) {
        console.error('Error fetching sites:', err)
        setError('サイト情報の取得に失敗しました')
        setSites([])
      } finally {
        setLoading(false)
      }
    }

    fetchSites()
  }, [])

  // 選択されたサイトのページURLリストを取得
  useEffect(() => {
    if (!selectedSite) {
      setPages([])
      setSelectedPageUrl('')
      return
    }

    const fetchPages = async () => {
      try {
        const response = await fetch(`/api/pages?site_id=${selectedSite.tracking_id}`)
        if (!response.ok) {
          throw new Error('Failed to fetch pages')
        }
        const data = await response.json()
        const pageList = data.data || []
        setPages(pageList)
        if (pageList.length > 0) {
          setSelectedPageUrl(pageList[0].url)
        } else {
          // ページが空の場合はselectedPageUrlをリセット
          setSelectedPageUrl('')
        }
      } catch (err) {
        console.error('Error fetching pages:', err)
        setPages([])
        setSelectedPageUrl('')
      }
    }

    fetchPages()
  }, [selectedSite])

  // ヒートマップデータを取得
  useEffect(() => {
    if (!selectedSite || !selectedPageUrl) {
      setHeatmapData([])
      setError(null)
      return
    }

    const fetchHeatmap = async () => {
      setError(null)
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
          page_url: selectedPageUrl,
        })
        
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)

        const url = `/api/heatmap?${params.toString()}`
        console.log('Fetching heatmap data from:', url)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`Failed to fetch heatmap data: ${response.status} ${response.statusText}`)
        }
        const data = await response.json()
        console.log('Heatmap data received:', data.data?.length || 0, 'points')
        const heatmapPoints = data.data || []
        setHeatmapData(heatmapPoints)

        // ヒートマップデータから最大のY座標を取得して高さを設定
        if (heatmapPoints.length > 0) {
          const maxY = Math.max(...heatmapPoints.map((p: HeatmapPoint) => p.click_y || 0))
          // 余裕を持って+500px、最低3000px
          const calculatedHeight = Math.max(maxY + 500, 3000)
          setContainerHeight(calculatedHeight)
          console.log('Container height set to:', calculatedHeight, 'based on max Y:', maxY)
        }

        setError(null)
      } catch (err) {
        console.error('Error fetching heatmap:', err)
        setHeatmapData([])
        setError('ヒートマップデータの取得に失敗しました。データが存在しない可能性があります。')
      }
    }

    fetchHeatmap()
  }, [selectedSite, selectedPageUrl, dateRange])

  // ヒートマップを描画
  useEffect(() => {
    // heatmap.jsがロードされていない場合のエラーメッセージ
    if (!h337 && heatmapLoadError) {
      console.error('heatmap.js is not loaded:', heatmapLoadError)
      return
    }

    if (!h337 || !heatmapContainerRef.current || heatmapData.length === 0) {
      // データがない場合は既存のキャンバスをクリーンアップ
      if (heatmapContainerRef.current) {
        const canvas = heatmapContainerRef.current.querySelector('canvas')
        if (canvas) {
          canvas.remove()
        }
      }
      return
    }

    // 既存のヒートマップインスタンスをクリーンアップ
    if (heatmapInstanceRef.current) {
      const canvas = heatmapContainerRef.current.querySelector('canvas')
      if (canvas) {
        canvas.remove()
      }
      heatmapInstanceRef.current = null
    }

    // 少し遅延させてコンテナのサイズが確定してから描画
    const timer = setTimeout(() => {
      if (!heatmapContainerRef.current) return

      try {
        // ヒートマップインスタンスを作成
        const heatmapInstance = h337.create({
          container: heatmapContainerRef.current,
          radius: 40,
          maxOpacity: 0.6,
          minOpacity: 0,
          blur: 0.75,
        })

        // データポイントを変換（有効な座標のみ）
        const points = heatmapData
          .filter(point => 
            typeof point.click_x === 'number' && 
            typeof point.click_y === 'number' &&
            !isNaN(point.click_x) && 
            !isNaN(point.click_y) &&
            point.click_x >= 0 && 
            point.click_y >= 0
          )
          .map(point => ({
            x: Math.round(point.click_x),
            y: Math.round(point.click_y),
            value: point.count || point.click_count || 1,
          }))

        if (points.length === 0) {
          console.warn('No valid heatmap points to display')
          return
        }

        // 最大値を計算
        const maxValue = Math.max(...points.map(p => p.value), 1)

        // データを設定
        heatmapInstance.setData({
          max: maxValue,
          data: points,
        })

        heatmapInstanceRef.current = heatmapInstance
        console.log('Heatmap rendered with', points.length, 'points')
      } catch (error) {
        console.error('Error setting heatmap data:', error)
      }
    }, 100)

    return () => {
      clearTimeout(timer)
      if (heatmapInstanceRef.current) {
        const canvas = heatmapContainerRef.current?.querySelector('canvas')
        if (canvas) {
          canvas.remove()
        }
        heatmapInstanceRef.current = null
      }
    }
  }, [heatmapData])

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">読み込み中...</div>
        </div>
      </DashboardLayout>
    )
  }

  // エラーが発生した場合でもページは表示する（エラーメッセージを表示）
  // sites.length === 0の場合は、エラーメッセージまたは空の状態を表示

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* ヘッダー */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold mb-1">ヒートマップ分析</h1>
            <p className="text-gray-600">クリック位置を可視化してユーザー行動を理解</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              <Filter className="w-4 h-4 mr-2" />
              フィルター
            </Button>
            <Button variant="outline" size="sm">
              <Download className="w-4 h-4 mr-2" />
              エクスポート
            </Button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
            {error}
          </div>
        )}

        {sites.length === 0 && !loading && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="text-gray-500 mb-4">登録されているサイトがありません</div>
              <a
                href="/sites"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                サイトを登録する
              </a>
            </CardContent>
          </Card>
        )}

        {/* サイト選択と期間選択 */}
        {sites.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>フィルター</CardTitle>
              <CardDescription>サイト、期間、ページを選択してヒートマップを表示</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <Globe className="w-4 h-4 inline mr-2" />
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
                    <Calendar className="w-4 h-4 inline mr-2" />
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
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <Map className="w-4 h-4 inline mr-2" />
                    ページを選択
                  </label>
                  {pages.length > 0 ? (
                    <select
                      value={selectedPageUrl}
                      onChange={(e) => setSelectedPageUrl(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      {pages.map((page) => (
                        <option key={page.url} value={page.url}>
                          {page.url} ({page.count.toLocaleString()} イベント)
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="px-4 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500 text-sm">
                      ページデータがありません
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* サイト選択（旧バージョン - 削除予定） */}
        {false && sites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>サイトとページを選択</CardTitle>
            <CardDescription>ヒートマップを表示するサイトとページを選択してください</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <Globe className="w-4 h-4 inline mr-2" />
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

            {pages.length === 0 && selectedSite && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-700">
                このサイトにはまだページデータがありません。トラッキングタグが正しく設置されているか確認してください。
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* ヒートマップ表示エリア */}
        {sites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <MousePointer className="w-5 h-5 inline mr-2" />
              クリックヒートマップ
            </CardTitle>
            <CardDescription>
              {selectedPageUrl || 'ページを選択してください'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedPageUrl ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-8 text-center">
                <BarChart3 className="w-12 h-12 text-yellow-600 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-yellow-900 mb-2">
                  ページを選択してください
                </h3>
                <p className="text-yellow-700">
                  上記の「ページを選択」ドロップダウンからページを選択すると、ヒートマップが表示されます。
                </p>
              </div>
            ) : heatmapData.length === 0 ? (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-8 text-center">
                <BarChart3 className="w-12 h-12 text-blue-600 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-blue-900 mb-2">
                  このページのヒートマップデータがありません
                </h3>
                <p className="text-blue-700 mb-4">
                  トラッキングタグが正しく設置されているか、データが蓄積されるまでお待ちください。
                </p>
                <a
                  href="/sites"
                  className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  サイト管理ページへ
                </a>
              </div>
            ) : !h337 ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-8 text-center">
                <BarChart3 className="w-12 h-12 text-red-600 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-red-900 mb-2">
                  ヒートマップライブラリの読み込みに失敗しました
                </h3>
                <p className="text-red-700 mb-4">
                  heatmap.jsが正しくインストールされていない可能性があります。ページをリロードしてください。
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="inline-block px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                >
                  ページをリロード
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <h4 className="font-semibold mb-2">クリックポイント統計</h4>
                  <div className="text-sm text-gray-600">
                    総クリック数: {heatmapData.reduce((sum, point) => sum + (point.count || point.click_count || 0), 0).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-600">
                    クリックポイント数: {heatmapData.length.toLocaleString()}
                  </div>
                </div>

                {/* ヒートマップビジュアライゼーション */}
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="p-4 border-b border-gray-200">
                    <h4 className="font-semibold flex items-center">
                      <Eye className="w-4 h-4 mr-2" />
                      クリックヒートマップ
                    </h4>
                    <p className="text-sm text-gray-600 mt-1">
                      赤い領域ほどクリックが集中しています
                    </p>
                  </div>
                  <div className="relative bg-white" style={{ width: '100%', height: `${containerHeight}px` }}>
                    {/* 実際のページをiframeで表示 */}
                    <iframe
                      src={selectedPageUrl}
                      className="absolute inset-0 w-full h-full border-0"
                      title="Page Preview"
                      sandbox="allow-same-origin allow-scripts"
                    />
                    {/* ヒートマップをオーバーレイ */}
                    <div
                      ref={heatmapContainerRef}
                      className="absolute inset-0 pointer-events-none"
                      style={{ width: '100%', height: '100%' }}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="font-semibold">トップクリック要素</h4>
                  <div className="space-y-2">
                    {heatmapData
                      .sort((a, b) => (b.count || b.click_count || 0) - (a.count || a.click_count || 0))
                      .slice(0, 10)
                      .map((point, index) => {
                        const clickCount = point.count || point.click_count || 0
                        return (
                          <div
                            key={index}
                            className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                          >
                            <div className="flex-1">
                              <div className="font-medium">
                                {point.element_tag_name || 'unknown'}
                                {point.element_id && ` #${point.element_id}`}
                                {point.element_class_name && ` .${point.element_class_name}`}
                              </div>
                              <div className="text-sm text-gray-600">
                                位置: ({point.click_x}, {point.click_y})
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold text-blue-600">{clickCount.toLocaleString()}</div>
                              <div className="text-sm text-gray-500">クリック</div>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        )}
      </div>
    </DashboardLayout>
  )
}
