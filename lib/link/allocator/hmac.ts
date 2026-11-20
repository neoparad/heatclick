/**
 * Pure synchronous zero-dependency HMAC-SHA256 & EV M1 uniform draw function.
 *
 * Uses `sha256Bytes` from `packages/contract/schema` so every Allocator draw
 * is 100% deterministic, synchronous, and byte-identical across Cloudflare Workers,
 * Node.js servers, and browser runtimes.
 *
 * Formula (EV M1): `u(key, unit_id) = uint32_be(HMAC-SHA256(key, unit_id)[0..4]) / 2^32`
 */

import { sha256Bytes, utf8ToBytes } from '../../../packages/contract/schema';

const BLOCK_SIZE = 64; // SHA-256 block size in bytes

export function hmacSha256Bytes(
  key: string | Uint8Array,
  message: string | Uint8Array
): Uint8Array {
  const keyRaw = typeof key === 'string' ? utf8ToBytes(key) : key;
  const msgRaw = typeof message === 'string' ? utf8ToBytes(message) : message;

  const keyBlock = new Uint8Array(BLOCK_SIZE);
  if (keyRaw.length > BLOCK_SIZE) {
    keyBlock.set(sha256Bytes(keyRaw), 0);
  } else {
    keyBlock.set(keyRaw, 0);
  }

  const ipad = new Uint8Array(BLOCK_SIZE + msgRaw.length);
  const opad = new Uint8Array(BLOCK_SIZE + 32);

  for (let i = 0; i < BLOCK_SIZE; i++) {
    ipad[i] = keyBlock[i] ^ 0x36;
    opad[i] = keyBlock[i] ^ 0x5c;
  }
  ipad.set(msgRaw, BLOCK_SIZE);

  const innerHash = sha256Bytes(ipad);
  opad.set(innerHash, BLOCK_SIZE);
  return sha256Bytes(opad);
}

export function hmacSha256Hex(
  key: string | Uint8Array,
  message: string | Uint8Array
): string {
  const bytes = hmacSha256Bytes(key, message);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Deterministic uniform float `u in [0, 1)` per EV M1:
 * `HMAC-SHA256(key, unit_id)[0..4] / 2^32`.
 */
export function drawUniformU(key: string, unitId: string): number {
  const digest = hmacSha256Bytes(key, unitId);
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const uint32 = view.getUint32(0, false);
  return uint32 / 0x100000000;
}

/**
 * Deterministic 128-bit lowercase hex decision ID derived from HMAC-SHA256.
 */
export function deriveDecisionId(
  secret: string,
  tenantId: string,
  siteId: string,
  pvId: string,
  layerId: string,
  decisionNo: number
): string {
  return hmacSha256Hex(
    secret,
    `ugk:decision_id:${tenantId}:${siteId}:${pvId}:${layerId}:${decisionNo}`
  ).slice(0, 32);
}
