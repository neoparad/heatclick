/**
 * Unit tests: image-dimensions (JPEG SOFn + PNG IHDR parser)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: Cloudflare Browser Rendering provider swap
 *
 * Cloudflare Browser Rendering は binary 画像を返し dimension を JSON で持たないため、
 * bytes から width/height を抽出する parser の正しさを検証する。
 */

import { readImageDimensions } from './image-dimensions'

/** 最小の JPEG header を組み立てる (SOI + 任意の前置 segment + SOF0 + width/height)。 */
function makeJpeg(width: number, height: number, withApp0 = true): Uint8Array {
  const out: number[] = [0xff, 0xd8] // SOI
  if (withApp0) {
    // APP0 (JFIF) segment: FF E0 + length(2)=16 + "JFIF\0" + ...(padding) を length 分置く。
    const app0Body = [
      0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ]
    const app0Len = app0Body.length + 2
    out.push(0xff, 0xe0, (app0Len >> 8) & 0xff, app0Len & 0xff, ...app0Body)
  }
  // SOF0: FF C0 + length(2)=17 + precision(1)=8 + height(2) + width(2) + components...
  out.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // num components
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  )
  return new Uint8Array(out)
}

/** 最小の PNG header (signature + IHDR chunk with width/height)。 */
function makePng(width: number, height: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdrLen = [0x00, 0x00, 0x00, 0x0d] // 13
  const ihdr = [0x49, 0x48, 0x44, 0x52] // "IHDR"
  const w = [(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff]
  const h = [(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff]
  const rest = [0x08, 0x06, 0x00, 0x00, 0x00] // bitdepth, colortype, compression, filter, interlace
  return new Uint8Array([...sig, ...ihdrLen, ...ihdr, ...w, ...h, ...rest])
}

describe('readImageDimensions — JPEG', () => {
  it('reads width/height from a JPEG with a preceding APP0 segment', () => {
    const dims = readImageDimensions(makeJpeg(1280, 8421, true))
    expect(dims).toEqual({ width: 1280, height: 8421 })
  })

  it('reads width/height from a JPEG with no preceding segments (SOF0 right after SOI)', () => {
    const dims = readImageDimensions(makeJpeg(390, 4096, false))
    expect(dims).toEqual({ width: 390, height: 4096 })
  })

  it('handles a very tall full-page capture (height > 16-bit chunk but JPEG caps at 65535)', () => {
    const dims = readImageDimensions(makeJpeg(820, 65535, true))
    expect(dims).toEqual({ width: 820, height: 65535 })
  })

  it('returns null for a truncated JPEG (SOF0 length lies beyond buffer)', () => {
    const full = makeJpeg(1280, 2000, false)
    // SOI(2) + 5 bytes of the SOF0 segment → height/width not fully present
    const truncated = full.slice(0, 7)
    expect(readImageDimensions(truncated)).toBeNull()
  })
})

describe('readImageDimensions — PNG', () => {
  it('reads width/height from a PNG IHDR', () => {
    const dims = readImageDimensions(makePng(1280, 12000))
    expect(dims).toEqual({ width: 1280, height: 12000 })
  })

  it('returns null when the PNG signature is corrupt', () => {
    const png = makePng(100, 200)
    png[1] = 0x00 // break the signature
    expect(readImageDimensions(png)).toBeNull()
  })
})

describe('readImageDimensions — non-image / garbage', () => {
  it('returns null for empty bytes', () => {
    expect(readImageDimensions(new Uint8Array())).toBeNull()
  })

  it('returns null for random bytes that are neither JPEG nor PNG', () => {
    expect(readImageDimensions(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))).toBeNull()
  })

  it('returns null for a JSON error body mistakenly passed as image bytes', () => {
    const json = new TextEncoder().encode('{"success":false,"errors":[{"message":"bad"}]}')
    expect(readImageDimensions(json)).toBeNull()
  })
})
