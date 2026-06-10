import {
  INTERVENTION_TYPES,
  NON_MECHANICAL_TOKENS,
  PAGE_TYPES,
  INDUSTRIES,
  DEVICES,
  PRIMARY_METRICS,
  EXPERIMENT_WINDOWS,
  WINDOW_DAYS,
  InterventionTypeSchema,
  DeviceSchema,
  cellKey,
  parseCellKey,
  type CellDimensions,
} from '@/lib/experiments/taxonomy'

describe('experiments/taxonomy — mechanical-only invariant (鉄則)', () => {
  it('intervention_type に非 mechanical トークンを含まない (コピー・価格は永久に対象外)', () => {
    for (const t of INTERVENTION_TYPES) {
      for (const forbidden of NON_MECHANICAL_TOKENS) {
        expect(t.includes(forbidden)).toBe(false)
      }
    }
  })

  it('全 enum は非空・重複なし', () => {
    const arrays: ReadonlyArray<ReadonlyArray<string>> = [
      INTERVENTION_TYPES,
      PAGE_TYPES,
      INDUSTRIES,
      DEVICES,
      PRIMARY_METRICS,
      EXPERIMENT_WINDOWS,
    ]
    for (const arr of arrays) {
      expect(arr.length).toBeGreaterThan(0)
      expect(new Set(arr).size).toBe(arr.length)
    }
  })

  it('device は unknown を含まない (不明デバイスは横断プール対象外)', () => {
    expect((DEVICES as ReadonlyArray<string>).includes('unknown')).toBe(false)
    expect(DeviceSchema.safeParse('unknown').success).toBe(false)
  })

  it('WINDOW_DAYS は全 window を被覆し正の整数', () => {
    for (const w of EXPERIMENT_WINDOWS) {
      expect(Number.isInteger(WINDOW_DAYS[w])).toBe(true)
      expect(WINDOW_DAYS[w]).toBeGreaterThan(0)
    }
  })
})

describe('experiments/taxonomy — Zod enum guards', () => {
  it('valid を受理、invalid を拒否', () => {
    expect(InterventionTypeSchema.safeParse('cta_placement').success).toBe(true)
    expect(InterventionTypeSchema.safeParse('price_change').success).toBe(false)
    expect(InterventionTypeSchema.safeParse('').success).toBe(false)
  })
})

describe('experiments/taxonomy — cellKey (pooling セル = 4 次元)', () => {
  const dims: CellDimensions = {
    intervention_type: 'cta_placement',
    page_type: 'product',
    industry: 'd2c_ec',
    device: 'mobile',
  }

  it('決定論的・round-trip', () => {
    const key = cellKey(dims)
    expect(key).toBe('cta_placement|product|d2c_ec|mobile')
    expect(parseCellKey(key)).toEqual(dims)
  })

  it('異なる次元タプルは異なる key', () => {
    expect(cellKey(dims)).not.toBe(cellKey({ ...dims, device: 'desktop' }))
  })

  it('不正な key は null', () => {
    expect(parseCellKey('foo|bar')).toBeNull()
    expect(parseCellKey('price|product|d2c_ec|mobile')).toBeNull()
    expect(parseCellKey('cta_placement|product|d2c_ec|unknown')).toBeNull()
  })
})
