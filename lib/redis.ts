import Redis from 'ioredis'

// Redisクライアントの設定（モック実装）
const redis = {
  get: async (key: string) => null,
  setex: async (key: string, ttl: number, value: string) => 'OK',
  del: async (...keys: string[]) => 0,
  keys: async (pattern: string) => [],
  publish: async (channel: string, message: string) => 0,
  subscribe: async (channel: string) => {},
  duplicate: () => redis,
  on: (event: string, callback: Function) => {},
  status: 'ready' as const,
  info: async (section: string) => '',
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
  deviceType?: string
): Promise<any[] | null> {
  try {
    const key = `heatmap:${siteId}:${pageUrl}${deviceType ? `:${deviceType}` : ''}`
    const cached = await redis.get(key)
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
  ttl: number = CACHE_TTL.HEATMAP
): Promise<void> {
  try {
    const key = `heatmap:${siteId}:${pageUrl}${deviceType ? `:${deviceType}` : ''}`
    await redis.setex(key, ttl, JSON.stringify(data))
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
    const cached = await redis.get(key)
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
    await redis.setex(key, ttl, JSON.stringify(data))
  } catch (error) {
    console.error('Error setting statistics cache:', error)
  }
}

// セッションデータのキャッシュ
export async function getSessionCache(sessionId: string): Promise<any | null> {
  try {
    const key = `session:${sessionId}`
    const cached = await redis.get(key)
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
    await redis.setex(key, ttl, JSON.stringify(data))
  } catch (error) {
    console.error('Error setting session cache:', error)
  }
}

// ユーザーデータのキャッシュ
export async function getUserCache(userId: string): Promise<any | null> {
  try {
    const key = `user:${userId}`
    const cached = await redis.get(key)
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
    await redis.setex(key, ttl, JSON.stringify(data))
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
    await redis.publish(channel, JSON.stringify(data))
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
    const subscriber = redis.duplicate()
    
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
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } catch (error) {
    console.error('Error clearing cache:', error)
  }
}

// キャッシュの統計情報
export async function getCacheStats(): Promise<any> {
  try {
    const info = await redis.info('memory')
    const keyspace = await redis.info('keyspace')
    
    return {
      memory: info,
      keyspace: keyspace,
      connected: redis.status === 'ready'
    }
  } catch (error) {
    console.error('Error getting cache stats:', error)
    return null
  }
}

export { redis }
