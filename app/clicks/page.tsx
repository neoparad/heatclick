'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Badge } from '../../components/ui/badge'
import Loading from '../../components/ui/loading'
import { 
  MousePointer, 
  TrendingUp, 
  TrendingDown,
  Target,
  BarChart3,
  Filter,
  Download,
  Eye,
  Clock,
  Users,
  Activity,
  Globe
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

interface ClickElement {
  element: string
  selector: string
  clicks: number
  ctr: number
  change: string
  page: string
  device: string
  position: { x: number; y: number }
}

interface PageStat {
  page: string
  clicks: number
  ctr: number
  visitors: number
}

interface DeviceStat {
  device: string
  clicks: number
  percentage: number
  ctr: number
}

export default function ClicksPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<string>('')
  const [selectedPeriod, setSelectedPeriod] = useState('7days')
  const [selectedPage, setSelectedPage] = useState('all')
  const [exporting, setExporting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [clickData, setClickData] = useState<ClickElement[]>([])
  const [pageStats, setPageStats] = useState<PageStat[]>([])
  const [deviceStats, setDeviceStats] = useState<DeviceStat[]>([])
  const [stats, setStats] = useState({
    totalClicks: 0,
    uniqueElements: 0,
    uniquePages: 0,
    uniqueSessions: 0,
    clickChange: '0'
  })

  // サイト一覧の取得
  useEffect(() => {
    const fetchSites = async () => {
      try {
        const response = await fetch('/api/sites')
        if (response.ok) {
          const data = await response.json()
          const sitesList = data.sites || []
          setSites(sitesList)
          if (sitesList.length > 0 && !selectedSite) {
            setSelectedSite(sitesList[0].tracking_id)
          }
        }
      } catch (error) {
        console.error('Error fetching sites:', error)
      }
    }
    fetchSites()
  }, [])

  // クリックデータの取得
  useEffect(() => {
    if (!selectedSite) return

    const fetchClickData = async () => {
      setLoading(true)
      try {
        // 期間の計算
        const endDate = new Date().toISOString().split('T')[0]
        let startDate = new Date()
        switch (selectedPeriod) {
          case '1day':
            startDate.setDate(startDate.getDate() - 1)
            break
          case '7days':
            startDate.setDate(startDate.getDate() - 7)
            break
          case '30days':
            startDate.setDate(startDate.getDate() - 30)
            break
          case '90days':
            startDate.setDate(startDate.getDate() - 90)
            break
        }
        const startDateStr = startDate.toISOString().split('T')[0]

        const params = new URLSearchParams({
          site_id: selectedSite,
          start_date: startDateStr,
          end_date: endDate,
          ...(selectedPage !== 'all' && { page_url: selectedPage })
        })

        const response = await fetch(`/api/clicks?${params}`)
        if (response.ok) {
          const result = await response.json()
          if (result.success && result.data) {
            setClickData(result.data.elements || [])
            setPageStats(result.data.pages || [])
            setDeviceStats(result.data.devices || [])
            setStats(result.data.stats || {
              totalClicks: 0,
              uniqueElements: 0,
              uniquePages: 0,
              uniqueSessions: 0,
              clickChange: '0'
            })
          }
        }
      } catch (error) {
        console.error('Error fetching click data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchClickData()
  }, [selectedSite, selectedPeriod, selectedPage])

  const getChangeIcon = (change: string) => {
    return change.startsWith('+') ? TrendingUp : TrendingDown
  }

  const getChangeColor = (change: string) => {
    return change.startsWith('+') ? 'text-green-600' : 'text-red-600'
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      // CSVデータの準備
      const csvHeaders = ['要素', 'セレクター', 'クリック数', 'CTR', '変化率', 'ページ', 'デバイス']
      const csvRows = clickData.map(item => [
        item.element,
        item.selector,
        item.clicks.toString(),
        `${item.ctr}%`,
        item.change,
        item.page,
        item.device === 'desktop' ? 'デスクトップ' : item.device === 'mobile' ? 'モバイル' : 'タブレット'
      ])

      // CSV文字列の生成
      const csvContent = [
        csvHeaders.join(','),
        ...csvRows.map(row => row.map(cell => `"${cell}"`).join(','))
      ].join('\n')

      // BOMを追加してExcelで正しく開けるようにする
      const BOM = '\uFEFF'
      const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' })
      
      // ダウンロード
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const siteName = sites.find(s => s.tracking_id === selectedSite)?.name || selectedSite
      link.href = url
      link.download = `ugokimap-clicks-${siteName}-${new Date().toISOString().split('T')[0]}.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      alert('エクスポートが完了しました')
    } catch (error) {
      console.error('Export error:', error)
      alert('エクスポートに失敗しました')
    } finally {
      setExporting(false)
    }
  }

  const selectedSiteName = sites.find(s => s.tracking_id === selectedSite)?.name || selectedSite

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">クリック分析</h1>
            <p className="text-gray-600 mt-2">詳細なクリックデータの分析とインサイト</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline">
              <Filter className="w-4 h-4 mr-2" />
              フィルター
            </Button>
            <Button onClick={handleExport} disabled={exporting}>
              <Download className="w-4 h-4 mr-2" />
              {exporting ? 'エクスポート中...' : 'エクスポート'}
            </Button>
          </div>
        </div>

        {/* フィルター */}
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">サイト</label>
                <Select value={selectedSite} onValueChange={setSelectedSite}>
                  <SelectTrigger>
                    <SelectValue placeholder="サイトを選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.tracking_id}>
                        {site.name} ({site.url})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">期間</label>
                <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1day">過去24時間</SelectItem>
                    <SelectItem value="7days">過去7日間</SelectItem>
                    <SelectItem value="30days">過去30日間</SelectItem>
                    <SelectItem value="90days">過去90日間</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">ページ</label>
                <Select value={selectedPage} onValueChange={setSelectedPage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">すべてのページ</SelectItem>
                    <SelectItem value="/">ホームページ</SelectItem>
                    <SelectItem value="/pricing">料金ページ</SelectItem>
                    <SelectItem value="/contact">お問い合わせ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* サマリー統計 */}
        {loading ? (
          <Loading />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">総クリック数</p>
                    <p className="text-2xl font-bold">{stats.totalClicks.toLocaleString()}</p>
                  </div>
                  <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                    <MousePointer className="w-4 h-4 text-blue-600" />
                  </div>
                </div>
                {stats.clickChange !== '0' && (
                  <div className="flex items-center gap-1 text-sm mt-2">
                    {parseFloat(stats.clickChange) >= 0 ? (
                      <TrendingUp className="w-4 h-4 text-green-600" />
                    ) : (
                      <TrendingDown className="w-4 h-4 text-red-600" />
                    )}
                    <span className={parseFloat(stats.clickChange) >= 0 ? 'text-green-600' : 'text-red-600'}>
                      {parseFloat(stats.clickChange) >= 0 ? '+' : ''}{stats.clickChange}%
                    </span>
                    <span className="text-gray-500">vs 前期間</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">平均CTR</p>
                    <p className="text-2xl font-bold">
                      {pageStats.length > 0 
                        ? (pageStats.reduce((sum, p) => sum + p.ctr, 0) / pageStats.length).toFixed(1)
                        : '0'
                      }%
                    </p>
                  </div>
                  <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                    <Target className="w-4 h-4 text-green-600" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">ユニーク要素</p>
                    <p className="text-2xl font-bold">{stats.uniqueElements.toLocaleString()}</p>
                  </div>
                  <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                    <Activity className="w-4 h-4 text-purple-600" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">アクティブページ</p>
                    <p className="text-2xl font-bold">{stats.uniquePages.toLocaleString()}</p>
                  </div>
                  <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                    <Globe className="w-4 h-4 text-orange-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* トップクリック要素 */}
        <Card>
          <CardHeader>
            <CardTitle>トップクリック要素</CardTitle>
            <CardDescription>最もクリックされた要素の詳細分析</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Loading />
            ) : clickData.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                クリックデータがありません
              </div>
            ) : (
              <div className="space-y-4">
                {clickData.map((item, idx) => {
                  const ChangeIcon = getChangeIcon(item.change)
                  return (
                    <div key={idx} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                      <div className="flex items-center gap-4 flex-1">
                        <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                          <span className="font-bold text-blue-600 text-sm">{idx + 1}</span>
                        </div>
                        <div className="flex-1">
                          <div className="font-medium mb-1">{item.element}</div>
                          <div className="text-sm text-gray-500 mb-1">
                            {item.selector} • {item.page}
                          </div>
                          <div className="flex items-center gap-4 text-sm text-gray-500">
                            <span>{item.clicks.toLocaleString()} クリック</span>
                            {item.ctr > 0 && <span>CTR {item.ctr.toFixed(1)}%</span>}
                            <Badge variant="outline" className="text-xs">
                              {item.device === 'desktop' ? 'デスクトップ' : item.device === 'mobile' ? 'モバイル' : 'タブレット'}
                            </Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.change !== '+0%' && (
                          <div className={`flex items-center gap-1 text-sm font-medium ${getChangeColor(item.change)}`}>
                            <ChangeIcon className="w-4 h-4" />
                            {item.change}
                          </div>
                        )}
                        <Button variant="outline" size="sm">
                          <Eye className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ページ別分析 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>ページ別クリック数</CardTitle>
              <CardDescription>各ページのクリックパフォーマンス</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Loading />
              ) : pageStats.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  ページ別データがありません
                </div>
              ) : (
                <div className="space-y-3">
                  {pageStats.map((page, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                      <div>
                        <div className="font-medium">{page.page}</div>
                        <div className="text-sm text-gray-500">
                          {page.visitors.toLocaleString()} 訪問者
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{page.clicks.toLocaleString()}</div>
                        <div className="text-sm text-gray-500">CTR {page.ctr.toFixed(1)}%</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>デバイス別分析</CardTitle>
              <CardDescription>デバイスごとのクリック分布</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Loading />
              ) : deviceStats.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  デバイス別データがありません
                </div>
              ) : (
                <div className="space-y-4">
                  {deviceStats.map((device, idx) => (
                    <div key={idx}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium">{device.device}</span>
                        <span className="text-sm text-gray-500">
                          {device.clicks.toLocaleString()} ({device.percentage.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div 
                          className="bg-blue-600 h-2 rounded-full" 
                          style={{ width: `${device.percentage}%` }}
                        />
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        CTR: {device.ctr.toFixed(1)}%
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}





