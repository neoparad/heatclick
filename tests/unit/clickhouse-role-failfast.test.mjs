/**
 * Unit tests: lib/clickhouse.ts production fail-fast for role-based credentials (続 70 補強)
 *
 * Strategy: production (NODE_ENV=production) で CLICKHOUSE_RO_PASSWORD / CLICKHOUSE_WRITER_PASSWORD
 *           不在の場合に throw する挙動を、resolveCredentials 等価実装で契約担保。
 *
 * Usage:
 *   node --test tests/unit/clickhouse-role-failfast.test.mjs
 *
 * 検証対象 (続 70 強化、続 67 D-3 配備済前提):
 *   - production + role 専用 password 不在 → throw (Infra 続 67 D-3 投入忘れ防御)
 *   - production + role 専用 password 設定済 → 正常 (role 別 credentials 返却)
 *   - non-production (dev/test) + role 専用 password 不在 → default fallback (warn 許容)
 *   - error message に password 値を含めない (env 名のみ)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── 等価実装 (lib/clickhouse.ts:resolveCredentials 同一仕様、続 70 fail-fast 強化版) ──

function requireRoleCredentialOrThrow(envName, role) {
  throw new Error(
    `[clickhouse] ${envName} is required in production for role='${role}' ` +
      `(Infra 続 67 D-3 配備済前提、続 70 fail-fast 強化)。Vercel env で投入してください。`,
  )
}

function resolveCredentials(role, env) {
  const defaultUser = env.CLICKHOUSE_USERNAME ?? 'default'
  const defaultPwd = env.CLICKHOUSE_PASSWORD ?? ''
  const isProd = env.NODE_ENV === 'production'

  switch (role) {
    case 'analytics_reader': {
      const user = env.CLICKHOUSE_RO_USERNAME ?? 'analytics_reader'
      const pwd = env.CLICKHOUSE_RO_PASSWORD
      if (!pwd) {
        if (isProd) requireRoleCredentialOrThrow('CLICKHOUSE_RO_PASSWORD', 'analytics_reader')
        return { username: defaultUser, password: defaultPwd }
      }
      return { username: user, password: pwd }
    }
    case 'chat_writer': {
      const user = env.CLICKHOUSE_WRITER_USERNAME ?? 'chat_writer'
      const pwd = env.CLICKHOUSE_WRITER_PASSWORD
      if (!pwd) {
        if (isProd) requireRoleCredentialOrThrow('CLICKHOUSE_WRITER_PASSWORD', 'chat_writer')
        return { username: defaultUser, password: defaultPwd }
      }
      return { username: user, password: pwd }
    }
    case 'default':
    default:
      return { username: defaultUser, password: defaultPwd }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

test('prod-1: production + analytics_reader + CLICKHOUSE_RO_PASSWORD 不在 → THROW', () => {
  assert.throws(
    () =>
      resolveCredentials('analytics_reader', {
        NODE_ENV: 'production',
        CLICKHOUSE_USERNAME: 'default',
        CLICKHOUSE_PASSWORD: 'fallback',
      }),
    (err) => /CLICKHOUSE_RO_PASSWORD.*required in production/.test(err.message),
  )
})

test('prod-2: production + chat_writer + CLICKHOUSE_WRITER_PASSWORD 不在 → THROW', () => {
  assert.throws(
    () =>
      resolveCredentials('chat_writer', {
        NODE_ENV: 'production',
        CLICKHOUSE_USERNAME: 'default',
        CLICKHOUSE_PASSWORD: 'fallback',
      }),
    (err) => /CLICKHOUSE_WRITER_PASSWORD.*required in production/.test(err.message),
  )
})

test('prod-3: production + 両 role password 設定済 → 正常', () => {
  const r1 = resolveCredentials('analytics_reader', {
    NODE_ENV: 'production',
    CLICKHOUSE_RO_USERNAME: 'analytics_reader',
    CLICKHOUSE_RO_PASSWORD: 'ro_pwd_xxx',
  })
  assert.equal(r1.username, 'analytics_reader')
  assert.equal(r1.password, 'ro_pwd_xxx')

  const r2 = resolveCredentials('chat_writer', {
    NODE_ENV: 'production',
    CLICKHOUSE_WRITER_USERNAME: 'chat_writer',
    CLICKHOUSE_WRITER_PASSWORD: 'w_pwd_xxx',
  })
  assert.equal(r2.username, 'chat_writer')
  assert.equal(r2.password, 'w_pwd_xxx')
})

test('prod-4: production + default role は env なしでも throw しない (既存挙動維持)', () => {
  const r = resolveCredentials('default', {
    NODE_ENV: 'production',
    CLICKHOUSE_USERNAME: 'default',
    CLICKHOUSE_PASSWORD: 'main',
  })
  assert.equal(r.username, 'default')
  assert.equal(r.password, 'main')
})

test('dev-1: development + role password 不在 → default fallback (throw しない)', () => {
  const r = resolveCredentials('analytics_reader', {
    NODE_ENV: 'development',
    CLICKHOUSE_USERNAME: 'dev_user',
    CLICKHOUSE_PASSWORD: 'dev_pwd',
  })
  assert.equal(r.username, 'dev_user')
  assert.equal(r.password, 'dev_pwd')
})

test('dev-2: NODE_ENV 未設定 (test 環境) + role password 不在 → default fallback', () => {
  const r = resolveCredentials('chat_writer', {
    CLICKHOUSE_USERNAME: 'test_user',
    CLICKHOUSE_PASSWORD: 'test_pwd',
  })
  assert.equal(r.username, 'test_user')
  assert.equal(r.password, 'test_pwd')
})

test('safe-1: error message に password 値を含めない (env 名のみ)', () => {
  try {
    resolveCredentials('analytics_reader', { NODE_ENV: 'production' })
    assert.fail('should have thrown')
  } catch (err) {
    // password 値ライク文字列は含まれない (env 名と role 名のみ)
    assert.match(err.message, /CLICKHOUSE_RO_PASSWORD/)
    assert.match(err.message, /analytics_reader/)
    assert.doesNotMatch(err.message, /password=/i)
    assert.doesNotMatch(err.message, /secret/i)
  }
})
