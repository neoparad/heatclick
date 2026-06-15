/**
 * variant-preview-srcdoc.test.ts — preview srcdoc 組み立ての単体テスト (C)
 *
 * buildVariantPreviewSrcDoc は純粋関数 (DOMParser 非依存)。sanitizeHtml は stub を渡して
 * 「HTML variant は必ず sanitizer を通る」「画像 URL は https 検証」「position でレイアウト
 * クラスが変わる」「unsafe URL は描画されない」を固定する。
 */

import { buildVariantPreviewSrcDoc } from './variant-preview-srcdoc'
import type { Variant } from '@/lib/scenarios/types'

// sanitizer が確かに適用されたことを検出できるよう marker を付ける stub。
const stubSanitize = (raw: string) => `<<S>>${raw.replace(/<script[\s\S]*?<\/script>/gi, '')}`

function imageVariant(over: Partial<Variant> = {}): Variant {
  return {
    id: 'A',
    content_type: 'image',
    image_url: 'https://cdn.example.com/a.png',
    image_alt: '',
    position: 'center',
    traffic_split: 100,
    ...over,
  } as Variant
}

function htmlVariant(over: Partial<Variant> = {}): Variant {
  return {
    id: 'B',
    content_type: 'html',
    html: '<div>hi</div>',
    position: 'bottom-right',
    traffic_split: 100,
    ...over,
  } as Variant
}

describe('buildVariantPreviewSrcDoc — image', () => {
  it('renders a safe https image and uses the center/overlay layout', () => {
    const doc = buildVariantPreviewSrcDoc(imageVariant(), stubSanitize)
    expect(doc).toContain('src="https://cdn.example.com/a.png"')
    expect(doc).toContain('class="card"')
    expect(doc).toContain('<body class="overlay">')
  })

  it('escapes the alt text (no raw HTML injection via alt)', () => {
    const doc = buildVariantPreviewSrcDoc(
      imageVariant({ image_alt: 'a & "b" <c>' } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).toContain('alt="a &amp; &quot;b&quot; &lt;c&gt;"')
    expect(doc).not.toContain('alt="a & "b" <c>"')
  })

  it('refuses a non-https image_url (shows a warning, no img src)', () => {
    const doc = buildVariantPreviewSrcDoc(
      imageVariant({ image_url: 'http://cdn.example.com/a.png' } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).toContain('ugk-warn')
    expect(doc).not.toContain('src="http://cdn.example.com/a.png"')
  })

  it('refuses a leading-whitespace https URL (runtime fidelity: must start with https://)', () => {
    const doc = buildVariantPreviewSrcDoc(
      imageVariant({ image_url: '  https://cdn.example.com/a.png' } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).toContain('ugk-warn')
    expect(doc).not.toContain('<img')
  })

  it('refuses a javascript: image_url', () => {
    const doc = buildVariantPreviewSrcDoc(
      // eslint-disable-next-line no-script-url
      imageVariant({ image_url: 'javascript:alert(1)' } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).toContain('ugk-warn')
    expect(doc).not.toContain('javascript:alert(1)')
  })
})

describe('buildVariantPreviewSrcDoc — html', () => {
  it('ALWAYS routes html through the provided sanitizer (鉄則)', () => {
    const doc = buildVariantPreviewSrcDoc(
      htmlVariant({ html: '<div>hi<script>x()</script></div>' } as Partial<Variant>),
      stubSanitize,
    )
    // sanitizer marker が入っている = sanitize を通った
    expect(doc).toContain('<<S>>')
    // stub が script を除去した結果が反映される
    expect(doc).not.toContain('<script>x()</script>')
  })

  it('uses the corner layout for a corner position (no overlay)', () => {
    const doc = buildVariantPreviewSrcDoc(htmlVariant({ position: 'bottom-right' } as Partial<Variant>), stubSanitize)
    expect(doc).toContain('class="corner"')
    expect(doc).toContain('<body class="">')
  })

  it('uses the inline layout for inline position', () => {
    const doc = buildVariantPreviewSrcDoc(htmlVariant({ position: 'inline' } as Partial<Variant>), stubSanitize)
    expect(doc).toContain('class="inline"')
  })
})

describe('buildVariantPreviewSrcDoc — cta', () => {
  it('renders a CTA anchor for a safe https cta_url', () => {
    const doc = buildVariantPreviewSrcDoc(
      htmlVariant({ cta_url: 'https://shop.example/buy' } as Partial<Variant>),
      stubSanitize,
    )
    // CSS の `.ugk-cta{` は常にあるので、リンク要素 `class="ugk-cta"` で判定する。
    expect(doc).toContain('<a class="ugk-cta"')
    expect(doc).toContain('href="https://shop.example/buy"')
  })

  it('drops a non-https cta_url (no CTA anchor rendered)', () => {
    const doc = buildVariantPreviewSrcDoc(
      htmlVariant({ cta_url: 'http://shop.example/buy' } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).not.toContain('<a class="ugk-cta"')
    expect(doc).not.toContain('href="http://shop.example/buy"')
  })
})

describe('buildVariantPreviewSrcDoc — position & responsive (PC/SP)', () => {
  it('renders a full-width footer bar for footer position', () => {
    const doc = buildVariantPreviewSrcDoc(
      htmlVariant({ position: 'footer' } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).toContain('class="footerbar"')
    expect(doc).toContain('<body class="footer-body">')
  })

  it('mobile preview uses position_mobile when set (PC=右下 → SP=フッター)', () => {
    const v = imageVariant({ position: 'bottom-right', position_mobile: 'footer' } as Partial<Variant>)
    expect(buildVariantPreviewSrcDoc(v, stubSanitize, 'desktop')).toContain('class="corner"')
    expect(buildVariantPreviewSrcDoc(v, stubSanitize, 'mobile')).toContain('class="footerbar"')
  })

  it('mobile falls back to position when position_mobile is not set', () => {
    const v = htmlVariant({ position: 'center' } as Partial<Variant>)
    const mobile = buildVariantPreviewSrcDoc(v, stubSanitize, 'mobile')
    expect(mobile).toContain('class="card"')
    expect(mobile).toContain('<body class="overlay">')
  })

  it('applies offset (margin-bottom) for footer position', () => {
    const doc = buildVariantPreviewSrcDoc(
      htmlVariant({ position: 'footer', position_offset: 60 } as Partial<Variant>),
      stubSanitize,
    )
    expect(doc).toContain('margin-bottom:60px')
  })

  it('defaults to desktop when the device arg is omitted (backward compatible)', () => {
    const v = imageVariant({ position: 'bottom-right', position_mobile: 'footer' } as Partial<Variant>)
    expect(buildVariantPreviewSrcDoc(v, stubSanitize)).toContain('class="corner"')
  })
})
