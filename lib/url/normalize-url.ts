/**
 * 融合SaaS 共通 URL 正規化 (TypeScript 正本)
 *
 * Python 側 (`linkscrawl/shared/url_canon.py`) と 1バイト単位で同一の出力・ハッシュを返す。
 *
 * 解決する課題 (STATE_2026-11-03.md §5 / PLAN.md P1):
 *   - ugokimap (events.url) / linkscrawl (pages.url, page_structure.page_url) /
 *     AIreceipt (observations.url) / GSC (Search Analytics page URL) で
 *     末尾 `/`・`www.`・`#fragment`・トラッキングパラメータ・クエリ順序・%エンコードの
 *     表記ゆれがあり、単純一致やバラバラな正規化で取りこぼしが発生していた。
 *
 * 正規化規則 (`normalizeUrl`):
 *   1. 前後空白除去。最大長 16,384 文字超過はエラー。
 *   2. スキーム補完: `http://` / `https://` が無ければ `https://` を補う (大文字小文字無視)。
 *   3. スキームとホストを小文字化。ホスト末尾のドット (`.`) を除去。
 *   4. ホスト先頭の `www.` を除去 (apex <-> www を同一視: `is_same_site` / `url_match_key` 準拠)。
 *   5. 既定ポート (`http` の `:80`、`https` の `:443`、空ポート `:`) を除去。非標準ポートは保持。
 *   6. `#fragment` を完全除去 (fragment 内の `/` や `?` に惑わされないよう最初に分離)。
 *   7. パス正規化:
 *      - 空パスは `/`
 *      - POSIX dot-segment (`.` / `..`) と連続スラッシュ (`//` -> `/`) を解決
 *      - RFC 3986 パーセントエンコード正規化 (非予約文字 `A-Za-z0-9-._~` の `%xx` はデコード、
 *        非ASCII文字は UTF-8 `%XX` 大文字16進へエンコード、既存の `%xx` は大文字 `%XX` 化)
 *      - ルート `/` 以外の末尾スラッシュを除去 (`/about/` -> `/about`, `/` -> `/`)
 *   8. クエリパラメータ正規化:
 *      - トラッキング用パラメータを除去 (小文字比較):
 *        `utm_*` (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` 等全て),
 *        `gclid`, `gclsrc`, `dclid`, `fbclid`, `msclkid`, `twclid`, `yclid`, `ttclid`, `wbraid`, `gbraid`,
 *        `_gl`, `_ga`, `_gac`, `mc_cid`, `mc_eid`, `vero_id`, `mkt_tok`, `igshid`
 *      - 残ったパラメータを (key, value) の辞書順 (UTF-8 コードポイント順) にソート
 *      - RFC 3986 準拠の `%XX` エンコード (`application/x-www-form-urlencoded` の `+` は `%20` に統一せず、
 *        既存の `parse_qsl` / `URLSearchParams` と互換の標準 form-urlencode で直列化)
 */

import { createHash } from 'node:crypto'

export const MAX_URL_CHARS = 16 * 1024
export const MAX_QUERY_FIELDS = 1000

const TRACKING_EXACT_PARAMS = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'yclid',
  'ttclid',
  'wbraid',
  'gbraid',
  '_gl',
  '_ga',
  '_gac',
  'mc_cid',
  'mc_eid',
  'vero_id',
  'mkt_tok',
  'igshid',
])

const UNRESERVED_RE = /^[A-Za-z0-9\-._~]$/
const PATH_SAFE_SET = new Set('/%:@!$&\'()*+,;=-._~'.split(''))

export interface NormalizedUrlResult {
  /** 正規化済みフルURL (例: `https://bihadashop.jp/column/skin?page=2`) */
  normalizedUrl: string
  /** スキームなし・小文字ホスト(www除去済)+パス+正規化クエリ (例: `bihadashop.jp/column/skin?page=2`) */
  matchKey: string
  /** `normalizedUrl` の SHA-256 先頭 16 hex (64-bit 突合キー) */
  urlHash: string
  /** 正規化済みホスト (小文字、`www.` 除去済、非標準ポートがあれば `host:port`) */
  host: string
  /** 正規化済みパス (先頭 `/`、ルート以外は末尾 `/` なし) */
  pathname: string
  /** 正規化済みクエリ文字列 (先頭 `?` なし、無ければ `""`) */
  query: string
}

export class UrlNormalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlNormalizationError'
  }
}

/**
 * トラッキングパラメータかどうか判定する (小文字化したキー名で比較)
 */
export function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase()
  if (lower.startsWith('utm_')) return true
  return TRACKING_EXACT_PARAMS.has(lower)
}

/**
 * RFC 3986 §6.2.2 に基づくパスのパーセントエンコード正規化。
 * Python `shared/url_canon.py` と同一のバイト列変換を行う。
 */
function normalizePathEncoding(rawPath: string): string {
  // 1. まず不完全な % 以外の非ASCIIや安全でない文字を UTF-8 %XX に変換し、既存の %xx は維持する
  let step1 = ''
  for (let i = 0; i < rawPath.length; i++) {
    const ch = rawPath[i]
    const code = rawPath.charCodeAt(i)
    if (ch === '%' && i + 2 < rawPath.length && /^[0-9A-Fa-f]{2}$/.test(rawPath.slice(i + 1, i + 3))) {
      step1 += '%' + rawPath.slice(i + 1, i + 3).toUpperCase()
      i += 2
      continue
    }
    if (code < 0x80 && (UNRESERVED_RE.test(ch) || PATH_SAFE_SET.has(ch)) && ch !== '%') {
      step1 += ch
    } else {
      // サロゲートペアを考慮してコードポイント単位で UTF-8 バイト化
      const cp = rawPath.codePointAt(i)!
      if (cp > 0xffff) i++
      const buf = Buffer.from(String.fromCodePoint(cp), 'utf8')
      for (let bi = 0; bi < buf.length; bi++) {
        step1 += '%' + buf[bi].toString(16).toUpperCase().padStart(2, '0')
      }
    }
  }

  // 2. 非予約文字 (A-Za-z0-9-._~) に該当する %XX (ASCII範囲 0x00-0x7F) を文字へデコードし、それ以外は %XX 大文字維持
  return step1.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const byteVal = parseInt(hex, 16)
    if (byteVal < 0x80) {
      const ch = String.fromCharCode(byteVal)
      if (UNRESERVED_RE.test(ch)) return ch
    }
    return '%' + hex.toUpperCase()
  })
}

/**
 * POSIX 形式のパス正規化 (`//` 圧縮、`.` / `..` 解決、末尾 `/` 除去)
 */
function resolvePosixPath(inputPath: string): string {
  if (!inputPath) return '/'
  const segments = inputPath.split('/')
  const stack: string[] = []
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      stack.pop()
    } else {
      stack.push(seg)
    }
  }
  return '/' + stack.join('/')
}

/**
 * Python `urllib.parse.urlencode` (doseq=True, safe='') と完全互換のクエリエンコード。
 * - 半角スペースは `+`
 * - `A-Za-z0-9-._~` はそのまま (ただし `~` も RFC 3986 非予約文字として無変換)
 * - その他は UTF-8 `%XX` (大文字)
 */
function formUrlEncodeComponent(str: string): string {
  const buf = Buffer.from(str, 'utf8')
  let out = ''
  for (let bi = 0; bi < buf.length; bi++) {
    const b = buf[bi]
    if (b === 0x20) {
      out += '+'
    } else if (
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || // -
      b === 0x2e || // .
      b === 0x5f || // _
      b === 0x7e // ~
    ) {
      out += String.fromCharCode(b)
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

/**
 * クエリ文字列をパースして `[key, value][]` に展開する (`+` はスペースとしてデコード)。
 * 空クエリパートはスキップし、`a=` のような空値は `[a, '']` として保持する (`keep_blank_values=True` 相当)。
 */
function parseQueryParams(rawQuery: string): Array<[string, string]> {
  if (!rawQuery) return []
  const parts = rawQuery.split('&')
  const pairs: Array<[string, string]> = []
  for (const part of parts) {
    if (!part) continue
    if (pairs.length >= MAX_QUERY_FIELDS) {
      throw new UrlNormalizationError('URL query exceeds normalization limit')
    }
    const eqIdx = part.indexOf('=')
    const rawKey = eqIdx >= 0 ? part.slice(0, eqIdx) : part
    const rawVal = eqIdx >= 0 ? part.slice(eqIdx + 1) : ''
    const decodeForm = (s: string): string => {
      const plusToSpace = s.replace(/\+/g, ' ')
      try {
        return decodeURIComponent(plusToSpace)
      } catch {
        return plusToSpace
      }
    }
    pairs.push([decodeForm(rawKey), decodeForm(rawVal)])
  }
  return pairs
}

export interface NormalizeUrlOptions {
  /** scheme を http/https そのまま残すか、https に統一するか (既定: false = 元スキーム維持) */
  forceHttps?: boolean
  /** トラッキングパラメータを除去するか (既定: true) */
  stripTrackingParams?: boolean
  /** 先頭の `www.` を除去するか (既定: true) */
  stripWww?: boolean
}

/**
 * URL を正規化し、正規化URL・突合キー・SHA-256 先頭16hexハッシュ等を返す。
 */
export function normalizeUrlFull(
  rawUrl: string,
  options?: NormalizeUrlOptions,
): NormalizedUrlResult {
  if (typeof rawUrl !== 'string') {
    throw new UrlNormalizationError('URL must be a string')
  }
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new UrlNormalizationError('URL is empty')
  }
  if (trimmed.length > MAX_URL_CHARS) {
    throw new UrlNormalizationError('URL exceeds normalization limit')
  }

  const forceHttps = options?.forceHttps ?? false
  const stripTracking = options?.stripTrackingParams ?? true
  const stripWww = options?.stripWww ?? true

  // 1. fragment を最優先で切り落とす
  const noFragment = trimmed.split('#', 1)[0].trim()

  // 2. スキーム補完
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(noFragment)
  const withScheme = hasScheme ? noFragment : `https://${noFragment}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new UrlNormalizationError(`Invalid URL: ${rawUrl}`)
  }

  const rawScheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (rawScheme !== 'http' && rawScheme !== 'https') {
    throw new UrlNormalizationError(`Unsupported URL scheme: ${rawScheme}`)
  }
  const scheme = forceHttps ? 'https' : rawScheme

  // 3. ホスト正規化 (小文字、末尾ドット除去、先頭 www. 除去)
  let hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  if (!hostname) {
    throw new UrlNormalizationError(`Missing hostname in URL: ${rawUrl}`)
  }
  if (stripWww && hostname.startsWith('www.') && hostname.length > 4) {
    hostname = hostname.slice(4)
  }

  // 4. ポート正規化 (URL オブジェクトは http:80 / https:443 を空文字にするが、forceHttps 時も考慮)
  let port = parsed.port
  if (
    (rawScheme === 'http' && port === '80') ||
    (rawScheme === 'https' && port === '443') ||
    (scheme === 'https' && port === '443') ||
    (scheme === 'http' && port === '80')
  ) {
    port = ''
  }
  const host = port ? `${hostname}:${port}` : hostname

  // 5. クエリ抽出 (生の search から `?` を除いて取得)
  const qMarkIdx = withScheme.indexOf('?')
  const rawQuery = qMarkIdx >= 0 ? withScheme.slice(qMarkIdx + 1) : ''

  // 6. パス正規化 (生パスを取り出して POSIX 解決 + RFC3986 正規化)
  const schemeSepIdx = withScheme.indexOf('://')
  const afterScheme = withScheme.slice(schemeSepIdx + 3)
  const pathStartIdx = afterScheme.indexOf('/')
  const queryStartInAfter = afterScheme.indexOf('?')
  let rawPath = '/'
  if (pathStartIdx >= 0 && (queryStartInAfter < 0 || pathStartIdx < queryStartInAfter)) {
    rawPath =
      queryStartInAfter >= 0
        ? afterScheme.slice(pathStartIdx, queryStartInAfter)
        : afterScheme.slice(pathStartIdx)
  }

  const normalizedEncodedPath = normalizePathEncoding(rawPath)
  const pathname = resolvePosixPath(normalizedEncodedPath)

  // 7. クエリパラメータのフィルタ＆ソート
  const pairs = parseQueryParams(rawQuery)
  const filteredPairs = stripTracking
    ? pairs.filter(([k]) => !isTrackingParam(k))
    : pairs

  filteredPairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
    return 0
  })

  const query = filteredPairs
    .map(([k, v]) => `${formUrlEncodeComponent(k)}=${formUrlEncodeComponent(v)}`)
    .join('&')

  const querySuffix = query ? `?${query}` : ''
  const normalizedUrl = `${scheme}://${host}${pathname}${querySuffix}`
  const matchKey = `${host}${pathname}${querySuffix}`
  const urlHash = createHash('sha256').update(normalizedUrl, 'utf8').digest('hex').slice(0, 16)

  return {
    normalizedUrl,
    matchKey,
    urlHash,
    host,
    pathname,
    query,
  }
}

/**
 * 正規化済み URL 文字列を返すショートカット。不正な URL の場合は null を返す (例外を投げない安全版)。
 */
export function normalizeUrl(rawUrl: string | null | undefined, options?: NormalizeUrlOptions): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  try {
    return normalizeUrlFull(rawUrl, options).normalizedUrl
  } catch {
    return null
  }
}

/**
 * スキーム差 (`http://` vs `https://`) も吸収した突合用キー (`host + pathname + sorted_query`) を返す。
 * 不正な URL の場合は null。
 */
export function urlMatchKey(rawUrl: string | null | undefined, options?: NormalizeUrlOptions): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  try {
    return normalizeUrlFull(rawUrl, options).matchKey
  } catch {
    return null
  }
}

/**
 * 正規化済み URL の SHA-256 先頭 16 hex を返す。不正な URL の場合は null。
 */
export function urlHash16(rawUrl: string | null | undefined, options?: NormalizeUrlOptions): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  try {
    return normalizeUrlFull(rawUrl, options).urlHash
  } catch {
    return null
  }
}

/**
 * ホスト名だけを正規化して返す (`www.` 除去、小文字、末尾ドット除去)。
 * サイト台帳でのドメイン突合 (`sc-domain:bihadashop.jp` や `https://www.bihadashop.jp/` → `bihadashop.jp`) に使用。
 */
export function normalizeHost(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  const withoutScDomain = trimmed.startsWith('sc-domain:')
    ? trimmed.slice('sc-domain:'.length).trim()
    : trimmed
  try {
    const res = normalizeUrlFull(withoutScDomain, { stripWww: true })
    return res.host.split(':')[0] || null
  } catch {
    return null
  }
}
