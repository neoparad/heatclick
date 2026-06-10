import {
  createExperimentRepository,
  InMemoryExperimentStore,
  ExperimentNotFoundError,
  ExperimentLockError,
  ExperimentStateError,
  type CreateExperimentInput,
  type ExperimentRepository,
} from '@/lib/experiments/repository'
import { ExperimentSchema, type LockedTaxonomy } from '@/lib/experiments/types'

const TAXONOMY: LockedTaxonomy = {
  intervention_type: 'cta_placement',
  page_type: 'product',
  industry: 'd2c_ec',
  device: 'mobile',
  primary_metric: 'cvr',
  window: '28d',
}

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
]

function makeRepo(): ExperimentRepository {
  let seq = 0
  return createExperimentRepository({
    store: new InMemoryExperimentStore(),
    now: () => '2026-06-10T00:00:00.000Z',
    uuid: () => UUIDS[seq++] ?? `00000000-0000-4000-8000-0000000000${seq}`,
  })
}

function draftInput(over: Partial<CreateExperimentInput> = {}): CreateExperimentInput {
  return {
    tenant_id: 'tnt_a',
    site_id: 'CIP_a',
    name: 'mobile CTA placement',
    url_pattern: '/products',
    taxonomy: TAXONOMY,
    created_by: 'owner@ugokimap.com',
    ...over,
  }
}

describe('experiments/repository — create + read', () => {
  it('create は draft で永続化し get で読める', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    expect(created.status).toBe('draft')
    expect(created.id).toBe(UUIDS[0])
    const fetched = await repo.get('tnt_a', 'CIP_a', created.id)
    expect(fetched?.name).toBe('mobile CTA placement')
  })

  it('別テナントからは get できない (tenant 隔離 §3.8.1)', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    expect(await repo.get('tnt_b', 'CIP_a', created.id)).toBeNull()
    expect(await repo.get('tnt_a', 'CIP_other', created.id)).toBeNull()
  })

  it('list は当該 tenant+site のみ返す', async () => {
    const repo = makeRepo()
    await repo.create(draftInput())
    await repo.create(draftInput({ tenant_id: 'tnt_b' }))
    const listed = await repo.list('tnt_a', 'CIP_a')
    expect(listed).toHaveLength(1)
    expect(listed[0].tenant_id).toBe('tnt_a')
  })
})

describe('experiments/repository — lifecycle', () => {
  it('start で draft → running、end_at = start + 28d、locked_at を刻む', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    const started = await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    expect(started.status).toBe('running')
    expect(started.locked_at).toBe('2026-06-10T00:00:00.000Z')
    expect(started.dates.start_at).toBe('2026-06-10T00:00:00.000Z')
    expect(started.dates.end_at).toBe('2026-07-08T00:00:00.000Z') // +28d
  })

  it('draft でない実験の start は ExperimentStateError', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    await expect(repo.start('tnt_a', 'CIP_a', created.id, '2026-06-11T00:00:00.000Z')).rejects.toThrow(
      ExperimentStateError,
    )
  })

  it('running を stop → stopped、stopped_at を刻む', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    const stopped = await repo.stop('tnt_a', 'CIP_a', created.id)
    expect(stopped.status).toBe('stopped')
    expect(stopped.stopped_at).toBe('2026-06-10T00:00:00.000Z')
  })

  it('running でない実験の stop は ExperimentStateError', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await expect(repo.stop('tnt_a', 'CIP_a', created.id)).rejects.toThrow(ExperimentStateError)
  })

  it('archive は archived にし archived_at を刻む', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    const archived = await repo.archive('tnt_a', 'CIP_a', created.id)
    expect(archived.status).toBe('archived')
    expect(archived.archived_at).toBe('2026-06-10T00:00:00.000Z')
  })
})

describe('experiments/repository — lock 不変条件 (事前登録)', () => {
  it('draft 中は taxonomy 編集可', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    const updated = await repo.update('tnt_a', 'CIP_a', created.id, {
      taxonomy: { ...TAXONOMY, device: 'desktop' },
    })
    expect(updated.taxonomy.device).toBe('desktop')
  })

  it('running 後の taxonomy 変更は ExperimentLockError', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    await expect(
      repo.update('tnt_a', 'CIP_a', created.id, { taxonomy: { ...TAXONOMY, device: 'desktop' } }),
    ).rejects.toThrow(ExperimentLockError)
  })

  it('running 後でも name は編集可 (locked field でない)', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    const renamed = await repo.update('tnt_a', 'CIP_a', created.id, { name: 'renamed' })
    expect(renamed.name).toBe('renamed')
  })

  it('running 後の url_pattern / salt_version 変更は ExperimentLockError', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    await expect(repo.update('tnt_a', 'CIP_a', created.id, { url_pattern: '/x' })).rejects.toThrow(
      ExperimentLockError,
    )
    await expect(repo.update('tnt_a', 'CIP_a', created.id, { salt_version: 2 })).rejects.toThrow(
      ExperimentLockError,
    )
  })
})

describe('experiments/repository — not found', () => {
  it('存在しない id の update は ExperimentNotFoundError', async () => {
    const repo = makeRepo()
    await expect(repo.update('tnt_a', 'CIP_a', UUIDS[2], { name: 'x' })).rejects.toThrow(
      ExperimentNotFoundError,
    )
  })
})

describe('experiments/repository — archive 状態機械 (Codex HIGH)', () => {
  it('draft は archive 可 (破棄)', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    const archived = await repo.archive('tnt_a', 'CIP_a', created.id)
    expect(archived.status).toBe('archived')
    expect(archived.archived_at).toBe('2026-06-10T00:00:00.000Z')
  })

  it('running の archive は不可 (先に stop)', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    await expect(repo.archive('tnt_a', 'CIP_a', created.id)).rejects.toThrow(ExperimentStateError)
  })

  it('stopped は archive 可', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', created.id, '2026-06-10T00:00:00.000Z')
    await repo.stop('tnt_a', 'CIP_a', created.id)
    const archived = await repo.archive('tnt_a', 'CIP_a', created.id)
    expect(archived.status).toBe('archived')
  })
})

describe('experiments/repository — immutability (Codex MEDIUM)', () => {
  it('返却 experiment の変異は stored state を汚さない', async () => {
    const repo = makeRepo()
    const created = await repo.create(draftInput())
    created.taxonomy.device = 'desktop' // mutate the returned object
    created.name = 'mutated'
    const refetched = await repo.get('tnt_a', 'CIP_a', created.id)
    expect(refetched?.taxonomy.device).toBe('mobile') // store は汚れない
    expect(refetched?.name).toBe('mobile CTA placement')
  })
})

describe('experiments/repository — listActiveForAssignment (Codex M2b)', () => {
  it('running + window 内のみ返す', async () => {
    const repo = makeRepo()
    const c = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', c.id, '2026-06-10T00:00:00.000Z') // window 6/10..7/8
    const active = await repo.listActiveForAssignment('tnt_a', 'CIP_a', '2026-06-15T00:00:00.000Z')
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(c.id)
  })

  it('draft / stopped は除外', async () => {
    const repo = makeRepo()
    await repo.create(draftInput()) // draft のまま
    const running = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', running.id, '2026-06-10T00:00:00.000Z')
    await repo.stop('tnt_a', 'CIP_a', running.id) // stopped
    const active = await repo.listActiveForAssignment('tnt_a', 'CIP_a', '2026-06-15T00:00:00.000Z')
    expect(active).toHaveLength(0)
  })

  it('window 前 / end ちょうど / 後は除外', async () => {
    const repo = makeRepo()
    const c = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', c.id, '2026-06-10T00:00:00.000Z') // 6/10..7/8
    expect(await repo.listActiveForAssignment('tnt_a', 'CIP_a', '2026-06-09T00:00:00.000Z')).toHaveLength(0)
    expect(await repo.listActiveForAssignment('tnt_a', 'CIP_a', '2026-07-08T00:00:00.000Z')).toHaveLength(0) // end 排他
    expect(await repo.listActiveForAssignment('tnt_a', 'CIP_a', '2026-07-09T00:00:00.000Z')).toHaveLength(0)
  })

  it('別テナントは除外 (§3.8.1)', async () => {
    const repo = makeRepo()
    const c = await repo.create(draftInput())
    await repo.start('tnt_a', 'CIP_a', c.id, '2026-06-10T00:00:00.000Z')
    expect(await repo.listActiveForAssignment('tnt_b', 'CIP_a', '2026-06-15T00:00:00.000Z')).toHaveLength(0)
  })

  it('running でも null 日付は除外 (fail-closed、スキーマは null を許すため)', async () => {
    const store = new InMemoryExperimentStore()
    // start() を経由せず running + null 日付の不正行を直接挿入
    const bad = ExperimentSchema.parse({
      id: '00000000-0000-4000-8000-0000000000aa',
      tenant_id: 'tnt_a',
      site_id: 'CIP_a',
      name: 'bad import',
      url_pattern: '/products',
      taxonomy: TAXONOMY,
      status: 'running',
      dates: { start_at: null, end_at: null },
      salt_version: 1,
      consent: { pool_opt_in: false, k_anonymity_min: 50 },
      created_at: '2026-06-10T00:00:00.000Z',
      updated_at: '2026-06-10T00:00:00.000Z',
      created_by: 'owner@ugokimap.com',
      locked_at: '2026-06-10T00:00:00.000Z',
      stopped_at: null,
      archived_at: null,
    })
    await store.insert(bad)
    expect(await store.listActiveForAssignment('tnt_a', 'CIP_a', '2026-06-15T00:00:00.000Z')).toHaveLength(0)
  })
})
