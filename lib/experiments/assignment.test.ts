import {
  ARMS,
  assignmentBucket,
  computeArm,
  armToVariantId,
  isValidVisitorId,
  getAssignSalt,
  assignArm,
  AssignSaltMissingError,
  type Arm,
  type ComputeArmParams,
} from '@/lib/experiments/assignment'

const SALT = 'test_salt_v1_0123456789abcdefghijABC' // >= 32 chars, >= 8 distinct, no whitespace
const EXP = '00000000-0000-4000-8000-000000000001'

function base(over: Partial<ComputeArmParams> = {}): ComputeArmParams {
  return { experimentId: EXP, visitorId: 'visitor-1', salt: SALT, saltVersion: 1, ...over }
}

function armsForVisitors(over: Partial<ComputeArmParams>, n: number): Arm[] {
  const out: Arm[] = []
  for (let i = 0; i < n; i++) out.push(computeArm(base({ ...over, visitorId: `visitor-${i}` })))
  return out
}

function fractionDiffer(a: Arm[], b: Arm[]): number {
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  return diff / a.length
}

describe('experiments/assignment — determinism', () => {
  it('同一 (exp, visitor, salt, version) は常に同じ arm', () => {
    const p = base()
    const first = computeArm(p)
    for (let i = 0; i < 20; i++) expect(computeArm(p)).toBe(first)
  })

  it('arm は control / treatment のみ', () => {
    for (let i = 0; i < 100; i++) {
      expect(ARMS).toContain(computeArm(base({ visitorId: `v-${i}` })))
    }
  })

  it('bucket は [0, 10000)', () => {
    for (let i = 0; i < 100; i++) {
      const b = assignmentBucket(base({ visitorId: `v-${i}` }))
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(10_000)
    }
  })
})

describe('experiments/assignment — 50/50 distribution', () => {
  it('1万 visitor で control 比率 ~0.5 (±0.03)', () => {
    const arms = armsForVisitors({}, 10_000)
    const controls = arms.filter((a) => a === 'control').length
    const ratio = controls / arms.length
    expect(ratio).toBeGreaterThan(0.47)
    expect(ratio).toBeLessThan(0.53)
  })

  it('両 arm が出現する', () => {
    const arms = armsForVisitors({}, 500)
    expect(arms).toContain('control')
    expect(arms).toContain('treatment')
  })
})

describe('experiments/assignment — フロント上書き不可 (salt 依存)', () => {
  it('salt が変わると割付ベクタが大きく変わる (salt を知らない client は arm を選べない)', () => {
    const a = armsForVisitors({ salt: SALT }, 1_000)
    const b = armsForVisitors({ salt: 'different-salt-fedcba9876543210' }, 1_000)
    // 独立なら ~50% 変わる。30% を安全な下限に。
    expect(fractionDiffer(a, b)).toBeGreaterThan(0.3)
  })

  it('salt_version ローテーションで再ランダム化', () => {
    const v1 = armsForVisitors({ saltVersion: 1 }, 1_000)
    const v2 = armsForVisitors({ saltVersion: 2 }, 1_000)
    expect(fractionDiffer(v1, v2)).toBeGreaterThan(0.3)
  })

  it('実験ごとに独立 (visitor が全実験で同じ arm に固定されない)', () => {
    const x = armsForVisitors({ experimentId: '00000000-0000-4000-8000-00000000000a' }, 1_000)
    const y = armsForVisitors({ experimentId: '00000000-0000-4000-8000-00000000000b' }, 1_000)
    expect(fractionDiffer(x, y)).toBeGreaterThan(0.3)
  })
})

describe('experiments/assignment — armToVariantId', () => {
  it('control=A / treatment=B', () => {
    expect(armToVariantId('control')).toBe('A')
    expect(armToVariantId('treatment')).toBe('B')
  })
})

describe('experiments/assignment — isValidVisitorId (hygiene)', () => {
  it('正常な ID を受理', () => {
    expect(isValidVisitorId('00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isValidVisitorId('ugk_vid_abc123XYZ')).toBe(true)
  })
  it('空 / 短すぎ / 過長 / 制御文字 / 非文字列を拒否', () => {
    expect(isValidVisitorId('')).toBe(false)
    expect(isValidVisitorId('short')).toBe(false) // < 8
    expect(isValidVisitorId('a'.repeat(129))).toBe(false) // > 128
    expect(isValidVisitorId('bad id with space')).toBe(false)
    expect(isValidVisitorId('inject<script>')).toBe(false)
    expect(isValidVisitorId(null)).toBe(false)
    expect(isValidVisitorId(42)).toBe(false)
  })
})

describe('experiments/assignment — getAssignSalt (fail-closed)', () => {
  const original = process.env.EXPERIMENT_ASSIGN_SALT
  afterEach(() => {
    if (original === undefined) delete process.env.EXPERIMENT_ASSIGN_SALT
    else process.env.EXPERIMENT_ASSIGN_SALT = original
  })

  it('未設定で AssignSaltMissingError', () => {
    delete process.env.EXPERIMENT_ASSIGN_SALT
    expect(() => getAssignSalt()).toThrow(AssignSaltMissingError)
  })

  it('短すぎ (< 32) で throw', () => {
    process.env.EXPERIMENT_ASSIGN_SALT = 'short'
    expect(() => getAssignSalt()).toThrow(AssignSaltMissingError)
  })

  it('低エントロピー (distinct < 8) で throw', () => {
    process.env.EXPERIMENT_ASSIGN_SALT = '0'.repeat(40)
    expect(() => getAssignSalt()).toThrow(AssignSaltMissingError)
  })

  it('前後 whitespace で throw', () => {
    process.env.EXPERIMENT_ASSIGN_SALT = ` ${SALT} `
    expect(() => getAssignSalt()).toThrow(AssignSaltMissingError)
  })

  it('十分な長さ・エントロピーで返す + assignArm が env salt を使う', () => {
    process.env.EXPERIMENT_ASSIGN_SALT = SALT
    expect(getAssignSalt()).toBe(SALT)
    const viaEnv = assignArm(EXP, 'visitor-42', 1)
    const viaPure = computeArm({ experimentId: EXP, visitorId: 'visitor-42', salt: SALT, saltVersion: 1 })
    expect(viaEnv).toBe(viaPure)
  })
})
