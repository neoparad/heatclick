/**
 * Unit tests: resolveAppUrl — magic-link verify URL 等の絶対 base URL 解決
 *
 * 続 117 root-fix (本番 magic-link が localhost を指す login bug) の regression guard。
 * 親 SSOT §3.6.1 / Part V §5.5.1 P-01
 */

import { resolveAppUrl, isTrustedHost, resolveRequestOrigin } from './app-url'

const ENV_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'VERCEL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_URL',
  'NODE_ENV',
] as const

describe('resolveAppUrl', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k]
    for (const k of ENV_KEYS) delete process.env[k]
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k]
      else process.env[k] = original[k]
    }
  })

  it('1. NEXT_PUBLIC_APP_URL が最優先 (末尾スラッシュ除去)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/'
    expect(resolveAppUrl()).toBe('https://app.example.com')
  })

  it('2. NEXT_PUBLIC_APP_URL 未設定なら VERCEL_PROJECT_PRODUCTION_URL を https で使う', () => {
    process.env.VERCEL = '1'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ugokimap.com'
    expect(resolveAppUrl()).toBe('https://ugokimap.com')
  })

  it('3. production URL 無し + VERCEL_URL あり → preview デプロイ URL を https で使う', () => {
    process.env.VERCEL = '1'
    process.env.VERCEL_URL = 'my-app-git-feature.vercel.app'
    expect(resolveAppUrl()).toBe('https://my-app-git-feature.vercel.app')
  })

  it('4. Vercel 上で NEXT_PUBLIC_APP_URL が localhost の設定ミス → 無視して正規ドメインへ', () => {
    process.env.VERCEL = '1'
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ugokimap.com'
    expect(resolveAppUrl()).toBe('https://ugokimap.com')
  })

  it('4b. Vercel 上で localhost 設定ミス + 正規ドメイン無し → ugokimap.com に fallback', () => {
    process.env.VERCEL = '1'
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3000'
    expect(resolveAppUrl()).toBe('https://ugokimap.com')
  })

  it('5. 非 Vercel + NODE_ENV=production → ugokimap.com', () => {
    process.env.NODE_ENV = 'production'
    expect(resolveAppUrl()).toBe('https://ugokimap.com')
  })

  it('6. ローカル開発 (env 何も無し) → localhost:3000', () => {
    expect(resolveAppUrl()).toBe('http://localhost:3000')
  })

  it('7. ローカル開発で NEXT_PUBLIC_APP_URL=localhost は尊重する (Vercel 外なので許可)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3001'
    expect(resolveAppUrl()).toBe('http://localhost:3001')
  })

  it('8. 解決結果から magic-link verify URL を組み立てると正規ドメインを指す', () => {
    process.env.VERCEL = '1'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ugokimap.com'
    const verifyUrl = new URL('/api/auth/verify', resolveAppUrl())
    verifyUrl.searchParams.set('token', 'abc')
    expect(verifyUrl.toString()).toBe('https://ugokimap.com/api/auth/verify?token=abc')
  })
})

describe('isTrustedHost', () => {
  const PRESERVED = ['NODE_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of PRESERVED) saved[k] = process.env[k]
    // env 由来の Vercel host 信頼をテスト間で漏らさないよう既定で消す
    delete (process.env as Record<string, string | undefined>).VERCEL_URL
    delete (process.env as Record<string, string | undefined>).VERCEL_PROJECT_PRODUCTION_URL
  })

  afterEach(() => {
    for (const k of PRESERVED) {
      if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k]
      else process.env[k] = saved[k]
    }
  })

  it('ugokimap.com (apex) を信頼', () => {
    expect(isTrustedHost('ugokimap.com')).toBe(true)
  })
  it('www.ugokimap.com / sub.ugokimap.com を信頼', () => {
    expect(isTrustedHost('www.ugokimap.com')).toBe(true)
    expect(isTrustedHost('app.ugokimap.com')).toBe(true)
  })
  it('ugokimap-saas.vercel.app (本番 alias) を信頼', () => {
    expect(isTrustedHost('ugokimap-saas.vercel.app')).toBe(true)
  })
  it('preview host は VERCEL_URL env と exact 一致した場合のみ信頼 (glob 廃止)', () => {
    // env 未設定では preview host を信頼しない
    expect(isTrustedHost('ugokimap-saas-git-x.vercel.app')).toBe(false)
    // VERCEL_URL に一致すれば信頼 (Vercel が当デプロイに権威的に設定する host)
    process.env.VERCEL_URL = 'ugokimap-saas-git-x.vercel.app'
    expect(isTrustedHost('ugokimap-saas-git-x.vercel.app')).toBe(true)
  })
  it('VERCEL_PROJECT_PRODUCTION_URL env を信頼', () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ugokimap.com'
    expect(isTrustedHost('ugokimap.com')).toBe(true)
  })
  it('VERCEL_URL に scheme / slash / 大文字が混ざっても正規化して一致 (env 正規化 nit fix)', () => {
    process.env.VERCEL_URL = 'https://Ugokimap-Saas-Deploy.vercel.app/'
    expect(isTrustedHost('ugokimap-saas-deploy.vercel.app')).toBe(true)
  })
  it('ugokimap-saas-<attacker>.vercel.app は拒否 (Codex CRITICAL: prefix glob 廃止)', () => {
    // 攻撃者が ugokimap-saas-attacker という Vercel project を作って取得できる host。
    // env と一致しないため信用しない。
    expect(isTrustedHost('ugokimap-saas-attacker.vercel.app')).toBe(false)
    expect(isTrustedHost('ugokimap-saas-.vercel.app')).toBe(false)
  })
  it('信頼 host への明示 port は拒否 (Codex MEDIUM: origin すり替え防止)', () => {
    expect(isTrustedHost('ugokimap.com:8443')).toBe(false)
    expect(isTrustedHost('ugokimap-saas.vercel.app:8443')).toBe(false)
    expect(isTrustedHost('www.ugokimap.com:1234')).toBe(false)
  })
  it('攻撃者ドメインは拒否 (Host injection 対策)', () => {
    expect(isTrustedHost('attacker.com')).toBe(false)
    expect(isTrustedHost('ugokimap.com.attacker.com')).toBe(false)
    expect(isTrustedHost('evil-vercel.app.attacker.com')).toBe(false)
    expect(isTrustedHost(null)).toBe(false)
    expect(isTrustedHost('')).toBe(false)
  })
  it('自社プロジェクト以外の vercel.app は拒否 (slug 厳格化)', () => {
    expect(isTrustedHost('evil.vercel.app')).toBe(false)
    expect(isTrustedHost('ugokimap.vercel.app')).toBe(false) // saas slug でない
    expect(isTrustedHost('ugokimap-saas-evil.attacker.app')).toBe(false)
    expect(isTrustedHost('notugokimap-saas.vercel.app')).toBe(false)
  })
  it('fragment / path / query 注入は拒否 (Codex CRITICAL: endsWith すり抜け防止)', () => {
    // new URL は host を attacker.com、残りを fragment/path/query と解釈するため
    // 素朴な endsWith(".ugokimap.com") をすり抜ける。これを WHATWG parse で reject する。
    expect(isTrustedHost('attacker.com#.ugokimap.com')).toBe(false)
    expect(isTrustedHost('attacker.com/.ugokimap.com')).toBe(false)
    expect(isTrustedHost('attacker.com?.ugokimap.com')).toBe(false)
    expect(isTrustedHost('attacker.com#.ugokimap-saas.vercel.app')).toBe(false)
    // userinfo 注入 (user@host) も reject
    expect(isTrustedHost('ugokimap.com@attacker.com')).toBe(false)
  })
  it('localhost は本番では拒否、非本番では許可', () => {
    process.env.NODE_ENV = 'production'
    expect(isTrustedHost('localhost:3000')).toBe(false)
    process.env.NODE_ENV = 'development'
    expect(isTrustedHost('localhost:3000')).toBe(true)
    expect(isTrustedHost('127.0.0.1:3000')).toBe(true)
  })
})

describe('resolveRequestOrigin', () => {
  function req(headers: Record<string, string>): { headers: Headers } {
    return { headers: new Headers(headers) }
  }

  it('信頼 host (vercel.app) → そのままその host の origin を返す (login host = 閲覧 host)', () => {
    const origin = resolveRequestOrigin(
      req({ host: 'ugokimap-saas.vercel.app', 'x-forwarded-proto': 'https' }),
    )
    expect(origin).toBe('https://ugokimap-saas.vercel.app')
  })

  it('信頼 host (custom domain) を尊重', () => {
    const origin = resolveRequestOrigin(req({ host: 'ugokimap.com', 'x-forwarded-proto': 'https' }))
    expect(origin).toBe('https://ugokimap.com')
  })

  it('host を x-forwarded-host より優先 (host は Vercel が権威的に設定)', () => {
    // 両方信頼できる場合は host を採用する (Codex MEDIUM fix: x-forwarded-host は
    // proxy 経由で偽装余地があるため、Vercel が設定する host を一次ソースにする)。
    const origin = resolveRequestOrigin(
      req({
        host: 'ugokimap-saas.vercel.app',
        'x-forwarded-host': 'www.ugokimap.com',
        'x-forwarded-proto': 'https',
      }),
    )
    expect(origin).toBe('https://ugokimap-saas.vercel.app')
  })

  it('host が信頼できない場合のみ x-forwarded-host にフォールバック', () => {
    const origin = resolveRequestOrigin(
      req({ host: 'internal.vercel.app', 'x-forwarded-host': 'www.ugokimap.com', 'x-forwarded-proto': 'https' }),
    )
    expect(origin).toBe('https://www.ugokimap.com')
  })

  it('x-forwarded-proto がカンマ区切りでも先頭を採用 (非本番)', () => {
    const savedEnv = process.env.NODE_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    try {
      const origin = resolveRequestOrigin(
        req({ host: 'localhost:3000', 'x-forwarded-proto': 'https,http' }),
      )
      expect(origin).toBe('https://localhost:3000')
    } finally {
      if (savedEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV
      else process.env.NODE_ENV = savedEnv
    }
  })

  it('本番では x-forwarded-proto=http 注入を無視して https を強制 (Codex HIGH fix)', () => {
    const savedEnv = process.env.NODE_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    try {
      const origin = resolveRequestOrigin(
        req({ host: 'ugokimap.com', 'x-forwarded-proto': 'http' }),
      )
      expect(origin).toBe('https://ugokimap.com')
    } finally {
      if (savedEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV
      else process.env.NODE_ENV = savedEnv
    }
  })

  it('信頼できない host (Host injection) → canonical へフォールバック (token 流出防止)', () => {
    const saved = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = 'https://ugokimap.com'
    try {
      const origin = resolveRequestOrigin(req({ host: 'attacker.com', 'x-forwarded-proto': 'https' }))
      expect(origin).toBe('https://ugokimap.com')
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL
      else process.env.NEXT_PUBLIC_APP_URL = saved
    }
  })

  it('host header 欠落 → canonical へフォールバック', () => {
    const saved = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = 'https://ugokimap.com'
    try {
      expect(resolveRequestOrigin(req({}))).toBe('https://ugokimap.com')
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL
      else process.env.NEXT_PUBLIC_APP_URL = saved
    }
  })
})
