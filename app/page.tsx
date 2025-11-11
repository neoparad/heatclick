import { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { 
  BarChart3, 
  Brain, 
  Zap, 
  Shield, 
  Globe, 
  TrendingUp,
  Users,
  Target,
  Lightbulb,
  ArrowRight
} from 'lucide-react'

export const metadata: Metadata = {
  title: 'ClickInsight Pro - ヒートマップ＆クリック分析ツール',
  description: 'AIによる自動診断と改善提案を行う次世代SEO特化型ヒートマップツール',
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* ヘッダー */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600"></div>
              <span className="text-xl font-bold text-gray-900">ClickInsight Pro</span>
            </Link>
            <nav className="hidden md:flex items-center space-x-6">
              <Link href="#features" className="text-gray-600 hover:text-gray-900">機能</Link>
              <Link href="#pricing" className="text-gray-600 hover:text-gray-900">料金</Link>
              <Link href="#about" className="text-gray-600 hover:text-gray-900">会社概要</Link>
              <Link href="/auth/login">
                <Button variant="outline" size="sm">ログイン</Button>
              </Link>
              <Link href="/auth/register">
                <Button size="sm">無料で始める</Button>
              </Link>
            </nav>
            {/* モバイルメニュー */}
            <div className="md:hidden flex items-center gap-2">
              <Link href="/auth/login">
                <Button variant="outline" size="sm">ログイン</Button>
              </Link>
              <Link href="/auth/register">
                <Button size="sm">始める</Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* メインビジュアル */}
      <section className="py-20">
        <div className="container mx-auto px-4 text-center">
          <Badge variant="secondary" className="mb-4">
            🚀 新機能: AI自動分析
          </Badge>
          <h1 className="text-4xl md:text-6xl font-bold text-gray-900 mb-6">
            ヒートマップで
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-purple-600">
              {' '}ユーザー行動{' '}
            </span>
            を可視化
          </h1>
          <p className="text-xl text-gray-600 mb-8 max-w-3xl mx-auto">
            WordPressサイトのクリック行動とヒートマップを分析し、
            AIによる自動診断と改善提案を行う次世代SEO特化型ツール
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/auth/register">
              <Button size="lg" className="text-lg px-8 py-6">
                無料で始める
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
            <Link href="/dashboard">
              <Button variant="outline" size="lg" className="text-lg px-8 py-6">
                デモを見る
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* 機能セクション */}
      <section id="features" className="py-20 bg-white">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              なぜClickInsight Proなのか？
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              競合を圧倒する3つの差別化ポイント
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <Card className="p-6">
              <CardHeader>
                <div className="h-12 w-12 rounded-lg bg-blue-100 flex items-center justify-center mb-4">
                  <Brain className="h-6 w-6 text-blue-600" />
                </div>
                <CardTitle>AI自動診断</CardTitle>
                <CardDescription>
                  Claude APIによる実装可能な改善提案
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li>• 自動で問題点を発見</li>
                  <li>• 具体的な改善案を提示</li>
                  <li>• 期待効果を算出</li>
                  <li>• 実装時間を見積もり</li>
                </ul>
              </CardContent>
            </Card>

            <Card className="p-6">
              <CardHeader>
                <div className="h-12 w-12 rounded-lg bg-green-100 flex items-center justify-center mb-4">
                  <Globe className="h-6 w-6 text-green-600" />
                </div>
                <CardTitle>SEO完全連携</CardTitle>
                <CardDescription>
                  GSC/Ads APIによるクエリ別ヒートマップ
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li>• Google Search Console連携</li>
                  <li>• Google Ads API連携</li>
                  <li>• クエリ別行動分析</li>
                  <li>• 検索順位とCTRの相関</li>
                </ul>
              </CardContent>
            </Card>

            <Card className="p-6">
              <CardHeader>
                <div className="h-12 w-12 rounded-lg bg-purple-100 flex items-center justify-center mb-4">
                  <Zap className="h-6 w-6 text-purple-600" />
                </div>
                <CardTitle>コスパ最強</CardTitle>
                <CardDescription>
                  競合の半額で高機能
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li>• ミエルカの約50%低価格</li>
                  <li>• AI分析機能が標準搭載</li>
                  <li>• データ保持期間無制限</li>
                  <li>• 内部リンクSEO分析</li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* 料金セクション */}
      <section id="pricing" className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              シンプルな料金プラン
            </h2>
            <p className="text-xl text-gray-600">
              無料から始めて、必要に応じてアップグレード
            </p>
          </div>

          <div className="grid md:grid-cols-4 gap-6">
            <Card className="p-6">
              <CardHeader>
                <CardTitle className="text-lg">Free</CardTitle>
                <div className="text-3xl font-bold">¥0</div>
                <CardDescription>月額</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  <li>• 5,000 PV/月</li>
                  <li>• 1サイト</li>
                  <li>• 基本ヒートマップ</li>
                  <li>• 7日間データ保持</li>
                </ul>
                <Link href="/auth/register" className="block">
                  <Button className="w-full mt-6" variant="outline">
                    無料で始める
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="p-6 border-blue-200 bg-blue-50">
              <CardHeader>
                <CardTitle className="text-lg">Starter</CardTitle>
                <div className="text-3xl font-bold">¥4,980</div>
                <CardDescription>月額</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  <li>• 50,000 PV/月</li>
                  <li>• 3サイト</li>
                  <li>• 全ヒートマップ</li>
                  <li>• AI分析（月1回）</li>
                  <li>• GSC連携</li>
                </ul>
                <Link href="/auth/register" className="block">
                  <Button className="w-full mt-6">
                    今すぐ始める
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="p-6">
              <CardHeader>
                <CardTitle className="text-lg">Professional</CardTitle>
                <div className="text-3xl font-bold">¥9,800</div>
                <CardDescription>月額</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  <li>• 500,000 PV/月</li>
                  <li>• 10サイト</li>
                  <li>• AI分析（週1回）</li>
                  <li>• A/Bテスト</li>
                  <li>• API提供</li>
                </ul>
                <Link href="/auth/register" className="block">
                  <Button className="w-full mt-6" variant="outline">
                    選択する
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="p-6">
              <CardHeader>
                <CardTitle className="text-lg">Business</CardTitle>
                <div className="text-3xl font-bold">¥24,800</div>
                <CardDescription>月額</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  <li>• 2,000,000 PV/月</li>
                  <li>• 50サイト</li>
                  <li>• 無制限AI分析</li>
                  <li>• 専任サポート</li>
                  <li>• カスタム開発</li>
                </ul>
                <Button className="w-full mt-6" variant="outline">
                  お問い合わせ
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* フッター */}
      <footer className="bg-gray-900 text-white py-12">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <div className="flex items-center space-x-2 mb-4">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600"></div>
                <span className="text-xl font-bold">ClickInsight Pro</span>
              </div>
              <p className="text-gray-400">
                次世代SEO特化型ヒートマップツール
              </p>
            </div>
            <div>
              <h3 className="font-semibold mb-4">製品</h3>
              <ul className="space-y-2 text-gray-400">
                <li><Link href="#features">機能</Link></li>
                <li><Link href="#pricing">料金</Link></li>
                <li><Link href="#demo">デモ</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-4">サポート</h3>
              <ul className="space-y-2 text-gray-400">
                <li><Link href="#help">ヘルプ</Link></li>
                <li><Link href="#docs">ドキュメント</Link></li>
                <li><Link href="#contact">お問い合わせ</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-4">会社</h3>
              <ul className="space-y-2 text-gray-400">
                <li><Link href="#about">会社概要</Link></li>
                <li><Link href="#privacy">プライバシー</Link></li>
                <li><Link href="#terms">利用規約</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 mt-8 pt-8 text-center text-gray-400">
            <p>&copy; 2025 ClickInsight Pro. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
