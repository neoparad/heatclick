/**
 * segment-filter のユニットテスト (続132)。
 * セキュリティ不変条件 (tenant 束縛 / param binding のみ / 入力連結なし) と
 * returning / new の判定方向を固定する。
 */

import { segmentFilterSql } from './segment-filter'

describe('segmentFilterSql', () => {
  it('all は空文字 (絞り込みなし)', () => {
    expect(segmentFilterSql('all')).toBe('')
  })

  it('全セグメントが tenant_id / site_id を束縛する (cross-tenant 遮断)', () => {
    for (const seg of ['deep_read', 'bounce', 'ad', 'returning', 'new'] as const) {
      const sql = segmentFilterSql(seg)
      expect(sql).toContain('tenant_id = {tenant_id:String}')
      expect(sql).toContain('site_id = {site_id:String}')
      // session_id サブクエリで絞る共通形
      expect(sql).toContain('AND session_id IN (')
    }
  })

  it('生のユーザー入力を連結しない (parameter placeholder のみ)', () => {
    // どのセグメントの SQL も {name:Type} 形式の placeholder 以外に裸のリテラル注入が無いこと。
    // ざっくり: 文字列の中にシングルクオートで囲まれた値リテラル ('xxx') は
    // gclid/fbclid の空文字比較 ('') と scroll 閾値の数値のみ許容。
    for (const seg of ['deep_read', 'bounce', 'ad', 'returning', 'new'] as const) {
      const sql = segmentFilterSql(seg)
      const singleQuoted = sql.match(/'[^']*'/g) ?? []
      for (const lit of singleQuoted) {
        expect(lit).toBe("''") // 空文字比較のみ (gclid/fbclid/visitor_id != '')
      }
    }
  })

  it('deep_read / bounce は scroll_percentage の閾値で分岐', () => {
    expect(segmentFilterSql('deep_read')).toContain('max(scroll_percentage) >= 70')
    expect(segmentFilterSql('bounce')).toContain('max(scroll_percentage) <= 20')
  })

  it('ad は gclid / fbclid 条件', () => {
    const sql = segmentFilterSql('ad')
    expect(sql).toContain('gclid')
    expect(sql).toContain('fbclid')
  })

  it('returning は visitor 初回来訪 < session 開始 (再訪)', () => {
    const sql = segmentFilterSql('returning')
    expect(sql).toContain('first_seen < ')
    expect(sql).toContain("visitor_id != ''")
    expect(sql).toContain('min(timestamp) AS first_seen')
  })

  it('new は visitor 初回来訪 >= session 開始 (初訪問)', () => {
    const sql = segmentFilterSql('new')
    expect(sql).toContain('first_seen >= ')
    expect(sql).toContain("visitor_id != ''")
  })

  it('returning と new は comparator だけが異なる (判定方向の対称性)', () => {
    const ret = segmentFilterSql('returning')
    const neu = segmentFilterSql('new')
    // new の '>=' を '<' に戻すと returning と一致する
    expect(neu.replace('first_seen >= ', 'first_seen < ')).toBe(ret)
  })
})
