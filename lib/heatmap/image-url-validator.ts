/**
 * Screenshot image URL validator
 *
 * 診断目的: API が返した imageUrl がどのソースか分類する。
 * セキュリティ目的ではなく、あくまで診断ログ付与・origin 分類のための pure utility。
 * (ロードの可否判断は呼び出し元で行う)
 */

const TRUSTED_HOSTS = [
  // R2 (Cloudflare) — サブドメイン含む
  'r2.ugoki.jp',
  'r2.ugoki.com',

  // Microlink CDN
  'cdn.microlink.io',
  'microlink.io',

  // localhost / development (http も許可)
  'localhost',
  '127.0.0.1',
]

const SAFE_DATA_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']

/**
 * imageUrl の信頼度を分類して返す。pure function (副作用なし)。
 * - data: URL は許可された MIME type のみ trusted
 * - blob: URL は呼び出し元コンテキスト依存のため untrusted として記録のみ
 * - https: は TRUSTED_HOSTS 内か確認。サブドメインも許可。
 * - http: は localhost / 127.0.0.1 のみ開発環境許可
 */
export function isImageUrlTrusted(url: string): { trusted: boolean; reason?: string } {
  if (!url) {
    return { trusted: false, reason: 'URL is empty' }
  }

  try {
    // data URL — 安全な画像 MIME type のみ許可、SVG は script injection の懸念で除外
    if (url.startsWith('data:')) {
      const mime = url.slice(5, url.indexOf(';'))
      if (SAFE_DATA_IMAGE_TYPES.includes(mime)) return { trusted: true }
      return { trusted: false, reason: `data URL with unsupported MIME: ${mime}` }
    }

    // blob URL — 一時 preview などで使われる可能性。origin は trusted とみなしログのみ
    if (url.startsWith('blob:')) {
      return { trusted: true }
    }

    const u = new URL(url)

    // localhost / 127.0.0.1 は http/https 両方許可 (開発環境)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return { trusted: true }
    }

    // 外部 URL は https のみ
    if (u.protocol !== 'https:') {
      return { trusted: false, reason: `protocol not https: ${u.protocol}` }
    }

    const trusted = TRUSTED_HOSTS.some((host) => {
      return u.hostname === host || u.hostname.endsWith('.' + host)
    })

    if (!trusted) {
      return { trusted: false, reason: `hostname not in whitelist: ${u.hostname}` }
    }

    return { trusted: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return { trusted: false, reason: `URL parse failed: ${msg}` }
  }
}
