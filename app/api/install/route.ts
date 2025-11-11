import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('site_id')
    const platform = searchParams.get('platform') || 'wordpress'
    
    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required parameter: site_id' },
        { status: 400 }
      )
    }

    // プラットフォーム別のインストールコードを生成
    let installCode = ''

    switch (platform) {
      case 'wordpress':
        installCode = generateWordPressCode(siteId)
        break
      case 'html':
        installCode = generateHTMLCode(siteId)
        break
      case 'react':
        installCode = generateReactCode(siteId)
        break
      case 'nextjs':
        installCode = generateNextJSCode(siteId)
        break
      default:
        installCode = generateHTMLCode(siteId)
    }

    return NextResponse.json({
      success: true,
      site_id: siteId,
      platform: platform,
      install_code: installCode,
      tracking_url: `${process.env.NEXT_PUBLIC_APP_URL}/tracking.js`,
      api_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/events`
    })

  } catch (error) {
    console.error('Error generating install code:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

function generateWordPressCode(siteId: string): string {
  return `<?php
// ClickInsight Pro WordPress Plugin
// テーマのfunctions.phpに追加するか、プラグインとして作成

function clickinsight_pro_tracking() {
    ?>
    <script>
        window.CLICKINSIGHT_SITE_ID = '${siteId}';
        window.CLICKINSIGHT_DEBUG = false;
    </script>
    <script src="${process.env.NEXT_PUBLIC_APP_URL}/tracking.js" async></script>
    <?php
}

// フロントエンドにスクリプトを追加
add_action('wp_head', 'clickinsight_pro_tracking');

// 管理画面での設定
function clickinsight_pro_admin_menu() {
    add_options_page(
        'ClickInsight Pro',
        'ClickInsight Pro',
        'manage_options',
        'clickinsight-pro',
        'clickinsight_pro_admin_page'
    );
}
add_action('admin_menu', 'clickinsight_pro_admin_menu');

function clickinsight_pro_admin_page() {
    ?>
    <div class="wrap">
        <h1>ClickInsight Pro 設定</h1>
        <p>サイトID: <strong>${siteId}</strong></p>
        <p>トラッキングスクリプトが正常に読み込まれています。</p>
        <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard" target="_blank">ダッシュボードを開く</a></p>
    </div>
    <?php
}`
}

function generateHTMLCode(siteId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
    <title>Your Website</title>
    <!-- ClickInsight Pro Tracking -->
    <script>
        window.CLICKINSIGHT_SITE_ID = '${siteId}';
        window.CLICKINSIGHT_DEBUG = false;
    </script>
    <script src="${process.env.NEXT_PUBLIC_APP_URL}/tracking.js" async></script>
</head>
<body>
    <!-- Your website content -->
</body>
</html>`
}

function generateReactCode(siteId: string): string {
  return `// ClickInsight Pro React Integration
// 1. package.jsonに依存関係を追加
// npm install @clickinsight/tracking

// 2. App.jsまたはindex.jsに追加
import { ClickInsightProvider } from '@clickinsight/tracking';

function App() {
  return (
    <ClickInsightProvider siteId="${siteId}">
      {/* Your app components */}
    </ClickInsightProvider>
  );
}

// 3. コンポーネント内での使用
import { useClickInsight } from '@clickinsight/tracking';

function MyComponent() {
  const { track } = useClickInsight();
  
  const handleClick = () => {
    track('custom_event', { data: 'value' });
  };
  
  return <button onClick={handleClick}>Click me</button>;
}`
}

function generateNextJSCode(siteId: string): string {
  return `// ClickInsight Pro Next.js Integration
// 1. package.jsonに依存関係を追加
// npm install @clickinsight/tracking

// 2. pages/_app.jsまたはapp/layout.tsxに追加
import { ClickInsightProvider } from '@clickinsight/tracking';

export default function App({ Component, pageProps }) {
  return (
    <ClickInsightProvider siteId="${siteId}">
      <Component {...pageProps} />
    </ClickInsightProvider>
  );
}

// 3. コンポーネント内での使用
import { useClickInsight } from '@clickinsight/tracking';

export default function MyPage() {
  const { track } = useClickInsight();
  
  const handleClick = () => {
    track('custom_event', { data: 'value' });
  };
  
  return <button onClick={handleClick}>Click me</button>;
}`
}





