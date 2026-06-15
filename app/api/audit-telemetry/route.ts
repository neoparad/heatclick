/**
 * POST /api/audit-telemetry — tracking.js audit beacon receiver (Wave 3-C R7-9 §1.2.2 + §1.2.3)
 *
 * 親 SSOT §1.6 原則 2 (Evidence Level) / §3.8.1 (multi-tenant) / D-07
 * 設計 SSOT: decisions.md 続 36 §1.2.2 / §1.4 #7 / §6.1 (本続 42 で配備)
 *
 * 目的:
 *   tracking.js client side で発生する以下 3 種を観測可能化:
 *     §1.2.1 debug mode (?ugoki_debug=1): 100% audit beacon (response.status + reason 観測)
 *     §1.2.2 sampling telemetry: 5% で sendBeacon 成功時の audit beacon
 *     §1.2.3 sendBeacon 失敗時: 100% audit beacon (sampling 対象外、失敗観測必須)
 *
 * フロー:
 *   tracking.js (顧客サイト) → POST /api/audit-telemetry (Next.js Route Handler)
 *     → Zod 検証 → rate limit (IP) → ClickHouse audit_telemetry table 書込 (HTTP API)
 *     → Sentry breadcrumb (failure_status / reason / tracking_id PII redact 経由)
 *
 * 注:
 *   - 顧客サイト埋込 tracking.js から直叩き = 認証なし (CORS で送信元制限なし、tenant_id は client-claimed)
 *   - rate limit は anonymizeIp(/24 mask) per minute、Phase 1 free プラン共有上限
 *   - ClickHouse audit_telemetry table は本続 42 で Infra 配備要請 (続 36 §6.1 SQL spec)
 *     Phase 1 は audit_events table への INSERT (action='tracking.telemetry') で代替可
 */

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { z } from 'zod'

import { anonymizeIp, redactPII } from '@/lib/privacy'
import { checkRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── schema ─────────────────────────────────────────────────────────

const beaconAttemptEnum = z.enum([
  'sendBeacon',
  'sendBeacon_failed',
  'fetch',
])

const auditTelemetrySchema = z.object({
  tracking_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  tenant_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  status: z.number().int().min(0).max(599),
  reason: z.string().min(1).max(64),
  sampled_at: z.string().datetime({ offset: true }).optional(),
  beacon_attempt: beaconAttemptEnum,
  payload_size: z.number().int().min(0).max(1_000_000).optional(),
})

type AuditTelemetry = z.infer<typeof auditTelemetrySchema>

// ── ClickHouse client (minimal HTTP API) ────────────────────────────

interface ClickHouseConfig {
  baseUrl: string
  database: string
  authHeader: string
}

function getClickHouseConfig(): ClickHouseConfig | null {
  const url = process.env.CLICKHOUSE_URL
  const database = process.env.CLICKHOUSE_DB || 'clickinsight'
  if (!url) return null
  try {
    const parsed = new URL(url)
    const user = decodeURIComponent(parsed.username || 'default')
    const password = decodeURIComponent(parsed.password || '')
    parsed.username = ''
    parsed.password = ''
    const baseUrl = parsed.toString().replace(/\/$/, '')
    const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
    return { baseUrl, database, authHeader }
  } catch {
    return null
  }
}

async function insertAuditTelemetry(
  payload: AuditTelemetry,
  ipAnon: string,
  userAgent: string,
  requestId: string,
): Promise<{ ok: boolean; error?: string }> {
  const config = getClickHouseConfig()
  if (!config) {
    return { ok: false, error: 'clickhouse_unconfigured' }
  }

  // Phase 1: audit_telemetry table 配備前は audit_events table への INSERT で代替可
  // (続 36 §6.1 Infra 配備要請、本続 42 で Infra → audit_telemetry 配備後切替)
  // ここでは audit_telemetry 経路を採用、未配備時は Infra 配備後 INSERT 成功する想定
  const row = {
    tenant_id: payload.tenant_id || '__unknown__',
    tracking_id: payload.tracking_id,
    status: payload.status,
    reason: payload.reason,
    beacon_attempt: payload.beacon_attempt,
    sampled_at: payload.sampled_at || new Date().toISOString(),
    payload_size: payload.payload_size ?? 0,
    ip_anonymized: ipAnon,
    user_agent: redactPII(userAgent).slice(0, 256),
    request_id: requestId,
  }

  const body = JSON.stringify(row) + '\n'
  const insertUrl = `${config.baseUrl}/?database=${encodeURIComponent(config.database)}`
    + `&query=${encodeURIComponent('INSERT INTO audit_telemetry FORMAT JSONEachRow')}`
    + `&input_format_skip_unknown_fields=1`

  try {
    const resp = await fetch(insertUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: config.authHeader,
      },
      body,
    })
    if (!resp.ok) {
      const respText = await resp.text().catch(() => '')
      // PII / credentials が含まれないことは Authorization header 側で保証 (URL 経由 user:pass なし)
      return { ok: false, error: `ch_${resp.status}_${respText.slice(0, 128)}` }
    }
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return { ok: false, error: `network_${msg.slice(0, 128)}` }
  }
}

// ── handler ────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
  // 1. headers
  const h = headers()
  const ipRaw = h.get('cf-connecting-ip')
    || h.get('x-real-ip')
    || h.get('x-forwarded-for')?.split(',')[0]?.trim()
    || ''
  const ipAnon = anonymizeIp(ipRaw)
  const userAgent = h.get('user-agent') || ''
  const requestId = h.get('cf-ray') || h.get('x-vercel-id') || ''

  // 2. rate limit (IP /24 単位、free プラン 10 req/min)
  //    続 36 §4.5 Q5: 5% sampling + 1000 events/min site = 50 audit/min/site、
  //    100 sites = 5000 audit/min global、free plan 10/min は IP /24 単位なので問題なし
  if (ipAnon) {
    const rl = await checkRateLimit(`audit-telemetry:${ipAnon}`, 'free')
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit, resetTime: rl.resetTime },
        { status: 429 },
      )
    }
  }

  // 3. body parse + validate
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = auditTelemetrySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    )
  }

  // 4. ClickHouse INSERT (audit_telemetry table)
  const result = await insertAuditTelemetry(parsed.data, ipAnon, userAgent, requestId)
  if (!result.ok) {
    // ClickHouse 失敗時でも client には 202 返却 (audit は fire-and-forget、primary ingest を阻害しない)
    // 内部 error は構造化 log で Sentry breadcrumb 化 (Sentry SDK が auto-instrument)
    // eslint-disable-next-line no-console -- Sentry breadcrumb 経路
    console.error(`[audit-telemetry] insert failed: ${result.error}`, {
      tracking_id: parsed.data.tracking_id,
      tenant_id: parsed.data.tenant_id,
      reason: parsed.data.reason,
      beacon_attempt: parsed.data.beacon_attempt,
    })
    return NextResponse.json({ status: 'accepted', persisted: false }, { status: 202 })
  }

  return NextResponse.json({ status: 'ok', persisted: true }, { status: 200 })
}

// ── CORS (顧客サイト埋込 tracking.js から叩かれるため OPTIONS preflight 要、ただし simple POST + application/json は preflight 必要) ──

export async function OPTIONS(request: Request): Promise<NextResponse> {
  const origin = request.headers.get('origin') || '*'
  return new NextResponse(null, {
    status: 204,
    headers: {
      // 顧客サイト多数のため origin 動的反映 (audit-telemetry は認証なし、tenant_id は client-claimed のため security 影響なし)
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    },
  })
}
