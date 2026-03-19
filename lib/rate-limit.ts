// Redis-backed Rate Limiting
// メモリフォールバック付き

import { redis as getRedisClient } from './redis'

const RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60 * 1000, // 15分
  maxRequests: 100,
}

// メモリフォールバック（Redis接続失敗時）
const memoryStore: Record<string, { count: number; resetTime: number }> = {}

export async function checkRateLimitAsync(identifier: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  try {
    const client = getRedisClient()
    const key = `ratelimit:${identifier}`
    const now = Date.now()
    const windowEnd = now + RATE_LIMIT_CONFIG.windowMs

    // Redisのインクリメント + TTL設定
    const count = await client.incr(key)

    if (count === 1) {
      // 新しいキー → TTLを設定
      await client.pexpire(key, RATE_LIMIT_CONFIG.windowMs)
    }

    const ttl = await client.pttl(key)
    const resetTime = now + Math.max(ttl, 0)
    const remaining = Math.max(0, RATE_LIMIT_CONFIG.maxRequests - count)

    return {
      allowed: count <= RATE_LIMIT_CONFIG.maxRequests,
      remaining,
      resetTime,
    }
  } catch {
    // Redis接続失敗 → メモリフォールバック
    return checkRateLimitSync(identifier)
  }
}

// 同期版（メモリ内、後方互換性のため残す）
export function checkRateLimit(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
  return checkRateLimitSync(identifier)
}

function checkRateLimitSync(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now()
  let record = memoryStore[identifier]

  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + RATE_LIMIT_CONFIG.windowMs }
    memoryStore[identifier] = record
  }

  record.count++
  const remaining = Math.max(0, RATE_LIMIT_CONFIG.maxRequests - record.count)

  return {
    allowed: record.count <= RATE_LIMIT_CONFIG.maxRequests,
    remaining,
    resetTime: record.resetTime,
  }
}

// メモリストアのクリーンアップ
export function cleanupRateLimitStore() {
  const now = Date.now()
  for (const key of Object.keys(memoryStore)) {
    if (now > memoryStore[key].resetTime) delete memoryStore[key]
  }
}

if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRateLimitStore, 5 * 60 * 1000)
}
