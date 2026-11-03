import { execFileSync } from 'node:child_process'
import path from 'node:path'

import {
  normalizeUrlFull,
  normalizeUrl,
  urlMatchKey,
  urlHash16,
  normalizeHost,
  isTrackingParam,
  UrlNormalizationError,
} from './normalize-url'

interface TestCase {
  name: string
  input: string
  expectedUrl: string
  expectedMatchKey: string
  expectedHost: string
  expectedPathname: string
  expectedQuery: string
}

const SHARED_VECTORS: ReadonlyArray<TestCase> = [
  {
    name: 'root trailing slash preserved and www stripped',
    input: 'https://www.bihadashop.jp/',
    expectedUrl: 'https://bihadashop.jp/',
    expectedMatchKey: 'bihadashop.jp/',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/',
    expectedQuery: '',
  },
  {
    name: 'non-root trailing slash stripped, host lowercased',
    input: 'HTTPS://WWW.BihadaShop.jp/column/skin-care/',
    expectedUrl: 'https://bihadashop.jp/column/skin-care',
    expectedMatchKey: 'bihadashop.jp/column/skin-care',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/column/skin-care',
    expectedQuery: '',
  },
  {
    name: 'fragment containing slash and query is stripped before path normalization',
    input: 'https://bihadashop.jp/column/item/#section/sub?utm_source=x',
    expectedUrl: 'https://bihadashop.jp/column/item',
    expectedMatchKey: 'bihadashop.jp/column/item',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/column/item',
    expectedQuery: '',
  },
  {
    name: 'tracking params stripped and remaining query params sorted deterministically',
    input:
      'https://www.bihadashop.jp/items/?utm_source=google&z=2&fbclid=IwAR123&a=1&utm_medium=cpc&a=0&gclid=test999&_gl=1*abc',
    expectedUrl: 'https://bihadashop.jp/items?a=0&a=1&z=2',
    expectedMatchKey: 'bihadashop.jp/items?a=0&a=1&z=2',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/items',
    expectedQuery: 'a=0&a=1&z=2',
  },
  {
    name: 'default port :443 for https and :80 for http removed, custom port kept',
    input: 'https://bihadashop.jp:443/shop/',
    expectedUrl: 'https://bihadashop.jp/shop',
    expectedMatchKey: 'bihadashop.jp/shop',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/shop',
    expectedQuery: '',
  },
  {
    name: 'custom port 8080 preserved',
    input: 'http://www.example.com:8080/api/v1/test/',
    expectedUrl: 'http://example.com:8080/api/v1/test',
    expectedMatchKey: 'example.com:8080/api/v1/test',
    expectedHost: 'example.com:8080',
    expectedPathname: '/api/v1/test',
    expectedQuery: '',
  },
  {
    name: 'Japanese path and percent-escape case normalization (RFC 3986)',
    input: 'https://bihadashop.jp/%e6%af%94%e8%bc%83/%7etest/肌ケア/',
    expectedUrl: 'https://bihadashop.jp/%E6%AF%94%E8%BC%83/~test/%E8%82%8C%E3%82%B1%E3%82%A2',
    expectedMatchKey: 'bihadashop.jp/%E6%AF%94%E8%BC%83/~test/%E8%82%8C%E3%82%B1%E3%82%A2',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/%E6%AF%94%E8%BC%83/~test/%E8%82%8C%E3%82%B1%E3%82%A2',
    expectedQuery: '',
  },
  {
    name: 'dot segments and multiple slashes collapsed',
    input: 'https://bihadashop.jp//a/b/../c/./d//',
    expectedUrl: 'https://bihadashop.jp/a/c/d',
    expectedMatchKey: 'bihadashop.jp/a/c/d',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/a/c/d',
    expectedQuery: '',
  },
  {
    name: 'schemeless domain gets https:// prepended',
    input: 'bihadashop.jp/about/',
    expectedUrl: 'https://bihadashop.jp/about',
    expectedMatchKey: 'bihadashop.jp/about',
    expectedHost: 'bihadashop.jp',
    expectedPathname: '/about',
    expectedQuery: '',
  },
]

describe('Fusion SaaS URL Normalization (lib/url/normalize-url)', () => {
  it.each(SHARED_VECTORS)('$name', (tc) => {
    const res = normalizeUrlFull(tc.input)
    expect(res.normalizedUrl).toBe(tc.expectedUrl)
    expect(res.matchKey).toBe(tc.expectedMatchKey)
    expect(res.host).toBe(tc.expectedHost)
    expect(res.pathname).toBe(tc.expectedPathname)
    expect(res.query).toBe(tc.expectedQuery)
    expect(res.urlHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces identical urlHash and matchKey for equivalent URLs across products', () => {
    const ugokimapUrl = 'https://www.bihadashop.jp/column/post-1/?utm_source=instagram&fbclid=abc#top'
    const linkscrawlUrl = 'https://bihadashop.jp/column/post-1'
    const aireceiptUrl = 'https://BIHADASHOP.JP:443/column/post-1/?gclid=xyz'
    const gscUrl = 'https://www.bihadashop.jp/column/post-1/'

    const h1 = urlHash16(ugokimapUrl)
    const h2 = urlHash16(linkscrawlUrl)
    const h3 = urlHash16(aireceiptUrl)
    const h4 = urlHash16(gscUrl)

    expect(h1).not.toBeNull()
    expect(h1).toBe(h2)
    expect(h2).toBe(h3)
    expect(h3).toBe(h4)

    expect(urlMatchKey(ugokimapUrl)).toBe('bihadashop.jp/column/post-1')
    expect(urlMatchKey('http://bihadashop.jp/column/post-1/')).toBe('bihadashop.jp/column/post-1')
  })

  it('normalizes hosts including sc-domain: prefix from GSC', () => {
    expect(normalizeHost('sc-domain:bihadashop.jp')).toBe('bihadashop.jp')
    expect(normalizeHost('https://www.bihadashop.jp/column')).toBe('bihadashop.jp')
    expect(normalizeHost('LINK-TH.CO.JP.')).toBe('link-th.co.jp')
    expect(normalizeHost('')).toBeNull()
    expect(normalizeHost(null)).toBeNull()
  })

  it('identifies tracking parameters accurately', () => {
    expect(isTrackingParam('utm_source')).toBe(true)
    expect(isTrackingParam('UTM_CAMPAIGN')).toBe(true)
    expect(isTrackingParam('gclid')).toBe(true)
    expect(isTrackingParam('fbclid')).toBe(true)
    expect(isTrackingParam('page')).toBe(false)
    expect(isTrackingParam('category')).toBe(false)
  })

  it('handles invalid or empty inputs gracefully in safe helpers', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl(null)).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(() => normalizeUrlFull('')).toThrow(UrlNormalizationError)
  })

  it('matches Python linkscrawl/shared/url_canon.py byte-for-byte on all shared vectors', () => {
    const pyScript = `
import json, sys
sys.path.insert(0, r"C:\\Users\\M2603\\linkscrawl\\shared")
from url_canon import normalize_url_full

inputs = json.loads(sys.argv[1])
out = []
for u in inputs:
    r = normalize_url_full(u)
    out.append({
        "normalizedUrl": r.normalized_url,
        "matchKey": r.match_key,
        "urlHash": r.url_hash,
        "host": r.host,
        "pathname": r.pathname,
        "query": r.query,
    })
print(json.dumps(out))
`
    const inputs = SHARED_VECTORS.map((v) => v.input)
    const stdout = execFileSync('python', ['-c', pyScript, JSON.stringify(inputs)], {
      encoding: 'utf8',
    })
    const pyResults = JSON.parse(stdout.trim()) as Array<{
      normalizedUrl: string
      matchKey: string
      urlHash: string
      host: string
      pathname: string
      query: string
    }>

    inputs.forEach((input, idx) => {
      const tsRes = normalizeUrlFull(input)
      expect(pyResults[idx]).toEqual(tsRes)
    })
  })
})
