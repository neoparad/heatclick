/**
 * Unit tests: scenario-runtime.js の表示位置レスポンシブ解決 (_resolvePosition) 等価実装
 *
 * SP (<=768px) で variant.position_mobile が設定されていればそれを使い、なければ position。
 * desktop は常に position。実関数 (public/scenario-runtime.js _resolvePosition) と lockstep。
 *
 * Usage: node --test tests/unit/scenario-position-resolve.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// mirrors public/scenario-runtime.js _resolvePosition
function resolvePosition(variant, isMobile) {
  if (isMobile && variant && variant.position_mobile) return variant.position_mobile
  return (variant && variant.position) || 'center'
}

test('desktop always uses position (ignores position_mobile)', () => {
  assert.equal(
    resolvePosition({ position: 'bottom-right', position_mobile: 'footer' }, false),
    'bottom-right',
  )
})

test('mobile uses position_mobile when set', () => {
  assert.equal(
    resolvePosition({ position: 'bottom-right', position_mobile: 'footer' }, true),
    'footer',
  )
})

test('mobile falls back to position when position_mobile not set', () => {
  assert.equal(resolvePosition({ position: 'center' }, true), 'center')
})

test('missing position defaults to center', () => {
  assert.equal(resolvePosition({}, false), 'center')
  assert.equal(resolvePosition({}, true), 'center')
  // desktop ignores position_mobile even if position is absent
  assert.equal(resolvePosition({ position_mobile: 'footer' }, false), 'center')
})

test('代表ケース PC=右下 / SP=フッター', () => {
  const v = { position: 'bottom-right', position_mobile: 'footer' }
  assert.equal(resolvePosition(v, false), 'bottom-right')
  assert.equal(resolvePosition(v, true), 'footer')
})

test('empty position_mobile is ignored (falsy → falls back to position)', () => {
  assert.equal(resolvePosition({ position: 'center', position_mobile: '' }, true), 'center')
})
