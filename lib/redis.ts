import Redis from 'ioredis'
import type { EventBufferItem } from './clickhouse/types'

// Redisクライアントの設定
function getRedisConfig() {
  if (process.env.REDIS_URL) {
    // 完全なURL形式の場合
    return {
      host: process.env.REDIS_URL,
    }
  } else {
    // 個別の環境変数から構築
    const host = process.env.REDIS_HOST || 'localhost'
    const port = parseInt(process.env.REDIS_PORT || '6379')
    const password = process.env.REDIS_PASSWORD || undefined
    
    return {
      host,
      port,
      password,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000)
        return delay
      },
      maxRetriesPerRequest: 3,
    }
  }
}

let redis: Redis | null = null

// Redisクライアントの初期化（遅延初期化）
function getRedisClient(): Redis {
  if (!redis) {
    try {
      const config = getRedisConfig()
      
      if ('host' in config && config.host.startsWith('redis://')) {
        // URL形式の場合
        redis = new Redis(config.host, {
          retryStrategy: (times: number) => {
            const delay = Math.min(times * 50, 2000)
            return delay
          },
          maxRetriesPerRequest: 3,
        })
      } else {
        // 個別設定の場合
        redis = new Redis(config as any)
      }
      
      redis.on('error', (error) => {
        console.error('Redis client error:', error)
      })
      
      redis.on('connect', () => {
        if (process.env.NODE_ENV === 'development') {
          console.log('Redis client connected')
        }
      })
      
      if (process.env.NODE_ENV === 'development') {
        console.log('Redis client initialized:', {
          host: 'host' in config ? config.host : 'N/A',
          port: 'port' in config ? config.port : 'N/A',
        })
      }
    } catch (error) {
      console.error('Failed to initialize Redis client:', error)
      // エラーが発生してもモック実装にフォールバック
      return createMockRedis()
    }
  }
  return redis
}

// モック実装（接続失敗時のフォールバック）
function createMockRedis(): Redis {
  const mockRedis = {
    get: async (key: string) => null,
    setex: async (key: string, ttl: number, value: string) => 'OK',
    del: async (...keys: string[]) => 0,
    keys: async (pattern: string) => [],
    publish: async (channel: string, message: string) => 0,
    subscribe: async (channel: string) => {},
    duplicate: () => mockRedis as any,
    on: (event: string, callback: Function) => {},
    status: 'ready' as const,
    info: async (section: string) => '',
  } as any
  
  return mockRedis as Redis
}

// キャッシュの設定
const CACHE_TTL = {
  HEATMAP: 3600, // 1時間
  STATISTICS: 1800, // 30分
  SESSION: 86400, // 24時間
  USER: 3600, // 1時間
}

// ヒートマップデータのキャッシュ
export async function getHeatmapCache(
  siteId: string,
  pageUrl: string,
  deviceType?: string,
  startDate?: string,
  endDate?: string,
  heatmapType?: string
): Promise<Record<string, unknown>[] | null> {
  try {
    const client = getRedisClient()
    // heatmap_typeを含めたキャッシュキーに変更
    const key = `heatmap:v2:${siteId}:${pageUrl}:${deviceType || 'all'}:${heatmapType || 'click'}:${startDate || 'all'}:${endDate || 'all'}`
    const cached = await client.get(key)
    return cached ? JSON.parse(cached) : null
  } catch (error) {
    console.error('Error getting heatmap cache:', error)
    return null
  }
}

export async function setHeatmapCache(
  siteId: string,
  pageUrl: string,
  data: Record<string, unknown>[],
  deviceType?: string,
  startDate?: string,
  endDate?: string,
  ttl: number = CACHE_TTL.HEATMAP,
  heatmapType?: string
): Promise<void> {
  try {
    // heatmap_typeを含めたキャッシュキーに変更
    const key = `heatmap:v2:${siteId}:${pageUrl}:${deviceType || 'all'}:${heatmapType || 'click'}:${startDate || 'all'}:${endDate || 'all'}`
    const client = getRedisClient()
    await client.setex(key, ttl, JSON.stringify(data))
  } catch (error) {
    console.error('Error setting heatmap cache:', error)
  }
}

// 統計データのキャッシュ
export async function getStatisticsCache(
  siteId: string,
  startDate?: string,
  endDate?: string
): Promise<Record<string, unknown> | null> {
  try {
    const key = `stats:${siteId}:${startDate || 'all'}:${endDate || 'all'}`
    const client = getRedisClient()
    const cached = await client.get(key)
    return cached ? JSON.parse(cached) : null
  } catch (error) {
    console.error('Error getting statistics cache:', error)
    return null
  }
}

export async function setStatisticsCache(
  siteId: string,
  data: Record<string, unknown>,
  startDate?: string,
  endDate?: string,
  ttl: number = CACHE_TTL.STATISTICS
): Promise<void> {
  try {
    const key = `stats:${siteId}:${startDate || 'all'}:${endDate || 'all'}`
    const client = getRedisClient()
    await client.setex(key, ttl, JSON.stringify(data))
  } catch (error) {
    console.error('Error setting statistics cache:', error)
  }
}

// セッションデータのキャッシュ
export async function getSessionCache(sessionId: string): Promise<Record<string, unknown> | null> {
  try {
    const key = `session:${sessionId}`
    const client = getRedisClient()
    const cached = await client.get(key)
    return cached ? JSON.parse(cached) : null
  } catch (error) {
    console.error('Error getting session cache:', error)
    return null
  }
}

export async function setSessionCache(
  sessionId: string,
  data: Record<string, unknown>,
  ttl: number = CACHE_TTL.SESSION
): Promise<void> {
  try {
    const key = `session:${sessionId}`
    const client = getRedisClient()
    await client.setex(key, ttl, JSON.stringify(data))
  } catch (error) {
    console.error('Error setting session cache:', error)
  }
}

// ユーザーデータのキャッシュ
export async function getUserCache(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const key = `user:${userId}`
    const client = getRedisClient()
    const cached = await client.get(key)
    return cached ? JSON.parse(cached) : null
  } catch (error) {
    console.error('Error getting user cache:', error)
    return null
  }
}

export async function setUserCache(
  userId: string,
  data: Record<string, unknown>,
  ttl: number = CACHE_TTL.USER
): Promise<void> {
  try {
    const key = `user:${userId}`
    const client = getRedisClient()
    await client.setex(key, ttl, JSON.stringify(data))
  } catch (error) {
    console.error('Error setting user cache:', error)
  }
}

// リアルタイムデータの管理
export async function publishRealtimeData(
  siteId: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const channel = `realtime:${siteId}`
    const client = getRedisClient()
    await client.publish(channel, JSON.stringify(data))
  } catch (error) {
    console.error('Error publishing realtime data:', error)
  }
}

export async function subscribeRealtimeData(
  siteId: string,
  callback: (data: Record<string, unknown>) => void
): Promise<void> {
  try {
    const channel = `realtime:${siteId}`
    const client = getRedisClient()
    const subscriber = client.duplicate()
    
    await subscriber.subscribe(channel)
    subscriber.on('message', (channel: string, message: string) => {
      try {
        const data = JSON.parse(message)
        callback(data)
      } catch (error) {
        console.error('Error parsing realtime message:', error)
      }
    })
  } catch (error) {
    console.error('Error subscribing to realtime data:', error)
  }
}

// キャッシュのクリア（SCANで安全にキー走査）
export async function clearCache(pattern: string): Promise<void> {
  try {
    const client = getRedisClient()
    let cursor = '0'
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = nextCursor
      if (keys.length > 0) {
        await client.del(...keys)
      }
    } while (cursor !== '0')
  } catch (error) {
    console.error('Error clearing cache:', error)
  }
}

// キャッシュの統計情報
export async function getCacheStats(): Promise<{ memory: string; keyspace: string; connected: boolean } | null> {
  try {
    const client = getRedisClient()
    const info = await client.info('memory')
    const keyspace = await client.info('keyspace')
    
    return {
      memory: info,
      keyspace: keyspace,
      connected: client.status === 'ready'
    }
  } catch (error) {
    console.error('Error getting cache stats:', error)
    return null
  }
}

// イベントバッファ: ClickHouseへの直接書き込みを避け、Redisに一時保存
const EVENT_BUFFER_KEY = 'event_buffer:pending'
const EVENT_BUFFER_RETRY_KEY = 'event_buffer:retry'

export async function pushEventBuffer(
  table: string,
  values: Record<string, unknown>[]
): Promise<void> {
  try {
    const client = getRedisClient()
    const payload = JSON.stringify({ table, values, timestamp: Date.now() })
    await client.rpush(EVENT_BUFFER_KEY, payload)
  } catch (error) {
    console.error('Error pushing to event buffer:', error)
    throw error
  }
}

// Lua: LRANGE + LTRIM を原子的に実行（2重処理防止）
const POP_BUFFER_LUA = `
  local items = redis.call('LRANGE', KEYS[1], 0, ARGV[1] - 1)
  if #items > 0 then
    redis.call('LTRIM', KEYS[1], #items, -1)
  end
  return items
`

export async function popEventBuffer(batchSize: number = 500): Promise<EventBufferItem[]> {
  try {
    const client = getRedisClient()
    const rawItems = await client.eval(POP_BUFFER_LUA, 1, EVENT_BUFFER_KEY, batchSize) as string[]
    if (!rawItems || rawItems.length === 0) return []
    return rawItems.map(item => JSON.parse(item))
  } catch (error) {
    console.error('Error popping from event buffer:', error)
    return []
  }
}

export async function pushRetryBuffer(
  table: string,
  values: Record<string, unknown>[]
): Promise<void> {
  try {
    const client = getRedisClient()
    const payload = JSON.stringify({ table, values, timestamp: Date.now() })
    await client.rpush(EVENT_BUFFER_RETRY_KEY, payload)
  } catch (error) {
    console.error('Error pushing to retry buffer:', error)
  }
}

export async function popRetryBuffer(batchSize: number = 100): Promise<EventBufferItem[]> {
  try {
    const client = getRedisClient()
    const rawItems = await client.eval(POP_BUFFER_LUA, 1, EVENT_BUFFER_RETRY_KEY, batchSize) as string[]
    if (!rawItems || rawItems.length === 0) return []
    return rawItems.map(item => JSON.parse(item))
  } catch (error) {
    console.error('Error popping from retry buffer:', error)
    return []
  }
}

export async function getEventBufferLength(): Promise<number> {
  try {
    const client = getRedisClient()
    return await client.llen(EVENT_BUFFER_KEY)
  } catch (error) {
    return 0
  }
}

// Export the client getter function
export { getRedisClient as redis }
