/**
 * repository.test.ts — PathSet CRUD + tenant isolation (REQ-SEC-004)
 *
 * in-memory KvStorage を注入して、createPathSetRepository の CRUD と所有権再検証を検証する。
 * lib/scenarios/repository.test.ts と同方針 (HTTP モックではなく DI)。
 */

import { PathSetNotFoundError, createPathSetRepository, pathSetKey } from './repository'
import type { KvStorage } from '@/lib/scenarios/kv-storage'
import type { PathSet } from './types'

const TENANT_A = 'tenant_a'
const TENANT_B = 'tenant_b'
const SITE = 'CIP_site_a'

function makeKv(seed: Array<[string, unknown]> = []): KvStorage {
  const store = new Map<string, unknown>(seed)
  return {
    async getJson(key: string) {
      return store.has(key) ? store.get(key) : null
    },
    async putJson(key: string, value: unknown) {
      store.set(key, value)
    },
    async delete(key: string) {
      return store.delete(key)
    },
    async listKeys(prefix?: string) {
      return [...store.keys()].filter((k) => !prefix || k.startsWith(prefix))
    },
  } as unknown as KvStorage
}

let counter = 0
function deterministicRepo(storage: KvStorage) {
  counter = 0
  return createPathSetRepository({
    storage,
    now: () => `2026-06-17T00:00:0${counter}.000Z`,
    uuid: () => {
      counter += 1
      return `00000000-0000-4000-8000-00000000000${counter}`
    },
  })
}

const baseInput = {
  tenant_id: TENANT_A,
  site_id: SITE,
  name: '商品購入比較',
  trigger: { title: 'TOP 訪問', url: '/' },
  branches: [
    {
      name: '経路 A',
      description: '直行',
      steps: [
        { title: '商品ページ', url: '/products/*' },
        { title: '購入完了', url: '/thanks/' },
      ],
    },
  ],
  created_by: 'owner_1',
}

describe('createPathSet', () => {
  it('persists a draft pathset with built branches (empty stats, last step = CV)', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createPathSet(baseInput)

    expect(created.status).toBe('draft')
    expect(created.isDummy).toBe(false)
    expect(created.evidence_level).toBe('planned')
    expect(created.branches).toHaveLength(1)
    const branch = created.branches[0]
    expect(branch.id).toBe('A')
    expect(branch.nodes).toHaveLength(2)
    expect(branch.nodes[0].stats).toEqual([])
    expect(branch.nodes[0].step).toBe('A1')
    expect(branch.nodes[1].step).toBe('CV')
    expect(branch.edges).toHaveLength(1)
    expect(branch.summary.cvRate).toBe('—')

    const stored = await repo.getPathSet(TENANT_A, SITE, created.id)
    expect(stored?.name).toBe('商品購入比較')
  })
})

describe('listPathSets', () => {
  it('returns non-archived sets sorted by updated_at desc', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const first = await repo.createPathSet(baseInput)
    const second = await repo.createPathSet({ ...baseInput, name: '二番目' })

    const list = await repo.listPathSets(TENANT_A, SITE)
    expect(list.map((p) => p.id)).toEqual([second.id, first.id])
  })

  it('excludes archived sets', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createPathSet(baseInput)
    await repo.updatePathSet(TENANT_A, SITE, created.id, {
      status: 'archived',
    })
    // status=archived だけでは list に残る; archived_at をセットしたものだけ除外する設計のため
    // ここでは archived_at を直接立てたケースを検証する。
    const key = pathSetKey(TENANT_A, SITE, created.id)
    const raw = (await kv.getJson<PathSet>(key))!
    await kv.putJson(key, { ...raw, archived_at: '2026-06-17T01:00:00.000Z' })

    const list = await repo.listPathSets(TENANT_A, SITE)
    expect(list).toHaveLength(0)
  })
})

describe('tenant isolation (REQ-SEC-004)', () => {
  it('getPathSet returns null for a non-existent set in this tenant', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const got = await repo.getPathSet(TENANT_A, SITE, '00000000-0000-4000-8000-000000000099')
    expect(got).toBeNull()
  })

  it('throws not-found when stored row tenant_id mismatches the key (key/data drift)', async () => {
    const id = '00000000-0000-4000-8000-0000000000ff'
    // tenant_a の key の下に、body は tenant_b の row を仕込む (drift / collision を模擬)
    const driftRow: PathSet = {
      ...mkRow(id, TENANT_B, SITE),
    }
    const kv = makeKv([[pathSetKey(TENANT_A, SITE, id), driftRow]])
    const repo = deterministicRepo(kv)

    await expect(repo.getPathSet(TENANT_A, SITE, id)).rejects.toBeInstanceOf(PathSetNotFoundError)
  })

  it('listPathSets skips rows whose own tenant/site do not match', async () => {
    const id = '00000000-0000-4000-8000-0000000000ee'
    const driftRow = mkRow(id, TENANT_B, SITE)
    const kv = makeKv([
      [pathSetKey(TENANT_A, SITE, id), driftRow],
      [`pathset-index/${TENANT_A}/${SITE}`, [id]],
    ])
    const repo = deterministicRepo(kv)
    const list = await repo.listPathSets(TENANT_A, SITE)
    expect(list).toHaveLength(0)
  })
})

describe('updatePathSet / deletePathSet', () => {
  it('patches name + status', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createPathSet(baseInput)
    const updated = await repo.updatePathSet(TENANT_A, SITE, created.id, {
      name: '改名',
      status: 'monitoring',
    })
    expect(updated.name).toBe('改名')
    expect(updated.status).toBe('monitoring')
    expect(updated.updated_at >= created.updated_at).toBe(true)
  })

  it('delete removes the set and returns false for missing', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createPathSet(baseInput)
    expect(await repo.deletePathSet(TENANT_A, SITE, created.id)).toBe(true)
    expect(await repo.getPathSet(TENANT_A, SITE, created.id)).toBeNull()
    expect(await repo.deletePathSet(TENANT_A, SITE, created.id)).toBe(false)
  })
})

// ── helper ───────────────────────────────────────────────────────────────────

function mkRow(id: string, tenantId: string, siteId: string): PathSet {
  return {
    id,
    tenant_id: tenantId,
    site_id: siteId,
    name: 'row',
    description: '',
    status: 'draft',
    trigger: { title: 't', url: '/', periodDays: 30, sessions: '—' },
    branches: [
      {
        id: 'A',
        name: '経路 A',
        description: '',
        severity: 'ok',
        nodes: [{ id: 'A1', step: 'CV', title: 's', url: '/', stats: [] }],
        edges: [],
        summary: { cvRate: '—', delta: '', deltaTone: 'pos' },
      },
    ],
    insights: [],
    isDummy: false,
    evidence_level: 'planned',
    evidence_data: {},
    averageCvRate: '—',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    created_by: 'x',
    archived_at: null,
  }
}
