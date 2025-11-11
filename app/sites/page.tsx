'use client'

import { useState, useEffect } from 'react'
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
  Clock,
  Loader2,
  Key
} from 'lucide-react'
import Loading from '../../components/ui/loading'
import ErrorMessage from '../../components/ui/error-message'

interface Site {
  id: string
  name: string
  url: string
  status: 'active' | 'inactive' | 'pending'
  tracking_id: string
  created_at: string
  last_activity: string
  page_views: number
}

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newSite, setNewSite] = useState({ name: '', url: '' })
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [showTrackingScript, setShowTrackingScript] = useState(false)
  const [copiedTrackingId, setCopiedTrackingId] = useState<string | null>(null)

  // Fetch sites from API
  useEffect(() => {
    fetchSites()
  }, [])

  const fetchSites = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch('/api/sites')

      if (!response.ok) {
        throw new Error('Failed to fetch sites')
      }

      const data = await response.json()
      setSites(data.sites || [])
    } catch (err) {
      console.error('Error fetching sites:', err)
      setError('サイトの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleAddSite = async () => {
    if (!newSite.name || !newSite.url) {
      alert('サイト名とURLを入力してください')
      return
    }

    try {
      setSubmitting(true)
      setError(null)

      const response = await fetch('/api/sites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newSite),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to create site')
      }

      const data = await response.json()

      // Add new site to the list
      setSites([data.site, ...sites])
      setNewSite({ name: '', url: '' })
      setShowAddForm(false)

      // Show tracking ID modal after successful registration
      setSelectedSite(data.site)
      setShowTrackingScript(true)
    } catch (err: any) {
      console.error('Error creating site:', err)
      setError(err.message || 'サイトの作成に失敗しました')
      alert(err.message || 'サイトの作成に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteSite = async (id: string) => {
    if (!confirm('本当にこのサイトを削除しますか？')) {
      return
    }

    try {
      const response = await fetch(`/api/sites/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Failed to delete site')
      }

      // Remove site from list
      setSites(sites.filter(site => site.id !== id))
      alert('サイトが削除されました')
    } catch (err) {
      console.error('Error deleting site:', err)
      alert('サイトの削除に失敗しました')
    }
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
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')
    return `<!-- ClickInsight Pro Tracking -->
<script>
    window.CLICKINSIGHT_SITE_ID = '${site.tracking_id}';
    window.CLICKINSIGHT_DEBUG = false; // 本番環境ではfalse
    window.CLICKINSIGHT_API_URL = '${appUrl}/api/track';
    window.CLICKINSIGHT_RECORDING_SAMPLE_RATE = 0.1; // 10%のセッションを録画
</script>
<script src="${appUrl}/tracking.js" async></script>
<script src="${appUrl}/recording.js" async></script>
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

  const copyTrackingId = async (trackingId: string) => {
    try {
      await navigator.clipboard.writeText(trackingId)
      setCopiedTrackingId(trackingId)
      setTimeout(() => setCopiedTrackingId(null), 2000)
    } catch (err) {
      console.error('Failed to copy tracking ID: ', err)
      alert('トラッキングIDのコピーに失敗しました')
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

        {/* Error Message */}
        {error && (
          <ErrorMessage
            title="エラー"
            message={error}
            onDismiss={() => setError(null)}
          />
        )}

        {/* Loading State */}
        {loading && (
          <Loading text="サイトを読み込み中..." />
        )}

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
      {!loading && (
        <div className="grid gap-4">
          {sites.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Globe className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-900 mb-2">サイトが登録されていません</h3>
                <p className="text-gray-600 mb-4">最初のサイトを登録してトラッキングを開始しましょう</p>
                <Button onClick={() => setShowAddForm(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  サイトを追加
                </Button>
              </CardContent>
            </Card>
          ) : (
            sites.map((site) => (
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
                      <div className="flex items-center space-x-2">
                        <Key className="w-3 h-3 text-gray-400" />
                        <span className="text-sm text-gray-500 font-mono">
                          トラッキングID: {site.tracking_id}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2"
                          onClick={() => copyTrackingId(site.tracking_id)}
                          title="トラッキングIDをコピー"
                        >
                          <Copy className={`w-3 h-3 ${copiedTrackingId === site.tracking_id ? 'text-green-600' : ''}`} />
                        </Button>
                      </div>
                      <span className="text-sm text-gray-500">
                        PV: {(site.page_views || 0).toLocaleString()}
                      </span>
                      <span className="text-sm text-gray-500">
                        最終活動: {site.last_activity ? new Date(site.last_activity).toLocaleDateString('ja-JP') : 'なし'}
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
                    <Key className="w-4 h-4 mr-1" />
                    トラッキングID
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
            ))
          )}
        </div>
      )}

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
              {/* トラッキングID表示 */}
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-semibold text-blue-900 mb-1 block">トラッキングID</Label>
                    <p className="text-sm font-mono text-blue-700">{selectedSite.tracking_id}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyTrackingId(selectedSite.tracking_id)}
                    className={copiedTrackingId === selectedSite.tracking_id ? 'bg-green-50 border-green-300' : ''}
                  >
                    <Copy className={`w-4 h-4 mr-1 ${copiedTrackingId === selectedSite.tracking_id ? 'text-green-600' : ''}`} />
                    {copiedTrackingId === selectedSite.tracking_id ? 'コピー済み' : 'コピー'}
                  </Button>
                </div>
              </div>

              {/* トラッキングスクリプト */}
              <div>
                <Label className="text-sm font-semibold mb-2 block">トラッキングスクリプト</Label>
                <div className="bg-gray-100 p-4 rounded-lg">
                  <pre className="text-sm overflow-x-auto">
                    <code>{generateTrackingScript(selectedSite)}</code>
                  </pre>
                </div>
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
