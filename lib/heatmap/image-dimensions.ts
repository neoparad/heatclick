/**
 * 画像 bytes から (width, height) を抽出する最小 parser (JPEG / PNG)。
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: Cloudflare Browser Rendering provider swap
 *
 * Why manual (not image-size / probe-image-size / sharp):
 *   - Cloudflare Browser Rendering は **binary image bytes** を返す (JSON の dimension が無い)。
 *     heatmap 座標系は naturalWidth/naturalHeight を必要とするため bytes から読む。
 *   - 新規 npm dep を足さず、必要なのは JPEG (我々が type='jpeg' で要求) の header parse のみ。
 *     防御的に PNG も対応する (将来 type 変更や fallback content に備える)。
 *   - SOF0..SOF15 marker (0xFFC0..0xFFCF、ただし DHT=0xC4 / DAC=0xCC / RSTn は除外) を
 *     先頭から走査して height/width を読む。~40 行で完結し単体テスト可能。
 *
 * 参照:
 *   - JPEG (JFIF) SOFn marker layout:
 *       FF Cn  <len:2>  <precision:1>  <height:2>  <width:2> ...
 *   - PNG IHDR: 8-byte signature + "IHDR" chunk first → width:4, height:4 at offset 16.
 */

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * 画像 bytes から dimension を抽出する。判別できない場合は null。
 * 呼び出し側で sanitizeDimension / fallback と組み合わせて使うこと。
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const png = readPngDimensions(bytes)
  if (png) return png
  return readJpegDimensions(bytes)
}

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A。IHDR は signature 直後の chunk。 */
const PNG_SIGNATURE: ReadonlyArray<number> = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null
  }
  // IHDR chunk: length(4) + "IHDR"(4) → data starts at byte 16; width(4) big-endian, height(4).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null
  }
  const width = readUint32BE(bytes, 16)
  const height = readUint32BE(bytes, 20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * JPEG header を走査して SOFn marker の (width, height) を読む。
 *
 * segment 構造: 各 marker は 0xFF + marker-byte。SOFn (frame header) の手前にある
 * segment は length-prefixed なので length 分だけ skip して次の marker を探す。
 */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  // SOI marker: FF D8
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let offset = 2
  const len = bytes.length
  while (offset + 1 < len) {
    // marker は 0xFF で始まる。fill byte (0xFF が連続) は読み飛ばす。
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    let marker = bytes[offset + 1] as number
    // 連続 0xFF padding を skip して実 marker byte に到達する。
    while (marker === 0xff && offset + 2 < len) {
      offset += 1
      marker = bytes[offset + 1] as number
    }
    offset += 2

    // standalone marker (length なし): RSTn (D0..D7) / SOI(D8) / EOI(D9) / TEM(01)。
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue
    if (marker >= 0xd0 && marker <= 0xd7) continue

    // 残りは length-prefixed segment。length(2) は marker 自身を含まないが length field を含む。
    if (offset + 2 > len) return null
    const segLen = readUint16BE(bytes, offset)
    if (segLen < 2) return null

    // SOF0..SOF15 = frame header。ただし DHT(C4) / DAC(CC) は frame ではないので除外。
    if (isSofMarker(marker)) {
      // segment: length(2) precision(1) height(2) width(2)
      if (offset + 7 > len) return null
      const height = readUint16BE(bytes, offset + 3)
      const width = readUint16BE(bytes, offset + 5)
      if (width <= 0 || height <= 0) return null
      return { width, height }
    }

    // 次の segment へ (length 分 skip)。
    offset += segLen
  }
  return null
}

/** SOFn (Start Of Frame) marker か。0xC0..0xCF のうち C4(DHT)/C8(JPG)/CC(DAC) を除く。 */
function isSofMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function readUint16BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] as number) << 8) | (bytes[at + 1] as number)
}

function readUint32BE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] as number) << 24) |
    ((bytes[at + 1] as number) << 16) |
    ((bytes[at + 2] as number) << 8) |
    (bytes[at + 3] as number)
  ) >>> 0
}
