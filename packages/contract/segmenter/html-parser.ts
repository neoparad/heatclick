/**
 * UGOKI LINK v2 — Lightweight Zero-Dependency HTML5-Compatible Parser
 *
 * 生HTML文字列を、ブラウザ DOM (`Document` / `Element` / `Text`) と
 * 同一インターフェースの軽量ノードツリーに変換する。
 *
 * - 外部依存ゼロ (Browser / Worker / Node 共通動作)
 * - join-final.md R-5 準拠: scripting flag ON (`<noscript>` は生テキスト扱い)
 * - 省略終了タグ (`<p>`, `<li>`, `<tr>`, `<td>`, `<th>`, `<dt>`, `<dd>`, `<option>` 等) の HTML5 自動閉じ対応
 * - `<svg>` / `<math>` 内の自己閉じタグ対応
 * - 名前付き・10進・16進 HTML 文字実体参照のデコード
 */

// ---------------------------------------------------------------------------
// DOM-Compatible Minimal Read Interface
// ---------------------------------------------------------------------------

export interface SegNodeLike {
  readonly nodeType: number
  readonly nodeValue: string | null
  readonly childNodes: ArrayLike<SegNodeLike>
}

export interface SegElementLike extends SegNodeLike {
  readonly nodeType: 1
  readonly tagName: string
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
}

export interface SegTextLike extends SegNodeLike {
  readonly nodeType: 3
  readonly nodeValue: string
}

export interface SegDocumentLike extends SegNodeLike {
  readonly nodeType: 9
  readonly documentElement?: SegElementLike | null
  readonly head?: SegElementLike | null
  readonly body?: SegElementLike | null
}

// ---------------------------------------------------------------------------
// Concrete Lightweight DOM Node Implementations
// ---------------------------------------------------------------------------

export class LightTextNode implements SegTextLike {
  readonly nodeType = 3 as const
  readonly childNodes: readonly SegNodeLike[] = Object.freeze([])
  parentNode: LightElementNode | LightDocumentNode | null = null

  constructor(public nodeValue: string) {}
}

export class LightElementNode implements SegElementLike {
  readonly nodeType = 1 as const
  readonly nodeValue = null
  readonly tagName: string
  readonly childNodes: Array<LightElementNode | LightTextNode> = []
  private readonly attrs = new Map<string, string>()
  parentNode: LightElementNode | LightDocumentNode | null = null

  constructor(tagName: string, attrs?: Readonly<Record<string, string>>) {
    this.tagName = tagName.toUpperCase()
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        const lower = k.toLowerCase()
        if (!this.attrs.has(lower)) {
          this.attrs.set(lower, v)
        }
      }
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), value)
  }

  setAttributeIfAbsent(name: string, value: string): void {
    const lower = name.toLowerCase()
    if (!this.attrs.has(lower)) {
      this.attrs.set(lower, value)
    }
  }

  getAttribute(name: string): string | null {
    const val = this.attrs.get(name.toLowerCase())
    return val === undefined ? null : val
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase())
  }

  appendChild<T extends LightElementNode | LightTextNode>(child: T): T {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
}

export class LightDocumentNode implements SegDocumentLike {
  readonly nodeType = 9 as const
  readonly nodeValue = null
  readonly childNodes: Array<LightElementNode | LightTextNode> = []

  get documentElement(): LightElementNode | null {
    for (const c of this.childNodes) {
      if (c.nodeType === 1 && c.tagName === 'HTML') return c
    }
    for (const c of this.childNodes) {
      if (c.nodeType === 1) return c
    }
    return null
  }

  get head(): LightElementNode | null {
    const html = this.documentElement
    if (!html) return null
    for (const c of html.childNodes) {
      if (c.nodeType === 1 && c.tagName === 'HEAD') return c
    }
    return null
  }

  get body(): LightElementNode | null {
    const html = this.documentElement
    if (!html) return null
    for (const c of html.childNodes) {
      if (c.nodeType === 1 && c.tagName === 'BODY') return c
    }
    return null
  }

  appendChild<T extends LightElementNode | LightTextNode>(child: T): T {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
}

// ---------------------------------------------------------------------------
// HTML Entity Decoding
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '\u00ad',
  copy: '©',
  reg: '®',
  trade: '™',
  yen: '¥',
  euro: '€',
  pound: '£',
  cent: '¢',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  middot: '·',
  bull: '•',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
  sect: '§',
  para: '¶',
  hearts: '♥',
  spades: '♠',
  clubs: '♣',
  diams: '♦',
  starf: '★',
  star: '☆',
  check: '✓',
  cross: '✗',
}

// HTML5 Windows-1252 remapping table for numeric char refs 0x80..0x9F
const WIN1252_REMAP: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
}

export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (full, hex?: string, dec?: string, named?: string) => {
    if (hex !== undefined || dec !== undefined) {
      let cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10)
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return '\uFFFD'
      }
      if (cp in WIN1252_REMAP) {
        cp = WIN1252_REMAP[cp]
      }
      return String.fromCodePoint(cp)
    }
    if (named !== undefined) {
      const mapped = NAMED_ENTITIES[named] ?? NAMED_ENTITIES[named.toLowerCase()]
      if (mapped !== undefined) return mapped
    }
    return full
  })
}

// ---------------------------------------------------------------------------
// HTML5 Tag Classification Tables
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set([
  'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
  'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
])

const RAW_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'XMP'])
const RCDATA_TAGS = new Set(['TITLE', 'TEXTAREA'])
const FOREIGN_ROOT_TAGS = new Set(['SVG', 'MATH'])
const SVG_HTML_INTEGRATION_TAGS = new Set(['FOREIGNOBJECT', 'DESC', 'TITLE'])
const MATH_TEXT_INTEGRATION_TAGS = new Set(['MI', 'MO', 'MN', 'MS', 'MTEXT'])

const P_BUTTON_SCOPE_BOUNDARY_TAGS = new Set([
  'APPLET', 'BUTTON', 'CAPTION', 'HTML', 'MARQUEE', 'OBJECT', 'TABLE', 'TD', 'TEMPLATE', 'TH',
  'FOREIGNOBJECT', 'DESC', 'TITLE', 'ANNOTATION-XML', 'MI', 'MO', 'MN', 'MS', 'MTEXT', 'SVG', 'MATH',
])

const FOREIGN_HTML_BREAKOUT_TAGS = new Set([
  'B', 'BIG', 'BLOCKQUOTE', 'BODY', 'BR', 'CENTER', 'CODE', 'DD', 'DIV', 'DL', 'DT', 'EM',
  'EMBED', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEAD', 'HR', 'I', 'IMG', 'LI', 'LISTING',
  'MENU', 'META', 'NOBR', 'OL', 'P', 'PRE', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'STRIKE',
  'SUB', 'SUP', 'TABLE', 'TT', 'U', 'UL', 'VAR',
])

const P_CLOSERS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIALOG', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HGROUP', 'HR', 'MAIN', 'MENU', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
])

const TABLE_SECTION_TAGS = new Set(['THEAD', 'TBODY', 'TFOOT'])
const TABLE_CELL_TAGS = new Set(['TD', 'TH'])

// ---------------------------------------------------------------------------
// Parser Implementation
// ---------------------------------------------------------------------------

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
}

function isTagNameChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x3a // :
  )
}

interface StackEntry {
  readonly node: LightElementNode
  readonly ns: 'html' | 'svg' | 'math'
  readonly isHtmlIntegrationPoint: boolean
  readonly isMathTextIntegrationPoint: boolean
}

export function parseHtmlToDom(html: string): LightDocumentNode {
  const doc = new LightDocumentNode()
  const stack: StackEntry[] = []

  const currentParent = (): LightElementNode | LightDocumentNode =>
    stack.length > 0 ? stack[stack.length - 1].node : doc

  /**
   * Determines whether a child token under the current stack top is parsed in
   * SVG/MathML foreign content mode (`true`) vs HTML insertion mode (`false`).
   * Inside `<svg><foreignObject>` (or `<desc>`, `<title>`, MathML HTML/text integration points),
   * child elements return to HTML mode per WHATWG HTML5 §13.2.6.5!
   */
  const isInForeignInsertionContext = (childTagName?: string): boolean => {
    if (stack.length === 0) return false
    const top = stack[stack.length - 1]
    if (top.ns === 'html') return false
    if (top.isHtmlIntegrationPoint) return false
    if (top.isMathTextIntegrationPoint) {
      if (!childTagName) return false
      return childTagName === 'MGLYPH' || childTagName === 'MALIGNMARK'
    }
    return true
  }

  const isAdjustedCurrentNodeForeign = (): boolean =>
    stack.length > 0 && stack[stack.length - 1].ns !== 'html'

  const appendText = (text: string): void => {
    if (!text) return
    const parent = currentParent()
    const last = parent.childNodes[parent.childNodes.length - 1]
    if (last && last.nodeType === 3) {
      last.nodeValue += text
    } else {
      parent.appendChild(new LightTextNode(text))
    }
  }

  const popElement = (): void => {
    stack.pop()
  }

  const popIfTopIn = (tags: ReadonlySet<string>): void => {
    while (stack.length > 0 && tags.has(stack[stack.length - 1].node.tagName)) {
      popElement()
    }
  }

  const autoCloseBeforeStart = (tag: string): void => {
    if (isInForeignInsertionContext(tag)) return

    if (P_CLOSERS.has(tag)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        const t = entry.node.tagName
        if (t === 'P' && entry.ns === 'html') {
          while (stack.length > i) popElement()
          break
        }
        if (P_BUTTON_SCOPE_BOUNDARY_TAGS.has(t) || entry.ns !== 'html') {
          break
        }
      }
    }

    if (tag === 'LI') {
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        const t = entry.node.tagName
        if (entry.ns !== 'html') break
        if (t === 'LI') {
          while (stack.length > i) popElement()
          break
        }
        if (t === 'UL' || t === 'OL' || t === 'MENU') break
      }
    } else if (tag === 'DT' || tag === 'DD') {
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        const t = entry.node.tagName
        if (entry.ns !== 'html') break
        if (t === 'DT' || t === 'DD') {
          while (stack.length > i) popElement()
          break
        }
        if (t === 'DL') break
      }
    } else if (TABLE_CELL_TAGS.has(tag)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        const t = entry.node.tagName
        if (entry.ns !== 'html') break
        if (TABLE_CELL_TAGS.has(t)) {
          while (stack.length > i) popElement()
          break
        }
        if (t === 'TR' || t === 'TABLE' || TABLE_SECTION_TAGS.has(t)) break
      }
    } else if (tag === 'TR') {
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        const t = entry.node.tagName
        if (entry.ns !== 'html') break
        if (t === 'TR' || TABLE_CELL_TAGS.has(t)) {
          while (stack.length > i) popElement()
          if (t === 'TR') break
        } else if (t === 'TABLE' || TABLE_SECTION_TAGS.has(t)) {
          break
        }
      }
    } else if (TABLE_SECTION_TAGS.has(tag)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        const t = entry.node.tagName
        if (entry.ns !== 'html') break
        if (TABLE_SECTION_TAGS.has(t) || t === 'TR' || TABLE_CELL_TAGS.has(t)) {
          while (stack.length > i) popElement()
          if (TABLE_SECTION_TAGS.has(t)) break
        } else if (t === 'TABLE') {
          break
        }
      }
    } else if (tag === 'OPTION') {
      popIfTopIn(new Set(['OPTION']))
    } else if (tag === 'OPTGROUP') {
      popIfTopIn(new Set(['OPTION', 'OPTGROUP']))
    } else if (tag === 'BODY') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].ns !== 'html') break
        if (stack[i].node.tagName === 'HEAD') {
          while (stack.length > i) popElement()
          break
        }
      }
    }
  }

  const len = html.length
  let pos = 0

  while (pos < len) {
    const ltIdx = html.indexOf('<', pos)
    if (ltIdx === -1) {
      appendText(decodeHtmlEntities(html.slice(pos)))
      break
    }
    if (ltIdx > pos) {
      appendText(decodeHtmlEntities(html.slice(pos, ltIdx)))
      pos = ltIdx
    }

    // Comment <!-- ... -->
    if (html.startsWith('<!--', pos)) {
      const endComment = html.indexOf('-->', pos + 4)
      pos = endComment === -1 ? len : endComment + 3
      continue
    }

    // CDATA section <![CDATA[ ... ]]> in foreign content (SVG / MathML, WHATWG HTML5 §13.2.5.42)
    if (isAdjustedCurrentNodeForeign() && html.slice(pos, pos + 9).toUpperCase() === '<![CDATA[') {
      const endCdata = html.indexOf(']]>', pos + 9)
      if (endCdata === -1) {
        appendText(html.slice(pos + 9))
        pos = len
      } else {
        appendText(html.slice(pos + 9, endCdata))
        pos = endCdata + 3
      }
      continue
    }

    // DOCTYPE / bogus comment <! ... > or processing instruction <? ... >
    if (pos + 1 < len && (html[pos + 1] === '!' || html[pos + 1] === '?')) {
      const gtIdx = html.indexOf('>', pos + 2)
      pos = gtIdx === -1 ? len : gtIdx + 1
      continue
    }

    // End tag </name ... >
    if (pos + 1 < len && html[pos + 1] === '/') {
      let cur = pos + 2
      while (cur < len && isAsciiWhitespace(html.charCodeAt(cur))) cur++
      const nameStart = cur
      while (cur < len && isTagNameChar(html.charCodeAt(cur))) cur++
      const closeTag = html.slice(nameStart, cur).toUpperCase()
      const gtIdx = html.indexOf('>', cur)
      pos = gtIdx === -1 ? len : gtIdx + 1

      if (closeTag) {
        // Find matching open tag in stack
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].node.tagName === closeTag) {
            while (stack.length > i) {
              popElement()
            }
            break
          }
        }
      }
      continue
    }

    // Start tag <name ... >
    if (pos + 1 < len && ((html.charCodeAt(pos + 1) >= 0x41 && html.charCodeAt(pos + 1) <= 0x5a) || (html.charCodeAt(pos + 1) >= 0x61 && html.charCodeAt(pos + 1) <= 0x7a))) {
      let cur = pos + 1
      const nameStart = cur
      while (cur < len && isTagNameChar(html.charCodeAt(cur))) cur++
      const tagName = html.slice(nameStart, cur).toUpperCase()

      const el = new LightElementNode(tagName)
      let selfClosing = false

      // Parse attributes
      while (cur < len) {
        while (cur < len && isAsciiWhitespace(html.charCodeAt(cur))) cur++
        if (cur >= len) break
        const ch = html[cur]
        if (ch === '>') {
          cur++
          break
        }
        if (ch === '/' && cur + 1 < len && html[cur + 1] === '>') {
          selfClosing = true
          cur += 2
          break
        }
        if (ch === '/') {
          cur++
          continue
        }

        // Attribute name
        const attrStart = cur
        while (cur < len) {
          const c = html.charCodeAt(cur)
          if (isAsciiWhitespace(c) || c === 0x3d /* = */ || c === 0x3e /* > */ || c === 0x2f /* / */) {
            break
          }
          cur++
        }
        const attrName = html.slice(attrStart, cur).toLowerCase()
        while (cur < len && isAsciiWhitespace(html.charCodeAt(cur))) cur++

        let attrVal = ''
        if (cur < len && html[cur] === '=') {
          cur++
          while (cur < len && isAsciiWhitespace(html.charCodeAt(cur))) cur++
          if (cur < len && (html[cur] === '"' || html[cur] === "'")) {
            const quote = html[cur]
            cur++
            const valStart = cur
            const endQuote = html.indexOf(quote, cur)
            if (endQuote === -1) {
              attrVal = decodeHtmlEntities(html.slice(valStart))
              cur = len
            } else {
              attrVal = decodeHtmlEntities(html.slice(valStart, endQuote))
              cur = endQuote + 1
            }
          } else {
            const valStart = cur
            while (cur < len) {
              const c = html.charCodeAt(cur)
              if (isAsciiWhitespace(c) || c === 0x3e /* > */) break
              cur++
            }
            attrVal = decodeHtmlEntities(html.slice(valStart, cur))
          }
        }
        if (attrName) {
          el.setAttributeIfAbsent(attrName, attrVal)
        }
      }

      pos = cur

      // HTML5 §13.2.6.5 foreign-content breakout: if currently inside foreign content (NOT inside
      // `<foreignObject>` / `<desc>` / `<title>`), HTML breakout start tags pop foreign elements
      // back to the nearest HTML element or integration point!
      if (isInForeignInsertionContext(tagName)) {
        const isFontBreakout =
          tagName === 'FONT' &&
          (el.hasAttribute('color') || el.hasAttribute('face') || el.hasAttribute('size'))
        if (FOREIGN_HTML_BREAKOUT_TAGS.has(tagName) || isFontBreakout) {
          while (stack.length > 0) {
            const top = stack[stack.length - 1]
            if (top.ns === 'html' || top.isHtmlIntegrationPoint || top.isMathTextIntegrationPoint) {
              break
            }
            popElement()
          }
        }
      }

      const inForeign = isInForeignInsertionContext(tagName)
      autoCloseBeforeStart(tagName)
      currentParent().appendChild(el)

      const elementNs: 'html' | 'svg' | 'math' = inForeign
        ? stack[stack.length - 1].ns
        : tagName === 'SVG'
          ? 'svg'
          : tagName === 'MATH'
            ? 'math'
            : 'html'

      const isForeignSelfClose = (inForeign || FOREIGN_ROOT_TAGS.has(tagName)) && selfClosing
      if ((!inForeign && VOID_TAGS.has(tagName)) || isForeignSelfClose) {
        continue
      }

      // Raw text or RCDATA elements in HTML insertion mode (including inside `<svg><foreignObject>`!):
      // consume verbatim until matching `</tagName>`
      if (!inForeign && (RAW_TEXT_TAGS.has(tagName) || RCDATA_TAGS.has(tagName))) {
        const closeRe = new RegExp(`</${tagName}(?:[\\t\\n\\f\\r /][^>]*)?>`, 'i')
        const rest = html.slice(pos)
        const match = closeRe.exec(rest)
        const rawInner = match ? rest.slice(0, match.index) : rest
        const textVal = RCDATA_TAGS.has(tagName) ? decodeHtmlEntities(rawInner) : rawInner
        if (textVal.length > 0) {
          el.appendChild(new LightTextNode(textVal))
        }
        pos = match ? pos + match.index + match[0].length : len
        continue
      }

      const encodingLower = (el.getAttribute('encoding') ?? '').trim().toLowerCase()
      const isHtmlIntegrationPoint =
        (elementNs === 'svg' && SVG_HTML_INTEGRATION_TAGS.has(tagName)) ||
        (elementNs === 'math' &&
          tagName === 'ANNOTATION-XML' &&
          (encodingLower === 'text/html' || encodingLower === 'application/xhtml+xml'))
      const isMathTextIntegrationPoint =
        elementNs === 'math' && MATH_TEXT_INTEGRATION_TAGS.has(tagName)

      stack.push({
        node: el,
        ns: elementNs,
        isHtmlIntegrationPoint,
        isMathTextIntegrationPoint,
      })
      continue
    }

    // Stray `<` that is not a valid tag -> treat as literal text
    appendText('<')
    pos++
  }

  // Normalize fragment without <html> / <body> into standard document structure
  if (!doc.documentElement || doc.documentElement.tagName !== 'HTML') {
    const htmlEl = new LightElementNode('HTML')
    const headEl = new LightElementNode('HEAD')
    const bodyEl = new LightElementNode('BODY')
    const existingChildren = [...doc.childNodes]
    doc.childNodes.length = 0
    for (const child of existingChildren) {
      if (child.nodeType === 1 && child.tagName === 'HEAD') {
        for (const hc of child.childNodes) headEl.appendChild(hc)
      } else if (child.nodeType === 1 && child.tagName === 'BODY') {
        for (const bc of child.childNodes) bodyEl.appendChild(bc)
      } else {
        bodyEl.appendChild(child)
      }
    }
    htmlEl.appendChild(headEl)
    htmlEl.appendChild(bodyEl)
    doc.appendChild(htmlEl)
  }

  return doc
}
