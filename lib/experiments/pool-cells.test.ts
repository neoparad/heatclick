import { toDisclosablePoolSummary, type PoolCellRow } from '@/lib/experiments/pool-cells'

function row(over: Partial<PoolCellRow> = {}): PoolCellRow {
  return { k_sites: 60, ci_low: 0.05, ci_high: 0.3, meets_k50: true, ...over }
}

describe('experiments/pool-cells — toDisclosablePoolSummary (開示ゲート)', () => {
  it('meets_k50 かつ valid → summary を返す', () => {
    const s = toDisclosablePoolSummary(row())
    expect(s).toEqual({ k_sites: 60, ci_low: 0.05, ci_high: 0.3, meets_k50: true })
  })

  it('行なし → null', () => {
    expect(toDisclosablePoolSummary(null)).toBeNull()
    expect(toDisclosablePoolSummary(undefined)).toBeNull()
  })

  it('meets_k50=false (24≤K<50 の corpus 行) は顧客に開示しない → null', () => {
    expect(toDisclosablePoolSummary(row({ k_sites: 30, meets_k50: false }))).toBeNull()
  })

  it('フラグ詐称 (meets_k50=true だが k_sites<50) → null (fail-closed)', () => {
    expect(toDisclosablePoolSummary(row({ k_sites: 30, meets_k50: true }))).toBeNull()
  })

  it('CI 欠損 / NaN / 反転 / 空文字 → null (fail-closed)', () => {
    expect(toDisclosablePoolSummary(row({ ci_low: null }))).toBeNull()
    expect(toDisclosablePoolSummary(row({ ci_high: 'not-a-number' }))).toBeNull()
    expect(toDisclosablePoolSummary(row({ ci_low: 0.5, ci_high: 0.1 }))).toBeNull()
    expect(toDisclosablePoolSummary(row({ ci_low: '' }))).toBeNull() // Number('')=0 化け防止
    expect(toDisclosablePoolSummary(row({ ci_high: '   ' }))).toBeNull()
  })

  it('DB の string 数値 (DOUBLE PRECISION が文字列で返る) は数値化して受理', () => {
    const s = toDisclosablePoolSummary(row({ ci_low: '0.05', ci_high: '0.30' }))
    expect(s).toEqual({ k_sites: 60, ci_low: 0.05, ci_high: 0.3, meets_k50: true })
  })
})
