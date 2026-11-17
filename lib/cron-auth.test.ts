/**
 * cron-auth のユニットテスト (続134 + 2026-11 fail-closed 化)。
 * 不変条件:
 *   - CRON_SECRET (16 文字以上) が一致した要求だけを通す。
 *   - CRON_SECRET が未設定 / 短すぎる場合は **誰も通さない** (fail-closed)。
 *     誰でも付けられる `x-vercel-cron: 1` を認証の根拠にしない。
 */

import { checkCronAuth, isCronAuthorized } from './cron-auth'

function req(headers: Record<string, string>): Request {
  return new Request('https://x.test/api/cron/x', { method: 'GET', headers })
}

const SECRET = 'a'.repeat(32)

describe('checkCronAuth', () => {
  const orig = process.env.CRON_SECRET
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    if (orig === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = orig
  })

  describe('CRON_SECRET 設定時 — secret 必須', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = SECRET
    })

    it('Authorization: Bearer <secret> を受理 (Vercel Cron の呼び方)', () => {
      expect(checkCronAuth(req({ authorization: `Bearer ${SECRET}` }))).toEqual({
        ok: true,
        reason: 'bearer',
      })
    })

    it('x-cron-secret: <secret> を受理 (手動 invoke)', () => {
      expect(checkCronAuth(req({ 'x-cron-secret': SECRET }))).toEqual({
        ok: true,
        reason: 'header-secret',
      })
    })

    it('前後に空白が入った CRON_SECRET でも trim 後の値で照合する', () => {
      process.env.CRON_SECRET = `  ${SECRET}\n`
      expect(checkCronAuth(req({ authorization: `Bearer ${SECRET}` })).ok).toBe(true)
    })

    it('x-vercel-cron: 1 単体は拒否 (なりすまし遮断)', () => {
      const r = checkCronAuth(req({ 'x-vercel-cron': '1' }))
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('secret-mismatch')
    })

    it('誤った secret は拒否', () => {
      expect(checkCronAuth(req({ authorization: 'Bearer wrong' })).ok).toBe(false)
      expect(checkCronAuth(req({ 'x-cron-secret': 'wrong' })).ok).toBe(false)
    })

    it('ヘッダ無しは拒否', () => {
      expect(checkCronAuth(req({})).ok).toBe(false)
    })
  })

  describe('CRON_SECRET 未設定 / 不正 — 誰も通さない (fail-closed)', () => {
    it.each([
      ['未設定', undefined],
      ['空文字', ''],
      ['空白のみ', '                    '],
      ['16 文字未満', 'short'],
    ])('%s: x-vercel-cron: 1 を付けても拒否', (_label, value) => {
      if (value === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = value

      expect(checkCronAuth(req({ 'x-vercel-cron': '1' }))).toEqual({
        ok: false,
        reason: 'secret-not-configured',
      })
    })

    it('短すぎる secret は、その値そのものを送っても通らない (弱い secret を使わせない)', () => {
      process.env.CRON_SECRET = 'short'
      expect(checkCronAuth(req({ authorization: 'Bearer short' })).ok).toBe(false)
      expect(checkCronAuth(req({ 'x-cron-secret': 'short' })).ok).toBe(false)
    })

    it('未設定のとき、空の Bearer / 空の x-cron-secret でも通らない', () => {
      delete process.env.CRON_SECRET
      expect(checkCronAuth(req({ authorization: 'Bearer ' })).ok).toBe(false)
      expect(checkCronAuth(req({ 'x-cron-secret': '' })).ok).toBe(false)
    })

    it('拒否理由をサーバーログに残す (設定漏れに気づけるように)。secret の値は出さない', () => {
      process.env.CRON_SECRET = 'short'
      checkCronAuth(req({ 'x-vercel-cron': '1' }))

      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logged = String(errorSpy.mock.calls[0]?.[0] ?? '')
      expect(logged).toContain('CRON_SECRET')
      expect(logged).not.toContain('short')
    })
  })

  it('isCronAuthorized は boolean を返す薄いラッパ', () => {
    process.env.CRON_SECRET = SECRET
    expect(isCronAuthorized(req({ authorization: `Bearer ${SECRET}` }))).toBe(true)
    expect(isCronAuthorized(req({ 'x-vercel-cron': '1' }))).toBe(false)
  })
})
