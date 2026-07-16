/**
 * lib/conversions/repository.ts — CvDefinition CRUD repository (KV-backed)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §4
 *
 * lib/paths/repository.ts の KV パターンをそのまま踏襲する (別 prefix で同 namespace に同居):
 *   - tenant_id / site_id prefix enforce: 全 key は `cvdefs/{tenant_id}/{site_id}/`
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

import { MAX_CV_DEFINITIONS_PER_SITE, cvDefinitionSchema } from './types'
import type { CvDefinition, CvScope, CvTrigger, CvValue } from './types'

// ── Errors ──────────────────────────────────────────────────────────────────

export class CvDefinitionValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'CvDefinitionValidationError'
  }
}

export class CvDefinitionNotFoundError extends Error {
  constructor(cvDefId: string) {
    super(`cv definition not found: ${cvDefId}`)
    this.name = 'CvDefinitionNotFoundError'
  }
}

/** best-effort 楽観ロック不一致 (§2 設計判断: KV に CAS が無いため read 時 version 比較) */
export class CvDefinitionVersionConflictError extends Error {
  constructor(cvDefId: string) {
    super(`cv definition version conflict: ${cvDefId}`)
    this.name = 'CvDefinitionVersionConflictError'
  }
}

export class CvDefinitionLimitExceededError extends Error {
  constructor(siteId: string) {
    super(`site ${siteId} already has ${MAX_CV_DEFINITIONS_PER_SITE} cv definitions (limit reached)`)
    this.name = 'CvDefinitionLimitExceededError'
  }
}

// ── Key helpers ───────────────────────────────────────────────────────────────

const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const UUID_PATTERN = /^[0-9a-f-]{36}$/i

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new CvDefinitionValidationError('invalid tenant_id', [
      { path: 'tenant_id', message: 'must match ^[a-z0-9_-]{1,64}$' },
    ])
  }
}

function assertSiteId(siteId: string): void {
  if (!SITE_ID_PATTERN.test(siteId)) {
    throw new CvDefinitionValidationError('invalid site_id', [
      { path: 'site_id', message: 'must match ^[A-Za-z0-9_-]{1,64}$' },
    ])
  }
}

export function cvDefKey(tenantId: string, siteId: string, cvDefId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  if (!UUID_PATTERN.test(cvDefId)) {
    throw new CvDefinitionValidationError('invalid cvDefId format', [
      { path: 'cvdef_id', message: 'must be UUID' },
    ])
  }
  return `cvdefs/${tenantId}/${siteId}/${cvDefId}`
}

export function cvDefPrefix(tenantId: string, siteId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  return `cvdefs/${tenantId}/${siteId}/`
}

/**
 * per-(tenant,site) index key — KV list 結果整合対策。`cvdefs/` とは別 prefix のため
 * listKeys('cvdefs/{t}/{s}/') には拾われない。
 */
export function cvDefIndexKey(tenantId: string, siteId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  return `cvdef-index/${tenantId}/${siteId}`
}

// ── Input shapes ──────────────────────────────────────────────────────────────

export interface CreateCvDefinitionInput {
  tenant_id: string
  site_id: string
  name: string
  cvKey: string
  description?: string
  enabled: boolean
  trigger: CvTrigger
  scope?: CvScope
  value: CvValue
  created_by: string
}

export interface UpdateCvDefinitionInput {
  name?: string
  cvKey?: string
  description?: string
  enabled?: boolean
  trigger?: CvTrigger
  scope?: CvScope
  value?: CvValue
}

export interface UpdateCvDefinitionOptions {
  /** best-effort 楽観ロック。指定時 existing.version と不一致なら CvDefinitionVersionConflictError */
  expectedVersion?: number
  /** 書込み前の認可フック。authoritative read (`existing`) に対して呼ばれる。 */
  authorize?: (existing: CvDefinition, patch: UpdateCvDefinitionInput) => void
}

// ── Repository ────────────────────────────────────────────────────────────────

export interface CvDefinitionRepositoryOptions {
  storage?: KvStorage
  now?: () => string
  uuid?: () => string
}

export function createCvDefinitionRepository(opts: CvDefinitionRepositoryOptions = {}) {
  const storage = opts.storage ?? getDefaultStorage()
  const now = opts.now ?? (() => new Date().toISOString())
  const uuid = opts.uuid ?? (() => randomUUID())

  async function listCvDefinitions(tenantId: string, siteId: string): Promise<CvDefinition[]> {
    const prefix = cvDefPrefix(tenantId, siteId)
    const keySet = new Set<string>()
    let anySourceOk = false

    // primary: index (reliable direct get)
    try {
      for (const id of await readIndex(storage, tenantId, siteId)) {
        try {
          keySet.add(cvDefKey(tenantId, siteId, id))
        } catch {
          // index に紛れた不正 id は無視
        }
      }
      anySourceOk = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[conversions] index read failed, relying on listKeys: ${(e as Error).message}`)
    }

    // best-effort: listKeys (結果整合の保険)
    try {
      for (const k of await storage.listKeys(prefix)) keySet.add(k)
      anySourceOk = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[conversions] listKeys failed, relying on index: ${(e as Error).message}`)
    }

    if (!anySourceOk) {
      throw new CloudflareKvError('cvdef list failed: both index and listKeys reads errored')
    }
    if (keySet.size === 0) return []

    const rows = await Promise.all([...keySet].map((k) => storage.getJson<CvDefinition>(k)))
    const valid: CvDefinition[] = []
    for (const r of rows) {
      if (r === null) continue
      const parsed = cvDefinitionSchema.safeParse(r)
      if (!parsed.success) continue
      // REQ-SEC-004: key を信頼せず row 自身の所有権を確認
      if (parsed.data.tenant_id !== tenantId || parsed.data.site_id !== siteId) continue
      valid.push(parsed.data)
    }
    valid.sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
    return valid
  }

  async function getCvDefinition(
    tenantId: string,
    siteId: string,
    cvDefId: string,
  ): Promise<CvDefinition | null> {
    const key = cvDefKey(tenantId, siteId, cvDefId)
    const raw = await storage.getJson<unknown>(key)
    if (raw === null) return null
    const parsed = cvDefinitionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new CvDefinitionValidationError(
        `stored cv definition ${cvDefId} fails schema`,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    assertOwnership(parsed.data, tenantId, siteId)
    return parsed.data
  }

  async function createCvDefinition(input: CreateCvDefinitionInput): Promise<CvDefinition> {
    // 所有権フィルタ済みの authoritative list を1回だけ読み、上限チェックとcvKey重複チェックを両方まかなう。
    const existing = await listCvDefinitions(input.tenant_id, input.site_id)
    if (existing.length >= MAX_CV_DEFINITIONS_PER_SITE) {
      throw new CvDefinitionLimitExceededError(input.site_id)
    }

    // cvKey は site 内で一意 (消費側の解決が曖昧にならないよう軽量チェック)
    if (existing.some((d) => d.cvKey === input.cvKey)) {
      throw new CvDefinitionValidationError('cvKey already exists for this site', [
        { path: 'cvKey', message: `'${input.cvKey}' is already used by another definition` },
      ])
    }

    const ts = now()
    const candidate = {
      id: uuid(),
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      name: input.name,
      cvKey: input.cvKey,
      description: input.description,
      enabled: input.enabled,
      trigger: input.trigger,
      scope: input.scope,
      value: input.value,
      created_at: ts,
      updated_at: ts,
      created_by: input.created_by,
      version: 1,
    }
    const parsed = cvDefinitionSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new CvDefinitionValidationError(
        'create cv definition validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    const key = cvDefKey(parsed.data.tenant_id, parsed.data.site_id, parsed.data.id)
    await storage.putJson(key, parsed.data)
    await addToIndex(storage, parsed.data.tenant_id, parsed.data.site_id, parsed.data.id)
    void emitScenarioAudit({
      action: 'cvdef.created',
      tenant_id: parsed.data.tenant_id,
      scenario_id: parsed.data.id,
      user_id: parsed.data.created_by,
      metadata: { name: parsed.data.name, cvKey: parsed.data.cvKey, site_id: parsed.data.site_id },
    })
    return parsed.data
  }

  async function updateCvDefinition(
    tenantId: string,
    siteId: string,
    cvDefId: string,
    patch: UpdateCvDefinitionInput,
    options: UpdateCvDefinitionOptions = {},
  ): Promise<CvDefinition> {
    const existing = await getCvDefinition(tenantId, siteId, cvDefId)
    if (!existing) throw new CvDefinitionNotFoundError(cvDefId)

    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw new CvDefinitionVersionConflictError(cvDefId)
    }
    options.authorize?.(existing, patch)

    if (patch.cvKey !== undefined && patch.cvKey !== existing.cvKey) {
      const siblings = await listCvDefinitions(tenantId, siteId)
      if (siblings.some((d) => d.id !== cvDefId && d.cvKey === patch.cvKey)) {
        throw new CvDefinitionValidationError('cvKey already exists for this site', [
          { path: 'cvKey', message: `'${patch.cvKey}' is already used by another definition` },
        ])
      }
    }

    const merged = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cvKey !== undefined ? { cvKey: patch.cvKey } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
      ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      ...(patch.value !== undefined ? { value: patch.value } : {}),
      updated_at: now(),
      version: existing.version + 1,
    }
    const parsed = cvDefinitionSchema.safeParse(merged)
    if (!parsed.success) {
      throw new CvDefinitionValidationError(
        'update cv definition validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    const key = cvDefKey(tenantId, siteId, cvDefId)
    await storage.putJson(key, parsed.data)
    await addToIndex(storage, tenantId, siteId, cvDefId)
    void emitScenarioAudit({
      action: 'cvdef.updated',
      tenant_id: parsed.data.tenant_id,
      scenario_id: parsed.data.id,
      user_id: existing.created_by,
      metadata: { changed_fields: Object.keys(patch), enabled: parsed.data.enabled },
    })
    return parsed.data
  }

  async function deleteCvDefinition(
    tenantId: string,
    siteId: string,
    cvDefId: string,
  ): Promise<boolean> {
    // REQ-SEC-004: row の所有権を再検証してから削除
    const existing = await getCvDefinition(tenantId, siteId, cvDefId)
    if (!existing) return false
    const key = cvDefKey(tenantId, siteId, cvDefId)
    const existed = await storage.delete(key)
    if (existed) {
      await removeFromIndex(storage, tenantId, siteId, cvDefId)
      void emitScenarioAudit({
        action: 'cvdef.deleted',
        tenant_id: tenantId,
        scenario_id: cvDefId,
        metadata: { site_id: siteId, cvKey: existing.cvKey },
      })
    }
    return existed
  }

  return {
    listCvDefinitions,
    getCvDefinition,
    createCvDefinition,
    updateCvDefinition,
    deleteCvDefinition,
  }
}

export type CvDefinitionRepository = ReturnType<typeof createCvDefinitionRepository>

// ── helpers ───────────────────────────────────────────────────────────────────

function assertOwnership(def: CvDefinition, tenantId: string, siteId: string): void {
  if (def.tenant_id !== tenantId || def.site_id !== siteId) {
    // 所有権不一致は「存在しない」扱い (resource の存在を確認させない)
    throw new CvDefinitionNotFoundError(def.id)
  }
}

async function readIndex(storage: KvStorage, tenantId: string, siteId: string): Promise<string[]> {
  const raw = await storage.getJson<unknown>(cvDefIndexKey(tenantId, siteId))
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}

async function addToIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
  cvDefId: string,
): Promise<void> {
  try {
    const ids = await readIndex(storage, tenantId, siteId)
    if (ids.includes(cvDefId)) return
    await storage.putJson(cvDefIndexKey(tenantId, siteId), [...ids, cvDefId])
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[conversions] index add failed for ${cvDefId}: ${(e as Error).message}`)
  }
}

async function removeFromIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
  cvDefId: string,
): Promise<void> {
  try {
    const ids = await readIndex(storage, tenantId, siteId)
    if (!ids.includes(cvDefId)) return
    await storage.putJson(
      cvDefIndexKey(tenantId, siteId),
      ids.filter((id) => id !== cvDefId),
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[conversions] index remove failed for ${cvDefId}: ${(e as Error).message}`)
  }
}
