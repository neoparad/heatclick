'use client'

import { useState, useEffect, useCallback } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Sankey, Tooltip, ResponsiveContainer } from 'recharts'
import {
  Loader2,
  AlertCircle,
  Globe,
  GitBranch,
  Users,
  Repeat,
  TrendingUp,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

interface SankeyNode { name: string }
interface SankeyLink { source: number; target: number; value: number }
interface SankeyData { nodes: SankeyNode[]; links: SankeyLink[]; total_cv_sessions: number }

interface SessionData {
  session_id: string
  visit_number: number
  session_start: string
  landing_page: string
  utm_medium: string
  utm_source: string
  device_type: string
  pages_visited: string[]
  page_views: number
  conversion_type: string | null
  conversion_value: number
}

interface UserPath {
  user_id: string
  sessions: SessionData[]
  total_sessions: number
  conversion_type: string | null
  conversion_value: number
}

interface PathSummary {
  total_cv_users: number
  avg_sessions_to_convert: number
  medium_breakdown: Record<string, number>
}

const MEDIUM_COLORS: Record<string, string> = {
  organic: '#16a34a',
  cpc: '#2563eb',
  referral: '#ca8a04',
  social: '#db2777',
  direct: '#6b7280',
  email: '#7c3aed',
}

export default function CvPathsPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [sankeyData, setSankeyData] = useState<SankeyData | null>(null)
  const [paths, setPaths] = useState<UserPath[]>([])
  const [summary, setSummary] = useState<PathSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [sankeyLoading, setSankeyLoading] = useState(false)
  const [pathsLoading, setPathsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')
  const [expandedUser, setExpandedUser] = useState<string | null>(null)

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

  const buildParams = useCallback(() => {
    if (!selectedSite) return null
    let startDate: string | undefined, endDate: string | undefined
    if (dateRange !== 'all') {
      const end = new Date(), start = new Date()
      start.setDate(start.getDate() - (dateRange === '7days' ? 7 : dateRange === '30days' ? 30 : 90))
      startDate = start.toISOString().split('T')[0]
      endDate = end.toISOString().split('T')[0]
    }
    const params = new URLSearchParams({ site_id: selectedSite.tracking_id })
    if (startDate) params.append('start_date', startDate)
    if (endDate) params.append('end_date', endDate)
    return params
  }, [selectedSite, dateRange])

  // Sankeyデータ取得
  useEffect(() => {
    const params = buildParams()
    if (!params) { setSankeyData(null); return }
    const fetchSankey = async () => {
      setSankeyLoading(true)
      try {
        params.append('format', 'sankey')
        const response = await fetch(`/api/cv-paths?${params.toString()}`)
        if (!response.ok) throw new Error('Failed')
        const result = await response.json()
        setSankeyData(result.data || null)
      } catch { setSankeyData(null) }
      finally { setSankeyLoading(false) }
    }
    fetchSankey()
  }, [buildParams])

  // CV経路リスト取得
  useEffect(() => {
    const params = buildParams()
    if (!params) { setPaths([]); setSummary(null); return }
    const fetchPaths = async () => {
      setPathsLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/cv-paths?${params.toString()}`)
        if (!response.ok) throw new Error('Failed')
        const result = await response.json()
        setPaths(result.data?.paths || [])
        setSummary(result.data?.summary || null)
      } catch {
        setPaths([])
        setError('CV経路データの取得に失敗しました')
      } finally { setPathsLoading(false) }
    }
    fetchPaths()
  }, [buildParams])

  const getMediumColor = (medium: string) => MEDIUM_COLORS[medium] || '#9ca3af'

  const CustomSankeyTooltip = ({ active, payload }: any) => {
    if (!active || !payload || payload.length === 0) return null
    const data = payload[0]?.payload
    if (!data) return null

    if (data.source !== undefined && data.target !== undefined && sankeyData) {
      const sourceName = sankeyData.nodes[data.source]?.name || ''
      const targetName = sankeyData.nodes[data.target]?.name || ''
      return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
          <p className="font-semibold">{sourceName} → {targetName}</p>
          <p className="text-gray-500">{data.value} セッション</p>
        </div>
      )
    }

    if (data.name) {
      return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
          <p className="font-semibold">{data.name}</p>
        </div>
      )
    }

    return null
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
          <h1 className="text-2xl font-bold">CV経路分析</h1>
          <p className="text-sm text-gray-500 mt-1">コンバージョンに至ったユーザーの流入元・ページ遷移・訪問回数を可視化</p>
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
            {/* フィルター */}
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                </div>
              </CardContent>
            </Card>

            {/* サマリー */}
            {summary && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><Users className="w-4 h-4 text-blue-500" /><span className="text-xs text-gray-500">CVユーザー数</span></div>
                  <p className="text-2xl font-bold">{summary.total_cv_users}</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><Repeat className="w-4 h-4 text-purple-500" /><span className="text-xs text-gray-500">平均訪問回数（CV迄）</span></div>
                  <p className="text-2xl font-bold">{summary.avg_sessions_to_convert}<span className="text-sm text-gray-400">回</span></p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-4 h-4 text-green-500" /><span className="text-xs text-gray-500">流入元内訳</span></div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {Object.entries(summary.medium_breakdown).sort(([,a],[,b]) => b - a).map(([medium, count]) => (
                      <span key={medium} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{ backgroundColor: getMediumColor(medium) + '20', color: getMediumColor(medium) }}>
                        {medium}: {count}
                      </span>
                    ))}
                  </div>
                </CardContent></Card>
              </div>
            )}

            {/* Sankey図 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <GitBranch className="w-4 h-4" />
                  CV経路フロー
                </CardTitle>
                <p className="text-xs text-gray-400">流入元 → ランディングページ → 遷移先 → CV のフロー。線の太さはセッション数に比例</p>
              </CardHeader>
              <CardContent>
                {sankeyLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400 mr-2" />
                    <span className="text-gray-500 text-sm">フロー図を生成中...</span>
                  </div>
                ) : sankeyData && sankeyData.nodes.length > 0 && sankeyData.links.length > 0 ? (
                  <div className="overflow-x-auto">
                    <div style={{ minWidth: '600px', height: '400px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <Sankey
                          data={sankeyData}
                          nodeWidth={10}
                          nodePadding={24}
                          margin={{ top: 10, right: 160, bottom: 10, left: 10 }}
                          link={{ stroke: '#93c5fd', strokeOpacity: 0.4 }}
                          node={{
                            fill: '#3b82f6',
                            fillOpacity: 0.9,
                          }}
                        >
                          <Tooltip content={<CustomSankeyTooltip />} />
                        </Sankey>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-2 text-center">
                      CVセッション数: {sankeyData.total_cv_sessions} / ノード: {sankeyData.nodes.length} / フロー: {sankeyData.links.length}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12">
                    <GitBranch className="w-12 h-12 text-gray-300 mb-4" />
                    <p className="text-gray-500 mb-2">CVデータがありません</p>
                    <p className="text-xs text-gray-400">コンバージョンイベントを設定してください:
                      <code className="bg-gray-100 px-1 ml-1 rounded">ClickInsight.trackConversion(&apos;purchase&apos;, 9800)</code>
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* CV経路リスト */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">CVユーザー経路詳細</CardTitle>
                <p className="text-xs text-gray-400">各ユーザーの初回訪問からCV完了までの全セッション</p>
              </CardHeader>
              <CardContent>
                {pathsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400 mr-2" />
                    <span className="text-gray-500 text-sm">データを取得中...</span>
                  </div>
                ) : paths.length === 0 ? (
                  <p className="text-gray-400 text-sm text-center py-8">CVユーザーのデータがありません</p>
                ) : (
                  <div className="space-y-2">
                    {paths.slice(0, 20).map((user) => (
                      <div key={user.user_id} className="border border-gray-100 rounded-lg overflow-hidden">
                        <button
                          onClick={() => setExpandedUser(expandedUser === user.user_id ? null : user.user_id)}
                          className="w-full text-left px-4 py-3 hover:bg-gray-50/50 flex items-center justify-between"
                        >
                          <div className="flex items-center gap-3">
                            {expandedUser === user.user_id
                              ? <ChevronDown className="w-4 h-4 text-gray-400" />
                              : <ChevronRight className="w-4 h-4 text-gray-400" />}
                            <div>
                              <span className="text-sm font-medium text-gray-700">
                                {user.user_id.substring(0, 8)}...
                              </span>
                              <span className="ml-2 text-xs text-gray-400">{user.total_sessions}セッション</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                              style={{ backgroundColor: getMediumColor(user.sessions[0]?.utm_medium || 'direct') + '20', color: getMediumColor(user.sessions[0]?.utm_medium || 'direct') }}>
                              {user.sessions[0]?.utm_medium || 'direct'}
                            </span>
                            {user.conversion_type && (
                              <span className="inline-block px-2 py-0.5 rounded bg-green-50 text-green-600 text-xs font-bold">
                                {user.conversion_type}
                                {user.conversion_value > 0 && ` ¥${user.conversion_value.toLocaleString()}`}
                              </span>
                            )}
                          </div>
                        </button>

                        {expandedUser === user.user_id && (
                          <div className="px-4 pb-4 border-t border-gray-100">
                            <div className="relative pl-6 mt-3 space-y-3">
                              {/* タイムライン */}
                              <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-gray-200" />
                              {user.sessions.map((session, idx) => (
                                <div key={session.session_id} className="relative">
                                  <div className={`absolute left-[-15px] top-1 w-3 h-3 rounded-full border-2 ${
                                    session.conversion_type ? 'bg-green-500 border-green-500' : 'bg-white border-gray-300'
                                  }`} />
                                  <div className="text-xs">
                                    <div className="flex items-center gap-2 mb-0.5">
                                      <span className="font-semibold text-gray-700">訪問 #{session.visit_number}</span>
                                      <span className="text-gray-400">{new Date(session.session_start).toLocaleString('ja-JP')}</span>
                                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                                        style={{ backgroundColor: getMediumColor(session.utm_medium) + '20', color: getMediumColor(session.utm_medium) }}>
                                        {session.utm_medium}
                                      </span>
                                      <span className="text-gray-300">{session.device_type}</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {session.pages_visited.slice(0, 8).map((page, pi) => (
                                        <span key={pi} className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">
                                          {page}
                                        </span>
                                      ))}
                                      {session.pages_visited.length > 8 && (
                                        <span className="text-gray-400 text-[10px]">+{session.pages_visited.length - 8}ページ</span>
                                      )}
                                    </div>
                                    {session.conversion_type && (
                                      <div className="mt-1">
                                        <span className="inline-block bg-green-50 text-green-700 px-2 py-0.5 rounded text-[10px] font-bold">
                                          CV: {session.conversion_type}
                                          {session.conversion_value > 0 && ` (¥${session.conversion_value.toLocaleString()})`}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {paths.length > 20 && (
                      <p className="text-xs text-gray-400 text-center py-2">上位20ユーザーを表示中（全{paths.length}ユーザー）</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
