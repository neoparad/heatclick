/**
 * Rate Limiting (Redis-backed with memory fallback)
 *
 * 親 SSOT §2.4.2 (F-44 プラン別 Rate Limit) / §2.3 Cost Guard
 * Sprint 0 S0-03 完成版。
 *
 * ugokimap/lib/rate-limit.ts から流用 + 5 階層プラン対応 (D-05)。
 */

import { redis as getRedisClient } from './redis'
import type { Plan } from './jwt'

// プラン別 Rate Limit (per minute、§2.4.2 F-44)
const PLAN_RATE_LIMITS: Record<Plan, number> = {
  free: 10,
  starter: 60,
  growth: 300,
  agency: 1200,
  enterprise: 6000, // 要見積、Phase 1 は固定上限
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 分

// プラン別 API quota (per hour、§2.4.3)
const PLAN_API_QUOTAS: Record<Plan, number> = {
  free: 100,
  starter: 1000,
  growth: 10000,
  agency: 100000,
  enterprise: 1000000,
}

const API_QUOTA_WINDOW_MS = 60 * 60 * 1000 // 1 時間

// メモリフォールバック (Redis 接続失敗時)
const memoryStore: Record<string, { count: number; resetTime: number }> = {}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetTime: number
  limit: number
}

/**
 * 短期 Rate Limit (per minute、プラン別)
 */
export async function checkRateLimit(
  identifier: string,
  plan: Plan = 'free',
): Promise<RateLimitResult> {
  const limit = PLAN_RATE_LIMITS[plan]

  try {
    const client = getRedisClient()
    const key = `ratelimit:${plan}:${identifier}`
    const count = await client.incr(key)
    if (count === 1) {
      await client.pexpire(key, RATE_LIMIT_WINDOW_MS)
    }
    const ttl = await client.pttl(key)
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetTime: Date.now() + Math.max(ttl, 0),
      limit,
    }
  } catch {
    return checkRateLimitSync(identifier, plan)
  }
}

/**
 * 長期 API quota (per hour、プラン別)
 */
export async function checkApiQuota(
  apiKey: string,
  plan: Plan = 'free',
): Promise<RateLimitResult> {
  const limit = PLAN_API_QUOTAS[plan]
  const identifier = `apiquota:${apiKey}`

  try {
    const client = getRedisClient()
    const key = `ratelimit:${identifier}`
    const count = await client.incr(key)
    if (count === 1) {
      await client.pexpire(key, API_QUOTA_WINDOW_MS)
    }
    const ttl = await client.pttl(key)
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetTime: Date.now() + Math.max(ttl, 0),
      limit,
    }
  } catch {
    return checkRateLimitSync(identifier, plan)
  }
}

function checkRateLimitSync(identifier: string, plan: Plan): RateLimitResult {
  const limit = PLAN_RATE_LIMITS[plan]
  const now = Date.now()
  let record = memoryStore[identifier]

  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS }
    memoryStore[identifier] = record
  }

  record.count++

  return {
    allowed: record.count <= limit,
    remaining: Math.max(0, limit - record.count),
    resetTime: record.resetTime,
    limit,
  }
}

// メモリストアのクリーンアップ
export function cleanupRateLimitStore(): void {
  const now = Date.now()
  for (const key of Object.keys(memoryStore)) {
    if (now > memoryStore[key].resetTime) delete memoryStore[key]
  }
}

if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRateLimitStore, 5 * 60 * 1000)
}
