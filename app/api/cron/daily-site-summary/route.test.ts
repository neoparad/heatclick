/**
 * Unit tests: app/api/cron/daily-site-summary/route.ts
 *
 * 固定する契約:
 *   - Vercel Cron の呼び方 (GET + Authorization: Bearer <CRON_SECRET>) で処理が走る
 *   - 手動実行 (POST + x-cron-secret) も従来どおり動く
 *   - 認証が先。認証なしは設定状態 (503) を漏らさず 401、処理は走らない
 *   - 全件失敗は 200 で隠さず 500 にする (Vercel の実行ログで気づけるようにする)
 */

jest.mock('@/lib/llm/daily-summary')
jest.mock('@/lib/llm/gateway', () => {
  class LLMRuntimeConfigError extends Error {}
  return { assertLLMRuntimeConfig: jest.fn(), LLMRuntimeConfigError }
})

import { regenerateAllDailySummaries } from '@/lib/llm/daily-summary'
import { assertLLMRuntimeConfig, LLMRuntimeConfigError } from '@/lib/llm/gateway'

import { GET, POST } from './route'

const mockRegenerate = regenerateAllDailySummaries as jest.MockedFunction<
  typeof regenerateAllDailySummaries
>
const mockAssertConfig = assertLLMRuntimeConfig as jest.MockedFunction<typeof assertLLMRuntimeConfig>

const SECRET = 's'.repeat(32)
const URL_ = 'https://x.test/api/cron/daily-site-summary'

function req(method: 'GET' | 'POST', headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method, headers })
}

describe('/api/cron/daily-site-summary', () => {
  const origSecret = process.env.CRON_SECRET

  beforeEach(() => {
    jest.resetAllMocks()
    process.env.CRON_SECRET = SECRET
    mockRegenerate.mockResolvedValue({ generated: 3, failed: 0 })
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
    expect(mockRegenerate).toHaveBeenCalledTimes(1)
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ generated: 3, failed: 0 })
  })

  it('POST + x-cron-secret (手動実行) も従来どおり動く', async () => {
    const res = await POST(req('POST', { 'x-cron-secret': SECRET }))

    expect(res.status).toBe(200)
    expect(mockRegenerate).toHaveBeenCalledTimes(1)
  })

  it('認証なしの GET は 401、処理は走らない', async () => {
    const res = await GET(req('GET'))

    expect(res.status).toBe(401)
    expect(mockRegenerate).not.toHaveBeenCalled()
  })

  it('CRON_SECRET 設定時、x-vercel-cron 単体の GET は 401 (なりすまし遮断)', async () => {
    const res = await GET(req('GET', { 'x-vercel-cron': '1' }))

    expect(res.status).toBe(401)
    expect(mockRegenerate).not.toHaveBeenCalled()
  })

  it('認証なしの POST も 401、処理は走らない', async () => {
    const res = await POST(req('POST'))

    expect(res.status).toBe(401)
    expect(mockRegenerate).not.toHaveBeenCalled()
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
    expect(mockRegenerate).not.toHaveBeenCalled()
  })

  it('処理が例外を投げたら 500 WORKER_FAILED (詳細は外に出さない)', async () => {
    mockRegenerate.mockRejectedValue(new Error('clickhouse down: secret-host'))

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const raw = await res.text()

    expect(res.status).toBe(500)
    expect(raw).toContain('WORKER_FAILED')
    expect(raw).not.toContain('secret-host')
  })

  it('認証なしなら LLM 設定エラーがあっても 401 (設定状態を外に漏らさない)', async () => {
    mockAssertConfig.mockImplementation(() => {
      throw new LLMRuntimeConfigError('bad config')
    })

    const res = await GET(req('GET'))

    expect(res.status).toBe(401)
    expect(mockRegenerate).not.toHaveBeenCalled()
  })

  it('認証ありで LLM 設定エラーなら 503、処理は走らない', async () => {
    mockAssertConfig.mockImplementation(() => {
      throw new LLMRuntimeConfigError('bad config')
    })

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error.code).toBe('LLM_RUNTIME_CONFIG')
    expect(mockRegenerate).not.toHaveBeenCalled()
  })

  it('全サイト失敗は 500 (成功として隠さない)。件数は返す', async () => {
    mockRegenerate.mockResolvedValue({ generated: 0, failed: 4 })

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('ALL_FAILED')
    expect(body.data).toMatchObject({ generated: 0, failed: 4 })
  })

  it('一部失敗は 200 のまま件数で伝える', async () => {
    mockRegenerate.mockResolvedValue({ generated: 2, failed: 1 })

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))

    expect(res.status).toBe(200)
  })

  it('対象サイト 0 件 (失敗もなし) は 200', async () => {
    mockRegenerate.mockResolvedValue({ generated: 0, failed: 0 })

    const res = await GET(req('GET', { authorization: `Bearer ${SECRET}` }))

    expect(res.status).toBe(200)
  })
})
