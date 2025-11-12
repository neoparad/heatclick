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
  BarChart3
} from 'lucide-react'
import dynamic from 'next/dynamic'

// Dynamically import heatmap.js to avoid SSR issues
let h337: any = null
if (typeof window !== 'undefined') {
  try {
    h337 = require('heatmap.js')
  } catch (error) {
    console.error('Failed to load heatmap.js:', error)
  }
}

interface Site {
  id: string
  name: string
  domain: string
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
  const heatmapContainerRef = useRef<HTMLDivElement>(null)
  const heatmapInstanceRef = useRef<any>(null)

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

  // 選択されたサイトのページURLリストを取得
  useEffect(() => {
    if (!selectedSite) return

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
        }
      } catch (err) {
        console.error('Error fetching pages:', err)
        setPages([])
      }
    }

    fetchPages()
  }, [selectedSite])

  // ヒートマップデータを取得
  useEffect(() => {
    if (!selectedSite || !selectedPageUrl) return

    const fetchHeatmap = async () => {
      try {
        const response = await fetch(
          `/api/heatmap?site_id=${selectedSite.tracking_id}&page_url=${encodeURIComponent(selectedPageUrl)}`
        )
        if (!response.ok) {
          throw new Error('Failed to fetch heatmap data')
        }
        const data = await response.json()
        setHeatmapData(data.data || [])
      } catch (err) {
        console.error('Error fetching heatmap:', err)
        setHeatmapData([])
      }
    }

    fetchHeatmap()
  }, [selectedSite, selectedPageUrl])

  // ヒートマップを描画
  useEffect(() => {
    if (!h337 || !heatmapContainerRef.current || heatmapData.length === 0) return

    // 既存のヒートマップインスタンスをクリーンアップ
    if (heatmapInstanceRef.current) {
      const canvas = heatmapContainerRef.current.querySelector('canvas')
      if (canvas) {
        canvas.remove()
      }
    }

    // ヒートマップインスタンスを作成
    const heatmapInstance = h337.create({
      container: heatmapContainerRef.current,
      radius: 40,
      maxOpacity: 0.6,
      minOpacity: 0,
      blur: 0.75,
    })

    // データポイントを変換
    const points = heatmapData.map(point => ({
      x: point.click_x,
      y: point.click_y,
      value: point.count || point.click_count || 1,
    }))

    // 最大値を計算（空配列の場合は1を設定）
    const maxValue = points.length > 0 
      ? Math.max(...points.map(p => p.value), 1)
      : 1

    // データを設定
    try {
      heatmapInstance.setData({
        max: maxValue,
        data: points,
      })
    } catch (error) {
      console.error('Error setting heatmap data:', error)
    }

    heatmapInstanceRef.current = heatmapInstance

    return () => {
      if (heatmapInstanceRef.current) {
        const canvas = heatmapContainerRef.current?.querySelector('canvas')
        if (canvas) {
          canvas.remove()
        }
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

        {/* サイト選択 */}
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
                    {site.name} ({site.domain})
                  </option>
                ))}
              </select>
            </div>

            {pages.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Map className="w-4 h-4 inline mr-2" />
                  ページを選択
                </label>
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
              </div>
            )}

            {pages.length === 0 && selectedSite && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-700">
                このサイトにはまだページデータがありません。トラッキングタグが正しく設置されているか確認してください。
              </div>
            )}
          </CardContent>
        </Card>

        {/* ヒートマップ表示エリア */}
        {selectedPageUrl && (
          <Card>
            <CardHeader>
              <CardTitle>
                <MousePointer className="w-5 h-5 inline mr-2" />
                クリックヒートマップ
              </CardTitle>
              <CardDescription>{selectedPageUrl}</CardDescription>
            </CardHeader>
            <CardContent>
              {heatmapData.length === 0 ? (
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
                    <div
                      ref={heatmapContainerRef}
                      className="relative bg-gray-50"
                      style={{ width: '100%', height: '600px' }}
                    />
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
