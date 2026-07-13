import { pathnameMatchSql, toPathnameForMatch, toPathnameGlobPrefix } from './url-match'

describe('toPathnameForMatch', () => {
  it.each([
    ['/entry/tirtir-cushion-foundation?utm=summer#hero', '/entry/tirtir-cushion-foundation'],
    ['https://bihadashop.jp/entry/tirtir-cushion-foundation/?utm=summer#hero', '/entry/tirtir-cushion-foundation'],
    ['/', '/'],
    ['https://bihadashop.jp/', '/'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(toPathnameForMatch(value)).toBe(expected)
  })

  it.each(['', 'entry/without-leading-slash', 'ftp://example.com/path', 'https://'])('rejects %s', (value) => {
    expect(toPathnameForMatch(value)).toBeNull()
  })
})

describe('toPathnameGlobPrefix', () => {
  it('preserves the pathname segment boundary for glob matching', () => {
    expect(toPathnameGlobPrefix('/products/*')).toBe('/products/')
    expect(toPathnameGlobPrefix('https://bihadashop.jp/products/*?ignored=1')).toBe('/products/')
    expect(toPathnameGlobPrefix('/*')).toBe('/')
  })

  it('rejects non-glob and malformed input', () => {
    expect(toPathnameGlobPrefix('/products')).toBeNull()
    expect(toPathnameGlobPrefix('products/*')).toBeNull()
  })
})

describe('pathnameMatchSql', () => {
  it('uses a NULL-safe path() expression with the same trailing slash rule', () => {
    expect(pathnameMatchSql()).toBe(
      "if(ifNull(path(url), '') = '/', '/', replaceRegexpOne(ifNull(path(url), ''), '/+$', ''))",
    )
  })

  it('rejects non-identifier column names', () => {
    expect(() => pathnameMatchSql('url; DROP TABLE events')).toThrow('simple identifier')
  })
})
