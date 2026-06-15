/**
 * URL allowlist — SSRF / open-redirect 防御の最終ライン
 *
 * 親 SSOT §1.6 原則 5 (Privacy by Default) + §3.8 (Privacy Architecture)
 * cross-cutting-concerns.md §1.3.4 v0.1 設計
 *
 * 使い方:
 *   import { isAllowedHost } from '@/lib/url-allowlist'
 *
 *   if (!isAllowedHost(externalUrl)) {
 *     return Response.json({ error: 'untrusted_host' }, { status: 400 })
 *   }
 *
 * いつ使うか:
 *   - サーバー側で `fetch(externalUrl)` する全箇所 (`/api/proxy/*` 等)
 *   - 顧客入力の `og:image` URL を再取得する箇所
 *   - email 通知に外部画像を埋める箇所 (`<img src="...">`)
 *   - `next/image` は `next.config.js` の `images.remotePatterns` で別途防御するが、
 *     `<img>` / `fetch` 等を使う場合は本関数で **二重防御**
 *
 * 設計判断:
 *   - 静的 allowlist (`STATIC_ALLOW`) と `config/partner-hosts.json` の 2 段
 *   - subdomain 一致 (`.endsWith('.' + root)`) を許可、host 完全一致も許可
 *   - HTTPS のみ、port 443 (default) のみ
 *   - 内部 IP / metadata endpoint / loopback / link-local を deny
 *   - DNS rebinding は本関数では完全には防げない (fetch 時に毎回再検証推奨)
 *   - hostname の case-insensitive 比較 (host は lowercase に正規化)
 */

import partnerHosts from '@/config/partner-hosts.json'

// LINKTH / 自社配下の永続 allowlist
const STATIC_ALLOW: ReadonlySet<string> = new Set([
  'vercel.app',
  'ugokimap.com',
  'linkth.co.jp',
])

// 内部 / 予約 / プライベート IP / metadata 拒否パターン (NFR-SEC-07)
const DENY_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?fc00::/i, // IPv6 ULA
  /^\[?fe80::/i, // IPv6 link-local
  /metadata\.google\.internal$/i,
  /metadata\.aws$/i,
  /\.local$/i,
  /\.lan$/i,
  /\.internal$/i,
  /\.localhost$/i,
]

/**
 * Whether the input URL string points to an allowed host.
 *
 * Returns `false` for any of:
 *   - non-string / malformed URL
 *   - non-https protocol
 *   - non-standard port (anything other than empty/443)
 *   - hostname matching DENY_HOST_PATTERNS (private IP / metadata / .local)
 *   - hostname not in STATIC_ALLOW or partner-hosts.json
 */
export function isAllowedHost(input: string): boolean {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    return false
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }

  // HTTPS only
  if (url.protocol !== 'https:') return false

  // Userinfo form reject (Codex A-2): `https://evil@good.com/` のような
  // log / UI poisoning ベクター。`url.hostname` は good.com に正規化されるため
  // 既存 SSRF deny では捕捉不能、ここで明示 reject する。
  if (url.username || url.password) return false

  // Standard port only (Next.js default config 整合)
  if (url.port && url.port !== '443') return false

  const host = url.hostname.toLowerCase()

  // Block internal / metadata / loopback / link-local addresses
  for (const denyPattern of DENY_HOST_PATTERNS) {
    if (denyPattern.test(host)) return false
  }

  // STATIC_ALLOW: host completely matches or is subdomain of an allowed root
  for (const root of STATIC_ALLOW) {
    if (host === root || host.endsWith('.' + root)) return true
  }

  // partner-hosts.json: same matching rule, but strip leading `*.` if present
  const partnerEntries = partnerHosts.hosts as readonly string[]
  for (const entry of partnerEntries) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    const stripped = entry.startsWith('*.') ? entry.slice(2) : entry
    if (host === stripped || host.endsWith('.' + stripped)) return true
  }

  return false
}

/**
 * Exported for testing / observability. Do NOT mutate at runtime — modify
 * `config/partner-hosts.json` instead and re-deploy.
 */
export const __TEST_ONLY__ = {
  STATIC_ALLOW,
  DENY_HOST_PATTERNS,
  PARTNER_HOSTS: partnerHosts.hosts as readonly string[],
}
