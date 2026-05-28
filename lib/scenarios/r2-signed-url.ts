/**
 * M-Director Stage 3 (続 M-10) — R2 presigned URL generator (manual S3 v4 signing)
 *
 * Reference:
 *   - 続 M-9 §6 Stage 3 計画 (R2 signed URL 発行 + Vercel から直接 R2 PUT)
 *   - AWS SigV4 spec: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 *   - Cloudflare R2 S3 互換 API: https://developers.cloudflare.com/r2/api/s3/api/
 *
 * Why manual signing (not aws4fetch / @aws-sdk):
 *   - 新規 npm dep を追加せず、Web Crypto API のみで完結 (Edge runtime + Vercel Functions 両対応)
 *   - ~140 行で完結、単体テスト可能
 *   - aws4fetch / @aws-sdk のサイズ (10KB+) を回避
 *
 * Owner action (Stage 3 配備後):
 *   1. Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API token
 *      permissions: Object Read & Write, bucket=banner-assets
 *   2. access_key_id + secret_access_key を Vercel project env に投入
 *      R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ACCOUNT_ID / R2_BUCKET
 */

const R2_REGION = 'auto'
const R2_SERVICE = 's3'
const SIGNED_URL_TTL_SEC = 300 // 5 分有効、upload 後すぐ無効化

export interface R2Config {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export class R2ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'R2ConfigError'
  }
}

export function getR2ConfigFromEnv(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID
  const bucket = process.env.R2_BUCKET ?? 'banner-assets'
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new R2ConfigError(
      'R2 env missing: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
    )
  }
  return { accountId, bucket, accessKeyId, secretAccessKey }
}

export interface SignedPutUrlInput {
  /** object key (e.g. `assets/{scenario_id}/{asset_id}.png`) */
  key: string
  /** MIME type, e.g. `image/png` */
  contentType: string
  /** TTL override (default 300s) */
  ttlSec?: number
  /** test 用 deterministic clock */
  now?: Date
  /** test 用 R2 config override (default = env) */
  config?: R2Config
}

export interface SignedPutUrlResult {
  /** PUT 用の signed URL (5 min 有効) */
  uploadUrl: string
  /** upload 完了後の public URL (Stage 3 では public bucket、Stage 6 で signed GET も検討) */
  publicUrl: string
  /** R2 internal key (DB metadata 用) */
  storageKey: string
  /** signed at timestamp ISO (audit + invalidation 用) */
  signedAt: string
  /** expires at timestamp ISO */
  expiresAt: string
}

/**
 * R2 への presigned PUT URL を発行する。
 * 発行後、5 分以内に client から PUT で multipart upload する。
 */
export async function signR2PutUrl(input: SignedPutUrlInput): Promise<SignedPutUrlResult> {
  const cfg = input.config ?? getR2ConfigFromEnv()
  const ttl = input.ttlSec ?? SIGNED_URL_TTL_SEC
  if (ttl < 60 || ttl > 7 * 24 * 3600) {
    throw new R2ConfigError(`invalid ttl: ${ttl} (must be 60..604800)`)
  }
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + ttl * 1000)

  // Endpoint: <account_id>.r2.cloudflarestorage.com
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`
  const objectPath = `/${cfg.bucket}/${encodeR2Key(input.key)}`

  // SigV4 query-string signing (presigned URL pattern)
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8) // YYYYMMDD
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`
  const algorithm = 'AWS4-HMAC-SHA256'

  // Query params (alphabetical, AWS spec)
  const params = new URLSearchParams()
  params.set('X-Amz-Algorithm', algorithm)
  params.set('X-Amz-Credential', `${cfg.accessKeyId}/${credentialScope}`)
  params.set('X-Amz-Date', amzDate)
  params.set('X-Amz-Expires', String(ttl))
  params.set('X-Amz-SignedHeaders', 'host')

  // Canonical request
  const canonicalQueryString = sortQueryParams(params)
  const canonicalHeaders = `host:${host}\n`
  const signedHeaders = 'host'
  const payloadHash = 'UNSIGNED-PAYLOAD' // presigned URLs use this literal
  const canonicalRequest = [
    'PUT',
    objectPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const canonicalRequestHash = await sha256Hex(canonicalRequest)
  const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n')

  // Signing key derivation chain
  const kDate = await hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp)
  const kRegion = await hmacSha256(kDate, R2_REGION)
  const kService = await hmacSha256(kRegion, R2_SERVICE)
  const kSigning = await hmacSha256(kService, 'aws4_request')

  const signature = bytesToHex(await hmacSha256(kSigning, stringToSign))
  params.set('X-Amz-Signature', signature)

  const uploadUrl = `https://${host}${objectPath}?${params.toString()}`

  // Public URL = R2 dev URL (Stage 3 では bucket public access 想定、Stage 6 で domain mapping)
  // 注意: bucket public access は別途 Cloudflare dashboard で有効化必要 (Stage 3 Owner runbook で明示)
  const publicUrl = `https://${host}${objectPath}`

  return {
    uploadUrl,
    publicUrl,
    storageKey: `${cfg.bucket}/${input.key}`,
    signedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

// ── crypto helpers (Web Crypto only) ───────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return bytesToHex(new Uint8Array(buf))
}

async function hmacSha256(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
  // TS modern Uint8Array<ArrayBufferLike> ↔ Web Crypto BufferSource 互換のため明示 cast。
  // Web Crypto は ArrayBuffer / TypedArray を受け付けるため runtime は問題なし。
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(data) as unknown as BufferSource,
  )
  return new Uint8Array(sig)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── path / query helpers ───────────────────────────────────────────────────

/**
 * R2 object key encoding. Slashes are kept; other chars per RFC 3986.
 * AWS SigV4 requires path components to be encoded the same way during signing
 * and during the actual request.
 */
export function encodeR2Key(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
    )
    .join('/')
}

function sortQueryParams(params: URLSearchParams): string {
  const pairs: string[] = []
  for (const [k, v] of params) {
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  pairs.sort()
  return pairs.join('&')
}

function formatAmzDate(d: Date): string {
  // YYYYMMDDTHHMMSSZ
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

// ── object key 採番 (scenario_id + asset_id + 拡張子) ──────────────────────

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/

export function buildAssetObjectKey(input: {
  tenantId: string
  scenarioId: string
  assetId: string
  filename: string
}): string {
  const ext = extractExtension(input.filename)
  if (!ext) {
    throw new R2ConfigError(`filename must have an extension: ${input.filename}`)
  }
  return `assets/${input.tenantId}/${input.scenarioId}/${input.assetId}${ext}`
}

function extractExtension(filename: string): string | null {
  if (!SAFE_FILENAME.test(filename)) return null
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filename.slice(dot).toLowerCase()
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return null
  return ext
}
