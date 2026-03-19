import { NextRequest, NextResponse } from 'next/server'
import { redis as getRedisClient } from '@/lib/redis'
import { getAuthContext, unauthorized, badRequest } from '@/lib/api-utils'

const PAGESPEED_API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
const CACHE_TTL = 86400 // 24時間

// パフォーマンスに影響が大きい監査項目（my-gsc-analyzer-aiから移植）
const IMPORTANT_AUDITS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'speed-index',
  'interactive',
  'render-blocking-resources',
  'unused-css-rules',
  'unused-javascript',
  'uses-optimized-images',
  'uses-webp-images',
  'uses-text-compression',
  'uses-responsive-images',
  'offscreen-images',
  'unminified-css',
  'unminified-javascript',
  'efficient-animated-content',
  'duplicated-javascript',
  'legacy-javascript',
  'uses-long-cache-ttl',
  'dom-size',
  'critical-request-chains',
  'bootup-time',
  'mainthread-work-breakdown',
  'font-display',
  'third-party-summary',
  'interaction-to-next-paint',
  'experimental-interaction-to-next-paint',
]

// 監査項目の日本語マッピング
const AUDIT_TITLES_JA: Record<string, string> = {
  'first-contentful-paint': 'FCP（初回コンテンツ描画）',
  'largest-contentful-paint': 'LCP（最大コンテンツ描画）',
  'cumulative-layout-shift': 'CLS（累積レイアウトシフト）',
  'total-blocking-time': 'TBT（合計ブロック時間）',
  'speed-index': 'スピードインデックス',
  'interactive': 'TTI（操作可能までの時間）',
  'render-blocking-resources': 'レンダリングブロックリソース',
  'unused-css-rules': '未使用CSS',
  'unused-javascript': '未使用JavaScript',
  'uses-optimized-images': '画像最適化',
  'uses-webp-images': 'WebP画像の使用',
  'uses-text-compression': 'テキスト圧縮',
  'uses-responsive-images': 'レスポンシブ画像',
  'offscreen-images': '画面外画像の遅延読み込み',
  'unminified-css': 'CSS圧縮',
  'unminified-javascript': 'JavaScript圧縮',
  'efficient-animated-content': 'アニメーション最適化',
  'duplicated-javascript': '重複JavaScript削除',
  'legacy-javascript': 'レガシーJavaScript削減',
  'uses-long-cache-ttl': 'キャッシュポリシー',
  'dom-size': 'DOMサイズ',
  'critical-request-chains': 'クリティカルリクエストチェーン',
  'bootup-time': 'JavaScript起動時間',
  'mainthread-work-breakdown': 'メインスレッド作業時間',
  'font-display': 'フォント表示',
  'third-party-summary': 'サードパーティコード',
  'interaction-to-next-paint': 'INP（次の描画までのインタラクション）',
  'experimental-interaction-to-next-paint': 'INP（次の描画までのインタラクション）',
}

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const url = searchParams.get('url')
    const device = searchParams.get('device') || 'mobile'

    if (!url) {
      return badRequest('Missing required parameter: url')
    }

    const cacheKey = `pagespeed:${url}:${device}`

    // キャッシュから取得を試みる
    let cached = false
    let data: any = null

    try {
      const client = getRedisClient()
      const cachedData = await client.get(cacheKey)
      if (cachedData) {
        data = JSON.parse(cachedData)
        cached = true
      }
    } catch (cacheError) {
      console.error('Redis cache error:', cacheError)
    }

    if (!data) {
      // PageSpeed Insights API呼び出し
      const apiKey = process.env.PAGESPEED_API_KEY
      const strategy = device === 'desktop' ? 'DESKTOP' : 'MOBILE'
      const baseParams = `url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo`

      // APIキーありで試行、403ならキーなしでリトライ
      let response: Response
      let apiUrl = `${PAGESPEED_API_URL}?${baseParams}${apiKey ? `&key=${apiKey}` : ''}`

      response = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json' },
      })

      // APIキーが無効（403）の場合、キーなしで再試行
      if (!response.ok && response.status === 403 && apiKey) {
        console.warn('PageSpeed API key blocked, retrying without key...')
        apiUrl = `${PAGESPEED_API_URL}?${baseParams}`
        response = await fetch(apiUrl, {
          headers: { 'Accept': 'application/json' },
        })
      }

      if (!response.ok) {
        const errorText = await response.text()
        console.error('PageSpeed API error:', errorText)
        return NextResponse.json(
          { error: 'PageSpeed API request failed', details: errorText },
          { status: response.status }
        )
      }

      const result = await response.json()

      // スコアとメトリクスを抽出
      const categories = result.lighthouseResult?.categories || {}
      const audits = result.lighthouseResult?.audits || {}

      // 監査項目を抽出（失敗・要改善のみ）
      const auditItems: any[] = []
      for (const auditId of IMPORTANT_AUDITS) {
        const audit = audits[auditId]
        if (!audit) continue
        // score < 0.9 のもの（改善の余地があるもの）を抽出
        if (audit.score !== null && audit.score !== undefined && audit.score < 0.9) {
          auditItems.push({
            id: auditId,
            title: AUDIT_TITLES_JA[auditId] || audit.title || auditId,
            description: audit.description || '',
            score: audit.score,
            displayValue: audit.displayValue || undefined,
            numericValue: audit.numericValue || undefined,
          })
        }
      }

      // スコア昇順でソート（最も悪いものが先頭）
      auditItems.sort((a, b) => (a.score ?? 1) - (b.score ?? 1))

      data = {
        performance_score: Math.round((categories.performance?.score || 0) * 100),
        accessibility_score: Math.round((categories.accessibility?.score || 0) * 100),
        best_practices_score: Math.round((categories['best-practices']?.score || 0) * 100),
        seo_score: Math.round((categories.seo?.score || 0) * 100),
        lcp: (audits['largest-contentful-paint']?.numericValue || 0) / 1000,
        cls: audits['cumulative-layout-shift']?.numericValue || 0,
        inp: audits['interaction-to-next-paint']?.numericValue || audits['experimental-interaction-to-next-paint']?.numericValue || 0,
        fcp: (audits['first-contentful-paint']?.numericValue || 0) / 1000,
        tbt: audits['total-blocking-time']?.numericValue || 0,
        speed_index: (audits['speed-index']?.numericValue || 0) / 1000,
        tti: (audits['interactive']?.numericValue || 0) / 1000,
        measured_at: new Date().toISOString(),
        audit_items: auditItems,
      }

      // Redisにキャッシュ保存
      try {
        const client = getRedisClient()
        await client.setex(cacheKey, CACHE_TTL, JSON.stringify(data))
      } catch (cacheError) {
        console.error('Failed to cache PageSpeed data:', cacheError)
      }
    }

    return NextResponse.json({
      success: true,
      data,
      cached,
    })
  } catch (error) {
    console.error('Error in PageSpeed API route:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
