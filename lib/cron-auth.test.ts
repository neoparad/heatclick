/**
 * cron-auth のユニットテスト (続134)。
 * 不変条件: CRON_SECRET 設定時は secret 必須 (spoofable な x-vercel-cron 単体を拒否)。
 */

import { checkCronAuth, isCronAuthorized } from './cron-auth'

function req(headers: Record<string, string>): Request {
  return new Request('https://x.test/api/cron/x', { method: 'POST', headers })
}

const SECRET = 'a'.repeat(32)

describe('checkCronAuth', () => {
  const orig = process.env.CRON_SECRET
  afterEach(() => {
    if (orig === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = orig
  })

  describe('CRON_SECRET 設定時 (本番) — secret 必須', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = SECRET
    })

    it('Authorization: Bearer <secret> を受理', () => {
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

    it('x-vercel-cron: 1 単体は **拒否** (spoof 遮断) — これが本 fix の核心', () => {
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

  describe('CRON_SECRET 未設定 — cron を壊さないため header に degrade', () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET
    })

    it('x-vercel-cron: 1 を受理 (fallback)', () => {
      expect(checkCronAuth(req({ 'x-vercel-cron': '1' }))).toEqual({
        ok: true,
        reason: 'vercel-cron-fallback',
      })
    })

    it('ヘッダ無しは拒否', () => {
      expect(checkCronAuth(req({})).ok).toBe(false)
    })
  })

  it('短すぎる CRON_SECRET (<16 文字) は未設定扱い (誤設定で弱い secret を使わせない)', () => {
    process.env.CRON_SECRET = 'short'
    // 未設定扱い → header fallback 経路
    expect(checkCronAuth(req({ 'x-vercel-cron': '1' })).reason).toBe('vercel-cron-fallback')
    // secret では通らない
    expect(checkCronAuth(req({ 'x-cron-secret': 'short' })).ok).toBe(false)
  })

  it('isCronAuthorized は boolean を返す薄いラッパ', () => {
    process.env.CRON_SECRET = SECRET
    expect(isCronAuthorized(req({ authorization: `Bearer ${SECRET}` }))).toBe(true)
    expect(isCronAuthorized(req({ 'x-vercel-cron': '1' }))).toBe(false)
  })
})
