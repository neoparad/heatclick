/**
 * UGOKI LINK v2 — REST Route: `GET` / `POST` `/api/v1/sites/[siteId]/heatmap-image` (§11.12)
 *
 * - 取得毎認証 (署名付き URL 単独アクセス禁止: `x-ugk-principal-id` + `x-ugk-tenant-id` + `x-ugk-scopes` を毎回検証)
 * - `POST`: ヒートマップ描画要求を受け付け、版・案単位で分割した画像(base64 PNG)＋元数字＋共通返答形式を返却
 * - `GET`: `artifact_id` で保存済み画像またはメタデータを再認証＋削除/再集計世代再確認のうえ返却
 */

import { NextRequest, NextResponse } from 'next/server'

import type { Scope } from '@/lib/link/auth'
import {
  HeatmapRenderService,
  type HeatmapFetchPrincipal,
  type HeatmapRenderRequest,
} from '@/lib/link/heatmap-render'

const defaultHeatmapService = new HeatmapRenderService()

function extractPrincipalFromRequest(req: NextRequest): {
  readonly principal: HeatmapFetchPrincipal | null
  readonly signedUrlOnly: boolean
} {
  const signedOnlyParam = req.nextUrl.searchParams.get('sig')
  const principalId = req.headers.get('x-ugk-principal-id')?.trim()
  const tenantId = req.headers.get('x-ugk-tenant-id')?.trim()
  const scopesHeader = req.headers.get('x-ugk-scopes')?.trim()

  if (!principalId || !tenantId || !scopesHeader) {
    return {
      principal: null,
      signedUrlOnly: Boolean(signedOnlyParam),
    }
  }

  const scopes = scopesHeader
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as Scope[]
  const allowedSitesHeader = req.headers.get('x-ugk-allowed-sites')?.trim()
  const allowedSites: readonly string[] | '*' =
    !allowedSitesHeader || allowedSitesHeader === '*'
      ? '*'
      : allowedSitesHeader.split(',').map((s) => s.trim()).filter(Boolean)
  const epochRaw = Number(req.headers.get('x-ugk-revocation-epoch') ?? '0')
  const audienceRaw = req.headers.get('x-ugk-audience')?.trim()
  const audience: 'site_owner' | 'external_party' =
    audienceRaw === 'external_party' ? 'external_party' : 'site_owner'

  return {
    principal: Object.freeze({
      principal_id: principalId,
      tenant_id: tenantId,
      allowed_site_ids: allowedSites,
      scopes,
      token_revocation_epoch: Number.isFinite(epochRaw) ? epochRaw : 0,
      audience,
    }),
    signedUrlOnly: false,
  }
}

export async function GET(
  req: NextRequest,
  context: { params: { siteId: string } },
): Promise<NextResponse> {
  const artifactId = req.nextUrl.searchParams.get('artifact_id')?.trim()
  if (!artifactId) {
    return NextResponse.json(
      { ok: false, error: 'missing_artifact_id_query_param', site_id: context.params.siteId },
      { status: 400 },
    )
  }

  const { principal, signedUrlOnly } = extractPrincipalFromRequest(req)
  const result = defaultHeatmapService.fetchArtifactById({
    principal,
    artifact_id: artifactId,
    signed_url_token_only: signedUrlOnly,
    now_iso: new Date().toISOString(),
  })

  if (result.http_status !== 200 || !result.artifact) {
    return NextResponse.json(
      { ok: false, error: result.reason, artifact_id: artifactId },
      { status: result.http_status },
    )
  }

  const accept = req.headers.get('accept') ?? ''
  if (accept.includes('image/png') && result.png_bytes) {
    return new NextResponse(Buffer.from(result.png_bytes), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, no-store',
        'X-UGK-Artifact-Id': result.artifact.artifact_id,
        'X-UGK-Png-Sha256': result.artifact.png_sha256 ?? '',
      },
    })
  }

  return NextResponse.json(
    { ok: true, site_id: context.params.siteId, artifact: result.artifact },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function POST(
  req: NextRequest,
  context: { params: { siteId: string } },
): Promise<NextResponse> {
  const { principal } = extractPrincipalFromRequest(req)
  let body: Partial<HeatmapRenderRequest>
  try {
    body = (await req.json()) as Partial<HeatmapRenderRequest>
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json_body' }, { status: 400 })
  }

  if (!body.tenant_id || !body.page_url || !body.kind || !body.actor_bucket || !body.unit_datasets) {
    return NextResponse.json({ ok: false, error: 'missing_required_fields' }, { status: 400 })
  }

  const renderReq: HeatmapRenderRequest = {
    tenant_id: body.tenant_id,
    site_id: context.params.siteId,
    page_url: body.page_url,
    period_start: body.period_start ?? '2026-11-01T00:00:00Z',
    period_end: body.period_end ?? '2026-11-20T00:00:00Z',
    device_class: body.device_class ?? 'desktop',
    kind: body.kind,
    lane: body.lane ?? 'standard_telemetry',
    actor_bucket: body.actor_bucket,
    verdict_version: body.verdict_version ?? 'verdict/1',
    segment_id: body.segment_id ?? 'all',
    consent_mode: body.consent_mode ?? 'full',
    granted_purposes: body.granted_purposes ?? ['standard_analytics'],
    jurisdiction: body.jurisdiction ?? 'JP',
    sdk_capability: body.sdk_capability ?? 'full',
    custom_event_mapped_to_page_version_position: body.custom_event_mapped_to_page_version_position,
    requested_metric_keys: body.requested_metric_keys,
    model_inferred_header: body.model_inferred_header,
    unit_datasets: body.unit_datasets,
    custom_display_label: body.custom_display_label,
    requested_at: body.requested_at ?? new Date().toISOString(),
  }

  try {
    const res = defaultHeatmapService.renderHeatmap(principal, renderReq)
    return NextResponse.json(res, {
      status: res.http_status,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'render_failed' },
      { status: 400 },
    )
  }
}
