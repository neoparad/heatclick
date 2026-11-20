import {
  DEFAULT_PRUNE_REGISTRY,
  NORM_PROBE_EXPECTED_NORM,
  NORM_PROBE_STRING,
  SEGMENTER_CONTENT_HASH,
  SEGMENTER_RULE_REVISIONS,
  computeImageKey,
  computeSegmenterContentHash,
  isGeneratedLookingId,
  normText,
  segmentDocument,
  segmentHtml,
  verifyNormProbe,
  type OriginalNodeValues,
  type SegDocumentLike,
  type SegElementLike,
  type SegNodeLike,
  type SegTextLike,
  type SegmentOptions,
} from './index'

// ---------------------------------------------------------------------------
// Independent Browser-Like DOM Builder (completely independent of parseHtmlToDom)
// ---------------------------------------------------------------------------

class IndependentDomText implements SegTextLike {
  readonly nodeType = 3 as const
  readonly childNodes: readonly SegNodeLike[] = []
  constructor(public readonly nodeValue: string) {}
}

class IndependentDomElement implements SegElementLike {
  readonly nodeType = 1 as const
  readonly nodeValue = null
  readonly tagName: string
  readonly childNodes: Array<IndependentDomElement | IndependentDomText> = []
  private readonly attrMap = new Map<string, string>()

  constructor(tag: string, attrs?: Readonly<Record<string, string>>) {
    this.tagName = tag.toUpperCase()
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        this.attrMap.set(k.toLowerCase(), v)
      }
    }
  }

  getAttribute(name: string): string | null {
    const val = this.attrMap.get(name.toLowerCase())
    return val === undefined ? null : val
  }

  hasAttribute(name: string): boolean {
    return this.attrMap.has(name.toLowerCase())
  }

  append(node: IndependentDomElement | IndependentDomText): void {
    this.childNodes.push(node)
  }
}

class IndependentDomDocument implements SegDocumentLike {
  readonly nodeType = 9 as const
  readonly nodeValue = null
  readonly childNodes: IndependentDomElement[] = []
  readonly documentElement: IndependentDomElement
  readonly head: IndependentDomElement
  readonly body: IndependentDomElement

  constructor(head: IndependentDomElement, body: IndependentDomElement) {
    this.head = head
    this.body = body
    const html = new IndependentDomElement('html')
    html.append(head)
    html.append(body)
    this.documentElement = html
    this.childNodes.push(html)
  }
}

// ---------------------------------------------------------------------------
// Declarative Blueprint -> (A) Raw HTML Serializer & (B) Independent DOM Tree
// ---------------------------------------------------------------------------

interface BlueprintNode {
  readonly tag?: string
  readonly attrs?: Readonly<Record<string, string>>
  readonly children?: readonly (BlueprintNode | string)[]
  /** If true, serialize children as raw text (for <script>, <style>, <noscript>) */
  readonly raw?: boolean
  /** If true, omit closing tag in HTML serialization to exercise HTML5 auto-close */
  readonly omitEndTag?: boolean
}

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const FOREIGN_SELF_CLOSE_TAGS = new Set(['path', 'circle', 'rect', 'line'])

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;')
}

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function serializeBlueprintToHtml(node: BlueprintNode | string, indent = 0): string {
  if (typeof node === 'string') {
    return escapeHtmlText(node)
  }
  const tag = (node.tag ?? 'div').toLowerCase()
  let attrStr = ''
  if (node.attrs) {
    for (const [k, v] of Object.entries(node.attrs)) {
      if (v === '' && (k === 'hidden' || k === 'disabled' || k === 'data-ugk' || k === 'data-ugk-root' || k === 'data-ugk-private')) {
        attrStr += ` ${k}`
      } else {
        attrStr += ` ${k}="${escapeHtmlAttr(v)}"`
      }
    }
  }

  if (VOID_HTML_TAGS.has(tag)) {
    return `<${tag}${attrStr}>`
  }
  if (FOREIGN_SELF_CLOSE_TAGS.has(tag) && (!node.children || node.children.length === 0)) {
    return `<${tag}${attrStr} />`
  }

  const children = node.children ?? []
  const inner = node.raw
    ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
    : children.map((c) => serializeBlueprintToHtml(c, indent + 1)).join('')

  if (node.omitEndTag) {
    return `<${tag}${attrStr}>${inner}`
  }
  return `<${tag}${attrStr}>${inner}</${tag}>`
}

function buildIndependentDomNode(node: BlueprintNode | string): IndependentDomElement | IndependentDomText {
  if (typeof node === 'string') {
    return new IndependentDomText(node)
  }
  const el = new IndependentDomElement(node.tag ?? 'div', node.attrs)
  for (const child of node.children ?? []) {
    el.append(buildIndependentDomNode(child))
  }
  return el
}

interface PageFixture {
  readonly id: string
  readonly site: string
  readonly archetype: string
  readonly headChildren: readonly BlueprintNode[]
  readonly bodyChildren: readonly (BlueprintNode | string)[]
  readonly options?: SegmentOptions
}

function materializeFixture(fixture: PageFixture): {
  readonly rawHtml: string
  readonly domDoc: IndependentDomDocument
} {
  const headEl = new IndependentDomElement('head')
  for (const hc of fixture.headChildren) {
    headEl.append(buildIndependentDomNode(hc))
  }
  const bodyEl = new IndependentDomElement('body')
  for (const bc of fixture.bodyChildren) {
    bodyEl.append(buildIndependentDomNode(bc))
  }
  const domDoc = new IndependentDomDocument(headEl, bodyEl)

  const headHtml = fixture.headChildren.map((c) => serializeBlueprintToHtml(c)).join('\n    ')
  const bodyHtml = fixture.bodyChildren.map((c) => serializeBlueprintToHtml(c)).join('\n    ')
  const rawHtml = `<!DOCTYPE html>
<!-- Fixture ${fixture.id} (${fixture.archetype}) -->
<html lang="ja">
  <head>
    ${headHtml}
  </head>
  <body>
    ${bodyHtml}
  </body>
</html>`

  return { rawHtml, domDoc }
}

// ---------------------------------------------------------------------------
// 220 Fixed Test Fixtures (>= 200 across 5 sites & 8 archetypes — Gate join.G1)
// ---------------------------------------------------------------------------

const SITES = ['bihadashop.jp', 'kirei-lab.jp', 'ec-compare.jp', 'clinic-guide.jp', 'lp-studio.jp'] as const

function el(
  tag: string,
  attrs?: Readonly<Record<string, string>>,
  children?: readonly (BlueprintNode | string)[],
  extra?: { readonly raw?: boolean; readonly omitEndTag?: boolean },
): BlueprintNode {
  return { tag, attrs, children, ...extra }
}

function makeStandardHead(site: string, idx: number, extraHead: readonly BlueprintNode[] = []): BlueprintNode[] {
  return [
    el('meta', { charset: 'utf-8' }),
    el('title', undefined, [`ページ ${idx} | ${site}`]),
    el('meta', { name: 'description', content: `テスト説明文 ${idx} — 美肌・比較・解説` }),
    el('link', { rel: 'canonical', href: `https://${site}/page-${idx}` }),
    el('link', { rel: 'alternate', hreflang: 'ja', href: `https://${site}/page-${idx}` }),
    el('link', { rel: 'stylesheet', href: `/assets/main.css?v=${(idx % 5) + 1}` }),
    el('script', { src: `/assets/app.js?ver=${(idx % 7) + 1}` }, [], { raw: true }),
    el('style', undefined, [`.card-${idx} { margin: ${(idx % 4) * 4}px; }`], { raw: true }),
    el(
      'script',
      { type: 'application/ld+json' },
      [
        JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: `記事タイトル ${idx}`,
          dateModified: `2026-11-${String((idx % 20) + 1).padStart(2, '0')}T00:00:00Z`,
        }),
      ],
      { raw: true },
    ),
    ...extraHead,
  ]
}

function makeChromeHeaderFooter(site: string, idx: number): { header: BlueprintNode; footer: BlueprintNode } {
  return {
    header: el('header', { class: `hdr-${idx}` }, [
      el('a', { href: `https://${site}/` }, ['ホーム']),
      el('a', { href: `https://${site}/ranking` }, ['ランキング']),
    ]),
    footer: el('footer', { class: `ftr-${idx}` }, [
      el('a', { href: `https://${site}/privacy` }, ['プライバシーポリシー']),
      el('a', { href: `https://${site}/contact` }, ['お問い合わせ']),
    ]),
  }
}

function build220FixedFixtures(): PageFixture[] {
  const fixtures: PageFixture[] = []
  let seq = 1
  const nextId = (): string => `F${String(seq++).padStart(3, '0')}`
  const siteAt = (n: number): string => SITES[n % SITES.length]

  // 1. Articles (45 pages)
  for (let i = 0; i < 45; i++) {
    const site = siteAt(i)
    const { header, footer } = makeChromeHeaderFooter(site, i)
    const kanaVariant = i % 3 === 0 ? 'ｶﾞｲﾄﾞ' : i % 3 === 1 ? 'ガイド' : 'カ\u3099イト\u3099'
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'article',
      headChildren: makeStandardHead(site, i + 1, [
        el('meta', { property: 'article:modified_time', content: '2026-11-19T09:00:00Z' }),
      ]),
      bodyChildren: [
        header,
        el('main', undefined, [
          el('article', { class: `post-wrap-${i}` }, [
            el('h1', undefined, [`スキンケア完全${kanaVariant} #${i + 1}`]),
            el('p', undefined, [`導入文です。乾燥肌・敏感肌に向けた実践ポイント (${i + 1}) & 解説。`]),
            el('h2', undefined, [`基本のステップ ${i + 1}`, el('br'), '朝のケア']),
            el('p', undefined, ['洗顔後すぐに化粧水をなじませます。ＡＢＣ１２３　テスト。']),
            el('ul', undefined, [
              el('li', undefined, ['低刺激の洗顔料を使う']),
              el('li', undefined, ['保湿成分セラミドを補う']),
              el('li', undefined, ['日焼け止めで紫外線を防ぐ']),
            ]),
            el('h3', undefined, [`化粧水の選び方 (${i + 1})`]),
            el('figure', undefined, [
              el('img', {
                'data-lazy-src': `https://${site}/img/lotion-${i}-800x600.webp?w=800`,
                src: `https://${site}/img/placeholder.gif`,
                alt: `化粧水比較写真 ${i + 1}`,
              }),
              el('figcaption', undefined, [`おすすめ化粧水 ${i + 1}`]),
            ]),
            el('p', undefined, [
              '詳しくは ',
              el('a', { href: `https://${site}/detail/${i}?utm_source=blog&id=${i}` }, ['成分ガイドを見る']),
              ' を確認してください。',
            ]),
            el('h2', undefined, ['よくある疑問とまとめ']),
            el('blockquote', undefined, ['毎日の積み重ねが肌バリアを整えます。']),
          ]),
        ]),
        footer,
      ],
      options: { url: `https://${site}/articles/${i + 1}` },
    })
  }

  // 2. Landing Pages / LP (30 pages)
  for (let i = 0; i < 30; i++) {
    const site = siteAt(i)
    const { header, footer } = makeChromeHeaderFooter(site, 100 + i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'lp',
      headChildren: makeStandardHead(site, 100 + i),
      bodyChildren: [
        header,
        el('main', { 'data-ugk-root': '' }, [
          el('section', { 'data-ugk-section': `hero-${i}` }, [
            el('h2', undefined, [`初回限定トライアル ${i + 1}`]),
            el('p', undefined, ['今なら送料無料・30日間返金保証付きでお試しいただけます。']),
            el('a', { href: `https://${site}/order/trial-${i}?gclid=test` }, ['今すぐ申し込む']),
          ]),
          el('section', { 'data-ugk-section': `features-${i}` }, [
            el('h2', undefined, ['選ばれる3つの理由']),
            el('ol', undefined, [
              el('li', undefined, ['皮膚科医監修の処方']),
              el('li', undefined, ['無添加・アルコールフリー']),
              el('li', undefined, ['国内工場での徹底品質管理']),
            ]),
            el('iframe', { src: `https://www.youtube.com/embed/vid_${i}?rel=0`, title: '紹介動画' }),
          ]),
          el('h2', undefined, ['無料カウンセリング予約']),
          el('form', { action: `/api/reserve-${i}`, method: 'POST', id: `react-form-${9000 + i}` }, [
            el('label', { for: `uid-email-${i}` }, ['メールアドレス']),
            el('input', { type: 'email', id: `uid-email-${i}`, name: 'email', autocomplete: 'email' }),
            el('label', { for: `uid-plan-${i}` }, ['希望コース']),
            el('select', { id: `uid-plan-${i}`, name: 'plan' }, [
              el('option', { value: 'basic' }, ['ベーシック']),
              el('option', { value: 'pro' }, ['プレミアム']),
            ]),
            el('button', { type: 'submit', class: `btn-cta-${i}` }, ['予約を確定する']),
          ]),
          // UGOKI inserted recommendation slot -> excluded from sections, hashed in slot_fp!
          el('div', { 'data-ugk-slot': `lp-rec-${i}` }, [
            el('p', undefined, [`関連おすすめ ${i}`]),
            el('a', { href: `https://${site}/rec/${i}` }, ['おすすめを見る']),
          ]),
        ]),
        footer,
      ],
      options: { url: `https://${site}/lp/${i + 1}` },
    })
  }

  // 3. E-Commerce Product Pages / EC (30 pages)
  for (let i = 0; i < 30; i++) {
    const site = siteAt(i)
    const { header, footer } = makeChromeHeaderFooter(site, 200 + i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'ec',
      headChildren: makeStandardHead(site, 200 + i),
      bodyChildren: [
        header,
        el('main', undefined, [
          el('h1', undefined, [`モイスチャーセラム Pro #${i + 1}`]),
          el('figure', undefined, [
            el('img', {
              srcset: `/images/prod-${i}-400x400.jpg 400w, /images/prod-${i}-1200x1200.jpg 1200w`,
              src: `/images/prod-${i}@2x.jpg`,
              alt: `商品パッケージ ${i + 1}`,
            }),
          ]),
          el('h2', undefined, ['商品スペック']),
          el('table', undefined, [
            el('thead', undefined, [
              el('tr', undefined, [el('th', undefined, ['項目']), el('th', undefined, ['内容'])]),
            ]),
            el('tbody', undefined, [
              el('tr', undefined, [el('td', undefined, ['容量']), el('td', undefined, [`${30 + i}ml`])]),
              el('tr', undefined, [el('td', undefined, ['価格']), el('td', undefined, [`¥${3000 + i * 100}`])]),
            ]),
          ]),
          el('h2', undefined, ['購入リンク']),
          el('p', undefined, [
            el('a', { href: `https://px.a8.net/svt/ejp?a8mat=TEST${i}&utm_medium=aff` }, ['公式サイトで購入']),
            ' / ',
            el('a', { href: `https://hb.afl.rakuten.co.jp/hgc/item-${i}` }, ['楽天で見る']),
          ]),
          el('h2', undefined, ['購入者レビュー']),
          el('ul', undefined, [
            el('li', undefined, [`★5 べたつかずしっとりします (${i + 1})`]),
            el('li', undefined, ['★4 敏感肌でも使えました']),
          ]),
        ]),
        footer,
      ],
      options: { url: `https://${site}/products/serum-${i + 1}` },
    })
  }

  // 4. Comparison Table Pages (25 pages)
  for (let i = 0; i < 25; i++) {
    const site = siteAt(i)
    const { header, footer } = makeChromeHeaderFooter(site, 300 + i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'comparison',
      headChildren: makeStandardHead(site, 300 + i),
      bodyChildren: [
        header,
        el('article', undefined, [
          el('h1', undefined, [`人気コスメ徹底比較ランキング 2026 (${i + 1})`]),
          el('h2', undefined, ['一覧比較表']),
          el('table', undefined, [
            el('thead', undefined, [
              el('tr', undefined, [
                el('th', undefined, ['商品名']),
                el('th', undefined, ['月額']),
                el('th', undefined, ['保湿力']),
                el('th', undefined, ['公式']),
              ]),
            ]),
            el('tbody', undefined, [
              el('tr', undefined, [
                el('td', undefined, [`ブランドA-${i}`]),
                el('td', undefined, ['¥2,980']),
                el('td', undefined, ['◎']),
                el('td', undefined, [el('a', { href: `https://${site}/go/a-${i}` }, ['公式サイトを見る'])]),
              ]),
              el('tr', undefined, [
                el('td', undefined, [`ブランドB-${i}`]),
                el('td', undefined, ['¥3,480']),
                el('td', undefined, ['○']),
                el('td', undefined, [el('a', { href: `https://${site}/go/b-${i}` }, ['公式サイトを見る'])]),
              ]),
            ]),
          ]),
          el('h2', undefined, ['各商品の詳細解説']),
          el('h3', undefined, [`1位: ブランドA-${i}`]),
          el('p', undefined, ['高濃度セラミド配合でコスパ抜群。']),
          el('h3', undefined, [`2位: ブランドB-${i}`]),
          el('p', undefined, ['さっぱりした使用感で夏場にも最適。']),
        ]),
        el('aside', { 'data-ugk-chrome': '' }, [
          el('a', { href: `https://${site}/sidebar/top` }, ['人気記事TOP10']),
        ]),
        footer,
      ],
      options: { url: `https://${site}/compare/${i + 1}` },
    })
  }

  // 5. Heading-less (block_fallback: 15), h4-only (5), depth_band (5) = 25 pages
  for (let i = 0; i < 15; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'no-heading-block-fallback',
      headChildren: makeStandardHead(site, 400 + i),
      bodyChildren: [
        el('main', undefined, [
          el('p', undefined, [`見出しのない本文ブロック1 (${i + 1}): 冒頭80文字で安定した照合キーが生成されます。テスト文章を十分長く記述しています。`]),
          el('p', undefined, [`見出しのない本文ブロック2 (${i + 1}): 2番目の段落では別のトピックについて説明しています。`]),
          el('ul', undefined, [
            el('li', undefined, [`箇条書き項目A-${i}`]),
            el('li', undefined, [`箇条書き項目B-${i}`]),
          ]),
          el('figure', undefined, [el('img', { src: `/img/nohead-${i}-scaled.png`, alt: `図解 ${i}` })]),
        ]),
      ],
      options: { url: `https://${site}/notes/${i + 1}` },
    })
  }
  for (let i = 0; i < 5; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'h4-only-fallback',
      headChildren: makeStandardHead(site, 420 + i),
      bodyChildren: [
        el('article', undefined, [
          el('h4', undefined, [`小見出しA-${i}`]),
          el('p', undefined, [`h2/h3が存在しない場合のみh4がアンカーになります (${i})。`]),
          el('h4', undefined, [`小見出しB-${i}`]),
          el('p', undefined, [`2つ目のh4セクション本文 (${i})。`]),
        ]),
      ],
      options: { url: `https://${site}/h4-only/${i + 1}` },
    })
  }
  for (let i = 0; i < 5; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'depth-band-fallback',
      headChildren: makeStandardHead(site, 430 + i),
      bodyChildren: [
        el('main', undefined, [
          el('div', { class: `canvas-stage-${i}` }, [el('canvas', { width: '800', height: '600' })]),
        ]),
      ],
      options: { url: `https://${site}/interactive/${i + 1}` },
    })
  }

  // 6. Ad / Consent Banner / Chat / Comment / Related Post Mixed (25 pages)
  for (let i = 0; i < 25; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'mixed-pruned-widgets',
      headChildren: makeStandardHead(site, 500 + i),
      bodyChildren: [
        el('div', { id: 'onetrust-consent-sdk' }, [
          el('h2', undefined, ['Cookie の使用について']),
          el('p', undefined, ['同意バナーは除外されます']),
          el('button', undefined, ['すべて同意']),
        ]),
        el('div', { id: 'intercom-container', class: 'chat-widget' }, [
          el('p', undefined, ['チャットサポートはこちら']),
        ]),
        el('article', undefined, [
          el('h2', undefined, [`本編セクション1 (${i + 1})`]),
          el('p', undefined, [`ノイズ要素に囲まれた純粋な本文テキスト ${i + 1}。`]),
          el('ins', { class: 'adsbygoogle', 'data-ad-client': 'ca-pub-1234', 'data-ad-slot': `slot-${i}` }, [
            el('p', undefined, ['広告テキスト']),
          ]),
          el('div', { 'data-ugk-private': '' }, [
            el('p', undefined, ['非公開会員情報 — 絶対に読まない']),
          ]),
          el('div', { role: 'dialog' }, [el('h2', undefined, ['モーダルダイアログ'])]),
          el('div', { contenteditable: 'true' }, [el('p', undefined, ['編集可能メモ'])]),
          el('noscript', undefined, ['<h2>JavaScript無効時の見出し</h2><p>無視される</p>'], { raw: true }),
          el('h2', undefined, [`本編セクション2 (${i + 1})`]),
          el('p', undefined, [`2つ目の純粋な本文 ${i + 1}。`]),
          el('section', { id: 'comments', class: 'comments-area' }, [
            el('h2', undefined, ['コメント欄']),
            el('p', undefined, ['読者コメント']),
          ]),
          el('aside', { id: 'related-posts', 'aria-label': '関連記事' }, [
            el('h2', undefined, ['関連記事']),
            el('a', { href: '/rel-1' }, ['関連記事1']),
          ]),
        ]),
      ],
      options: { url: `https://${site}/noisy/${i + 1}` },
    })
  }

  // 7. Experiment Rewrites with `data-ugk-orig-*` (20 pages)
  for (let i = 0; i < 20; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'experiment-rewrite',
      headChildren: makeStandardHead(site, 600 + i),
      bodyChildren: [
        el('article', undefined, [
          el(
            'h2',
            { 'data-ugk-orig-text': `オリジナル見出し ${i + 1}` },
            [`ABテスト書き換え後の見出しB案 ${i + 1}`],
          ),
          el(
            'p',
            { 'data-ugk-orig-text': `オリジナル本文テキスト ${i + 1}。` },
            [`書き換え後テキスト ${i + 1}！今だけ特別価格！`],
          ),
          el('p', { hidden: '', 'data-ugk-orig-hidden': 'false' }, [`実験で非表示にした元の段落 ${i + 1}`]),
          el('p', undefined, [
            el(
              'a',
              {
                href: `https://${site}/offer-variant-b-${i}`,
                'data-ugk-orig-href': `https://${site}/offer-control-${i}`,
                'data-ugk-orig-text': '詳しく見る',
              },
              ['今すぐ限定オファーを受け取る！'],
            ),
          ]),
          el('figure', undefined, [
            el('img', {
              src: `/img/hero-${i}.jpg`,
              alt: '書き換え後ALT',
              'data-ugk-orig-alt': `元のALT ${i}`,
            }),
          ]),
          // Runtime-injected overlay -> completely pruned
          el('div', { 'data-ugk': '', class: 'ugk-popup' }, [
            el('h2', undefined, ['ポップアップ見出し']),
            el('p', undefined, ['実験オーバーレイ']),
          ]),
        ]),
      ],
      options: { url: `https://${site}/exp/${i + 1}` },
    })
  }

  // 8. Duplicate Headings, Private Scope, Malformed Optional End Tags & SVG (20 pages)
  for (let i = 0; i < 10; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'duplicate-headings',
      headChildren: makeStandardHead(site, 700 + i),
      bodyChildren: [
        el('article', undefined, [
          el('h2', undefined, ['特徴']),
          el('h3', undefined, ['メリット']),
          el('p', undefined, [`特徴側のメリット説明 ${i}`]),
          el('h3', undefined, ['メリット']),
          el('p', undefined, [`同一親h2配下の重複h3 (${i})`]),
          el('h2', undefined, ['まとめ']),
          el('h3', undefined, ['メリット']),
          el('p', undefined, [`別親h2配下の同名h3はctxが異なる (${i})`]),
          el('h2', undefined, ['まとめ']),
          el('p', undefined, [`重複したまとめ見出し2回目 (${i})`]),
        ]),
      ],
      options: { url: `https://${site}/dups/${i + 1}` },
    })
  }
  for (let i = 0; i < 5; i++) {
    const site = siteAt(i)
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'malformed-html-and-svg',
      headChildren: makeStandardHead(site, 720 + i),
      bodyChildren: [
        el('article', undefined, [
          el('h2', undefined, [`省略閉じタグ & SVG テスト ${i + 1}`]),
          el('p', undefined, [`閉じタグ省略段落1 (${i})`], { omitEndTag: true }),
          el('p', undefined, [`閉じタグ省略段落2 (${i})`], { omitEndTag: true }),
          el('ul', undefined, [
            el('li', undefined, [`省略LI-1 (${i})`], { omitEndTag: true }),
            el('li', undefined, [`省略LI-2 (${i})`], { omitEndTag: true }),
          ]),
          el('button', { type: 'button' }, [
            el('svg', { viewBox: '0 0 16 16' }, [el('path', { d: 'M0 0h16v16H0z' })]),
            `保存する ${i + 1}`,
          ]),
        ]),
      ],
      options: { url: `https://${site}/edge-html/${i + 1}` },
    })
  }
  for (let i = 0; i < 5; i++) {
    const site = siteAt(i)
    const isNoindex = i < 3
    fixtures.push({
      id: nextId(),
      site,
      archetype: 'private-scope',
      headChildren: makeStandardHead(
        site,
        730 + i,
        isNoindex ? [el('meta', { name: 'robots', content: 'noindex, nofollow' })] : [],
      ),
      bodyChildren: [
        el('main', undefined, [
          el('h2', undefined, ['会員専用マイページ']),
          el('p', undefined, ['個人向けアカウント情報']),
        ]),
      ],
      options: { url: isNoindex ? `https://${site}/draft/${i}` : `https://${site}/checkout/step-${i}` },
    })
  }

  return fixtures
}

const FIXTURES_220 = build220FixedFixtures()

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Bundle 1-D: Unified Segmenter Engine (packages/contract/segmenter — Gate join.G1)', () => {
  describe('Gate join.G1: 200+ Fixed Page Fixtures Raw HTML === DOM 100% Parity', () => {
    it('provides at least 200 fixed page fixtures (>= 40 per site across 5 sites)', () => {
      expect(FIXTURES_220.length).toBeGreaterThanOrEqual(200)
      const perSite = new Map<string, number>()
      for (const f of FIXTURES_220) {
        perSite.set(f.site, (perSite.get(f.site) ?? 0) + 1)
      }
      expect(perSite.size).toBe(5)
      for (const count of perSite.values()) {
        expect(count).toBeGreaterThanOrEqual(40)
      }
    })

    it.each(FIXTURES_220)(
      '[$id] ($site / $archetype) yields 100% byte-identical IDs between Raw HTML and DOM tree',
      (fixture) => {
        const { rawHtml, domDoc } = materializeFixture(fixture)
        const rawOut = segmentHtml(rawHtml, fixture.options)
        const domOut = segmentDocument(domDoc, fixture.options)

        expect(rawOut).toEqual(domOut)

        if (fixture.archetype === 'private-scope') {
          expect(rawOut.dom_state).toBe('private_scope')
          expect(rawOut.skel_fp).toBeNull()
          expect(rawOut.sections).toHaveLength(0)
        } else {
          expect(rawOut.dom_state).toBe('ok')
          expect(rawOut.segmenter_hash).toBe(SEGMENTER_CONTENT_HASH)
          expect(rawOut.segmenter_hash).toMatch(/^[0-9a-f]{64}$/)
          expect(rawOut.skel_fp).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.struct_fp).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.head_fp).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.css_fp).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.res_fp).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.slot_fp).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.links_fp!.root).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.links_fp!.chrome).toMatch(/^[0-9a-f]{16}$/)
          expect(rawOut.links_fp!.combined).toMatch(/^[0-9a-f]{32}$/)

          for (const sec of rawOut.sections) {
            expect(sec.sec_fp).toMatch(/^[0-9a-f]{12}$/)
            expect(sec.body_fp).toMatch(/^[0-9a-f]{8}$/)
            expect(sec.body_digest_128).toMatch(/^[0-9a-f]{32}$/)
            for (const blk of sec.blocks) {
              expect(blk.blk_fp).toMatch(/^[0-9a-f]{10}$/)
            }
          }
          for (const elem of rawOut.elements) {
            expect(elem.el_fp).toMatch(/^[0-9a-f]{12}$/)
            expect(elem.slot_id).toMatch(/^[0-9a-f]{12}$/)
          }
        }
      },
    )
  })

  describe('Core Invariants & Fingerprint Families (§6.1 / join-final.md M1 & A1)', () => {
    it('passes norm/1 table-driven normalization and self-test probe without String.normalize or Intl', () => {
      expect(verifyNormProbe()).toBe(true)
      expect(normText(NORM_PROBE_STRING)).toBe(NORM_PROBE_EXPECTED_NORM)
      expect(normText('  ｶﾞｷﾞｸﾞｹﾞｺﾞ ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ ｳﾞ  ')).toBe('ガギグゲゴ パピプペポ ヴ')
      expect(normText('か\u3099き\u3099 は\u309Aひ\u309A')).toBe('がぎ ぱぴ')
      expect(normText('ＦＵＬＬ－ＷＩＤＴＨ　１２３\u200B\u00AD')).toBe('full-width 123')
    })

    it('never depends on CSS class names or auto-generated IDs', () => {
      const htmlA = `<html><body><article class="article-v1 prose" id="wp-block-123456">
        <h2 class="title-lg" id="react-id-99">化粧水の選び方</h2>
        <p class="lead-text" id="uid_abcdef123456">セラミド配合の保湿化粧水がおすすめです。</p>
        <form id="form-99999" class="signup-v1">
          <label for="input-888888">メール</label>
          <input id="input-888888" name="email" type="email" class="inp-a" />
          <button id="btn-77777" class="btn-primary">送信する</button>
        </form>
        <a href="https://example.com/buy" class="cta-old" id="el-123456">詳細を見る</a>
      </article></body></html>`

      const htmlB = `<html><body><article class="tw-p-8 css-x9y8z7" id="radix-999999">
        <h2 class="text-2xl font-bold" id="r42">化粧水の選び方</h2>
        <p class="mt-4 text-gray-700" id="550e8400-e29b-41d4-a716-446655440000">セラミド配合の保湿化粧水がおすすめです。</p>
        <form id="mui-11111" class="tw-grid">
          <label for="r99">メール</label>
          <input id="r99" name="email" type="email" class="tw-border" />
          <button id="r100" class="tw-bg-blue-500">送信する</button>
        </form>
        <a href="https://example.com/buy" class="cta-new-2026" id="auto-99999">詳細を見る</a>
      </article></body></html>`

      const a = segmentHtml(htmlA)
      const b = segmentHtml(htmlB)

      expect(a.skel_fp).toBe(b.skel_fp)
      expect(a.struct_fp).toBe(b.struct_fp)
      expect(a.links_fp).toEqual(b.links_fp)
      expect(a.sections).toEqual(b.sections)
      expect(a.elements).toEqual(b.elements)
      expect(isGeneratedLookingId('react-id-99')).toBe(true)
      expect(isGeneratedLookingId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
      expect(isGeneratedLookingId('pricing-table')).toBe(false)
    })

    it('prunes consent banners, chat widgets, ads, comments, and related posts identically to clean page', () => {
      const cleanHtml = `<html><body><article>
        <h2>本編の見出し</h2>
        <p>純粋な記事本文のテキストです。</p>
      </article></body></html>`

      const noisyHtml = `<html><body>
        <div id="onetrust-consent-sdk"><h2>Cookie設定</h2><p>同意してください</p></div>
        <div id="intercom-container"><p>チャットで質問</p></div>
        <article>
          <h2>本編の見出し</h2>
          <ins class="adsbygoogle" data-ad-client="ca-pub-1"><p>スポンサー広告</p></ins>
          <p>純粋な記事本文のテキストです。</p>
          <div id="disqus_thread"><h2>コメント</h2><p>投稿テキスト</p></div>
          <aside id="related-posts"><h2>関連記事</h2><a href="/other">別記事</a></aside>
        </article>
      </body></html>`

      const clean = segmentHtml(cleanHtml)
      const noisy = segmentHtml(noisyHtml)

      expect(noisy.skel_fp).toBe(clean.skel_fp)
      expect(noisy.struct_fp).toBe(clean.struct_fp)
      expect(noisy.sections).toEqual(clean.sections)
      expect(noisy.links_fp).toEqual(clean.links_fp)
    })

    it('guarantees control invariance during LINK delivery experiments via data-ugk-orig-* and originalValueMap', () => {
      const controlHtml = `<html><head><link rel="stylesheet" href="/site.css?v=1"></head><body>
        <article>
          <h2>料金プランの比較</h2>
          <p>月額2,980円から始められます。</p>
          <p>30日間の返金保証つき。</p>
          <p><a href="https://shop.example/buy">今すぐ申し込む</a></p>
        </article>
      </body></html>`

      const variantHtml = `<html><head>
        <link rel="stylesheet" href="/site.css?v=1">
        <style data-ugk>.ugk-banner { color: red; }</style>
      </head><body>
        <article>
          <div data-ugk class="ugk-banner"><h2>限定キャンペーン！</h2><p>本日限り</p></div>
          <h2 data-ugk-orig-text="料金プランの比較">最安プランを徹底比較【2026年最新】</h2>
          <p data-ugk-orig-text="月額2,980円から始められます。">今だけ初月50%OFFでスタート！</p>
          <p hidden data-ugk-orig-hidden="false">30日間の返金保証つき。</p>
          <p><a href="https://shop.example/buy-exp-b" data-ugk-orig-href="https://shop.example/buy" data-ugk-orig-text="今すぐ申し込む">無料で試してみる</a></p>
        </article>
      </body></html>`

      const control = segmentHtml(controlHtml)
      const variant = segmentHtml(variantHtml)

      expect(variant.skel_fp).toBe(control.skel_fp)
      expect(variant.struct_fp).toBe(control.struct_fp)
      expect(variant.css_fp).toBe(control.css_fp)
      expect(variant.links_fp).toEqual(control.links_fp)
      expect(variant.sections).toEqual(control.sections)
      expect(variant.elements).toEqual(control.elements)

      // Also verify WeakMap/Map runtime originalValueMap parity
      const h2El = new IndependentDomElement('h2')
      h2El.append(new IndependentDomText('書き換え見出し'))
      const p1El = new IndependentDomElement('p')
      p1El.append(new IndependentDomText('書き換え本文'))
      const p2El = new IndependentDomElement('p', { hidden: '' })
      p2El.append(new IndependentDomText('30日間の返金保証つき。'))
      const aEl = new IndependentDomElement('a', { href: 'https://shop.example/buy-exp-c' })
      aEl.append(new IndependentDomText('別コピー'))
      const p3El = new IndependentDomElement('p')
      p3El.append(aEl)
      const artEl = new IndependentDomElement('article')
      artEl.append(h2El)
      artEl.append(p1El)
      artEl.append(p2El)
      artEl.append(p3El)
      const headEl = new IndependentDomElement('head')
      headEl.append(new IndependentDomElement('link', { rel: 'stylesheet', href: '/site.css?v=1' }))
      const bodyEl = new IndependentDomElement('body')
      bodyEl.append(artEl)
      const domDoc = new IndependentDomDocument(headEl, bodyEl)

      const origMap = new Map<SegElementLike, OriginalNodeValues>([
        [h2El, { text: '料金プランの比較' }],
        [p1El, { text: '月額2,980円から始められます。' }],
        [p2El, { hidden: false }],
        [aEl, { text: '今すぐ申し込む', attrs: { href: 'https://shop.example/buy' } }],
      ])

      const viaMap = segmentDocument(domDoc, { originalValueMap: origMap })
      expect(viaMap.skel_fp).toBe(control.skel_fp)
      expect(viaMap.sections).toEqual(control.sections)
      expect(viaMap.elements).toEqual(control.elements)
    })

    it('keeps existing sec_fp stable when a duplicate heading is appended later, and marks duplicates positional', () => {
      const before = segmentHtml(`<html><body><article>
        <h2>まとめ</h2><p>最初のまとめ</p>
      </article></body></html>`)

      const after = segmentHtml(`<html><body><article>
        <h2>まとめ</h2><p>最初のまとめ</p>
        <h2>まとめ</h2><p>2つ目のまとめ</p>
      </article></body></html>`)

      expect(before.sections).toHaveLength(1)
      expect(before.sections[0].positional).toBe(false)
      expect(before.sections[0].dup).toBe(0)

      expect(after.sections).toHaveLength(2)
      // Appending a duplicate later NEVER changes the first section's sec_fp!
      expect(after.sections[0].sec_fp).toBe(before.sections[0].sec_fp)
      expect(after.sections[0].dup).toBe(0)
      expect(after.sections[0].positional).toBe(true)
      expect(after.sections[1].dup).toBe(1)
      expect(after.sections[1].positional).toBe(true)
      expect(after.sections[1].sec_fp).not.toBe(after.sections[0].sec_fp)
    })

    it('isolates [data-ugk-slot] into slot_fp without altering skel_fp, body_fp, or links_fp', () => {
      const base = segmentHtml(`<html><body><article>
        <h2>本文</h2><p>テキスト <a href="/a">A</a></p>
      </article></body></html>`)

      const withSlot = segmentHtml(`<html><body><article>
        <h2>本文</h2><p>テキスト <a href="/a">A</a></p>
        <div data-ugk-slot="rec-bottom"><p>おすすめ記事</p><a href="/rec-1">記事1</a></div>
      </article></body></html>`)

      const withUpdatedSlot = segmentHtml(`<html><body><article>
        <h2>本文</h2><p>テキスト <a href="/a">A</a></p>
        <div data-ugk-slot="rec-bottom"><p>別のおすすめ</p><a href="/rec-2">記事2</a></div>
      </article></body></html>`)

      expect(withSlot.skel_fp).toBe(base.skel_fp)
      expect(withSlot.struct_fp).toBe(base.struct_fp)
      expect(withSlot.links_fp).toEqual(base.links_fp)
      expect(base.slot_fp).toBe('0000000000000000')
      expect(withSlot.slot_fp).not.toBe(base.slot_fp)
      expect(withUpdatedSlot.slot_fp).not.toBe(withSlot.slot_fp)
      expect(withUpdatedSlot.skel_fp).toBe(base.skel_fp)
    })

    it('distinguishes css_fp (version-sensitive) from res_fp (cache-buster stripped) and key-sorts JSON-LD in head_fp', () => {
      const v1 = segmentHtml(`<html><head>
        <title>Test Page</title>
        <link rel="stylesheet" href="/main.css?v=100">
        <script src="/bundle.js?cb=111"></script>
        <script type="application/ld+json">{"@type":"Article","headline":"Hello","author":{"name":"A","type":"Person"}}</script>
      </head><body><article><h2>見出し</h2><p>本文</p></article></body></html>`)

      const v2 = segmentHtml(`<html><head>
        <title>Test Page</title>
        <link rel="stylesheet" href="/main.css?v=200">
        <script src="/bundle.js?cb=222"></script>
        <script type="application/ld+json">{"author":{"type":"Person","name":"A"},"headline":"Hello","@type":"Article"}</script>
      </head><body><article><h2>見出し</h2><p>本文</p></article></body></html>`)

      expect(v1.css_fp).not.toBe(v2.css_fp)
      expect(v1.res_fp).toBe(v2.res_fp)
      expect(v1.head_fp).toBe(v2.head_fp)
    })

    it('never reads form input values and normalizes image keys across lazy/srcset/size suffixes', () => {
      const f1 = segmentHtml(`<html><body><main><form action="/s">
        <input name="email" value="alice@example.com" />
        <textarea name="note">secret personal note 1</textarea>
      </form></main></body></html>`)

      const f2 = segmentHtml(`<html><body><main><form action="/s">
        <input name="email" value="bob@example.org" />
        <textarea name="note">completely different user text 2</textarea>
      </form></main></body></html>`)

      expect(f1.skel_fp).toBe(f2.skel_fp)
      expect(f1.struct_fp).toBe(f2.struct_fp)
      expect(f1.sections).toEqual(f2.sections)
      expect(f1.elements).toEqual(f2.elements)

      const imgA = new IndependentDomElement('img', {
        'data-lazy-src': 'https://cdn.example.com/uploads/serum-800x600.webp?q=80',
      })
      const imgB = new IndependentDomElement('img', {
        src: '/uploads/serum@2x.jpg',
      })
      const imgC = new IndependentDomElement('img', {
        srcset: '/uploads/serum-400x300.png 400w, /uploads/serum-scaled.png 1200w',
      })
      expect(computeImageKey(imgA)).toBe('/uploads/serum')
      expect(computeImageKey(imgB)).toBe('/uploads/serum')
      expect(computeImageKey(imgC)).toBe('/uploads/serum')
    })

    it('emits 20 fixed 5% depth bands on anchorless/blockless pages and produces deterministic segmenter content hash', () => {
      const emptyCanvas = segmentHtml(`<html><body><main><canvas width="400" height="400"></canvas></main></body></html>`)
      expect(emptyCanvas.dom_state).toBe('ok')
      expect(emptyCanvas.sections).toHaveLength(20)
      expect(emptyCanvas.sections[0].tier).toBe('depth_band')
      expect(emptyCanvas.sections[0].depth_band).toEqual([0, 5])
      expect(emptyCanvas.sections[19].depth_band).toEqual([95, 100])

      expect(SEGMENTER_CONTENT_HASH).toBe(computeSegmenterContentHash(DEFAULT_PRUNE_REGISTRY))
      expect(SEGMENTER_RULE_REVISIONS.norm).toBe('norm/1')
    })
  })
})
