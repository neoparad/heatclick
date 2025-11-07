'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { 
  MousePointer, 
  Eye, 
  ScrollText, 
  Map, 
  Clock, 
  Users,
  Activity,
  TrendingUp,
  Globe,
  RefreshCw
} from 'lucide-react'

interface TrackingEvent {
  id: string
  siteId: string
  sessionId: string
  userId: string
  eventType: string
  timestamp: string
  url: string
  element?: any
  position?: any
  scrollPercentage?: number
  timeOnPage?: number
}

export default function RealtimePage() {
  const [events, setEvents] = useState<TrackingEvent[]>([])
  const [stats, setStats] = useState({
    totalEvents: 0,
    uniqueUsers: 0,
    uniqueSessions: 0,
    clicks: 0,
    scrolls: 0,
    pageViews: 0
  })
  const [isLoading, setIsLoading] = useState(false)

  const fetchData = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/track?limit=50')
      const result = await response.json()
      setEvents(result.data)
      
      // 統計計算
      const uniqueUsers = new Set(result.data.map((e: TrackingEvent) => e.userId)).size
      const uniqueSessions = new Set(result.data.map((e: TrackingEvent) => e.sessionId)).size
      const clicks = result.data.filter((e: TrackingEvent) => e.eventType === 'click').length
      const scrolls = result.data.filter((e: TrackingEvent) => e.eventType === 'scroll').length
      const pageViews = result.data.filter((e: TrackingEvent) => e.eventType === 'page_view').length

      setStats({
        totalEvents: result.data.length,
        uniqueUsers,
        uniqueSessions,
        clicks,
        scrolls,
        pageViews
      })
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000) // 5秒ごとに更新
    return () => clearInterval(interval)
  }, [])

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'click': return MousePointer
      case 'scroll': return ScrollText
      case 'mouse_move': return Map
      case 'page_view': return Eye
      case 'page_leave': return Clock
      default: return Activity
    }
  }

  const getEventColor = (eventType: string) => {
    switch (eventType) {
      case 'click': return 'bg-blue-100 text-blue-700'
      case 'scroll': return 'bg-green-100 text-green-700'
      case 'mouse_move': return 'bg-purple-100 text-purple-700'
      case 'page_view': return 'bg-orange-100 text-orange-700'
      case 'page_leave': return 'bg-red-100 text-red-700'
      default: return 'bg-gray-100 text-gray-700'
    }
  }

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString('ja-JP')
  }

  const formatUrl = (url: string) => {
    try {
      const urlObj = new URL(url)
      return urlObj.pathname + urlObj.search
    } catch {
      return url
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">リアルタイム分析</h1>
            <p className="text-gray-600 mt-2">ライブデータの監視と分析</p>
          </div>
          <button 
            onClick={fetchData}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            更新
          </button>
        </div>

        {/* 統計カード */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">総イベント数</p>
                  <p className="text-2xl font-bold">{stats.totalEvents}</p>
                </div>
                <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Activity className="w-4 h-4 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">ユニークユーザー</p>
                  <p className="text-2xl font-bold">{stats.uniqueUsers}</p>
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
                  <p className="text-sm font-medium text-gray-600">セッション数</p>
                  <p className="text-2xl font-bold">{stats.uniqueSessions}</p>
                </div>
                <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Globe className="w-4 h-4 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">クリック数</p>
                  <p className="text-2xl font-bold">{stats.clicks}</p>
                </div>
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                  <MousePointer className="w-4 h-4 text-orange-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* イベント一覧 */}
        <Card>
          <CardHeader>
            <CardTitle>リアルタイムイベント</CardTitle>
            <CardDescription>最新のユーザー行動データ</CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <div className="text-center py-8">
                <Activity className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500">イベントデータがありません</p>
                <p className="text-sm text-gray-400 mt-2">
                  トラッキングスクリプトが設置されたサイトでアクティビティを確認してください
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {events.map((event) => {
                  const EventIcon = getEventIcon(event.eventType)
                  return (
                    <div key={event.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                      <div className="flex items-center gap-4 flex-1">
                        <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
                          <EventIcon className="w-4 h-4 text-gray-600" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{event.eventType}</span>
                            <Badge className={getEventColor(event.eventType)}>
                              {event.eventType}
                            </Badge>
                          </div>
                          <div className="text-sm text-gray-500">
                            {formatUrl(event.url)} • {formatTime(event.timestamp)}
                          </div>
                          {event.element && (
                            <div className="text-xs text-gray-400 mt-1">
                              {event.element.tagName} {event.element.id && `#${event.element.id}`}
                              {event.element.className && `.${event.element.className.split(' ')[0]}`}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-gray-400">
                        {event.sessionId.substring(0, 8)}...
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* トラッキングスクリプト情報 */}
        <Card>
          <CardHeader>
            <CardTitle>トラッキングスクリプト</CardTitle>
            <CardDescription>サイトに設置するスクリプト</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-gray-100 p-4 rounded-lg">
              <pre className="text-sm overflow-x-auto">
                <code>{`<!-- ClickInsight Pro Tracking Script -->
<script>
  (function(c,i,p){
    var s=document.createElement('script');
    s.type='text/javascript';
    s.async=true;
    s.src='http://localhost:3001/track.js';
    s.setAttribute('data-site-id','YOUR_SITE_ID');
    var x=document.getElementsByTagName('script')[0];
    x.parentNode.insertBefore(s,x);
  })();
</script>
<!-- End ClickInsight Pro -->`}</code>
              </pre>
            </div>
            <div className="mt-4 p-4 bg-blue-50 rounded-lg">
              <h4 className="font-semibold text-blue-800 mb-2">設置方法</h4>
              <ol className="text-sm text-blue-700 space-y-1 list-decimal list-inside">
                <li>上記のスクリプトをコピー</li>
                <li>YOUR_SITE_IDを実際のサイトIDに置き換え</li>
                <li>サイトの&lt;head&gt;タグ内に貼り付け</li>
                <li>サイトにアクセスしてデータを確認</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
