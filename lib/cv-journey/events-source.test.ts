/**
 * events-source のユニットテスト。
 * SQL 文字列ビルダーの不変条件（allowlist の安全性 / first-touch 集計の形 /
 * where 句の透過 / 追加 param を導入しない）を固定する。
 */

import {
  buildFirstTouchSessionsSubquery,
  SEARCH_ENGINE_DOMAINS,
  SOCIAL_DOMAINS,
} from './events-source'

describe('ドメイン allowlist の安全不変条件', () => {
  it('全語が [a-z] のみ (SQL リテラル埋め込みが injection 不可能であること)', () => {
    for (const d of [...SEARCH_ENGINE_DOMAINS, ...SOCIAL_DOMAINS]) {
      expect(d).toMatch(/^[a-z]+$/)
    }
  })

  it('主要な検索/SNS ドメインを含む', () => {
    expect(SEARCH_ENGINE_DOMAINS).toContain('google')
    expect(SEARCH_ENGINE_DOMAINS).toContain('yahoo')
    expect(SOCIAL_DOMAINS).toContain('x')
    expect(SOCIAL_DOMAINS).toContain('instagram')
  })
})

describe('buildFirstTouchSessionsSubquery', () => {
  const where = `tenant_id = {tenant_id:String} AND site_id = {site_id:String}`
  const sql = buildFirstTouchSessionsSubquery(where)

  it('events を session 単位に first-touch 集約する (argMin + NULL-safe)', () => {
    expect(sql).toContain('FROM clickinsight.events')
    expect(sql).toContain('GROUP BY session_id')
    expect(sql).toContain(`argMin(ifNull(utm_source, ''), timestamp)`)
    expect(sql).toContain(`argMin(ifNull(utm_medium, ''), timestamp)`)
    expect(sql).toContain(`argMin(ifNull(referrer, ''), timestamp)`)
    expect(sql).toContain(`argMin(ifNull(url, ''), timestamp)`)
  })

  it('呼び出し側の where 句を透過し、sessions テーブルを参照しない', () => {
    expect(sql).toContain(where)
    expect(sql).not.toContain('clickinsight.sessions')
  })

  it('referrer_type を SQL 内で分類導出する (utm 優先 → direct → search/social/referral)', () => {
    expect(sql).toContain(`concat(utm_src, ' / ', utm_med)`)
    expect(sql).toContain(`'direct / none'`)
    expect(sql).toContain(`'search'`)
    expect(sql).toContain(`'social'`)
    expect(sql).toContain(`'referral'`)
    // 自サイト内 referrer は direct 扱い (first-touch の LP と同一登録ドメイン)
    expect(sql).toContain('firstSignificantSubdomain(ref) = firstSignificantSubdomain(first_url)')
  })

  it('追加の query_params を導入しない ({...:String} 参照は where 由来のみ)', () => {
    const withoutWhere = sql.replace(where, '')
    expect(withoutWhere).not.toMatch(/\{[a-z_]+:String\}/)
  })
})
