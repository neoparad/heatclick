/**
 * 回帰テスト (続 119): /auth/sign-out のプリフェッチ安全性
 *
 * 背景: Next.js は sidebar の `<Link href="/auth/sign-out">` を自動プリフェッチする。
 *   sign-out が GET でセッション cookie を削除していたため、「ページを開いただけで
 *   プリフェッチが sign-out を実行 → cookie 消滅 → 次の soft navigation が no_token で
 *   弾かれる」サイレントログアウトが発生していた (Owner dogfood で全画面遷移が
 *   sign-in に弾かれる症状の真因)。
 *
 *   このテストは「プリフェッチ要求では cookie を消さない」「実クリック/POST では消す」
 *   を固定し、再発 (誰かが prefetch ガードを外す等) を CI で検知する。
 */

import { GET, POST } from './route'

const TOKEN = 'ugokimap_saas_token'
const URL_BASE = 'https://app.example.com/auth/sign-out'

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request(URL_BASE, { method: 'GET', headers })
}

function setCookie(res: Response): string {
  return res.headers.get('set-cookie') ?? ''
}

describe('GET /auth/sign-out — プリフェッチ安全性', () => {
  it('Next-Router-Prefetch のプリフェッチでは cookie を削除しない (204) + no-store', async () => {
    const res = await GET(makeRequest({ 'next-router-prefetch': '1' }))
    expect(res.status).toBe(204)
    expect(setCookie(res)).toBe('')
    expect(res.headers.get('cache-control') ?? '').toContain('no-store')
  })

  it('Sec-Purpose: prefetch のプリフェッチでも削除しない', async () => {
    const res = await GET(makeRequest({ 'sec-purpose': 'prefetch;anonymous-client-ip' }))
    expect(res.status).toBe(204)
    expect(setCookie(res)).toBe('')
  })

  it('Purpose: prefetch のプリフェッチでも削除しない', async () => {
    const res = await GET(makeRequest({ purpose: 'prefetch' }))
    expect(res.status).toBe(204)
  })

  it('通常の GET (プリフェッチでない) は cookie を削除し sign-in へ 302', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain('/auth/sign-in')
    expect(res.headers.get('cache-control') ?? '').toContain('no-store')
    const cookie = setCookie(res)
    expect(cookie).toContain(`${TOKEN}=`)
    expect(cookie).toMatch(/Max-Age=0/i)
  })
})

describe('POST /auth/sign-out — 常にログアウト実行', () => {
  it('POST は prefetch ヘッダがあっても cookie を削除する (POST はプリフェッチされない)', async () => {
    const req = new Request(URL_BASE, { method: 'POST', headers: { 'next-router-prefetch': '1' } })
    const res = await POST(req)
    expect(res.status).toBe(302)
    expect(setCookie(res)).toContain(`${TOKEN}=`)
  })
})
