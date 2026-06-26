/**
 * canonical-url.test.ts — JS 正規化と SQL 式の等価性 + エッジケース (続135)
 */

import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'

/** テスト用: ClickHouse replaceRegexpOne(col, '[?#].*$', '') と同じ意味の JS 実装 */
function sqlEquivalent(url: string): string {
  return url.replace(/[?#].*$/, '')
}

describe('canonicalizeHeatmapUrl', () => {
  const cases: Array<[string, string]> = [
    ['https://x.com/a', 'https://x.com/a'],
    ['https://x.com/a/', 'https://x.com/a/'],
    ['https://x.com/a?utm_source=sn&x=1', 'https://x.com/a'],
    ['https://x.com/a#formarea', 'https://x.com/a'],
    ['https://x.com/a?b=1#top', 'https://x.com/a'],
    ['https://x.com/a#top?b=1', 'https://x.com/a'], // # が先: 前半のみ
    ['https://x.com/a?', 'https://x.com/a'],
    ['https://x.com/a#', 'https://x.com/a'],
    ['https://x.com:443/a?b=1', 'https://x.com:443/a'], // port は保持
    ['', ''],
  ]

  it.each(cases)('canonicalize(%s) === %s', (input, expected) => {
    expect(canonicalizeHeatmapUrl(input)).toBe(expected)
  })

  it('JS split と SQL 正規表現 ([?#].*$) が全ケースで一致する', () => {
    for (const [input] of cases) {
      expect(canonicalizeHeatmapUrl(input)).toBe(sqlEquivalent(input))
    }
  })
})

describe('canonicalUrlSql', () => {
  it('既定は url カラム', () => {
    expect(canonicalUrlSql()).toBe("replaceRegexpOne(url, '[?#].*$', '')")
  })
  it('image_visibility は page_url カラム', () => {
    expect(canonicalUrlSql('page_url')).toBe("replaceRegexpOne(page_url, '[?#].*$', '')")
  })
})
