/**
 * public/experiment-runtime.js の純関数テスト (node)。
 * DOM 操作部 (applyCta 等) は dogfood 実機検証 — ここでは配信判定ロジックのみ固定する。
 */

const {
  pathMatches,
  pickApplicable,
  isSafeSelector,
  isSafeHref,
} = require('@/public/experiment-runtime.js')

describe('experiment-runtime — pathMatches (server と同じ subtree 一致)', () => {
  it('pattern "/" は全 path に一致', () => {
    expect(pathMatches('/anything/deep', '/')).toBe(true)
  })
  it('完全一致 + subtree のみ (prefix 過剰一致しない)', () => {
    expect(pathMatches('/products', '/products')).toBe(true)
    expect(pathMatches('/products/123', '/products')).toBe(true)
    expect(pathMatches('/products-old', '/products')).toBe(false) // /products-old は別 subtree
    expect(pathMatches('/other', '/products')).toBe(false)
  })
  it('不正入力は false', () => {
    expect(pathMatches(null, '/x')).toBe(false)
    expect(pathMatches('/x', '')).toBe(false)
  })
})

describe('experiment-runtime — pickApplicable', () => {
  const renderA = {
    intervention_type: 'cta_placement',
    config: { kind: 'cta', cta_selector: '#buy' },
  }
  function assignment(over) {
    return Object.assign(
      { experiment_id: 'e1', arm: 'treatment', url_pattern: '/products', render: renderA },
      over,
    )
  }

  it('treatment + render + path 一致のみ通す', () => {
    const out = pickApplicable([assignment()], '/products/1')
    expect(out).toHaveLength(1)
  })
  it('control は除外 (render が無いのが正常形)', () => {
    expect(pickApplicable([assignment({ arm: 'control', render: undefined })], '/products')).toHaveLength(0)
  })
  it('treatment でも render なし (A/A) は除外', () => {
    expect(pickApplicable([assignment({ render: undefined })], '/products')).toHaveLength(0)
  })
  it('path 不一致は除外', () => {
    expect(pickApplicable([assignment()], '/checkout')).toHaveLength(0)
  })
  it('不正入力 (null / 非配列) は空配列', () => {
    expect(pickApplicable(null, '/x')).toEqual([])
    expect(pickApplicable({}, '/x')).toEqual([])
  })
})

describe('experiment-runtime — isSafeSelector', () => {
  it('通常 selector を受理、空 / 過長 / 非文字列を拒否', () => {
    expect(isSafeSelector('#buy-button')).toBe(true)
    expect(isSafeSelector('.cta a[href]')).toBe(true)
    expect(isSafeSelector('')).toBe(false)
    expect(isSafeSelector('a'.repeat(257))).toBe(false)
    expect(isSafeSelector(42)).toBe(false)
  })
})

describe('experiment-runtime — isSafeHref (Codex M6: script-bearing リンクの昇格防止)', () => {
  it('http(s) / 相対 / # / ? を受理', () => {
    expect(isSafeHref('https://example.com/buy')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('/checkout')).toBe(true)
    expect(isSafeHref('#order')).toBe(true)
    expect(isSafeHref('?step=2')).toBe(true)
    expect(isSafeHref('page.html')).toBe(true)
  })
  it('javascript: / data: / vbscript: を拒否 (大文字・空白分断も)', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false)
    expect(isSafeHref(' javascript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>x</script>')).toBe(false)
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false)
  })
  it('未知 scheme / 空 / 過長 / 非文字列を拒否', () => {
    expect(isSafeHref('customscheme:payload')).toBe(false)
    expect(isSafeHref('')).toBe(false)
    expect(isSafeHref('h'.repeat(2049))).toBe(false)
    expect(isSafeHref(null)).toBe(false)
  })
})
