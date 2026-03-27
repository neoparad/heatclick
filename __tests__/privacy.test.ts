import { anonymizeIp } from '@/lib/privacy'

// getBrowser はexportされていないのでモジュールをimportして内部テスト
// simplifyUserAgent経由でテスト
import { simplifyUserAgent } from '@/lib/privacy'

describe('anonymizeIp', () => {
  it('should anonymize IPv4 by zeroing last octet', () => {
    expect(anonymizeIp('192.168.1.100')).toBe('192.168.1.0')
  })

  it('should anonymize IPv6 by zeroing last 4 segments', () => {
    expect(anonymizeIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334'))
      .toBe('2001:0db8:85a3:0000:0:0:0:0')
  })

  it('should handle empty string', () => {
    expect(anonymizeIp('')).toBe('')
  })

  it('should handle forwarded IPs (first IP)', () => {
    // x-forwarded-for often has comma-separated IPs; this tests single IP
    expect(anonymizeIp('10.0.0.42')).toBe('10.0.0.0')
  })
})

describe('Browser detection (via simplifyUserAgent)', () => {
  it('should detect Chrome', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    expect(simplifyUserAgent(ua)).toBe('Chrome on Windows')
  })

  it('should detect Edge (not Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
    expect(simplifyUserAgent(ua)).toBe('Edge on Windows')
  })

  it('should detect Opera (not Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0'
    expect(simplifyUserAgent(ua)).toBe('Opera on Windows')
  })

  it('should detect Firefox', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'
    expect(simplifyUserAgent(ua)).toBe('Firefox on Linux')
  })

  it('should detect Safari on macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    expect(simplifyUserAgent(ua)).toBe('Safari on macOS')
  })

  it('should handle empty UA', () => {
    expect(simplifyUserAgent('')).toBe('')
  })
})
