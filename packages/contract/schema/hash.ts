/**
 * Pure zero-dependency deterministic SHA-256 implementation (FIPS 180-4).
 *
 * Works identically across browser runtimes, Cloudflare Workers, and Node.js
 * without relying on `node:crypto` or async Web Crypto APIs, ensuring
 * contract generators and integrity checks remain 100% synchronous and
 * deterministic everywhere.
 */

const K: ReadonlyArray<number> = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function utf8ToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const len = data.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;

  // Pad to 56 mod 64 bytes, then append 8-byte big-endian bit length
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data, 0);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input;
  const digest = sha256Bytes(bytes);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Pure zero-dependency RFC 2104 HMAC-SHA256 implementation over `sha256Bytes`.
 * Works identically and synchronously across browsers, Cloudflare Workers, and Node.js.
 */
export function hmacSha256Bytes(
  secretKey: string | Uint8Array,
  message: string | Uint8Array
): Uint8Array {
  const BLOCK_SIZE = 64;
  const rawKey = typeof secretKey === 'string' ? utf8ToBytes(secretKey) : secretKey;
  const msgBytes = typeof message === 'string' ? utf8ToBytes(message) : message;

  const keyBlock = new Uint8Array(BLOCK_SIZE);
  if (rawKey.length > BLOCK_SIZE) {
    keyBlock.set(sha256Bytes(rawKey), 0);
  } else {
    keyBlock.set(rawKey, 0);
  }

  const innerPad = new Uint8Array(BLOCK_SIZE + msgBytes.length);
  const outerPad = new Uint8Array(BLOCK_SIZE + 32);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    innerPad[i] = keyBlock[i] ^ 0x36;
    outerPad[i] = keyBlock[i] ^ 0x5c;
  }
  innerPad.set(msgBytes, BLOCK_SIZE);

  const innerHash = sha256Bytes(innerPad);
  outerPad.set(innerHash, BLOCK_SIZE);
  return sha256Bytes(outerPad);
}

export function hmacSha256Hex(
  secretKey: string | Uint8Array,
  message: string | Uint8Array
): string {
  const digest = hmacSha256Bytes(secretKey, message);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export const SUBJECT_HMAC_VERSION = 'v1' as const;
export type CanonicalSubjectHmacVersion = typeof SUBJECT_HMAC_VERSION;

export interface CanonicalSubjectHmacInput {
  readonly tenantId: string;
  readonly subjectKind: string;
  readonly subjectValue: string;
  readonly secretKey: string;
  readonly version?: CanonicalSubjectHmacVersion;
}

/**
 * Unified canonical versioned RFC 2104 HMAC-SHA256 for subject identifiers
 * shared identically across collector ingest, `/v1/optout`, and the 14-day
 * deletion execution engine (Codex #9):
 *   `HMAC-SHA256(secretKey, "v1\0" + tenantId + "\0" + subjectKind + "\0" + subjectValue)`
 */
export function computeCanonicalSubjectHmac(input: CanonicalSubjectHmacInput): string {
  const version = input.version ?? SUBJECT_HMAC_VERSION;
  const payload = `${version}\u0000${input.tenantId}\u0000${input.subjectKind}\u0000${input.subjectValue}`;
  return hmacSha256Hex(input.secretKey, payload);
}

export interface SubjectHmacLookupCandidatesInput {
  readonly tenantId: string;
  readonly subjectKind: string;
  readonly subjectValue: string;
  readonly secretKeys: readonly string[];
  readonly version?: CanonicalSubjectHmacVersion;
}

/**
 * Returns the canonical `v1` digest PLUS legacy compatibility digests
 * (`value`, `kind:value`, `tenant:kind:value`) across current AND rotated
 * historical `secretKeys` so subject deletion matches both newly ingested
 * and legacy rows.
 */
export function computeSubjectHmacLookupCandidates(
  input: SubjectHmacLookupCandidatesInput
): readonly string[] {
  const version = input.version ?? SUBJECT_HMAC_VERSION;
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (digest: string) => {
    if (!seen.has(digest)) {
      seen.add(digest);
      out.push(digest);
    }
  };

  for (const secretKey of input.secretKeys) {
    // 1. Canonical v1 digest
    add(
      computeCanonicalSubjectHmac({
        tenantId: input.tenantId,
        subjectKind: input.subjectKind,
        subjectValue: input.subjectValue,
        secretKey,
        version,
      })
    );
    // 2. Legacy collector digest (value only)
    add(hmacSha256Hex(secretKey, input.subjectValue));
    // 3. Legacy opt-out worker digest (`kind:value`)
    add(hmacSha256Hex(secretKey, `${input.subjectKind}:${input.subjectValue}`));
    // 4. Legacy deletion engine digest (`tenant:kind:value`)
    add(hmacSha256Hex(secretKey, `${input.tenantId}:${input.subjectKind}:${input.subjectValue}`));
  }

  return out;
}

/**
 * Deterministic canonical JSON stringify (recursively sorts object keys).
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(record[k])}`
    );
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Unsupported value for canonical JSON serialization: ${typeof value}`);
}
