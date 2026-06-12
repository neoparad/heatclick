/**
 * repository.test.ts — updateScenario の authorize フック単体テスト
 *
 * REQ-SEC-010 (HIGH, Codex dual review): route の preflight だけでは
 * 「preflight が draft を見た後に owner が publish する」TOCTOU を塞げない。
 * updateScenario は書込みに使う authoritative read (`existing`) に対して
 * authorize を呼ぶため、ここで最新 status を見て弾けることを検証する。
 */

import { createScenarioRepository, ScenarioForbiddenError } from './repository'
import type { KvStorage } from './kv-storage'
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
    expect(putJson).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy behavior when authorize is omitted', async () => {
    const { kv, putJson } = makeFakeKv(baseScenario({ status: 'live' }))
    const repo = createScenarioRepository({ storage: kv })

    const updated = await repo.updateScenario(TENANT, SITE, ID, { name: 'no guard' })

    expect(updated.name).toBe('no guard')
    expect(putJson).toHaveBeenCalledTimes(1)
  })
})
