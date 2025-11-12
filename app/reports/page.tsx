'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Badge } from '../../components/ui/badge'
import Loading from '../../components/ui/loading'
import { getCurrentUser } from '@/lib/auth'
import { 
  FileText, 
  Download, 
  Calendar, 
  BarChart3, 
  TrendingUp, 
  Users, 
  MousePointer,
  Eye,
  Clock,
  Target,
  Globe,
  Mail,
  Share2,
  RefreshCw,
  Filter
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

export default function ReportsPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<string>('')
  const [selectedPeriod, setSelectedPeriod] = useState('7days')
  const [selectedReport, setSelectedReport] = useState('comprehensive')
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)
  const [generatedReports, setGeneratedReports] = useState<any[]>([])

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
      } finally {
        setLoading(false)
      }
    }
    fetchSites()
  }, [])

  // ユーザー情報の取得
  useEffect(() => {
    const currentUser = getCurrentUser()
    if (currentUser) {
      setUser(currentUser)
    }
  }, [])

  // レポートテンプレート
  const reportTemplates = [
    {
      id: 'comprehensive',
      name: '総合分析レポート',
      description: 'サイト全体のパフォーマンスと改善提案',
      duration: '30分',
      sections: ['KPI分析', 'クリック分析', 'AI分析', '改善提案'],
      icon: BarChart3
    },
    {
      id: 'click-analysis',
      name: 'クリック分析レポート',
      description: '詳細なクリックデータとユーザー行動分析',
      duration: '15分',
      sections: ['クリック統計', '要素分析', 'デバイス別分析'],
      icon: MousePointer
    },
    {
      id: 'ai-insights',
      name: 'AI分析レポート',
      description: 'AIによる自動分析と改善提案',
      duration: '20分',
      sections: ['AI分析結果', '優先度別提案', '実装コード'],
      icon: Target
    },
    {
      id: 'seo-performance',
      name: 'SEOパフォーマンスレポート',
      description: '検索流入とSEO効果の分析',
      duration: '25分',
      sections: ['検索クエリ分析', '流入分析', 'コンバージョン分析'],
      icon: TrendingUp
    }
  ]

  const handleGenerateReport = async () => {
    if (!selectedSite) {
      alert('サイトを選択してください')
      return
    }

    try {
      // TODO: 実際のレポート生成APIを実装
      alert('レポート生成機能は現在開発中です')
      console.log('Generating report for site:', selectedSite, 'period:', selectedPeriod, 'type:', selectedReport)
    } catch (error) {
      console.error('Error generating report:', error)
      alert('レポートの生成に失敗しました')
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-100 text-green-700">完了</Badge>
      case 'generating':
        return <Badge className="bg-yellow-100 text-yellow-700">生成中</Badge>
      case 'failed':
        return <Badge className="bg-red-100 text-red-700">エラー</Badge>
      default:
        return <Badge className="bg-gray-100 text-gray-700">不明</Badge>
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">レポート</h1>
            <p className="text-gray-600 mt-2">分析レポートの生成・管理・共有</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline">
              <Filter className="w-4 h-4 mr-2" />
              フィルター
            </Button>
            <Button>
              <RefreshCw className="w-4 h-4 mr-2" />
              更新
            </Button>
          </div>
        </div>

        {/* レポート生成 */}
        <Card>
          <CardHeader>
            <CardTitle>新しいレポートを生成</CardTitle>
            <CardDescription>分析データからレポートを自動生成します</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                    <SelectItem value="7days">過去7日間</SelectItem>
                    <SelectItem value="30days">過去30日間</SelectItem>
                    <SelectItem value="90days">過去90日間</SelectItem>
                    <SelectItem value="custom">カスタム期間</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">レポートタイプ</label>
                <Select value={selectedReport} onValueChange={setSelectedReport}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reportTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* レポートテンプレート選択 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {reportTemplates.map((template) => {
                const Icon = template.icon
                return (
                  <div 
                    key={template.id}
                    className={`border rounded-lg p-4 cursor-pointer transition-colors ${
                      selectedReport === template.id 
                        ? 'border-blue-500 bg-blue-50' 
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setSelectedReport(template.id)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                        <Icon className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold">{template.name}</h3>
                        <p className="text-sm text-gray-600 mb-2">{template.description}</p>
                        <div className="flex items-center gap-4 text-xs text-gray-500">
                          <span>⏱️ {template.duration}</span>
                          <span>📄 {template.sections.length}セクション</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={handleGenerateReport} className="bg-blue-600 hover:bg-blue-700">
                <FileText className="w-4 h-4 mr-2" />
                レポートを生成
              </Button>
              <Button variant="outline">
                <Calendar className="w-4 h-4 mr-2" />
                スケジュール設定
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 生成済みレポート */}
        <Card>
          <CardHeader>
            <CardTitle>生成済みレポート</CardTitle>
            <CardDescription>過去に生成されたレポートの一覧</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Loading />
            ) : generatedReports.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                生成済みのレポートがありません
                <p className="text-sm mt-2">レポートを生成すると、ここに表示されます</p>
              </div>
            ) : (
              <div className="space-y-4">
                {generatedReports.map((report) => (
                <div key={report.id} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1">
                      <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                        <FileText className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold">{report.name}</h3>
                          {getStatusBadge(report.status)}
                        </div>
                        <div className="text-sm text-gray-600 mb-1">
                          {report.site} • {report.generatedAt}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-gray-500">
                          <span>📄 {report.pages}ページ</span>
                          <span>💡 {report.insights}インサイト</span>
                          <span>📊 {report.size}</span>
                          <span>⬇️ {report.downloadCount}回ダウンロード</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          // TODO: レポートプレビュー機能の実装
                          alert('レポートプレビュー機能は現在開発中です')
                        }}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        プレビュー
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          // レポートをダウンロード
                          const reportContent = `レポート: ${report.name}\nサイト: ${report.site}\n生成日時: ${report.generatedAt}\n\nこのレポートは現在開発中です。`
                          const blob = new Blob([reportContent], { type: 'text/plain' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `${report.name.replace(/\s+/g, '_')}.txt`
                          document.body.appendChild(a)
                          a.click()
                          document.body.removeChild(a)
                          URL.revokeObjectURL(url)
                        }}
                      >
                        <Download className="w-4 h-4 mr-1" />
                        ダウンロード
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          // レポートを共有
                          if (navigator.share) {
                            navigator.share({
                              title: report.name,
                              text: `${report.name} - ${report.site}`,
                              url: window.location.href
                            }).catch(err => console.error('Error sharing:', err))
                          } else {
                            // フォールバック: クリップボードにコピー
                            const shareUrl = `${window.location.origin}/reports?report=${report.id}`
                            navigator.clipboard.writeText(shareUrl).then(() => {
                              alert('レポートのリンクをクリップボードにコピーしました')
                            }).catch(err => {
                              console.error('Error copying to clipboard:', err)
                              alert('共有機能を使用できません')
                            })
                          }
                        }}
                      >
                        <Share2 className="w-4 h-4 mr-1" />
                        共有
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 自動レポート設定 */}
        <Card>
          <CardHeader>
            <CardTitle>自動レポート設定</CardTitle>
            <CardDescription>定期的なレポート生成と配信の設定</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h4 className="font-semibold">配信スケジュール</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div>
                      <div className="font-medium">週次レポート</div>
                      <div className="text-sm text-gray-500">毎週月曜日 9:00</div>
                    </div>
                    <Button variant="outline" size="sm">編集</Button>
                  </div>
                  <div className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div>
                      <div className="font-medium">月次レポート</div>
                      <div className="text-sm text-gray-500">毎月1日 10:00</div>
                    </div>
                    <Button variant="outline" size="sm">編集</Button>
                  </div>
                </div>
              </div>
              
              <div className="space-y-3">
                <h4 className="font-semibold">配信先</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-gray-500" />
                      <span>{user?.email || 'メールアドレス未設定'}</span>
                    </div>
                    <Button variant="outline" size="sm">編集</Button>
                  </div>
                  <div className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Share2 className="w-4 h-4 text-gray-500" />
                      <span>Slack #analytics</span>
                    </div>
                    <Button variant="outline" size="sm">編集</Button>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}








