/**
 * M-Director Stage 1 (続 M-7/M-8) — Scenario CRUD repository (KV-backed)
 *
 * Reference:
 *   - 続 M-7 §3 (KV key 設計)
 *   - 続 M-7 §4 #2 (CRUD ops + Zod validate + audit emit hook)
 *   - data-model.md §2.1 (Scenario row schema、本 Phase 2 では KV で代用)
 *
 * Patterns:
 *   - tenant_id prefix enforce: every key under `scenarios/{tenant_id}/{site_id}/`
 *   - Optimistic concurrency: not implemented in Phase 1 (last-write-wins is fine for
 *     single-Marketer editing; multi-edit conflict detection is Phase 3 backlog)
 *   - Soft delete: `archived_at` is set on DELETE rather than physical removal,
 *     but for Phase 2 we use physical KV.delete() and rely on audit_events for trail.
 *     (Phase 3 で archive=soft / delete=hard の二段モデルに切り替え予定)
 *   - audit emit: fire-and-forget after KV write; failures are logged not surfaced.
 */

import { randomUUID } from 'node:crypto'

import { emitScenarioAudit } from './audit'
import { getDefaultStorage, type KvStorage } from './kv-storage'
import {
  ScenarioSchema,
  type Scenario,
  validateConditionAst,
  conditionDepth,
  countLeaves,
  MAX_DEPTH,
  MAX_LEAVES,
} from './types'

// ── Errors ──────────────────────────────────────────────────────────────────

export class ScenarioValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'ScenarioValidationError'
  }
}

export class ScenarioNotFoundError extends Error {
  constructor(scenarioId: string) {
    super(`scenario not found: ${scenarioId}`)
    this.name = 'ScenarioNotFoundError'
  }
}

// ── Key helpers (続 M-7 §3) ─────────────────────────────────────────────────

const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function scenarioKey(tenantId: string, siteId: string, scenarioId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  if (!/^[0-9a-f-]{36}$/i.test(scenarioId)) {
    throw new ScenarioValidationError('invalid scenarioId format', [
      { path: 'scenario_id', message: 'must be UUID v4' },
    ])
  }
  return `scenarios/${tenantId}/${siteId}/${scenarioId}`
}

export function scenarioPrefix(tenantId: string, siteId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  return `scenarios/${tenantId}/${siteId}/`
}

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new ScenarioValidationError('invalid tenant_id', [
      { path: 'tenant_id', message: 'must match ^[a-z0-9_-]{1,64}$' },
    ])
  }
}

function assertSiteId(siteId: string): void {
  if (!SITE_ID_PATTERN.test(siteId)) {
    throw new ScenarioValidationError('invalid site_id', [
      { path: 'site_id', message: 'must match ^[A-Za-z0-9_-]{1,64}$' },
    ])
  }
}

// ── Input shape (subset; created_at / updated_at are server-stamped) ────────

export interface CreateScenarioInput {
  tenant_id: string
  site_id: string
  name: string
  description?: string
  condition_ast: Scenario['condition_ast']
  variants: Scenario['variants']
  status?: Scenario['status']
  evidence_level?: Scenario['evidence_level']
  evidence_data?: Scenario['evidence_data']
  created_by: string
}

export interface UpdateScenarioInput {
  name?: string
  description?: string
  condition_ast?: Scenario['condition_ast']
  variants?: Scenario['variants']
  status?: Scenario['status']
  evidence_level?: Scenario['evidence_level']
  evidence_data?: Scenario['evidence_data']
}

// ── CRUD ops ────────────────────────────────────────────────────────────────

export interface ScenarioRepositoryOptions {
  storage?: KvStorage
  /** test 用 deterministic clock。default = `() => new Date().toISOString()` */
  now?: () => string
  /** test 用 deterministic UUID。default = `() => randomUUID()` */
  uuid?: () => string
}

export function createScenarioRepository(opts: ScenarioRepositoryOptions = {}) {
  const storage = opts.storage ?? getDefaultStorage()
  const now = opts.now ?? (() => new Date().toISOString())
  const uuid = opts.uuid ?? (() => randomUUID())

  async function listScenarios(tenantId: string, siteId: string): Promise<Scenario[]> {
    const prefix = scenarioPrefix(tenantId, siteId)
    const keys = await storage.listKeys(prefix)
    if (keys.length === 0) return []
    // KV list 順序は CF が保証しないので、updated_at desc で client sort
    const rows = await Promise.all(
      keys.map(async (k) => {
        const v = await storage.getJson<Scenario>(k)
        return v
      }),
    )
    const valid: Scenario[] = []
    for (const r of rows) {
      if (r === null) continue
      const parsed = ScenarioSchema.safeParse(r)
      if (parsed.success) valid.push(parsed.data)
      // If parse fails, skip silently to avoid crashing list. Phase 3 で migrator 追加検討。
    }
    valid.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
    return valid
  }

  async function getScenario(
    tenantId: string,
    siteId: string,
    scenarioId: string,
  ): Promise<Scenario | null> {
    const key = scenarioKey(tenantId, siteId, scenarioId)
    const raw = await storage.getJson<unknown>(key)
    if (raw === null) return null
    const parsed = ScenarioSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ScenarioValidationError(
        `stored scenario ${scenarioId} fails schema`,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    return parsed.data
  }

  async function createScenario(input: CreateScenarioInput): Promise<Scenario> {
    validateAstOrThrow(input.condition_ast)
    const ts = now()
    const candidate = {
      id: uuid(),
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      name: input.name,
      description: input.description ?? '',
      condition_ast: input.condition_ast,
      variants: input.variants,
      status: input.status ?? 'draft',
      evidence_level: input.evidence_level ?? 'planned',
      evidence_data: input.evidence_data ?? {},
      created_at: ts,
      updated_at: ts,
      created_by: input.created_by,
      archived_at: null,
    }
    const parsed = ScenarioSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new ScenarioValidationError(
        'create scenario validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    const key = scenarioKey(parsed.data.tenant_id, parsed.data.site_id, parsed.data.id)
    await storage.putJson(key, parsed.data)
    void emitScenarioAudit({
      action: 'scenario.created',
      tenant_id: parsed.data.tenant_id,
      scenario_id: parsed.data.id,
      user_id: parsed.data.created_by,
      metadata: { name: parsed.data.name, site_id: parsed.data.site_id, status: parsed.data.status },
    })
    return parsed.data
  }

  async function updateScenario(
    tenantId: string,
    siteId: string,
    scenarioId: string,
    patch: UpdateScenarioInput,
  ): Promise<Scenario> {
    const existing = await getScenario(tenantId, siteId, scenarioId)
    if (!existing) throw new ScenarioNotFoundError(scenarioId)
    if (patch.condition_ast !== undefined) validateAstOrThrow(patch.condition_ast)

    const merged = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.condition_ast !== undefined ? { condition_ast: patch.condition_ast } : {}),
      ...(patch.variants !== undefined ? { variants: patch.variants } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.evidence_level !== undefined ? { evidence_level: patch.evidence_level } : {}),
      ...(patch.evidence_data !== undefined ? { evidence_data: patch.evidence_data } : {}),
      updated_at: now(),
    }
    const parsed = ScenarioSchema.safeParse(merged)
    if (!parsed.success) {
      throw new ScenarioValidationError(
        'update scenario validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    const key = scenarioKey(tenantId, siteId, scenarioId)
    await storage.putJson(key, parsed.data)
    void emitScenarioAudit({
      action: 'scenario.updated',
      tenant_id: parsed.data.tenant_id,
      scenario_id: parsed.data.id,
      user_id: existing.created_by,
      metadata: { changed_fields: Object.keys(patch), status: parsed.data.status },
    })
    return parsed.data
  }

  async function deleteScenario(
    tenantId: string,
    siteId: string,
    scenarioId: string,
  ): Promise<boolean> {
    const key = scenarioKey(tenantId, siteId, scenarioId)
    const existed = await storage.delete(key)
    if (existed) {
      void emitScenarioAudit({
        action: 'scenario.deleted',
        tenant_id: tenantId,
        scenario_id: scenarioId,
        metadata: { site_id: siteId },
      })
    }
    return existed
  }

  return {
    listScenarios,
    getScenario,
    createScenario,
    updateScenario,
    deleteScenario,
  }
}

export type ScenarioRepository = ReturnType<typeof createScenarioRepository>

// ── AST validation helper ───────────────────────────────────────────────────

function validateAstOrThrow(ast: Scenario['condition_ast']): void {
  const errors = validateConditionAst(ast)
  if (errors.length > 0) {
    throw new ScenarioValidationError(
      'condition_ast validation failed',
      errors.map((e) => ({ path: 'condition_ast', message: e.message })),
    )
  }
  // Defensive double-check (validateConditionAst already covers depth + leaves + fields,
  // but cheap to re-assert with the constant boundaries)
  if (conditionDepth(ast) > MAX_DEPTH || countLeaves(ast) > MAX_LEAVES) {
    throw new ScenarioValidationError('condition_ast exceeds AST limits', [
      { path: 'condition_ast', message: `max depth=${MAX_DEPTH}, max leaves=${MAX_LEAVES}` },
    ])
  }
}
