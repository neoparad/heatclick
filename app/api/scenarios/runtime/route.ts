/**
 * GET /api/scenarios/runtime — M-Director Sprint M-1 (2026-05-25)
 *
 * Serves the per-tenant/per-site scenario runtime payload to public/scenario-runtime.js.
 *
 * Reference:
 *   - linkscrawl/docs/fusion/team/m-director/data-model.md §4.2
 *   - linkscrawl/docs/fusion/team/m-director/prd.md §3 Path C
 *
 * Phase 1 strategy:
 *   - Reads in-memory hard-code (lib/scenarios/poc-scenario.ts)
 *   - public endpoint (no JWT) because tracking.js v2 already runs on customer pages
 *     and the runtime payload contains no PII — only condition AST + variant HTML.
 *   - tenant_id + site_id are NOT required to match a pre-registered site_id record: any
 *     syntactically valid pair (see QuerySchema) that simply has zero active scenarios is a
 *     normal, expected state for real customer traffic (most pageviews have no live scenario
 *     running). That case returns HTTP 200 with an empty `scenarios: []` payload — not 404 —
 *     so it does not show up as console/network error noise on every customer pageview.
 *     Malformed query params (missing/invalid tenant_id or site_id) still return 400.
 *
 * REQ-SEC-006 (don't public-cache executable config + kill-switch):
 *   - This payload contains EXECUTABLE config (inline HTML the runtime injects). It is served
 *     with `Cache-Control: no-store` so a poisoned/compromised entry cannot fan out via CDN
 *     for minutes and an emergency kill takes effect on the very next request (no TTL wait).
 *   - A kill-switch (lib/scenarios/kill-switch.ts) is consulted on every serve, independent
 *     of any cache: global / per-tenant / per-scenario disable flags drop scenarios at serve
 *     time. If everything is killed, we serve the empty-scenarios 200 payload (see above).
 *   - `preview` status is NOT exposed in this public payload — preview is for authoring/QA,
 *     not for delivery to every anonymous visitor. Only `live` (+ measure-path) reaches here.
 *
 * Phase 2: backing store switches to PostgreSQL `scenarios` table.
 * Phase 3: JWT-gated CRUD endpoints (POST/PUT/DELETE) live separately under /api/scenarios/[id].
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getPocScenariosForTenant } from '@/lib/scenarios/poc-scenario'
import { canonicalizeAst } from '@/lib/scenarios/evaluator'
import {
  isScenarioDeliveryGloballyDisabled,
  isDeliveryKilled,
} from '@/lib/scenarios/kill-switch'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { ScenarioValidationError, createScenarioRepository } from '@/lib/scenarios/repository'
import { isScenarioInSchedule } from '@/lib/scenarios/schedule-utils'
import {
  ScenarioRuntimePayloadSchema,
  type Scenario,
  type ScenarioRuntime,
  type ScenarioRuntimePayload,
} from '@/lib/scenarios/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 続120 (Stage2 配信): CORS。本ルートは customer サイト (別オリジン) で動く
 * public/scenario-runtime.js から cross-origin fetch される。payload は PII を含まない
 * public な live バナー config のみ、client は credentials:'omit' のため wildcard origin が
 * 安全 (cookie/認証情報の露出なし)。これが無いとブラウザの CORS で fetch がブロックされ配信不能。
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  })
}

const QuerySchema = z.object({
  tenant_id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  site_id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
})

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    tenant_id: searchParams.get('tenant_id') ?? '',
    site_id: searchParams.get('site_id') ?? '',
  })

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_query' },
      { status: 400, headers: { ...CORS_HEADERS } },
    )
  }

  const { tenant_id, site_id } = parsed.data

  // REQ-SEC-006: global kill-switch — serve the empty-scenarios 200 payload if scenario
  // delivery is globally disabled. Not a 404: this is a routine "nothing to deliver right
  // now" outcome for otherwise-valid requests, not an error.
  if (isScenarioDeliveryGloballyDisabled()) {
    return NextResponse.json(emptyRuntimePayload(tenant_id, site_id), {
      status: 200,
      headers: { 'Cache-Control': 'no-store', ...CORS_HEADERS },
    })
  }

  // Stage 5 (続 M-12): KV-first merge with POC fallback
  let kvScenarios: Scenario[] = []
  try {
    const repo = createScenarioRepository()
    kvScenarios = await repo.listScenarios(tenant_id, site_id)
  } catch (e) {
    if (e instanceof CloudflareKvError || e instanceof ScenarioValidationError) {
      // eslint-disable-next-line no-console
      console.warn(`[scenarios/runtime] KV read failed, POC fallback only: ${(e as Error).message}`)
    } else {
      throw e
    }
  }
  const pocScenarios = getPocScenariosForTenant(tenant_id, site_id)
  const merged = mergeForRuntime(kvScenarios, pocScenarios)

  // REQ-SEC-006: per-tenant / per-scenario kill-switch — drop killed scenarios at serve time,
  // independent of any cache (route is no-store, so this takes effect on the next request).
  const killFiltered = merged.filter((s) => !isDeliveryKilled(tenant_id, s.id))

  // Phase 2.1: schedule (start_at/end_at) で期間外の scenario を除外。
  // scenario-runtime.js が browser side で再度チェックするが (clock skew 耐性)、
  // server side で落とすことで「期間前/後」の variant HTML が一切 client に届かなくする
  // (REQ-SEC 整合: 必要外の payload は出さない)。
  const nowMs = Date.now()
  const scenarios = killFiltered.filter((s) => isScenarioInSchedule(s.schedule, nowMs))

  if (scenarios.length === 0) {
    // Valid tenant_id/site_id with zero active scenarios is the common case for real
    // customer traffic (most pageviews have no live scenario running) — 200 + empty
    // scenarios payload, not 404, so it doesn't show up as console/network error noise.
    return NextResponse.json(emptyRuntimePayload(tenant_id, site_id), {
      status: 200,
      headers: { 'Cache-Control': 'no-store', ...CORS_HEADERS },
    })
  }

  const runtimeScenarios: ScenarioRuntime[] = await Promise.all(
    scenarios.map(async (s) => ({
      id: s.id,
      condition_ast: s.condition_ast,
      variants: s.variants,
      status: s.status,
      matched_condition_hash: await sha256Hex(canonicalizeAst(s.condition_ast)),
      // Phase 2.1: browser side 二重チェック用に frequency_cap / schedule を payload に含める。
      // schedule は ±5min clock skew tolerance を browser 側で吸収する。
      ...(s.frequency_cap ? { frequency_cap: s.frequency_cap } : {}),
      ...(s.schedule ? { schedule: s.schedule } : {}),
    })),
  )

  const payload: ScenarioRuntimePayload = {
    generated_at: new Date().toISOString(),
    tenant_id,
    site_id,
    scenarios: runtimeScenarios,
  }

  // Defensive: re-validate before serializing (catches schema drift in dev).
  const validated = ScenarioRuntimePayloadSchema.parse(payload)

  // REQ-SEC-006: executable config MUST NOT be public-cached. no-store ensures a poisoned
  // entry cannot fan out via CDN and a kill-switch flip takes effect on the next request.
  return NextResponse.json(validated, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'X-M-Director-Phase': '2',
      ...CORS_HEADERS,
    },
  })
}

/**
 * 続 M-N (2026-08-16, issue①): Empty-scenarios success payload, reused by every
 * "valid tenant/site, nothing to deliver right now" branch (global kill-switch, zero
 * scenarios after schedule/kill filtering). Shape matches the non-empty success payload
 * below (ScenarioRuntimePayloadSchema) — just with `scenarios: []` — so this is genuinely
 * the existing "no active scenario" success shape, not a new one.
 */
function emptyRuntimePayload(tenant_id: string, site_id: string): ScenarioRuntimePayload {
  return {
    generated_at: new Date().toISOString(),
    tenant_id,
    site_id,
    scenarios: [],
  }
}

/**
 * Stage 5 (続 M-12): Merge KV + POC scenarios for runtime serving.
 *   - KV scenarios with status in {live, measure_only} are exposed.
 *     'draft' / 'paused' / 'archived' は server-side gate で除外。
 *   - REQ-SEC-006: 'preview' is NOT exposed in this public payload — preview is for
 *     authoring/QA review, not for delivery to every anonymous visitor. Gating it here
 *     (and not in scenario-runtime.js) ensures preview HTML never leaves the server to the
 *     general public, even if a client tweaks its evaluation.
 *   - POC fallback は KV に同 id が無いときのみ採用 (legacy 維持)。
 *   - updated_at desc sort で最新順配信。
 */
function mergeForRuntime(kv: Scenario[], poc: ReadonlyArray<Scenario>): Scenario[] {
  const RUNTIME_STATUSES = new Set(['live', 'measure_only'])
  const byId = new Map<string, Scenario>()
  for (const s of poc) {
    if (s.archived_at !== null) continue
    if (!RUNTIME_STATUSES.has(s.status)) continue
    byId.set(s.id, s)
  }
  for (const s of kv) {
    if (s.archived_at !== null) continue
    if (!RUNTIME_STATUSES.has(s.status)) continue
    byId.set(s.id, s) // KV overrides POC for same id
  }
  return [...byId.values()].sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
}

// isScenarioInSchedule は lib/scenarios/schedule-utils.ts に切り出し済 (Next.js route.ts は
// named export を制限するため)。
