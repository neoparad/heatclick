/**
 * REQ-SEC-003 — URL scheme allowlist unit tests.
 */

import { isSafeHttpsUrl } from './safe-url'

describe('isSafeHttpsUrl (REQ-SEC-003)', () => {
  it('accepts absolute https URLs', () => {
    expect(isSafeHttpsUrl('https://example.com')).toBe(true)
    expect(isSafeHttpsUrl('https://example.com/path?q=1#frag')).toBe(true)
    expect(isSafeHttpsUrl('https://sub.example.co.jp/a/b')).toBe(true)
  })

  it('rejects non-https schemes', () => {
    expect(isSafeHttpsUrl('http://example.com')).toBe(false)
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpsUrl('JavaScript:alert(1)')).toBe(false)
    expect(isSafeHttpsUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeHttpsUrl('blob:https://example.com/uuid')).toBe(false)
    expect(isSafeHttpsUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeHttpsUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects relative URLs', () => {
    expect(isSafeHttpsUrl('/path/only')).toBe(false)
    expect(isSafeHttpsUrl('path/only')).toBe(false)
    expect(isSafeHttpsUrl('//example.com')).toBe(false)
    expect(isSafeHttpsUrl('')).toBe(false)
  })

  it('rejects URLs with embedded credentials', () => {
    expect(isSafeHttpsUrl('https://user:pass@example.com')).toBe(false)
    expect(isSafeHttpsUrl('https://user@example.com')).toBe(false)
  })

  it('rejects malformed input', () => {
    expect(isSafeHttpsUrl('https://')).toBe(false)
    expect(isSafeHttpsUrl('not a url')).toBe(false)
  })
})
