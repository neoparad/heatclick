/**
 * WebCrypto Ed25519 / SHA-256 / SRI helpers for `workers/link-signer`.
 * Runs identically in Cloudflare Workers, modern browsers, and Node 20+.
 */

import type { PublicKeyJwkLike } from './types';

function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new Error('WebCrypto subtle API is unavailable in this runtime');
  }
  return globalThis.crypto.subtle;
}

export function utf8Encode(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

export async function sha256Bytes(data: string | Uint8Array): Promise<Uint8Array> {
  const raw = typeof data === 'string' ? utf8Encode(data) : data;
  const digest = await getSubtle().digest('SHA-256', toArrayBuffer(raw));
  return new Uint8Array(digest);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(data));
}

export async function sha256Sri(data: string | Uint8Array): Promise<string> {
  return `sha256-${bytesToBase64(await sha256Bytes(data))}`;
}

export interface Ed25519KeyPairHandle {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyJwk: PublicKeyJwkLike;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPairHandle> {
  const generated = (await getSubtle().generateKey(
    { name: 'Ed25519' } as AlgorithmIdentifier,
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;

  const exported = (await getSubtle().exportKey('jwk', generated.publicKey)) as PublicKeyJwkLike;
  return {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    publicKeyJwk: exported,
  };
}

export async function importEd25519PublicKey(jwk: PublicKeyJwkLike): Promise<CryptoKey> {
  return getSubtle().importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'Ed25519' } as AlgorithmIdentifier,
    true,
    ['verify']
  );
}

export async function signEd25519Bytes(
  privateKey: CryptoKey,
  data: Uint8Array
): Promise<string> {
  const sig = await getSubtle().sign(
    { name: 'Ed25519' } as AlgorithmIdentifier,
    privateKey,
    toArrayBuffer(data)
  );
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyEd25519Bytes(
  publicKey: CryptoKey,
  data: Uint8Array,
  signatureB64: string
): Promise<boolean> {
  try {
    const sigBytes = base64ToBytes(signatureB64);
    return await getSubtle().verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      publicKey,
      toArrayBuffer(sigBytes),
      toArrayBuffer(data)
    );
  } catch {
    return false;
  }
}

export async function signCanonicalObject(
  privateKey: CryptoKey,
  obj: unknown
): Promise<{ readonly sha256: string; readonly sigB64: string }> {
  const serialized = canonicalJson(obj);
  const bytes = utf8Encode(serialized);
  const sha256 = await sha256Hex(bytes);
  const sigB64 = await signEd25519Bytes(privateKey, bytes);
  return { sha256, sigB64 };
}

export async function verifyCanonicalObject(
  publicKey: CryptoKey,
  obj: unknown,
  signatureB64: string
): Promise<boolean> {
  const bytes = utf8Encode(canonicalJson(obj));
  return verifyEd25519Bytes(publicKey, bytes, signatureB64);
}
