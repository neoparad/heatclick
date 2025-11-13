import { NextRequest, NextResponse } from 'next/server'

/**
 * スクリーンショットAPIのプロキシエンドポイント
 * 外部のスクリーンショットAPIを呼び出して、ページの画像を取得
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const url = searchParams.get('url')
    
    if (!url) {
      return NextResponse.json(
        { error: 'Missing required parameter: url' },
        { status: 400 }
      )
    }

    // スクリーンショットAPIのキー（環境変数から取得）
    const apiKey = process.env.SCREENSHOT_API_KEY || process.env.NEXT_PUBLIC_SCREENSHOT_API_KEY
    
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Screenshot API key not configured' },
        { status: 500 }
      )
    }

    // スクリーンショットAPIのURL（例: ScreenshotOne API）
    const screenshotUrl = `https://api.screenshotone.com/take?access_key=${apiKey}&url=${encodeURIComponent(url)}&viewport_width=1920&viewport_height=1080&device_scale_factor=1&format=png&image_quality=80&block_ads=true&block_cookie_banners=true&block_banners_by_heuristics=true&block_trackers=true&delay=2000&timeout=10000`

    // スクリーンショットを取得
    const response = await fetch(screenshotUrl)
    
    if (!response.ok) {
      throw new Error(`Screenshot API failed: ${response.status} ${response.statusText}`)
    }

    // 画像データを取得
    const imageBuffer = await response.arrayBuffer()
    
    // 画像を返す
    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600', // 1時間キャッシュ
      },
    })
  } catch (error: any) {
    console.error('Error fetching screenshot:', error)
    return NextResponse.json(
      { error: 'Failed to generate screenshot' },
      { status: 500 }
    )
  }
}

