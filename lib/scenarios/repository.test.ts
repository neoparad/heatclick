/**
 * repository.test.ts — updateScenario の authorize フック単体テスト
 *
 * REQ-SEC-010 (HIGH, Codex dual review): route の preflight だけでは
 * 「preflight が draft を見た後に owner が publish する」TOCTOU を塞げない。
 * updateScenario は書込みに使う authoritative read (`existing`) に対して
 * authorize を呼ぶため、ここで最新 status を見て弾けることを検証する。
 */

import {
  createScenarioRepository,
  ScenarioForbiddenError,
  type CreateScenarioInput,
} from './repository'
import { CloudflareKvError, type KvStorage } from './kv-storage'
import type { Scenario } from './types'

const TENANT = 'tenant_a'
const SITE = 'CIP_site_a'
const ID = '00000000-0000-4000-8000-000000000001'
const KEY = `scenarios/${TENANT}/${SITE}/${ID}`

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: ID,
    tenant_id: TENANT,
    site_id: SITE,
    name: 'banner',
    description: '',
    condition_ast: { op: 'EQ', field: 'utm_source', value: 'google' },
    variants: [
      {
        id: 'A',
        content_type: 'image',
        image_url: 'https://cdn.example.com/a.png',
        image_alt: '',
        position: 'center',
        traffic_split: 100,
      },
    ],
    status: 'live',
    evidence_level: 'planned',
    evidence_data: {},
    frequency_cap: null,
    schedule: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    created_by: 'owner_1',
    archived_at: null,
    ...overrides,
  } as Scenario
}

function makeFakeKv(seed?: Scenario): { kv: KvStorage; putJson: jest.Mock } {
  const store = new Map<string, unknown>()
  if (seed) store.set(KEY, seed)
  const putJson = jest.fn(async (key: string, value: unknown) => {
    store.set(key, value)
  })
  const kv = {
    async getJson(key: string) {
      return store.has(key) ? store.get(key) : null
    },
    putJson,
    async delete(key: string) {
      return store.delete(key)
    },
    async listKeys(prefix?: string) {
      return [...store.keys()].filter((k) => !prefix || k.startsWith(prefix))
    },
  } as unknown as KvStorage
  return { kv, putJson }
}

const newImageVariant = [
  {
    id: 'A',
    content_type: 'image' as const,
    image_url: 'https://cdn.example.com/b.png',
    image_alt: '',
    position: 'center' as const,
    traffic_split: 100,
  },
]

describe('updateScenario authorize hook (REQ-SEC-010 TOCTOU close)', () => {
  it('runs authorize against the authoritative existing row and aborts the write when it throws', async () => {
    const { kv, putJson } = makeFakeKv(baseScenario({ status: 'live' }))
    const repo = createScenarioRepository({ storage: kv })
    let seenStatus: string | undefined

    await expect(
      repo.updateScenario(
        TENANT,
        SITE,
        ID,
        { variants: newImageVariant },
        {
          authorize: (existing) => {
            seenStatus = existing.status
            if (existing.status === 'live') throw new ScenarioForbiddenError('blocked')
          },
        },
      ),
    ).rejects.toBeInstanceOf(ScenarioForbiddenError)

    // authorize は authoritative な live 行を見た & 書込みは発生していない
    expect(seenStatus).toBe('live')
    expect(putJson).not.toHaveBeenCalled()
    const after = (await kv.getJson(KEY)) as Scenario
    expect(after.variants[0].content_type === 'image' && after.variants[0].image_url).toBe(
      'https://cdn.example.com/a.png',
    )
  })

  it('proceeds with the write when authorize does not throw (existing is draft)', async () => {
    const { kv, putJson } = makeFakeKv(baseScenario({ status: 'draft' }))
    const repo = createScenarioRepository({ storage: kv })

    const updated = await repo.updateScenario(
      TENANT,
      SITE,
      ID,
      { name: 'edited while draft' },
      {
        authorize: (existing) => {
          if (existing.status === 'live') throw new ScenarioForbiddenError('blocked')
        },
      },
    )

    expect(updated.name).toBe('edited while draft')
    // index 更新の put も走るため、call 数ではなく scenario 本体キーへの書込みで検証する
    expect(putJson).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ id: ID, name: 'edited while draft' }),
    )
  })

  it('keeps legacy behavior when authorize is omitted', async () => {
    const { kv, putJson } = makeFakeKv(baseScenario({ status: 'live' }))
    const repo = createScenarioRepository({ storage: kv })

    const updated = await repo.updateScenario(TENANT, SITE, ID, { name: 'no guard' })

    expect(updated.name).toBe('no guard')
    expect(putJson).toHaveBeenCalledWith(KEY, expect.objectContaining({ id: ID, name: 'no guard' }))
  })
})

// ── Scenario index (KV list 結果整合バグ対策、続: runtime 断続配信落ち修正) ──────────
//
// Cloudflare KV の list(/keys) は結果整合で書きたてキーを取りこぼす。配信 read を list に
// 依存させず index キー (直接 get) を primary にしたことの回帰テスト。
// 中核: 「listKeys が空/throw でも、index 経由で確実に配信に乗る」。

const INDEX_KEY = `scenario-index/${TENANT}/${SITE}`
const VALID_AST = {
  op: 'AND',
  children: [{ op: 'GTE', field: 'session_duration_sec', value: 10 }],
} as Scenario['condition_ast']
const CREATE_INPUT: CreateScenarioInput = {
  tenant_id: TENANT,
  site_id: SITE,
  name: 'indexed banner',
  condition_ast: VALID_AST,
  variants: [
    {
      id: 'A',
      content_type: 'image',
      image_url: 'https://cdn.example.com/a.png',
      image_alt: '',
      position: 'center',
      traffic_split: 100,
    },
  ],
  created_by: 'owner_1',
}

function makeIndexKv(opts: { listKeys?: (prefix?: string) => Promise<string[]> } = {}): {
  kv: KvStorage
  store: Map<string, unknown>
} {
  const store = new Map<string, unknown>()
  const kv = {
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
      if (opts.listKeys) return opts.listKeys(prefix)
      return [...store.keys()].filter((k) => !prefix || k.startsWith(prefix))
    },
  } as unknown as KvStorage
  return { kv, store }
}

describe('scenario index (KV list 結果整合バグ対策)', () => {
  it('createScenario records the new id in the per-site index key', async () => {
    const { kv, store } = makeIndexKv()
    const repo = createScenarioRepository({
      storage: kv,
      uuid: () => ID,
      now: () => '2026-06-01T00:00:00.000Z',
    })
    await repo.createScenario(CREATE_INPUT)
    expect(store.get(INDEX_KEY)).toEqual([ID])
  })

  it('listScenarios returns the scenario via the index even when listKeys() returns [] (KV list eventual-consistency miss)', async () => {
    // list がまだ書込みを反映していない状況を再現 — 旧実装ではここで配信から落ちていた
    const { kv } = makeIndexKv({ listKeys: async () => [] })
    const repo = createScenarioRepository({
      storage: kv,
      uuid: () => ID,
      now: () => '2026-06-01T00:00:00.000Z',
    })
    await repo.createScenario(CREATE_INPUT)
    const list = await repo.listScenarios(TENANT, SITE)
    expect(list.map((s) => s.id)).toEqual([ID])
  })

  it('listScenarios still returns index-backed scenarios when listKeys() throws (list flakiness)', async () => {
    const { kv } = makeIndexKv({
      listKeys: async () => {
        throw new CloudflareKvError('list flaky')
      },
    })
    const repo = createScenarioRepository({
      storage: kv,
      uuid: () => ID,
      now: () => '2026-06-01T00:00:00.000Z',
    })
    await repo.createScenario(CREATE_INPUT)
    const list = await repo.listScenarios(TENANT, SITE)
    expect(list.map((s) => s.id)).toEqual([ID])
  })

  it('listScenarios still finds a legacy key present only via listKeys (no index entry) — no regression', async () => {
    const { kv, store } = makeIndexKv()
    store.set(KEY, baseScenario()) // index 無しで直接書かれた旧データ
    const repo = createScenarioRepository({ storage: kv })
    const list = await repo.listScenarios(TENANT, SITE)
    expect(list.map((s) => s.id)).toEqual([ID])
  })

  it('updateScenario backfills the index for a legacy scenario that had no index entry', async () => {
    const { kv, store } = makeIndexKv()
    store.set(KEY, baseScenario({ status: 'draft' }))
    expect(store.get(INDEX_KEY)).toBeUndefined()
    const repo = createScenarioRepository({ storage: kv, now: () => '2026-06-02T00:00:00.000Z' })
    await repo.updateScenario(TENANT, SITE, ID, { name: 'touched' })
    expect(store.get(INDEX_KEY)).toEqual([ID])
  })

  it('deleteScenario removes the id from the index', async () => {
    const { kv, store } = makeIndexKv()
    const repo = createScenarioRepository({
      storage: kv,
      uuid: () => ID,
      now: () => '2026-06-01T00:00:00.000Z',
    })
    await repo.createScenario(CREATE_INPUT)
    expect(store.get(INDEX_KEY)).toEqual([ID])
    await repo.deleteScenario(TENANT, SITE, ID)
    expect(store.get(INDEX_KEY)).toEqual([])
  })

  it('listScenarios throws CloudflareKvError when BOTH index get and listKeys fail (KV down → route POC fallback)', async () => {
    const kv = {
      async getJson() {
        throw new CloudflareKvError('get down')
      },
      async putJson() {},
      async delete() {
        return false
      },
      async listKeys() {
        throw new CloudflareKvError('list down')
      },
    } as unknown as KvStorage
    const repo = createScenarioRepository({ storage: kv })
    await expect(repo.listScenarios(TENANT, SITE)).rejects.toBeInstanceOf(CloudflareKvError)
  })
})
