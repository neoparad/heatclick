'use client'

import React, { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { 
  BarChart3, 
  MousePointerClick, 
  Zap, 
  TrendingUp, 
  Clock, 
  Users, 
  Activity, 
  Settings, 
  FileText, 
  Brain, 
  ChevronDown, 
  Calendar, 
  Download, 
  Filter, 
  Search, 
  Eye, 
  Map,
  Globe
} from 'lucide-react'

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [selectedSite, setSelectedSite] = useState('example.com')

  // サンプルデータ
  const kpiData = {
    totalClicks: 45234,
    clickRate: 12.4,
    avgTimeOnPage: 185,
    bounceRate: 42.3,
    trend: {
      clicks: '+12.5%',
      clickRate: '+2.1%',
      time: '-5.2%',
      bounce: '-3.8%'
    }
  }

  const topClickedElements = [
    { element: '「資料請求」ボタン', clicks: 8542, ctr: 18.9, change: '+15%' },
    { element: '「料金プラン」リンク', clicks: 6234, ctr: 13.8, change: '+8%' },
    { element: 'メニュー「導入事例」', clicks: 4521, ctr: 10.0, change: '-2%' },
    { element: 'フッター「お問い合わせ」', clicks: 3102, ctr: 6.9, change: '+22%' },
    { element: '「無料トライアル」ボタン', clicks: 2845, ctr: 6.3, change: '+5%' },
  ]

  const aiInsights = [
    {
      priority: '緊急',
      title: 'CTAボタンのクリック率が業界平均の40%',
      current: '2.3%',
      target: '5.8%',
      impact: 'CV率 +150%',
      time: '15分'
    },
    {
      priority: '重要',
      title: '内部リンク「導入事例」が87%見逃されている',
      current: '1.2%',
      target: '10%',
      impact: '回遊率 +220%',
      time: '30分'
    },
    {
      priority: 'SEO',
      title: 'クエリ「ヒートマップ ツール」の直帰率78%',
      current: '78%',
      target: '50%',
      impact: '検索順位 +1位',
      time: '60分'
    }
  ]

  const searchQueries = [
    { query: 'ヒートマップ ツール', clicks: 1250, ctr: 12.5, position: 3.2, bounceRate: 45 },
    { query: 'クリック分析', clicks: 890, ctr: 9.8, position: 4.1, bounceRate: 52 },
    { query: 'ユーザー行動 可視化', clicks: 654, ctr: 7.2, position: 5.8, bounceRate: 38 },
    { query: 'SEO ヒートマップ', clicks: 432, ctr: 6.1, position: 6.3, bounceRate: 61 },
  ]

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* KPIカード */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">総クリック数</span>
              <MousePointerClick className="w-5 h-5 text-blue-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.totalClicks.toLocaleString()}</div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp className="w-4 h-4 text-green-600" />
              <span className="text-green-600 font-medium">{kpiData.trend.clicks}</span>
              <span className="text-gray-500">vs 前期間</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">クリック率</span>
              <Activity className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.clickRate}%</div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp className="w-4 h-4 text-green-600" />
              <span className="text-green-600 font-medium">{kpiData.trend.clickRate}</span>
              <span className="text-gray-500">vs 前期間</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">平均滞在時間</span>
              <Clock className="w-5 h-5 text-purple-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.avgTimeOnPage}秒</div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp className="w-4 h-4 text-red-600 rotate-180" />
              <span className="text-red-600 font-medium">{kpiData.trend.time}</span>
              <span className="text-gray-500">vs 前期間</span>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-600">直帰率</span>
              <Users className="w-5 h-5 text-orange-600" />
            </div>
            <div className="text-3xl font-bold mb-2">{kpiData.bounceRate}%</div>
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp className="w-4 h-4 text-green-600 rotate-180" />
              <span className="text-green-600 font-medium">{kpiData.trend.bounce}</span>
              <span className="text-gray-500">vs 前期間</span>
            </div>
          </div>
        </div>

        {/* トップクリック要素 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold">トップクリック要素</h3>
            <button className="text-blue-600 hover:text-blue-700 text-sm font-medium">
              すべて表示 →
            </button>
          </div>
          <div className="space-y-3">
            {topClickedElements.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                    <span className="font-bold text-blue-600 text-sm">{idx + 1}</span>
                  </div>
                  <div className="flex-1">
                    <div className="font-medium mb-1">{item.element}</div>
                    <div className="text-sm text-gray-500">
                      {item.clicks.toLocaleString()} クリック • CTR {item.ctr}%
                    </div>
                  </div>
                </div>
                <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                  item.change.startsWith('+') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}>
                  {item.change}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 検索クエリ分析 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold">検索クエリ別パフォーマンス</h3>
            <div className="flex items-center gap-2">
              <button className="px-3 py-1 bg-blue-50 text-blue-600 rounded-lg text-sm font-medium">
                GSC連携中
              </button>
            </div>
          </div>
          <div className="space-y-3">
            {searchQueries.map((item, idx) => (
              <div key={idx} className="p-4 border border-gray-200 rounded-lg hover:border-blue-300 transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-medium text-lg">{item.query}</div>
                  <Eye className="w-5 h-5 text-gray-400" />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <div className="text-gray-500 text-sm">クリック数</div>
                    <div className="font-bold">{item.clicks.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-sm">CTR</div>
                    <div className="font-bold">{item.ctr}%</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-sm">平均掲載順位</div>
                    <div className="font-bold">{item.position}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-sm">直帰率</div>
                    <div className="font-bold">{item.bounceRate}%</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}