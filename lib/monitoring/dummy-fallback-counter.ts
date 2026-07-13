import { redis } from '@/lib/redis'

export const DEFAULT_DUMMY_FALLBACK_WINDOW_HOURS = 6

const HOUR_MS = 60 * 60 * 1000
const MAX_WINDOW_HOURS = 24 * 31
const KEY_PREFIX = 'dummy-fallback:v1'

export interface DummyFallbackCounterHooks {
  now?: () => Date
  redisIncr?: (key: string) => Promise<number>
  redisExpire?: (key: string, seconds: number) => Promise<number>
  redisGet?: (key: string) => Promise<string | null>
}

function resolveWindowHours(value: unknown = process.env.DUMMY_FALLBACK_WINDOW_HOURS): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_WINDOW_HOURS) {
    return parsed
  }
  return DEFAULT_DUMMY_FALLBACK_WINDOW_HOURS
}

function hourBucket(now: Date): number {
  return Math.floor(now.getTime() / HOUR_MS)
}

function counterKey(feature: string, bucket: number): string {
  return `${KEY_PREFIX}:${encodeURIComponent(feature)}:${bucket}`
}

function readCount(raw: string | null): number {
  if (raw === null) return 0
  const count = Number(raw)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

async function defaultRedisIncr(key: string): Promise<number> {
  return redis().incr(key)
}

async function defaultRedisExpire(key: string, seconds: number): Promise<number> {
  return redis().expire(key, seconds)
}

async function defaultRedisGet(key: string): Promise<string | null> {
  return redis().get(key)
}

/**
 * Records a non-intentional dummy-data fallback in the current hour bucket.
 * Redis is monitoring-only infrastructure, so every Redis error is fail-open.
 */
export async function recordDummyFallback(
  feature: string,
  options: DummyFallbackCounterHooks = {},
): Promise<void> {
  const windowHours = resolveWindowHours()
  const now = options.now?.() ?? new Date()
  const key = counterKey(feature, hourBucket(now))
  const redisIncr = options.redisIncr ?? defaultRedisIncr
  const redisExpire = options.redisExpire ?? defaultRedisExpire

  try {
    const count = await redisIncr(key)
    if (count === 1) {
      await redisExpire(key, (windowHours + 1) * 60 * 60)
    }
  } catch {
    // Monitoring must never change the caller's fallback response.
  }
}

/**
 * Returns the aggregate fallback count for the current and prior hour buckets.
 * A Redis outage is observable through checked=false but never throws from health.
 */
export async function getRecentDummyFallbacks(
  feature: string,
  windowHours?: number,
  options: DummyFallbackCounterHooks = {},
): Promise<{ count: number; checked: boolean; windowHours: number }> {
  const resolvedWindowHours = resolveWindowHours(windowHours)
  const now = options.now?.() ?? new Date()
  const currentBucket = hourBucket(now)
  const redisGet = options.redisGet ?? defaultRedisGet

  try {
    const values = await Promise.all(
      Array.from({ length: resolvedWindowHours }, (_, offset) =>
        redisGet(counterKey(feature, currentBucket - offset)),
      ),
    )
    return {
      count: values.reduce((sum, value) => sum + readCount(value), 0),
      checked: true,
      windowHours: resolvedWindowHours,
    }
  } catch {
    return { count: 0, checked: false, windowHours: resolvedWindowHours }
  }
}
