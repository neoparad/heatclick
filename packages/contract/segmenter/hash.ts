/**
 * UGOKI LINK v2 — Segmenter Synchronous Pure-JS Hashing (zero dependencies)
 *
 * - SipHash-2-4 (64-bit, BigInt-exact) with two independent keys for 128-bit digests
 * - Width helpers: H32 (8 hex), H40 (10 hex), H48 (12 hex), H64 (16 hex), H128 (32 hex)
 * - FIPS 180-4 SHA-256 for segmenter bundle content hash pinning (§6.1 / D-8)
 *
 * Zero reliance on `node:crypto`, `Buffer`, `Intl`, or engine-specific APIs.
 */

const UTF8_ENCODER = new TextEncoder()
const MASK64 = 0xffffffffffffffffn

// Two independent fixed 128-bit keys (domain-separated, deterministic across all engines)
const SIP_KEY_A0 = 0x75676f6b696c696en // "ugokilin"
const SIP_KEY_A1 = 0x6b76327365676d31n // "kv2segm1"
const SIP_KEY_B0 = 0x637261776c6a6f69n // "crawljoi"
const SIP_KEY_B1 = 0x6e64696765737432n // "ndigest2"

function rotl64(v: bigint, shift: bigint): bigint {
  return ((v << shift) & MASK64) | (v >> (64n - shift))
}

function sipRound(
  v0: bigint,
  v1: bigint,
  v2: bigint,
  v3: bigint,
): [bigint, bigint, bigint, bigint] {
  v0 = (v0 + v1) & MASK64
  v1 = rotl64(v1, 13n) ^ v0
  v0 = rotl64(v0, 32n)

  v2 = (v2 + v3) & MASK64
  v3 = rotl64(v3, 16n) ^ v2

  v0 = (v0 + v3) & MASK64
  v3 = rotl64(v3, 21n) ^ v0

  v2 = (v2 + v1) & MASK64
  v1 = rotl64(v1, 17n) ^ v2
  v2 = rotl64(v2, 32n)

  return [v0, v1, v2, v3]
}

function sipHash24Bytes(bytes: Uint8Array, k0: bigint, k1: bigint): bigint {
  let v0 = 0x736f6d6570736575n ^ k0
  let v1 = 0x646f72616e646f6dn ^ k1
  let v2 = 0x6c7967656e657261n ^ k0
  let v3 = 0x7465646279746573n ^ k1

  const len = bytes.length
  const fullBlocks = len - (len % 8)

  for (let i = 0; i < fullBlocks; i += 8) {
    const m =
      BigInt(bytes[i]) |
      (BigInt(bytes[i + 1]) << 8n) |
      (BigInt(bytes[i + 2]) << 16n) |
      (BigInt(bytes[i + 3]) << 24n) |
      (BigInt(bytes[i + 4]) << 32n) |
      (BigInt(bytes[i + 5]) << 40n) |
      (BigInt(bytes[i + 6]) << 48n) |
      (BigInt(bytes[i + 7]) << 56n)

    v3 ^= m
    ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
    ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
    v0 ^= m
  }

  let b = BigInt(len & 0xff) << 56n
  const rem = len - fullBlocks
  if (rem >= 7) b |= BigInt(bytes[fullBlocks + 6]) << 48n
  if (rem >= 6) b |= BigInt(bytes[fullBlocks + 5]) << 40n
  if (rem >= 5) b |= BigInt(bytes[fullBlocks + 4]) << 32n
  if (rem >= 4) b |= BigInt(bytes[fullBlocks + 3]) << 24n
  if (rem >= 3) b |= BigInt(bytes[fullBlocks + 2]) << 16n
  if (rem >= 2) b |= BigInt(bytes[fullBlocks + 1]) << 8n
  if (rem >= 1) b |= BigInt(bytes[fullBlocks])

  v3 ^= b
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  v0 ^= b

  v2 ^= 0xffn
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)
  ;[v0, v1, v2, v3] = sipRound(v0, v1, v2, v3)

  return (v0 ^ v1 ^ v2 ^ v3) & MASK64
}

function encodeTagged(domainTag: string, parts: readonly string[]): Uint8Array {
  // Length-prefixed canonical framing prevents ambiguity across part boundaries
  let framed = `${domainTag.length}:${domainTag}|`
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    framed += `${p.length}:${p}|`
  }
  return UTF8_ENCODER.encode(framed)
}

export function hash64(domainTag: string, ...parts: readonly string[]): string {
  const bytes = encodeTagged(domainTag, parts)
  return sipHash24Bytes(bytes, SIP_KEY_A0, SIP_KEY_A1).toString(16).padStart(16, '0')
}

export function hash48(domainTag: string, ...parts: readonly string[]): string {
  return hash64(domainTag, ...parts).slice(0, 12)
}

export function hash40(domainTag: string, ...parts: readonly string[]): string {
  return hash64(domainTag, ...parts).slice(0, 10)
}

export function hash32(domainTag: string, ...parts: readonly string[]): string {
  return hash64(domainTag, ...parts).slice(0, 8)
}

/**
 * 128-bit digest from two independent keyed 64-bit SipHash-2-4 hashes (join-final.md A1).
 */
export function hash128(domainTag: string, ...parts: readonly string[]): string {
  const bytes = encodeTagged(domainTag, parts)
  const h1 = sipHash24Bytes(bytes, SIP_KEY_A0, SIP_KEY_A1).toString(16).padStart(16, '0')
  const h2 = sipHash24Bytes(bytes, SIP_KEY_B0, SIP_KEY_B1).toString(16).padStart(16, '0')
  return h1 + h2
}

// ---------------------------------------------------------------------------
// Pure-JS SHA-256 (for segmenter content hash pinning)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

export function sha256Hex(text: string): string {
  const input = UTF8_ENCODER.encode(text)
  const bitLenHi = Math.floor((input.length * 8) / 0x100000000)
  const bitLenLo = (input.length * 8) >>> 0

  const paddedLen = Math.ceil((input.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(input)
  padded[input.length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, bitLenHi, false)
  view.setUint32(paddedLen - 4, bitLenLo, false)

  const h = new Uint32Array(SHA256_H0)
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  let hex = ''
  for (let i = 0; i < 8; i++) {
    hex += h[i].toString(16).padStart(8, '0')
  }
  return hex
}
