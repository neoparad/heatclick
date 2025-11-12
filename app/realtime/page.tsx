'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
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
  // Snake case versions (from API)
  site_id?: string
  session_id?: string
  user_id?: string
  event_type?: string
  scroll_percentage?: number
  time_on_page?: number
  page_url?: string
  elementTag?: string
  elementId?: string
  elementClass?: string
}

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

export default function RealtimePage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<string>('')
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

  const fetchData = async () => {
    if (!selectedSite) return
    
    setIsLoading(true)
    try {
      const response = await fetch(`/api/track?siteId=${selectedSite}&limit=50`)
      const result = await response.json()
      const eventData = result.data || []
      setEvents(eventData)
      
      // 統計計算
      const uniqueUsers = new Set(eventData.map((e: TrackingEvent) => e.userId || e.user_id || 'anonymous').filter((id: string) => id)).size
      const uniqueSessions = new Set(eventData.map((e: TrackingEvent) => e.sessionId || e.session_id || '').filter((id: string) => id)).size
      const clicks = eventData.filter((e: TrackingEvent) => {
        const type = e.eventType || e.event_type || ''
        return type === 'click' || type === 'Click'
      }).length
      const scrolls = eventData.filter((e: TrackingEvent) => {
        const type = e.eventType || e.event_type || ''
        return type === 'scroll' || type === 'Scroll'
      }).length
      const pageViews = eventData.filter((e: TrackingEvent) => {
        const type = e.eventType || e.event_type || ''
        return type === 'page_view' || type === 'pageview' || type === 'PageView'
      }).length

      setStats({
        totalEvents: eventData.length,
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
    if (!selectedSite) return
    
    fetchData()
    const interval = setInterval(fetchData, 5000) // 5秒ごとに更新
    return () => clearInterval(interval)
  }, [selectedSite])

  const getEventIcon = (eventType: string) => {
    if (!eventType) return Activity
    const type = eventType.toLowerCase()
    switch (type) {
      case 'click': return MousePointer
      case 'scroll': return ScrollText
      case 'mouse_move': return Map
      case 'page_view':
      case 'pageview': return Eye
      case 'page_leave': return Clock
      default: return Activity
    }
  }

  const getEventColor = (eventType: string) => {
    if (!eventType) return 'bg-gray-100 text-gray-700'
    const type = eventType.toLowerCase()
    switch (type) {
      case 'click': return 'bg-blue-100 text-blue-700'
      case 'scroll': return 'bg-green-100 text-green-700'
      case 'mouse_move': return 'bg-purple-100 text-purple-700'
      case 'page_view':
      case 'pageview': return 'bg-orange-100 text-orange-700'
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
          <div className="flex items-center gap-4">
            {sites.length > 0 && (
              <Select value={selectedSite} onValueChange={setSelectedSite}>
                <SelectTrigger className="w-64">
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
            )}
            <button 
              onClick={fetchData}
              disabled={isLoading || !selectedSite}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              更新
            </button>
          </div>
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
            {!selectedSite ? (
              <div className="text-center py-8">
                <Globe className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500">サイトを選択してください</p>
              </div>
            ) : events.length === 0 ? (
              <div className="text-center py-8">
                <Activity className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500">イベントデータがありません</p>
                <p className="text-sm text-gray-400 mt-2">
                  サイトでアクティビティが発生すると、ここに表示されます
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  トラッキングスクリプトが正しく設置されているか確認してください
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {events.map((event) => {
                  const eventType = event.eventType || event.event_type || 'unknown'
                  const EventIcon = getEventIcon(eventType)
                  const sessionId = event.sessionId || event.session_id || ''
                  const url = event.url || event.page_url || ''
                  const timestamp = event.timestamp || ''
                  
                  return (
                    <div key={event.id || `${eventType}-${timestamp}`} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                      <div className="flex items-center gap-4 flex-1">
                        <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
                          <EventIcon className="w-4 h-4 text-gray-600" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{eventType}</span>
                            <Badge className={getEventColor(eventType)}>
                              {eventType}
                            </Badge>
                          </div>
                          <div className="text-sm text-gray-500">
                            {url ? formatUrl(url) : 'N/A'} • {timestamp ? formatTime(timestamp) : 'N/A'}
                          </div>
                          {(event.element || event.elementTag) && (
                            <div className="text-xs text-gray-400 mt-1">
                              {event.element?.tagName || event.elementTag || 'N/A'} 
                              {(event.element?.id || event.elementId) && ` #${event.element?.id || event.elementId}`}
                              {(event.element?.className || event.elementClass) && `.${(event.element?.className || event.elementClass).split(' ')[0]}`}
                            </div>
                          )}
                        </div>
                      </div>
                      {sessionId && (
                        <div className="text-xs text-gray-400">
                          {sessionId.substring(0, 8)}...
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </DashboardLayout>
  )
}
