import Redis from 'ioredis'

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
): Promise<any[] | null> {
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
  data: any[],
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
): Promise<any | null> {
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
  data: any,
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
export async function getSessionCache(sessionId: string): Promise<any | null> {
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
  data: any,
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
export async function getUserCache(userId: string): Promise<any | null> {
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
  data: any,
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
  data: any
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
  callback: (data: any) => void
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

// キャッシュのクリア
export async function clearCache(pattern: string): Promise<void> {
  try {
    const client = getRedisClient()
    const keys = await client.keys(pattern)
    if (keys.length > 0) {
      await client.del(...keys)
    }
  } catch (error) {
    console.error('Error clearing cache:', error)
  }
}

// キャッシュの統計情報
export async function getCacheStats(): Promise<any> {
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

// Export the client getter function
export { getRedisClient as redis }
