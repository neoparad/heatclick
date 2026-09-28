/**
 * Unit tests: workers/screenshot/src/request.ts (parseRequestBody)
 *
 * 後方互換の要: preferredDeviceScaleFactor は省略可で、deviceScaleFactor の意味は変えない。
 */
import { parseRequestBody } from '../src/request'

const BASE = { url: 'https://example.com/p', width: 390, deviceScaleFactor: 1 }

describe('parseRequestBody', () => {
  it('accepts the legacy body (no preferredDeviceScaleFactor) unchanged', () => {
    expect(parseRequestBody(BASE)).toEqual({
      url: 'https://example.com/p',
      width: 390,
      deviceScaleFactor: 1,
    })
  })

  it('does not add a preferredDeviceScaleFactor key when the caller omitted it', () => {
    expect(parseRequestBody(BASE)).not.toHaveProperty('preferredDeviceScaleFactor')
  })

  it('passes preferredDeviceScaleFactor through when valid', () => {
    expect(parseRequestBody({ ...BASE, preferredDeviceScaleFactor: 2 })).toEqual({
      url: 'https://example.com/p',
      width: 390,
      deviceScaleFactor: 1,
      preferredDeviceScaleFactor: 2,
    })
  })

  it('ignores an invalid preferredDeviceScaleFactor instead of failing the capture (0, negative, > 4, non-number)', () => {
    for (const bad of [0, -1, 4.5, '2', null, {}, []]) {
      const r = parseRequestBody({ ...BASE, preferredDeviceScaleFactor: bad })
      expect(r).toEqual({ url: 'https://example.com/p', width: 390, deviceScaleFactor: 1 })
      expect(r).not.toHaveProperty('preferredDeviceScaleFactor')
    }
  })

  it('still validates the base fields', () => {
    expect(typeof parseRequestBody(null)).toBe('string')
    expect(typeof parseRequestBody({ ...BASE, url: '  ' })).toBe('string')
    expect(typeof parseRequestBody({ ...BASE, width: 100 })).toBe('string')
    expect(typeof parseRequestBody({ ...BASE, deviceScaleFactor: 0 })).toBe('string')
    expect(typeof parseRequestBody({ ...BASE, deviceScaleFactor: 5 })).toBe('string')
  })

  it('rounds width and trims url', () => {
    const r = parseRequestBody({ url: '  https://example.com/x  ', width: 389.6, deviceScaleFactor: 1 })
    expect(r).toEqual({ url: 'https://example.com/x', width: 390, deviceScaleFactor: 1 })
  })
})
