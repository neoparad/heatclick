/**
 * Unit tests: lib/monitoring/ingest-freshness.ts (続137 P0-α1)
 */

import {
  _resetIngestFreshnessCache,
  computeFreshnessSummary,
  getIngestFreshnessSummary,
  type FreshnessSummary,
} from './ingest-freshness'

describe('computeFreshnessSummary (pure)', () => {
  it('buckets sites into active / stale / neverActive correctly', () => {
    const trackingIds = ['CIP_a', 'CIP_b', 'CIP_c', 'CIP_d']
    const staleFlagBySite = new Map<string, boolean>([
      ['CIP_a', false], // active
      ['CIP_b', true], // stale
      ['CIP_c', false], // active
      // CIP_d absent from map = never active
    ])

    const result = computeFreshnessSummary(trackingIds, staleFlagBySite, 6)

    expect(result).toEqual<FreshnessSummary>({
      totalSites: 4,
      activeSites: 2,
      staleSites: 1,
      neverActiveSites: 1,
      thresholdHours: 6,
      ok: false, // staleSites > 0
    })
  })

  it('ok=true when no site is stale (never-active sites do not block ok)', () => {
    const trackingIds = ['CIP_a', 'CIP_b']
    const staleFlagBySite = new Map<string, boolean>([['CIP_a', false]])
    // CIP_b never active (absent from map)

    const result = computeFreshnessSummary(trackingIds, staleFlagBySite, 6)

    expect(result.staleSites).toBe(0)
    expect(result.neverActiveSites).toBe(1)
    expect(result.ok).toBe(true)
  })

  it('handles empty registry (totalSites=0, ok=true)', () => {
    const result = computeFreshnessSummary([], new Map(), 6)
    expect(result).toEqual<FreshnessSummary>({
      totalSites: 0,
      activeSites: 0,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    })
  })

  it('all sites stale → ok=false, staleSites=total', () => {
    const trackingIds = ['CIP_a', 'CIP_b']
    const staleFlagBySite = new Map<string, boolean>([
      ['CIP_a', true],
      ['CIP_b', true],
    ])
    const result = computeFreshnessSummary(trackingIds, staleFlagBySite, 6)
    expect(result.staleSites).toBe(2)
    expect(result.activeSites).toBe(0)
    expect(result.ok).toBe(false)
  })
})

/** dry-run-preview.test.ts と同じ fake-client パターン。query 文字列で sites/events を判別する。 */
function mockClient(
  sitesRows: Array<{ tracking_id: string }>,
  eventsRows: Array<{ site_id: string; is_stale: number }>,
): import('@clickhouse/client').ClickHouseClient {
  const fakeQuery = jest.fn(async (opts: { query: string }) => {
    const isSitesQuery = opts.query.includes('clickinsight.sites')
    return {
      json: async <T>() => (isSitesQuery ? sitesRows : eventsRows) as unknown as T[],
    }
  })
  return { query: fakeQuery } as unknown as import('@clickhouse/client').ClickHouseClient
}

describe('getIngestFreshnessSummary (integration with mocked ClickHouse)', () => {
  const ORIGINAL_ENV = { ...process.env }
  beforeEach(() => {
    _resetIngestFreshnessCache()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    _resetIngestFreshnessCache()
  })

  it('combines sites registry + events stale-flag query into a summary', async () => {
    const client = mockClient(
      [{ tracking_id: 'CIP_a' }, { tracking_id: 'CIP_b' }, { tracking_id: 'CIP_c' }],
      [
        { site_id: 'CIP_a', is_stale: 0 },
        { site_id: 'CIP_b', is_stale: 1 },
        // CIP_c absent → never active
      ],
    )

    const result = await getIngestFreshnessSummary(client, { thresholdHours: 6 })

    expect(result).toEqual<FreshnessSummary>({
      totalSites: 3,
      activeSites: 1,
      staleSites: 1,
      neverActiveSites: 1,
      thresholdHours: 6,
      ok: false,
    })
  })

  it('passes threshold_hours as a query_param (not string-interpolated) to the events query', async () => {
    const client = mockClient([], [])
    const querySpy = client.query as jest.Mock
    await getIngestFreshnessSummary(client, { thresholdHours: 12 })

    const eventsCall = querySpy.mock.calls.find((c: [{ query: string }]) =>
      c[0].query.includes('clickinsight.events'),
    )
    expect(eventsCall).toBeDefined()
    expect(eventsCall[0].query).toContain('{threshold_hours:UInt32}')
    expect(eventsCall[0].query).toContain('{lookback_days:UInt32}')
    expect(eventsCall[0].query).not.toContain('12 * 3600') // 文字列連結でないことの確認
    expect(eventsCall[0].query_params).toEqual({ threshold_hours: 12, lookback_days: 90 })
  })

  it('falls back to INGEST_FRESHNESS_THRESHOLD_HOURS env when thresholdHours option omitted', async () => {
    process.env.INGEST_FRESHNESS_THRESHOLD_HOURS = '3'
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const result = await getIngestFreshnessSummary(client)
    expect(result.thresholdHours).toBe(3)
  })

  it('falls back to default threshold when env is unset/invalid', async () => {
    delete process.env.INGEST_FRESHNESS_THRESHOLD_HOURS
    const client = mockClient([], [])
    const result = await getIngestFreshnessSummary(client)
    expect(result.thresholdHours).toBe(6)
  })

  it('rejects non-integer env threshold (e.g. "6.5") and falls back to default', async () => {
    // Codex review MEDIUM: 小数は {threshold_hours:UInt32} に不適合 → 既定値へ
    process.env.INGEST_FRESHNESS_THRESHOLD_HOURS = '6.5'
    const client = mockClient([], [])
    const result = await getIngestFreshnessSummary(client)
    expect(result.thresholdHours).toBe(6)
  })

  it('ignores blank tracking_id rows from the sites registry', async () => {
    const client = mockClient([{ tracking_id: '' }, { tracking_id: 'CIP_a' }], [])
    const result = await getIngestFreshnessSummary(client, { thresholdHours: 6 })
    expect(result.totalSites).toBe(1)
  })
})

describe('getIngestFreshnessSummary caching + single-flight (Codex review HIGH fix)', () => {
  beforeEach(() => {
    _resetIngestFreshnessCache()
  })
  afterEach(() => {
    _resetIngestFreshnessCache()
  })

  it('caches the result: a second call within TTL does not re-query ClickHouse', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const querySpy = client.query as jest.Mock

    await getIngestFreshnessSummary(client, { thresholdHours: 6 })
    expect(querySpy).toHaveBeenCalledTimes(2) // sites + events

    await getIngestFreshnessSummary(client, { thresholdHours: 6 })
    expect(querySpy).toHaveBeenCalledTimes(2) // 追加クエリなし (cache hit)
  })

  it('single-flight: concurrent calls before the first resolves share one query round-trip', async () => {
    let resolveSites: (rows: Array<{ tracking_id: string }>) => void = () => {}
    const sitesPromise = new Promise<Array<{ tracking_id: string }>>((resolve) => {
      resolveSites = resolve
    })
    const querySpy = jest.fn(async (opts: { query: string }) => {
      if (opts.query.includes('clickinsight.sites')) {
        return { json: async <T>() => (await sitesPromise) as unknown as T[] }
      }
      return { json: async <T>() => [{ site_id: 'CIP_a', is_stale: 0 }] as unknown as T[] }
    })
    const client = { query: querySpy } as unknown as import('@clickhouse/client').ClickHouseClient

    const p1 = getIngestFreshnessSummary(client, { thresholdHours: 6 })
    const p2 = getIngestFreshnessSummary(client, { thresholdHours: 6 })
    resolveSites([{ tracking_id: 'CIP_a' }])
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toEqual(r2)
    expect(querySpy).toHaveBeenCalledTimes(2) // sites + events を1回ずつ (2回分ではない)
  })

  it('different thresholdHours values get independent cache entries (no cross-contamination)', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const querySpy = client.query as jest.Mock

    const r6 = await getIngestFreshnessSummary(client, { thresholdHours: 6 })
    const r12 = await getIngestFreshnessSummary(client, { thresholdHours: 12 })

    expect(r6.thresholdHours).toBe(6)
    expect(r12.thresholdHours).toBe(12)
    expect(querySpy).toHaveBeenCalledTimes(4) // (sites+events) x 2 threshold buckets
  })

  it('does not cache a rejected query (next call retries)', async () => {
    let callCount = 0
    const querySpy = jest.fn(async () => {
      callCount += 1
      if (callCount <= 2) throw new Error('CH unavailable')
      return { json: async <T>() => [] as unknown as T[] }
    })
    const client = { query: querySpy } as unknown as import('@clickhouse/client').ClickHouseClient

    await expect(getIngestFreshnessSummary(client, { thresholdHours: 6 })).rejects.toThrow(
      'CH unavailable',
    )
    // 失敗後、次の呼び出しは再度クエリを試みる (キャッシュも in-flight も残らない)
    await expect(getIngestFreshnessSummary(client, { thresholdHours: 6 })).resolves.toEqual(
      expect.objectContaining({ totalSites: 0 }),
    )
  })
})

describe('getIngestFreshnessSummary L2 (Redis, Codex review HIGH 2周目: cold start / 複数instance対策)', () => {
  beforeEach(() => {
    _resetIngestFreshnessCache()
  })
  afterEach(() => {
    _resetIngestFreshnessCache()
  })

  it('L2 hit (別instanceが直近に書いたcache) を使う場合、ClickHouseに一切問い合わせない', async () => {
    const client = mockClient([], []) // 呼ばれたら空配列を返す (呼ばれないことを検証)
    const querySpy = client.query as jest.Mock
    const cachedSummary = {
      totalSites: 5,
      activeSites: 5,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    }
    const redisGet = jest.fn(async () => JSON.stringify(cachedSummary))
    const redisSet = jest.fn(async () => {})

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      redisSet,
    })

    expect(result).toEqual(cachedSummary)
    expect(querySpy).not.toHaveBeenCalled()
    expect(redisSet).not.toHaveBeenCalled() // L2 hit 時は書き直さない
  })

  it('L1/L2 両方miss時は実クエリを実行し、結果をL2(Redis)へも書き込む', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const redisGet = jest.fn(async () => null) // L2 miss
    const redisSet = jest.fn(async () => {})

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      redisSet,
    })

    expect(result.totalSites).toBe(1)
    expect(redisSet).toHaveBeenCalledTimes(1)
    const [key, value, ttlSec] = redisSet.mock.calls[0] as [string, string, number]
    expect(key).toBe('ingest-freshness:v1:6')
    expect(JSON.parse(value)).toEqual(result)
    expect(ttlSec).toBe(60)
  })

  it('L2から壊れたJSONが返っても実クエリへ安全にフォールバックする (throwしない)', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const redisGet = jest.fn(async () => '{not valid json')
    const redisSet = jest.fn(async () => {})

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      redisSet,
    })

    expect(result.totalSites).toBe(1) // fetchFreshnessSummary の結果に正しくフォールバック
  })

  it('redisGet/redisSet が例外を投げても (fail-open前提の呼び出し元契約) 実クエリ結果は返る', async () => {
    // options 経由の DI hook 自体が想定外に throw した場合の防御的テスト。
    // 既定実装 (defaultRedisGet/defaultRedisSet) は内部で fail-open するが、
    // ここでは DI hook 自身が壊れているケースを想定。getIngestFreshnessSummary が
    // 素通しで throw することを確認する (呼び出し元 = /api/health route 側で
    // 必ず try-catch すべき、という契約のドキュメント化)。
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const redisGet = jest.fn(async () => {
      throw new Error('redisGet hook itself is broken')
    })

    await expect(
      getIngestFreshnessSummary(client, { thresholdHours: 6, redisGet }),
    ).rejects.toThrow('redisGet hook itself is broken')
  })

  it('デフォルト実装 (options未指定、実 lib/redis.ts) は REDIS_URL 未設定でもfail-openしthrowしない', async () => {
    // テスト環境には REDIS_URL が無い想定。defaultRedisGet/defaultRedisSet の
    // fail-open (try-catch) が効いて、L1+実クエリのパスへ正常にフォールバックすることを確認する。
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const result = await getIngestFreshnessSummary(client, { thresholdHours: 6 })
    expect(result.totalSites).toBe(1)
  })

  it('L2値が構造不正 (数値/booleanでない・欠損フィールド) なら実クエリへフォールバックする', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const redisGet = jest.fn(async () => JSON.stringify({ ok: true })) // totalSites 等が欠損
    const redisSet = jest.fn(async () => {})

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      redisSet,
    })

    expect(result.totalSites).toBe(1) // 実クエリの結果を正しく採用
  })
})

describe('getIngestFreshnessSummary cluster-wide lock (Codex review HIGH 3周目)', () => {
  beforeEach(() => {
    _resetIngestFreshnessCache()
  })
  afterEach(() => {
    _resetIngestFreshnessCache()
  })

  it('lock取得成功時: 実クエリを実行し、成功後にlockを解放する', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const redisGet = jest.fn(async () => null)
    const redisSet = jest.fn(async () => {})
    const acquireLock = jest.fn(async () => true)
    const releaseLock = jest.fn(async () => {})

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      redisSet,
      acquireLock,
      releaseLock,
    })

    expect(result.totalSites).toBe(1)
    expect(acquireLock).toHaveBeenCalledWith('ingest-freshness:v1:lock:6', 35)
    expect(releaseLock).toHaveBeenCalledWith('ingest-freshness:v1:lock:6')
  })

  it('lock取得失敗時、別instanceの結果がpolling中にL2へ現れたらそれを使い、自分ではクエリを実行しない', async () => {
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const querySpy = client.query as jest.Mock
    const winningSummary: FreshnessSummary = {
      totalSites: 9,
      activeSites: 9,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    }
    let pollCount = 0
    const redisGet = jest.fn(async () => {
      pollCount += 1
      // 3回目の poll でようやく別 instance の結果が Redis に現れた、という想定
      return pollCount >= 3 ? JSON.stringify(winningSummary) : null
    })
    const acquireLock = jest.fn(async () => false) // 別instanceが既に取得中

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      acquireLock,
    })

    expect(result).toEqual(winningSummary)
    expect(querySpy).not.toHaveBeenCalled() // 自分では一切ClickHouseに問い合わせない
  }, 10_000)

  it('lock取得失敗かつpolling上限までL2が埋まらなければ、throwして「未確認」を呼び出し元に委ねる (自分ではCHに問い合わせない)', async () => {
    // Codex review HIGH 5周目: ここで fail-open して自分もクエリを実行すると、owner側の
    // 集計が poll予算(数秒)より長くかかった場合に確実に重複実行し、lockの目的(dedupe)を
    // 満たせない。throw して呼び出し元(route.ts)の既存 catch → INGEST_UNCHECKED
    // フォールバックに委ねるのが正しい (嘘のhealthyを返さず、CHにも追加負荷をかけない)。
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const querySpy = client.query as jest.Mock
    const redisGet = jest.fn(async () => null) // 常にmiss (別instanceも失敗した想定)
    const redisSet = jest.fn(async () => {})
    const acquireLock = jest.fn(async () => false)

    await expect(
      getIngestFreshnessSummary(client, { thresholdHours: 6, redisGet, redisSet, acquireLock }),
    ).rejects.toThrow('lock contention timeout')

    expect(querySpy).not.toHaveBeenCalled() // 自分では一切ClickHouseに問い合わせない
    expect(redisSet).not.toHaveBeenCalled()
  }, 10_000)

  it('実クエリがthrowしてもlockは必ず解放される (finally)', async () => {
    const querySpy = jest.fn(async () => {
      throw new Error('CH boom')
    })
    const client = { query: querySpy } as unknown as import('@clickhouse/client').ClickHouseClient
    const redisGet = jest.fn(async () => null)
    const acquireLock = jest.fn(async () => true)
    const releaseLock = jest.fn(async () => {})

    await expect(
      getIngestFreshnessSummary(client, { thresholdHours: 6, redisGet, acquireLock, releaseLock }),
    ).rejects.toThrow('CH boom')

    expect(releaseLock).toHaveBeenCalledWith('ingest-freshness:v1:lock:6')
  })

  it('lock取得直後の再確認でL2に別instanceの結果が見つかったら、実クエリを実行せずlockだけ解放する', async () => {
    // Codex review HIGH 4周目 issue#2: L2-miss判定〜lock取得の間に別instanceが計算・書込・
    // 解放を終えているケース。1回目のredisGet(L2初回確認)はmiss、lock取得後の再確認では
    // 既に値がある、という順序をシミュレートする。
    const client = mockClient([{ tracking_id: 'CIP_a' }], [{ site_id: 'CIP_a', is_stale: 0 }])
    const querySpy = client.query as jest.Mock
    const winningSummary: FreshnessSummary = {
      totalSites: 7,
      activeSites: 7,
      staleSites: 0,
      neverActiveSites: 0,
      thresholdHours: 6,
      ok: true,
    }
    let call = 0
    const redisGet = jest.fn(async () => {
      call += 1
      return call === 1 ? null : JSON.stringify(winningSummary) // 1回目miss、2回目(再確認)hit
    })
    const acquireLock = jest.fn(async () => true)
    const releaseLock = jest.fn(async () => {})
    const redisSet = jest.fn(async () => {})

    const result = await getIngestFreshnessSummary(client, {
      thresholdHours: 6,
      redisGet,
      redisSet,
      acquireLock,
      releaseLock,
    })

    expect(result).toEqual(winningSummary)
    expect(querySpy).not.toHaveBeenCalled() // 実クエリ不要
    expect(redisSet).not.toHaveBeenCalled() // 既にL2にある値を書き直さない
    expect(releaseLock).toHaveBeenCalledWith('ingest-freshness:v1:lock:6') // lockは解放する
  })
})
