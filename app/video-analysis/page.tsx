'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent } from '../../components/ui/card'
import {
  Loader2,
  AlertCircle,
  Globe,
  Video,
  Play,
  CheckCircle,
  Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

interface PageData { url: string; count: number }

interface VideoData {
  video_src: string
  page_url: string
  plays: number
  completions: number
  completion_rate: number
  avg_played_ms: number
  video_duration: number
  avg_watch_percent: number
  avg_interactions: number
  unique_sessions: number
}

interface Milestone { milestone: number; reached: number }
interface Summary { total_videos: number; total_plays: number; total_completions: number; avg_completion_rate: number; avg_watch_time_ms: number }

export default function VideoAnalysisPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [selectedPageUrl, setSelectedPageUrl] = useState('')
  const [videos, setVideos] = useState<VideoData[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null)
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [milestoneLoading, setMilestoneLoading] = useState(false)

  useEffect(() => {
    const fetchSites = async () => {
      setLoading(true)
      try {
        const response = await fetch('/api/sites')
        if (!response.ok) throw new Error('Failed')
        const result = await response.json()
        const sitesList = result.sites || []
        setSites(sitesList)
        if (sitesList.length > 0) setSelectedSite(sitesList[0])
      } catch { setError('サイト情報の取得に失敗しました') }
      finally { setLoading(false) }
    }
    fetchSites()
  }, [])

  useEffect(() => {
    if (!selectedSite) { setPages([]); setSelectedPageUrl(''); return }
    const fetchPages = async () => {
      try {
        const response = await fetch(`/api/pages?site_id=${selectedSite.tracking_id}`)
        if (!response.ok) throw new Error('Failed')
        setPages((await response.json()).data || [])
        setSelectedPageUrl('')
      } catch { setPages([]) }
    }
    fetchPages()
  }, [selectedSite])

  useEffect(() => {
    if (!selectedSite) { setVideos([]); setSummary(null); return }
    const fetchData = async () => {
      setDataLoading(true); setError(null)
      try {
        let startDate: string | undefined, endDate: string | undefined
        if (dateRange !== 'all') {
          const end = new Date(), start = new Date()
          start.setDate(start.getDate() - (dateRange === '7days' ? 7 : dateRange === '30days' ? 30 : 90))
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
        }
        const params = new URLSearchParams({ site_id: selectedSite.tracking_id })
        if (selectedPageUrl) params.append('page_url', selectedPageUrl)
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)

        const response = await fetch(`/api/video-analysis?${params.toString()}`)
        if (!response.ok) throw new Error('Failed')
        const result = await response.json()
        setVideos(result.data?.videos || [])
        setSummary(result.data?.summary || null)
      } catch {
        setVideos([]); setError('動画分析データの取得に失敗しました')
      } finally { setDataLoading(false) }
    }
    fetchData()
  }, [selectedSite, selectedPageUrl, dateRange])

  // マイルストーン詳細取得
  const toggleVideo = async (videoSrc: string) => {
    if (expandedVideo === videoSrc) { setExpandedVideo(null); return }
    setExpandedVideo(videoSrc)
    setMilestoneLoading(true)
    try {
      const params = new URLSearchParams({ site_id: selectedSite!.tracking_id, video_src: videoSrc })
      const response = await fetch(`/api/video-analysis?${params.toString()}`)
      if (!response.ok) throw new Error('Failed')
      const result = await response.json()
      setMilestones(result.data?.milestones || [])
    } catch { setMilestones([]) }
    finally { setMilestoneLoading(false) }
  }

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  const getVideoName = (src: string) => {
    try { return new URL(src).pathname.split('/').pop() || src }
    catch { return src.split('/').pop() || src }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400 mr-2" />
          <span className="text-gray-500">読み込み中...</span>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">動画分析</h1>
          <p className="text-sm text-gray-500 mt-1">動画の再生数・完了率・視聴時間・マイルストーン到達率を分析</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
          </div>
        )}

        {sites.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Globe className="w-12 h-12 text-gray-300 mb-4" />
              <p className="text-gray-500 mb-4">登録されているサイトがありません</p>
              <a href="/sites" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">サイトを登録する</a>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">サイト</label>
                    <select value={selectedSite?.id || ''}
                      onChange={(e) => { const s = sites.find(s => s.id === e.target.value); if (s) setSelectedSite(s) }}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                      {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">期間</label>
                    <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                      <option value="7days">過去7日間</option>
                      <option value="30days">過去30日間</option>
                      <option value="90days">過去90日間</option>
                      <option value="all">全期間</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">ページ</label>
                    {pages.length > 0 ? (
                      <select value={selectedPageUrl} onChange={(e) => setSelectedPageUrl(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">全ページ</option>
                        {pages.map(p => <option key={p.url} value={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '')} ({p.count.toLocaleString()})</option>)}
                      </select>
                    ) : <div className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-400">データなし</div>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {summary && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><Video className="w-4 h-4 text-blue-500" /><span className="text-xs text-gray-500">動画数</span></div>
                  <p className="text-2xl font-bold">{summary.total_videos}</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><Play className="w-4 h-4 text-green-500" /><span className="text-xs text-gray-500">総再生数</span></div>
                  <p className="text-2xl font-bold">{summary.total_plays.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><CheckCircle className="w-4 h-4 text-purple-500" /><span className="text-xs text-gray-500">平均完了率</span></div>
                  <p className="text-2xl font-bold">{summary.avg_completion_rate}<span className="text-sm text-gray-400">%</span></p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><Clock className="w-4 h-4 text-orange-500" /><span className="text-xs text-gray-500">平均視聴時間</span></div>
                  <p className="text-2xl font-bold">{formatDuration(summary.avg_watch_time_ms)}</p>
                </CardContent></Card>
              </div>
            )}

            {dataLoading ? (
              <Card><CardContent className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-gray-400 mr-2" /><span className="text-gray-500 text-sm">データを取得中...</span>
              </CardContent></Card>
            ) : videos.length === 0 ? (
              <Card><CardContent className="flex flex-col items-center justify-center py-12">
                <Video className="w-12 h-12 text-gray-300 mb-4" />
                <p className="text-gray-500 mb-2">動画データがありません</p>
                <p className="text-xs text-gray-400">トラッキングスクリプトの <code className="bg-gray-100 px-1 rounded">data-extensions=&quot;video&quot;</code> が有効か確認してください</p>
              </CardContent></Card>
            ) : (
              <div className="space-y-3">
                {videos.map((video) => (
                  <Card key={video.video_src}>
                    <button onClick={() => toggleVideo(video.video_src)} className="w-full text-left">
                      <CardContent className="pt-4 pb-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {expandedVideo === video.video_src
                              ? <ChevronDown className="w-4 h-4 text-gray-400" />
                              : <ChevronRight className="w-4 h-4 text-gray-400" />}
                            <div>
                              <h3 className="font-semibold text-sm truncate max-w-[300px]">{getVideoName(video.video_src)}</h3>
                              <p className="text-xs text-gray-400 mt-0.5">{video.page_url.replace(/^https?:\/\/[^/]+/, '') || '/'}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-sm">
                            <div className="text-center">
                              <p className="text-xs text-gray-400">再生</p>
                              <p className="font-semibold">{video.plays.toLocaleString()}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-gray-400">完了</p>
                              <p className="font-semibold text-green-600">{video.completions.toLocaleString()}</p>
                            </div>
                            <div className="text-center min-w-[60px]">
                              <p className="text-xs text-gray-400">完了率</p>
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                                video.completion_rate >= 50 ? 'text-green-600 bg-green-50' :
                                video.completion_rate >= 25 ? 'text-yellow-600 bg-yellow-50' :
                                'text-red-600 bg-red-50'
                              }`}>{video.completion_rate}%</span>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-gray-400">平均視聴</p>
                              <p className="font-semibold">{formatDuration(video.avg_played_ms)}</p>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </button>

                    {expandedVideo === video.video_src && (
                      <div className="border-t border-gray-100 px-6 pb-4">
                        <h4 className="text-xs font-semibold text-gray-500 mt-4 mb-3">マイルストーン到達率</h4>
                        {milestoneLoading ? (
                          <div className="flex items-center gap-2 py-4">
                            <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                            <span className="text-xs text-gray-400">読み込み中...</span>
                          </div>
                        ) : milestones.length === 0 ? (
                          <p className="text-xs text-gray-400 py-2">マイルストーンデータなし</p>
                        ) : (
                          <div className="space-y-2">
                            {[25, 50, 75].map(pct => {
                              const m = milestones.find(ms => ms.milestone === pct)
                              const reached = m?.reached || 0
                              const ratio = video.plays > 0 ? Math.round((reached / video.plays) * 100) : 0
                              return (
                                <div key={pct} className="flex items-center gap-3">
                                  <span className="text-xs text-gray-500 w-10">{pct}%</span>
                                  <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${
                                        ratio >= 50 ? 'bg-green-500' : ratio >= 25 ? 'bg-yellow-500' : 'bg-red-400'
                                      }`}
                                      style={{ width: `${ratio}%` }}
                                    />
                                  </div>
                                  <span className="text-xs font-medium text-gray-600 w-16 text-right">{reached} ({ratio}%)</span>
                                </div>
                              )
                            })}
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-500 w-10">完了</span>
                              <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                                <div
                                  className={`h-full rounded-full bg-blue-500`}
                                  style={{ width: `${video.plays > 0 ? Math.round((video.completions / video.plays) * 100) : 0}%` }}
                                />
                              </div>
                              <span className="text-xs font-medium text-gray-600 w-16 text-right">{video.completions} ({video.completion_rate}%)</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
