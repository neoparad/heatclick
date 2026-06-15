/**
 * lib/llm/chat-rate-limit.ts — Chat-specific rate limit (60 req/h/tenant) (続 68 W2-A、続 66 §3 M-7)
 *
 * 親 SSOT §2.4.2 (F-44 Rate Limit) / 続 66 §3 M-7
 * 配備根拠: chat 経路は plan rate limit (lib/rate-limit.ts、per-minute) とは独立に、
 *           tenant あたり 60 req/h の上限を持つ (LLM コスト + abuse 防御)。
 *
 * 既存 `lib/rate-limit.ts` との関係:
 *   - per-minute plan rate (free=10/min, growth=300/min etc.) は既存 `checkRateLimit()`
 *   - 本ファイルは **tenant あたり 60 req/h** 専用、chat 用
 *   - 両方適用 (per-minute は API gateway 全般、per-hour は chat orchestrator のみ)
 *
 * 実装:
 *   - Redis-backed (`lib/redis.ts:redis()`) で sliding hourly bucket
 *   - 失敗時は in-memory fallback (続 63 lib/rate-limit.ts 流儀)
 *   - key = `chat-rate:${tenant_id}:${hour_bucket}`
 */

import { redis as getRedisClient } from '@/lib/redis'

export const CHAT_RATE_LIMIT_PER_HOUR = 60
const HOUR_BUCKET_MS = 60 * 60 * 1000

export interface ChatRateLimitResult {
  allowed: boolean
  remaining: number
  resetTime: number
  limit: number
}

// ── In-memory fallback (Redis 障害時) ───────────────────────────────

const memoryStore: Record<string, { count: number; resetTime: number }> = {}

function checkSync(tenantId: string): ChatRateLimitResult {
  const limit = CHAT_RATE_LIMIT_PER_HOUR
  const now = Date.now()
  const key = `${tenantId}:${Math.floor(now / HOUR_BUCKET_MS)}`
  let record = memoryStore[key]
  if (!record) {
    record = { count: 0, resetTime: now + HOUR_BUCKET_MS }
    memoryStore[key] = record
  }
  record.count++
  return {
    allowed: record.count <= limit,
    remaining: Math.max(0, limit - record.count),
    resetTime: record.resetTime,
    limit,
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * chat あたり 60 req/h の rate limit を check + count。
 *
 * Atomic increment (Redis INCR + PEXPIRE)、bucket は hour 単位 sliding。
 *   key = `chat-rate:${tenant_id}:${hour_bucket}`
 *
 * Redis 接続失敗時:
 *   - in-memory fallback (per-process)、複数 instance では over-counting だが under-counting しない
 *   - failure mode で chat を全停止させない (Owner / Director judgment)
 */
export async function checkChatRateLimit(tenantId: string): Promise<ChatRateLimitResult> {
  const limit = CHAT_RATE_LIMIT_PER_HOUR
  try {
    const client = getRedisClient()
    const hourBucket = Math.floor(Date.now() / HOUR_BUCKET_MS)
    const key = `chat-rate:${tenantId}:${hourBucket}`
    const count = await client.incr(key)
    if (count === 1) {
      // 1.5x の余裕で expire 設定 (clock skew 吸収)
      await client.pexpire(key, Math.floor(HOUR_BUCKET_MS * 1.5))
    }
    const ttl = await client.pttl(key)
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetTime: Date.now() + Math.max(ttl, 0),
      limit,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.warn(`[chat-rate-limit] Redis failed, in-memory fallback: ${msg}`)
    return checkSync(tenantId)
  }
}

// 5 分ごとに memory store cleanup
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const key of Object.keys(memoryStore)) {
      if (now > memoryStore[key].resetTime) delete memoryStore[key]
    }
  }, 5 * 60 * 1000)
}
