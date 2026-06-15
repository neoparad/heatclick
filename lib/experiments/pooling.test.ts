import { poolSiteEffects, tQuantile975, type SiteEffect } from '@/lib/experiments/pooling'

/**
 * Oracle: sim_pooling_power.py L32-44 の DL 部分を **独立に再移植** した参照実装。
 * pooling.ts と同じ式を別コードパスで書き、数値一致を回帰する (式の写し間違い検出)。
 */
function oracleDL(effects: SiteEffect[]): {
  pooled: number
  tau2: number
  q: number
  seClassic: number
} {
  const k = effects.length
  const wf = effects.map((e) => 1 / e.variance)
  const sw = wf.reduce((a, b) => a + b, 0)
  const pooledF = effects.reduce((a, e, i) => a + wf[i] * e.log_rr, 0) / sw
  const q = effects.reduce((a, e, i) => a + wf[i] * (e.log_rr - pooledF) ** 2, 0)
  const c = sw - wf.reduce((a, w) => a + w * w, 0) / sw
  const tau2 = c > 0 ? Math.max(0, (q - (k - 1)) / c) : 0
  const w = effects.map((e) => 1 / (e.variance + tau2))
  const sw2 = w.reduce((a, b) => a + b, 0)
  const pooled = effects.reduce((a, e, i) => a + w[i] * e.log_rr, 0) / sw2
  return { pooled, tau2, q, seClassic: Math.sqrt(1 / sw2) }
}

// 決定論的な擬似データ (Math.random 不使用)。異質性ありの 30 サイト。
function syntheticEffects(k: number): SiteEffect[] {
  const out: SiteEffect[] = []
  for (let i = 0; i < k; i++) {
    const wave = Math.sin(i * 1.7) // [-1,1] の決定論的ゆらぎ
    out.push({ log_rr: 0.1 + 0.15 * wave, variance: 0.02 + 0.015 * Math.abs(Math.cos(i * 0.9)) })
  }
  return out
}

describe('experiments/pooling — DL oracle 数値一致 (sim L32-44)', () => {
  it.each([[5], [12], [24], [50]])('K=%i で pooled/τ²/Q が oracle と一致', (k) => {
    const effects = syntheticEffects(k)
    const r = poolSiteEffects(effects)
    const o = oracleDL(effects)
    expect(r).not.toBeNull()
    expect(r!.pooled_log_rr).toBeCloseTo(o.pooled, 12)
    expect(r!.tau2).toBeCloseTo(o.tau2, 12)
    expect(r!.q).toBeCloseTo(o.q, 12)
    expect(r!.k).toBe(k)
  })

  it('手計算 fixture (2 studies): pooled=0.2667, τ²=0, SE=0.1633, t(1)=12.706', () => {
    const r = poolSiteEffects([
      { log_rr: 0.2, variance: 0.04 },
      { log_rr: 0.4, variance: 0.08 },
    ])
    expect(r).not.toBeNull()
    expect(r!.pooled_log_rr).toBeCloseTo(0.2666667, 6)
    expect(r!.tau2).toBe(0)
    expect(r!.i2).toBe(0)
    // KH SE (0.0943) < classic (0.1633) → 保守的 truncation で classic を採用
    expect(r!.se).toBeCloseTo(0.1632993, 6)
    expect(r!.ci_low).toBeCloseTo(0.2666667 - 12.706 * 0.1632993, 4)
    expect(r!.ci_high).toBeCloseTo(0.2666667 + 12.706 * 0.1632993, 4)
  })
})

describe('experiments/pooling — KH 補正の性質', () => {
  it('異質なデータでは KH SE が classic より広がり CI が保守化する', () => {
    // 大きくバラつく効果 (τ² が Q を支配)
    const effects: SiteEffect[] = [
      { log_rr: 0.6, variance: 0.01 },
      { log_rr: -0.5, variance: 0.01 },
      { log_rr: 0.55, variance: 0.01 },
      { log_rr: -0.45, variance: 0.01 },
      { log_rr: 0.5, variance: 0.01 },
    ]
    const r = poolSiteEffects(effects)!
    const o = oracleDL(effects)
    expect(r.se).toBeGreaterThanOrEqual(o.seClassic) // max truncation
    expect(r.tau2).toBeGreaterThan(0)
    expect(r.i2).toBeGreaterThan(0.5)
  })

  it('均質なデータ (同一効果) では τ²=0・I²=0', () => {
    const effects = Array.from({ length: 24 }, () => ({ log_rr: 0.3, variance: 0.05 }))
    const r = poolSiteEffects(effects)!
    expect(r.tau2).toBe(0)
    expect(r.i2).toBe(0)
    expect(r.pooled_log_rr).toBeCloseTo(0.3, 12)
  })

  it('真効果 +30%・低異質性・K=30 で CI下限>0 (効く傾向を検出できる)', () => {
    const effects = syntheticEffects(30).map((e) => ({ ...e, log_rr: e.log_rr + 0.2 }))
    const r = poolSiteEffects(effects)!
    expect(r.ci_low).toBeGreaterThan(0)
  })
})

describe('experiments/pooling — fail-closed', () => {
  it('K<2 / 全滅 → null', () => {
    expect(poolSiteEffects([])).toBeNull()
    expect(poolSiteEffects([{ log_rr: 0.2, variance: 0.04 }])).toBeNull()
  })

  it('非有限・variance<=0 の入力は除外して計算 (残り K<2 なら null)', () => {
    expect(
      poolSiteEffects([
        { log_rr: NaN, variance: 0.04 },
        { log_rr: 0.2, variance: 0 },
        { log_rr: 0.3, variance: -1 },
      ]),
    ).toBeNull()
    const r = poolSiteEffects([
      { log_rr: NaN, variance: 0.04 },
      { log_rr: 0.2, variance: 0.04 },
      { log_rr: 0.4, variance: 0.08 },
    ])
    expect(r).not.toBeNull()
    expect(r!.k).toBe(2) // NaN は除外
  })
})

describe('experiments/pooling — tQuantile975', () => {
  it('既知表と一致 (df 1..10 は exact、df>10 は誤差 <0.005)', () => {
    expect(tQuantile975(1)).toBeCloseTo(12.706, 3)
    expect(tQuantile975(5)).toBeCloseTo(2.571, 3)
    expect(tQuantile975(10)).toBeCloseTo(2.228, 3)
    expect(Math.abs(tQuantile975(11) - 2.201)).toBeLessThan(0.005)
    expect(Math.abs(tQuantile975(20) - 2.086)).toBeLessThan(0.005)
    expect(Math.abs(tQuantile975(23) - 2.069)).toBeLessThan(0.005) // K=24 の運用域
    expect(Math.abs(tQuantile975(30) - 2.042)).toBeLessThan(0.005)
    expect(Math.abs(tQuantile975(49) - 2.01) ).toBeLessThan(0.005) // K=50
    expect(Math.abs(tQuantile975(100) - 1.984)).toBeLessThan(0.005)
  })

  it('df が大きいほど z=1.96 に収束・単調減少', () => {
    expect(tQuantile975(1000)).toBeCloseTo(1.962, 2)
    expect(tQuantile975(23)).toBeGreaterThan(tQuantile975(49))
    expect(tQuantile975(49)).toBeGreaterThan(tQuantile975(200))
  })

  it('不正 df → NaN', () => {
    expect(Number.isNaN(tQuantile975(0))).toBe(true)
    expect(Number.isNaN(tQuantile975(NaN))).toBe(true)
  })
})
