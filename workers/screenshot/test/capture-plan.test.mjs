/**
 * Unit tests: workers/screenshot/src/capture-plan.ts (実ファイルを直接 import)
 *
 * 背景 (2026-09-29): ヒートマップ背景画像が粗い問題への対処として SP を deviceScaleFactor=2 で撮る。
 * 面積上限 (MAX_CAPTURE_AREA_PX) は「画像ピクセル面積」で効くので、倍率を上げると CSS 高さの上限が
 * 1/倍率² に縮む。縦長ページで上限が縮んで「上部のみ画像」が増えないよう、
 * 倍率を上げてよいのは「倍率込みの面積が MAX_SHARP_AREA_PX 以内」のページだけにし、
 * それ以外は従来どおり倍率 1 に自動で戻す。
 *
 * Usage:
 *   cd workers/screenshot
 *   node --test test/capture-plan.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CAPTURE_AREA_PX,
  MAX_SHARP_AREA_PX,
  planCapture,
} from '../src/capture-plan.ts'

test('constants keep the pre-existing area cap and add a stricter sharp budget', () => {
  assert.equal(MAX_CAPTURE_AREA_PX, 26_000_000)
  assert.ok(MAX_SHARP_AREA_PX < MAX_CAPTURE_AREA_PX)
})

test('SP short page: keeps the requested 2x, not capped', () => {
  const p = planCapture({ width: 390, requestedDsf: 2, fullHeight: 5_000 })
  assert.deepEqual(p, { dsf: 2, capHeight: 5_000, capped: false })
})

test('SP page right at the sharp budget still gets 2x', () => {
  // 390 * 10_000 * 4 = 15.6M <= MAX_SHARP_AREA_PX
  const p = planCapture({ width: 390, requestedDsf: 2, fullHeight: 10_000 })
  assert.equal(p.dsf, 2)
  assert.equal(p.capped, false)
})

test('SP tall page: falls back to 1x and is NOT clipped (no regression vs before)', () => {
  // 390 * 12_000 * 4 = 18.7M > MAX_SHARP_AREA_PX → 1x。1x の面積は 4.68M で上限内。
  const p = planCapture({ width: 390, requestedDsf: 2, fullHeight: 12_000 })
  assert.deepEqual(p, { dsf: 1, capHeight: 12_000, capped: false })
})

test('SP very tall page: 1x and clipped at the original CSS cap (26M / width)', () => {
  const p = planCapture({ width: 390, requestedDsf: 2, fullHeight: 100_000 })
  assert.equal(p.dsf, 1)
  assert.equal(p.capHeight, Math.floor(26_000_000 / 390))
  assert.equal(p.capped, true)
})

test('PC at 1x behaves exactly like the old logic (capHeight = floor(26M / 1280))', () => {
  const short = planCapture({ width: 1280, requestedDsf: 1, fullHeight: 4_000 })
  assert.deepEqual(short, { dsf: 1, capHeight: 4_000, capped: false })
  const tall = planCapture({ width: 1280, requestedDsf: 1, fullHeight: 50_000 })
  assert.deepEqual(tall, { dsf: 1, capHeight: Math.floor(26_000_000 / 1280), capped: true })
})

test('requestedDsf=1 never raises the scale', () => {
  const p = planCapture({ width: 390, requestedDsf: 1, fullHeight: 2_000 })
  assert.equal(p.dsf, 1)
})

test('a 2x request is honoured for a clipped result only when the whole 2x area fits', () => {
  // 幅が大きいと 2x の予算に収まる高さが小さい: 1280 * 3_000 * 4 = 15.36M (収まる) / 1280 * 5_000 * 4 = 25.6M (収まらない)
  assert.equal(planCapture({ width: 1280, requestedDsf: 2, fullHeight: 3_000 }).dsf, 2)
  assert.equal(planCapture({ width: 1280, requestedDsf: 2, fullHeight: 5_000 }).dsf, 1)
})

test('non-finite / non-positive fullHeight degrades to 1x without throwing or NaN', () => {
  for (const fullHeight of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    const p = planCapture({ width: 390, requestedDsf: 2, fullHeight })
    assert.equal(p.dsf, 1)
    assert.ok(Number.isFinite(p.capHeight) && p.capHeight >= 0)
  }
})
