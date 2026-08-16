/**
 * perf ②a (PSI-confirmed 55ms forced synchronous layout) — regression guard.
 *
 * tracking-ext-image.js (public/v2/tracking-ext-image.js) used to call a fresh
 * img.getBoundingClientRect() for every <img> during its scan/observe loop, forcing
 * a synchronous layout on every page that has this extension installed. The fix moves
 * geometry capture into the IntersectionObserver callback, sourcing it from the
 * entry's own `boundingClientRect` (computed by the browser's async intersection
 * pass) instead of a manual, synchronous read.
 *
 * These tests assert:
 *  1. The scan/observe loop (observeImages) never calls img.getBoundingClientRect().
 *  2. The tracked geometry (image_y / image_width / image_height) is still correctly
 *     derived — now from entry.boundingClientRect + scrollY — so the event payload
 *     shape and values are unchanged from the caller's point of view.
 *
 * Runtime: Node 20+ built-in test runner (node:test), same vm.runInContext sandbox
 * pattern as tests/unit/tracking-tenant-id.test.js (no jsdom dependency).
 * `.mjs` (not `.test.js`) so `npm run test:mjs` (`node --test tests/unit/*.test.mjs`)
 * picks it up and jest's testMatch ([jt]s?(x) only) does not — jest cannot execute
 * node:test-registered tests and fails with "must contain at least one test".
 * Run: `node --test tests/unit/tracking-ext-image.test.mjs`
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'public', 'v2', 'tracking-ext-image.js')
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf-8')

/**
 * Build a minimal browser-like sandbox, register the extension (which triggers its
 * own init()/observeImages() synchronously, mirroring tracking.js's registerExtension),
 * and return handles for driving the mocked IntersectionObserver and inspecting results.
 */
function runExtension({ images, scrollY = 500 } = {}) {
  const trackedEvents = []
  let registeredExt = null

  const CI = {
    registerExtension(ext) {
      registeredExt = ext
      if (ext.init) ext.init()
    },
    track(ev) {
      trackedEvents.push(ev)
    },
    utils: {
      getElementPath: (img) => '/img[' + (img.src || 'unknown') + ']',
    },
  }

  let lastIOInstance = null
  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      this.observedTargets = []
      lastIOInstance = this
    }
    observe(target) {
      this.observedTargets.push(target)
    }
    unobserve() {}
    disconnect() {}
  }

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  const documentMock = {
    body: {},
    querySelectorAll: (sel) => (sel === 'img' ? images : []),
  }

  const windowMock = {
    ClickInsight: CI,
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    scrollY,
    pageYOffset: scrollY,
  }

  const sandbox = {
    window: windowMock,
    document: documentMock,
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    Map,
    Math,
    Date,
    console,
  }

  vm.createContext(sandbox)

  let runtimeError
  try {
    vm.runInContext(SCRIPT_SRC, sandbox, { timeout: 1500 })
  } catch (err) {
    runtimeError = err
  }

  return {
    trackedEvents,
    runtimeError,
    getExt: () => registeredExt,
    getIO: () => lastIOInstance,
  }
}

function makeImg({ src, alt = '', naturalWidth = 0, naturalHeight = 0, throwOnRectRead = false }) {
  let rectCallCount = 0
  const img = {
    src,
    alt,
    naturalWidth,
    naturalHeight,
    getBoundingClientRect() {
      rectCallCount += 1
      if (throwOnRectRead) {
        throw new Error('img.getBoundingClientRect() must not be called during the scan (perf ②a regression)')
      }
      return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }
    },
  }
  Object.defineProperty(img, '_rectCallCount', { get: () => rectCallCount })
  return img
}

test('②a: observeImages() never calls img.getBoundingClientRect() (forced-layout regression guard)', () => {
  const img1 = makeImg({ src: 'https://example.com/a.jpg', naturalWidth: 300, naturalHeight: 200, throwOnRectRead: true })
  const img2 = makeImg({ src: 'https://example.com/b.jpg', naturalWidth: 0, naturalHeight: 0, throwOnRectRead: true })

  const result = runExtension({ images: [img1, img2] })

  assert.equal(result.runtimeError, undefined, `Unexpected runtime error: ${result.runtimeError && result.runtimeError.stack}`)

  const io = result.getIO()
  assert.ok(io, 'IntersectionObserver should have been constructed')
  assert.equal(io.observedTargets.length, 2, 'both images should be observed')
  assert.equal(img1._rectCallCount, 0, 'getBoundingClientRect must not be called on img1 during scan')
  assert.equal(img2._rectCallCount, 0, 'getBoundingClientRect must not be called on img2 during scan')
})

test('②a: geometry is derived from entry.boundingClientRect (async IO pass), not a fresh layout read', () => {
  const img1 = makeImg({ src: 'https://example.com/a.jpg', alt: 'photo a', naturalWidth: 300, naturalHeight: 200 })
  // naturalWidth/Height not yet available (image still loading) -> rect fallback path
  const img2 = makeImg({ src: 'https://example.com/b.jpg', alt: 'photo b', naturalWidth: 0, naturalHeight: 0 })

  const result = runExtension({ images: [img1, img2], scrollY: 500 })
  assert.equal(result.runtimeError, undefined)

  const io = result.getIO()
  const ext = result.getExt()
  assert.ok(ext, 'extension should have registered')

  // Simulate the browser's async intersection-checking pass delivering entries.
  io.callback([
    { target: img1, isIntersecting: true, intersectionRatio: 0.75, boundingClientRect: { top: 120, width: 999, height: 999 } },
    { target: img2, isIntersecting: true, intersectionRatio: 1, boundingClientRect: { top: 40, width: 640, height: 360 } },
  ])

  const data1 = ext.tracked.get(img1)
  const data2 = ext.tracked.get(img2)

  assert.equal(data1.geometrySet, true)
  assert.equal(data1.y, 120 + 500, 'image_y = entry.boundingClientRect.top + scrollY')
  assert.equal(data1.width, 300, 'naturalWidth takes precedence over boundingClientRect.width when available')
  assert.equal(data1.height, 200)

  assert.equal(data2.geometrySet, true)
  assert.equal(data2.y, 40 + 500)
  assert.equal(data2.width, 640, 'falls back to boundingClientRect.width when naturalWidth is unavailable')
  assert.equal(data2.height, 360)

  // Backdate startTime instead of sleeping, to accumulate >= 100ms visible duration.
  data1.startTime = Date.now() - 500
  data2.startTime = Date.now() - 250

  ext.flush()

  assert.equal(result.trackedEvents.length, 2)
  const ev1 = result.trackedEvents.find((e) => e.image_src === 'https://example.com/a.jpg')
  const ev2 = result.trackedEvents.find((e) => e.image_src === 'https://example.com/b.jpg')

  assert.ok(ev1 && ev2, 'both events should be present')
  assert.equal(ev1.event_type, 'image_visibility')
  assert.equal(ev1.image_y, 620)
  assert.equal(ev1.image_width, 300)
  assert.equal(ev1.image_height, 200)
  assert.equal(ev1.max_visible_ratio, 0.75)
  assert.ok(ev1.visible_duration_ms >= 500)

  assert.equal(ev2.image_y, 540)
  assert.equal(ev2.image_width, 640)
  assert.equal(ev2.image_height, 360)

  // Final confirmation: the whole run, including flush, never touched getBoundingClientRect.
  assert.equal(img1._rectCallCount, 0)
  assert.equal(img2._rectCallCount, 0)
})
