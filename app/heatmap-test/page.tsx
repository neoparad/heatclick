'use client'

import { useState } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import HeatmapCanvas from '../../components/heatmap/HeatmapCanvas'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Map, RefreshCw } from 'lucide-react'

export default function HeatmapTestPage() {
  // テスト用のサンプルデータ（実際のトラッキングデータを模擬）
  const [heatmapData] = useState([
    // 「資料請求」ボタン - 最も多いクリック
    { x: 120, y: 450, value: 8542 },
    { x: 125, y: 455, value: 7200 },
    { x: 118, y: 448, value: 6800 },

    // 「料金プラン」リンク
    { x: 200, y: 120, value: 6234 },
    { x: 205, y: 125, value: 5100 },

    // メニュー「導入事例」
    { x: 50, y: 60, value: 4521 },
    { x: 55, y: 65, value: 3800 },

    // フッター「お問い合わせ」
    { x: 300, y: 800, value: 3102 },
    { x: 305, y: 805, value: 2500 },

    // 「無料トライアル」ボタン
    { x: 150, y: 300, value: 2845 },
    { x: 155, y: 305, value: 2200 },

    // 「お問い合わせ」ボタン
    { x: 400, y: 200, value: 2100 },
    { x: 405, y: 205, value: 1800 },

    // 「資料ダウンロード」リンク
    { x: 80, y: 350, value: 1800 },
    { x: 85, y: 355, value: 1500 },

    // 「サービス詳細」ボタン
    { x: 250, y: 500, value: 1200 },
    { x: 255, y: 505, value: 1000 },

    // 低クリックエリア（青色になる）
    { x: 600, y: 100, value: 150 },
    { x: 650, y: 150, value: 100 },
    { x: 700, y: 200, value: 80 },
    { x: 600, y: 400, value: 50 },
    { x: 650, y: 450, value: 30 },
  ])

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* ヘッダー */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">ヒートマップ - 新グラデーション表示</h1>
            <p className="text-gray-600 mt-2">青（低）→ 緑 → 黄 → オレンジ → 赤（高）</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline">
              <RefreshCw className="w-4 h-4 mr-2" />
              更新
            </Button>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Map className="w-4 h-4 mr-2" />
              実データで表示
            </Button>
          </div>
        </div>

        {/* 説明カード */}
        <Card>
          <CardHeader>
            <CardTitle>新しいヒートマップ表示</CardTitle>
            <CardDescription>
              heatmap.jsを使用した本格的なヒートマップ可視化
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-gray-700">
                このページでは、heatmap.jsライブラリを使用した新しいヒートマップ表示をテストしています。
              </p>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-semibold text-blue-900 mb-2">カラースキーム</h3>
                <ul className="space-y-1 text-sm text-blue-800">
                  <li>🔵 <strong>青色</strong> - クリック数が最も少ない（未閲覧エリア）</li>
                  <li>🟢 <strong>緑色</strong> - クリック数が少ない</li>
                  <li>🟡 <strong>黄色</strong> - クリック数が中程度</li>
                  <li>🟠 <strong>オレンジ色</strong> - クリック数が多い</li>
                  <li>🔴 <strong>赤色</strong> - クリック数が最も多い（人気エリア）</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* メインヒートマップ */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Map className="w-5 h-5 mr-2" />
              クリックヒートマップ（サンプルデータ）
            </CardTitle>
            <CardDescription>
              ページ全体のクリック分布を色で表示 - デモデータ
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {/* ヒートマップ表示 */}
              <div className="flex justify-center">
                <HeatmapCanvas
                  data={heatmapData}
                  width={800}
                  height={600}
                  className="shadow-lg"
                />
              </div>

              {/* 凡例 */}
              <div className="flex items-center justify-center gap-4 py-4 bg-gray-50 rounded-lg">
                <span className="text-sm font-medium text-gray-700">クリック密度:</span>
                <div className="flex items-center gap-1">
                  <div className="w-12 h-6 bg-blue-500 rounded-l" title="最も少ない"></div>
                  <div className="w-12 h-6 bg-cyan-400" title="少ない"></div>
                  <div className="w-12 h-6 bg-lime-400" title="中程度"></div>
                  <div className="w-12 h-6 bg-yellow-400" title="多い"></div>
                  <div className="w-12 h-6 bg-orange-500" title="とても多い"></div>
                  <div className="w-12 h-6 bg-red-500 rounded-r" title="最も多い"></div>
                </div>
                <span className="text-sm text-gray-600">低 → 高</span>
              </div>

              {/* データ統計 */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-gray-900">
                    {heatmapData.reduce((sum, p) => sum + p.value, 0).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-600">総クリック数</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-gray-900">
                    {heatmapData.length}
                  </div>
                  <div className="text-sm text-gray-600">ヒートポイント数</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-2xl font-bold text-gray-900">
                    {Math.max(...heatmapData.map(p => p.value)).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-600">最大クリック数</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* トップクリックエリア */}
        <Card>
          <CardHeader>
            <CardTitle>トップクリックエリア</CardTitle>
            <CardDescription>最もクリックされている要素</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-red-50 rounded-lg border border-red-200">
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-red-500"></div>
                  <div>
                    <div className="font-medium">「資料請求」ボタン</div>
                    <div className="text-sm text-gray-500">位置: (120, 450)</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-red-600">8,542クリック</div>
                  <div className="text-sm text-gray-500">最高値</div>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-orange-50 rounded-lg border border-orange-200">
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-orange-500"></div>
                  <div>
                    <div className="font-medium">「料金プラン」リンク</div>
                    <div className="text-sm text-gray-500">位置: (200, 120)</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-orange-600">6,234クリック</div>
                  <div className="text-sm text-gray-500">2位</div>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-200">
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-blue-500"></div>
                  <div>
                    <div className="font-medium">右側エリア</div>
                    <div className="text-sm text-gray-500">位置: (600-700, 100-450)</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-blue-600">30-150クリック</div>
                  <div className="text-sm text-gray-500">ほとんど見られていない</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
