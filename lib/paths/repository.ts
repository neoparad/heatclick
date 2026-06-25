/**
 * lib/paths/repository.ts — PathSet CRUD repository (KV-backed)
 *
 * 「1 経路 = 比較セット」(lib/paths/types.ts PathSet) の CRUD。lib/scenarios/repository.ts の
 * KV パターンを踏襲する:
 *   - tenant_id / site_id prefix enforce: 全 key は `pathsets/{tenant_id}/{site_id}/`
 *   - REQ-SEC-004: key を信頼せず、読み出した row 自身の tenant_id/site_id を必ず再検証
 *   - KV list 結果整合バグ対策: write 時に per-(tenant,site) index key へ id を登録し、read は
 *     index (直接 get・信頼性◎) を primary、listKeys を best-effort の保険として union する
 *   - audit emit: fire-and-forget (lib/scenarios/audit.ts を共用)
 *
 * 親 SSOT: CLAUDE.md §Tenant Isolation / §3.8.1 multi-tenant isolation
 */

import { randomUUID } from 'node:crypto'

import { emitScenarioAudit } from '@/lib/scenarios/audit'
import { CloudflareKvError, getDefaultStorage, type KvStorage } from '@/lib/scenarios/kv-storage'
import { PathSetSchema, buildBranchesFromInput, type PathBranchInput, type PathSet } from './types'

// ── Errors ──────────────────────────────────────────────────────────────────

export class PathSetValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'PathSetValidationError'
  }
}

export class PathSetNotFoundError extends Error {
  constructor(pathSetId: string) {
    super(`pathset not found: ${pathSetId}`)
    this.name = 'PathSetNotFoundError'
  }
}

export class PathSetForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathSetForbiddenError'
  }
}

// ── Key helpers ───────────────────────────────────────────────────────────────

const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const UUID_PATTERN = /^[0-9a-f-]{36}$/i

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new PathSetValidationError('invalid tenant_id', [
      { path: 'tenant_id', message: 'must match ^[a-z0-9_-]{1,64}$' },
    ])
  }
}

function assertSiteId(siteId: string): void {
  if (!SITE_ID_PATTERN.test(siteId)) {
    throw new PathSetValidationError('invalid site_id', [
      { path: 'site_id', message: 'must match ^[A-Za-z0-9_-]{1,64}$' },
    ])
  }
}

export function pathSetKey(tenantId: string, siteId: string, pathSetId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  if (!UUID_PATTERN.test(pathSetId)) {
    throw new PathSetValidationError('invalid pathSetId format', [
      { path: 'pathset_id', message: 'must be UUID' },
    ])
  }
  return `pathsets/${tenantId}/${siteId}/${pathSetId}`
}

export function pathSetPrefix(tenantId: string, siteId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  return `pathsets/${tenantId}/${siteId}/`
}

/**
 * per-(tenant,site) index key — KV list 結果整合対策。`pathsets/` とは別 prefix のため
 * listKeys('pathsets/{t}/{s}/') には拾われない。
 */
export function pathSetIndexKey(tenantId: string, siteId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  return `pathset-index/${tenantId}/${siteId}`
}

// ── Input shapes ──────────────────────────────────────────────────────────────

export interface CreatePathSetInput {
  tenant_id: string
  site_id: string
  name: string
  description?: string
  trigger: { title: string; url: string; periodDays?: number }
  branches: ReadonlyArray<PathBranchInput>
  created_by: string
}

export interface UpdatePathSetInput {
  name?: string
  description?: string
  status?: PathSet['status']
  trigger?: PathSet['trigger']
  branches?: PathSet['branches']
  insights?: PathSet['insights']
  evidence_level?: PathSet['evidence_level']
  evidence_data?: PathSet['evidence_data']
  averageCvRate?: PathSet['averageCvRate']
}

export interface UpdatePathSetOptions {
  /** 書込み前の認可フック。authoritative read (`existing`) に対して呼ばれる。 */
  authorize?: (existing: PathSet, patch: UpdatePathSetInput) => void
}

// ── Repository ────────────────────────────────────────────────────────────────

export interface PathSetRepositoryOptions {
  storage?: KvStorage
  now?: () => string
  uuid?: () => string
}

export function createPathSetRepository(opts: PathSetRepositoryOptions = {}) {
  const storage = opts.storage ?? getDefaultStorage()
  const now = opts.now ?? (() => new Date().toISOString())
  const uuid = opts.uuid ?? (() => randomUUID())

  async function listPathSets(tenantId: string, siteId: string): Promise<PathSet[]> {
    const prefix = pathSetPrefix(tenantId, siteId)
    const keySet = new Set<string>()
    let anySourceOk = false

    // primary: index (reliable direct get)
    try {
      for (const id of await readIndex(storage, tenantId, siteId)) {
        try {
          keySet.add(pathSetKey(tenantId, siteId, id))
        } catch {
          // index に紛れた不正 id は無視
        }
      }
      anySourceOk = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[paths] index read failed, relying on listKeys: ${(e as Error).message}`)
    }

    // best-effort: listKeys (結果整合の保険)
    try {
      for (const k of await storage.listKeys(prefix)) keySet.add(k)
      anySourceOk = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[paths] listKeys failed, relying on index: ${(e as Error).message}`)
    }

    if (!anySourceOk) {
      throw new CloudflareKvError('pathset list failed: both index and listKeys reads errored')
    }
    if (keySet.size === 0) return []

    const rows = await Promise.all([...keySet].map((k) => storage.getJson<PathSet>(k)))
    const valid: PathSet[] = []
    for (const r of rows) {
      if (r === null) continue
      const parsed = PathSetSchema.safeParse(r)
      if (!parsed.success) continue
      // REQ-SEC-004: key を信頼せず row 自身の所有権を確認
      if (parsed.data.tenant_id !== tenantId || parsed.data.site_id !== siteId) continue
      if (parsed.data.archived_at !== null) continue
      valid.push(parsed.data)
    }
    valid.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
    return valid
  }

  async function getPathSet(
    tenantId: string,
    siteId: string,
    pathSetId: string,
  ): Promise<PathSet | null> {
    const key = pathSetKey(tenantId, siteId, pathSetId)
    const raw = await storage.getJson<unknown>(key)
    if (raw === null) return null
    const parsed = PathSetSchema.safeParse(raw)
    if (!parsed.success) {
      throw new PathSetValidationError(
        `stored pathset ${pathSetId} fails schema`,
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      )
    }
    assertOwnership(parsed.data, tenantId, siteId)
    return parsed.data
  }

  async function createPathSet(input: CreatePathSetInput): Promise<PathSet> {
    const ts = now()
    const candidate = {
      id: uuid(),
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      name: input.name,
      description: input.description ?? '',
      status: 'draft' as const,
      trigger: {
        title: input.trigger.title,
        url: input.trigger.url,
        periodDays: input.trigger.periodDays ?? 30,
        sessions: '—',
      },
      branches: buildBranchesFromInput(input.branches),
      insights: [],
      isDummy: false,
      evidence_level: 'planned' as const,
      evidence_data: {},
      averageCvRate: '—',
      created_at: ts,
      updated_at: ts,
      created_by: input.created_by,
      archived_at: null,
    }
    const parsed = PathSetSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new PathSetValidationError(
        'create pathset validation failed',
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      )
    }
    const key = pathSetKey(parsed.data.tenant_id, parsed.data.site_id, parsed.data.id)
    await storage.putJson(key, parsed.data)
    await addToIndex(storage, parsed.data.tenant_id, parsed.data.site_id, parsed.data.id)
    void emitScenarioAudit({
      action: 'pathset.created',
      tenant_id: parsed.data.tenant_id,
      scenario_id: parsed.data.id,
      user_id: parsed.data.created_by,
      metadata: { name: parsed.data.name, site_id: parsed.data.site_id },
    })
    return parsed.data
  }

  async function updatePathSet(
    tenantId: string,
    siteId: string,
    pathSetId: string,
    patch: UpdatePathSetInput,
    options: UpdatePathSetOptions = {},
  ): Promise<PathSet> {
    const existing = await getPathSet(tenantId, siteId, pathSetId)
    if (!existing) throw new PathSetNotFoundError(pathSetId)
    options.authorize?.(existing, patch)

    const merged = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
      ...(patch.branches !== undefined ? { branches: patch.branches } : {}),
      ...(patch.insights !== undefined ? { insights: patch.insights } : {}),
      ...(patch.evidence_level !== undefined ? { evidence_level: patch.evidence_level } : {}),
      ...(patch.evidence_data !== undefined ? { evidence_data: patch.evidence_data } : {}),
      ...(patch.averageCvRate !== undefined ? { averageCvRate: patch.averageCvRate } : {}),
      updated_at: now(),
    }
    const parsed = PathSetSchema.safeParse(merged)
    if (!parsed.success) {
      throw new PathSetValidationError(
        'update pathset validation failed',
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      )
    }
    const key = pathSetKey(tenantId, siteId, pathSetId)
    await storage.putJson(key, parsed.data)
    await addToIndex(storage, tenantId, siteId, pathSetId)
    void emitScenarioAudit({
      action: 'pathset.updated',
      tenant_id: parsed.data.tenant_id,
      scenario_id: parsed.data.id,
      user_id: existing.created_by,
      metadata: {
        changed_fields: Object.keys(patch),
        status: parsed.data.status,
      },
    })
    return parsed.data
  }

  async function deletePathSet(
    tenantId: string,
    siteId: string,
    pathSetId: string,
  ): Promise<boolean> {
    // REQ-SEC-004: row の所有権を再検証してから削除
    const existing = await getPathSet(tenantId, siteId, pathSetId)
    if (!existing) return false
    const key = pathSetKey(tenantId, siteId, pathSetId)
    const existed = await storage.delete(key)
    if (existed) {
      await removeFromIndex(storage, tenantId, siteId, pathSetId)
      void emitScenarioAudit({
        action: 'pathset.deleted',
        tenant_id: tenantId,
        scenario_id: pathSetId,
        metadata: { site_id: siteId },
      })
    }
    return existed
  }

  return {
    listPathSets,
    getPathSet,
    createPathSet,
    updatePathSet,
    deletePathSet,
  }
}

export type PathSetRepository = ReturnType<typeof createPathSetRepository>

// ── helpers ───────────────────────────────────────────────────────────────────

function assertOwnership(pset: PathSet, tenantId: string, siteId: string): void {
  if (pset.tenant_id !== tenantId || pset.site_id !== siteId) {
    // 所有権不一致は「存在しない」扱い (resource の存在を確認させない)
    throw new PathSetNotFoundError(pset.id)
  }
}

async function readIndex(storage: KvStorage, tenantId: string, siteId: string): Promise<string[]> {
  const raw = await storage.getJson<unknown>(pathSetIndexKey(tenantId, siteId))
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}

async function addToIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
  pathSetId: string,
): Promise<void> {
  try {
    const ids = await readIndex(storage, tenantId, siteId)
    if (ids.includes(pathSetId)) return
    await storage.putJson(pathSetIndexKey(tenantId, siteId), [...ids, pathSetId])
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[paths] index add failed for ${pathSetId}: ${(e as Error).message}`)
  }
}

async function removeFromIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
  pathSetId: string,
): Promise<void> {
  try {
    const ids = await readIndex(storage, tenantId, siteId)
    if (!ids.includes(pathSetId)) return
    await storage.putJson(
      pathSetIndexKey(tenantId, siteId),
      ids.filter((id) => id !== pathSetId),
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[paths] index remove failed for ${pathSetId}: ${(e as Error).message}`)
  }
}
