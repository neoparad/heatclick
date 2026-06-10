/**
 * 宝プロジェクト — 標準実験 registry repository (engine, T1)
 *
 * store 注入で test 容易化 (lib/scenarios/repository.ts の KvStorage 注入と同様の方針)。
 *   - InMemoryExperimentStore: unit test / dev。
 *   - PostgresExperimentStore (postgres-store.ts): 本番 (Supabase 相乗り)。
 *
 * 不変条件:
 *   - tenant_id を全操作で保持・検証 (§3.8.1)。get は row 自身の tenant/site を再照合 (REQ-SEC-004 同型)。
 *   - lock: running 以降は taxonomy / url_pattern / salt_version 変更を拒否 (assertLockedFieldsUnchanged)。
 *   - lifecycle: draft → running(start: locked_at + 期間確定) → stopped → archived。
 *     archive は {draft(破棄), stopped} からのみ。running は不可 (先に stop = 計測を黙って失わない)。
 */

import { randomUUID } from 'node:crypto'

import { WINDOW_DAYS } from './taxonomy'
import {
  ExperimentSchema,
  assertLockedFieldsUnchanged,
  isTaxonomyEditable,
  type Consent,
  type Experiment,
  type ExperimentDates,
  type LockedTaxonomy,
} from './types'

// ── Errors ────────────────────────────────────────────────────────────────────
export class ExperimentValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'ExperimentValidationError'
  }
}
export class ExperimentNotFoundError extends Error {
  constructor(id: string) {
    super(`experiment not found: ${id}`)
    this.name = 'ExperimentNotFoundError'
  }
}
export class ExperimentStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExperimentStateError'
  }
}
// API route が types を直接 import せず lock 違反を catch できるよう re-export。
export { ExperimentLockError } from './types'

// ── Store interface (domain-level、SQL を隠蔽) ─────────────────────────────────
export interface ExperimentStore {
  insert(row: Experiment): Promise<void>
  getById(tenantId: string, siteId: string, id: string): Promise<Experiment | null>
  listByTenantSite(tenantId: string, siteId: string): Promise<Experiment[]>
  update(row: Experiment): Promise<void>
  /**
   * assignment 配信用: running かつ [start_at, end_at) (両端 non-null) の実験のみを SQL 側で絞る。
   * 公開 endpoint の per-request の作業量を有界化し、null 日付を fail-closed で除外 (Codex M2b)。
   */
  listActiveForAssignment(tenantId: string, siteId: string, nowIso: string): Promise<Experiment[]>
}

// ── In-memory store (test / dev) ───────────────────────────────────────────────
export class InMemoryExperimentStore implements ExperimentStore {
  private readonly rows = new Map<string, Experiment>()

  // deep clone (Codex MEDIUM): nested taxonomy/dates/consent の参照共有を断ち、返却値の
  // 変異で stored state が書き換わって lock を迂回されるのを防ぐ (immutability)。
  async insert(row: Experiment): Promise<void> {
    this.rows.set(row.id, structuredClone(row))
  }
  async getById(tenantId: string, siteId: string, id: string): Promise<Experiment | null> {
    const row = this.rows.get(id)
    if (!row || row.tenant_id !== tenantId || row.site_id !== siteId) return null
    return structuredClone(row)
  }
  async listByTenantSite(tenantId: string, siteId: string): Promise<Experiment[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenant_id === tenantId && r.site_id === siteId)
      .map((r) => structuredClone(r))
      .sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
  }
  async update(row: Experiment): Promise<void> {
    this.rows.set(row.id, structuredClone(row))
  }
  async listActiveForAssignment(tenantId: string, siteId: string, nowIso: string): Promise<Experiment[]> {
    const nowMs = Date.parse(nowIso)
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.tenant_id === tenantId &&
          r.site_id === siteId &&
          r.status === 'running' &&
          r.dates.start_at !== null &&
          r.dates.end_at !== null &&
          Date.parse(r.dates.start_at) <= nowMs &&
          nowMs < Date.parse(r.dates.end_at),
      )
      .map((r) => structuredClone(r))
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────────
export interface CreateExperimentInput {
  tenant_id: string
  site_id: string
  name: string
  url_pattern: string
  taxonomy: LockedTaxonomy
  dates?: ExperimentDates
  salt_version?: number
  consent?: Consent
  created_by: string
}

export interface UpdateExperimentInput {
  name?: string
  url_pattern?: string
  taxonomy?: LockedTaxonomy
  dates?: ExperimentDates
  salt_version?: number
  consent?: Consent
}

export interface ExperimentRepositoryOptions {
  store?: ExperimentStore
  /** test 用 deterministic clock。default = `() => new Date().toISOString()` */
  now?: () => string
  /** test 用 deterministic UUID。default = `() => randomUUID()` */
  uuid?: () => string
}

const DAY_MS = 86_400_000

// ── Repository ──────────────────────────────────────────────────────────────────
export function createExperimentRepository(opts: ExperimentRepositoryOptions = {}) {
  const store = opts.store ?? new InMemoryExperimentStore()
  const now = opts.now ?? (() => new Date().toISOString())
  const uuid = opts.uuid ?? (() => randomUUID())

  async function create(input: CreateExperimentInput): Promise<Experiment> {
    const ts = now()
    const candidate = {
      id: uuid(),
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      name: input.name,
      url_pattern: input.url_pattern,
      taxonomy: input.taxonomy,
      status: 'draft' as const,
      dates: input.dates ?? { start_at: null, end_at: null },
      salt_version: input.salt_version ?? 1,
      consent: input.consent ?? { pool_opt_in: false, k_anonymity_min: 50 },
      created_at: ts,
      updated_at: ts,
      created_by: input.created_by,
      locked_at: null,
      stopped_at: null,
      archived_at: null,
    }
    const parsed = parseOrThrow(candidate)
    await store.insert(parsed)
    return parsed
  }

  async function get(tenantId: string, siteId: string, id: string): Promise<Experiment | null> {
    const row = await store.getById(tenantId, siteId, id)
    if (!row) return null
    // 防御: store がフィルタ済みでも row 自身の tenant/site を再照合 (REQ-SEC-004 同型)。
    if (row.tenant_id !== tenantId || row.site_id !== siteId) return null
    return row
  }

  async function list(tenantId: string, siteId: string): Promise<Experiment[]> {
    return store.listByTenantSite(tenantId, siteId)
  }

  /** assignment 配信用 (running + 有界 window のみ)。public endpoint の作業量を有界化。 */
  async function listActiveForAssignment(
    tenantId: string,
    siteId: string,
    nowIso: string,
  ): Promise<Experiment[]> {
    return store.listActiveForAssignment(tenantId, siteId, nowIso)
  }

  async function update(
    tenantId: string,
    siteId: string,
    id: string,
    patch: UpdateExperimentInput,
  ): Promise<Experiment> {
    const existing = await get(tenantId, siteId, id)
    if (!existing) throw new ExperimentNotFoundError(id)
    // running 以降は locked field 変更不可 (throw ExperimentLockError)。
    assertLockedFieldsUnchanged(existing, {
      taxonomy: patch.taxonomy,
      url_pattern: patch.url_pattern,
      salt_version: patch.salt_version,
    })
    return save({
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.url_pattern !== undefined ? { url_pattern: patch.url_pattern } : {}),
      ...(patch.taxonomy !== undefined ? { taxonomy: patch.taxonomy } : {}),
      ...(patch.dates !== undefined ? { dates: patch.dates } : {}),
      ...(patch.salt_version !== undefined ? { salt_version: patch.salt_version } : {}),
      ...(patch.consent !== undefined ? { consent: patch.consent } : {}),
      updated_at: now(),
    })
  }

  /**
   * draft → running。start_at を確定し end_at = start_at + window 日数を導出、taxonomy をロック。
   * 既に draft でない場合は ExperimentStateError。
   */
  async function start(tenantId: string, siteId: string, id: string, startIso: string): Promise<Experiment> {
    const existing = await get(tenantId, siteId, id)
    if (!existing) throw new ExperimentNotFoundError(id)
    if (!isTaxonomyEditable(existing.status)) {
      throw new ExperimentStateError(`experiment ${id} is not in draft (status=${existing.status})`)
    }
    const startMs = Date.parse(startIso)
    if (!Number.isFinite(startMs)) {
      throw new ExperimentValidationError('invalid start_at', [
        { path: 'start_at', message: 'must be an ISO datetime' },
      ])
    }
    const endMs = startMs + WINDOW_DAYS[existing.taxonomy.window] * DAY_MS
    const ts = now()
    return save({
      ...existing,
      status: 'running' as const,
      dates: { start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString() },
      locked_at: ts,
      updated_at: ts,
    })
  }

  async function stop(tenantId: string, siteId: string, id: string): Promise<Experiment> {
    const existing = await get(tenantId, siteId, id)
    if (!existing) throw new ExperimentNotFoundError(id)
    if (existing.status !== 'running') {
      throw new ExperimentStateError(`only running experiments can be stopped (status=${existing.status})`)
    }
    const ts = now()
    return save({ ...existing, status: 'stopped' as const, stopped_at: ts, updated_at: ts })
  }

  async function archive(tenantId: string, siteId: string, id: string): Promise<Experiment> {
    const existing = await get(tenantId, siteId, id)
    if (!existing) throw new ExperimentNotFoundError(id)
    // archive は {draft(破棄), stopped} からのみ。running は先に stop() する
    // (Codex HIGH: 実行中の計測を黙って失わない / 状態機械を skip させない)。
    if (existing.status === 'running') {
      throw new ExperimentStateError(`stop the experiment before archiving (status=running)`)
    }
    if (existing.status === 'archived') {
      throw new ExperimentStateError(`experiment ${id} already archived`)
    }
    const ts = now()
    return save({ ...existing, status: 'archived' as const, archived_at: ts, updated_at: ts })
  }

  async function save(candidate: unknown): Promise<Experiment> {
    const parsed = parseOrThrow(candidate)
    await store.update(parsed)
    return parsed
  }

  return { create, get, list, listActiveForAssignment, update, start, stop, archive }
}

export type ExperimentRepository = ReturnType<typeof createExperimentRepository>

// ── helpers ──────────────────────────────────────────────────────────────────
function parseOrThrow(candidate: unknown): Experiment {
  const parsed = ExperimentSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new ExperimentValidationError(
      'experiment validation failed',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return parsed.data
}
