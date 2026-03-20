'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import {
  Loader2,
  AlertCircle,
  Globe,
  FormInput,
  Clock,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  LogOut,
  CheckCircle,
} from 'lucide-react'

interface Site {
  id: string
  name: string
  url: string
  tracking_id: string
}

interface PageData {
  url: string
  count: number
}

interface FieldData {
  field_name: string
  field_type: string
  interactions: number
  avg_duration_ms: number
  max_duration_ms: number
  filled_rate: number
  unfilled_count: number
  unique_sessions: number
}

interface AbandonPoint {
  field_name: string
  abandon_count: number
}

interface FormData {
  form_id: string
  form_action: string
  page_url: string
  field_count: number
  views: number
  started: number
  submitted: number
  abandoned: number
  completion_rate: number
  abandon_rate: number
  fields: FieldData[]
  abandon_points: AbandonPoint[]
}

interface Summary {
  total_forms: number
  total_views: number
  total_submitted: number
  total_abandoned: number
  avg_completion_rate: number
}

export default function FormAnalysisPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>('')
  const [forms, setForms] = useState<FormData[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')
  const [expandedForm, setExpandedForm] = useState<string | null>(null)

  // サイトリスト取得
  useEffect(() => {
    const fetchSites = async () => {
      setLoading(true)
      try {
        const response = await fetch('/api/sites')
        if (!response.ok) throw new Error('Failed to fetch sites')
        const result = await response.json()
        const sitesList = result.sites || []
        setSites(sitesList)
        if (sitesList.length > 0) setSelectedSite(sitesList[0])
      } catch {
        setError('サイト情報の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }
    fetchSites()
  }, [])

  // ページリスト取得
  useEffect(() => {
    if (!selectedSite) { setPages([]); setSelectedPageUrl(''); return }
    const fetchPages = async () => {
      try {
        const response = await fetch(`/api/pages?site_id=${selectedSite.tracking_id}`)
        if (!response.ok) throw new Error('Failed to fetch pages')
        const result = await response.json()
        const pageList = result.data || []
        setPages(pageList)
        setSelectedPageUrl('')
      } catch {
        setPages([])
      }
    }
    fetchPages()
  }, [selectedSite])

  // フォーム分析データ取得
  useEffect(() => {
    if (!selectedSite) { setForms([]); setSummary(null); return }
    const fetchData = async () => {
      setDataLoading(true)
      setError(null)
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

        const response = await fetch(`/api/form-analysis?${params.toString()}`)
        if (!response.ok) throw new Error('Failed to fetch data')
        const result = await response.json()
        setForms(result.data?.forms || [])
        setSummary(result.data?.summary || null)
      } catch {
        setForms([])
        setSummary(null)
        setError('フォーム分析データの取得に失敗しました')
      } finally {
        setDataLoading(false)
      }
    }
    fetchData()
  }, [selectedSite, selectedPageUrl, dateRange])

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const rateColor = (rate: number, inverted = false) => {
    const val = inverted ? 100 - rate : rate
    if (val >= 70) return 'text-green-600 bg-green-50'
    if (val >= 40) return 'text-yellow-600 bg-yellow-50'
    if (val >= 20) return 'text-orange-600 bg-orange-50'
    return 'text-red-600 bg-red-50'
  }

  const getFormDisplayName = (form: FormData) => {
    if (form.form_id && !form.form_id.startsWith('form-')) return form.form_id
    if (form.form_action) return form.form_action.split('/').pop() || form.form_action
    return form.form_id || '不明なフォーム'
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
          <h1 className="text-2xl font-bold">フォーム分析</h1>
          <p className="text-sm text-gray-500 mt-1">フォームのフィールド別離脱率・入力時間・完了率を分析</p>
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
                      <select value={selectedPageUrl}
                        onChange={(e) => setSelectedPageUrl(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">全ページ</option>
                        {pages.map(p => <option key={p.url} value={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '')} ({p.count.toLocaleString()})</option>)}
                      </select>
                    ) : <div className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-400">データなし</div>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* サマリーカード */}
            {summary && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <FormInput className="w-4 h-4 text-blue-500" />
                      <span className="text-xs text-gray-500">フォーム数</span>
                    </div>
                    <p className="text-2xl font-bold">{summary.total_forms}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle className="w-4 h-4 text-green-500" />
                      <span className="text-xs text-gray-500">平均完了率</span>
                    </div>
                    <p className="text-2xl font-bold">{summary.avg_completion_rate}<span className="text-sm text-gray-400">%</span></p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-4 h-4 text-purple-500" />
                      <span className="text-xs text-gray-500">総送信数</span>
                    </div>
                    <p className="text-2xl font-bold">{summary.total_submitted.toLocaleString()}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <LogOut className="w-4 h-4 text-red-500" />
                      <span className="text-xs text-gray-500">総離脱数</span>
                    </div>
                    <p className="text-2xl font-bold">{summary.total_abandoned.toLocaleString()}</p>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* メインコンテンツ */}
            {dataLoading ? (
              <Card>
                <CardContent className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400 mr-2" />
                  <span className="text-gray-500 text-sm">データを取得中...</span>
                </CardContent>
              </Card>
            ) : forms.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <FormInput className="w-12 h-12 text-gray-300 mb-4" />
                  <p className="text-gray-500 mb-2">フォームデータがありません</p>
                  <p className="text-xs text-gray-400">トラッキングスクリプトの <code className="bg-gray-100 px-1 rounded">data-extensions=&quot;form&quot;</code> が有効か確認してください</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {forms.map((form) => (
                  <Card key={form.form_id}>
                    {/* フォームヘッダー（クリックで展開） */}
                    <button
                      onClick={() => setExpandedForm(expandedForm === form.form_id ? null : form.form_id)}
                      className="w-full text-left"
                    >
                      <CardContent className="pt-4 pb-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {expandedForm === form.form_id
                              ? <ChevronDown className="w-4 h-4 text-gray-400" />
                              : <ChevronRight className="w-4 h-4 text-gray-400" />}
                            <div>
                              <h3 className="font-semibold text-sm">{getFormDisplayName(form)}</h3>
                              <p className="text-xs text-gray-400 mt-0.5">{form.page_url.replace(/^https?:\/\/[^/]+/, '') || '/'} &middot; {form.field_count}フィールド</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-sm">
                            <div className="text-center">
                              <p className="text-xs text-gray-400">表示</p>
                              <p className="font-semibold">{form.views.toLocaleString()}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-gray-400">開始</p>
                              <p className="font-semibold">{form.started.toLocaleString()}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-gray-400">送信</p>
                              <p className="font-semibold text-green-600">{form.submitted.toLocaleString()}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-gray-400">離脱</p>
                              <p className="font-semibold text-red-600">{form.abandoned.toLocaleString()}</p>
                            </div>
                            <div className="text-center min-w-[60px]">
                              <p className="text-xs text-gray-400">完了率</p>
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${rateColor(form.completion_rate)}`}>
                                {form.completion_rate}%
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* ファネルバー */}
                        <div className="mt-3 flex items-center gap-1 h-2">
                          {form.views > 0 && (
                            <>
                              <div className="bg-blue-200 h-full rounded-l" style={{ width: '100%' }} title={`表示: ${form.views}`} />
                              <div className="bg-blue-400 h-full" style={{ width: `${form.started > 0 ? (form.started / form.views) * 100 : 0}%` }} title={`開始: ${form.started}`} />
                              <div className="bg-green-500 h-full rounded-r" style={{ width: `${form.submitted > 0 ? (form.submitted / form.views) * 100 : 0}%` }} title={`送信: ${form.submitted}`} />
                            </>
                          )}
                        </div>
                        <div className="flex justify-between mt-1 text-[10px] text-gray-400">
                          <span>表示 100%</span>
                          <span>開始 {form.views > 0 ? Math.round((form.started / form.views) * 100) : 0}%</span>
                          <span>送信 {form.views > 0 ? Math.round((form.submitted / form.views) * 100) : 0}%</span>
                        </div>
                      </CardContent>
                    </button>

                    {/* 展開時: フィールド詳細 */}
                    {expandedForm === form.form_id && form.fields.length > 0 && (
                      <div className="border-t border-gray-100 px-6 pb-4">
                        <h4 className="text-xs font-semibold text-gray-500 mt-4 mb-2">フィールド別分析</h4>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-gray-400 border-b border-gray-100">
                                <th className="text-left py-2 pr-4">フィールド名</th>
                                <th className="text-left py-2 pr-4">タイプ</th>
                                <th className="text-right py-2 pr-4">平均入力時間</th>
                                <th className="text-right py-2 pr-4">入力率</th>
                                <th className="text-right py-2 pr-4">操作数</th>
                              </tr>
                            </thead>
                            <tbody>
                              {form.fields.map((field, i) => {
                                const abandonPoint = form.abandon_points.find(a => a.field_name === field.field_name)
                                return (
                                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="py-2 pr-4">
                                      <div className="flex items-center gap-2">
                                        <span className="font-medium">{field.field_name}</span>
                                        {abandonPoint && (
                                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-50 text-red-600 text-[10px] font-medium">
                                            <LogOut className="w-3 h-3" />
                                            {abandonPoint.abandon_count}離脱
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                    <td className="py-2 pr-4 text-gray-400 text-xs">{field.field_type}</td>
                                    <td className="py-2 pr-4 text-right">
                                      <span className={field.avg_duration_ms > 10000 ? 'text-red-600 font-medium' : field.avg_duration_ms > 5000 ? 'text-orange-600' : ''}>
                                        {formatDuration(field.avg_duration_ms)}
                                      </span>
                                    </td>
                                    <td className="py-2 pr-4 text-right">
                                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${rateColor(field.filled_rate)}`}>
                                        {field.filled_rate}%
                                      </span>
                                    </td>
                                    <td className="py-2 pr-4 text-right text-gray-500">{field.interactions}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {expandedForm === form.form_id && form.fields.length === 0 && (
                      <div className="border-t border-gray-100 px-6 py-4">
                        <p className="text-xs text-gray-400 text-center">フィールドレベルのデータがありません</p>
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
