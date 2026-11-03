/**
 * Unit tests: app/api/auth/magic-link/route.ts (続137)
 *
 * Owner報告「メールが届かない」の根因: sendMagicLinkEmail の戻り値 (SendResult) を
 * 完全に無視しており、送信失敗 (RESEND_API_KEY不正/ドメイン未認証/ネットワーク障害等)
 * が無言でクライアントに success:true として伝わっていた。
 * 修正: 失敗時に console.error でサーバ側可視化 (client応答は enumeration対策のため不変)。
 */

jest.mock('@/lib/resend')
jest.mock('@/lib/redis')
jest.mock('@/lib/auth/magic-link')
jest.mock('@/lib/app-url')

import { sendMagicLinkEmail } from '@/lib/resend'
import { redis } from '@/lib/redis'
import { signMagicLinkToken, generateNonce } from '@/lib/auth/magic-link'
import { resolveRequestOrigin } from '@/lib/app-url'

import { POST } from './route'

const mockSendMagicLinkEmail = sendMagicLinkEmail as jest.MockedFunction<typeof sendMagicLinkEmail>
const mockRedis = redis as jest.MockedFunction<typeof redis>
const mockSignMagicLinkToken = signMagicLinkToken as jest.MockedFunction<typeof signMagicLinkToken>
const mockGenerateNonce = generateNonce as jest.MockedFunction<typeof generateNonce>
const mockResolveRequestOrigin = resolveRequestOrigin as jest.MockedFunction<
  typeof resolveRequestOrigin
>

function makeRequest(body: unknown): Request {
  return new Request('https://app.example.com/api/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/magic-link', () => {
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.resetAllMocks()
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    // redis() は throw させ、rate-limit / nonce-set の fail-open 経路を通す
    // (既存挙動: Redis 不達時は fail-open するため、本テストではRedis動作自体は対象外)
    mockRedis.mockImplementation(() => {
      throw new Error('REDIS_URL environment variable is required')
    })
    mockSignMagicLinkToken.mockResolvedValue('signed-token')
    mockGenerateNonce.mockReturnValue('nonce-abc')
    mockResolveRequestOrigin.mockReturnValue('https://app.example.com')
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('メール送信が失敗しても console.error で可視化しつつ success:true を返す (enumeration対策維持)', async () => {
    mockSendMagicLinkEmail.mockResolvedValue({
      success: false,
      error: 'RESEND_API_KEY environment variable is required',
    })

    const res = await POST(makeRequest({ email: 'user@example.com' }))
    const body = await res.json()

    expect(body).toEqual({ success: true })
    expect(errorSpy).toHaveBeenCalledWith(
      '[magic-link] email send failed (client still sees success:true):',
      'RESEND_API_KEY environment variable is required',
    )
  })

  it('メール送信が成功したら console.error は呼ばれない', async () => {
    mockSendMagicLinkEmail.mockResolvedValue({ success: true, id: 'email-123' })

    const res = await POST(makeRequest({ email: 'user@example.com' }))
    const body = await res.json()

    expect(body).toEqual({ success: true })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('不正な入力は400を返しメール送信を試みない', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email' }))
    expect(res.status).toBe(400)
    expect(mockSendMagicLinkEmail).not.toHaveBeenCalled()
  })
})
