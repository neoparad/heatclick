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
import { HtmlSanitizationError, sanitizeHtmlVariant } from './html-sanitizer'
import { CloudflareKvError, getDefaultStorage, type KvStorage } from './kv-storage'
import {
  ScenarioSchema,
  type Scenario,
  type Variants,
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

/**
 * 認可拒否 (REQ-SEC-010)。updateScenario の `authorize` フックが、書込みに使う authoritative
 * な既存 row を見て拒否したいときに throw する。API route 側は 403 にマップする。
 */
export class ScenarioForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioForbiddenError'
  }
}

// Re-export so API routes can catch sanitizer rejections without importing the sanitizer module.
export { HtmlSanitizationError } from './html-sanitizer'

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

/**
 * Per-(tenant,site) scenario index key — KV list 結果整合バグ対策 (runtime 断続配信落ち修正)。
 *
 * Cloudflare KV の list(/keys) は **結果整合** で、書きたてキーが list に出てこない/出たり消えたり
 * する。配信 runtime はこの list に依存していたため、管理画面で作った live シナリオが断続的に配信
 * から落ちていた。対策として write 時に「サイトごとの scenario_id 配列」を 1 キーで保持し、read は
 * 直接 get (getScenario と同じ信頼性) で引く。
 *
 * `scenarios/` とは別 prefix のため listKeys('scenarios/{t}/{s}/') には拾われない。
 */
export function scenarioIndexKey(tenantId: string, siteId: string): string {
  assertTenantId(tenantId)
  assertSiteId(siteId)
  return `scenario-index/${tenantId}/${siteId}`
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
  /** Phase 2.1 additive */
  frequency_cap?: Scenario['frequency_cap']
  /** Phase 2.1 additive */
  schedule?: Scenario['schedule']
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
  /** Phase 2.1 additive */
  frequency_cap?: Scenario['frequency_cap']
  /** Phase 2.1 additive */
  schedule?: Scenario['schedule']
}

export interface UpdateScenarioOptions {
  /**
   * REQ-SEC-010 (HIGH): 書込み前の認可フック。updateScenario が書込みに使うのと同じ
   * authoritative read (`existing`) に対して呼ばれるため、route の preflight 後に状態が
   * 変わる TOCTOU を塞げる。拒否したい場合は ScenarioForbiddenError を throw する。
   */
  authorize?: (existing: Scenario, patch: UpdateScenarioInput) => void
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
    // Cloudflare KV の list(/keys) は **結果整合** で書きたてキーを取りこぼす (= 新規/更新
    // シナリオが配信から断続的に落ちる重大バグの原因)。そこで index キー (直接 get・信頼性◎) を
    // primary、listKeys を best-effort の保険 (移行 / index 取りこぼし) として **union** する。
    // どちらか一方が読めれば配信を継続できる。
    const keySet = new Set<string>()
    let anySourceOk = false

    // primary: index (reliable direct get)
    try {
      for (const id of await readScenarioIndex(storage, tenantId, siteId)) {
        try {
          keySet.add(scenarioKey(tenantId, siteId, id))
        } catch {
          // index に紛れた不正 id は無視 (index drift 耐性)
        }
      }
      anySourceOk = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[scenarios] index read failed, relying on listKeys: ${(e as Error).message}`)
    }

    // best-effort: listKeys (結果整合。index 未登録の legacy key を拾う保険)
    try {
      for (const k of await storage.listKeys(prefix)) keySet.add(k)
      anySourceOk = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[scenarios] listKeys failed, relying on index: ${(e as Error).message}`)
    }

    // 両系統とも読めない = KV 自体ダウン → 呼出元 (runtime route) が POC fallback + log できるよう throw
    if (!anySourceOk) {
      throw new CloudflareKvError('scenario list failed: both index and listKeys reads errored')
    }
    if (keySet.size === 0) return []

    // 直接 get で各 scenario を読む (getScenario と同じ信頼性)。KV list 順序は保証されないので
    // updated_at desc で client sort。
    const rows = await Promise.all([...keySet].map((k) => storage.getJson<Scenario>(k)))
    const valid: Scenario[] = []
    for (const r of rows) {
      if (r === null) continue
      const parsed = ScenarioSchema.safeParse(r)
      if (!parsed.success) continue // parse 失敗は list を壊さないよう skip。Phase 3 で migrator 検討。
      // 続134 (1-5): REQ-SEC-004 防御の二重化 — getScenario と同じく key だけ信頼せず行自身の
      //   tenant/site を確認する。key/data drift で混入した他テナント行を公開配信 (runtime) に
      //   流さないため、所有権不一致の行は list から除外する (1 行の不整合で list を落とさない)。
      try {
        assertScenarioOwnership(parsed.data, tenantId, siteId)
      } catch {
        continue
      }
      valid.push(parsed.data)
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
    // REQ-SEC-004: never trust the key alone — confirm the row's own tenant/site.
    assertScenarioOwnership(parsed.data, tenantId, siteId)
    return parsed.data
  }

  async function createScenario(input: CreateScenarioInput): Promise<Scenario> {
    validateAstOrThrow(input.condition_ast)
    // REQ-SEC-001/002: sanitize inline HTML before persist (store ONLY the sanitized result).
    const safeVariants = sanitizeVariantsOrThrow(input.variants)
    const ts = now()
    const candidate = {
      id: uuid(),
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      name: input.name,
      description: input.description ?? '',
      condition_ast: input.condition_ast,
      variants: safeVariants,
      status: input.status ?? 'draft',
      evidence_level: input.evidence_level ?? 'planned',
      evidence_data: input.evidence_data ?? {},
      frequency_cap: input.frequency_cap ?? null,
      schedule: input.schedule ?? null,
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
    // KV list 結果整合バグ対策: 配信 read が list に依存しないよう index に id を登録 (best-effort)。
    await addToScenarioIndex(storage, parsed.data.tenant_id, parsed.data.site_id, parsed.data.id)
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
    options: UpdateScenarioOptions = {},
  ): Promise<Scenario> {
    const existing = await getScenario(tenantId, siteId, scenarioId)
    if (!existing) throw new ScenarioNotFoundError(scenarioId)
    // REQ-SEC-010 (HIGH): 書込みに使う authoritative read で認可判定する。route の preflight
    // 後に owner が publish する TOCTOU でも、ここで最新の `existing.status` を見て弾く。
    options.authorize?.(existing, patch)
    if (patch.condition_ast !== undefined) validateAstOrThrow(patch.condition_ast)
    // REQ-SEC-001/002: re-sanitize inline HTML on every variant update.
    const safeVariants =
      patch.variants !== undefined ? sanitizeVariantsOrThrow(patch.variants) : undefined

    const merged = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.condition_ast !== undefined ? { condition_ast: patch.condition_ast } : {}),
      ...(safeVariants !== undefined ? { variants: safeVariants } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.evidence_level !== undefined ? { evidence_level: patch.evidence_level } : {}),
      ...(patch.evidence_data !== undefined ? { evidence_data: patch.evidence_data } : {}),
      ...(patch.frequency_cap !== undefined ? { frequency_cap: patch.frequency_cap } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
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
    // KV list 結果整合バグ対策: index を冪等に更新。index 未登録の legacy 行はここで backfill される
    // (再保存 1 回で確実に配信に乗る)。
    await addToScenarioIndex(storage, tenantId, siteId, scenarioId)
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
    // REQ-SEC-004: load + re-verify the row's own tenant/site before deleting, so a delete
    // can never act on a row that doesn't actually belong to this tenant/site. getScenario
    // throws ScenarioNotFoundError on ownership mismatch and returns null when absent.
    const existing = await getScenario(tenantId, siteId, scenarioId)
    if (!existing) return false
    const key = scenarioKey(tenantId, siteId, scenarioId)
    const existed = await storage.delete(key)
    if (existed) {
      // KV list 結果整合バグ対策: index からも id を除去 (best-effort)。
      await removeFromScenarioIndex(storage, tenantId, siteId, scenarioId)
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

// ── Inline-HTML sanitization (REQ-SEC-001 / 002) ─────────────────────────────

/**
 * Sanitize every `content_type:'html'` variant's inline HTML at the write boundary.
 * Returns a NEW variants array (immutable); throws HtmlSanitizationError (surfaced as a
 * validation error to the author) if any variant contains forbidden markup.
 */
function sanitizeVariantsOrThrow(variants: Variants): Variants {
  return variants.map((variant) => {
    if (variant.content_type !== 'html') return variant
    try {
      const cleanHtml = sanitizeHtmlVariant(variant.html)
      return { ...variant, html: cleanHtml }
    } catch (err) {
      if (err instanceof HtmlSanitizationError) {
        throw new ScenarioValidationError('inline HTML variant failed sanitization', [
          { path: `variants.${variant.id}.html`, message: `${err.reason}: ${err.message}` },
        ])
      }
      throw err
    }
  }) as Variants
}

/**
 * Re-verify that a loaded scenario actually belongs to the requested tenant/site
 * (REQ-SEC-004 defense-in-depth). The KV key is tenant/site-scoped, but never trust the
 * key alone — confirm the stored row's own tenant_id/site_id match before returning or
 * mutating, so a key collision or data drift can never leak across tenants.
 */
function assertScenarioOwnership(
  scenario: Scenario,
  tenantId: string,
  siteId: string,
): void {
  if (scenario.tenant_id !== tenantId || scenario.site_id !== siteId) {
    // Treat an ownership mismatch as "not found" to avoid confirming the resource exists.
    throw new ScenarioNotFoundError(scenario.id)
  }
}

// ── Scenario index helpers (KV list 結果整合バグ対策) ─────────────────────────
//
// write 時に「サイトごとの scenario_id 配列」を 1 キー (scenarioIndexKey) で保持し、配信 read を
// 結果整合な listKeys に依存させない。index への書込みは **best-effort**: scenario 本体の write は
// 既に成功しているので、index 失敗で全体を落とさず warn に留める (listScenarios の best-effort
// listKeys が安全網)。
//
// 並行性: addToScenarioIndex は read-modify-write のため同時 create で lost-update し得る
// (Phase 1 dogfood は低並行で許容、listKeys union が保険)。Phase 3 で per-id index key / CAS 化検討。

async function readScenarioIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
): Promise<string[]> {
  const raw = await storage.getJson<unknown>(scenarioIndexKey(tenantId, siteId))
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}

async function addToScenarioIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
  scenarioId: string,
): Promise<void> {
  try {
    const ids = await readScenarioIndex(storage, tenantId, siteId)
    if (ids.includes(scenarioId)) return
    await storage.putJson(scenarioIndexKey(tenantId, siteId), [...ids, scenarioId])
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[scenarios] index add failed for ${scenarioId}: ${(e as Error).message}`)
  }
}

async function removeFromScenarioIndex(
  storage: KvStorage,
  tenantId: string,
  siteId: string,
  scenarioId: string,
): Promise<void> {
  try {
    const ids = await readScenarioIndex(storage, tenantId, siteId)
    if (!ids.includes(scenarioId)) return
    await storage.putJson(
      scenarioIndexKey(tenantId, siteId),
      ids.filter((id) => id !== scenarioId),
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[scenarios] index remove failed for ${scenarioId}: ${(e as Error).message}`)
  }
}

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
