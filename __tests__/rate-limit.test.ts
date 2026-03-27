import { checkRateLimit, cleanupRateLimitStore } from '@/lib/rate-limit'

describe('Rate Limiter (memory fallback)', () => {
  beforeEach(() => {
    cleanupRateLimitStore()
  })

  it('should allow requests within limit', () => {
    const result = checkRateLimit('test-ip-1')
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(99) // 100 max - 1
  })

  it('should decrement remaining count', () => {
    checkRateLimit('test-ip-2')
    checkRateLimit('test-ip-2')
    const result = checkRateLimit('test-ip-2')
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(97) // 100 - 3
  })

  it('should block after exceeding limit', () => {
    const id = 'test-ip-flood'
    for (let i = 0; i < 100; i++) {
      checkRateLimit(id)
    }
    const result = checkRateLimit(id)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('should track different identifiers independently', () => {
    for (let i = 0; i < 100; i++) {
      checkRateLimit('ip-a')
    }
    const resultA = checkRateLimit('ip-a')
    const resultB = checkRateLimit('ip-b')

    expect(resultA.allowed).toBe(false)
    expect(resultB.allowed).toBe(true)
  })

  it('should include resetTime in future', () => {
    const before = Date.now()
    const result = checkRateLimit('test-ip-time')
    expect(result.resetTime).toBeGreaterThan(before)
  })
})
