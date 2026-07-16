/**
 * repository.test.ts — CvDefinition CRUD + tenant isolation (REQ-SEC-004) + 楽観ロック
 *
 * in-memory KvStorage を注入して createCvDefinitionRepository を検証する。
 * lib/paths/repository.test.ts と同方針 (HTTP モックではなく DI)。
 */

import {
  CvDefinitionLimitExceededError,
  CvDefinitionNotFoundError,
  CvDefinitionValidationError,
  CvDefinitionVersionConflictError,
  createCvDefinitionRepository,
} from './repository'
import { MAX_CV_DEFINITIONS_PER_SITE } from './types'
import type { KvStorage } from '@/lib/scenarios/kv-storage'

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
  return createCvDefinitionRepository({
    storage,
    now: () => `2026-07-16T00:00:0${Math.min(counter, 9)}.000Z`,
    uuid: () => {
      counter += 1
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
    },
  })
}

const baseInput = {
  tenant_id: TENANT_A,
  site_id: SITE,
  name: '楽天アフィリ送客',
  cvKey: 'affiliate_rakuten',
  enabled: true,
  trigger: {
    kind: 'click' as const,
    conditions: { hrefHosts: ['rakuten.co.jp'] },
  },
  value: { mode: 'none' as const },
  created_by: 'owner_1',
}

describe('createCvDefinition', () => {
  it('永続化され version=1・enabled維持で返る', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)

    expect(created.version).toBe(1)
    expect(created.enabled).toBe(true)
    expect(created.cvKey).toBe('affiliate_rakuten')
    expect(created.created_at).toBe(created.updated_at)

    const stored = await repo.getCvDefinition(TENANT_A, SITE, created.id)
    expect(stored?.name).toBe('楽天アフィリ送客')
  })

  it('同一site内でcvKeyが重複すると拒否される', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    await repo.createCvDefinition(baseInput)

    await expect(
      repo.createCvDefinition({ ...baseInput, name: '別名だがcvKey同じ' }),
    ).rejects.toThrow(CvDefinitionValidationError)
  })

  it(`site上限 ${MAX_CV_DEFINITIONS_PER_SITE} 件を超えると拒否される`, async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    for (let i = 0; i < MAX_CV_DEFINITIONS_PER_SITE; i++) {
      await repo.createCvDefinition({ ...baseInput, cvKey: `key_${i}`, name: `def_${i}` })
    }
    await expect(
      repo.createCvDefinition({ ...baseInput, cvKey: 'one_too_many', name: 'overflow' }),
    ).rejects.toThrow(CvDefinitionLimitExceededError)
  })
})

describe('listCvDefinitions', () => {
  it('作成順(新しい順)で返る', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const first = await repo.createCvDefinition(baseInput)
    const second = await repo.createCvDefinition({ ...baseInput, cvKey: 'affiliate_amazon', name: '二番目' })

    const list = await repo.listCvDefinitions(TENANT_A, SITE)
    expect(list.map((d) => d.id)).toEqual([second.id, first.id])
  })

  it('index が壊れていても listKeys で保険復旧する (KV結果整合対策)', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)
    // index を意図的に破壊 (実運用でKV結果整合が崩れるケースを模擬)
    await kv.putJson(`cvdef-index/${TENANT_A}/${SITE}`, [])

    const list = await repo.listCvDefinitions(TENANT_A, SITE)
    expect(list.map((d) => d.id)).toEqual([created.id])
  })

  it('他tenant/他siteの定義が同一listに紛れ込まない (REQ-SEC-004)', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    await repo.createCvDefinition(baseInput)
    await repo.createCvDefinition({ ...baseInput, tenant_id: TENANT_B, cvKey: 'other_tenant_key' })

    const listA = await repo.listCvDefinitions(TENANT_A, SITE)
    expect(listA).toHaveLength(1)
    const listB = await repo.listCvDefinitions(TENANT_B, SITE)
    expect(listB).toHaveLength(1)
  })
})

describe('getCvDefinition — REQ-SEC-004 (行の所有権再検証)', () => {
  it('key を細工しても row の tenant_id 不一致で NotFound (存在露呈しない)', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)

    // 他tenantとして同じ id を取得しようとする -> 404相当 (403でなく)
    await expect(repo.getCvDefinition(TENANT_B, SITE, created.id)).resolves.toBeNull()
  })
})

describe('updateCvDefinition', () => {
  it('versionをインクリメントし updated_at を更新する', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)

    const updated = await repo.updateCvDefinition(TENANT_A, SITE, created.id, { enabled: false })
    expect(updated.version).toBe(2)
    expect(updated.enabled).toBe(false)
    expect(updated.updated_at).not.toBe(created.updated_at)
  })

  it('expectedVersion 不一致は VersionConflictError (best-effort楽観ロック)', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)
    await repo.updateCvDefinition(TENANT_A, SITE, created.id, { enabled: false })

    await expect(
      repo.updateCvDefinition(
        TENANT_A,
        SITE,
        created.id,
        { name: '競合更新' },
        { expectedVersion: created.version },
      ),
    ).rejects.toThrow(CvDefinitionVersionConflictError)
  })

  it('存在しないIDはNotFoundError', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    await expect(
      repo.updateCvDefinition(TENANT_A, SITE, '00000000-0000-4000-8000-000000000099', { enabled: false }),
    ).rejects.toThrow(CvDefinitionNotFoundError)
  })

  it('cvKeyを他定義と重複させる更新は拒否される', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const first = await repo.createCvDefinition(baseInput)
    const second = await repo.createCvDefinition({ ...baseInput, cvKey: 'affiliate_amazon', name: '二番目' })

    await expect(
      repo.updateCvDefinition(TENANT_A, SITE, second.id, { cvKey: first.cvKey }),
    ).rejects.toThrow(CvDefinitionValidationError)
  })

  it('自分自身のcvKeyへの更新(変更なし)は許容される', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)
    const updated = await repo.updateCvDefinition(TENANT_A, SITE, created.id, { cvKey: created.cvKey })
    expect(updated.cvKey).toBe(created.cvKey)
  })
})

describe('deleteCvDefinition', () => {
  it('削除後は取得できずindexからも消える', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)

    const deleted = await repo.deleteCvDefinition(TENANT_A, SITE, created.id)
    expect(deleted).toBe(true)
    expect(await repo.getCvDefinition(TENANT_A, SITE, created.id)).toBeNull()
    expect(await repo.listCvDefinitions(TENANT_A, SITE)).toHaveLength(0)
  })

  it('存在しないIDの削除はfalse', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    expect(
      await repo.deleteCvDefinition(TENANT_A, SITE, '00000000-0000-4000-8000-000000000099'),
    ).toBe(false)
  })

  it('他tenantの定義は削除できない (存在しない扱い)', async () => {
    const kv = makeKv()
    const repo = deterministicRepo(kv)
    const created = await repo.createCvDefinition(baseInput)

    expect(await repo.deleteCvDefinition(TENANT_B, SITE, created.id)).toBe(false)
    // 元tenantからはまだ取得できる (削除されていない)
    expect(await repo.getCvDefinition(TENANT_A, SITE, created.id)).not.toBeNull()
  })
})
