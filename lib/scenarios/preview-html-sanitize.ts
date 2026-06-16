/**
 * preview-html-sanitize.ts — エディタ内プレビュー用 client-side HTML allowlist sanitizer (C)
 *
 * 鉄則「HTML は必ず sanitize を通す。XSS 厳禁」に従い、プレビューでも variant HTML を
 * sanitize する。本実装は public/scenario-runtime.js の `_sanitizeToFragment` / `_sanitizeNode`
 * と同一 allowlist を DOMParser で適用し「実際に visitor が見る描画」に一致させる
 * (server 側 html-sanitizer.ts は sanitize-html ベースの write 境界 sanitizer。本モジュールは
 *  render 境界の runtime sanitizer を mirror。runtime は served 静的ファイルで import 不可のため
 *  ロジックを移植している)。
 *
 * 呼び出し側 (VariantPreview) は結果を sandbox iframe(allow-scripts なし) に描画するため、
 * 万一漏れても script は実行されない (defense in depth)。DOMParser 不在 (SSR) では
 * fail-closed で空文字を返す。
 */

import { isSafeHttpsUrl } from './safe-url'

/**
 * runtime (`_isSafeHttpsUrl`) と同等の厳格 https 絶対 URL 判定。
 * 共有 safe-url の isSafeHttpsUrl は URL 正規化で先頭空白/制御文字を吸収するため runtime より
 * 僅かに緩い。preview は「実際に visitor が見る描画」に一致させるため、raw が ^https:// で
 * 始まることも要求する (Codex review LOW 指摘の fidelity 揃え。XSS 経路ではないが整合性のため)。
 */
export function isHttpsAbsoluteUrl(rawUrl: string): boolean {
  return typeof rawUrl === 'string' && /^https:\/\//i.test(rawUrl) && isSafeHttpsUrl(rawUrl)
}

const SAFE_TAGS: ReadonlySet<string> = new Set([
  'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SMALL', 'SUB', 'SUP',
  'BR', 'HR', 'P', 'DIV', 'SPAN', 'SECTION', 'HEADER', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'IMG', 'PICTURE', 'SOURCE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
])

const SAFE_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  A: new Set(['href', 'title', 'target', 'rel', 'style']),
  IMG: new Set(['src', 'alt', 'width', 'height', 'style']),
  SOURCE: new Set(['srcset', 'media', 'type']),
  TD: new Set(['colspan', 'rowspan', 'style']),
  TH: new Set(['colspan', 'rowspan', 'scope', 'style']),
}

function safeStyle(value: string): string {
  if (/url\s*\(|expression\s*\(|javascript:|vbscript:|@import|<|>/i.test(value)) return ''
  return value
}

function attrAllowed(tag: string, name: string): boolean {
  if (/^on/i.test(name)) return false // on* イベントハンドラは絶対不可
  const generic = name === 'style' || name === 'title'
  const perTag = SAFE_ATTRS[tag]?.has(name)
  return !!perTag || generic
}

function sanitizeNode(src: Node): Node | null {
  if (src.nodeType === 3) return document.createTextNode(src.nodeValue ?? '') // text
  if (src.nodeType !== 1) return null // comment 等は drop
  const el = src as Element
  const tag = el.tagName ? el.tagName.toUpperCase() : ''
  if (!SAFE_TAGS.has(tag)) return null // 非許可要素は subtree ごと drop
  const out = document.createElement(tag.toLowerCase())
  for (const attr of Array.from(el.attributes)) {
    const lname = attr.name.toLowerCase()
    let value = attr.value
    if (!attrAllowed(tag, lname)) continue
    if (lname === 'href' || lname === 'src') {
      if (!isHttpsAbsoluteUrl(value)) continue // runtime 同等の https 絶対 URL のみ
    } else if (lname === 'srcset') {
      continue // 複数 URL を含むため安全側で drop
    } else if (lname === 'style') {
      value = safeStyle(value)
      if (!value) continue
    }
    try {
      out.setAttribute(lname, value)
    } catch {
      /* 不正属性は skip */
    }
  }
  for (const child of Array.from(el.childNodes)) {
    const clean = sanitizeNode(child)
    if (clean) out.appendChild(clean)
  }
  return out
}

/**
 * 信頼できない inline HTML を allowlist sanitize し、安全な HTML 文字列を返す。
 * DOMParser 不在環境では fail-closed で '' を返す。
 */
export function sanitizePreviewHtml(rawHtml: string): string {
  if (typeof rawHtml !== 'string' || rawHtml.length === 0) return ''
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString('<div id="__ugk_root">' + rawHtml + '</div>', 'text/html')
  } catch {
    return '' // parse 失敗 → 何も描画しない (fail-closed)
  }
  const root = doc.getElementById('__ugk_root')
  if (!root) return ''
  const out = document.createElement('div')
  for (const node of Array.from(root.childNodes)) {
    const clean = sanitizeNode(node)
    if (clean) out.appendChild(clean)
  }
  return out.innerHTML
}
