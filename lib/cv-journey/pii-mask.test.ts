/**
 * pii-mask のユニットテスト。
 * URL の query 除去・email/token マスク・path 正規化を固定する（GDPR / 個情法）。
 */

import { maskUrlForDisplay, maskSensitiveTokens, normalizePath } from './pii-mask'

describe('maskUrlForDisplay', () => {
  it('query string を除去する', () => {
    expect(maskUrlForDisplay('https://shop.example/p/123?email=foo@bar.com&token=abc')).toBe('/p/123')
  })

  it('相対 path の query も除去', () => {
    expect(maskUrlForDisplay('/cart?coupon=XYZ')).toBe('/cart')
  })

  it('path 内の email をマスク', () => {
    expect(maskUrlForDisplay('/u/foo@bar.com/profile')).toContain('<email>')
  })

  it('path 内の長いトークン状文字列を伏字化', () => {
    const masked = maskUrlForDisplay('/r/AbCdEfGhIjKlMnOpQrStUvWx')
    expect(masked).toContain('…')
    expect(masked).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx')
  })
})

describe('maskSensitiveTokens', () => {
  it('email を <email> に置換', () => {
    expect(maskSensitiveTokens('contact a@b.co now')).toBe('contact <email> now')
  })
})

describe('normalizePath', () => {
  it('query 除去 + 末尾スラッシュ統一', () => {
    expect(normalizePath('https://x.example/cart/?a=1')).toBe('/cart')
  })

  it('ルートは / を返す', () => {
    expect(normalizePath('https://x.example/')).toBe('/')
  })
})
