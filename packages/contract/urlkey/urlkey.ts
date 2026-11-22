/**
 * UGOKI LINK v2 — 束 1-C: URLキー単一権威関数 `urlkey/2`
 *
 * ブラウザ SDK・受付 (Cloudflare Worker)・CRAWL 取り込みの 3 か所で動かす
 * 外部依存ゼロの純粋 TypeScript URL 正規化関数。
 *
 * 設計根拠:
 * - マスター設計書 v2 §6.4
 * - join-final.md M4, Appendix A3
 * - consistency-definitions.md D-6
 */

import { sha256Hex, sha256Uint64 } from './sha256'
import { buildUrlKeyUnknowables, type UrlKeyUnknowables } from './unknowables'

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

export const URL_KEY_VERSION = 'urlkey/2' as const
export const MAX_URL_CHARS = 16 * 1024
export const MAX_QUERY_PARAMS = 1000

export type ParamClass = 'content' | 'noise' | 'user_input' | 'unclassified'

export type TrailingSlashMode = 'strip' | 'keep' | 'ensure'

/**
 * 入力語を含むパスの型定義 (設計書 §6.4)。
 * 例: `pattern: '/search/:term'` や `pattern: '/search/<term>/*'`
 * `:name` または `<name>` のセグメントを入力語として長さ区分トークンへ置換する。
 * `*` は任意の後続セグメントに一致する。
 */
export interface InputPathPatternRule {
  readonly id: string
  /** パス型テンプレート (例: `'/search/<term>'`, `'/s/:query/results'`, `'/search/<term>/*'`) */
  readonly pattern: string
}

export interface PageParamOverrideRule {
  /** 正規化済みパスに対する完全一致または前方一致 (`/*` 終端) */
  readonly pathPattern: string
  readonly paramClasses: Readonly<Record<string, Exclude<ParamClass, 'unclassified'>>>
}

export interface UrlKeyV2Rules {
  /** サイトプロファイル版 (例: `'site-1/rev-3'`) */
  readonly profileRev?: string
  /** 先頭 `www.` を除去するか (既定: `true`) */
  readonly stripWww?: boolean
  /** 末尾スラッシュの扱い (既定: `'strip'` = ルート `/` 以外の末尾 `/` を統一除去) */
  readonly trailingSlash?: TrailingSlashMode
  /** サイトプロファイルで証明済みのインデックスファイル名除去 (例: `['index.html']`、既定: 無効) */
  readonly indexFiles?: readonly string[]
  /** ハッシュルーティング SPA で `#fragment` を保持するか (既定: `false` = 除去) */
  readonly hashRouting?: boolean
  /**
   * サイト単位のパラメータ分類表 (検証済みのみ有効化)。
   * キーはパラメータ名 (大文字小文字は完全一致優先、無ければ小文字比較)。
   */
  readonly paramClasses?: Readonly<Record<string, Exclude<ParamClass, 'unclassified'>>>
  /** ページ例外のパラメータ分類表 (join-final.md M4: per (site, parameter) with page exceptions) */
  readonly pageParamOverrides?: readonly PageParamOverrideRule[]
  /** 入力語を含むパスの型 (設計書 §6.4: `/search/<term>/` 等) */
  readonly inputPathPatterns?: readonly InputPathPatternRule[]
  /** `content` 値に含まれる PII 形状文字列を自動マスクするか (既定: `true`) */
  readonly scrubPii?: boolean
  /** パス内マトリクスセッションパラメータ等の除去対象名 (サイトプロファイル指定時のみ) */
  readonly stripSessionPathParams?: readonly string[]
}

export interface CampaignAttribution {
  readonly utm: Readonly<Record<string, string>>
  /** 生のクリックID値は保持せず、パラメータ種別名のみを保持する (join-final.md A3) */
  readonly click_id_types: readonly string[]
}

export interface ParamClassificationEntry {
  readonly name: string
  readonly classification: ParamClass
}

export interface UrlKeyV2Result {
  /** 正規化・マスク済み URL キー (`host[:port]/path[?query]`、スキーム無し) */
  readonly url_key_v2: string
  /** D-6 互換エイリアス (`url_key_v2` と同一) */
  readonly url_key: string
  /** `url_key_v2` の SHA-256 先頭 64bit (UInt64 10進文字列) */
  readonly url_id: string
  /** `url_key_v2` の SHA-256 先頭 64bit (16 hex) */
  readonly url_id_hex: string
  /** クエリ無しのパスキー (`host[:port]/path`) */
  readonly path_key: string
  readonly host: string
  readonly hostname: string
  readonly port: string
  readonly pathname: string
  readonly query: string
  /** 未分類パラメータが 1 つ以上含まれていた場合に `true` (設計書 §6.4) */
  readonly coarse_key: boolean
  /** D-6 互換エイリアス (`coarse_key` と同一) */
  readonly key_degraded: boolean
  /** ソート済み・一意な未分類パラメータ名一覧 */
  readonly unclassified_param_names: readonly string[]
  /** 各クエリパラメータの分類結果 (生の値は含まない) */
  readonly param_classifications: readonly ParamClassificationEntry[]
  /** 入力語を含むパス型でマスクされた場合に `true` */
  readonly path_masked: boolean
  readonly matched_input_path_rule_id: string | null
  readonly unknowables: UrlKeyUnknowables
  readonly campaign_attribution: CampaignAttribution
  readonly key_ver: typeof URL_KEY_VERSION
  readonly profile_rev: string
}

export interface IdempotencyCheckResult {
  readonly idempotent: boolean
  readonly first: UrlKeyV2Result
  readonly second: UrlKeyV2Result
}

export class UrlKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UrlKeyError'
  }
}

/**
 * 版付き既知計測雑音パラメータ一覧 (join-final.md A3 + lib/url/normalize-url.ts)。
 * `utm_*` プレフィックス + 25 種の既知計測・クリックIDパラメータ。
 */
export const NOISE_PARAM_LIST_REV = 'noise/2' as const

export const DEFAULT_CLICK_ID_PARAMS: ReadonlySet<string> = new Set([
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
  'srsltid',
  'li_fat_id',
  'epik',
  'igshid',
])

export const DEFAULT_NOISE_EXACT_PARAMS: ReadonlySet<string> = new Set([
  ...DEFAULT_CLICK_ID_PARAMS,
  '_gl',
  '_ga',
  '_gac',
  'mc_cid',
  'mc_eid',
  'vero_id',
  'mkt_tok',
  'gad_source',
  'gad_campaignid',
  '_hsenc',
  '_hsmi',
])

/** よくあるサイト内検索パス型のプリセット (利用にはサイトプロファイルで明示登録する) */
export const COMMON_INPUT_PATH_PATTERNS: readonly InputPathPatternRule[] = Object.freeze([
  Object.freeze({ id: 'search_term', pattern: '/search/<term>' }),
  Object.freeze({ id: 'search_term_sub', pattern: '/search/<term>/*' }),
  Object.freeze({ id: 's_term', pattern: '/s/<term>' }),
])

/**
 * 長さ区分トークン。RFC 3986 非予約 ASCII 文字のみで構成し、
 * 再正規化しても変化しない（冪等）設計。
 * 数値か文字列か等の形状情報は一切含まない (設計書 §6.4)。
 */
export const LENGTH_BUCKET_TOKENS = Object.freeze({
  ZERO: '__ugk_len_0__',
  LEN_1_4: '__ugk_len_1_4__',
  LEN_5_16: '__ugk_len_5_16__',
  LEN_17_64: '__ugk_len_17_64__',
  LEN_65_256: '__ugk_len_65_256__',
  LEN_257_PLUS: '__ugk_len_257p__',
} as const)

export const PII_SCRUB_TOKEN = '__ugk_pii__' as const

const LENGTH_BUCKET_TOKEN_RE = /^__ugk_len_(?:0|1_4|5_16|17_64|65_256|257p)__$/

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER_FATAL = new TextDecoder('utf-8', { fatal: true })

// ---------------------------------------------------------------------------
// Low-Level Byte & Encoding Utilities
// ---------------------------------------------------------------------------

function isHexCharCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x46) || // A-F
    (code >= 0x61 && code <= 0x66) // a-f
  )
}

function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x7e // ~
  )
}

function isPathAllowedAsciiByte(b: number): boolean {
  if (isUnreservedByte(b)) return true
  // RFC 3986 pchar / sub-delims / '/' (excluding '%')
  switch (b) {
    case 0x2f: // /
    case 0x3a: // :
    case 0x40: // @
    case 0x21: // !
    case 0x24: // $
    case 0x26: // &
    case 0x27: // '
    case 0x28: // (
    case 0x29: // )
    case 0x2a: // *
    case 0x2b: // +
    case 0x2c: // ,
    case 0x3b: // ;
    case 0x3d: // =
      return true
    default:
      return false
  }
}

function encodeUtf8CodePointPercent(str: string, index: number): { hex: string; consumed: number } {
  const code = str.charCodeAt(index)
  let slice: string
  let consumed = 1
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < str.length) {
    const next = str.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      slice = str.slice(index, index + 2)
      consumed = 2
    } else {
      // Lone high surrogate -> TextEncoder emits UTF-8 U+FFFD (EF BF BD) safely
      slice = str[index]
    }
  } else {
    slice = str[index]
  }
  const bytes = UTF8_ENCODER.encode(slice)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += '%' + bytes[i].toString(16).toUpperCase().padStart(2, '0')
  }
  return { hex, consumed }
}

/**
 * パス向けのバイト単位パーセントエンコード正規化 (join-final.md A3)。
 * - 既存の有効な `%xx` は大文字 `%XX` 化。RFC 3986 非予約文字 (`A-Za-z0-9-._~`) のみデコード。
 * - 非 UTF-8 エスケープ (Shift_JIS `%82%A0` 等) は変換・破壊せず `%82%A0` のまま保持。
 * - 壊れたパーセント (`%ZZ`, `%2`, 末尾 `%`) は安全に `%25` へエスケープ (冪等)。
 * - WHATWG special scheme 準拠で `\` を `/` に正規化。
 * - 非 ASCII 文字・サロゲートペア・孤立サロゲートは UTF-8 `%XX` へ変換。
 */
function normalizePathPercentEncoding(rawPath: string): string {
  let out = ''
  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i)
    if (code === 0x25 /* % */) {
      if (
        i + 2 < rawPath.length &&
        isHexCharCode(rawPath.charCodeAt(i + 1)) &&
        isHexCharCode(rawPath.charCodeAt(i + 2))
      ) {
        const hex = rawPath.slice(i + 1, i + 3).toUpperCase()
        const byteVal = parseInt(hex, 16)
        if (isUnreservedByte(byteVal)) {
          out += String.fromCharCode(byteVal)
        } else {
          out += '%' + hex
        }
        i += 2
      } else {
        out += '%25'
      }
      continue
    }
    if (code === 0x5c /* \ */) {
      out += '/'
      continue
    }
    if (code < 0x80 && isPathAllowedAsciiByte(code)) {
      out += rawPath[i]
      continue
    }
    const { hex, consumed } = encodeUtf8CodePointPercent(rawPath, i)
    out += hex
    i += consumed - 1
  }
  return out
}

/**
 * クエリキー／値向けのバイト単位パーセントエンコード正規化。
 * - 非予約文字の `%XX` のみデコード、それ以外の有効な `%xx` は大文字 `%XX` で保持 (Shift_JIS 等を壊さない)。
 * - 壊れた `%` は `%25` へ安全変換。
 * - `&`, `=`, `#`, 空白, 非ASCII 等は UTF-8 `%XX` へエンコード。
 * - `+` は form-encoded space 互換のためそのまま保持せず `%20` へ統一しない？
 *   Wait: `+` と `%20` を区別しつつ壊さないため、query 内では `+` はそのまま保持し、
 *   リテラル空白は `%20` へエンコードする (A3: parse without decoding beyond unreserved characters)。
 */
function normalizeQueryComponent(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code === 0x25 /* % */) {
      if (
        i + 2 < raw.length &&
        isHexCharCode(raw.charCodeAt(i + 1)) &&
        isHexCharCode(raw.charCodeAt(i + 2))
      ) {
        const hex = raw.slice(i + 1, i + 3).toUpperCase()
        const byteVal = parseInt(hex, 16)
        if (isUnreservedByte(byteVal)) {
          out += String.fromCharCode(byteVal)
        } else {
          out += '%' + hex
        }
        i += 2
      } else {
        out += '%25'
      }
      continue
    }
    if (code < 0x80 && (isUnreservedByte(code) || code === 0x2b /* + */ || code === 0x3a /* : */ || code === 0x2f /* / */)) {
      out += raw[i]
      continue
    }
    const { hex, consumed } = encodeUtf8CodePointPercent(raw, i)
    out += hex
    i += consumed - 1
  }
  return out
}

/**
 * 値の長さを測るための安全な UTF-8 デコード (壊れた%やShift_JISでも絶対に投げない)。
 * 有効な UTF-8 シーケンスであれば Unicode コードポイント数を返し、
 * 非 UTF-8 バイト列であればバイト長を返す。
 */
function measureLogicalLength(raw: string, treatPlusAsSpace: boolean): number {
  if (!raw) return 0
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code === 0x25 /* % */) {
      if (
        i + 2 < raw.length &&
        isHexCharCode(raw.charCodeAt(i + 1)) &&
        isHexCharCode(raw.charCodeAt(i + 2))
      ) {
        bytes.push(parseInt(raw.slice(i + 1, i + 3), 16))
        i += 2
      } else {
        bytes.push(0x25)
      }
      continue
    }
    if (treatPlusAsSpace && code === 0x2b /* + */) {
      bytes.push(0x20)
      continue
    }
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    let slice = raw[i]
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length) {
      const next = raw.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        slice = raw.slice(i, i + 2)
        i++
      }
    }
    const encoded = UTF8_ENCODER.encode(slice)
    for (let j = 0; j < encoded.length; j++) bytes.push(encoded[j])
  }

  const u8 = new Uint8Array(bytes)
  try {
    const decoded = UTF8_DECODER_FATAL.decode(u8)
    let cpCount = 0
    for (const _cp of decoded) {
      void _cp
      cpCount++
    }
    return cpCount
  } catch {
    // 非 UTF-8 (Shift_JIS 等) はバイト長で区分決定
    return u8.length
  }
}

const UTF8_DECODER_LOSSY = new TextDecoder('utf-8', { fatal: false })

/**
 * Per-sequence `%XX` decoder that NEVER aborts on malformed `%` (e.g. `%ZZ`, `%2`, trailing `%`).
 * Valid contiguous `%XX` byte runs are decoded as UTF-8 (`%40` -> `@`), while malformed `%`
 * sequences remain literal (`%ZZ` -> `%ZZ`), preventing PII detector bypass via `%ZZ` suffixes.
 */
function safePercentDecodePartial(raw: string, treatPlusAsSpace: boolean): string {
  let out = ''
  let pendingBytes: number[] = []

  const flushPendingBytes = (): void => {
    if (pendingBytes.length === 0) return
    out += UTF8_DECODER_LOSSY.decode(new Uint8Array(pendingBytes))
    pendingBytes = []
  }

  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (
      code === 0x25 /* % */ &&
      i + 2 < raw.length &&
      isHexCharCode(raw.charCodeAt(i + 1)) &&
      isHexCharCode(raw.charCodeAt(i + 2))
    ) {
      pendingBytes.push(parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }

    flushPendingBytes()
    if (treatPlusAsSpace && code === 0x2b /* + */) {
      out += ' '
    } else {
      out += raw[i]
    }
  }

  flushPendingBytes()
  return out
}

function tryDecodeUtf8ForChecks(raw: string, treatPlusAsSpace: boolean): string {
  return safePercentDecodePartial(raw, treatPlusAsSpace)
}

/**
 * 文字列値を長さ区分トークンへ変換する (冪等: 既に長さ区分トークンならそのまま保持)。
 */
export function computeLengthBucket(rawValue: string, treatPlusAsSpace = true): string {
  if (LENGTH_BUCKET_TOKEN_RE.test(rawValue)) {
    return rawValue
  }
  const len = measureLogicalLength(rawValue, treatPlusAsSpace)
  if (len === 0) return LENGTH_BUCKET_TOKENS.ZERO
  if (len <= 4) return LENGTH_BUCKET_TOKENS.LEN_1_4
  if (len <= 16) return LENGTH_BUCKET_TOKENS.LEN_5_16
  if (len <= 64) return LENGTH_BUCKET_TOKENS.LEN_17_64
  if (len <= 256) return LENGTH_BUCKET_TOKENS.LEN_65_256
  return LENGTH_BUCKET_TOKENS.LEN_257_PLUS
}

/**
 * PII 形状文字列の検出 (メールアドレス、電話番号、クレジットカード番号様桁列、JWT)。
 */
export function isPiiShapedValue(rawValue: string): boolean {
  if (!rawValue || rawValue === PII_SCRUB_TOKEN || LENGTH_BUCKET_TOKEN_RE.test(rawValue)) {
    return false
  }
  const decoded = safePercentDecodePartial(rawValue, true).trim()
  if (!decoded) return false

  // Also strip residual broken-percent suffixes/tokens (e.g. %ZZ, %25ZZ) for secondary pattern match
  const cleanedBrokenPct = decoded.replace(/%(?:25)?[^0-9A-Fa-f]{1,2}|%[0-9A-Fa-f]?$/g, ' ').trim()

  for (const candidate of [decoded, cleanedBrokenPct]) {
    if (!candidate) continue
    // Email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(candidate)) return true
    if (/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(candidate)) return true
    // JWT (header.payload.signature)
    if (/(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(candidate)) {
      return true
    }
    // Phone numbers (JP/international formatted e.g. 090-1234-5678, +81-90-1234-5678, (03)1234-5678)
    if (/(?:^|[^\dA-Za-z])(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s])\d{2,4}[-.\s]\d{3,4}(?:$|[^\dA-Za-z])/.test(candidate)) {
      return true
    }
    // Credit card / 13-19 contiguous or hyphen/space-separated digits
    const digitsOnly = candidate.replace(/[-\s]/g, '')
    if (/^\d{13,19}$/.test(digitsOnly) && /^[\d-\s]+$/.test(candidate)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Path Resolution & Input Path Pattern Masking
// ---------------------------------------------------------------------------

function resolveDotSegmentsAndSlashes(
  encodedPath: string,
  trailingSlashMode: TrailingSlashMode,
  indexFiles: readonly string[],
  stripSessionPathParams: readonly string[],
): string {
  const hadTrailingSlash =
    encodedPath.endsWith('/') ||
    encodedPath.endsWith('/.') ||
    encodedPath.endsWith('/..') ||
    encodedPath === '.' ||
    encodedPath === '..'

  const rawSegments = encodedPath.split('/')
  const stack: string[] = []
  for (const seg of rawSegments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      stack.pop()
    } else {
      let cleanedSeg = seg
      if (stripSessionPathParams.length > 0 && cleanedSeg.includes(';')) {
        const [base, ...matrixParts] = cleanedSeg.split(';')
        const stripSet = new Set(stripSessionPathParams.map((p) => p.toLowerCase()))
        const kept = matrixParts.filter((mp) => {
          const eq = mp.indexOf('=')
          const name = (eq >= 0 ? mp.slice(0, eq) : mp).toLowerCase()
          return !stripSet.has(name)
        })
        cleanedSeg = kept.length > 0 ? `${base};${kept.join(';')}` : base
      }
      if (cleanedSeg) {
        stack.push(cleanedSeg)
      }
    }
  }

  // Optional index file removal (only when configured in site profile)
  if (indexFiles.length > 0 && stack.length > 0) {
    const lastLower = stack[stack.length - 1].toLowerCase()
    if (indexFiles.some((idx) => idx.toLowerCase() === lastLower)) {
      stack.pop()
    }
  }

  if (stack.length === 0) {
    return '/'
  }

  const joined = '/' + stack.join('/')
  if (trailingSlashMode === 'ensure') {
    return joined + '/'
  }
  if (trailingSlashMode === 'keep' && hadTrailingSlash) {
    return joined + '/'
  }
  return joined
}

function isPlaceholderPatSeg(pSeg: string): boolean {
  return (
    (pSeg.startsWith('<') && pSeg.endsWith('>') && pSeg.length > 2) ||
    (pSeg.startsWith(':') && pSeg.length > 1)
  )
}

function isMultiWildcardPatSeg(pSeg: string): boolean {
  return pSeg === '**' || pSeg === '...'
}

function applyInputPathPatterns(
  pathname: string,
  patterns: readonly InputPathPatternRule[],
): { readonly pathname: string; readonly masked: boolean; readonly ruleId: string | null } {
  if (patterns.length === 0 || pathname === '/') {
    return { pathname, masked: false, ruleId: null }
  }

  const hasTrailingSlash = pathname.length > 1 && pathname.endsWith('/')
  const trimmedPath = hasTrailingSlash ? pathname.slice(0, -1) : pathname
  const pathSegs = trimmedPath.split('/').filter((s) => s.length > 0)

  for (const rule of patterns) {
    const patSegs = rule.pattern
      .trim()
      .split('/')
      .filter((s) => s.length > 0)
    if (patSegs.length === 0) continue

    const hasExplicitPlaceholder = patSegs.some(isPlaceholderPatSeg)

    const matchFrom = (pIdx: number, sIdx: number): { out: string[]; replaced: boolean } | null => {
      if (pIdx === patSegs.length && sIdx === pathSegs.length) {
        return { out: [], replaced: false }
      }
      if (pIdx >= patSegs.length) {
        return null
      }

      const pSeg = patSegs[pIdx]
      const isLastPat = pIdx === patSegs.length - 1

      // Multi-segment wildcard (`**` or `...`) or trailing `/*` when explicit placeholder exists
      if (isMultiWildcardPatSeg(pSeg) || (pSeg === '*' && isLastPat)) {
        // Trailing `/*` or `/...` requires at least 1 segment (`sIdx < pathSegs.length`)
        if (isLastPat && sIdx >= pathSegs.length) {
          return null
        }
        if (isLastPat) {
          const rest = pathSegs
            .slice(sIdx)
            .map((seg) => (!hasExplicitPlaceholder ? computeLengthBucket(seg, false) : seg))
          return {
            out: rest,
            replaced: !hasExplicitPlaceholder && rest.length > 0,
          }
        }
        // Non-terminal `**` / `...`: match 1 or more (or 0 or more for `**`) segments greedily/backtracking
        const minCount = pSeg === '**' ? 0 : 1
        for (let take = minCount; sIdx + take <= pathSegs.length; take++) {
          const tail = matchFrom(pIdx + 1, sIdx + take)
          if (tail) {
            const consumed = pathSegs
              .slice(sIdx, sIdx + take)
              .map((seg) => (!hasExplicitPlaceholder ? computeLengthBucket(seg, false) : seg))
            return {
              out: [...consumed, ...tail.out],
              replaced: tail.replaced || (!hasExplicitPlaceholder && consumed.length > 0),
            }
          }
        }
        return null
      }

      if (sIdx >= pathSegs.length) {
        return null
      }

      // Single-segment placeholder (`<term>` or `:term`)
      if (isPlaceholderPatSeg(pSeg)) {
        const tail = matchFrom(pIdx + 1, sIdx + 1)
        if (!tail) return null
        return {
          out: [computeLengthBucket(pathSegs[sIdx], false), ...tail.out],
          replaced: true,
        }
      }

      // Mid-path single-segment wildcard `*` (e.g. `/search/*/query` or `/search/*/:query`)
      if (pSeg === '*') {
        const tail = matchFrom(pIdx + 1, sIdx + 1)
        if (!tail) return null
        const outSeg = !hasExplicitPlaceholder
          ? computeLengthBucket(pathSegs[sIdx], false)
          : pathSegs[sIdx]
        return {
          out: [outSeg, ...tail.out],
          replaced: tail.replaced || !hasExplicitPlaceholder,
        }
      }

      // Case-insensitive literal segment match (canonicalizes matched literal to lowercase rule segment)
      if (pSeg.toLowerCase() !== pathSegs[sIdx].toLowerCase()) {
        return null
      }
      const tail = matchFrom(pIdx + 1, sIdx + 1)
      if (!tail) return null
      return {
        out: [pSeg.toLowerCase(), ...tail.out],
        replaced: tail.replaced,
      }
    }

    const res = matchFrom(0, 0)
    if (res && res.replaced) {
      const rebuilt = '/' + res.out.join('/') + (hasTrailingSlash ? '/' : '')
      return { pathname: rebuilt, masked: true, ruleId: rule.id }
    }
  }

  return { pathname, masked: false, ruleId: null }
}

// ---------------------------------------------------------------------------
// Parameter Classification
// ---------------------------------------------------------------------------

export function isBuiltinNoiseParam(key: string): boolean {
  const lower = key.toLowerCase()
  if (lower.startsWith('utm_')) return true
  return DEFAULT_NOISE_EXACT_PARAMS.has(lower)
}

function matchPathPattern(pathname: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return pathname === prefix || pathname.startsWith(prefix + '/')
  }
  return pathname === pattern
}

function lookupClassInRecord(
  record: Readonly<Record<string, Exclude<ParamClass, 'unclassified'>>> | undefined,
  normalizedKey: string,
): Exclude<ParamClass, 'unclassified'> | undefined {
  if (!record) return undefined
  if (Object.prototype.hasOwnProperty.call(record, normalizedKey)) {
    return record[normalizedKey]
  }
  const lower = normalizedKey.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(record, lower)) {
    return record[lower]
  }
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower) return v
  }
  return undefined
}

export function classifyQueryParam(
  normalizedKey: string,
  pathname: string,
  rules?: UrlKeyV2Rules,
): ParamClass {
  // 1. Page-level exception overrides
  if (rules?.pageParamOverrides) {
    for (const override of rules.pageParamOverrides) {
      if (matchPathPattern(pathname, override.pathPattern)) {
        const hit = lookupClassInRecord(override.paramClasses, normalizedKey)
        if (hit) return hit
      }
    }
  }

  // 2. Site-level verified parameter classes
  const siteHit = lookupClassInRecord(rules?.paramClasses, normalizedKey)
  if (siteHit) return siteHit

  // 3. Built-in versioned tracking noise list
  if (isBuiltinNoiseParam(normalizedKey)) {
    return 'noise'
  }

  // 4. Unclassified (fail-safe: mask value to length bucket only + coarse_key=true)
  return 'unclassified'
}

// ---------------------------------------------------------------------------
// Main Authoritative Function: computeUrlKeyV2
// ---------------------------------------------------------------------------

const KNOWN_NON_HTTP_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'vbscript',
  'data',
  'mailto',
  'tel',
  'sms',
  'mms',
  'fax',
  'about',
  'blob',
  'file',
  'ftp',
  'ftps',
  'ws',
  'wss',
  'urn',
  'geo',
  'magnet',
  'intent',
  'market',
  'itms',
  'itms-apps',
  'chrome',
  'chrome-extension',
  'moz-extension',
  'view-source',
])

function assertNonEmptyAuthority(afterDoubleSlash: string, rawUrl: string): void {
  let delimIdx = -1
  for (let i = 0; i < afterDoubleSlash.length; i++) {
    const ch = afterDoubleSlash[i]
    if (ch === '/' || ch === '\\' || ch === '?' || ch === '#') {
      delimIdx = i
      break
    }
  }
  const authority = delimIdx === -1 ? afterDoubleSlash : afterDoubleSlash.slice(0, delimIdx)
  if (!authority) {
    throw new UrlKeyError(`Empty authority / host in URL: ${rawUrl}`)
  }
  const atIdx = authority.lastIndexOf('@')
  const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority
  if (!hostPort || hostPort.startsWith(':')) {
    throw new UrlKeyError(`Empty hostname in URL authority: ${rawUrl}`)
  }
}

function prepareInputWithScheme(input: string): string {
  // Reject explicit non-http(s) scheme with `://`
  const fullSchemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input)
  if (fullSchemeMatch) {
    const scheme = fullSchemeMatch[1].toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') {
      throw new UrlKeyError(`Unsupported URL scheme: ${scheme}`)
    }
    assertNonEmptyAuthority(input.slice(fullSchemeMatch[0].length), input)
    return input
  }

  // Reject `http:/foo` or `https:/foo` (missing second authority slash) or `///foo`
  if (/^https?:\/(?!\/)/i.test(input)) {
    throw new UrlKeyError(`Malformed HTTP(S) authority slashes in URL: ${input}`)
  }

  // Protocol-relative URL (`//example.com/path`)
  if (input.startsWith('//')) {
    assertNonEmptyAuthority(input.slice(2), input)
    return 'https:' + input
  }

  // Reject bare path starting with `/` without host
  if (input.startsWith('/') || input.startsWith('\\')) {
    throw new UrlKeyError(`Missing hostname in relative path URL: ${input}`)
  }

  // Detect schemeless `scheme:...` without `//` (javascript:, mailto:, data:, tel:, about:, blob:, file:)
  // while STILL allowing `host:port/path` including single-label hosts (`staging:8080/page`, `localhost:3000/a`, `[::1]:8080/a`)!
  if (!input.startsWith('[')) {
    const colonIdx = input.indexOf(':')
    const firstDelim = input.search(/[/?#\\]/)
    if (colonIdx === 0) {
      throw new UrlKeyError(`Missing hostname before port in URL: ${input}`)
    }
    if (colonIdx > 0 && (firstDelim === -1 || colonIdx < firstDelim)) {
      const beforeColon = input.slice(0, colonIdx)
      const beforeLower = beforeColon.toLowerCase()
      const afterColon = firstDelim === -1 ? input.slice(colonIdx + 1) : input.slice(colonIdx + 1, firstDelim)

      if (KNOWN_NON_HTTP_SCHEMES.has(beforeLower)) {
        throw new UrlKeyError(`Unsupported URL scheme: ${beforeLower}`)
      }

      const isNumericPort = /^\d{1,5}$/.test(afterColon) && Number(afterColon) >= 1 && Number(afterColon) <= 65535
      const isEmptyPortWithExplicitHost =
        afterColon === '' && (beforeColon.includes('.') || beforeLower === 'localhost')
      const looksLikeValidHost =
        beforeColon.includes('.') ||
        beforeLower === 'localhost' ||
        /^\d+$/.test(beforeColon) ||
        (isNumericPort && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(beforeColon))

      if (!(isNumericPort || isEmptyPortWithExplicitHost) || !looksLikeValidHost) {
        throw new UrlKeyError(`Unsupported URL scheme: ${beforeLower}`)
      }
    }
  }

  assertNonEmptyAuthority(input, input)
  return 'https://' + input
}

export function computeUrlKeyV2(rawUrl: string, rules?: UrlKeyV2Rules): UrlKeyV2Result {
  if (typeof rawUrl !== 'string') {
    throw new UrlKeyError('URL must be a string')
  }

  // Strip ASCII tabs and newlines per WHATWG URL preprocessing, then trim outer whitespace
  const trimmed = rawUrl.trim().replace(/[\t\r\n]/g, '')
  if (!trimmed) {
    throw new UrlKeyError('URL is empty')
  }
  if (trimmed.length > MAX_URL_CHARS) {
    throw new UrlKeyError(`URL exceeds maximum length (${MAX_URL_CHARS})`)
  }
  // Reject remaining C0 control characters (0x00..0x1F) and DEL (0x7F)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new UrlKeyError('URL contains illegal control character')
    }
  }

  const hashRouting = rules?.hashRouting ?? false
  const stripWww = rules?.stripWww ?? true
  const trailingSlash = rules?.trailingSlash ?? 'strip'
  const indexFiles = rules?.indexFiles ?? []
  const scrubPii = rules?.scrubPii ?? true
  const inputPathPatterns = rules?.inputPathPatterns ?? []
  const stripSessionPathParams = rules?.stripSessionPathParams ?? []
  const profileRev = rules?.profileRev ?? 'default/1'

  // Step 1: Separate fragment before parsing path/query
  const hashIdx = trimmed.indexOf('#')
  const withoutFragment = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed
  const rawFragment = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : ''

  // Step 2: Scheme validation & WHATWG URL parse
  const withScheme = prepareInputWithScheme(withoutFragment)

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new UrlKeyError(`Invalid URL: ${rawUrl}`)
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UrlKeyError(`Unsupported URL scheme: ${scheme}`)
  }

  // Step 3: Host normalization (lowercase, UTS-46 A-labels via WHATWG URL, trailing dot removed, www. removed, default ports removed)
  let hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  if (!hostname) {
    throw new UrlKeyError(`Missing hostname in URL: ${rawUrl}`)
  }
  if (stripWww && hostname.startsWith('www.') && hostname.slice(4).includes('.')) {
    hostname = hostname.slice(4)
  }

  // Drop default web ports (80 and 443) so http/https unification remains strictly idempotent
  let port = parsed.port
  if (port === '80' || port === '443') {
    port = ''
  }
  const host = port ? `${hostname}:${port}` : hostname

  // Step 4: Raw path & query extraction (preserves raw percent escapes & Shift_JIS bytes)
  const schemeSepIdx = withScheme.indexOf('://')
  const afterScheme = withScheme.slice(schemeSepIdx + 3)
  let delimIdx = -1
  for (let i = 0; i < afterScheme.length; i++) {
    const ch = afterScheme[i]
    if (ch === '/' || ch === '\\' || ch === '?') {
      delimIdx = i
      break
    }
  }

  let rawPath = '/'
  let rawQuery = ''
  if (delimIdx >= 0) {
    if (afterScheme[delimIdx] === '?') {
      rawPath = '/'
      rawQuery = afterScheme.slice(delimIdx + 1)
    } else {
      const qIdx = afterScheme.indexOf('?', delimIdx)
      if (qIdx >= 0) {
        rawPath = afterScheme.slice(delimIdx, qIdx)
        rawQuery = afterScheme.slice(qIdx + 1)
      } else {
        rawPath = afterScheme.slice(delimIdx)
      }
    }
  }

  const encodedPath = normalizePathPercentEncoding(rawPath)
  const resolvedPath = resolveDotSegmentsAndSlashes(
    encodedPath,
    trailingSlash,
    indexFiles,
    stripSessionPathParams,
  )

  const pathMaskRes = applyInputPathPatterns(resolvedPath, inputPathPatterns)
  const pathname = pathMaskRes.pathname

  // Step 5: Query parsing, campaign attribution extraction, 4-way classification & stable sort by key only
  const utmMap: Record<string, string> = {}
  const clickIdTypesSet = new Set<string>()
  const unclassifiedSet = new Set<string>()
  const classifications: ParamClassificationEntry[] = []
  const keptPairs: Array<{ readonly key: string; readonly value: string; readonly order: number }> = []

  if (rawQuery.length > 0) {
    const parts = rawQuery.split('&')
    let paramCount = 0
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx]
      if (!part) continue
      paramCount++
      if (paramCount > MAX_QUERY_PARAMS) {
        throw new UrlKeyError(`URL query exceeds parameter limit (${MAX_QUERY_PARAMS})`)
      }

      const eqIdx = part.indexOf('=')
      const rawKey = eqIdx >= 0 ? part.slice(0, eqIdx) : part
      const rawVal = eqIdx >= 0 ? part.slice(eqIdx + 1) : ''

      const normKey = normalizeQueryComponent(rawKey)
      if (!normKey) continue
      const lowerKey = normKey.toLowerCase()

      // Extract campaign attribution BEFORE dropping noise params
      if (lowerKey.startsWith('utm_')) {
        const utmSuffix = lowerKey.slice(4)
        if (utmSuffix && !(utmSuffix in utmMap)) {
          const decodedVal = tryDecodeUtf8ForChecks(rawVal, true)
          utmMap[utmSuffix] = scrubPii && isPiiShapedValue(rawVal) ? PII_SCRUB_TOKEN : decodedVal
        }
      } else if (DEFAULT_CLICK_ID_PARAMS.has(lowerKey)) {
        clickIdTypesSet.add(lowerKey)
      }

      const paramClass = classifyQueryParam(normKey, pathname, rules)
      classifications.push(Object.freeze({ name: normKey, classification: paramClass }))

      if (paramClass === 'noise') {
        continue
      }

      if (paramClass === 'content') {
        const normVal =
          scrubPii && isPiiShapedValue(rawVal)
            ? PII_SCRUB_TOKEN
            : normalizeQueryComponent(rawVal)
        keptPairs.push({ key: normKey, value: normVal, order: idx })
      } else if (paramClass === 'user_input') {
        const bucket = computeLengthBucket(rawVal, true)
        keptPairs.push({ key: normKey, value: bucket, order: idx })
      } else {
        // unclassified: name + length bucket only, coarse_key = true, NEVER emit raw value or shape!
        unclassifiedSet.add(normKey)
        const bucket = computeLengthBucket(rawVal, true)
        keptPairs.push({ key: normKey, value: bucket, order: idx })
      }
    }
  }

  // Stable sort by KEY ONLY (join-final.md A3: never reorder repeated keys by value!)
  keptPairs.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1
    return a.order - b.order
  })

  const query = keptPairs.map((p) => `${p.key}=${p.value}`).join('&')
  const pathKey = `${host}${pathname}`
  const fragmentSuffix =
    hashRouting && rawFragment.length > 0 ? `#${normalizePathPercentEncoding(rawFragment)}` : ''
  const urlKeyV2 = `${pathKey}${query ? `?${query}` : ''}${fragmentSuffix}`

  const { hex16, uint64 } = sha256Uint64(urlKeyV2)
  const unclassifiedNames = Object.freeze(Array.from(unclassifiedSet).sort())
  const coarseKey = unclassifiedNames.length > 0
  const unknowables = buildUrlKeyUnknowables(pathname, pathMaskRes.masked, unclassifiedNames)

  return Object.freeze({
    url_key_v2: urlKeyV2,
    url_key: urlKeyV2,
    url_id: uint64,
    url_id_hex: hex16,
    path_key: pathKey,
    host,
    hostname,
    port,
    pathname,
    query,
    coarse_key: coarseKey,
    key_degraded: coarseKey,
    unclassified_param_names: unclassifiedNames,
    param_classifications: Object.freeze(classifications),
    path_masked: pathMaskRes.masked,
    matched_input_path_rule_id: pathMaskRes.ruleId,
    unknowables,
    campaign_attribution: Object.freeze({
      utm: Object.freeze(utmMap),
      click_id_types: Object.freeze(Array.from(clickIdTypesSet).sort()),
    }),
    key_ver: URL_KEY_VERSION,
    profile_rev: profileRev,
  })
}

/**
 * 受付側での真の不動点・冪等性検証:
 * 入力 `rawUrl` 自体が既に正規化済み正準形 (`rawUrl === first.url_key_v2`) であり、
 * かつ 2 回目の適用でも完全一致 (`first.url_key_v2 === second.url_key_v2`) することを確認する (設計書 §6.4 / D-6 / [C-08])。
 */
export function verifyUrlKeyIdempotency(
  rawUrl: string,
  rules?: UrlKeyV2Rules,
): IdempotencyCheckResult {
  const first = computeUrlKeyV2(rawUrl, rules)
  const second = computeUrlKeyV2(first.url_key_v2, rules)

  const idempotent =
    rawUrl === first.url_key_v2 &&
    first.url_key_v2 === second.url_key_v2 &&
    first.url_id === second.url_id &&
    first.url_id_hex === second.url_id_hex &&
    first.path_key === second.path_key &&
    first.coarse_key === second.coarse_key &&
    first.path_masked === second.path_masked &&
    first.unclassified_param_names.length === second.unclassified_param_names.length &&
    first.unclassified_param_names.every((n, i) => n === second.unclassified_param_names[i])

  return Object.freeze({ idempotent, first, second })
}

/**
 * 適合試験ベクトル集合の決定論的 SHA-256 ハッシュを算出する (マニフェスト格納用: join-final.md M4 / D-6)。
 */
export function computeConformanceSuiteHash(
  vectors: ReadonlyArray<{ readonly id: string; readonly input: string; readonly expected_url_key_v2: string | null }>,
): string {
  const payload = JSON.stringify(
    vectors.map((v) => [v.id, v.input, v.expected_url_key_v2]),
  )
  return sha256Hex(`${URL_KEY_VERSION}:${NOISE_PARAM_LIST_REV}:${payload}`)
}
