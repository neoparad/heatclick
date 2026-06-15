/**
 * Unit tests for lib/auth/dogfood-users SEED — 続 72 (Frontend B-2 fix)
 *
 * 背景: Owner 動作テスト (2026-05-23 22:50) で AIチャットが
 *   `[TENANT_FORBIDDEN] site not in tenant` で動作不能。
 *   原因: SEED の site_ids が fake (`site_linkth_main`, `site_bihada_demo`) で
 *   実 ClickHouse sites table の tracking_id (CIP_xxxx) と mismatch。
 *
 * 続 72 fix:
 *   tenant_id = 'linkth_internal' (続 25 §4952 Phase 1 内部 dogfood 運用)
 *   site_ids = 続 39 で確定済の Phase 1 5 sites (CIP_xxxx)
 *
 * Strategy: CI 環境互換のため source-level 検査 (regex / 文字列含有) を採用。
 *           動的 `.ts` import は Node 22.6+ の experimental TS 機能依存で fragile。
 *           middleware-classify.test.mjs と同じ等価実装パターン。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/dogfood-users-seed.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SOURCE_PATH = resolve(__dirname, '../../lib/auth/dogfood-users.ts')
const source = readFileSync(SOURCE_PATH, 'utf8')

// 続 39 で確定済の Phase 1 dogfood 実 site_id (CIP_xxxx) 5 件。
const EXPECTED_TENANT = 'linkth_internal'
const EXPECTED_SITE_IDS = [
  'CIP_EcwUTHEZdIOAUqum',
  'CIP_xginf3nVacnkn62o',
  'CIP_6r2WofQDSKrOwxmM',
  'CIP_8eN7xgfBtDAnzE26',
  'CIP_QWaPiks5krukJ6NM',
]

// 旧 (続 14 配備〜続 71) の fake 値 — regression 検知用。
const FORBIDDEN_TENANT = 'tnt_linkth'
const FORBIDDEN_SITE_IDS = ['site_linkth_main', 'site_bihada_demo']

const OWNER_EMAILS = ['hiroki@linkth.com', 'hiroki101313@gmail.com']

test('SEED source contains real tenant_id="linkth_internal" (続 72 B-2 fix)', () => {
  assert.ok(
    source.includes(`'${EXPECTED_TENANT}'`) || source.includes(`"${EXPECTED_TENANT}"`),
    `dogfood-users.ts must reference tenant_id '${EXPECTED_TENANT}' (続 25 §4952)`,
  )
})

test('SEED source contains all 5 real CIP_ site_ids (続 72 B-2 fix)', () => {
  for (const sid of EXPECTED_SITE_IDS) {
    assert.ok(
      source.includes(sid),
      `dogfood-users.ts must reference real site_id '${sid}' (続 39 Phase 1)`,
    )
  }
})

/** SEED 配列本体 (const SEED: DogfoodUser[] = [ ... ]) を抜き出す。 */
function extractSeedBlock(src) {
  const idx = src.indexOf('const SEED')
  assert.ok(idx >= 0, 'const SEED declaration must exist')
  // 簡易 brace 解析: [ で始まり対応する ] を返す
  const openIdx = src.indexOf('[', idx)
  assert.ok(openIdx > idx, 'SEED must be initialized with [')
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  throw new Error('SEED array brace mismatch')
}

test('SEED block does NOT contain old fake tenant_id (regression 防止)', () => {
  const seedBlock = extractSeedBlock(source)
  assert.ok(
    !seedBlock.includes(`'${FORBIDDEN_TENANT}'`) &&
      !seedBlock.includes(`"${FORBIDDEN_TENANT}"`),
    `SEED block must not reference old fake tenant '${FORBIDDEN_TENANT}' (続 72 fix)`,
  )
})

test('SEED block does NOT contain old fake site_ids (regression 防止)', () => {
  const seedBlock = extractSeedBlock(source)
  for (const fake of FORBIDDEN_SITE_IDS) {
    assert.ok(
      !seedBlock.includes(`'${fake}'`) && !seedBlock.includes(`"${fake}"`),
      `SEED block must not reference old fake site_id '${fake}' (続 72 fix)`,
    )
  }
})

test('SEED source contains both owner emails (続 72 B-2 contract)', () => {
  for (const email of OWNER_EMAILS) {
    assert.ok(
      source.includes(`'${email}'`) || source.includes(`"${email}"`),
      `dogfood-users.ts must contain owner email '${email}'`,
    )
  }
})

test('SEED source declares enterprise/agency plan for owners', () => {
  // 'enterprise' or 'agency' literal が SEED block 内に存在
  assert.ok(
    source.includes(`plan: 'enterprise'`) ||
      source.includes(`plan: "enterprise"`) ||
      source.includes(`plan: 'agency'`) ||
      source.includes(`plan: "agency"`),
    'SEED must use enterprise or agency plan for owners (proof + agency 双方アクセス)',
  )
})

test('SEED defines exactly 5 site_ids via shared constant', () => {
  // 続 72 fix で LINKTH_INTERNAL_SITE_IDS readonly array を導入
  // (重複定義を避けるため)
  const constMatch = source.match(/LINKTH_INTERNAL_SITE_IDS[^=]*=\s*\[([^\]]+)\]/)
  assert.ok(constMatch, 'LINKTH_INTERNAL_SITE_IDS constant must be defined')
  const cipMatches = constMatch[1].match(/CIP_[A-Za-z0-9]+/g) ?? []
  assert.equal(
    cipMatches.length,
    EXPECTED_SITE_IDS.length,
    `LINKTH_INTERNAL_SITE_IDS must contain exactly ${EXPECTED_SITE_IDS.length} CIP_ ids, got ${cipMatches.length}`,
  )
  for (const sid of EXPECTED_SITE_IDS) {
    assert.ok(
      cipMatches.includes(sid),
      `LINKTH_INTERNAL_SITE_IDS must include '${sid}'`,
    )
  }
})
