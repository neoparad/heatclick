/**
 * Unit tests: lib/scenarios/r2-signed-url + sign-url API contract
 * (M-Director Stage 3 / 続 M-10、2026-05-28)
 *
 * Reference:
 *   - lib/scenarios/r2-signed-url.ts (manual SigV4 implementation)
 *   - app/api/banner-assets/sign-url/route.ts (Sign URL POST endpoint)
 *   - AWS SigV4 spec: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 *
 * Strategy: mirror lib/scenarios/r2-signed-url.ts logic in plain JS so tests
 * can run under bare `node --test`. Validates:
 *   - encodeR2Key path encoding
 *   - SigV4 canonical query sort
 *   - HMAC chain key derivation
 *   - filename → extension extraction
 *   - MIME / extension allowlist
 *
 * Usage:
 *   node --test tests/unit/scenarios-r2-upload.test.mjs
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'

// ── Mirror: encodeR2Key (lib/scenarios/r2-signed-url.ts) ──

function encodeR2Key(key) {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
    )
    .join('/')
}

// ── Mirror: buildAssetObjectKey ──

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/

function extractExtension(filename) {
  if (!SAFE_FILENAME.test(filename)) return null
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filename.slice(dot).toLowerCase()
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return null
  return ext
}

function buildAssetObjectKey({ tenantId, scenarioId, assetId, filename }) {
  const ext = extractExtension(filename)
  if (!ext) throw new Error(`filename must have an extension: ${filename}`)
  return `assets/${tenantId}/${scenarioId}/${assetId}${ext}`
}

// ── Mirror: SigV4 helpers (Web Crypto → node:crypto for tests) ──

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function formatAmzDate(d) {
  const pad = (n) => n.toString().padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

function sortQueryParams(params) {
  const pairs = []
  for (const [k, v] of params) {
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  pairs.sort()
  return pairs.join('&')
}

// ── Mirror: signR2PutUrl ──

function signR2PutUrl({ key, contentType, accountId, bucket, accessKeyId, secretAccessKey, now, ttlSec = 300 }) {
  const host = `${accountId}.r2.cloudflarestorage.com`
  const objectPath = `/${bucket}/${encodeR2Key(key)}`
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const algorithm = 'AWS4-HMAC-SHA256'

  const params = new URLSearchParams()
  params.set('X-Amz-Algorithm', algorithm)
  params.set('X-Amz-Credential', `${accessKeyId}/${credentialScope}`)
  params.set('X-Amz-Date', amzDate)
  params.set('X-Amz-Expires', String(ttlSec))
  params.set('X-Amz-SignedHeaders', 'host')

  const canonicalQueryString = sortQueryParams(params)
  const canonicalHeaders = `host:${host}\n`
  const canonicalRequest = [
    'PUT',
    objectPath,
    canonicalQueryString,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const canonicalRequestHash = sha256Hex(canonicalRequest)
  const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n')

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, 'auto')
  const kService = hmacSha256(kRegion, 's3')
  const kSigning = hmacSha256(kService, 'aws4_request')
  const signature = bytesToHex(hmacSha256(kSigning, stringToSign))

  params.set('X-Amz-Signature', signature)
  return {
    uploadUrl: `https://${host}${objectPath}?${params.toString()}`,
    publicUrl: `https://${host}${objectPath}`,
    signature,
    contentType,
  }
}

// ── MIME / extension allowlist ──

const ALLOWED_MIME_BY_EXT = {
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.webp': ['image/webp'],
  '.gif': ['image/gif'],
}

function validateMimeAgainstFilename(filename, mime) {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  const ext = filename.slice(dot).toLowerCase()
  const allowed = ALLOWED_MIME_BY_EXT[ext]
  if (!allowed) return false
  return allowed.includes(mime.toLowerCase())
}

// ── Fixtures ──

const FIXED_NOW = new Date('2026-05-28T10:00:00.000Z')
const CONFIG = {
  accountId: '76c9d366fabdcc59d4bc9008c7936584',
  bucket: 'banner-assets',
  accessKeyId: 'TEST_ACCESS_KEY_ID',
  secretAccessKey: 'TEST_SECRET_ACCESS_KEY',
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('§1 encodeR2Key (path encoding)', () => {
  test('preserves slashes between path components', () => {
    assert.equal(encodeR2Key('assets/abc/def'), 'assets/abc/def')
  })
  test('encodes spaces in segments', () => {
    assert.equal(encodeR2Key('assets/my file.png'), 'assets/my%20file.png')
  })
  test('encodes special chars per RFC 3986', () => {
    // ! ' ( ) * are not encoded by encodeURIComponent but AWS SigV4 requires them
    assert.equal(encodeR2Key("seg!seg'seg(seg)seg*"), 'seg%21seg%27seg%28seg%29seg%2A')
  })
  test('handles deep paths', () => {
    const got = encodeR2Key('assets/linkth_internal/abc-def/ghi.png')
    assert.equal(got, 'assets/linkth_internal/abc-def/ghi.png')
  })
})

describe('§2 buildAssetObjectKey + extractExtension', () => {
  test('builds assets/{tenant}/{scenario}/{asset}{ext}', () => {
    const key = buildAssetObjectKey({
      tenantId: 'linkth_internal',
      scenarioId: '00000000-0000-4000-8000-00000000d001',
      assetId: 'aaaaaaaa-aaaa-4bbb-9ccc-dddddddddddd',
      filename: 'banner.png',
    })
    assert.equal(
      key,
      'assets/linkth_internal/00000000-0000-4000-8000-00000000d001/aaaaaaaa-aaaa-4bbb-9ccc-dddddddddddd.png',
    )
  })
  test('rejects filenames without extension', () => {
    assert.throws(
      () =>
        buildAssetObjectKey({
          tenantId: 't',
          scenarioId: 's',
          assetId: 'a',
          filename: 'no-extension',
        }),
      /must have an extension/,
    )
  })
  test('rejects filenames with unsafe chars', () => {
    assert.throws(
      () =>
        buildAssetObjectKey({
          tenantId: 't',
          scenarioId: 's',
          assetId: 'a',
          filename: 'has space.png',
        }),
      /must have an extension/,
    )
  })
  test('rejects extensions that are too long', () => {
    assert.equal(extractExtension('file.toolongextension'), null)
  })
})

describe('§3 SigV4 signing produces deterministic output', () => {
  test('same input → same signature', () => {
    const a = signR2PutUrl({
      ...CONFIG,
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    const b = signR2PutUrl({
      ...CONFIG,
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    assert.equal(a.signature, b.signature)
    assert.equal(a.uploadUrl, b.uploadUrl)
  })
  test('different secret key → different signature', () => {
    const a = signR2PutUrl({
      ...CONFIG,
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    const b = signR2PutUrl({
      ...CONFIG,
      secretAccessKey: 'DIFFERENT_SECRET',
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    assert.notEqual(a.signature, b.signature)
  })
  test('uploadUrl contains required SigV4 query params', () => {
    const result = signR2PutUrl({
      ...CONFIG,
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    const u = new URL(result.uploadUrl)
    assert.ok(u.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256')
    assert.ok(u.searchParams.get('X-Amz-Credential')?.startsWith('TEST_ACCESS_KEY_ID/'))
    assert.ok(u.searchParams.get('X-Amz-Date'))
    assert.ok(u.searchParams.get('X-Amz-Expires') === '300')
    assert.ok(u.searchParams.get('X-Amz-SignedHeaders') === 'host')
    assert.match(u.searchParams.get('X-Amz-Signature') || '', /^[a-f0-9]{64}$/)
  })
  test('host matches R2 account endpoint', () => {
    const result = signR2PutUrl({
      ...CONFIG,
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    const u = new URL(result.uploadUrl)
    assert.equal(u.host, '76c9d366fabdcc59d4bc9008c7936584.r2.cloudflarestorage.com')
  })
  test('publicUrl is identical to uploadUrl without query string', () => {
    const result = signR2PutUrl({
      ...CONFIG,
      key: 'assets/t/s/a.png',
      contentType: 'image/png',
      now: FIXED_NOW,
    })
    const u = new URL(result.uploadUrl)
    const expectedPublic = `${u.protocol}//${u.host}${u.pathname}`
    assert.equal(result.publicUrl, expectedPublic)
  })
})

describe('§4 MIME / extension allowlist', () => {
  test('PNG: .png + image/png allowed', () => {
    assert.equal(validateMimeAgainstFilename('a.png', 'image/png'), true)
  })
  test('JPG: .jpg + image/jpeg allowed', () => {
    assert.equal(validateMimeAgainstFilename('a.jpg', 'image/jpeg'), true)
    assert.equal(validateMimeAgainstFilename('a.jpeg', 'image/jpeg'), true)
  })
  test('WebP allowed', () => {
    assert.equal(validateMimeAgainstFilename('a.webp', 'image/webp'), true)
  })
  test('GIF allowed', () => {
    assert.equal(validateMimeAgainstFilename('a.gif', 'image/gif'), true)
  })
  test('extension/MIME mismatch rejected (e.g. .png with image/jpeg)', () => {
    assert.equal(validateMimeAgainstFilename('a.png', 'image/jpeg'), false)
  })
  test('disallowed types rejected (.svg / .pdf / .exe)', () => {
    assert.equal(validateMimeAgainstFilename('a.svg', 'image/svg+xml'), false)
    assert.equal(validateMimeAgainstFilename('a.pdf', 'application/pdf'), false)
    assert.equal(validateMimeAgainstFilename('virus.exe', 'application/octet-stream'), false)
  })
  test('case-insensitive MIME match (image/PNG ≈ image/png)', () => {
    assert.equal(validateMimeAgainstFilename('a.png', 'image/PNG'), true)
  })
})

describe('§5 SigV4 canonical query string ordering invariants', () => {
  test('query params are alphabetically sorted', () => {
    const params = new URLSearchParams()
    params.set('X-Amz-SignedHeaders', 'host')
    params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
    params.set('X-Amz-Date', '20260528T100000Z')
    const sorted = sortQueryParams(params)
    // canonical order: Algorithm < Date < SignedHeaders
    const parts = sorted.split('&')
    assert.ok(parts[0].startsWith('X-Amz-Algorithm='))
    assert.ok(parts[1].startsWith('X-Amz-Date='))
    assert.ok(parts[2].startsWith('X-Amz-SignedHeaders='))
  })
})
