/**
 * Unit tests: lib/scenarios/repository (M-Director Stage 1 / 続 M-7+M-8)
 *
 * Reference:
 *   - linkscrawl/docs/fusion/team/m-director/decisions.md 続 M-7 §3 (KV key 設計)
 *   - linkscrawl/docs/fusion/team/m-director/decisions.md 続 M-7 §4 (Stage 1 配備物)
 *   - lib/scenarios/repository.ts (CRUD ops)
 *   - lib/scenarios/kv-storage.ts (KvStorage interface)
 *
 * Strategy: existing scenario-evaluator.test.mjs / audit-resp-ok.test.mjs pattern
 *   = equivalent JS impl of the TS module under test (mirror, parity-tested).
 *
 * Why mirror not direct-import:
 *   - tests/unit/*.mjs runs under bare `node --test` (no TS toolchain).
 *   - ugokimap-saas existing convention (8+ .mjs files all mirror their TS source).
 *
 * Drift detection:
 *   - keep the validation rules (tenant_id pattern / scenario_id format / KV key prefix)
 *     in sync; if `repository.ts` changes, update this mirror in the same commit.
 *
 * Usage:
 *   node --test tests/unit/scenarios-crud.test.mjs
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ── Equivalent JS impl (mirrors lib/scenarios/repository.ts key helpers) ──

const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertTenantId(t) {
  if (!TENANT_ID_PATTERN.test(t)) {
    const e = new Error('invalid tenant_id')
    e.code = 'invalid_tenant_id'
    throw e
  }
}
function assertSiteId(s) {
  if (!SITE_ID_PATTERN.test(s)) {
    const e = new Error('invalid site_id')
    e.code = 'invalid_site_id'
    throw e
  }
}
function scenarioKey(t, s, id) {
  assertTenantId(t)
  assertSiteId(s)
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    const e = new Error('invalid scenario id')
    e.code = 'invalid_id'
    throw e
  }
  return `scenarios/${t}/${s}/${id}`
}
function scenarioPrefix(t, s) {
  assertTenantId(t)
  assertSiteId(s)
  return `scenarios/${t}/${s}/`
}

// ── In-memory KV mirror (mirrors KvStorage interface) ──

class MockKv {
  constructor() {
    this.store = new Map()
  }
  async getJson(key) {
    const v = this.store.get(key)
    return v === undefined ? null : JSON.parse(v)
  }
  async putJson(key, value) {
    this.store.set(key, JSON.stringify(value))
  }
  async delete(key) {
    return this.store.delete(key)
  }
  async listKeys(prefix = '') {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix))
  }
}

// ── Minimal repository mirror (mirrors createScenarioRepository) ──

function createMockRepo({ now, uuid, storage }) {
  return {
    async list(tenant_id, site_id) {
      const prefix = scenarioPrefix(tenant_id, site_id)
      const keys = await storage.listKeys(prefix)
      const rows = await Promise.all(keys.map((k) => storage.getJson(k)))
      const valid = rows.filter((r) => r !== null)
      valid.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
      return valid
    },
    async get(tenant_id, site_id, scenario_id) {
      return await storage.getJson(scenarioKey(tenant_id, site_id, scenario_id))
    },
    async create(input) {
      const ts = now()
      const row = {
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
      await storage.putJson(scenarioKey(row.tenant_id, row.site_id, row.id), row)
      return row
    },
    async update(tenant_id, site_id, scenario_id, patch) {
      const existing = await storage.getJson(scenarioKey(tenant_id, site_id, scenario_id))
      if (!existing) {
        const e = new Error('not found')
        e.code = 'not_found'
        throw e
      }
      const merged = { ...existing, ...patch, updated_at: now() }
      await storage.putJson(scenarioKey(tenant_id, site_id, scenario_id), merged)
      return merged
    },
    async remove(tenant_id, site_id, scenario_id) {
      return await storage.delete(scenarioKey(tenant_id, site_id, scenario_id))
    },
  }
}

// ── Fixtures ──

const TENANT = 'linkth_internal'
const SITE = 'CIP_EcwUTHEZdIOAUqum' // bihadashop.jp
const FIXED_NOW = '2026-05-28T10:00:00.000Z'
const FIXED_NOW_2 = '2026-05-28T11:00:00.000Z'
const FIXED_UUID_1 = '11111111-2222-4333-8444-555555555555'
const FIXED_UUID_2 = '99999999-8888-4777-9666-555555555555'

const MIN_AST = { op: 'EQ', field: 'utm_source', value: 'google' }
const MIN_VARIANTS = [
  { id: 'A', content_type: 'image', image_url: 'https://example.com/a.png', position: 'center', traffic_split: 100 },
]

function buildCreateInput(overrides = {}) {
  return {
    tenant_id: TENANT,
    site_id: SITE,
    name: 'Test scenario',
    condition_ast: MIN_AST,
    variants: MIN_VARIANTS,
    created_by: 'system',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('§1 KV key helpers (scenarioKey / scenarioPrefix)', () => {
  test('scenarioPrefix builds tenant/site prefix', () => {
    assert.equal(scenarioPrefix(TENANT, SITE), `scenarios/${TENANT}/${SITE}/`)
  })
  test('scenarioKey builds full path with UUID', () => {
    assert.equal(
      scenarioKey(TENANT, SITE, FIXED_UUID_1),
      `scenarios/${TENANT}/${SITE}/${FIXED_UUID_1}`,
    )
  })
  test('invalid tenant_id (uppercase) is rejected', () => {
    assert.throws(() => scenarioPrefix('LINKTH', SITE), /invalid tenant_id/)
  })
  test('invalid tenant_id (special char) is rejected', () => {
    assert.throws(() => scenarioPrefix('linkth.internal', SITE), /invalid tenant_id/)
  })
  test('invalid site_id (special char) is rejected', () => {
    assert.throws(() => scenarioPrefix(TENANT, 'site/path'), /invalid site_id/)
  })
  test('non-UUID scenario_id is rejected', () => {
    assert.throws(() => scenarioKey(TENANT, SITE, 'not-a-uuid'), /invalid scenario id/)
  })
  test('site_id with uppercase is allowed (CIP_ prefix legacy)', () => {
    // bihadashop tracking_id is CIP_EcwUTHEZdIOAUqum (mixed case OK for site_id)
    assert.equal(scenarioPrefix(TENANT, 'CIP_AbCdEf12'), 'scenarios/linkth_internal/CIP_AbCdEf12/')
  })
})

describe('§2 CRUD via mock repository', () => {
  test('create stores row with server-stamped timestamps + id', async () => {
    const kv = new MockKv()
    const repo = createMockRepo({
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID_1,
      storage: kv,
    })
    const created = await repo.create(buildCreateInput())
    assert.equal(created.id, FIXED_UUID_1)
    assert.equal(created.tenant_id, TENANT)
    assert.equal(created.site_id, SITE)
    assert.equal(created.created_at, FIXED_NOW)
    assert.equal(created.updated_at, FIXED_NOW)
    assert.equal(created.status, 'draft')
    assert.equal(created.evidence_level, 'planned')
    assert.equal(created.archived_at, null)

    // KV にも書込されている
    const fetched = await kv.getJson(scenarioKey(TENANT, SITE, FIXED_UUID_1))
    assert.equal(fetched.id, FIXED_UUID_1)
  })

  test('get returns the stored row', async () => {
    const kv = new MockKv()
    const repo = createMockRepo({
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID_1,
      storage: kv,
    })
    await repo.create(buildCreateInput())
    const got = await repo.get(TENANT, SITE, FIXED_UUID_1)
    assert.ok(got)
    assert.equal(got.id, FIXED_UUID_1)
  })

  test('get returns null for missing scenario', async () => {
    const kv = new MockKv()
    const repo = createMockRepo({ now: () => FIXED_NOW, uuid: () => FIXED_UUID_1, storage: kv })
    const got = await repo.get(TENANT, SITE, FIXED_UUID_2)
    assert.equal(got, null)
  })

  test('list returns scenarios filtered by tenant + site prefix', async () => {
    const kv = new MockKv()
    let counter = 0
    const uuids = [FIXED_UUID_1, FIXED_UUID_2]
    const repo = createMockRepo({
      now: () => FIXED_NOW,
      uuid: () => uuids[counter++],
      storage: kv,
    })
    await repo.create(buildCreateInput({ name: 'A' }))
    await repo.create(buildCreateInput({ name: 'B' }))
    // Different site should not appear
    await kv.putJson(`scenarios/${TENANT}/OTHER_SITE/${FIXED_UUID_2}`, {
      id: FIXED_UUID_2,
      tenant_id: TENANT,
      site_id: 'OTHER_SITE',
      name: 'X',
      updated_at: FIXED_NOW,
    })

    const list = await repo.list(TENANT, SITE)
    assert.equal(list.length, 2)
    assert.deepEqual(
      new Set(list.map((s) => s.name)),
      new Set(['A', 'B']),
    )
  })

  test('list orders by updated_at desc', async () => {
    const kv = new MockKv()
    const tsBuffer = [FIXED_NOW, FIXED_NOW_2]
    const uuidBuffer = [FIXED_UUID_1, FIXED_UUID_2]
    let i = 0
    const repo = createMockRepo({
      now: () => tsBuffer[i],
      uuid: () => uuidBuffer[i],
      storage: kv,
    })
    await repo.create(buildCreateInput({ name: 'Older' }))
    i++
    await repo.create(buildCreateInput({ name: 'Newer' }))

    const list = await repo.list(TENANT, SITE)
    assert.equal(list[0].name, 'Newer')
    assert.equal(list[1].name, 'Older')
  })

  test('update merges patch and bumps updated_at', async () => {
    const kv = new MockKv()
    const tsBuffer = [FIXED_NOW, FIXED_NOW_2]
    let i = 0
    const repo = createMockRepo({
      now: () => tsBuffer[i],
      uuid: () => FIXED_UUID_1,
      storage: kv,
    })
    await repo.create(buildCreateInput({ name: 'Old name' }))
    i++
    const updated = await repo.update(TENANT, SITE, FIXED_UUID_1, { name: 'New name' })
    assert.equal(updated.name, 'New name')
    assert.equal(updated.created_at, FIXED_NOW)
    assert.equal(updated.updated_at, FIXED_NOW_2)
  })

  test('update on non-existent scenario throws not_found', async () => {
    const kv = new MockKv()
    const repo = createMockRepo({ now: () => FIXED_NOW, uuid: () => FIXED_UUID_1, storage: kv })
    await assert.rejects(
      () => repo.update(TENANT, SITE, FIXED_UUID_2, { name: 'X' }),
      /not found/,
    )
  })

  test('remove returns true when scenario existed, false otherwise', async () => {
    const kv = new MockKv()
    const repo = createMockRepo({ now: () => FIXED_NOW, uuid: () => FIXED_UUID_1, storage: kv })
    await repo.create(buildCreateInput())
    const removed = await repo.remove(TENANT, SITE, FIXED_UUID_1)
    assert.equal(removed, true)
    const removedAgain = await repo.remove(TENANT, SITE, FIXED_UUID_1)
    assert.equal(removedAgain, false)
    const got = await repo.get(TENANT, SITE, FIXED_UUID_1)
    assert.equal(got, null)
  })

  test('cross-tenant isolation: tenant A list does not include tenant B keys', async () => {
    const kv = new MockKv()
    const repo = createMockRepo({ now: () => FIXED_NOW, uuid: () => FIXED_UUID_1, storage: kv })
    await repo.create(buildCreateInput({ tenant_id: 'tenant_a' }))
    await kv.putJson('scenarios/tenant_b/CIP_X/22222222-3333-4444-8555-666666666666', {
      id: '22222222-3333-4444-8555-666666666666',
      tenant_id: 'tenant_b',
      site_id: 'CIP_X',
      name: 'B',
      updated_at: FIXED_NOW,
    })

    const listA = await repo.list('tenant_a', SITE)
    assert.equal(listA.length, 1)
    assert.equal(listA[0].tenant_id, 'tenant_a')
  })
})

describe('§3 KV key format invariants (D-4 cross-tenant guard parity with Main Director)', () => {
  test('every scenario key starts with `scenarios/{tenant_id}/`', () => {
    const k = scenarioKey('linkth_internal', 'CIP_EcwUTHEZdIOAUqum', FIXED_UUID_1)
    assert.ok(k.startsWith('scenarios/linkth_internal/'))
  })
  test('prefix is tenant + site, not tenant alone', () => {
    const p = scenarioPrefix('linkth_internal', 'CIP_X')
    assert.equal(p, 'scenarios/linkth_internal/CIP_X/')
    // Use case: KV.list({ prefix: 'scenarios/linkth_internal/' }) would leak
    // cross-site keys. Always use full tenant+site prefix.
    assert.ok(!p.endsWith('linkth_internal/'))
  })
})
