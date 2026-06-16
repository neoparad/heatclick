/**
 * Redis client (singleton)
 *
 * 親 SSOT §3.2.3 / §3.7
 * Sprint 0 S0-03 流用。
 */

import Redis from 'ioredis'

let _client: Redis | null = null

export function redis(): Redis {
  if (!_client) {
    const url = process.env.REDIS_URL
    if (!url) {
      throw new Error('REDIS_URL environment variable is required')
    }
    _client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    })
    _client.on('error', (err) => {
      // Sentry でキャプチャされる想定 (instrumentation.ts)
      // Silent fail で memory fallback に頼る
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.error('Redis connection error:', err.message)
      }
    })
  }
  return _client
}

export function resetRedisConnection(): void {
  if (_client) {
    _client.disconnect()
    _client = null
  }
}
