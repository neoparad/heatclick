'use client'

import { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Badge } from '../../components/ui/badge'
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

export default function ClicksPage() {
  const [selectedSite, setSelectedSite] = useState('example.com')
  const [selectedPeriod, setSelectedPeriod] = useState('7days')
  const [selectedPage, setSelectedPage] = useState('all')
  const [exporting, setExporting] = useState(false)

  // サンプルデータ
  const clickData = [
    {
      element: '「資料請求」ボタン',
      selector: '.cta-button',
      clicks: 8542,
      ctr: 18.9,
      change: '+15%',
      page: '/contact',
      device: 'desktop',
      position: { x: 120, y: 450 }
    },
    {
      element: '「料金プラン」リンク',
      selector: 'a[href="/pricing"]',
      clicks: 6234,
      ctr: 13.8,
      change: '+8%',
      page: '/',
      device: 'desktop',
      position: { x: 200, y: 120 }
    },
    {
      element: 'メニュー「導入事例」',
      selector: '.nav-item[href="/cases"]',
      clicks: 4521,
      ctr: 10.0,
      change: '-2%',
      page: '/',
      device: 'mobile',
      position: { x: 50, y: 60 }
    },
    {
      element: 'フッター「お問い合わせ」',
      selector: '.footer-contact',
      clicks: 3102,
      ctr: 6.9,
      change: '+22%',
      page: '/',
      device: 'desktop',
      position: { x: 300, y: 800 }
    },
    {
      element: '「無料トライアル」ボタン',
      selector: '.trial-button',
      clicks: 2845,
      ctr: 6.3,
      change: '+5%',
      page: '/pricing',
      device: 'desktop',
      position: { x: 150, y: 300 }
    }
  ]

  const pageStats = [
    { page: '/', clicks: 15420, ctr: 12.4, visitors: 124200 },
    { page: '/pricing', clicks: 8920, ctr: 15.8, visitors: 56400 },
    { page: '/contact', clicks: 6540, ctr: 18.2, visitors: 35900 },
    { page: '/about', clicks: 3200, ctr: 8.9, visitors: 35900 }
  ]

  const deviceStats = [
    { device: 'デスクトップ', clicks: 28420, percentage: 68.5, ctr: 14.2 },
    { device: 'モバイル', clicks: 10200, percentage: 24.6, ctr: 9.8 },
    { device: 'タブレット', clicks: 2840, percentage: 6.9, ctr: 11.5 }
  ]

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
      link.href = url
      link.download = `clickinsight-clicks-${selectedSite}-${new Date().toISOString().split('T')[0]}.csv`
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
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="example.com">example.com</SelectItem>
                    <SelectItem value="blog.example.com">blog.example.com</SelectItem>
                    <SelectItem value="lp.example.com">lp.example.com</SelectItem>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">総クリック数</p>
                  <p className="text-2xl font-bold">41,460</p>
                </div>
                <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <MousePointer className="w-4 h-4 text-blue-600" />
                </div>
              </div>
              <div className="flex items-center gap-1 text-sm mt-2">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <span className="text-green-600 font-medium">+12.5%</span>
                <span className="text-gray-500">vs 前期間</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">平均CTR</p>
                  <p className="text-2xl font-bold">13.2%</p>
                </div>
                <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                  <Target className="w-4 h-4 text-green-600" />
                </div>
              </div>
              <div className="flex items-center gap-1 text-sm mt-2">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <span className="text-green-600 font-medium">+2.1%</span>
                <span className="text-gray-500">vs 前期間</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">ユニーク要素</p>
                  <p className="text-2xl font-bold">1,247</p>
                </div>
                <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Activity className="w-4 h-4 text-purple-600" />
                </div>
              </div>
              <div className="flex items-center gap-1 text-sm mt-2">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <span className="text-green-600 font-medium">+8.3%</span>
                <span className="text-gray-500">vs 前期間</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">アクティブページ</p>
                  <p className="text-2xl font-bold">12</p>
                </div>
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                  <Globe className="w-4 h-4 text-orange-600" />
                </div>
              </div>
              <div className="flex items-center gap-1 text-sm mt-2">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <span className="text-green-600 font-medium">+2</span>
                <span className="text-gray-500">vs 前期間</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* トップクリック要素 */}
        <Card>
          <CardHeader>
            <CardTitle>トップクリック要素</CardTitle>
            <CardDescription>最もクリックされた要素の詳細分析</CardDescription>
          </CardHeader>
          <CardContent>
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
                          <span>CTR {item.ctr}%</span>
                          <Badge variant="outline" className="text-xs">
                            {item.device === 'desktop' ? 'デスクトップ' : 'モバイル'}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`flex items-center gap-1 text-sm font-medium ${getChangeColor(item.change)}`}>
                        <ChangeIcon className="w-4 h-4" />
                        {item.change}
                      </div>
                      <Button variant="outline" size="sm">
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
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
                      <div className="text-sm text-gray-500">CTR {page.ctr}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>デバイス別分析</CardTitle>
              <CardDescription>デバイスごとのクリック分布</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {deviceStats.map((device, idx) => (
                  <div key={idx}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{device.device}</span>
                      <span className="text-sm text-gray-500">
                        {device.clicks.toLocaleString()} ({device.percentage}%)
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div 
                        className="bg-blue-600 h-2 rounded-full" 
                        style={{ width: `${device.percentage}%` }}
                      />
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      CTR: {device.ctr}%
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}





