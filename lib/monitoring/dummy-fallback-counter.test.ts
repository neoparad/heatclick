import {
  getRecentDummyFallbacks,
  recordDummyFallback,
} from './dummy-fallback-counter'

const HOUR_MS = 60 * 60 * 1000
const now = new Date('2026-07-13T00:30:00.000Z')

function hourKey(feature: string, offset = 0): string {
  const bucket = Math.floor(now.getTime() / HOUR_MS) - offset
  return `dummy-fallback:v1:${feature}:${bucket}`
}

describe('dummy fallback counter', () => {
  const originalWindowHours = process.env.DUMMY_FALLBACK_WINDOW_HOURS

  beforeEach(() => {
    delete process.env.DUMMY_FALLBACK_WINDOW_HOURS
  })

  afterAll(() => {
    if (originalWindowHours === undefined) {
      delete process.env.DUMMY_FALLBACK_WINDOW_HOURS
    } else {
      process.env.DUMMY_FALLBACK_WINDOW_HOURS = originalWindowHours
    }
  })

  it('records the first fallback in the current hour and sets the retention TTL', async () => {
    const redisIncr = jest.fn(async () => 1)
    const redisExpire = jest.fn(async () => 1)

    await recordDummyFallback('cv-journey', {
      now: () => now,
      redisIncr,
      redisExpire,
    })

    expect(redisIncr).toHaveBeenCalledWith(hourKey('cv-journey'))
    expect(redisExpire).toHaveBeenCalledWith(hourKey('cv-journey'), 7 * 60 * 60)
  })

  it('does not reset the TTL when the hour bucket already has a counter', async () => {
    const redisIncr = jest.fn(async () => 2)
    const redisExpire = jest.fn(async () => 1)

    await recordDummyFallback('cv-journey', {
      now: () => now,
      redisIncr,
      redisExpire,
    })

    expect(redisExpire).not.toHaveBeenCalled()
  })

  it('sums the current and previous hour buckets inside the requested window', async () => {
    const redisGet = jest.fn(async (key: string) => {
      if (key === hourKey('cv-journey')) return '2'
      if (key === hourKey('cv-journey', 2)) return '3'
      return null
    })

    const result = await getRecentDummyFallbacks('cv-journey', 3, {
      now: () => now,
      redisGet,
    })

    expect(result).toEqual({ count: 5, checked: true, windowHours: 3 })
    expect(redisGet).toHaveBeenCalledTimes(3)
  })

  it('fails open when Redis is unavailable', async () => {
    const unavailable = async () => {
      throw new Error('redis unavailable')
    }

    await expect(
      recordDummyFallback('cv-journey', {
        now: () => now,
        redisIncr: unavailable,
      }),
    ).resolves.toBeUndefined()

    await expect(
      getRecentDummyFallbacks('cv-journey', 6, {
        now: () => now,
        redisGet: unavailable,
      }),
    ).resolves.toEqual({ count: 0, checked: false, windowHours: 6 })
  })

  it('uses a valid integer environment window and falls back for invalid values', async () => {
    const redisGet = jest.fn(async () => null)
    process.env.DUMMY_FALLBACK_WINDOW_HOURS = '12'

    const configured = await getRecentDummyFallbacks('cv-journey', undefined, {
      now: () => now,
      redisGet,
    })

    expect(configured.windowHours).toBe(12)
    expect(redisGet).toHaveBeenCalledTimes(12)

    redisGet.mockClear()
    process.env.DUMMY_FALLBACK_WINDOW_HOURS = '6.5'
    const invalid = await getRecentDummyFallbacks('cv-journey', undefined, {
      now: () => now,
      redisGet,
    })

    expect(invalid.windowHours).toBe(6)
    expect(redisGet).toHaveBeenCalledTimes(6)
  })
})
