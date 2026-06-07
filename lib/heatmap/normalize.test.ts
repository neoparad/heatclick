/**
 * logNormalize — 強度の対数正規化 regression (node env)
 */
import { logNormalize } from './normalize'

describe('logNormalize', () => {
  it('count 0 / 負 / NaN は 0', () => {
    expect(logNormalize(0, 100)).toBe(0)
    expect(logNormalize(-5, 100)).toBe(0)
    expect(logNormalize(Number.NaN, 100)).toBe(0)
  })

  it('count = max は 1', () => {
    expect(logNormalize(100, 100)).toBe(1)
  })

  it('max 超過は 1 にクランプ', () => {
    expect(logNormalize(1000, 100)).toBe(1)
  })

  it('外れ値で潰れない: bulk が線形より大きく持ち上がる', () => {
    const linear = 10 / 500 // 0.02
    const log = logNormalize(10, 500)
    expect(log).toBeGreaterThan(linear)
    expect(log).toBeGreaterThan(0.3) // 可視域 (約 0.39)
    expect(log).toBeLessThan(1)
  })

  it('順序を保つ (単調増加)', () => {
    const max = 1000
    expect(logNormalize(5, max)).toBeLessThan(logNormalize(50, max))
    expect(logNormalize(50, max)).toBeLessThan(logNormalize(500, max))
  })

  it('max が 0 でも例外を出さず 0..1 に収まる', () => {
    const v = logNormalize(5, 0)
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  })
})
