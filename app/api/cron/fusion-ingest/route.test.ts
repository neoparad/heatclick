/**
 * Unit tests: app/api/cron/fusion-ingest/route.ts
 *
 * 固定する契約:
 *   - Vercel Cron の呼び方 (GET + Authorization: Bearer <CRON_SECRET>) で処理が走る
 *   - 手動実行 (POST + x-cron-secret) も従来どおり動く
 *   - 認証なしは 401、処理は走らない
 *   - 対象が全件失敗なら 200 で隠さず 500 にする
 */

jest.mock('@/lib/fusion/ingest')

import { runFusionIngest, type FusionIngestResult } from '@/lib/fusion/ingest'

import { GET, POST } from './route'

const mockRun = runFusionIngest as jest.MockedFunction<typeof runFusionIngest>

const SECRET = 's'.repeat(32)
const URL_ = 'https://x.test/api/cron/fusion-ingest'
const TARGET = { tenantId: 't1', siteId: 's1', jobId: 'j1' }

function req(method: 'GET' | 'POST', headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method, headers })
}

const okResult: FusionIngestResult = {
  target: TARGET,
  ok: true,
  counts: { sections: 1, performance: 1, issues: 1, section_behavior: 0 },
}
const ngResult: FusionIngestResult = { target: TARGET, ok: false, error: 'export fetch failed: HTTP 404' }

describe('/api/cron/fusion-ingest', () => {
  const origSecret = process.env.CRON_SECRET

  beforeEach(() => {
    jest.resetAllMocks()
    process.env.CRON_SECRET = SECRET
    mockRun.mockResolvedValue([okResult])
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (origSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = origSecret
  })

  it('GET + Bearer (Vercel Cron の呼び方) で処理が走り 200 を返す', async () => {
    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ targets: 1, ok: 1, failed: 0 })
  })

  it('POST + x-cron-secret (手動実行) も従来どおり動く', async () => {
    const res = await POST(req('POST', { 'x-cron-secret': SECRET }))

    expect(res.status).toBe(200)
    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  it('認証なしの GET は 401、処理は走らない', async () => {
    const res = await GET(req('GET'))

    expect(res.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('CRON_SECRET 設定時、x-vercel-cron 単体の GET は 401 (なりすまし遮断)', async () => {
    const res = await GET(req('GET', { 'x-vercel-cron': '1' }))

    expect(res.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('認証なしの POST も 401、処理は走らない', async () => {
    const res = await POST(req('POST'))

    expect(res.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it.each([
    ['未設定', undefined],
    ['16 文字未満', 'short'],
  ])('CRON_SECRET が%sなら、x-vercel-cron を付けても GET/POST とも 401 (fail-closed)', async (_l, v) => {
    if (v === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = v
    const headers = { 'x-vercel-cron': '1', authorization: `Bearer ${v ?? ''}`, 'x-cron-secret': v ?? '' }

    expect((await GET(req('GET', headers))).status).toBe(401)
    expect((await POST(req('POST', headers))).status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('応答は件数のみ。対象の tenant/site/job とエラー本文は載せない (成功時・全件失敗時とも)', async () => {
    mockRun.mockResolvedValue([okResult, ngResult])
    const okRaw = await (await GET(req('GET', { authorization: `Bearer ${SECRET}` }))).text()

    mockRun.mockResolvedValue([ngResult])
    const ngRaw = await (await GET(req('GET', { authorization: `Bearer ${SECRET}` }))).text()

    for (const raw of [okRaw, ngRaw]) {
      expect(raw).not.toContain('results')
      expect(raw).not.toContain(TARGET.tenantId)
      expect(raw).not.toContain(TARGET.jobId)
      expect(raw).not.toContain('HTTP 404')
    }
  })

  it('処理が例外を投げたら 500 INGEST_FAILED (詳細は外に出さない)', async () => {
    mockRun.mockRejectedValue(new Error('clickhouse down: secret-host'))

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const raw = await res.text()

    expect(res.status).toBe(500)
    expect(raw).toContain('INGEST_FAILED')
    expect(raw).not.toContain('secret-host')
  })

  it('対象が全件失敗なら 500 (成功として隠さない)。内訳は返す', async () => {
    mockRun.mockResolvedValue([ngResult, ngResult])

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('ALL_FAILED')
    expect(body.data).toMatchObject({ targets: 2, ok: 0, failed: 2 })
  })

  it('一部失敗は 200 のまま件数で伝える', async () => {
    mockRun.mockResolvedValue([okResult, ngResult])

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({ targets: 2, ok: 1, failed: 1 })
  })

  it('取り込み対象が未設定 (0 件) は 200', async () => {
    mockRun.mockResolvedValue([])

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({ targets: 0, ok: 0, failed: 0 })
  })
})
