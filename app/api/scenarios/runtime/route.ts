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
 *   - status='measure_only' only (Path C, §1.7.1 compliant)
 *   - public endpoint (no JWT) because tracking.js v2 already runs on customer pages
 *     and the runtime payload contains no PII — only condition AST + variant HTML.
 *   - tenant_id + site_id must match a configured site_id (validated against poc data).
 *     Cross-tenant probing returns 404, not 403, to avoid info leak about tenant existence.
 *   - Cache-Control public + s-maxage=300 for CDN edge caching.
 *
 * Phase 2: backing store switches to PostgreSQL `scenarios` table.
 * Phase 3: JWT-gated CRUD endpoints (POST/PUT/DELETE) live separately under /api/scenarios/[id].
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getPocScenariosForTenant } from '@/lib/scenarios/poc-scenario'
import { canonicalizeAst } from '@/lib/scenarios/evaluator'
import { CloudflareKvError } from '@/lib/scenarios/kv-storage'
import { ScenarioValidationError, createScenarioRepository } from '@/lib/scenarios/repository'
import {
  ScenarioRuntimePayloadSchema,
  type Scenario,
  type ScenarioRuntime,
  type ScenarioRuntimePayload,
} from '@/lib/scenarios/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  }

  const { tenant_id, site_id } = parsed.data

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
  const scenarios = mergeForRuntime(kvScenarios, pocScenarios)

  if (scenarios.length === 0) {
    // 404 (not 403) to avoid leaking tenant existence.
    return NextResponse.json(
      { error: 'no_scenarios' },
      { status: 404, headers: { 'Cache-Control': 'public, s-maxage=60' } },
    )
  }

  const runtimeScenarios: ScenarioRuntime[] = await Promise.all(
    scenarios.map(async (s) => ({
      id: s.id,
      condition_ast: s.condition_ast,
      variants: s.variants,
      status: s.status,
      matched_condition_hash: await sha256Hex(canonicalizeAst(s.condition_ast)),
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

  return NextResponse.json(validated, {
    status: 200,
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      'X-M-Director-Phase': '2',
    },
  })
}

/**
 * Stage 5 (続 M-12): Merge KV + POC scenarios for runtime serving.
 *   - KV scenarios with status in {live, preview, measure_only} are exposed.
 *     'draft' / 'paused' / 'archived' は server-side gate で除外。
 *   - POC fallback は KV に同 id が無いときのみ採用 (legacy 維持)。
 *   - updated_at desc sort で最新順配信。
 */
function mergeForRuntime(kv: Scenario[], poc: ReadonlyArray<Scenario>): Scenario[] {
  const RUNTIME_STATUSES = new Set(['live', 'preview', 'measure_only'])
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
