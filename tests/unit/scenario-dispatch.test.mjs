/**
 * Unit tests: public/scenario-runtime.js の dispatch 判定 + measure_only 計測挙動
 *
 * 実ファイルを node:vm で最小ブラウザ stub 上にロードし、window.UGOKI_SCENARIO_RUNTIME
 * 経由で内部関数を検証する (ミラー再実装ではなく「実コード」を回す)。
 *
 * 背景 (B): 従来 evaluateAll は `if (sc.status !== 'live') continue` で measure_only を
 * 素通りしており、§1.7.1 の「実行せず計測」パスが計測ゼロだった。本テストは
 * measure_only が「match イベントは送るが DOM 描画しない」ことを固定する。
 *
 * Usage: node --test tests/unit/scenario-dispatch.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '..', '..', 'public', 'scenario-runtime.js'), 'utf8')

function mapStorage(seed = {}) {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

function fakeEl(tag) {
  return {
    tagName: tag,
    style: {},
    setAttribute() {},
    appendChild() {},
    insertBefore() {},
    addEventListener() {},
    removeChild() {},
    parentNode: null,
  }
}

/** 実ファイルを fresh な vm context にロードし、debug API + capture hooks を返す。 */
function setup({ sessionSeed = { ci_sid: 'sess1' }, cookie = '__ugk_vid=vis123' } = {}) {
  const createdTags = []
  const beacons = []
  const sessionStore = mapStorage(sessionSeed)
  const localStore = mapStorage()

  const documentStub = {
    currentScript: null,
    readyState: 'complete',
    cookie,
    referrer: '',
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tag) => {
      createdTags.push(tag)
      return fakeEl(tag)
    },
    addEventListener() {},
    body: { appendChild() {}, firstChild: null },
    head: { appendChild() {} },
  }
  const windowStub = {
    location: { pathname: '/entry/x', search: '', href: 'https://shop.example/entry/x' },
    localStorage: localStore,
    sessionStorage: sessionStore,
    addEventListener() {},
    CLICKINSIGHT_SITE_ID: 'CIP_test',
    CLICKINSIGHT_TENANT_ID: 'tenant_test',
    UGOKI_SCENARIO_DISABLE_AUTOINIT: true,
  }
  const navigatorStub = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    language: 'ja-JP',
    sendBeacon: (url, blob) => {
      beacons.push({ url, payload: JSON.parse(blob._payload), type: blob._type })
      return true
    },
  }
  class FakeBlob {
    constructor(parts, opts) {
      this._payload = parts.join('')
      this._type = opts && opts.type
    }
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: navigatorStub,
    sessionStorage: sessionStore,
    localStorage: localStore,
    console,
    URL,
    Blob: FakeBlob,
  }
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox)
  return { runtime: windowStub.UGOKI_SCENARIO_RUNTIME, createdTags, beacons }
}

const scenario = (status) => ({
  id: 'sc-1',
  status,
  condition_ast: { op: 'EXISTS', field: 'session_id' },
  variants: [
    {
      id: 'A',
      content_type: 'image',
      image_url: 'https://cdn.example.com/a.png',
      image_alt: '',
      position: 'center',
      traffic_split: 100,
    },
  ],
})

// ── _dispatchDecision policy ────────────────────────────────────────────────
// NOTE: _dispatch が返すオブジェクトは vm realm 由来で Object.prototype が異なるため
// deepStrictEqual は使えない。フィールド単位で比較する。
test('_dispatch: live = measure + render', () => {
  const { runtime } = setup()
  const d = runtime._dispatch('live')
  assert.equal(d.measure, true)
  assert.equal(d.render, true)
})

test('_dispatch: measure_only = measure, NO render', () => {
  const { runtime } = setup()
  const d = runtime._dispatch('measure_only')
  assert.equal(d.measure, true)
  assert.equal(d.render, false)
})

test('_dispatch: draft / paused / archived / preview = neither', () => {
  const { runtime } = setup()
  for (const s of ['draft', 'paused', 'archived', 'preview']) {
    const d = runtime._dispatch(s)
    assert.equal(d.measure, false, `${s}.measure`)
    assert.equal(d.render, false, `${s}.render`)
  }
})

// ── evaluateAll integration (real file via vm) ──────────────────────────────
test('evaluateAll: measure_only sends a match event but does NOT render', () => {
  const { runtime, createdTags, beacons } = setup()
  runtime.evaluateAll([scenario('measure_only')])

  const match = beacons.find((b) => b.payload.match_type === 'match')
  assert.ok(match, 'expected a match beacon for measure_only')
  assert.equal(match.payload.dispatch_path, 'measure_only')
  // 描画しない: impression は出ず、DOM 要素も一切生成されない
  assert.equal(beacons.some((b) => b.payload.match_type === 'impression'), false)
  assert.equal(createdTags.length, 0, 'measure_only must not create any DOM node')
})

test('evaluateAll: live sends match + impression and renders DOM', () => {
  const { runtime, createdTags, beacons } = setup()
  runtime.evaluateAll([scenario('live')])

  assert.ok(
    beacons.some((b) => b.payload.match_type === 'match' && b.payload.dispatch_path === 'live'),
    'expected a live match beacon',
  )
  assert.ok(
    beacons.some((b) => b.payload.match_type === 'impression'),
    'live should emit an impression on render',
  )
  assert.ok(createdTags.length > 0, 'live must create DOM nodes (render)')
})

test('evaluateAll: draft is neither measured nor rendered', () => {
  const { runtime, createdTags, beacons } = setup()
  runtime.evaluateAll([scenario('draft')])
  assert.equal(beacons.length, 0)
  assert.equal(createdTags.length, 0)
})

test('scenario_match beacon uses a text/plain Blob (CORS simple request, no preflight)', () => {
  // cross-origin の event-ingest worker は ACAO:* のため、application/json (non-simple) だと
  // credentialed sendBeacon で preflight が blocked になる。tracking.js と同じ text/plain で送る。
  const { runtime, beacons } = setup()
  runtime.evaluateAll([scenario('live')])
  const match = beacons.find((b) => b.payload.match_type === 'match')
  assert.ok(match, 'expected a match beacon')
  assert.equal(match.type, 'text/plain')
})
