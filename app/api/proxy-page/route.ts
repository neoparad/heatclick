import { NextRequest, NextResponse } from 'next/server'

/**
 * ページプロキシAPI
 * 対象URLのHTMLを取得し、スクリプト除去・リンク無効化して返す
 * ヒートマップの背景として安全に表示するため
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const targetUrl = searchParams.get('url')

    if (!targetUrl) {
      return NextResponse.json(
        { error: 'Missing required parameter: url' },
        { status: 400 }
      )
    }

    // URLのバリデーション
    let parsedUrl: URL
    try {
      parsedUrl = new URL(targetUrl)
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL' },
        { status: 400 }
      )
    }

    // SSRF対策: プロトコル制限
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return NextResponse.json(
        { error: 'Only http/https protocols are allowed' },
        { status: 400 }
      )
    }

    // SSRF対策: プライベートIP・内部ネットワークのブロック
    const hostname = parsedUrl.hostname.toLowerCase()
    const blockedPatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^0\./,
      /^\[::1\]$/,
      /^\[fc/i,
      /^\[fd/i,
      /^\[fe80:/i,
      /^metadata\.google\.internal$/,
    ]
    if (blockedPatterns.some(p => p.test(hostname))) {
      return NextResponse.json(
        { error: 'Access to internal networks is not allowed' },
        { status: 403 }
      )
    }

    // ページのHTMLを取得
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      redirect: 'follow',
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch page: ${response.status}` },
        { status: 502 }
      )
    }

    let html = await response.text()
    const baseOrigin = parsedUrl.origin

    // 1. <base> タグを挿入（相対URLを正しく解決するため）
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${baseOrigin}/" />`
    )

    // 2. 全ての <script> タグを除去（インラインも外部も）
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    html = html.replace(/<script\b[^>]*\/>/gi, '')

    // 2b. <video> タグを除去（JS無効で巨大化するため。ヒートマップ分析に不要）
    html = html.replace(/<video\b[^<]*(?:(?!<\/video>)<[^<]*)*<\/video>/gi, '')
    html = html.replace(/<video\b[^>]*\/>/gi, '')

    // 3. イベントハンドラ属性を除去
    html = html.replace(/\s(on\w+)="[^"]*"/gi, '')
    html = html.replace(/\s(on\w+)='[^']*'/gi, '')

    // 4. 相対URLを絶対URLに変換（src, href, srcset）
    // src属性
    html = html.replace(
      /(src=["'])(?!https?:\/\/|data:|blob:|\/\/|#)(\/?)([^"']*)(["'])/gi,
      (_, prefix, slash, path, suffix) => {
        if (slash === '/') {
          return `${prefix}${baseOrigin}/${path}${suffix}`
        }
        return `${prefix}${baseOrigin}/${path}${suffix}`
      }
    )

    // href属性（CSSファイル等）
    html = html.replace(
      /(href=["'])(?!https?:\/\/|data:|blob:|\/\/|#|javascript:|mailto:)(\/?)([^"']*)(["'])/gi,
      (_, prefix, slash, path, suffix) => {
        if (slash === '/') {
          return `${prefix}${baseOrigin}/${path}${suffix}`
        }
        return `${prefix}${baseOrigin}/${path}${suffix}`
      }
    )

    // 5. ページを非インタラクティブにするスタイルとスクリプトを追加
    const injectedStyle = `
      <style>
        /* ページ全体を非インタラクティブに */
        body {
          pointer-events: none !important;
          user-select: none !important;
          overflow-x: hidden !important;
        }
        /* 画像のみ幅を制限 */
        img {
          max-width: 100% !important;
          height: auto !important;
        }
        /* 空になった動画/ヒーローセクションを潰す（videoタグ除去後の空コンテナ対策） */
        [class*="video"], [class*="Video"],
        [class*="hero-media"], [class*="hero_media"],
        [class*="hero-banner"], [class*="hero_banner"],
        [class*="full-screen"], [class*="fullscreen"],
        [data-section-type*="video"],
        [data-section-type*="hero"] {
          max-height: 60px !important;
          overflow: hidden !important;
        }
        /* vh単位の巨大セクションを制限（JS無効で空になるケース対策） */
        [style*="height: 100vh"],
        [style*="height:100vh"],
        [style*="min-height: 100vh"],
        [style*="min-height:100vh"] {
          height: auto !important;
          min-height: auto !important;
          max-height: 400px !important;
        }
        /* アニメーションを停止 */
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
        /* position:fixed要素をabsoluteに変更 */
        [style*="position: fixed"],
        [style*="position:fixed"] {
          position: absolute !important;
        }
        /* Cookie同意バナー・ドロワー・モーダル等を非表示（JS無効で巨大化するShopify要素） */
        [class*="cookie"], [class*="consent"], [class*="gdpr"],
        [id*="cookie"], [id*="consent"], [id*="gdpr"],
        [class*="popup"], [class*="modal"], [class*="overlay"],
        [class*="drawer"], [class*="Drawer"],
        [class*="slideout"], [class*="offcanvas"], [class*="off-canvas"],
        [class*="cart-sidebar"], [class*="mini-cart"],
        [class*="size-guide"], [class*="quick-view"],
        .no-js .disclaimer,
        noscript {
          display: none !important;
        }
      </style>
    `

    html = html.replace('</head>', `${injectedStyle}</head>`)

    // 6. </body>直前にCSS最終上書き（Shopify外部CSSより後に読み込まれるため確実に優先）
    const bodyEndStyle = `<style>[class*="drawer"],[class*="Drawer"],[class*="slideout"],[class*="offcanvas"],[class*="off-canvas"],[class*="size-guide"],[class*="quick-view"],[class*="mini-cart"],[class*="cart-sidebar"]{display:none!important;height:0!important;overflow:hidden!important;}</style>`
    html = html.replace('</body>', `${bodyEndStyle}</body>`)

    // HTMLを返す
    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    })
  } catch (error: any) {
    console.error('Error proxying page:', error)
    return NextResponse.json(
      { error: 'Failed to proxy page' },
      { status: 500 }
    )
  }
}
