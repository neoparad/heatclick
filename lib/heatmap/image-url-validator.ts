/**
 * Screenshot image URL validator
 *
 * セキュリティ: API が返した imageUrl が信頼できるソースか検証。
 * data/blob URL は同一オリジン安全。外部 URL は whitelist host のみ許可。
 */

const TRUSTED_HOSTS = [
  // R2 (Cloudflare) — ワイルドカードは * で表現しない、endsWith で prefix check
  'r2.ugoki.jp',
  'r2.ugoki.com',

  // Microlink CDN
  'cdn.microlink.io',
  'microlink.io',

  // Cloudflare CDN
  'cdn.example.com', // 環境に応じて実際の CDN host に置換

  // localhost / development
  'localhost',
  '127.0.0.1',
]

/**
 * imageUrl が信頼できるソースであるかチェック。
 * data: / blob: は同一オリジン安全。
 * https: は TRUSTED_HOSTS に含まれるか確認。
 */
export function isImageUrlTrusted(url: string): { trusted: boolean; reason?: string } {
  if (!url) {
    return { trusted: false, reason: 'URL is empty' }
  }

  try {
    // data URL / blob URL は同一オリジン → 安全
    if (url.startsWith('data:')) {
      return { trusted: true }
    }
    if (url.startsWith('blob:')) {
      return { trusted: true }
    }

    const u = new URL(url)

    // https のみ許可
    if (u.protocol !== 'https:') {
      return { trusted: false, reason: `protocol not https: ${u.protocol}` }
    }

    // ホスト名をチェック
    const trusted = TRUSTED_HOSTS.some((host) => {
      if (host === 'localhost' && u.hostname === 'localhost') return true
      if (host === '127.0.0.1' && u.hostname === '127.0.0.1') return true
      // 正式なホスト名は完全一致またはサブドメイン許可（*.r2.ugoki.jp など）
      if (host.startsWith('*.')) {
        const domain = host.slice(2)
        return u.hostname === domain || u.hostname.endsWith('.' + domain)
      }
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
