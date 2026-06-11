/**
 * /api/experiments/pool boundary tests (残タスク④ cron 化)
 *
 * 検証:
 *   GET (cron 経路、api-public 化に伴い route 内認証が唯一の門):
 *     - 認証 header なし → 401・recompute 未実行
 *     - x-vercel-cron: 1 → 200 (Vercel が外部からの x-vercel-* を strip する前提)
 *     - x-cron-secret 一致 → 200 / 不一致 → 401
 *   POST (operator 経路):
 *     - session なし → 401
 *     - owner でも allowlist 外 → 403
 *     - allowlist 内 owner → 200
 *     - EXPERIMENTS_POOL_OPERATORS 未設定 → 503 (fail-closed)
 *   共通: abort summary → 503
 */

const mockGetServerSession = jest.fn()
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: () => mockGetServerSession(),
}))

const mockRecompute = jest.fn()
jest.mock('@/lib/experiments/pool-aggregate', () => ({
  recomputePoolCells: (...args: unknown[]) => mockRecompute(...args),
}))
jest.mock('@/lib/experiments/pool-store', () => ({
  PostgresPoolableSource: class {},
  PostgresPoolCellStore: class {},
}))
jest.mock('@/lib/experiments/arm-stats', () => ({
  queryArmStats: jest.fn(),
}))

import { GET as CronGet, POST as OperatorPost } from '../pool/route'

const URL_POOL = 'https://app.example.com/api/experiments/pool'
const SALT = 'test_salt_v1_0123456789abcdefghijABC'

function summary(over: Partial<Record<string, unknown>> = {}) {
  return {
    experiments_considered: 30,
    experiments_contributed: 30,
    measure_failures: 0,
    cells_considered: 1,
    cells_published: 1,
    cells_removed: 0,
    aborted: false,
    ...over,
  }
}

function makeSession(role: string, email: string) {
  return {
    user: { sub: 'u1', email, name: 'x', tenant_id: 't1', plan: 'starter', site_ids: ['s1'], role },
    tenant_id: 't1',
    user_id: 'u1',
  }
}

const ENV_KEYS = ['EXPERIMENT_ASSIGN_SALT', 'EXPERIMENTS_POOL_OPERATORS', 'CRON_SECRET', 'VERCEL'] as const
const envBackup: Record<string, string | undefined> = {}

beforeEach(() => {
  jest.clearAllMocks()
  for (const k of ENV_KEYS) envBackup[k] = process.env[k]
  process.env.EXPERIMENT_ASSIGN_SALT = SALT
  process.env.EXPERIMENTS_POOL_OPERATORS = 'ops@ugokimap.com'
  process.env.CRON_SECRET = 'cron-secret-xyz'
  process.env.VERCEL = '1' // x-vercel-cron は Vercel runtime のみ信頼 (Codex LOW)
  mockRecompute.mockResolvedValue(summary())
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k]
    else process.env[k] = envBackup[k]
  }
})

describe('GET /api/experiments/pool — cron 認証', () => {
  it('認証 header なし → 401・recompute 未実行', async () => {
    const res = await CronGet(new Request(URL_POOL))
    expect(res.status).toBe(401)
    expect(mockRecompute).not.toHaveBeenCalled()
  })

  it('x-vercel-cron: 1 → 200', async () => {
    const res = await CronGet(new Request(URL_POOL, { headers: { 'x-vercel-cron': '1' } }))
    expect(res.status).toBe(200)
    expect(mockRecompute).toHaveBeenCalledTimes(1)
  })

  it('x-cron-secret 一致 → 200 / 不一致 → 401', async () => {
    const ok = await CronGet(new Request(URL_POOL, { headers: { 'x-cron-secret': 'cron-secret-xyz' } }))
    expect(ok.status).toBe(200)
    const ng = await CronGet(new Request(URL_POOL, { headers: { 'x-cron-secret': 'wrong' } }))
    expect(ng.status).toBe(401)
  })

  it('CRON_SECRET 未設定時は x-cron-secret では通らない', async () => {
    delete process.env.CRON_SECRET
    const res = await CronGet(new Request(URL_POOL, { headers: { 'x-cron-secret': '' } }))
    expect(res.status).toBe(401)
  })

  it('CRON_SECRET 設定済で x-cron-secret が空 → 401 (Codex LOW boundary)', async () => {
    const res = await CronGet(new Request(URL_POOL, { headers: { 'x-cron-secret': '' } }))
    expect(res.status).toBe(401)
  })

  it('非 Vercel 環境では x-vercel-cron を信頼しない (spoof 拒否、Codex LOW)', async () => {
    delete process.env.VERCEL
    const res = await CronGet(new Request(URL_POOL, { headers: { 'x-vercel-cron': '1' } }))
    expect(res.status).toBe(401)
    expect(mockRecompute).not.toHaveBeenCalled()
    // ただし secret 経路は非 Vercel でも有効
    const viaSecret = await CronGet(
      new Request(URL_POOL, { headers: { 'x-cron-secret': 'cron-secret-xyz' } }),
    )
    expect(viaSecret.status).toBe(200)
  })

  it('abort summary → 503 (corpus 不変)', async () => {
    mockRecompute.mockResolvedValue(summary({ aborted: true }))
    const res = await CronGet(new Request(URL_POOL, { headers: { 'x-vercel-cron': '1' } }))
    expect(res.status).toBe(503)
  })

  it('salt 未設定 → 503・recompute 未実行 (fail-closed)', async () => {
    delete process.env.EXPERIMENT_ASSIGN_SALT
    const res = await CronGet(new Request(URL_POOL, { headers: { 'x-vercel-cron': '1' } }))
    expect(res.status).toBe(503)
    expect(mockRecompute).not.toHaveBeenCalled()
  })
})

describe('POST /api/experiments/pool — operator 認証', () => {
  it('session なし → 401', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await OperatorPost()
    expect(res.status).toBe(401)
  })

  it('owner でも allowlist 外 → 403', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner', 'someone@tenant.com'))
    const res = await OperatorPost()
    expect(res.status).toBe(403)
    expect(mockRecompute).not.toHaveBeenCalled()
  })

  it('allowlist 内 owner → 200', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('owner', 'OPS@ugokimap.com')) // 大文字も許容
    const res = await OperatorPost()
    expect(res.status).toBe(200)
    expect(mockRecompute).toHaveBeenCalledTimes(1)
  })

  it('member は allowlist 内でも 403 (role gate が先)', async () => {
    mockGetServerSession.mockResolvedValue(makeSession('member', 'ops@ugokimap.com'))
    const res = await OperatorPost()
    expect(res.status).toBe(403)
  })

  it('EXPERIMENTS_POOL_OPERATORS 未設定 → 503 (fail-closed)', async () => {
    delete process.env.EXPERIMENTS_POOL_OPERATORS
    mockGetServerSession.mockResolvedValue(makeSession('owner', 'ops@ugokimap.com'))
    const res = await OperatorPost()
    expect(res.status).toBe(503)
  })
})
