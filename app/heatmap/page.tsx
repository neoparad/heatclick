'use client'

import { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Badge } from '../../components/ui/badge'
import { 
  Map, 
  MousePointer, 
  Eye, 
  ScrollText, 
  Copy, 
  Download,
  Filter,
  Calendar,
  Globe,
  BarChart3,
  TrendingUp,
  Users,
  Clock,
  Target,
  Lightbulb
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  status: 'active' | 'inactive'
}

interface Page {
  id: string
  path: string
  title: string
  views: number
  lastActivity: string
}

interface HeatmapData {
  type: 'click' | 'scroll' | 'attention' | 'mouse'
  intensity: number
  x: number
  y: number
  width: number
  height: number
}

const mockSites: Site[] = [
  { id: '1', name: 'メインサイト', url: 'https://example.com', status: 'active' },
  { id: '2', name: 'ブログ', url: 'https://blog.example.com', status: 'active' },
  { id: '3', name: 'ランディングページ', url: 'https://lp.example.com', status: 'active' }
]

const mockPages: Page[] = [
  { id: '1', path: '/', title: 'ホームページ', views: 5420, lastActivity: '2024-01-20' },
  { id: '2', path: '/products', title: '商品一覧', views: 3200, lastActivity: '2024-01-20' },
  { id: '3', path: '/about', title: '会社概要', views: 1800, lastActivity: '2024-01-19' },
  { id: '4', path: '/contact', title: 'お問い合わせ', views: 950, lastActivity: '2024-01-19' },
  { id: '5', path: '/blog', title: 'ブログ', views: 2100, lastActivity: '2024-01-20' }
]

export default function HeatmapPage() {
  const [selectedSite, setSelectedSite] = useState<string>('1')
  const [selectedPage, setSelectedPage] = useState<string>('1')
  const [selectedHeatmapType, setSelectedHeatmapType] = useState<string>('click')
  const [selectedPeriod, setSelectedPeriod] = useState<string>('7days')
  const [selectedTrafficSource, setSelectedTrafficSource] = useState<string>('all')
  const [selectedQuery, setSelectedQuery] = useState<string>('all')
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [showImprovementSuggestions, setShowImprovementSuggestions] = useState(false)

  const currentSite = mockSites.find(site => site.id === selectedSite)
  const currentPage = mockPages.find(page => page.id === selectedPage)

  const heatmapTypes = [
    { value: 'click', label: 'クリックヒートマップ', icon: MousePointer, color: 'bg-blue-500' },
    { value: 'scroll', label: 'スクロールヒートマップ', icon: ScrollText, color: 'bg-green-500' },
    { value: 'attention', label: '注意ヒートマップ', icon: Eye, color: 'bg-purple-500' },
    { value: 'mouse', label: 'マウス移動ヒートマップ', icon: Map, color: 'bg-orange-500' }
  ]

  const trafficSources = [
    { value: 'all', label: 'すべての流入' },
    { value: 'organic', label: '自然検索' },
    { value: 'paid', label: '広告流入' },
    { value: 'direct', label: '直接アクセス' },
    { value: 'social', label: 'ソーシャルメディア' },
    { value: 'referral', label: '参照サイト' }
  ]

  const searchQueries = [
    { value: 'all', label: 'すべてのクエリ' },
    { value: 'ヒートマップ ツール', label: 'ヒートマップ ツール' },
    { value: 'クリック分析', label: 'クリック分析' },
    { value: 'ユーザー行動 可視化', label: 'ユーザー行動 可視化' },
    { value: 'SEO ヒートマップ', label: 'SEO ヒートマップ' }
  ]

  // 実際のクリックデータ
  const clickData = [
    { x: 120, y: 450, clicks: 8542, element: '「資料請求」ボタン', selector: '.cta-button' },
    { x: 200, y: 120, clicks: 6234, element: '「料金プラン」リンク', selector: 'a[href="/pricing"]' },
    { x: 50, y: 60, clicks: 4521, element: 'メニュー「導入事例」', selector: '.nav-item' },
    { x: 300, y: 800, clicks: 3102, element: 'フッター「お問い合わせ」', selector: '.footer-contact' },
    { x: 150, y: 300, clicks: 2845, element: '「無料トライアル」ボタン', selector: '.trial-button' },
    { x: 400, y: 200, clicks: 2100, element: '「お問い合わせ」ボタン', selector: '.contact-btn' },
    { x: 80, y: 350, clicks: 1800, element: '「資料ダウンロード」リンク', selector: '.download-link' },
    { x: 250, y: 500, clicks: 1200, element: '「サービス詳細」ボタン', selector: '.service-btn' }
  ]

  // ページビューデータ
  const pageViewData = {
    totalViews: 45234,
    uniqueVisitors: 28420,
    avgTimeOnPage: 185,
    bounceRate: 42.3,
    conversionRate: 3.8
  }

  // 改善提案データ
  const improvementSuggestions = [
    {
      priority: '高',
      title: 'CTAボタンの配置最適化',
      description: '「資料請求」ボタンが画面下部にあり、68%のユーザーが到達していません',
      currentClicks: 8542,
      potentialClicks: 14200,
      improvement: '+66%',
      action: 'ボタンをページ上部（200px上）に移動',
      impact: 'CV率 +150%'
    },
    {
      priority: '中',
      title: 'ナビゲーションの視認性向上',
      description: '「導入事例」リンクのクリック率が低く、重要なコンテンツが見逃されています',
      currentClicks: 4521,
      potentialClicks: 7200,
      improvement: '+59%',
      action: 'リンクの色を目立つ色に変更し、アイコンを追加',
      impact: '回遊率 +220%'
    },
    {
      priority: '高',
      title: 'フッターCTAの強化',
      description: 'フッターの「お問い合わせ」が効果的ですが、さらに最適化できます',
      currentClicks: 3102,
      potentialClicks: 4500,
      improvement: '+45%',
      action: 'ボタンサイズを1.5倍に拡大し、色を変更',
      impact: '問い合わせ +45%'
    }
  ]

  const periods = [
    { value: '1day', label: '過去1日' },
    { value: '7days', label: '過去7日' },
    { value: '30days', label: '過去30日' },
    { value: '90days', label: '過去90日' }
  ]

  const generateHeatmapData = (): HeatmapData[] => {
    // モックデータ生成
    const data: HeatmapData[] = []
    for (let i = 0; i < 50; i++) {
      data.push({
        type: selectedHeatmapType as any,
        intensity: Math.random(),
        x: Math.random() * 800,
        y: Math.random() * 600,
        width: 20 + Math.random() * 40,
        height: 20 + Math.random() * 40
      })
    }
    return data
  }

  const handleGenerateHeatmap = () => {
    setShowHeatmap(true)
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">ヒートマップ分析</h1>
          <p className="text-gray-600 mt-2">ユーザーの行動パターンを可視化</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">
            <Download className="w-4 h-4 mr-2" />
            エクスポート
          </Button>
          <Button className="bg-blue-600 hover:bg-blue-700">
            <Map className="w-4 h-4 mr-2" />
            ヒートマップ生成
          </Button>
        </div>
      </div>

      {/* 設定パネル */}
      <Card>
        <CardHeader>
          <CardTitle>分析設定</CardTitle>
          <CardDescription>ヒートマップの対象サイトとページを選択してください</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
            {/* サイト選択 */}
            <div>
              <label className="text-sm font-medium mb-2 block">サイト</label>
              <Select value={selectedSite} onValueChange={setSelectedSite}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mockSites.map(site => (
                    <SelectItem key={site.id} value={site.id}>
                      <div className="flex items-center">
                        <Globe className="w-4 h-4 mr-2" />
                        {site.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* ページ選択 */}
            <div>
              <label className="text-sm font-medium mb-2 block">ページ</label>
              <Select value={selectedPage} onValueChange={setSelectedPage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mockPages.map(page => (
                    <SelectItem key={page.id} value={page.id}>
                      <div className="flex items-center justify-between w-full">
                        <span>{page.title}</span>
                        <Badge variant="outline" className="ml-2">
                          {page.views.toLocaleString()} PV
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 期間選択 */}
            <div>
              <label className="text-sm font-medium mb-2 block">期間</label>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {periods.map(period => (
                    <SelectItem key={period.value} value={period.value}>
                      <div className="flex items-center">
                        <Calendar className="w-4 h-4 mr-2" />
                        {period.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* ヒートマップタイプ */}
            <div>
              <label className="text-sm font-medium mb-2 block">ヒートマップタイプ</label>
              <Select value={selectedHeatmapType} onValueChange={setSelectedHeatmapType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {heatmapTypes.map(type => (
                    <SelectItem key={type.value} value={type.value}>
                      <div className="flex items-center">
                        <type.icon className="w-4 h-4 mr-2" />
                        {type.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* トラフィックソース */}
            <div>
              <label className="text-sm font-medium mb-2 block">流入元</label>
              <Select value={selectedTrafficSource} onValueChange={setSelectedTrafficSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {trafficSources.map(source => (
                    <SelectItem key={source.value} value={source.value}>
                      {source.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 検索クエリ */}
            <div>
              <label className="text-sm font-medium mb-2 block">検索クエリ</label>
              <Select value={selectedQuery} onValueChange={setSelectedQuery}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {searchQueries.map(query => (
                    <SelectItem key={query.value} value={query.value}>
                      {query.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 選択されたページ情報 */}
          {currentPage && (
            <div className="bg-gray-50 p-4 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">{currentPage.title}</h3>
                  <p className="text-sm text-gray-600">
                    {currentSite?.url}{currentPage.path}
                  </p>
                </div>
                <div className="flex items-center space-x-4 text-sm text-gray-600">
                  <div className="flex items-center">
                    <BarChart3 className="w-4 h-4 mr-1" />
                    {currentPage.views.toLocaleString()} PV
                  </div>
                  <div className="flex items-center">
                    <Clock className="w-4 h-4 mr-1" />
                    {currentPage.lastActivity}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 生成ボタン */}
          <div className="flex justify-center">
            <Button 
              onClick={handleGenerateHeatmap}
              className="bg-blue-600 hover:bg-blue-700 px-8"
            >
              <Map className="w-4 h-4 mr-2" />
              ヒートマップを生成
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ページ統計 */}
      {currentPage && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">総ページビュー</p>
                  <p className="text-2xl font-bold">{pageViewData.totalViews.toLocaleString()}</p>
                </div>
                <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Eye className="w-4 h-4 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">ユニーク訪問者</p>
                  <p className="text-2xl font-bold">{pageViewData.uniqueVisitors.toLocaleString()}</p>
                </div>
                <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                  <Users className="w-4 h-4 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">平均滞在時間</p>
                  <p className="text-2xl font-bold">{pageViewData.avgTimeOnPage}秒</p>
                </div>
                <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Clock className="w-4 h-4 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">直帰率</p>
                  <p className="text-2xl font-bold">{pageViewData.bounceRate}%</p>
                </div>
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-orange-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">コンバージョン率</p>
                  <p className="text-2xl font-bold">{pageViewData.conversionRate}%</p>
                </div>
                <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
                  <Target className="w-4 h-4 text-red-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ヒートマップ表示エリア */}
      {showHeatmap && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center">
                  <Map className="w-5 h-5 mr-2" />
                  {heatmapTypes.find(t => t.value === selectedHeatmapType)?.label}
                </CardTitle>
                <CardDescription>
                  {currentSite?.name} - {currentPage?.title} ({periods.find(p => p.value === selectedPeriod)?.label})
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => setShowImprovementSuggestions(!showImprovementSuggestions)}
                >
                  <Lightbulb className="w-4 h-4 mr-2" />
                  改善提案
                </Button>
                <Button variant="outline">
                  <Download className="w-4 h-4 mr-2" />
                  エクスポート
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* ヒートマップビジュアル */}
            <div className="relative bg-gray-50 rounded-lg p-8 mb-6" style={{ minHeight: '600px' }}>
              <div className="text-center mb-4">
                <h3 className="text-lg font-semibold">ページヒートマップ</h3>
                <p className="text-sm text-gray-600">
                  {currentPage?.title} - クリック密度の可視化
                </p>
              </div>
              
              {/* ヒートマップのポイント */}
              <div className="relative" style={{ height: '500px' }}>
                {clickData.map((point, idx) => {
                  const intensity = Math.min(point.clicks / 1000, 10) // 強度計算
                  const size = Math.max(intensity * 8, 20) // サイズ計算
                  return (
                    <div
                      key={idx}
                      className="absolute rounded-full cursor-pointer hover:scale-110 transition-transform"
                      style={{
                        left: `${point.x}px`,
                        top: `${point.y}px`,
                        width: `${size}px`,
                        height: `${size}px`,
                        backgroundColor: `rgba(255, 0, 0, ${Math.min(intensity / 10, 0.8)})`,
                        border: '2px solid rgba(255, 255, 255, 0.8)',
                        zIndex: 10
                      }}
                      title={`${point.element}: ${point.clicks}クリック`}
                    />
                  )
                })}
                
                {/* ページの枠線 */}
                <div className="absolute inset-0 border-2 border-gray-300 rounded-lg" />
              </div>
              
              {/* 凡例 */}
              <div className="flex items-center justify-center gap-4 mt-4">
                <span className="text-sm text-gray-600">ヒートマップ強度:</span>
                <div className="flex items-center gap-1">
                  {['bg-red-200', 'bg-red-300', 'bg-red-400', 'bg-red-500', 'bg-red-600'].map((color, idx) => (
                    <div key={idx} className={`w-8 h-4 ${color} rounded`} />
                  ))}
                </div>
                <span className="text-sm text-gray-600">低 → 高</span>
              </div>
            </div>

            {/* クリックデータテーブル */}
            <div className="space-y-4">
              <h4 className="font-semibold">クリックデータ詳細</h4>
              <div className="space-y-2">
                {clickData.map((point, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div 
                        className="w-4 h-4 rounded-full"
                        style={{ backgroundColor: `rgba(255, 0, 0, ${Math.min(point.clicks / 10000, 0.8)})` }}
                      />
                      <div>
                        <div className="font-medium">{point.element}</div>
                        <div className="text-sm text-gray-500">{point.selector}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{point.clicks.toLocaleString()} クリック</div>
                      <div className="text-sm text-gray-500">位置: ({point.x}, {point.y})</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 改善提案 */}
      {showImprovementSuggestions && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Lightbulb className="w-5 h-5 mr-2" />
              ページ改善提案
            </CardTitle>
            <CardDescription>
              クリックデータに基づく具体的な改善提案
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {improvementSuggestions.map((suggestion, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Badge className={
                        suggestion.priority === '高' ? 'bg-red-100 text-red-700' :
                        suggestion.priority === '中' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-green-100 text-green-700'
                      }>
                        {suggestion.priority}
                      </Badge>
                      <h4 className="font-semibold">{suggestion.title}</h4>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-500">改善効果</div>
                      <div className="font-bold text-green-600">{suggestion.improvement}</div>
                    </div>
                  </div>
                  
                  <p className="text-gray-700 mb-3">{suggestion.description}</p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-sm text-gray-500">現在のクリック数</div>
                      <div className="font-bold">{suggestion.currentClicks.toLocaleString()}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-sm text-gray-500">予想クリック数</div>
                      <div className="font-bold text-green-600">{suggestion.potentialClicks.toLocaleString()}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-sm text-gray-500">期待効果</div>
                      <div className="font-bold text-blue-600">{suggestion.impact}</div>
                    </div>
                  </div>
                  
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="font-semibold text-blue-800 mb-1">推奨アクション</div>
                    <p className="text-blue-700">{suggestion.action}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 統計情報 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">総クリック数</p>
                <p className="text-2xl font-bold">12,450</p>
              </div>
              <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                <MousePointer className="w-4 h-4 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">平均スクロール深度</p>
                <p className="text-2xl font-bold">68%</p>
              </div>
              <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                <ScrollText className="w-4 h-4 text-green-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">注意時間</p>
                <p className="text-2xl font-bold">2.4分</p>
              </div>
              <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                <Eye className="w-4 h-4 text-purple-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">ユニークユーザー</p>
                <p className="text-2xl font-bold">3,240</p>
              </div>
              <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                <Users className="w-4 h-4 text-orange-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      </div>
    </DashboardLayout>
  )
}