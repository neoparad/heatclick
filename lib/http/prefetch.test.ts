/**
 * isPrefetchRequest のシグネチャ網羅テスト (続 119 / Codex T1 review)
 *
 * 副作用を持つ GET ルートのガードに使うため、ブラウザ/Next.js/拡張が送る
 * プリフェッチ系ヘッダを取りこぼさないことを固定する。取りこぼし = サイレント
 * ログアウト等の再発、過検出 = 実操作がブロックされる退行、どちらも防ぐ。
 */

import { isPrefetchRequest } from './prefetch'

function req(headers: Record<string, string>): Request {
  return new Request('https://app.example.com/auth/sign-out', { headers })
}

describe('isPrefetchRequest', () => {
  it.each([
    ['Next-Router-Prefetch: 1', { 'next-router-prefetch': '1' }],
    ['Purpose: prefetch', { purpose: 'prefetch' }],
    ['Purpose: prefetch;...（tokenize）', { purpose: 'prefetch; foo=bar' }],
    ['X-Purpose: prefetch', { 'x-purpose': 'prefetch' }],
    ['Sec-Purpose: prefetch', { 'sec-purpose': 'prefetch' }],
    ['Sec-Purpose: prefetch;prerender', { 'sec-purpose': 'prefetch;prerender' }],
    ['Sec-Purpose: prerender', { 'sec-purpose': 'prerender' }],
    ['X-Moz: prefetch', { 'x-moz': 'prefetch' }],
    ['X-Moz: prefetch-prerender', { 'x-moz': 'prefetch-prerender' }],
    ['大文字/混在', { 'Sec-Purpose': 'PreFetch' }],
  ])('プリフェッチと判定する: %s', (_label, headers) => {
    expect(isPrefetchRequest(req(headers))).toBe(true)
  })

  it.each([
    ['ヘッダ無し', {}],
    ['通常ナビゲーション (Sec-Fetch-Mode: navigate)', { 'sec-fetch-mode': 'navigate' }],
    ['Purpose: navigation', { purpose: 'navigation' }],
    ['next-router-prefetch: 0', { 'next-router-prefetch': '0' }],
  ])('プリフェッチでないと判定する: %s', (_label, headers) => {
    expect(isPrefetchRequest(req(headers))).toBe(false)
  })
})
