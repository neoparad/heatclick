/**
 * perf ②b (same class as ②a: forced synchronous layout) — regression guard.
 *
 * tracking-ext-element.js (public/v2/tracking-ext-element.js) had two
 * el.getBoundingClientRect() calls inside scan loops that also mutated
 * DOM-observer state in the same iteration, forcing a synchronous layout per
 * element on every page that has this extension installed:
 *   - V1 observeElements() (CTA/banner scan) — fixed by resolving geometry
 *     lazily from the IntersectionObserver callback's entry.boundingClientRect,
 *     mirroring tracking-ext-image.js.
 *   - V2 observeContentElements() (broad content-element scan used only to
 *     filter out sub-10px elements) — fixed with FastDOM-style batching:
 *     all geometry reads happen in one pass before any writes/observes.
 *
 * These tests assert:
 *  1. V1: observeElements() never calls el.getBoundingClientRect() during scan;
 *     geometry (element_y) is correctly derived from entry.boundingClientRect
 *     once the IntersectionObserver delivers its first entry, and flush()
 *     produces the same element_y the caller would have gotten before.
 *  2. V2: observeContentElements() still calls getBoundingClientRect() (its
 *     reads feed a size filter, not the outgoing payload), but every read
 *     happens before any write (trackedV2.set()/observerV2.observe()) — i.e.
 *     batched, not interleaved — and the sub-10px filter still works.
 *
 * Runtime: Node 20+ built-in test runner (node:test), same vm.runInContext
 * sandbox pattern as tests/unit/tracking-ext-image.test.mjs (no jsdom).
 * Run: `node --test tests/unit/tracking-ext-element.test.mjs`
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'public', 'v2', 'tracking-ext-element.js')
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf-8')

/**
 * Build a minimal browser-like sandbox, register the extension (triggers its
 * own init()/observeElements()/observeContentElements() synchronously), and
 * return handles for driving the mocked IntersectionObservers and inspecting
 * the call-order log used to verify read/write batching.
 */
function runExtension({ ctaElements = [], contentElements = [], scrollY = 0, callLog } = {}) {
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
      getElementPath: (el) => '/el[' + (el._id || 'unknown') + ']',
      getCssSelector: (el) => '.' + (el._id || 'unknown'),
    },
  }

  const ioInstances = []
  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      this.observedTargets = []
      ioInstances.push(this)
    }
    observe(target) {
      if (callLog) callLog.push({ type: 'observe', el: target })
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
    querySelectorAll: (sel) => {
      // V1 calls querySelectorAll twice (custom [data-track-visibility] + the CTA list);
      // V2 calls it once with its own selector list. Route by a marker each element carries.
      if (sel === '[data-track-visibility]') return []
      if (sel.indexOf('cta') !== -1) return ctaElements
      return contentElements
    },
    addEventListener: () => {},
  }

  const windowMock = {
    ClickInsight: CI,
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    scrollY,
    pageYOffset: scrollY,
    CLICKINSIGHT_VISIBILITY_SELECTORS: undefined,
  }

  const sandbox = {
    window: windowMock,
    document: documentMock,
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    Set,
    Map,
    Array,
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
    getV1IO: () => ioInstances[0],
    getV2IO: () => ioInstances[1],
  }
}

function makeEl({ id, width = 100, height = 100, throwOnRectRead = false, callLog }) {
  let rectCallCount = 0
  const el = {
    _id: id,
    tagName: 'div',
    textContent: id,
    getAttribute: () => null,
    getBoundingClientRect() {
      rectCallCount += 1
      if (callLog) callLog.push({ type: 'read', el })
      if (throwOnRectRead) {
        throw new Error(`el.getBoundingClientRect() must not be called eagerly at scan time (perf ②b regression, ${id})`)
      }
      return { top: 0, left: 0, width, height, right: width, bottom: height }
    },
  }
  Object.defineProperty(el, '_rectCallCount', { get: () => rectCallCount })
  return el
}

test('②b V1: observeElements() never calls el.getBoundingClientRect() (forced-layout regression guard)', () => {
  const cta1 = makeEl({ id: 'cta1', throwOnRectRead: true })
  const result = runExtension({ ctaElements: [cta1] })

  assert.equal(result.runtimeError, undefined, `Unexpected runtime error: ${result.runtimeError && result.runtimeError.stack}`)
  const io = result.getV1IO()
  assert.ok(io, 'V1 IntersectionObserver should have been constructed')
  assert.equal(io.observedTargets.length, 1)
  assert.equal(cta1._rectCallCount, 0, 'getBoundingClientRect must not be called on cta1 during scan')
})

test('②b V1: element_y is derived from entry.boundingClientRect (async IO pass), matches prior behavior', () => {
  const cta1 = makeEl({ id: 'cta1' })
  const result = runExtension({ ctaElements: [cta1], scrollY: 300 })
  assert.equal(result.runtimeError, undefined)

  const io = result.getV1IO()
  const ext = result.getExt()
  assert.ok(ext)

  io.callback([{ target: cta1, isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 80 } }])

  const data = ext.tracked.get(cta1)
  assert.equal(data.y, 80 + 300, 'element_y = entry.boundingClientRect.top + scrollY')

  data.startTime = Date.now() - 200
  ext.flush()

  assert.equal(result.trackedEvents.length, 1)
  const ev = result.trackedEvents[0]
  assert.equal(ev.event_type, 'element_visibility')
  assert.equal(ev.element_y, 380)
  assert.equal(cta1._rectCallCount, 0, 'flush() must not have triggered a rect read either')
})

test('②b V1: element_y falls back to 0 if flushed before the observer ever delivered an entry', () => {
  // Defensive guard added alongside the fix (data.y starts as null instead of an eager read).
  const cta1 = makeEl({ id: 'cta1' })
  const result = runExtension({ ctaElements: [cta1] })
  const ext = result.getExt()
  const data = ext.tracked.get(cta1)
  data.startTime = Date.now() - 200 // visible long enough to pass the >=100ms flush threshold
  ext.flush()
  assert.equal(result.trackedEvents[0].element_y, 0, 'null y must not leak into the payload as null/NaN')
})

test('②b V2: every getBoundingClientRect() read happens before any observe()/track write (batched, not interleaved)', () => {
  const callLog = []
  const c1 = makeEl({ id: 'c1', width: 200, height: 200, callLog })
  const c2 = makeEl({ id: 'c2', width: 200, height: 200, callLog })
  const c3 = makeEl({ id: 'c3', width: 200, height: 200, callLog })

  const result = runExtension({ contentElements: [c1, c2, c3], callLog })
  assert.equal(result.runtimeError, undefined, `Unexpected runtime error: ${result.runtimeError && result.runtimeError.stack}`)

  const reads = callLog.filter((e) => e.type === 'read')
  const writes = callLog.filter((e) => e.type === 'observe')
  assert.equal(reads.length, 3, 'all three candidates should have been read exactly once')
  assert.equal(writes.length, 3, 'all three candidates should have been observed (all pass the size filter)')

  const lastReadIndex = callLog.lastIndexOf(reads[reads.length - 1])
  const firstWriteIndex = callLog.indexOf(writes[0])
  assert.ok(
    firstWriteIndex > lastReadIndex,
    'every read must be batched before the first write — reads and writes must not interleave',
  )
})

test('②b V2: sub-10px elements are still filtered out after batching (no candidates[]/rects[] misalignment)', () => {
  const tiny = makeEl({ id: 'tiny', width: 5, height: 5 })
  const normal = makeEl({ id: 'normal', width: 200, height: 200 })

  // Order matters for this test: verify the filter applies to the correct element
  // (i.e. no off-by-one between the candidates[] and rects[] arrays built in two passes).
  const result = runExtension({ contentElements: [tiny, normal] })
  const io = result.getV2IO()

  assert.equal(io.observedTargets.length, 1, 'only the normal-sized element should be observed')
  assert.equal(io.observedTargets[0], normal, 'the surviving observed element must be the correctly-sized one, not tiny')

  const ext = result.getExt()
  assert.equal(ext.trackedV2.has(tiny), false)
  assert.equal(ext.trackedV2.has(normal), true)
})
