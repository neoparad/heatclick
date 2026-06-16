/**
 * M-Director Stage 3 (続 M-10) — POST /api/banner-assets/sign-url
 *
 * Issues a Cloudflare R2 presigned PUT URL so the client can upload a banner
 * image directly to R2 (no Vercel function bandwidth used for the file body).
 *
 * Flow:
 *   1. Client: POST { scenario_id, filename, content_type, byte_size } → here
 *   2. Server: validate (filename / mime / size) → generate asset_id (UUID) →
 *      sign URL via lib/scenarios/r2-signed-url.ts → write metadata to KV
 *      (`scenario_assets/{tenant}/{scenario_id}/{asset_id}`, status='pending') →
 *      return { upload_url, public_url, asset_id, expires_at }
 *   3. Client: PUT file binary to upload_url with Content-Type header
 *   4. Client: update scenario.variants[N].image_url = public_url, save scenario
 *
 * Limits (Phase 2):
 *   - max 5 MB per image (Vercel-side limit + R2 cost containment)
 *   - allowed MIME: image/png, image/jpeg, image/webp, image/gif
 *   - allowed extensions: .png, .jpg, .jpeg, .webp, .gif
 *
 * Reference:
 *   - 続 M-9 §6 #3 (Stage 3 計画)
 *   - 続 M-7 §3 (KV key 設計、scenario_assets prefix)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { getDefaultStorage } from '@/lib/scenarios/kv-storage'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import {
  R2ConfigError,
  buildAssetObjectKey,
  signR2PutUrl,
} from '@/lib/scenarios/r2-signed-url'
import { createScenarioRepository } from '@/lib/scenarios/repository'
import { isTenantContext, resolveScenarioTenantContext } from '@/lib/scenarios/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MiB

const ALLOWED_MIME_BY_EXT: Record<string, string[]> = {
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.webp': ['image/webp'],
  '.gif': ['image/gif'],
}

// REQ-SEC-004: tenant_id is NOT accepted from the body — it is derived from the JWT.
// site_id is required so we can verify the target scenario belongs to the caller's tenant/site
// before minting an upload URL under that tenant's asset prefix.
const RequestSchema = z.object({
  scenario_id: z.string().regex(/^[0-9a-f-]{36}$/i, 'must be UUID v4'),
  site_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'site_id must be [A-Za-z0-9_-]+'),
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/, 'filename must be [A-Za-z0-9._-]+'),
  content_type: z.string().min(1).max(64),
  byte_size: z.number().int().positive().max(MAX_BYTES),
})

interface AssetMetadata {
  asset_id: string
  scenario_id: string
  tenant_id: string
  storage_key: string
  public_url: string
  mime_type: string
  byte_size: number
  status: 'pending' | 'uploaded' | 'failed'
  uploaded_by: string
  created_at: string
  expires_at: string
}

function validateMimeAgainstFilename(filename: string, mime: string): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  const ext = filename.slice(dot).toLowerCase()
  const allowed = ALLOWED_MIME_BY_EXT[ext]
  if (!allowed) return false
  return allowed.includes(mime.toLowerCase())
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = RequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    )
  }

  // REQ-SEC-004/126: tenant_id from JWT (getServerSession); body site_id must be in JWT site_ids.
  const ctx = await resolveScenarioTenantContext(request, parsed.data.site_id)
  if (!isTenantContext(ctx)) return ctx
  const tenantId = ctx.tenantId

  if (!validateMimeAgainstFilename(parsed.data.filename, parsed.data.content_type)) {
    return NextResponse.json(
      {
        error: 'invalid_mime',
        message: `filename "${parsed.data.filename}" and content_type "${parsed.data.content_type}" do not match an allowed image type`,
        allowed_extensions: Object.keys(ALLOWED_MIME_BY_EXT),
      },
      { status: 400 },
    )
  }

  // REQ-SEC-004: verify the target scenario actually belongs to this tenant/site BEFORE
  // signing an upload URL under that tenant's asset prefix. getScenario re-checks the row's
  // own tenant_id/site_id (assertScenarioOwnership) and returns null when absent.
  try {
    const repo = createScenarioRepository()
    const owned = await repo.getScenario(tenantId, ctx.siteId, parsed.data.scenario_id)
    if (!owned) {
      return NextResponse.json(
        { error: 'scenario_not_found', message: 'scenario does not exist for this tenant/site' },
        { status: 404 },
      )
    }
  } catch (e) {
    if (e instanceof CloudflareKvError) {
      // eslint-disable-next-line no-console
      console.error(`[banner-assets/sign-url] ownership check KV error: ${e.message}`)
      return NextResponse.json(
        { error: 'storage_error', message: 'ownership check failed' },
        { status: 502 },
      )
    }
    // eslint-disable-next-line no-console
    console.error('[banner-assets/sign-url] ownership check failed', e)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  const assetId = randomUUID()
  const objectKey = buildAssetObjectKey({
    tenantId,
    scenarioId: parsed.data.scenario_id,
    assetId,
    filename: parsed.data.filename,
  })

  try {
    const signed = await signR2PutUrl({
      key: objectKey,
      contentType: parsed.data.content_type,
    })

    const metadata: AssetMetadata = {
      asset_id: assetId,
      scenario_id: parsed.data.scenario_id,
      tenant_id: tenantId,
      storage_key: signed.storageKey,
      public_url: signed.publicUrl,
      mime_type: parsed.data.content_type,
      byte_size: parsed.data.byte_size,
      status: 'pending',
      uploaded_by: ctx.userId,
      created_at: signed.signedAt,
      expires_at: signed.expiresAt,
    }

    // KV write: scenario_assets/{tenant}/{scenario_id}/{asset_id}
    const kvKey = `scenario_assets/${tenantId}/${parsed.data.scenario_id}/${assetId}`
    try {
      await getDefaultStorage().putJson(kvKey, metadata)
    } catch (e) {
      if (e instanceof CloudflareKvError) {
        // eslint-disable-next-line no-console
        console.warn(
          `[banner-assets/sign-url] KV metadata write failed (continuing): ${e.message}`,
        )
        // 続行: R2 アップロード自体は signed URL で動く、metadata は best-effort
      } else {
        throw e
      }
    }

    return NextResponse.json(
      {
        asset_id: assetId,
        upload_url: signed.uploadUrl,
        public_url: signed.publicUrl,
        storage_key: signed.storageKey,
        expires_at: signed.expiresAt,
        content_type: parsed.data.content_type,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    if (e instanceof R2ConfigError) {
      return NextResponse.json(
        {
          error: 'r2_config_missing',
          message: e.message,
          owner_action:
            'Cloudflare dashboard で R2 API token を発行し、Vercel project env に R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET を投入してください (続 M-10 §Owner runbook 参照)',
        },
        { status: 503 },
      )
    }
    // eslint-disable-next-line no-console
    console.error('[banner-assets/sign-url] unhandled', e)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
