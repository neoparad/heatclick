// 簡易的なAPI Rate Limiting実装

interface RateLimitStore {
  [key: string]: {
    count: number
    resetTime: number
  }
}

// メモリ内ストレージ（本番環境ではRedisを使用推奨）
const rateLimitStore: RateLimitStore = {}

// レート制限の設定
const RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60 * 1000, // 15分
  maxRequests: 100, // 最大100リクエスト
}

export function checkRateLimit(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now()
  const key = identifier

  // 既存のレコードを取得
  let record = rateLimitStore[key]

  // レコードが存在しない、またはリセット時間が過ぎている場合
  if (!record || now > record.resetTime) {
    record = {
      count: 0,
      resetTime: now + RATE_LIMIT_CONFIG.windowMs,
    }
    rateLimitStore[key] = record
  }

  // リクエスト数を増やす
  record.count++

  const remaining = Math.max(0, RATE_LIMIT_CONFIG.maxRequests - record.count)
  const allowed = record.count <= RATE_LIMIT_CONFIG.maxRequests

  return {
    allowed,
    remaining,
    resetTime: record.resetTime,
  }
}

// 古いレコードのクリーンアップ（定期的に実行）
export function cleanupRateLimitStore() {
  const now = Date.now()
  Object.keys(rateLimitStore).forEach(key => {
    if (now > rateLimitStore[key].resetTime) {
      delete rateLimitStore[key]
    }
  })
}

// 5分ごとにクリーンアップを実行
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRateLimitStore, 5 * 60 * 1000)
}



