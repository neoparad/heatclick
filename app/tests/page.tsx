'use client'

import { useState, useEffect } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs'
import {
  Plus,
  ClipboardList,
  ArrowLeftRight,
  LayoutGrid,
  Loader2,
} from 'lucide-react'
import Loading from '../../components/ui/loading'

interface TestData {
  id: string
  site_id: string
  name: string
  type: string
  status: string
  page_url_a: string
  page_url_b: string
  description_a: string
  description_b: string
  traffic_split_a: number
  traffic_split_b: number
  goal_type: string
  confidence_level: number
  start_date: string | null
  end_date: string | null
  created_at: string
  updated_at: string
  sessions_a: number
  sessions_b: number
  clicks_a: number
  clicks_b: number
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'running':
      return <Badge className="bg-blue-100 text-blue-700">実行中</Badge>
    case 'completed':
      return <Badge className="bg-green-100 text-green-700">完了</Badge>
    case 'paused':
      return <Badge className="bg-yellow-100 text-yellow-700">一時停止</Badge>
    case 'draft':
    default:
      return <Badge className="bg-gray-100 text-gray-600">下書き</Badge>
  }
}

function getConfidenceBadge(confidence: number) {
  if (confidence >= 95) {
    return <span className="bg-green-100 text-green-800 px-2 py-1 text-xs rounded-full font-medium">{confidence}%</span>
  } else if (confidence >= 80) {
    return <span className="bg-yellow-100 text-yellow-800 px-2 py-1 text-xs rounded-full font-medium">{confidence}%</span>
  } else {
    return <span className="bg-red-100 text-red-800 px-2 py-1 text-xs rounded-full font-medium">{confidence}%</span>
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014'
  try {
    return new Date(dateStr).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
  } catch {
    return '\u2014'
  }
}

function formatPeriod(start: string | null, end: string | null, status: string): string {
  if (!start) return '\u2014'
  const startFormatted = formatDate(start)
  if (status === 'running') return `${startFormatted} - (進行中)`
  if (!end) return `${startFormatted} -`
  return `${startFormatted} - ${formatDate(end)}`
}

export default function TestsPage() {
  const [abTests, setAbTests] = useState<TestData[]>([])
  const [mvtTests, setMvtTests] = useState<TestData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('ab')

  useEffect(() => {
    fetchTests()
  }, [])

  const fetchTests = async () => {
    try {
      setLoading(true)
      const [abRes, mvtRes] = await Promise.all([
        fetch('/api/tests?type=ab'),
        fetch('/api/tests?type=mvt'),
      ])
      if (abRes.ok) {
        const abData = await abRes.json()
        setAbTests(abData.tests || [])
      }
      if (mvtRes.ok) {
        const mvtData = await mvtRes.json()
        setMvtTests(mvtData.tests || [])
      }
    } catch (err) {
      console.error('Error fetching tests:', err)
    } finally {
      setLoading(false)
    }
  }

  const tests = activeTab === 'ab' ? abTests : mvtTests

  const runningCount = tests.filter(t => t.status === 'running').length
  const completedCount = tests.filter(t => t.status === 'completed').length

  const renderSummaryCards = () => (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
      <Card>
        <CardContent className="p-4">
          <div className="text-sm text-gray-500">実行中</div>
          <div className="text-2xl font-bold text-blue-600">{runningCount}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="text-sm text-gray-500">完了</div>
          <div className="text-2xl font-bold text-green-600">{completedCount}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="text-sm text-gray-500">平均CVR改善</div>
          <div className="text-2xl font-bold text-gray-400">{'\u2014'}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="text-sm text-gray-500">月間追加CV</div>
          <div className="text-2xl font-bold text-gray-400">{'\u2014'}</div>
        </CardContent>
      </Card>
    </div>
  )

  const renderTestTable = (testList: TestData[]) => {
    if (testList.length === 0) {
      return (
        <Card>
          <CardContent className="p-12 text-center">
            <ClipboardList className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              テストがまだありません
            </h3>
            <p className="text-gray-600 mb-4">
              最初のテストを作成して最適化を始めましょう
            </p>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              新規テスト作成
            </Button>
          </CardContent>
        </Card>
      )
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">テスト名</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">ページ</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">ステータス</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">期間</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sessions</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">CVR A</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">CVR B</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">改善率</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">信頼度</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {testList.map((test) => {
              const cvrA = test.sessions_a > 0 ? (test.clicks_a / test.sessions_a) * 100 : 0
              const cvrB = test.sessions_b > 0 ? (test.clicks_b / test.sessions_b) * 100 : 0
              const improvement = cvrA > 0 ? ((cvrB - cvrA) / cvrA) * 100 : 0
              const totalSessions = test.sessions_a + test.sessions_b
              const isDraft = test.status === 'draft'

              return (
                <tr key={test.id} className="hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-4 text-sm font-medium text-blue-600">{test.name}</td>
                  <td className="px-4 py-4 text-sm text-gray-600">{test.page_url_a}</td>
                  <td className="px-4 py-4 text-center">{getStatusBadge(test.status)}</td>
                  <td className="px-4 py-4 text-center text-sm text-gray-500">
                    {formatPeriod(test.start_date, test.end_date, test.status)}
                  </td>
                  <td className="px-4 py-4 text-center text-sm">
                    {isDraft ? <span className="text-gray-400">{'\u2014'}</span> : totalSessions.toLocaleString()}
                  </td>
                  <td className="px-4 py-4 text-center text-sm">
                    {isDraft ? <span className="text-gray-400">{'\u2014'}</span> : `${cvrA.toFixed(1)}%`}
                  </td>
                  <td className="px-4 py-4 text-center text-sm">
                    {isDraft ? (
                      <span className="text-gray-400">{'\u2014'}</span>
                    ) : (
                      <span className={cvrB > cvrA ? 'font-bold text-green-600' : ''}>
                        {`${cvrB.toFixed(1)}%`}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center text-sm">
                    {isDraft ? (
                      <span className="text-gray-400">{'\u2014'}</span>
                    ) : (
                      <span className={improvement > 0 ? 'font-bold text-green-600' : improvement < 0 ? 'text-red-600' : ''}>
                        {improvement > 0 ? '+' : ''}{improvement.toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    {isDraft ? (
                      <span className="text-gray-400">{'\u2014'}</span>
                    ) : (
                      getConfidenceBadge(test.confidence_level)
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">テスト</h1>
            <p className="text-sm text-gray-500 mt-1">
              A/Bテスト・多変量テスト（MVT） — 行動データ付き最適化
            </p>
          </div>
          <Button className="bg-blue-600 hover:bg-blue-700 text-sm font-medium">
            <Plus className="w-4 h-4 mr-2" />
            新規テスト作成
          </Button>
        </div>

        {/* Loading */}
        {loading && <Loading text="テストを読み込み中..." />}

        {/* Tabs */}
        {!loading && (
          <Card>
            <Tabs defaultValue="ab" onValueChange={setActiveTab}>
              <div className="border-b border-gray-200">
                <TabsList className="bg-transparent h-auto p-0">
                  <TabsTrigger
                    value="ab"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-600 data-[state=active]:shadow-none px-6 py-3 text-sm font-medium"
                  >
                    <ArrowLeftRight className="w-4 h-4 mr-2" />
                    A/Bテスト
                  </TabsTrigger>
                  <TabsTrigger
                    value="mvt"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-600 data-[state=active]:shadow-none px-6 py-3 text-sm font-medium"
                  >
                    <LayoutGrid className="w-4 h-4 mr-2" />
                    多変量テスト（MVT）
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="ab" className="p-6 mt-0">
                {renderSummaryCards()}
                {renderTestTable(abTests)}
              </TabsContent>

              <TabsContent value="mvt" className="p-6 mt-0">
                {renderSummaryCards()}
                {renderTestTable(mvtTests)}
              </TabsContent>
            </Tabs>
          </Card>
        )}
      </div>
    </DashboardLayout>
  )
}
