/**
 * UGOKI LINK v2 — 束 1-D: 共通区切りプログラム (Unified Segmenter Core)
 *
 * 外部依存ゼロの純粋 TypeScript / JavaScript 区切り・照合キー生成エンジン。
 * 訪問者ブラウザ DOM・CRAWL 描画 DOM・生 HTML 解析 (軽量パーサー経由) で
 * 100% 同一の区画 ID・ブロック ID・要素 ID・全入力種別照合キーを出力する。
 *
 * 設計根拠:
 * - マスター設計書 v2 §6.1
 * - join-final.md M1, M3, M5, Appendix A1
 * - consistency-definitions.md D-8, D-9, D-10, D-11
 */

import { hash32, hash40, hash48, hash64, hash128, sha256Hex } from './hash'
import {
  parseHtmlToDom,
  type SegDocumentLike,
  type SegElementLike,
  type SegNodeLike,
} from './html-parser'
import { NORM_RULE_REV, normText, verifyNormProbe } from './norm'

// ---------------------------------------------------------------------------
// Revisions, Registries & Self Content Hash
// ---------------------------------------------------------------------------

export const SEGMENTER_RULE_REVISIONS = Object.freeze({
  norm: NORM_RULE_REV,
  anchor: 'anchor/1',
  block: 'block/1',
  body: 'body/1',
  digest: 'digest/1',
  element: 'el/1',
  prune: 'prune/1',
  skel: 'skel/1',
  struct: 'struct/1',
  head: 'head/1',
  links: 'links/1',
  res: 'res/1',
  css: 'css/1',
  slot: 'slot/1',
} as const)

export type PruneCategory = 'always' | 'consent' | 'chat' | 'ad' | 'comment' | 'related'

export interface PruneRegistry {
  readonly rev: string
  readonly consentIds: readonly string[]
  readonly consentTokens: readonly string[]
  readonly chatIds: readonly string[]
  readonly chatTokens: readonly string[]
  readonly adTokens: readonly string[]
  readonly commentIds: readonly string[]
  readonly commentTokens: readonly string[]
  readonly relatedIds: readonly string[]
  readonly relatedTokens: readonly string[]
  readonly cmsRootTokens: readonly string[]
}

/**
 * 版付き除外一覧 (設計書 §6.1 / join-final.md M1.2 & A1)。
 * 同意バナー・チャット・広告・コメント・関連記事を構造分割前に除外する。
 * 注意: ここで定義されたトークンは除外判定のみに使用し、いかなる照合キーの入力にも含めない。
 */
export const DEFAULT_PRUNE_REGISTRY: PruneRegistry = Object.freeze({
  rev: SEGMENTER_RULE_REVISIONS.prune,
  consentIds: Object.freeze([
    'onetrust-consent-sdk',
    'onetrust-banner-sdk',
    'cybotcookiebotdialog',
    'cookie-notice',
    'cookie-law-info-bar',
    'cmplz-cookiebanner-container',
    'didomi-host',
    'usercentrics-root',
  ]),
  consentTokens: Object.freeze([
    'onetrust',
    'cookiebot',
    'cookie-banner',
    'consent-banner',
    'gdpr-banner',
    'cmp-banner',
  ]),
  chatIds: Object.freeze([
    'intercom-container',
    'hubspot-messages-iframe-container',
    'drift-widget',
    'crisp-chatbox',
    'zendesk-chat',
    'tidio-chat',
    'channel-plugin-root',
  ]),
  chatTokens: Object.freeze([
    'intercom-lightweight',
    'crisp-client',
    'zendesk-chat',
    'chat-widget',
    'livechat-widget',
  ]),
  adTokens: Object.freeze([
    'adsbygoogle',
    'ad-slot',
    'ad-container',
    'advertisement',
    'dfp-ad',
    'gpt-ad',
    'sponsor-banner',
  ]),
  commentIds: Object.freeze([
    'comments',
    'respond',
    'disqus_thread',
    'comment-section',
  ]),
  commentTokens: Object.freeze([
    'comments-area',
    'comment-list',
    'disqus-wrapper',
  ]),
  relatedIds: Object.freeze([
    'related-posts',
    'related-articles',
    'yarpp-related',
  ]),
  relatedTokens: Object.freeze([
    'related-posts',
    'related-articles',
    'yarpp-related',
    'recommended-posts',
  ]),
  cmsRootTokens: Object.freeze([]),
})

const DEFAULT_PRIVATE_PATH_PREFIXES: readonly string[] = Object.freeze([
  '/account',
  '/cart',
  '/checkout',
  '/member',
  '/login',
  '/signin',
  '/mypage',
  '/admin',
])

const CACHE_BUSTER_PARAMS: ReadonlySet<string> = new Set([
  'v',
  'ver',
  'version',
  '_',
  'cb',
  't',
  'ts',
  'timestamp',
  'bust',
  'cachebust',
  'hash',
  'rev',
  'build',
])

const TRACKING_LINK_PARAMS: ReadonlySet<string> = new Set([
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
  'srsltid',
  'gad_source',
  'gad_campaignid',
  '_hsenc',
  '_hsmi',
  'li_fat_id',
  'epik',
])

/**
 * 区切りプログラム自身の決定的コンテンツハッシュ (SHA-256 64 hex, 設計書 §6.1 / D-8)。
 * ルール版・除外一覧・アルゴリズム仕様の正規化表現から算出する。
 */
export function computeSegmenterContentHash(registry: PruneRegistry = DEFAULT_PRUNE_REGISTRY): string {
  const canonicalSpec = JSON.stringify({
    engine: 'ugokilink-segmenter-v2',
    rule_revisions: SEGMENTER_RULE_REVISIONS,
    prune_registry: registry,
    cache_buster_params: Array.from(CACHE_BUSTER_PARAMS).sort(),
    private_path_prefixes: DEFAULT_PRIVATE_PATH_PREFIXES,
  })
  return sha256Hex(canonicalSpec)
}

export const SEGMENTER_CONTENT_HASH: string = computeSegmenterContentHash(DEFAULT_PRUNE_REGISTRY)

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type DomState =
  | 'ok'
  | 'private_scope'
  | 'translated'
  | 'norm_mismatch'
  | 'cap_hit'
  | 'degraded'

export type RootRule =
  | 'explicit_attr'
  | 'article'
  | 'main'
  | 'role_main'
  | 'cms_registry'
  | 'body_fallback'
  | 'none'

export type AnchorTier = 'pin' | 'heading' | 'block_fallback' | 'depth_band'

export type BlockKind = 'text' | 'list' | 'table' | 'figure' | 'form' | 'embed'

export type ElementKind = 'link' | 'button' | 'image' | 'field' | 'table' | 'video' | 'iframe'

export type ElementRegion = 'root' | 'chrome'

export interface OriginalNodeValues {
  readonly text?: string
  readonly hidden?: boolean
  readonly attrs?: Readonly<Record<string, string | null>>
}

export interface SegmentOptions {
  /** ページの URL またはパス (匿名範囲チェック・相対リンク解決用) */
  readonly url?: string
  readonly pathname?: string
  /** `noindex` ページも強制的にセグメント化するか (既定: `false` = private_scope) */
  readonly allowNoindex?: boolean
  /** 匿名範囲として明示許可するパスパターン */
  readonly allowPrivatePaths?: boolean
  /** カスタム版付き除外一覧 */
  readonly pruneRegistry?: PruneRegistry
  /** オーナー登録済みの固定見出し ID 一覧 (pin tier 扱い) */
  readonly registeredHeadingIds?: readonly string[]
  /** 配信ランタイムがメモリ上に保持する元値マップ (`data-ugk-orig-*` と併用可) */
  readonly originalValueMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>
  /** 制約端末向け劣化モード: 見出し `sec_fp` のみ計算しブロック/本文ハッシュを省略 */
  readonly degraded?: boolean
}

export interface SegmentedBlock {
  readonly blk_fp: string
  readonly sec_fp: string
  readonly kind: BlockKind
  readonly dup: number
  readonly text_hash: string
}

export interface SegmentedSection {
  readonly ordinal: number
  readonly sec_fp: string
  readonly tier: AnchorTier
  readonly anchor_hash: string
  readonly ctx: string
  readonly dup: number
  readonly positional: boolean
  readonly body_fp: string
  readonly body_digest_128: string
  readonly depth_band?: readonly [number, number]
  readonly blocks: readonly SegmentedBlock[]
}

export interface SegmentedElement {
  readonly el_fp: string
  readonly kind: ElementKind
  readonly region: ElementRegion
  readonly sec_fp: string | null
  readonly slot_id: string
  readonly dest_key_static?: string
}

export interface LinksFingerprint {
  readonly root: string
  readonly chrome: string
  readonly combined: string
}

export interface SegmentedSlot {
  readonly slot_name: string
  readonly slot_fp: string
  readonly content_hash: string
}

export interface SegmenterOutput {
  readonly dom_state: DomState
  readonly root_rule: RootRule
  readonly segmenter_hash: string
  readonly rule_revisions: typeof SEGMENTER_RULE_REVISIONS
  readonly prune_registry_rev: string
  readonly skel_fp: string | null
  readonly struct_fp: string | null
  readonly head_fp: string | null
  readonly links_fp: LinksFingerprint | null
  readonly res_fp: string | null
  readonly css_fp: string | null
  readonly slot_fp: string | null
  readonly sections: readonly SegmentedSection[]
  readonly elements: readonly SegmentedElement[]
  readonly slots: readonly SegmentedSlot[]
}

// ---------------------------------------------------------------------------
// DOM Traversal & Original-Value Reading (Control Invariance)
// ---------------------------------------------------------------------------

const ALWAYS_PRUNE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV'])
const CHROME_TAGS = new Set(['HEADER', 'FOOTER', 'ASIDE', 'NAV'])
const CHROME_ROLES = new Set(['banner', 'contentinfo', 'complementary', 'navigation'])
const FORM_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP'])
const INLINE_BREAK_TAGS = new Set(['BR', 'WBR', 'HR'])
const BLOCK_DISPLAY_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

function isElement(node: SegNodeLike): node is SegElementLike {
  return node.nodeType === 1
}

function getTag(el: SegElementLike): string {
  return el.tagName.toUpperCase()
}

function getChildElements(node: SegNodeLike): SegElementLike[] {
  const out: SegElementLike[] = []
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i]
    if (isElement(c)) out.push(c)
  }
  return out
}

/**
 * LINK 配信書き換え時の「元の値の控え」 (`data-ugk-orig-*` または `originalValueMap`) を優先取得する。
 */
function readOriginalAttr(
  el: SegElementLike,
  attrName: string,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): string | null {
  const lower = attrName.toLowerCase()
  const mapped = origMap?.get(el)?.attrs
  if (mapped && Object.prototype.hasOwnProperty.call(mapped, lower)) {
    return mapped[lower] ?? null
  }
  const directOrig = el.getAttribute(`data-ugk-orig-${lower}`)
  if (directOrig !== null) return directOrig
  const prefixedOrig = el.getAttribute(`data-ugk-orig-attr-${lower}`)
  if (prefixedOrig !== null) return prefixedOrig
  return el.getAttribute(lower)
}

function isOriginallyHidden(
  el: SegElementLike,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): boolean {
  const mapped = origMap?.get(el)
  if (mapped && typeof mapped.hidden === 'boolean') {
    return mapped.hidden
  }
  const origHidden = el.getAttribute('data-ugk-orig-hidden')
  if (origHidden !== null) {
    const low = origHidden.trim().toLowerCase()
    return low === 'true' || low === '1' || low === '' || low === 'hidden'
  }
  return el.hasAttribute('hidden')
}

function isInsertedOverlayNode(el: SegElementLike): boolean {
  if (el.hasAttribute('data-ugk-slot')) return false
  if (el.hasAttribute('data-ugk') || el.hasAttribute('data-ugk-lab')) return true
  const inserted = el.getAttribute('data-ugk-inserted')
  return inserted !== null && inserted.trim().toLowerCase() !== 'false'
}

function isUgokiSlotNode(el: SegElementLike): boolean {
  return el.hasAttribute('data-ugk-slot')
}

function getTokenSet(raw: string | null): Set<string> {
  const set = new Set<string>()
  if (!raw) return set
  for (const part of raw.toLowerCase().split(/\s+/)) {
    if (part) set.add(part)
  }
  return set
}

function matchesAnyToken(tokens: ReadonlySet<string>, registryList: readonly string[]): boolean {
  for (let i = 0; i < registryList.length; i++) {
    if (tokens.has(registryList[i])) return true
  }
  return false
}

/**
 * 版付き除外一覧 (同意バナー・チャット・広告・コメント・関連記事・非公開領域・実験挿入要素) 判定。
 */
export function classifyPrunedNode(
  el: SegElementLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): PruneCategory | null {
  const tag = getTag(el)

  // Always pruned structural/private/delivery nodes
  if (ALWAYS_PRUNE_TAGS.has(tag)) return 'always'
  if (isInsertedOverlayNode(el)) return 'always'
  if (el.hasAttribute('data-ugk-private')) return 'always'
  if (isOriginallyHidden(el, origMap)) return 'always'

  const role = (el.getAttribute('role') ?? '').trim().toLowerCase()
  if (role === 'dialog' || role === 'alertdialog') return 'always'

  const contentEditable = el.getAttribute('contenteditable')
  if (contentEditable !== null) {
    const ce = contentEditable.trim().toLowerCase()
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return 'always'
  }

  // Explicit data-ugk-prune category attribute
  const explicitPrune = (el.getAttribute('data-ugk-prune') ?? '').trim().toLowerCase()
  if (
    explicitPrune === 'consent' ||
    explicitPrune === 'chat' ||
    explicitPrune === 'ad' ||
    explicitPrune === 'comment' ||
    explicitPrune === 'related' ||
    explicitPrune === 'always'
  ) {
    return explicitPrune
  }

  const idLower = (el.getAttribute('id') ?? '').trim().toLowerCase()
  const ariaLabel = (el.getAttribute('aria-label') ?? '').trim().toLowerCase()
  const classTokens = getTokenSet(el.getAttribute('class'))

  // 1. Consent banners
  if (
    el.hasAttribute('data-cookieconsent') ||
    tag === 'COOKIE-BANNER' ||
    tag === 'CMP-BANNER' ||
    (idLower && registry.consentIds.includes(idLower)) ||
    matchesAnyToken(classTokens, registry.consentTokens) ||
    (ariaLabel && (ariaLabel.includes('cookie') || ariaLabel.includes('consent') || ariaLabel.includes('クッキー')))
  ) {
    return 'consent'
  }

  // 2. Chat widgets
  if (
    el.hasAttribute('data-chat-widget') ||
    (idLower && registry.chatIds.includes(idLower)) ||
    matchesAnyToken(classTokens, registry.chatTokens)
  ) {
    return 'chat'
  }

  // 3. Ads
  if (
    el.hasAttribute('data-ad-slot') ||
    el.hasAttribute('data-ad-client') ||
    el.hasAttribute('data-google-query-id') ||
    matchesAnyToken(classTokens, registry.adTokens) ||
    ariaLabel === 'advertisement' ||
    ariaLabel === '広告' ||
    ariaLabel === 'sponsored'
  ) {
    return 'ad'
  }

  // 4. Comments
  if (
    el.hasAttribute('data-comments') ||
    (idLower && registry.commentIds.includes(idLower)) ||
    matchesAnyToken(classTokens, registry.commentTokens)
  ) {
    return 'comment'
  }

  // 5. Related posts
  if (
    el.hasAttribute('data-related-posts') ||
    (idLower && registry.relatedIds.includes(idLower)) ||
    matchesAnyToken(classTokens, registry.relatedTokens) ||
    (tag === 'ASIDE' && (ariaLabel.includes('related') || ariaLabel.includes('関連')))
  ) {
    return 'related'
  }

  return null
}

function isChromeContainer(el: SegElementLike): boolean {
  if (el.hasAttribute('data-ugk-chrome')) return true
  const tag = getTag(el)
  if (CHROME_TAGS.has(tag)) return true
  const role = (el.getAttribute('role') ?? '').trim().toLowerCase()
  return CHROME_ROLES.has(role)
}

/**
 * 要素配下の正規化テキストを抽出する (NEVER uses `innerText`!).
 * - `data-ugk-orig-text` または `originalValueMap` があれば元の文字列を採用 (実験中ID不変性)
 * - 除外要素・フォーム入力要素・`[data-ugk-slot]` は読み飛ばす
 * - `<br>` やブロック境界には空白を補い、単語結合を防ぐ
 */
function extractNormalizedText(
  node: SegNodeLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
  includeSlot = false,
): string {
  const parts: string[] = []

  const walk = (cur: SegNodeLike): void => {
    if (cur.nodeType === 3) {
      if (cur.nodeValue) parts.push(cur.nodeValue)
      return
    }
    if (!isElement(cur)) {
      for (let i = 0; i < cur.childNodes.length; i++) walk(cur.childNodes[i])
      return
    }

    const tag = getTag(cur)
    if (!includeSlot && isUgokiSlotNode(cur)) return
    if (FORM_CONTROL_TAGS.has(tag)) return
    if (classifyPrunedNode(cur, registry, origMap) !== null) return

    // Control invariance: original text override
    const mappedText = origMap?.get(cur)?.text
    if (typeof mappedText === 'string') {
      parts.push(' ', mappedText, ' ')
      return
    }
    const origTextAttr = cur.getAttribute('data-ugk-orig-text')
    if (origTextAttr !== null) {
      parts.push(' ', origTextAttr, ' ')
      return
    }

    if (INLINE_BREAK_TAGS.has(tag)) {
      parts.push(' ')
      return
    }

    const isBlock = BLOCK_DISPLAY_TAGS.has(tag)
    if (isBlock) parts.push(' ')
    for (let i = 0; i < cur.childNodes.length; i++) {
      walk(cur.childNodes[i])
    }
    if (isBlock) parts.push(' ')
  }

  walk(node)
  return normText(parts.join(''))
}

// ---------------------------------------------------------------------------
// Anonymous Scope Check
// ---------------------------------------------------------------------------

function extractMetaRobots(doc: SegDocumentLike): string {
  const values: string[] = []
  const walk = (node: SegNodeLike): void => {
    if (isElement(node) && getTag(node) === 'META') {
      const name = (node.getAttribute('name') ?? '').trim().toLowerCase()
      if (name === 'robots' || name === 'googlebot') {
        const content = node.getAttribute('content')
        if (content) values.push(content.toLowerCase())
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      walk(node.childNodes[i])
    }
  }
  walk(doc)
  return values.join(',')
}

function extractPathnameFromOptions(options?: SegmentOptions): string | null {
  if (options?.pathname) return options.pathname.toLowerCase()
  if (options?.url) {
    try {
      const parsed = new URL(
        /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(options.url) ? options.url : `https://${options.url}`,
      )
      return parsed.pathname.toLowerCase()
    } catch {
      return null
    }
  }
  return null
}

function isOutsideAnonymousScope(doc: SegDocumentLike, options?: SegmentOptions): boolean {
  if (!options?.allowNoindex) {
    const robots = extractMetaRobots(doc)
    if (/(?:^|[\s,])noindex(?:[\s,]|$)/.test(robots)) {
      return true
    }
  }
  if (!options?.allowPrivatePaths) {
    const pathname = extractPathnameFromOptions(options)
    if (pathname) {
      for (const prefix of DEFAULT_PRIVATE_PATH_PREFIXES) {
        if (pathname === prefix || pathname.startsWith(prefix + '/')) {
          return true
        }
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Root Selection (join-final.md M1.2)
// ---------------------------------------------------------------------------

function findBody(doc: SegDocumentLike): SegElementLike | null {
  if (doc.body) return doc.body
  const walk = (node: SegNodeLike): SegElementLike | null => {
    if (isElement(node) && getTag(node) === 'BODY') return node
    for (let i = 0; i < node.childNodes.length; i++) {
      const found = walk(node.childNodes[i])
      if (found) return found
    }
    return null
  }
  const body = walk(doc)
  if (body) return body
  if (doc.documentElement) return doc.documentElement
  const children = getChildElements(doc)
  return children.length > 0 ? children[0] : null
}

function selectContentRoot(
  body: SegElementLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): { readonly root: SegElementLike; readonly rootRule: RootRule } {
  // 1. Explicit `[data-ugk-root]`
  const findExplicit = (node: SegElementLike): SegElementLike | null => {
    if (classifyPrunedNode(node, registry, origMap) !== null) return null
    if (node.hasAttribute('data-ugk-root')) return node
    for (const c of getChildElements(node)) {
      const found = findExplicit(c)
      if (found) return found
    }
    return null
  }
  const explicit = findExplicit(body)
  if (explicit) {
    return { root: explicit, rootRule: 'explicit_attr' }
  }

  // 2. Collect candidates: article, main, [role=main], registry CMS roots
  interface Candidate {
    readonly el: SegElementLike
    readonly rule: RootRule
    readonly depth: number
    readonly textLen: number
  }
  const candidates: Candidate[] = []

  const collectCandidates = (node: SegElementLike, depth: number): void => {
    if (classifyPrunedNode(node, registry, origMap) !== null) return
    if (isUgokiSlotNode(node)) return

    const tag = getTag(node)
    const role = (node.getAttribute('role') ?? '').trim().toLowerCase()
    let rule: RootRule | null = null
    if (tag === 'ARTICLE') rule = 'article'
    else if (tag === 'MAIN') rule = 'main'
    else if (role === 'main') rule = 'role_main'
    else if (registry.cmsRootTokens.length > 0) {
      const tokens = getTokenSet(node.getAttribute('class'))
      if (matchesAnyToken(tokens, registry.cmsRootTokens)) {
        rule = 'cms_registry'
      }
    }

    if (rule !== null) {
      const textLen = extractNormalizedText(node, registry, origMap).length
      candidates.push({ el: node, rule, depth, textLen })
    }

    for (const c of getChildElements(node)) {
      collectCandidates(c, depth + 1)
    }
  }

  collectCandidates(body, 0)

  if (candidates.length > 0) {
    // Outermost candidate (shallowest depth; tie-break largest text)
    let outermost = candidates[0]
    for (const c of candidates) {
      if (c.depth < outermost.depth || (c.depth === outermost.depth && c.textLen > outermost.textLen)) {
        outermost = c
      }
    }
    const threshold = outermost.textLen * 0.8

    // Innermost candidate holding >= 80% of outermost candidate's text
    let chosen = outermost
    for (const c of candidates) {
      if (c.textLen >= threshold) {
        if (c.depth > chosen.depth || (c.depth === chosen.depth && c.textLen > chosen.textLen)) {
          chosen = c
        }
      }
    }
    return { root: chosen.el, rootRule: chosen.rule }
  }

  // 3. Fallback: body (chrome containers excluded during traversal)
  return { root: body, rootRule: 'body_fallback' }
}

// ---------------------------------------------------------------------------
// Utility: Image Key, Static Destination Key, Embed Key, Log2 Buckets
// ---------------------------------------------------------------------------

function log2Bucket(n: number): string {
  if (n <= 0) return '0'
  return String(Math.floor(Math.log2(n)))
}

/**
 * Image key (join-final.md A1):
 * path stem of data-src / data-lazy-src / largest srcset candidate / src;
 * query, size suffixes (-WxH, @2x, -scaled) and file extension removed.
 */
export function computeImageKey(
  el: SegElementLike,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): string {
  const dataSrc = readOriginalAttr(el, 'data-src', origMap)
  const dataLazySrc = readOriginalAttr(el, 'data-lazy-src', origMap)
  const srcset = readOriginalAttr(el, 'srcset', origMap)
  const src = readOriginalAttr(el, 'src', origMap)

  let chosen = ''
  if (dataSrc && dataSrc.trim()) {
    chosen = dataSrc.trim()
  } else if (dataLazySrc && dataLazySrc.trim()) {
    chosen = dataLazySrc.trim()
  } else if (srcset && srcset.trim()) {
    // Pick largest candidate by width/density descriptor
    let bestUrl = ''
    let bestScore = -1
    for (const entry of srcset.split(',')) {
      const parts = entry.trim().split(/\s+/)
      if (!parts[0]) continue
      const desc = parts[1] ?? '1x'
      const num = parseFloat(desc)
      const score = Number.isFinite(num) ? (desc.endsWith('w') ? num : num * 1000) : 1
      if (score > bestScore) {
        bestScore = score
        bestUrl = parts[0]
      }
    }
    chosen = bestUrl || (src ?? '').trim()
  } else {
    chosen = (src ?? '').trim()
  }

  if (!chosen) return 'img:empty'
  // Ignore inline data URIs' huge payload: hash compactly
  if (/^data:/i.test(chosen)) {
    return 'img:data:' + hash48(SEGMENTER_RULE_REVISIONS.element, chosen)
  }

  // Strip fragment & query
  const noQuery = chosen.split('#', 1)[0].split('?', 1)[0]
  // Extract pathname if absolute URL
  let pathname = noQuery
  try {
    if (/^https?:\/\//i.test(noQuery) || noQuery.startsWith('//')) {
      const u = new URL(noQuery.startsWith('//') ? `https:${noQuery}` : noQuery)
      pathname = u.pathname
    }
  } catch {
    pathname = noQuery
  }

  // Lowercase stem, remove extension, strip size suffixes (-800x600, @2x, @3x, -scaled)
  const normalizedPath = pathname.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  const withoutExt = normalizedPath.replace(/\.(?:avif|webp|jpe?g|png|gif|svg|bmp|ico|heic)$/i, '')
  const withoutSize = withoutExt
    .replace(/-(?:\d+x\d+|scaled)$/i, '')
    .replace(/@\d+x$/i, '')
    .replace(/-(?:\d+x\d+|scaled)$/i, '')

  return withoutSize || 'img:empty'
}

/**
 * Link static destination key (zero external dependency, deterministic across raw HTML & DOM).
 */
function normalizeStaticHref(rawHref: string | null, baseUrl?: string): string {
  if (!rawHref) return ''
  const trimmed = rawHref.trim()
  if (!trimmed) return ''
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) return 'non-nav'
  if (trimmed.startsWith('#')) return trimmed.toLowerCase()
  if (/^(?:mailto|tel):/i.test(trimmed)) return trimmed.split('?', 1)[0].toLowerCase()

  let parsed: URL | null = null
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      parsed = new URL(trimmed)
    } else if (trimmed.startsWith('//')) {
      parsed = new URL(`https:${trimmed}`)
    } else if (baseUrl) {
      const base = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`
      parsed = new URL(trimmed, base)
    }
  } catch {
    parsed = null
  }

  const filterQuery = (rawQuery: string): string => {
    if (!rawQuery) return ''
    const kept: Array<[string, string]> = []
    for (const part of rawQuery.split('&')) {
      if (!part) continue
      const eq = part.indexOf('=')
      const k = eq >= 0 ? part.slice(0, eq) : part
      const v = eq >= 0 ? part.slice(eq + 1) : ''
      const kl = k.toLowerCase()
      if (kl.startsWith('utm_') || TRACKING_LINK_PARAMS.has(kl)) continue
      kept.push([k, v])
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return kept.map(([k, v]) => `${k}=${v}`).join('&')
  }

  if (parsed) {
    let host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
    if (host.startsWith('www.') && host.slice(4).includes('.')) {
      host = host.slice(4)
    }
    const port = parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : ''
    let pathname = parsed.pathname.replace(/\/+/g, '/')
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
    const q = filterQuery(parsed.search.startsWith('?') ? parsed.search.slice(1) : '')
    return `${host}${port}${pathname}${q ? `?${q}` : ''}`
  }

  // Relative path without baseUrl
  const noFrag = trimmed.split('#', 1)[0]
  const qIdx = noFrag.indexOf('?')
  let relPath = (qIdx >= 0 ? noFrag.slice(0, qIdx) : noFrag).replace(/\/+/g, '/')
  if (relPath.length > 1 && relPath.endsWith('/')) relPath = relPath.slice(0, -1)
  const q = qIdx >= 0 ? filterQuery(noFrag.slice(qIdx + 1)) : ''
  return `${relPath}${q ? `?${q}` : ''}`
}

function computeEmbedKey(
  el: SegElementLike,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): string {
  const src =
    readOriginalAttr(el, 'src', origMap) ??
    readOriginalAttr(el, 'data-src', origMap) ??
    ''
  const trimmed = src.trim()
  if (!trimmed) {
    // Fallback to <source src> inside <video> / <audio>
    for (const c of getChildElements(el)) {
      if (getTag(c) === 'SOURCE') {
        const s = readOriginalAttr(c, 'src', origMap)
        if (s && s.trim()) {
          return computeEmbedKeyFromUrl(s.trim())
        }
      }
    }
    return 'embed:empty'
  }
  return computeEmbedKeyFromUrl(trimmed)
}

function computeEmbedKeyFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr.startsWith('//') ? `https:${urlStr}` : /^https?:\/\//i.test(urlStr) ? urlStr : `https://local.invalid/${urlStr.replace(/^\/+/, '')}`)
    let host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'local.invalid') host = 'local'
    // Extract canonical media id (e.g. YouTube ?v= or last path segment)
    const vParam = u.searchParams.get('v')
    const idPart = vParam ?? u.pathname.replace(/\/+$/, '')
    return `${host}:${idPart}`
  } catch {
    return `embed:${urlStr.split('?', 1)[0]}`
  }
}

/**
 * 自動生成された ID らしい文字列を判定して無視する (join-final.md A1)。
 */
export function isGeneratedLookingId(id: string): boolean {
  const t = id.trim()
  if (!t) return true
  if (/^:?r\d+:?$/i.test(t)) return true
  if (/^(?:react|radix|mui|headlessui|ember|vue|ng|wp-block)[-_:]/.test(t.toLowerCase())) {
    return true
  }
  if (/^(?:uid|guid|uuid|auto|el|field|input)[-_:]?[0-9a-f]{2,}/i.test(t)) {
    return true
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true
  if (/[_-]\d{4,}$/.test(t)) return true
  if (/^[0-9a-f]{10,}$/i.test(t)) return true
  if (/^\d+$/.test(t)) return true
  return false
}

// ---------------------------------------------------------------------------
// Form Fingerprint & Table Header Hash
// ---------------------------------------------------------------------------

function extractTableHeaderAndRowCount(
  tableEl: SegElementLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): { readonly headerHash: string; readonly headerText: string; readonly rowCount: number } {
  const rows: SegElementLike[] = []
  const collectRows = (node: SegElementLike): void => {
    for (const c of getChildElements(node)) {
      if (classifyPrunedNode(c, registry, origMap) !== null) continue
      const t = getTag(c)
      if (t === 'TR') {
        rows.push(c)
      } else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT') {
        collectRows(c)
      }
    }
  }
  collectRows(tableEl)

  let headerText = ''
  if (rows.length > 0) {
    // Prefer first row containing <th>, else first row
    const thRow = rows.find((r) => getChildElements(r).some((cell) => getTag(cell) === 'TH'))
    const targetRow = thRow ?? rows[0]
    const cellTexts = getChildElements(targetRow)
      .filter((cell) => getTag(cell) === 'TH' || getTag(cell) === 'TD')
      .map((cell) => extractNormalizedText(cell, registry, origMap))
      .filter((s) => s.length > 0)
    headerText = cellTexts.join(' | ').slice(0, 160)
  }

  return {
    headerHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'table_hdr', headerText),
    headerText,
    rowCount: rows.length,
  }
}

function buildLabelForMap(
  scope: SegNodeLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (node: SegNodeLike): void => {
    if (isElement(node)) {
      if (classifyPrunedNode(node, registry, origMap) !== null) return
      if (getTag(node) === 'LABEL') {
        const forAttr = node.getAttribute('for')
        if (forAttr) {
          const text = extractNormalizedText(node, registry, origMap)
          if (text) map.set(forAttr, text)
        }
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
  }
  walk(scope)
  return map
}

function computeFieldDescriptor(
  fieldEl: SegElementLike,
  labelMap: ReadonlyMap<string, string>,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): string {
  // NEVER read `.value` or `value` attribute (privacy invariant tel.G7 / join-final.md M5)
  const tag = getTag(fieldEl)
  const inputType = tag === 'INPUT' ? (fieldEl.getAttribute('type') ?? 'text').toLowerCase() : tag.toLowerCase()
  const name = normText(readOriginalAttr(fieldEl, 'name', origMap) ?? '')
  const autocomplete = normText(readOriginalAttr(fieldEl, 'autocomplete', origMap) ?? '')
  const ariaLabel = normText(readOriginalAttr(fieldEl, 'aria-label', origMap) ?? '')
  const rawId = fieldEl.getAttribute('id') ?? ''
  const labelText = rawId && labelMap.has(rawId) ? labelMap.get(rawId)! : ''
  const nonGenId = rawId && !isGeneratedLookingId(rawId) ? normText(rawId) : ''

  const identityPart = name || autocomplete || labelText || ariaLabel || nonGenId || 'anon'
  return `${inputType}:${identityPart.slice(0, 80)}`
}

function computeFormFp(
  formEl: SegElementLike,
  labelMap: ReadonlyMap<string, string>,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
  baseUrl?: string,
): string {
  const action = normalizeStaticHref(readOriginalAttr(formEl, 'action', origMap), baseUrl)
  const method = (readOriginalAttr(formEl, 'method', origMap) ?? 'get').trim().toLowerCase()
  const fieldDescs: string[] = []

  const walk = (node: SegElementLike): void => {
    for (const c of getChildElements(node)) {
      if (classifyPrunedNode(c, registry, origMap) !== null) continue
      const t = getTag(c)
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
        const inputType = t === 'INPUT' ? (c.getAttribute('type') ?? 'text').toLowerCase() : ''
        if (inputType === 'hidden' || inputType === 'submit' || inputType === 'button' || inputType === 'reset') {
          continue
        }
        fieldDescs.push(computeFieldDescriptor(c, labelMap, origMap))
      } else {
        walk(c)
      }
    }
  }
  walk(formEl)
  fieldDescs.sort()
  return hash48(SEGMENTER_RULE_REVISIONS.element, 'form', action, method, fieldDescs.join('|'))
}

// ---------------------------------------------------------------------------
// Document-Level Fingerprints: head_fp, css_fp, res_fp, slot_fp
// ---------------------------------------------------------------------------

function canonicalSortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalSortJson(item))
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    const keys = Object.keys(value as Record<string, unknown>).sort()
    for (const k of keys) {
      sorted[k] = canonicalSortJson((value as Record<string, unknown>)[k])
    }
    return sorted
  }
  return value
}

function extractDateModifiedFromJsonLd(parsed: unknown, out: string[]): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) extractDateModifiedFromJsonLd(item, out)
  } else if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (typeof obj.dateModified === 'string' && obj.dateModified.trim()) {
      out.push(obj.dateModified.trim())
    }
    for (const val of Object.values(obj)) {
      if (val !== null && typeof val === 'object') {
        extractDateModifiedFromJsonLd(val, out)
      }
    }
  }
}

function computeHeadFp(
  doc: SegDocumentLike,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): string {
  let title = ''
  let description = ''
  let robots = ''
  let canonical = ''
  const hreflangs: string[] = []
  const jsonLds: string[] = []
  const modTimes: string[] = []

  const getRawText = (el: SegElementLike): string => {
    const orig = origMap?.get(el)?.text ?? el.getAttribute('data-ugk-orig-text')
    if (orig !== null && orig !== undefined) return orig
    let s = ''
    for (let i = 0; i < el.childNodes.length; i++) {
      const c = el.childNodes[i]
      if (c.nodeType === 3 && c.nodeValue) s += c.nodeValue
    }
    return s
  }

  // Document-wide query (join-final.md A1: parser differences in <head> do not matter)
  const walk = (node: SegNodeLike): void => {
    if (isElement(node)) {
      if (isInsertedOverlayNode(node)) return
      const tag = getTag(node)
      if (tag === 'TITLE' && !title) {
        title = normText(getRawText(node))
      } else if (tag === 'META') {
        const name = (node.getAttribute('name') ?? '').trim().toLowerCase()
        const prop = (node.getAttribute('property') ?? '').trim().toLowerCase()
        const content = readOriginalAttr(node, 'content', origMap) ?? ''
        if (name === 'description' && !description) {
          description = normText(content)
        } else if (name === 'robots' && !robots) {
          robots = normText(content)
        } else if (prop === 'article:modified_time' || name === 'last-modified') {
          if (content.trim()) modTimes.push(content.trim())
        }
      } else if (tag === 'LINK') {
        const relTokens = getTokenSet(node.getAttribute('rel'))
        const href = (readOriginalAttr(node, 'href', origMap) ?? '').trim()
        if (relTokens.has('canonical') && !canonical && href) {
          canonical = href
        }
        if (relTokens.has('alternate')) {
          const hreflang = (node.getAttribute('hreflang') ?? '').trim().toLowerCase()
          if (hreflang && href) {
            hreflangs.push(`${hreflang}=${href}`)
          }
        }
      } else if (tag === 'SCRIPT') {
        const type = (node.getAttribute('type') ?? '').trim().toLowerCase()
        if (type === 'application/ld+json') {
          const raw = getRawText(node).trim()
          if (raw) {
            try {
              const parsed: unknown = JSON.parse(raw)
              extractDateModifiedFromJsonLd(parsed, modTimes)
              jsonLds.push(JSON.stringify(canonicalSortJson(parsed)))
            } catch {
              jsonLds.push(normText(raw))
            }
          }
        }
      } else if (tag === 'TIME') {
        const itemprop = (node.getAttribute('itemprop') ?? '').trim().toLowerCase()
        if (itemprop === 'datemodified') {
          const dt = (node.getAttribute('datetime') ?? '').trim()
          if (dt) modTimes.push(dt)
        }
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
  }

  walk(doc)
  hreflangs.sort()
  jsonLds.sort()
  modTimes.sort()

  return hash64(
    SEGMENTER_RULE_REVISIONS.head,
    title,
    description,
    robots,
    canonical,
    hreflangs.join('\n'),
    jsonLds.join('\n'),
    modTimes.join('\n'),
  )
}

function stripCacheBusterParams(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''
  const noFrag = trimmed.split('#', 1)[0]
  const qIdx = noFrag.indexOf('?')
  if (qIdx < 0) return noFrag
  const base = noFrag.slice(0, qIdx)
  const query = noFrag.slice(qIdx + 1)
  const kept: string[] = []
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = (eq >= 0 ? part.slice(0, eq) : part).toLowerCase()
    if (CACHE_BUSTER_PARAMS.has(k)) continue
    kept.push(part)
  }
  kept.sort()
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base
}

function computeCssAndResFp(
  doc: SegDocumentLike,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): { readonly css_fp: string; readonly res_fp: string } {
  const stylesheetsWithVersions: string[] = []
  const inlineStyleHashes: string[] = []
  const resourceUrlsStripped: string[] = []

  const walk = (node: SegNodeLike): void => {
    if (isElement(node)) {
      if (isInsertedOverlayNode(node)) return
      const tag = getTag(node)
      if (tag === 'LINK') {
        const relTokens = getTokenSet(node.getAttribute('rel'))
        const href = (readOriginalAttr(node, 'href', origMap) ?? '').trim()
        if (relTokens.has('stylesheet') && href) {
          stylesheetsWithVersions.push(href)
          resourceUrlsStripped.push(`css:${stripCacheBusterParams(href)}`)
        }
      } else if (tag === 'STYLE') {
        let raw = ''
        for (let i = 0; i < node.childNodes.length; i++) {
          const c = node.childNodes[i]
          if (c.nodeType === 3 && c.nodeValue) raw += c.nodeValue
        }
        const normalizedStyle = normText(raw)
        if (normalizedStyle) {
          inlineStyleHashes.push(hash64(SEGMENTER_RULE_REVISIONS.css, 'inline', normalizedStyle))
        }
      } else if (tag === 'SCRIPT') {
        const src = (readOriginalAttr(node, 'src', origMap) ?? '').trim()
        if (src) {
          resourceUrlsStripped.push(`js:${stripCacheBusterParams(src)}`)
        }
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
  }

  walk(doc)
  stylesheetsWithVersions.sort()
  resourceUrlsStripped.sort()

  const css_fp = hash64(
    SEGMENTER_RULE_REVISIONS.css,
    stylesheetsWithVersions.join('\n'),
    inlineStyleHashes.join(','),
  )
  const res_fp = hash64(SEGMENTER_RULE_REVISIONS.res, resourceUrlsStripped.join('\n'))
  return { css_fp, res_fp }
}

/**
 * LINK が差し込んだオリジン枠 (`[data-ugk-slot]`) の照合キーを本文構造から分離して算出する (D-9)。
 */
function computeSlotFingerprints(
  doc: SegDocumentLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
  baseUrl?: string,
): { readonly slot_fp: string; readonly slots: readonly SegmentedSlot[] } {
  const slots: SegmentedSlot[] = []

  const walk = (node: SegNodeLike): void => {
    if (isElement(node)) {
      if (isUgokiSlotNode(node)) {
        const slotName = normText(node.getAttribute('data-ugk-slot') ?? '') || 'default'
        const slotText = extractNormalizedText(node, registry, origMap, true)
        const slotLinks: string[] = []
        const collectLinks = (sub: SegElementLike): void => {
          if (getTag(sub) === 'A') {
            const href = normalizeStaticHref(readOriginalAttr(sub, 'href', origMap), baseUrl)
            if (href) slotLinks.push(href)
          }
          for (const c of getChildElements(sub)) collectLinks(c)
        }
        collectLinks(node)
        slotLinks.sort()

        const contentHash = hash64(SEGMENTER_RULE_REVISIONS.slot, 'content', slotText, slotLinks.join('|'))
        const singleSlotFp = hash48(SEGMENTER_RULE_REVISIONS.slot, slotName, contentHash)
        slots.push(
          Object.freeze({
            slot_name: slotName,
            slot_fp: singleSlotFp,
            content_hash: contentHash,
          }),
        )
        return
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
  }

  walk(doc)
  slots.sort((a, b) =>
    a.slot_name !== b.slot_name
      ? a.slot_name < b.slot_name
        ? -1
        : 1
      : a.slot_fp < b.slot_fp
        ? -1
        : a.slot_fp > b.slot_fp
          ? 1
          : 0,
  )

  const combinedSlotFp =
    slots.length === 0
      ? '0000000000000000'
      : hash64(SEGMENTER_RULE_REVISIONS.slot, ...slots.map((s) => `${s.slot_name}:${s.slot_fp}`))

  return {
    slot_fp: combinedSlotFp,
    slots: Object.freeze(slots),
  }
}

// ---------------------------------------------------------------------------
// Block & Element Extraction
// ---------------------------------------------------------------------------

interface RawBlockItem {
  readonly kind: BlockKind
  readonly key: string
  readonly textHash: string
  readonly normalizedText: string
  readonly anchorFallbackText: string
  readonly node: SegElementLike
}

function extractBlockFromElement(
  el: SegElementLike,
  labelMap: ReadonlyMap<string, string>,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
  baseUrl?: string,
): RawBlockItem | null {
  const tag = getTag(el)

  if (tag === 'TABLE') {
    const tbl = extractTableHeaderAndRowCount(el, registry, origMap)
    const fullText = extractNormalizedText(el, registry, origMap)
    const key = `${tbl.headerHash}:${log2Bucket(tbl.rowCount)}`
    return {
      kind: 'table',
      key,
      textHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'table_body', fullText),
      normalizedText: fullText,
      anchorFallbackText: tbl.headerText.slice(0, 80) || fullText.slice(0, 80) || 'table',
      node: el,
    }
  }

  if (tag === 'UL' || tag === 'OL' || tag === 'DL') {
    const items = getChildElements(el).filter((c) => {
      const ct = getTag(c)
      return (ct === 'LI' || ct === 'DT' || ct === 'DD') && classifyPrunedNode(c, registry, origMap) === null
    })
    const firstItemText = items.length > 0 ? extractNormalizedText(items[0], registry, origMap) : ''
    const fullText = extractNormalizedText(el, registry, origMap)
    if (!fullText && items.length === 0) return null
    const key = `${hash64(SEGMENTER_RULE_REVISIONS.block, 'list_first', firstItemText.slice(0, 80))}:${log2Bucket(items.length)}`
    return {
      kind: 'list',
      key,
      textHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'list_body', fullText),
      normalizedText: fullText,
      anchorFallbackText: firstItemText.slice(0, 80) || fullText.slice(0, 80),
      node: el,
    }
  }

  if (tag === 'FIGURE' || tag === 'IMG') {
    const findImg = (n: SegElementLike): SegElementLike | null => {
      if (getTag(n) === 'IMG') return n
      for (const c of getChildElements(n)) {
        const found = findImg(c)
        if (found) return found
      }
      return null
    }
    const imgEl = findImg(el)
    const imgKey = imgEl ? computeImageKey(imgEl, origMap) : 'figure:empty'
    const caption = extractNormalizedText(el, registry, origMap)
    return {
      kind: 'figure',
      key: imgKey,
      textHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'figure', imgKey, caption),
      normalizedText: caption,
      anchorFallbackText: caption.slice(0, 80) || imgKey,
      node: el,
    }
  }

  if (tag === 'FORM') {
    const formFp = computeFormFp(el, labelMap, registry, origMap, baseUrl)
    const staticText = extractNormalizedText(el, registry, origMap)
    return {
      kind: 'form',
      key: formFp,
      textHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'form', formFp),
      normalizedText: staticText,
      anchorFallbackText: `form:${formFp}`,
      node: el,
    }
  }

  if (tag === 'IFRAME' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'OBJECT' || tag === 'EMBED') {
    const embedKey = computeEmbedKey(el, origMap)
    return {
      kind: 'embed',
      key: embedKey,
      textHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'embed', embedKey),
      normalizedText: '',
      anchorFallbackText: embedKey,
      node: el,
    }
  }

  // Text block (`p`, `blockquote`, `pre`, leaf `div`/`section`)
  const text = extractNormalizedText(el, registry, origMap)
  if (!text) return null
  const prefix80 = text.slice(0, 80)
  const key = `${hash64(SEGMENTER_RULE_REVISIONS.block, 'text_head', prefix80)}:${log2Bucket(text.length)}`
  return {
    kind: 'text',
    key,
    textHash: hash64(SEGMENTER_RULE_REVISIONS.block, 'text_body', text),
    normalizedText: text,
    anchorFallbackText: prefix80,
    node: el,
  }
}

const LEAF_BLOCK_TAGS = new Set([
  'P', 'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL', 'DL', 'FIGURE', 'FORM',
  'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'IMG',
])

const STRUCTURAL_CONTAINER_TAGS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'DETAILS', 'SUMMARY', 'ADDRESS', 'FIELDSET',
])

function hasDirectNonWhitespaceText(
  el: SegElementLike,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): boolean {
  if (origMap?.get(el)?.text !== undefined || el.getAttribute('data-ugk-orig-text') !== null) {
    return true
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === 3 && c.nodeValue && normText(c.nodeValue).length > 0) {
      return true
    }
  }
  return false
}

function hasDescendantMatching(el: SegElementLike, pred: (e: SegElementLike) => boolean): boolean {
  for (const c of getChildElements(el)) {
    if (pred(c) || hasDescendantMatching(c, pred)) return true
  }
  return false
}

function extractElementLabel(
  el: SegElementLike,
  registry: PruneRegistry,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
): string {
  const text = extractNormalizedText(el, registry, origMap)
  if (text) return text.slice(0, 80)

  const aria = normText(readOriginalAttr(el, 'aria-label', origMap) ?? '')
  if (aria) return aria.slice(0, 80)

  // Image alt or image key inside link/button
  const findImg = (n: SegElementLike): SegElementLike | null => {
    for (const c of getChildElements(n)) {
      if (getTag(c) === 'IMG') return c
      const nested = findImg(c)
      if (nested) return nested
    }
    return null
  }
  const img = findImg(el)
  if (img) {
    const alt = normText(readOriginalAttr(img, 'alt', origMap) ?? '')
    if (alt) return alt.slice(0, 80)
    return computeImageKey(img, origMap).slice(0, 80)
  }

  const title = normText(readOriginalAttr(el, 'title', origMap) ?? '')
  if (title) return title.slice(0, 80)

  return ''
}

function collectElementsInSubtree(
  node: SegElementLike,
  region: ElementRegion,
  secFp: string | null,
  currentFormFp: string | null,
  labelMap: ReadonlyMap<string, string>,
  registry: PruneRegistry,
  out: SegmentedElement[],
  slotOrdinals: Map<string, number>,
  origMap?: ReadonlyMap<SegElementLike, OriginalNodeValues>,
  baseUrl?: string,
  stopPredicate?: (el: SegElementLike) => boolean,
): void {
  if (classifyPrunedNode(node, registry, origMap) !== null) return
  if (isUgokiSlotNode(node)) return
  if (stopPredicate && stopPredicate(node)) return

  const tag = getTag(node)
  let nextFormFp = currentFormFp
  if (tag === 'FORM') {
    nextFormFp = computeFormFp(node, labelMap, registry, origMap, baseUrl)
  }

  const emitElement = (kind: ElementKind, elFp: string, destKeyStatic?: string): void => {
    const secKey = secFp ?? `chrome:${region}`
    const slotKey = `${secKey}|${elFp}`
    const ord = slotOrdinals.get(slotKey) ?? 0
    slotOrdinals.set(slotKey, ord + 1)
    const slotId = hash48(SEGMENTER_RULE_REVISIONS.element, 'slot_id', elFp, secKey, String(ord))
    out.push(
      Object.freeze({
        el_fp: elFp,
        kind,
        region,
        sec_fp: secFp,
        slot_id: slotId,
        ...(destKeyStatic !== undefined ? { dest_key_static: destKeyStatic } : {}),
      }),
    )
  }

  if (tag === 'A' && readOriginalAttr(node, 'href', origMap) !== null) {
    const destKey = normalizeStaticHref(readOriginalAttr(node, 'href', origMap), baseUrl)
    const label = extractElementLabel(node, registry, origMap)
    const elFp = hash48(SEGMENTER_RULE_REVISIONS.element, 'link', region, destKey, label)
    emitElement('link', elFp, destKey)
  } else if (
    tag === 'BUTTON' ||
    (tag === 'INPUT' &&
      ['submit', 'button', 'reset'].includes((node.getAttribute('type') ?? '').toLowerCase())) ||
    (node.getAttribute('role') ?? '').trim().toLowerCase() === 'button'
  ) {
    const label =
      tag === 'INPUT'
        ? normText(readOriginalAttr(node, 'aria-label', origMap) ?? readOriginalAttr(node, 'name', origMap) ?? '')
        : extractElementLabel(node, registry, origMap)
    const scopeKey = nextFormFp ?? secFp ?? region
    const elFp = hash48(SEGMENTER_RULE_REVISIONS.element, 'button', region, label, scopeKey)
    emitElement('button', elFp)
  } else if (tag === 'IMG') {
    const imgKey = computeImageKey(node, origMap)
    const elFp = hash48(SEGMENTER_RULE_REVISIONS.element, 'image', region, imgKey)
    emitElement('image', elFp)
  } else if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const inputType = tag === 'INPUT' ? (node.getAttribute('type') ?? 'text').toLowerCase() : ''
    if (inputType !== 'hidden' && inputType !== 'submit' && inputType !== 'button' && inputType !== 'reset') {
      const desc = computeFieldDescriptor(node, labelMap, origMap)
      const formScope = nextFormFp ?? secFp ?? region
      const elFp = hash48(SEGMENTER_RULE_REVISIONS.element, 'field', region, formScope, desc)
      emitElement('field', elFp)
    }
  } else if (tag === 'TABLE') {
    const tbl = extractTableHeaderAndRowCount(node, registry, origMap)
    const elFp = hash48(SEGMENTER_RULE_REVISIONS.element, 'table', region, tbl.headerHash)
    emitElement('table', elFp)
  } else if (tag === 'VIDEO' || tag === 'IFRAME') {
    const kind: ElementKind = tag === 'VIDEO' ? 'video' : 'iframe'
    const embedKey = computeEmbedKey(node, origMap)
    const elFp = hash48(SEGMENTER_RULE_REVISIONS.element, kind, region, embedKey)
    emitElement(kind, elFp)
  }

  for (const child of getChildElements(node)) {
    collectElementsInSubtree(
      child,
      region,
      secFp,
      nextFormFp,
      labelMap,
      registry,
      out,
      slotOrdinals,
      origMap,
      baseUrl,
      stopPredicate,
    )
  }
}

// ---------------------------------------------------------------------------
// Core Section Segmentation Engine
// ---------------------------------------------------------------------------

interface WorkingSection {
  readonly tier: AnchorTier
  readonly anchorText: string
  readonly anchorHash: string
  readonly ctx: string
  readonly dup: number
  readonly secFp: string
  readonly groupKey: string
  readonly blocks: RawBlockItem[]
  readonly elementNodes: SegElementLike[]
  readonly depthBand?: readonly [number, number]
}

export function segmentDocument(doc: SegDocumentLike, options?: SegmentOptions): SegmenterOutput {
  const registry = options?.pruneRegistry ?? DEFAULT_PRUNE_REGISTRY
  const segHash =
    registry === DEFAULT_PRUNE_REGISTRY
      ? SEGMENTER_CONTENT_HASH
      : computeSegmenterContentHash(registry)
  const origMap = options?.originalValueMap
  const baseUrl = options?.url

  const emptyFailure = (domState: DomState, rootRule: RootRule = 'none'): SegmenterOutput =>
    Object.freeze({
      dom_state: domState,
      root_rule: rootRule,
      segmenter_hash: segHash,
      rule_revisions: SEGMENTER_RULE_REVISIONS,
      prune_registry_rev: registry.rev,
      skel_fp: null,
      struct_fp: null,
      head_fp: null,
      links_fp: null,
      res_fp: null,
      css_fp: null,
      slot_fp: null,
      sections: Object.freeze([]),
      elements: Object.freeze([]),
      slots: Object.freeze([]),
    })

  // 1. Self-test norm probe (join-final.md A1)
  if (!verifyNormProbe()) {
    return emptyFailure('norm_mismatch')
  }

  // 2. Anonymous scope check (設計書 §6.1 / join-final.md M1.1)
  if (isOutsideAnonymousScope(doc, options)) {
    return emptyFailure('private_scope')
  }

  const body = findBody(doc)
  if (!body) {
    return emptyFailure('ok', 'none')
  }

  // 3. Document-wide non-section fingerprints
  const headFp = computeHeadFp(doc, origMap)
  const { css_fp: cssFp, res_fp: resFp } = computeCssAndResFp(doc, origMap)
  const { slot_fp: slotFp, slots } = computeSlotFingerprints(doc, registry, origMap, baseUrl)

  // 4. Content root selection
  const { root, rootRule } = selectContentRoot(body, registry, origMap)
  const labelMap = buildLabelForMap(body, registry, origMap)
  const registeredHeadingIds = new Set(
    (options?.registeredHeadingIds ?? []).map((id) => id.trim().toLowerCase()),
  )

  const isSkipInRoot = (el: SegElementLike): boolean => {
    if (el === root) return false
    if (classifyPrunedNode(el, registry, origMap) !== null) return true
    if (isUgokiSlotNode(el)) return true
    if (rootRule === 'body_fallback' && isChromeContainer(el)) return true
    if (rootRule !== 'body_fallback' && isChromeContainer(el)) return true
    return false
  }

  // Detect whether root contains pins, h2/h3, or h4 fallback headings
  let hasPin = false
  let hasH2OrH3 = false
  let hasH4 = false
  let firstH1Text = ''

  const scanAnchors = (el: SegElementLike): void => {
    if (isSkipInRoot(el)) return
    const tag = getTag(el)
    const idLower = (el.getAttribute('id') ?? '').trim().toLowerCase()
    if (el.hasAttribute('data-ugk-section') || (idLower && registeredHeadingIds.has(idLower))) {
      hasPin = true
    }
    if (tag === 'H1' && !firstH1Text) {
      firstH1Text = extractNormalizedText(el, registry, origMap)
    } else if (tag === 'H2' || tag === 'H3') {
      hasH2OrH3 = true
    } else if (tag === 'H4') {
      hasH4 = true
    }
    for (const c of getChildElements(el)) scanAnchors(c)
  }
  scanAnchors(root)

  const useH4AsHeading = !hasPin && !hasH2OrH3 && hasH4
  const useHeadingOrPinMode = hasPin || hasH2OrH3 || useH4AsHeading

  const isAnchorHeading = (el: SegElementLike): boolean => {
    const tag = getTag(el)
    if (tag === 'H2' || tag === 'H3') return true
    if (useH4AsHeading && tag === 'H4') return true
    return false
  }

  const isPinnedElement = (el: SegElementLike): boolean => {
    if (el.hasAttribute('data-ugk-section')) return true
    const idLower = (el.getAttribute('id') ?? '').trim().toLowerCase()
    return Boolean(idLower && registeredHeadingIds.has(idLower))
  }

  const dupCounts = new Map<string, number>()
  const workingSections: WorkingSection[] = []

  const openSection = (
    tier: AnchorTier,
    rawAnchorText: string,
    ctx: string,
    depthBand?: readonly [number, number],
  ): WorkingSection => {
    const anchorNorm = normText(rawAnchorText).slice(0, 160)
    const anchorHash = hash64(SEGMENTER_RULE_REVISIONS.norm, anchorNorm)
    const groupKey = `${tier}|${anchorHash}|${ctx}`
    const dup = dupCounts.get(groupKey) ?? 0
    dupCounts.set(groupKey, dup + 1)
    const secFp = hash48(SEGMENTER_RULE_REVISIONS.anchor, tier, anchorHash, ctx, String(dup))
    const sec: WorkingSection = {
      tier,
      anchorText: anchorNorm,
      anchorHash,
      ctx,
      dup,
      secFp,
      groupKey,
      blocks: [],
      elementNodes: [],
      ...(depthBand ? { depthBand } : {}),
    }
    workingSections.push(sec)
    return sec
  }

  if (useHeadingOrPinMode) {
    let currentSection: WorkingSection | null = null
    let currentH2SecFp: string | null = null
    let leadSection: WorkingSection | null = null

    const ensureLeadSection = (): WorkingSection => {
      if (currentSection) return currentSection
      if (!leadSection) {
        leadSection = openSection('heading', firstH1Text || '__lead__', 'root')
      }
      currentSection = leadSection
      return currentSection
    }

    const walkRoot = (el: SegElementLike): void => {
      if (isSkipInRoot(el)) return

      const tag = getTag(el)

      // Explicit pin `[data-ugk-section]` or registered heading id
      if (isPinnedElement(el) && el !== root) {
        const pinVal = normText(el.getAttribute('data-ugk-section') ?? '')
        const idVal = normText(el.getAttribute('id') ?? '')
        const anchorLabel = pinVal || idVal || extractNormalizedText(el, registry, origMap) || '__pin__'
        const sec = openSection('pin', anchorLabel, 'root')
        currentSection = sec
        if (tag === 'H2') {
          currentH2SecFp = sec.secFp
          sec.elementNodes.push(el)
          return
        }
        if (tag === 'H3' || tag === 'H4') {
          sec.elementNodes.push(el)
          return
        }
        // Container pin (e.g. <section data-ugk-section="pricing">):
        // Absorbs its own title heading (if first H2) without splitting into an empty orphan section
        currentH2SecFp = sec.secFp
        let absorbedLeadingHeading = false
        for (const child of getChildElements(el)) {
          if (!absorbedLeadingHeading && getTag(child) === 'H2' && !isPinnedElement(child)) {
            absorbedLeadingHeading = true
            sec.elementNodes.push(child)
            continue
          }
          walkRoot(child)
        }
        return
      }

      // Heading anchor (`h2` / `h3`, or `h4` when no `h2`/`h3`/pin)
      if (isAnchorHeading(el)) {
        const headingText = extractNormalizedText(el, registry, origMap) || `__${tag.toLowerCase()}__`
        const ctx = tag === 'H3' ? (currentH2SecFp ?? 'root') : 'root'
        const sec = openSection('heading', headingText, ctx)
        currentSection = sec
        if (tag === 'H2') {
          currentH2SecFp = sec.secFp
        }
        sec.elementNodes.push(el)
        return
      }

      // Skip H1 as anchor (its text already names lead section if lead blocks exist),
      // but still capture links/images inside H1 if any
      if (tag === 'H1') {
        if (hasDescendantMatching(el, (c) => getTag(c) === 'A' || getTag(c) === 'IMG')) {
          ensureLeadSection().elementNodes.push(el)
        }
        return
      }

      // Leaf content block
      if (LEAF_BLOCK_TAGS.has(tag)) {
        const block = extractBlockFromElement(el, labelMap, registry, origMap, baseUrl)
        if (block) {
          const target = ensureLeadSection()
          target.blocks.push(block)
          target.elementNodes.push(el)
        } else if (tag === 'IMG' || tag === 'IFRAME' || tag === 'VIDEO') {
          ensureLeadSection().elementNodes.push(el)
        }
        return
      }

      // Structural container (div/section/etc.): check if it contains nested anchors or leaf blocks
      if (STRUCTURAL_CONTAINER_TAGS.has(tag) || el === root) {
        const containsAnchorOrBlock = hasDescendantMatching(
          el,
          (c) =>
            !isSkipInRoot(c) &&
            (isAnchorHeading(c) || isPinnedElement(c) || LEAF_BLOCK_TAGS.has(getTag(c))),
        )
        if (!containsAnchorOrBlock && el !== root && hasDirectNonWhitespaceText(el, origMap)) {
          const block = extractBlockFromElement(el, labelMap, registry, origMap, baseUrl)
          if (block) {
            const target = ensureLeadSection()
            target.blocks.push(block)
            target.elementNodes.push(el)
          }
          return
        }
        for (const child of getChildElements(el)) {
          walkRoot(child)
        }
        return
      }

      // Any other element inside root (e.g., standalone <a>, <button>, <span>)
      if (
        tag === 'A' ||
        tag === 'BUTTON' ||
        (el.getAttribute('role') ?? '').trim().toLowerCase() === 'button'
      ) {
        const target = ensureLeadSection()
        target.elementNodes.push(el)
        return
      }

      for (const child of getChildElements(el)) {
        walkRoot(child)
      }
    }

    walkRoot(root)
  } else {
    // Tier 2: Heading-poor / No headings -> block_fallback keyed by first 80 normalized chars
    const fallbackBlocks: RawBlockItem[] = []

    const walkBlocks = (el: SegElementLike): void => {
      if (isSkipInRoot(el)) return
      const tag = getTag(el)

      if (LEAF_BLOCK_TAGS.has(tag)) {
        const block = extractBlockFromElement(el, labelMap, registry, origMap, baseUrl)
        if (block) fallbackBlocks.push(block)
        return
      }

      if (STRUCTURAL_CONTAINER_TAGS.has(tag) && el !== root) {
        const hasNestedBlock = hasDescendantMatching(
          el,
          (c) => !isSkipInRoot(c) && LEAF_BLOCK_TAGS.has(getTag(c)),
        )
        if (!hasNestedBlock && hasDirectNonWhitespaceText(el, origMap)) {
          const block = extractBlockFromElement(el, labelMap, registry, origMap, baseUrl)
          if (block) fallbackBlocks.push(block)
          return
        }
      }

      for (const child of getChildElements(el)) {
        walkBlocks(child)
      }
    }

    walkBlocks(root)

    if (fallbackBlocks.length > 0) {
      for (const blk of fallbackBlocks) {
        const sec = openSection('block_fallback', blk.anchorFallbackText.slice(0, 80), 'root')
        sec.blocks.push(blk)
        sec.elementNodes.push(blk.node)
      }
    } else {
      // Tier 3: No anchor and no blocks -> 20 fixed 5% depth bands (geometry only)
      for (let pct = 0; pct < 100; pct += 5) {
        openSection('depth_band', `depth:${pct}-${pct + 5}`, 'root', [pct, pct + 5])
      }
    }
  }

  // Finalize sections, block fingerprints, body_fp, body_digest_128, and root elements
  const degraded = options?.degraded ?? false
  const finalSections: SegmentedSection[] = []
  const allElements: SegmentedElement[] = []
  const slotOrdinals = new Map<string, number>()

  for (let i = 0; i < workingSections.length; i++) {
    const ws = workingSections[i]
    const positional = (dupCounts.get(ws.groupKey) ?? 0) > 1

    const blkDupCounts = new Map<string, number>()
    const finalBlocks: SegmentedBlock[] = []
    const blockTextHashes: string[] = []
    const sectionTexts: string[] = []

    if (!degraded) {
      for (const rb of ws.blocks) {
        const bKey = `${rb.kind}|${rb.key}`
        const bDup = blkDupCounts.get(bKey) ?? 0
        blkDupCounts.set(bKey, bDup + 1)
        const blkFp = hash40(
          SEGMENTER_RULE_REVISIONS.block,
          ws.secFp,
          rb.kind,
          rb.key,
          String(bDup),
        )
        finalBlocks.push(
          Object.freeze({
            blk_fp: blkFp,
            sec_fp: ws.secFp,
            kind: rb.kind,
            dup: bDup,
            text_hash: rb.textHash,
          }),
        )
        blockTextHashes.push(rb.textHash)
        if (rb.normalizedText) sectionTexts.push(rb.normalizedText)
      }
    }

    const bodyFp = degraded
      ? '00000000'
      : hash32(SEGMENTER_RULE_REVISIONS.body, ...blockTextHashes)
    const fullSectionText = normText(sectionTexts.join(' '))
    const bodyDigest128 = degraded
      ? '00000000000000000000000000000000'
      : hash128(SEGMENTER_RULE_REVISIONS.digest, fullSectionText)

    finalSections.push(
      Object.freeze({
        ordinal: i,
        sec_fp: ws.secFp,
        tier: ws.tier,
        anchor_hash: ws.anchorHash,
        ctx: ws.ctx,
        dup: ws.dup,
        positional,
        body_fp: bodyFp,
        body_digest_128: bodyDigest128,
        ...(ws.depthBand ? { depth_band: ws.depthBand } : {}),
        blocks: Object.freeze(finalBlocks),
      }),
    )

    for (const elNode of ws.elementNodes) {
      collectElementsInSubtree(
        elNode,
        'root',
        ws.secFp,
        null,
        labelMap,
        registry,
        allElements,
        slotOrdinals,
        origMap,
        baseUrl,
      )
    }
  }

  // Collect chrome region elements (elements outside root, or inside chrome containers within body)
  const collectChrome = (el: SegElementLike): void => {
    if (classifyPrunedNode(el, registry, origMap) !== null) return
    if (isUgokiSlotNode(el)) return
    if (el === root) {
      // Inside root, scan chrome containers (e.g., <aside>, <header>, <footer> nested inside root)
      for (const c of getChildElements(el)) {
        if (isChromeContainer(c)) {
          collectElementsInSubtree(
            c,
            'chrome',
            null,
            null,
            labelMap,
            registry,
            allElements,
            slotOrdinals,
            origMap,
            baseUrl,
          )
        } else {
          collectChromeInsideRoot(c)
        }
      }
      return
    }
    if (isChromeContainer(el)) {
      collectElementsInSubtree(
        el,
        'chrome',
        null,
        null,
        labelMap,
        registry,
        allElements,
        slotOrdinals,
        origMap,
        baseUrl,
        (sub) => sub === root,
      )
      return
    }
    // Check if this element is an ancestor of root
    if (hasDescendantMatching(el, (sub) => sub === root)) {
      for (const c of getChildElements(el)) {
        collectChrome(c)
      }
    } else {
      // Sibling subtree outside root -> chrome region!
      collectElementsInSubtree(
        el,
        'chrome',
        null,
        null,
        labelMap,
        registry,
        allElements,
        slotOrdinals,
        origMap,
        baseUrl,
      )
    }
  }

  const collectChromeInsideRoot = (el: SegElementLike): void => {
    if (classifyPrunedNode(el, registry, origMap) !== null) return
    if (isUgokiSlotNode(el)) return
    if (isChromeContainer(el)) {
      collectElementsInSubtree(
        el,
        'chrome',
        null,
        null,
        labelMap,
        registry,
        allElements,
        slotOrdinals,
        origMap,
        baseUrl,
      )
      return
    }
    for (const c of getChildElements(el)) {
      collectChromeInsideRoot(c)
    }
  }

  collectChrome(body)

  // Skeleton, struct, and links fingerprints
  const skelFp = hash64(SEGMENTER_RULE_REVISIONS.skel, ...finalSections.map((s) => s.sec_fp))
  const structFp = hash64(
    SEGMENTER_RULE_REVISIONS.struct,
    ...finalSections.map((s) => `${s.sec_fp}:${s.body_fp}`),
  )

  const rootLinkFps = Array.from(
    new Set(allElements.filter((e) => e.kind === 'link' && e.region === 'root').map((e) => e.el_fp)),
  ).sort()
  const chromeLinkFps = Array.from(
    new Set(
      allElements.filter((e) => e.kind === 'link' && e.region === 'chrome').map((e) => e.el_fp),
    ),
  ).sort()
  const linksRootFp = hash64(SEGMENTER_RULE_REVISIONS.links, 'root', ...rootLinkFps)
  const linksChromeFp = hash64(SEGMENTER_RULE_REVISIONS.links, 'chrome', ...chromeLinkFps)
  const linksFp: LinksFingerprint = Object.freeze({
    root: linksRootFp,
    chrome: linksChromeFp,
    combined: linksRootFp + linksChromeFp,
  })

  return Object.freeze({
    dom_state: degraded ? 'degraded' : 'ok',
    root_rule: rootRule,
    segmenter_hash: segHash,
    rule_revisions: SEGMENTER_RULE_REVISIONS,
    prune_registry_rev: registry.rev,
    skel_fp: skelFp,
    struct_fp: structFp,
    head_fp: headFp,
    links_fp: linksFp,
    res_fp: resFp,
    css_fp: cssFp,
    slot_fp: slotFp,
    sections: Object.freeze(finalSections),
    elements: Object.freeze(allElements),
    slots,
  })
}

/**
 * 生 HTML 文字列を軽量純 JS パーサーで解析し、DOM 入力と 100% 同一の区画・照合キーを返す。
 */
export function segmentHtml(html: string, options?: SegmentOptions): SegmenterOutput {
  const dom = parseHtmlToDom(html)
  return segmentDocument(dom, options)
}
