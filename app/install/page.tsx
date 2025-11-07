'use client'

import { Metadata } from 'next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { 
  Code, 
  Copy, 
  Check, 
  Download,
  Globe,
  Settings,
  Zap
} from 'lucide-react'
import { useState } from 'react'

// export const metadata: Metadata = {
//   title: 'インストール - ClickInsight Pro',
//   description: 'ClickInsight Proのトラッキングスクリプトをインストール',
// }

export default function InstallPage() {
  const [copied, setCopied] = useState<string | null>(null)

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error('Failed to copy text: ', err)
    }
  }

  const siteId = 'demo-site'
  const trackingUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://clickinsight.pro'}/tracking.js`

  const wordPressCode = `<?php
// ClickInsight Pro WordPress Plugin
function clickinsight_pro_tracking() {
    ?>
    <script>
        window.CLICKINSIGHT_SITE_ID = '${siteId}';
        window.CLICKINSIGHT_DEBUG = false;
    </script>
    <script src="${trackingUrl}" async></script>
    <?php
}

add_action('wp_head', 'clickinsight_pro_tracking');`

  const htmlCode = `<!DOCTYPE html>
<html>
<head>
    <title>Your Website</title>
    <!-- ClickInsight Pro Tracking -->
    <script>
        window.CLICKINSIGHT_SITE_ID = '${siteId}';
        window.CLICKINSIGHT_DEBUG = false;
    </script>
    <script src="${trackingUrl}" async></script>
</head>
<body>
    <!-- Your website content -->
</body>
</html>`

  const reactCode = `// ClickInsight Pro React Integration
import { ClickInsightProvider } from '@clickinsight/tracking';

function App() {
  return (
    <ClickInsightProvider siteId="${siteId}">
      {/* Your app components */}
    </ClickInsightProvider>
  );
}`

  const nextjsCode = `// ClickInsight Pro Next.js Integration
import { ClickInsightProvider } from '@clickinsight/tracking';

export default function App({ Component, pageProps }) {
  return (
    <ClickInsightProvider siteId="${siteId}">
      <Component {...pageProps} />
    </ClickInsightProvider>
  );
}`

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <header className="bg-white border-b">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600"></div>
              <span className="text-xl font-bold text-gray-900">ClickInsight Pro</span>
            </div>
            <div className="flex items-center space-x-4">
              <Badge variant="secondary">Free Plan</Badge>
              <Button variant="outline" size="sm">設定</Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* ページタイトル */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">インストール</h1>
          <p className="text-gray-600">ClickInsight Proのトラッキングスクリプトをインストール</p>
        </div>

        {/* サイト情報 */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>サイト情報</CardTitle>
            <CardDescription>インストール対象のサイト情報</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">サイトID</label>
                <p className="text-sm text-gray-900 font-mono bg-gray-100 px-2 py-1 rounded">{siteId}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">トラッキングURL</label>
                <p className="text-sm text-gray-900 font-mono bg-gray-100 px-2 py-1 rounded break-all">{trackingUrl}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* インストール方法 */}
        <Tabs defaultValue="wordpress" className="space-y-6">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="wordpress">WordPress</TabsTrigger>
            <TabsTrigger value="html">HTML</TabsTrigger>
            <TabsTrigger value="react">React</TabsTrigger>
            <TabsTrigger value="nextjs">Next.js</TabsTrigger>
          </TabsList>

          {/* WordPress */}
          <TabsContent value="wordpress">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Globe className="h-5 w-5" />
                  <span>WordPress インストール</span>
                </CardTitle>
                <CardDescription>
                  WordPressサイトにClickInsight Proをインストール
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <h3 className="font-medium text-blue-900 mb-2">方法1: テーマのfunctions.phpに追加</h3>
                    <p className="text-sm text-blue-700 mb-3">
                      テーマのfunctions.phpファイルに以下のコードを追加してください。
                    </p>
                    <div className="relative">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                        <code>{wordPressCode}</code>
                      </pre>
                      <Button
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => handleCopy(wordPressCode, 'wordpress')}
                      >
                        {copied === 'wordpress' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="p-4 bg-green-50 rounded-lg">
                    <h3 className="font-medium text-green-900 mb-2">方法2: プラグインとして作成</h3>
                    <p className="text-sm text-green-700 mb-3">
                      より安全な方法として、専用のプラグインを作成することをお勧めします。
                    </p>
                    <Button variant="outline" size="sm">
                      <Download className="mr-2 h-4 w-4" />
                      プラグインファイルをダウンロード
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* HTML */}
          <TabsContent value="html">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Code className="h-5 w-5" />
                  <span>HTML インストール</span>
                </CardTitle>
                <CardDescription>
                  静的HTMLサイトにClickInsight Proをインストール
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <h3 className="font-medium text-blue-900 mb-2">HTMLに直接追加</h3>
                    <p className="text-sm text-blue-700 mb-3">
                      各ページの&lt;head&gt;セクションに以下のコードを追加してください。
                    </p>
                    <div className="relative">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                        <code>{htmlCode}</code>
                      </pre>
                      <Button
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => handleCopy(htmlCode, 'html')}
                      >
                        {copied === 'html' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* React */}
          <TabsContent value="react">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Zap className="h-5 w-5" />
                  <span>React インストール</span>
                </CardTitle>
                <CardDescription>
                  ReactアプリケーションにClickInsight Proをインストール
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <h3 className="font-medium text-blue-900 mb-2">1. パッケージのインストール</h3>
                    <div className="relative">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                        <code>npm install @clickinsight/tracking</code>
                      </pre>
                      <Button
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => handleCopy('npm install @clickinsight/tracking', 'react-install')}
                      >
                        {copied === 'react-install' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="p-4 bg-green-50 rounded-lg">
                    <h3 className="font-medium text-green-900 mb-2">2. アプリケーションに追加</h3>
                    <div className="relative">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                        <code>{reactCode}</code>
                      </pre>
                      <Button
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => handleCopy(reactCode, 'react-code')}
                      >
                        {copied === 'react-code' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Next.js */}
          <TabsContent value="nextjs">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Settings className="h-5 w-5" />
                  <span>Next.js インストール</span>
                </CardTitle>
                <CardDescription>
                  Next.jsアプリケーションにClickInsight Proをインストール
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <h3 className="font-medium text-blue-900 mb-2">1. パッケージのインストール</h3>
                    <div className="relative">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                        <code>npm install @clickinsight/tracking</code>
                      </pre>
                      <Button
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => handleCopy('npm install @clickinsight/tracking', 'nextjs-install')}
                      >
                        {copied === 'nextjs-install' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="p-4 bg-green-50 rounded-lg">
                    <h3 className="font-medium text-green-900 mb-2">2. アプリケーションに追加</h3>
                    <div className="relative">
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                        <code>{nextjsCode}</code>
                      </pre>
                      <Button
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => handleCopy(nextjsCode, 'nextjs-code')}
                      >
                        {copied === 'nextjs-code' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* インストール後の確認 */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>インストール後の確認</CardTitle>
            <CardDescription>トラッキングスクリプトが正常に動作しているか確認</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <h3 className="font-medium text-blue-900 mb-2">1. ブラウザの開発者ツールで確認</h3>
                <p className="text-sm text-blue-700 mb-2">
                  ブラウザの開発者ツール（F12）を開き、Consoleタブで以下のメッセージが表示されることを確認してください。
                </p>
                <pre className="bg-gray-900 text-gray-100 p-3 rounded text-sm">
                  <code>ClickInsight Pro: Initializing tracking script</code>
                </pre>
              </div>

              <div className="p-4 bg-green-50 rounded-lg">
                <h3 className="font-medium text-green-900 mb-2">2. ネットワークタブで確認</h3>
                <p className="text-sm text-green-700 mb-2">
                  開発者ツールのNetworkタブで、以下のリクエストが送信されることを確認してください。
                </p>
                <pre className="bg-gray-900 text-gray-100 p-3 rounded text-sm">
                  <code>POST /api/events</code>
                </pre>
              </div>

              <div className="p-4 bg-yellow-50 rounded-lg">
                <h3 className="font-medium text-yellow-900 mb-2">3. ダッシュボードで確認</h3>
                <p className="text-sm text-yellow-700 mb-2">
                  数分後にダッシュボードでデータが表示されることを確認してください。
                </p>
                <Button>
                  ダッシュボードを開く
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
