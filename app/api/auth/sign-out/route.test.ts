/**
 * 回帰テスト (続 119): /api/auth/sign-out のプリフェッチ安全性
 *
 * /auth/sign-out と同じく、副作用 (cookie 削除) を持つ GET がプリフェッチで実行
 * されないことを固定する。複数 auth cookie (ugokimap_saas_token / _vercel_jwt /
 * __session) をまとめて消すため、削除分岐が走ったか/走らなかったかを検証する。
 */

import { GET, POST } from './route'

const TOKEN = 'ugokimap_saas_token'
const URL_BASE = 'https://app.example.com/api/auth/sign-out'

function setCookie(res: Response): string {
  // 複数 set-cookie が来る場合に備えて getSetCookie() も連結する
  const joined = res.headers.get('set-cookie') ?? ''
  const arr = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  return [joined, ...arr].join('\n')
}

describe('GET /api/auth/sign-out — プリフェッチ安全性', () => {
  it('プリフェッチ (Next-Router-Prefetch) では cookie を削除しない (204)', async () => {
    const res = await GET(new Request(URL_BASE, { headers: { 'next-router-prefetch': '1' } }))
    expect(res.status).toBe(204)
    expect(setCookie(res)).not.toContain(`${TOKEN}=`)
  })

  it('通常 GET は cookie を削除し 302', async () => {
    const res = await GET(new Request(URL_BASE))
    expect(res.status).toBe(302)
    expect(setCookie(res)).toContain(`${TOKEN}=`)
  })
})

describe('POST /api/auth/sign-out', () => {
  it('POST は常に cookie を削除する', async () => {
    const res = await POST(new Request(URL_BASE, { method: 'POST' }))
    expect(res.status).toBe(302)
    expect(setCookie(res)).toContain(`${TOKEN}=`)
  })
})
