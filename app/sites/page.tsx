'use client'

import { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Badge } from '../../components/ui/badge'
import { 
  Plus, 
  Globe, 
  Settings, 
  Trash2, 
  Copy, 
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Clock
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  status: 'active' | 'inactive' | 'pending'
  trackingId: string
  createdAt: string
  lastActivity: string
  pageViews: number
}

const mockSites: Site[] = [
  {
    id: '1',
    name: 'メインサイト',
    url: 'https://example.com',
    status: 'active',
    trackingId: 'CIP_1234567890',
    createdAt: '2024-01-15',
    lastActivity: '2024-01-20',
    pageViews: 15420
  },
  {
    id: '2',
    name: 'ブログ',
    url: 'https://blog.example.com',
    status: 'active',
    trackingId: 'CIP_0987654321',
    createdAt: '2024-01-10',
    lastActivity: '2024-01-19',
    pageViews: 8230
  },
  {
    id: '3',
    name: 'ランディングページ',
    url: 'https://lp.example.com',
    status: 'pending',
    trackingId: 'CIP_1122334455',
    createdAt: '2024-01-18',
    lastActivity: '2024-01-18',
    pageViews: 0
  }
]

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>(mockSites)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newSite, setNewSite] = useState({ name: '', url: '' })
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [showTrackingScript, setShowTrackingScript] = useState(false)

  const handleAddSite = () => {
    if (newSite.name && newSite.url) {
      const site: Site = {
        id: Date.now().toString(),
        name: newSite.name,
        url: newSite.url,
        status: 'pending',
        trackingId: `CIP_${Math.random().toString(36).substr(2, 10)}`,
        createdAt: new Date().toISOString().split('T')[0],
        lastActivity: new Date().toISOString().split('T')[0],
        pageViews: 0
      }
      setSites([...sites, site])
      setNewSite({ name: '', url: '' })
      setShowAddForm(false)
    }
  }

  const handleDeleteSite = (id: string) => {
    setSites(sites.filter(site => site.id !== id))
  }

  const getStatusBadge = (status: Site['status']) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-100 text-green-700"><CheckCircle className="w-3 h-3 mr-1" />アクティブ</Badge>
      case 'inactive':
        return <Badge className="bg-red-100 text-red-700"><AlertCircle className="w-3 h-3 mr-1" />非アクティブ</Badge>
      case 'pending':
        return <Badge className="bg-yellow-100 text-yellow-700"><Clock className="w-3 h-3 mr-1" />待機中</Badge>
    }
  }

  const generateTrackingScript = (site: Site) => {
    return `<!-- ClickInsight Pro Tracking Script -->
<script>
  (function(c,i,p){
    var s=document.createElement('script');
    s.type='text/javascript';
    s.async=true;
    s.src='http://localhost:3001/track.js';
    s.setAttribute('data-site-id','${site.trackingId}');
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
          <h1 className="text-3xl font-bold">サイト管理</h1>
          <p className="text-gray-600 mt-2">トラッキング対象サイトの管理と設定</p>
        </div>
        <Button 
          onClick={() => setShowAddForm(true)}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <Plus className="w-4 h-4 mr-2" />
          サイトを追加
        </Button>
      </div>

      {/* サイト追加フォーム */}
      {showAddForm && (
        <Card>
          <CardHeader>
            <CardTitle>新しいサイトを追加</CardTitle>
            <CardDescription>トラッキングを開始するサイトの情報を入力してください</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="site-name">サイト名</Label>
              <Input
                id="site-name"
                value={newSite.name}
                onChange={(e) => setNewSite({ ...newSite, name: e.target.value })}
                placeholder="例: メインサイト"
              />
            </div>
            <div>
              <Label htmlFor="site-url">URL</Label>
              <Input
                id="site-url"
                value={newSite.url}
                onChange={(e) => setNewSite({ ...newSite, url: e.target.value })}
                placeholder="https://example.com"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleAddSite} className="bg-blue-600 hover:bg-blue-700">
                サイトを追加
              </Button>
              <Button variant="outline" onClick={() => setShowAddForm(false)}>
                キャンセル
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* サイト一覧 */}
      <div className="grid gap-4">
        {sites.map((site) => (
          <Card key={site.id} className="hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                    <Globe className="w-6 h-6 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg">{site.name}</h3>
                    <p className="text-gray-600">{site.url}</p>
                    <div className="flex items-center space-x-4 mt-2">
                      {getStatusBadge(site.status)}
                      <span className="text-sm text-gray-500">
                        PV: {site.pageViews.toLocaleString()}
                      </span>
                      <span className="text-sm text-gray-500">
                        最終活動: {site.lastActivity}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedSite(site)
                      setShowTrackingScript(true)
                    }}
                  >
                    <Copy className="w-4 h-4 mr-1" />
                    トラッキングコード
                  </Button>
                  <Button variant="outline" size="sm">
                    <Settings className="w-4 h-4 mr-1" />
                    設定
                  </Button>
                  <Button variant="outline" size="sm">
                    <ExternalLink className="w-4 h-4 mr-1" />
                    サイトを開く
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeleteSite(site.id)}
                    className="text-red-600 hover:text-red-700"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* トラッキングスクリプトモーダル */}
      {showTrackingScript && selectedSite && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-2xl mx-4">
            <CardHeader>
              <CardTitle>トラッキングコード - {selectedSite.name}</CardTitle>
              <CardDescription>
                以下のコードをサイトの &lt;head&gt; タグ内に配置してください
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-gray-100 p-4 rounded-lg">
                <pre className="text-sm overflow-x-auto">
                  <code>{generateTrackingScript(selectedSite)}</code>
                </pre>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => copyToClipboard(generateTrackingScript(selectedSite))}
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
