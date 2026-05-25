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
import {
  ScenarioRuntimePayloadSchema,
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
  const scenarios = getPocScenariosForTenant(tenant_id, site_id)

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
      'X-M-Director-Phase': '1',
    },
  })
}
