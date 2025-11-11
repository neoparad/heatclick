'use client'

import { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Badge } from '../../components/ui/badge'
import { 
  Settings, 
  Code, 
  Copy, 
  CheckCircle, 
  AlertCircle, 
  Globe,
  Shield,
  Bell,
  Database,
  Zap,
  ExternalLink
} from 'lucide-react'

export default function SettingsPage() {
  const [selectedSite, setSelectedSite] = useState('example.com')
  const [showTrackingScript, setShowTrackingScript] = useState(false)

  // サンプルサイトデータ
  const sites = [
    { id: 'site_001', name: 'メインサイト', url: 'example.com', status: 'active' },
    { id: 'site_002', name: 'ブログ', url: 'blog.example.com', status: 'active' },
    { id: 'site_003', name: 'ランディングページ', url: 'lp.example.com', status: 'pending' }
  ]

  const generateTrackingScript = (siteId: string) => {
    return `<!-- ClickInsight Pro Tracking Script -->
<script>
  (function(c,i,p){
    var s=document.createElement('script');
    s.type='text/javascript';
    s.async=true;
    s.src='http://localhost:3001/track.js';
    s.setAttribute('data-site-id','${siteId}');
    var x=document.getElementsByTagName('script')[0];
    x.parentNode.insertBefore(s,x);
  })();
</script>
<!-- End ClickInsight Pro -->`
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      alert('トラッキングコードをコピーしました！')
    } catch (err) {
      console.error('Failed to copy: ', err)
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">設定</h1>
            <p className="text-gray-600 mt-2">アカウントとトラッキングの設定管理</p>
          </div>
        </div>

        {/* トラッキングスクリプト管理 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code className="w-5 h-5" />
              トラッキングスクリプト管理
            </CardTitle>
            <CardDescription>
              各サイトのトラッキングコードを生成・管理します
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {sites.map((site) => (
                <div key={site.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-semibold">{site.name}</h3>
                      <p className="text-sm text-gray-600">{site.url}</p>
                    </div>
                    <Badge className={site.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}>
                      {site.status === 'active' ? 'アクティブ' : '待機中'}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedSite(site.name)
                        setShowTrackingScript(true)
                      }}
                    >
                      <Code className="w-4 h-4 mr-1" />
                      コード生成
                    </Button>
                    <Button variant="outline" size="sm">
                      <ExternalLink className="w-4 h-4 mr-1" />
                      サイトを開く
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* アカウント設定 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              アカウント設定
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="company">会社名</Label>
                <Input id="company" defaultValue="株式会社Example" />
              </div>
              <div>
                <Label htmlFor="email">メールアドレス</Label>
                <Input id="email" type="email" defaultValue="admin@example.com" />
              </div>
              <div>
                <Label htmlFor="plan">プラン</Label>
                <div className="flex items-center gap-2 mt-2">
                  <Badge className="bg-blue-100 text-blue-700">Starter</Badge>
                  <Button variant="outline" size="sm">プラン変更</Button>
                </div>
              </div>
              <div>
                <Label htmlFor="usage">今月の使用量</Label>
                <div className="mt-2">
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div className="bg-blue-600 h-2 rounded-full" style={{ width: '65%' }} />
                  </div>
                  <p className="text-sm text-gray-500 mt-1">32,500 / 50,000 PV</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 通知設定 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5" />
              通知設定
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium">重要な分析結果</h4>
                  <p className="text-sm text-gray-600">AI分析で重要な改善点が発見された時</p>
                </div>
                <Button variant="outline" size="sm">有効</Button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium">週次レポート</h4>
                  <p className="text-sm text-gray-600">毎週月曜日に分析レポートを送信</p>
                </div>
                <Button variant="outline" size="sm">有効</Button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium">システム通知</h4>
                  <p className="text-sm text-gray-600">メンテナンスやアップデート情報</p>
                </div>
                <Button variant="outline" size="sm">有効</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* データ管理 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              データ管理
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold mb-2">データ保持期間</h4>
                <p className="text-sm text-gray-600 mb-3">現在: 無制限</p>
                <Button variant="outline" size="sm">設定変更</Button>
              </div>
              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold mb-2">データエクスポート</h4>
                <p className="text-sm text-gray-600 mb-3">CSV/JSON形式でダウンロード</p>
                <Button variant="outline" size="sm">エクスポート</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* トラッキングスクリプトモーダル */}
        {showTrackingScript && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <Card className="w-full max-w-2xl mx-4">
              <CardHeader>
                <CardTitle>トラッキングコード - {selectedSite}</CardTitle>
                <CardDescription>
                  以下のコードをサイトの &lt;head&gt; タグ内に配置してください
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="bg-gray-100 p-4 rounded-lg">
                  <pre className="text-sm overflow-x-auto">
                    <code>{generateTrackingScript('site_001')}</code>
                  </pre>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => copyToClipboard(generateTrackingScript('site_001'))}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    コードをコピー
                  </Button>
                  <Button variant="outline" onClick={() => setShowTrackingScript(false)}>
                    閉じる
                  </Button>
                </div>
                
                {/* GTM連携 */}
                <div className="border-t pt-4">
                  <h4 className="font-semibold mb-2">Google Tag Manager との連携</h4>
                  <p className="text-sm text-gray-600 mb-3">
                    GTMを使用している場合は、以下の設定で連携できます
                  </p>
                  <div className="bg-blue-50 p-3 rounded-lg">
                    <p className="text-sm">
                      <strong>GTM設定:</strong><br/>
                      1. GTMで新しいタグを作成<br/>
                      2. タグタイプ: カスタムHTML<br/>
                      3. 上記のトラッキングコードを貼り付け<br/>
                      4. トリガー: All Pages
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}





