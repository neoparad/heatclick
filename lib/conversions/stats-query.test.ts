/**
 * Unit tests: lib/conversions/stats-query.ts (C1-b)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §3 / §9
 * fakeClient パターン (paths stats-query / cv-journey query と同型) で検証:
 *   - 1スキャンSQL生成 (定義ごとにクエリを撃たない)
 *   - query_params 束縛の集約 (tenant/site/period + 各定義のparam)
 *   - 未対応定義は SQL に含めず supported:false
 *   - CH失敗 → throw せず statsComputed:false (CH生エラーを漏らさない)
 *   - session/event の対応付け・定義順維持
 */

import { computeCvStats } from './stats-query'
import type { CvStatsTarget } from './stats-query'

interface CapturedQuery {
  query: string
  query_params: Record<string, unknown>
}

function makeFakeClient(row: Record<string, unknown> | 'throw') {
  const captured: CapturedQuery[] = []
  const client = {
    query: async (args: CapturedQuery) => {
      captured.push(args)
      if (row === 'throw') throw new Error('CH connection refused: 159.69.95.59:8123')
      return { json: async () => [row] }
    },
  }
  return { client: client as never, captured }
}

const rakutenDef: CvStatsTarget = {
  id: 'def-rakuten',
  cvKey: 'affiliate_rakuten',
  trigger: { kind: 'click', conditions: { hrefHosts: ['rakuten.co.jp'] } },
}
const purchaseDef: CvStatsTarget = {
  id: 'def-purchase',
  cvKey: 'purchase',
  trigger: { kind: 'custom_event', conversionType: 'purchase' },
}

const ARGS = { tenantId: 'linkth_internal', siteId: 'CIP_EcwUTHEZdIOAUqum', periodDays: 30 }

describe('computeCvStats', () => {
  it('複数定義を1スキャンで集計 (1クエリのみ)', async () => {
    const { client, captured } = makeFakeClient({ s0: 1566, e0: 1800, s1: 42, e1: 42 })
    const result = await computeCvStats(client, [rakutenDef, purchaseDef], ARGS)

    expect(captured).toHaveLength(1)
    expect(result.statsComputed).toBe(true)
    expect(result.periodDays).toBe(30)
    expect(result.rows).toEqual([
      { defId: 'def-rakuten', cvKey: 'affiliate_rakuten', cvSessions: 1566, cvEvents: 1800, supported: true },
      { defId: 'def-purchase', cvKey: 'purchase', cvSessions: 42, cvEvents: 42, supported: true },
    ])
  })

  it('SQLは uniqExactIf + countIf を定義ごとに生成し base WHERE を含む', async () => {
    const { client, captured } = makeFakeClient({ s0: 1, e0: 1, s1: 2, e1: 2 })
    await computeCvStats(client, [rakutenDef, purchaseDef], ARGS)

    const { query, query_params } = captured[0]
    expect(query).toContain('uniqExactIf(session_id, (')
    expect(query).toContain(') AS s0')
    expect(query).toContain('countIf((')
    expect(query).toContain(') AS e0')
    expect(query).toContain(') AS s1')
    // base WHERE (paths と同一契約)
    expect(query).toContain('tenant_id = {tenant_id:String}')
    expect(query).toContain('site_id = {site_id:String}')
    expect(query).toContain('is_agent = 0')
    expect(query).toContain('timestamp >= now() - toIntervalDay({period_days:UInt16})')
    // params: base + 各定義の束縛値
    expect(query_params).toMatchObject({
      tenant_id: 'linkth_internal',
      site_id: 'CIP_EcwUTHEZdIOAUqum',
      period_days: 30,
      cv0_h0: 'rakuten.co.jp',
      cv1_cv: 'purchase',
    })
  })

  it('未対応の定義はSQLに含めず supported:false で報告 (定義順は維持)', async () => {
    const badDef: CvStatsTarget = {
      id: 'def-bad',
      cvKey: 'broken',
      // 正規化不能パス → buildCvPredicate が supported:false
      trigger: { kind: 'page_reach', url: { mode: 'exact', path: 'javascript:void(0)' } },
    }
    const { client, captured } = makeFakeClient({ s0: 100, e0: 120 })
    const result = await computeCvStats(client, [badDef, rakutenDef], ARGS)

    // SQL には supported な rakutenDef の1定義分だけ (s0/e0)
    expect(captured[0].query).toContain(') AS s0')
    expect(captured[0].query).not.toContain(') AS s1')

    // 結果は定義順 (bad が先)
    expect(result.rows.map((r) => r.defId)).toEqual(['def-bad', 'def-rakuten'])
    const bad = result.rows.find((r) => r.defId === 'def-bad')!
    expect(bad.supported).toBe(false)
    expect(bad.cvSessions).toBe(0)
    expect(bad.reason).toBeTruthy()
    const rakuten = result.rows.find((r) => r.defId === 'def-rakuten')!
    expect(rakuten.supported).toBe(true)
    expect(rakuten.cvSessions).toBe(100)
  })

  it('全定義が未対応ならCHを叩かない', async () => {
    const badDef: CvStatsTarget = {
      id: 'def-bad',
      cvKey: 'broken',
      trigger: { kind: 'page_reach', url: { mode: 'exact', path: 'not-a-path' } },
    }
    const { client, captured } = makeFakeClient({ s0: 1, e0: 1 })
    const result = await computeCvStats(client, [badDef], ARGS)

    expect(captured).toHaveLength(0)
    expect(result.statsComputed).toBe(true)
    expect(result.rows[0].supported).toBe(false)
  })

  it('定義ゼロは空結果 (CHを叩かない)', async () => {
    const { client, captured } = makeFakeClient({})
    const result = await computeCvStats(client, [], ARGS)
    expect(captured).toHaveLength(0)
    expect(result).toEqual({ statsComputed: true, periodDays: 30, rows: [] })
  })

  it('CH失敗はthrowせず statsComputed:false (CH生エラーを漏らさない)', async () => {
    const { client } = makeFakeClient('throw')
    const result = await computeCvStats(client, [rakutenDef, purchaseDef], ARGS)

    expect(result.statsComputed).toBe(false)
    expect(result.reason).toBe('clickhouse_error')
    // reason にCH接続情報(IP等)が混入しない
    expect(JSON.stringify(result)).not.toContain('159.69.95.59')
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((r) => r.cvSessions === 0)).toBe(true)
  })

  it('欠損/不正なカウント列は0に落とす', async () => {
    const { client } = makeFakeClient({ s0: 'not-a-number', e0: -5 })
    const result = await computeCvStats(client, [rakutenDef], ARGS)
    expect(result.rows[0].cvSessions).toBe(0)
    expect(result.rows[0].cvEvents).toBe(0)
  })

  it('periodDays 範囲外は throw (バリデーション)', async () => {
    const { client } = makeFakeClient({})
    await expect(computeCvStats(client, [rakutenDef], { ...ARGS, periodDays: 0 })).rejects.toThrow()
    await expect(computeCvStats(client, [rakutenDef], { ...ARGS, periodDays: 366 })).rejects.toThrow()
    await expect(computeCvStats(client, [rakutenDef], { ...ARGS, periodDays: 1.5 })).rejects.toThrow()
  })

  it('tenant/site 欠落は throw', async () => {
    const { client } = makeFakeClient({})
    await expect(computeCvStats(client, [rakutenDef], { ...ARGS, tenantId: '' })).rejects.toThrow()
    await expect(computeCvStats(client, [rakutenDef], { ...ARGS, siteId: '' })).rejects.toThrow()
  })
})
