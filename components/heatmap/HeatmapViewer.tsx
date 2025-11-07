'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { 
  MousePointer, 
  Eye, 
  Smartphone, 
  Monitor, 
  Tablet,
  Download,
  Share,
  Settings
} from 'lucide-react'

interface HeatmapData {
  click_x: number
  click_y: number
  click_count: number
  avg_duration: number
  last_click: string
}

interface HeatmapViewerProps {
  siteId: string
  pageUrl: string
  deviceType?: 'desktop' | 'tablet' | 'mobile'
  startDate?: string
  endDate?: string
}

export default function HeatmapViewer({
  siteId,
  pageUrl,
  deviceType,
  startDate,
  endDate
}: HeatmapViewerProps) {
  const [heatmapData, setHeatmapData] = useState<HeatmapData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDevice, setSelectedDevice] = useState(deviceType || 'desktop')
  const [heatmapType, setHeatmapType] = useState<'click' | 'scroll' | 'attention'>('click')
  const [showStats, setShowStats] = useState(true)
  
  const containerRef = useRef<HTMLDivElement>(null)
  const heatmapRef = useRef<HTMLDivElement>(null)

  // ヒートマップデータの取得
  useEffect(() => {
    const fetchHeatmapData = async () => {
      try {
        setLoading(true)
        const params = new URLSearchParams({
          site_id: siteId,
          page_url: pageUrl,
          ...(selectedDevice && { device_type: selectedDevice }),
          ...(startDate && { start_date: startDate }),
          ...(endDate && { end_date: endDate })
        })

        const response = await fetch(`/api/heatmap?${params}`)
        const result = await response.json()

        if (result.success) {
          setHeatmapData(result.data)
        } else {
          setError(result.error || 'Failed to fetch heatmap data')
        }
      } catch (err) {
        setError('Network error occurred')
        console.error('Error fetching heatmap data:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchHeatmapData()
  }, [siteId, pageUrl, selectedDevice, startDate, endDate])

  // ヒートマップの描画
  useEffect(() => {
    if (!heatmapData.length || !containerRef.current) return

    const container = containerRef.current
    const heatmap = heatmapRef.current

    if (!heatmap) return

    // 既存のヒートマップをクリア
    heatmap.innerHTML = ''

    // ヒートマップポイントの描画
    heatmapData.forEach((point, index) => {
      const element = document.createElement('div')
      element.className = 'heatmap-point'
      element.style.left = `${point.click_x}px`
      element.style.top = `${point.click_y}px`
      element.style.width = '20px'
      element.style.height = '20px'
      element.style.borderRadius = '50%'
      element.style.backgroundColor = `rgba(255, 0, 0, ${Math.min(point.click_count / 10, 0.8)})`
      element.style.position = 'absolute'
      element.style.pointerEvents = 'none'
      element.style.zIndex = '10'
      element.style.transition = 'all 0.3s ease'

      // ホバー効果
      element.addEventListener('mouseenter', () => {
        element.style.transform = 'scale(1.5)'
        element.style.zIndex = '20'
      })

      element.addEventListener('mouseleave', () => {
        element.style.transform = 'scale(1)'
        element.style.zIndex = '10'
      })

      // ツールチップ
      element.title = `クリック数: ${point.click_count}\n平均時間: ${point.avg_duration}ms\n最終クリック: ${new Date(point.last_click).toLocaleString()}`

      heatmap.appendChild(element)
    })
  }, [heatmapData])

  // デバイス選択
  const deviceOptions = [
    { value: 'desktop', label: 'デスクトップ', icon: Monitor },
    { value: 'tablet', label: 'タブレット', icon: Tablet },
    { value: 'mobile', label: 'モバイル', icon: Smartphone }
  ]

  // 統計情報の計算
  const stats = {
    totalClicks: heatmapData.reduce((sum, point) => sum + point.click_count, 0),
    uniquePositions: heatmapData.length,
    avgDuration: heatmapData.length > 0 
      ? heatmapData.reduce((sum, point) => sum + point.avg_duration, 0) / heatmapData.length 
      : 0,
    maxClicks: heatmapData.length > 0 
      ? Math.max(...heatmapData.map(point => point.click_count)) 
      : 0
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center text-red-600">
            <p>エラーが発生しました: {error}</p>
            <Button 
              onClick={() => window.location.reload()} 
              className="mt-4"
            >
              再読み込み
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* コントロールパネル */}
      <Card>
        <CardHeader>
          <CardTitle>ヒートマップ設定</CardTitle>
          <CardDescription>
            {pageUrl} - {selectedDevice === 'desktop' ? 'デスクトップ' : selectedDevice === 'tablet' ? 'タブレット' : 'モバイル'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-center">
            {/* デバイス選択 */}
            <div className="flex space-x-2">
              {deviceOptions.map(({ value, label, icon: Icon }) => (
                <Button
                  key={value}
                  variant={selectedDevice === value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedDevice(value as any)}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </Button>
              ))}
            </div>

            {/* ヒートマップタイプ */}
            <div className="flex space-x-2">
              <Button
                variant={heatmapType === 'click' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setHeatmapType('click')}
              >
                <MousePointer className="mr-2 h-4 w-4" />
                クリック
              </Button>
              <Button
                variant={heatmapType === 'scroll' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setHeatmapType('scroll')}
              >
                <Eye className="mr-2 h-4 w-4" />
                スクロール
              </Button>
            </div>

            {/* アクションボタン */}
            <div className="flex space-x-2 ml-auto">
              <Button variant="outline" size="sm">
                <Download className="mr-2 h-4 w-4" />
                エクスポート
              </Button>
              <Button variant="outline" size="sm">
                <Share className="mr-2 h-4 w-4" />
                共有
              </Button>
              <Button variant="outline" size="sm">
                <Settings className="mr-2 h-4 w-4" />
                設定
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 統計情報 */}
      {showStats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{stats.totalClicks.toLocaleString()}</div>
              <div className="text-sm text-muted-foreground">総クリック数</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{stats.uniquePositions}</div>
              <div className="text-sm text-muted-foreground">ユニーク位置</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{Math.round(stats.avgDuration)}ms</div>
              <div className="text-sm text-muted-foreground">平均時間</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{stats.maxClicks}</div>
              <div className="text-sm text-muted-foreground">最大クリック数</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ヒートマップ表示 */}
      <Card>
        <CardHeader>
          <CardTitle>ヒートマップ</CardTitle>
          <CardDescription>
            クリックされた位置を可視化（赤い点がクリック数に比例）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative border rounded-lg overflow-hidden">
            <div 
              ref={containerRef}
              className="relative w-full h-96 bg-gray-100"
              style={{ minHeight: '400px' }}
            >
              {/* ここにページのスクリーンショットが表示される */}
              <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center">
                <div className="text-center text-gray-500">
                  <Eye className="h-12 w-12 mx-auto mb-2" />
                  <p>ページのスクリーンショット</p>
                  <p className="text-sm">実際のページ画像がここに表示されます</p>
                </div>
              </div>
              
              {/* ヒートマップオーバーレイ */}
              <div 
                ref={heatmapRef}
                className="absolute inset-0 pointer-events-none"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
