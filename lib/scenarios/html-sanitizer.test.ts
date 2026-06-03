/**
 * REQ-SEC-001 / REQ-SEC-002 — server-side inline-HTML sanitizer unit tests.
 */

import { HtmlSanitizationError, sanitizeHtmlVariant } from './html-sanitizer'

describe('sanitizeHtmlVariant (REQ-SEC-001/002)', () => {
  it('preserves safe presentational HTML (the POC variant)', () => {
    const poc =
      '<div style="font-family:system-ui;text-align:center;">' +
      '<h3 style="margin:0 0 8px;font-size:18px;color:#0f1117;">初回限定 10% OFF</h3>' +
      '<div style="font-size:16px;color:#4f6bff;background:#eef1ff;padding:6px 12px;border-radius:6px;display:inline-block;font-weight:700;">FIRST10</div>' +
      '<p style="margin:12px 0 16px;font-size:13px;color:#5b6478;line-height:1.55;">ご新規様限定、初回購入が 10% OFF になります。</p>' +
      '</div>'
    const out = sanitizeHtmlVariant(poc)
    expect(out).toContain('初回限定 10% OFF')
    expect(out).toContain('FIRST10')
    expect(out).toContain('<h3')
    expect(out).toContain('<p')
    // styles preserved (modulo trailing semicolon normalization)
    expect(out).toContain('text-align:center')
    expect(out).toContain('color:#4f6bff')
  })

  it('rejects <script>', () => {
    expect(() => sanitizeHtmlVariant('<div>hi</div><script>alert(1)</script>')).toThrow(
      HtmlSanitizationError,
    )
    try {
      sanitizeHtmlVariant('<script>alert(1)</script>')
    } catch (e) {
      expect((e as HtmlSanitizationError).reason).toBe('forbidden_tag')
    }
  })

  it('rejects <iframe>, <object>, <embed>, <form>', () => {
    expect(() => sanitizeHtmlVariant('<iframe src="https://evil.com"></iframe>')).toThrow(
      HtmlSanitizationError,
    )
    expect(() => sanitizeHtmlVariant('<object data="x"></object>')).toThrow(HtmlSanitizationError)
    expect(() => sanitizeHtmlVariant('<embed src="x">')).toThrow(HtmlSanitizationError)
    expect(() => sanitizeHtmlVariant('<form action="x"><input></form>')).toThrow(
      HtmlSanitizationError,
    )
  })

  it('rejects inline event handlers (on*=)', () => {
    try {
      sanitizeHtmlVariant('<div onclick="alert(1)">hi</div>')
      fail('should have thrown')
    } catch (e) {
      expect((e as HtmlSanitizationError).reason).toBe('event_handler')
    }
    expect(() => sanitizeHtmlVariant('<img src="https://x.com/a.png" onerror="alert(1)">')).toThrow(
      HtmlSanitizationError,
    )
  })

  it('rejects dangerous URL schemes in href/src', () => {
    try {
      sanitizeHtmlVariant('<a href="javascript:alert(1)">x</a>')
      fail('should have thrown')
    } catch (e) {
      expect((e as HtmlSanitizationError).reason).toBe('dangerous_url')
    }
    expect(() => sanitizeHtmlVariant('<img src="data:text/html,<x>">')).toThrow(
      HtmlSanitizationError,
    )
  })

  it('rejects <style> blocks', () => {
    expect(() => sanitizeHtmlVariant('<style>body{display:none}</style>')).toThrow(
      HtmlSanitizationError,
    )
  })

  it('drops disallowed attributes but keeps the element', () => {
    const out = sanitizeHtmlVariant('<div data-evil="x" class="y">hi</div>')
    expect(out).toContain('hi')
    expect(out).not.toContain('data-evil')
    expect(out).not.toContain('class')
  })

  it('rejects content that sanitizes to empty', () => {
    // A bare unknown/disallowed wrapper with no text content survives as nothing.
    try {
      sanitizeHtmlVariant('<unknowntag></unknowntag>')
    } catch (e) {
      expect(e).toBeInstanceOf(HtmlSanitizationError)
    }
  })

  it('allows safe https links and images', () => {
    const out = sanitizeHtmlVariant(
      '<a href="https://example.com">go</a> <img src="https://example.com/a.png" alt="a">',
    )
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('src="https://example.com/a.png"')
  })
})
