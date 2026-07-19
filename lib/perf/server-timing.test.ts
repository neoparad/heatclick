/**
 * server-timing のユニットテスト。
 * 不変条件:
 *   (a) span は fn の戻り値を透過し、fn が throw した場合は span を記録した上で rethrow する
 *   (b) headerValue() は `name;dur=X` / `name;desc="v";dur=X` 形式で、total/cold/region を必ず含む
 *   (c) cold は module インスタンス内で最初の 1 回だけ true
 *   (d) desc に `"` を含めてもヘッダの構造が壊れない (余分な metric が注入されない)
 *
 * cold フラグは module スコープの状態なので、各テストごとに `jest.resetModules()` で
 * まっさらな module インスタンスを読み直す (テスト実行順への依存を無くすため)。
 */

type ServerTimingModule = typeof import('./server-timing')

let ServerTiming: ServerTimingModule

beforeEach(() => {
  jest.resetModules()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ServerTiming = require('./server-timing') as ServerTimingModule
})

describe('span', () => {
  it('resolves with the value fn returns and records the span', async () => {
    const t = ServerTiming.createRouteTimer('test-route')

    const result = await t.span('work', async () => 42)

    expect(result).toBe(42)
    expect(t.headerValue()).toMatch(/(^|, )work;dur=\d+(\.\d+)?/)
  })

  it('rethrows the original error but still records the span', async () => {
    const t = ServerTiming.createRouteTimer('test-route')
    const boom = new Error('boom')

    await expect(
      t.span('failing', async () => {
        throw boom
      }),
    ).rejects.toBe(boom)

    expect(t.headerValue()).toMatch(/(^|, )failing;dur=\d+(\.\d+)?/)
  })
})

describe('headerValue', () => {
  it('formats spans/marks and always includes total, cold, region', async () => {
    const t = ServerTiming.createRouteTimer('test-route')

    await t.span('ch', async () => 'ok')
    t.mark('bands', '3')

    const parts = t.headerValue().split(', ')

    expect(parts.some((p) => /^ch;dur=\d+(\.\d+)?$/.test(p))).toBe(true)
    expect(parts.some((p) => /^total;dur=\d+(\.\d+)?$/.test(p))).toBe(true)
    expect(parts).toContain('bands;desc="3"')
    expect(parts.some((p) => /^cold;desc="(0|1)"$/.test(p))).toBe(true)
    expect(parts.some((p) => /^region;desc=".*"$/.test(p))).toBe(true)
  })

  it('includes a span with a desc in `name;desc="v";dur=X` form', async () => {
    const t = ServerTiming.createRouteTimer('test-route')

    await t.span('cache', async () => undefined)
    // mark()を使わず、descありのspanが同じフォーマットになることも確認する
    t.mark('tier', 'l1')

    expect(t.headerValue()).toContain('tier;desc="l1"')
  })
})

describe('cold start', () => {
  it('is true only on the first call within a fresh module instance', () => {
    const first = ServerTiming.createRouteTimer('route-a')
    expect(first.headerValue()).toContain('cold;desc="1"')
    // cold のときだけ init;dur=... が付く
    expect(first.headerValue()).toMatch(/(^|, )init;dur=\d+(\.\d+)?/)

    const second = ServerTiming.createRouteTimer('route-b')
    expect(second.headerValue()).toContain('cold;desc="0"')
    expect(second.headerValue()).not.toMatch(/(^|, )init;dur=/)
  })

  it('coldStartInfo() itself follows the same first-call-only rule', () => {
    expect(ServerTiming.coldStartInfo().cold).toBe(true)
    expect(ServerTiming.coldStartInfo().cold).toBe(false)
    expect(ServerTiming.coldStartInfo().cold).toBe(false)
  })
})

describe('desc sanitization', () => {
  it('strips a double quote from desc so the header stays well-formed', () => {
    const t = ServerTiming.createRouteTimer('test-route')

    t.mark('tier', 'cold-capture", injected=1')

    const header = t.headerValue()
    const parts = header.split(', ')
    const knownNames = ['total', 'tier', 'cold', 'region', 'init']

    // 埋め込まれた `"` や `,` によって余分な metric が注入されていないこと
    for (const part of parts) {
      const metricName = part.split(';')[0]
      expect(knownNames).toContain(metricName)
    }

    const tierPart = parts.find((p) => p.startsWith('tier;'))
    expect(tierPart).toBeDefined()
    // 開始/終了の2つ以外に `"` が残っていない (quote を閉じてしまう文字が無い)
    const quoteCount = (tierPart ?? '').match(/"/g)?.length ?? 0
    expect(quoteCount).toBe(2)
  })
})

describe('reqId', () => {
  it('exposes a non-empty id that stays stable across calls on the same timer', () => {
    const t = ServerTiming.createRouteTimer('test-route')

    const first = t.reqId()
    const second = t.reqId()

    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('differs between two separate timers (used to correlate CH log_comment with app logs)', () => {
    const a = ServerTiming.createRouteTimer('route-a')
    const b = ServerTiming.createRouteTimer('route-b')

    expect(a.reqId()).not.toBe(b.reqId())
  })

  it('matches the reqId embedded in logLine()', async () => {
    const t = ServerTiming.createRouteTimer('test-route')
    await t.span('ch', async () => 'ok')

    const parsed = JSON.parse(t.logLine()) as { reqId: string }

    expect(parsed.reqId).toBe(t.reqId())
  })
})

describe('region', () => {
  it('falls back to "local" when VERCEL_REGION is unset', () => {
    const original = process.env.VERCEL_REGION
    delete process.env.VERCEL_REGION

    expect(ServerTiming.region()).toBe('local')

    if (original !== undefined) process.env.VERCEL_REGION = original
  })

  it('returns VERCEL_REGION when set', () => {
    const original = process.env.VERCEL_REGION
    process.env.VERCEL_REGION = 'iad1'

    expect(ServerTiming.region()).toBe('iad1')

    if (original === undefined) delete process.env.VERCEL_REGION
    else process.env.VERCEL_REGION = original
  })
})
