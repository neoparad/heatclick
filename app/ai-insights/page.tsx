'use client'

import { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import {
  Brain,
  AlertTriangle,
  CheckCircle,
  TrendingUp,
  Clock,
  Target,
  Lightbulb,
  Zap,
  RefreshCw,
  Download,
  Eye,
  ArrowRight,
  BarChart3,
  MousePointer,
  Users,
  Copy,
  Code
} from 'lucide-react'

export default function AIInsightsPage() {
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedInsight, setSelectedInsight] = useState<string | null>(null)

  // AI分析データ
  const aiInsights = [
    {
      id: 'insight_001',
      priority: '緊急',
      title: 'CTAボタンのクリック率が業界平均の40%',
      description: 'メインページの「資料請求」ボタンのクリック率が2.3%と業界平均の5.8%を大幅に下回っています。',
      current: '2.3%',
      target: '5.8%',
      impact: 'CV率 +150%',
      time: '15分',
      confidence: 95,
      category: 'conversion',
      elements: [
        { type: 'ボタン配置', suggestion: 'ボタンを200px上に移動（68%のユーザーが未到達）' },
        { type: 'ボタンサイズ', suggestion: 'ボタンサイズを1.5倍に拡大' },
        { type: '色の変更', suggestion: '色を#FF6B00（オレンジ）に変更' }
      ],
      code: `
/* 改善コード例 */
.cta-button {
  position: relative;
  top: -200px;
  width: 180px;
  height: 60px;
  background-color: #FF6B00;
  font-size: 18px;
  font-weight: bold;
}`
    },
    {
      id: 'insight_002',
      priority: '重要',
      title: '内部リンク「導入事例」が87%見逃されている',
      description: '重要なコンテンツである「導入事例」へのリンクがユーザーに気づかれていません。',
      current: '1.2%',
      target: '10%',
      impact: '回遊率 +220%',
      time: '30分',
      confidence: 88,
      category: 'navigation',
      elements: [
        { type: '視認性向上', suggestion: 'リンクを目立つ色（#0066CC）に変更' },
        { type: '配置最適化', suggestion: 'ナビゲーションの上部に移動' },
        { type: 'アイコン追加', suggestion: 'アイコンを追加して視認性を向上' }
      ],
      code: `
/* 改善コード例 */
.nav-item.cases {
  color: #0066CC;
  font-weight: bold;
  position: relative;
  top: -10px;
}

.nav-item.cases::before {
  content: "📊";
  margin-right: 5px;
}`
    },
    {
      id: 'insight_003',
      priority: 'SEO',
      title: 'クエリ「ヒートマップ ツール」の直帰率78%',
      description: 'SEO流入の重要なキーワードで直帰率が高く、コンバージョンに繋がっていません。',
      current: '78%',
      target: '50%',
      impact: '検索順位 +1位',
      time: '60分',
      confidence: 92,
      category: 'seo',
      elements: [
        { type: 'コンテンツ改善', suggestion: 'ページ上部にキーワード関連のコンテンツを追加' },
        { type: '内部リンク', suggestion: '関連ページへのリンクを3つ以上追加' },
        { type: 'CTA最適化', suggestion: 'ページ中央にCTAボタンを配置' }
      ],
      code: `
/* 改善コード例 */
.hero-section {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 80px 0;
  text-align: center;
}

.hero-section h1 {
  color: white;
  font-size: 2.5rem;
  margin-bottom: 20px;
}`
    }
  ]

  const performanceMetrics = {
    totalInsights: 12,
    highPriority: 3,
    mediumPriority: 6,
    lowPriority: 3,
    avgConfidence: 91.7,
    estimatedROI: 420
  }

  const handleAnalyze = async () => {
    setIsAnalyzing(true)
    // シミュレーション: 分析処理
    await new Promise(resolve => setTimeout(resolve, 3000))
    setIsAnalyzing(false)
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case '緊急': return 'bg-red-100 text-red-700 border-red-200'
      case '重要': return 'bg-orange-100 text-orange-700 border-orange-200'
      case 'SEO': return 'bg-blue-100 text-blue-700 border-blue-200'
      default: return 'bg-gray-100 text-gray-700 border-gray-200'
    }
  }

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'conversion': return Target
      case 'navigation': return BarChart3
      case 'seo': return TrendingUp
      default: return Brain
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">AI分析レポート</h1>
            <p className="text-gray-600 mt-2">Claude Sonnet 4による自動分析と改善提案</p>
          </div>
          <div className="flex items-center gap-2">
            <Button 
              onClick={handleAnalyze}
              disabled={isAnalyzing}
              className="bg-purple-600 hover:bg-purple-700"
            >
              <Brain className="w-4 h-4 mr-2" />
              {isAnalyzing ? '分析中...' : '再分析'}
              {isAnalyzing && <RefreshCw className="w-4 h-4 ml-2 animate-spin" />}
            </Button>
            <Button variant="outline">
              <Download className="w-4 h-4 mr-2" />
              レポート出力
            </Button>
          </div>
        </div>

        {/* 分析サマリー */}
        <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg border border-purple-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-gradient-to-br from-purple-600 to-blue-600 rounded-lg flex items-center justify-center">
              <Brain className="w-6 h-6 text-white" />
            </div>
            <div>
              <h3 className="font-bold text-lg">AI深堀診断レポート</h3>
              <p className="text-sm text-gray-600">最終更新: 2025年1月25日 10:30</p>
            </div>
          </div>
          <p className="text-gray-700 mb-4">
            Claude Sonnet 4がサイト全体を分析し、優先度の高い改善提案を{performanceMetrics.totalInsights}件抽出しました。
            合計で実装時間{performanceMetrics.estimatedROI}分、予測ROI +{performanceMetrics.estimatedROI}%の改善が見込まれます。
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">{performanceMetrics.totalInsights}</div>
              <div className="text-sm text-gray-600">総インサイト</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">{performanceMetrics.highPriority}</div>
              <div className="text-sm text-gray-600">緊急対応</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{performanceMetrics.avgConfidence}%</div>
              <div className="text-sm text-gray-600">平均信頼度</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">+{performanceMetrics.estimatedROI}%</div>
              <div className="text-sm text-gray-600">予測ROI</div>
            </div>
          </div>
        </div>

        {/* AI分析結果 */}
        <div className="space-y-6">
          {aiInsights.map((insight, idx) => {
            const CategoryIcon = getCategoryIcon(insight.category)
            return (
              <Card key={insight.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <Badge className={`${getPriorityColor(insight.priority)} border`}>
                        {insight.priority}
                      </Badge>
                      <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                        <CategoryIcon className="w-4 h-4 text-purple-600" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">{idx + 1}. {insight.title}</CardTitle>
                        <CardDescription className="mt-1">{insight.description}</CardDescription>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-500">信頼度</div>
                      <div className="text-lg font-bold text-purple-600">{insight.confidence}%</div>
                    </div>
                  </div>
                </CardHeader>
                
                <CardContent className="space-y-4">
                  {/* メトリクス */}
                  <div className="grid grid-cols-4 gap-4">
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 mb-1">現状</div>
                      <div className="text-2xl font-bold text-red-600">{insight.current}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 mb-1">目標</div>
                      <div className="text-2xl font-bold text-green-600">{insight.target}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 mb-1">期待効果</div>
                      <div className="text-lg font-bold text-blue-600">{insight.impact}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 mb-1">実装時間</div>
                      <div className="text-2xl font-bold text-purple-600">{insight.time}</div>
                    </div>
                  </div>

                  {/* 改善案 */}
                  <div className="bg-blue-50 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Lightbulb className="w-5 h-5 text-blue-600" />
                      <span className="font-semibold text-blue-800">改善提案</span>
                    </div>
                    <div className="space-y-2">
                      {insight.elements.map((element, elemIdx) => (
                        <div key={elemIdx} className="flex items-start gap-2">
                          <div className="w-2 h-2 bg-blue-600 rounded-full mt-2 flex-shrink-0" />
                          <div>
                            <span className="font-medium text-blue-800">{element.type}:</span>
                            <span className="text-blue-700 ml-1">{element.suggestion}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 実装コード */}
                  {selectedInsight === insight.id && (
                    <div className="bg-gray-900 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-white font-semibold">実装コード</span>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => navigator.clipboard.writeText(insight.code)}
                          className="text-white border-white hover:bg-white hover:text-gray-900"
                        >
                          <Copy className="w-4 h-4 mr-1" />
                          コピー
                        </Button>
                      </div>
                      <pre className="text-green-400 text-sm overflow-x-auto">
                        <code>{insight.code}</code>
                      </pre>
                    </div>
                  )}

                  {/* アクションボタン */}
                  <div className="flex items-center gap-3">
                    <Button 
                      className="flex-1 bg-purple-600 hover:bg-purple-700"
                      onClick={() => setSelectedInsight(selectedInsight === insight.id ? null : insight.id)}
                    >
                      <Code className="w-4 h-4 mr-2" />
                      {selectedInsight === insight.id ? 'コードを隠す' : '実装コードを表示'}
                    </Button>
                    <Button variant="outline">
                      <Eye className="w-4 h-4 mr-2" />
                      詳細を見る
                    </Button>
                    <Button variant="outline">
                      <Download className="w-4 h-4 mr-2" />
                      エクスポート
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* 分析履歴 */}
        <Card>
          <CardHeader>
            <CardTitle>分析履歴</CardTitle>
            <CardDescription>過去のAI分析結果と実装状況</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { date: '2025-01-24', insights: 8, implemented: 5, roi: '+180%' },
                { date: '2025-01-23', insights: 6, implemented: 3, roi: '+95%' },
                { date: '2025-01-22', insights: 10, implemented: 7, roi: '+240%' }
              ].map((history, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                  <div>
                    <div className="font-medium">{history.date}</div>
                    <div className="text-sm text-gray-500">
                      {history.insights}件のインサイト • {history.implemented}件実装済み
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-green-600 font-bold">ROI {history.roi}</div>
                    <Button variant="outline" size="sm">詳細</Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}











