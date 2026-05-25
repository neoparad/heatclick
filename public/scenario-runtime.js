/**
 * ClickInsight Pro — scenario-runtime.js (M-Director Phase 1, 2026-05-25)
 *
 * Path A (Owner 2026-05-25 確定): 条件 match → A/B/C variant 決定 → 実 DOM に表示。
 *
 * Reference:
 *   - linkscrawl/docs/fusion/team/m-director/dsl-spec.md §7 (evaluator)
 *   - linkscrawl/docs/fusion/team/m-director/data-model.md §4 (event flow)
 *   - linkscrawl/docs/fusion/team/m-director/prd.md (Phase 1 = live 配信)
 *
 * Load (after tracking.js):
 *   <script src="https://ugokimap.com/scenario-runtime.js"
 *           data-site-id="CIP_xxx"
 *           data-tenant-id="linkth_internal"
 *           data-runtime-url="https://ugokimap.com/api/scenarios/runtime"
 *           defer></script>
 *
 * Bundle size target: < 8KB gzipped (~18KB uncompressed).
 *
 * §1.7.1 NOTE: 親 SSOT §1.7.1 (Codex Round 4 確定) は traffic allocation +
 * variant execution を VWO 委譲としているが、Owner 2026-05-25 で Phase 1 内製配信
 * を確定。§1.7.1 改訂は Owner 別途実施 (m-director/decisions.md 続 M-3 参照)。
 */
(function () {
  'use strict'

  // ──────────────────────────────────────────────────────────────────────────
  // Config (mirrors tracking.js v2 attribute resolution)
  // ──────────────────────────────────────────────────────────────────────────
  var _cs = document.currentScript
  function _attr(name, fallback) {
    if (_cs) {
      var v = _cs.getAttribute(name)
      if (v) return v
    }
    var all = document.querySelectorAll('script[src*="scenario-runtime.js"]')
    for (var i = all.length - 1; i >= 0; i--) {
      var x = all[i].getAttribute(name)
      if (x) return x
    }
    return fallback || ''
  }

  var SITE_ID = _attr('data-site-id', window.CLICKINSIGHT_SITE_ID || '')
  var TENANT_ID = _attr('data-tenant-id', window.CLICKINSIGHT_TENANT_ID || '')
  var RUNTIME_URL = _attr('data-runtime-url', '')
  var TRACK_URL = window.CLICKINSIGHT_API_URL || 'https://ugokimap-event-ingest.linkth.workers.dev/api/track'

  if (!SITE_ID || !TENANT_ID) {
    console.error('[scenario-runtime] missing data-site-id / data-tenant-id')
    return
  }
  if (!RUNTIME_URL) {
    var origin = (function () {
      if (_cs && _cs.src) {
        try { return new URL(_cs.src).origin } catch (e) { /* noop */ }
      }
      return ''
    })()
    RUNTIME_URL = (origin || '') + '/api/scenarios/runtime'
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Context builder (reads tracking.js v2 sessionStorage + cookie)
  // ──────────────────────────────────────────────────────────────────────────
  function _cookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/+^])/g, '\\$1') + '=([^;]*)'))
      return m ? decodeURIComponent(m[1]) : ''
    } catch (e) { return '' }
  }
  function _qs(name) {
    try { return new URLSearchParams(window.location.search).get(name) || '' } catch (e) { return '' }
  }
  function _deviceType() {
    var ua = (navigator.userAgent || '').toLowerCase()
    if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet'
    if (/mobile|iphone|android|webos|blackberry|iemobile|opera mini/.test(ua)) return 'mobile'
    return 'desktop'
  }
  function buildCtx() {
    var nowSec = Math.floor(Date.now() / 1000)
    var startTs = parseInt(sessionStorage.getItem('ci_sst') || '0', 10) || Date.now()
    return {
      tenant_id: TENANT_ID,
      site_id: SITE_ID,
      visitor_id: _cookie('__ugk_vid'),
      session_id: sessionStorage.getItem('ci_sid') || '',
      is_first_visit: sessionStorage.getItem('ci_first_visit') === '1',
      session_duration_sec: Math.max(0, nowSec - Math.floor(startTs / 1000)),
      page_views_in_session: parseInt(sessionStorage.getItem('ci_spv') || '0', 10),
      url_path: window.location.pathname,
      url_query: window.location.search,
      referrer_host: (function () { try { return document.referrer ? new URL(document.referrer).host : '' } catch (e) { return '' } })(),
      utm_source: _qs('utm_source'),
      utm_medium: _qs('utm_medium'),
      utm_campaign: _qs('utm_campaign'),
      device_type: _deviceType(),
      visited_paths: (function () { try { return JSON.parse(sessionStorage.getItem('ci_vp') || '[]') } catch (e) { return [] } })(),
      scroll_depth_max_pct: parseInt(sessionStorage.getItem('ci_scroll_max') || '0', 10),
      hour_of_day: new Date().getHours(),
      language: (navigator.language || '').split('-')[0] || '',
      is_agent: window.CLICKINSIGHT_IS_AGENT === true,
    }
  }
  function _appendVisitedPath() {
    try {
      var arr = JSON.parse(sessionStorage.getItem('ci_vp') || '[]')
      var p = window.location.pathname
      if (arr.indexOf(p) === -1) {
        arr.push(p)
        if (arr.length > 50) arr.shift()
        sessionStorage.setItem('ci_vp', JSON.stringify(arr))
      }
    } catch (e) { /* noop */ }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // AST evaluator
  // ──────────────────────────────────────────────────────────────────────────
  var LEAF_OPS = {
    EQ: 1, NEQ: 1, GT: 1, GTE: 1, LT: 1, LTE: 1,
    IN: 1, NOT_IN: 1,
    CONTAINS: 1, STARTS_WITH: 1, ENDS_WITH: 1, MATCHES_REGEX: 1,
    VISITED: 1, NOT_VISITED: 1,
    EXISTS: 1, NOT_EXISTS: 1,
  }
  function evaluate(node, ctx) {
    if (!node || !node.op) return false
    if (LEAF_OPS[node.op]) return evalLeaf(node, ctx)
    if (node.op === 'AND') return (node.children || []).every(function (c) { return evaluate(c, ctx) })
    if (node.op === 'OR') return (node.children || []).some(function (c) { return evaluate(c, ctx) })
    if (node.op === 'NOT') return !!(node.children && node.children.length === 1 && !evaluate(node.children[0], ctx))
    return false
  }
  function evalLeaf(n, ctx) {
    var v = ctx[n.field]
    var t = n.value
    switch (n.op) {
      case 'EQ': return v === t
      case 'NEQ': return v !== t
      case 'GT': return typeof v === 'number' && typeof t === 'number' && v > t
      case 'GTE': return typeof v === 'number' && typeof t === 'number' && v >= t
      case 'LT': return typeof v === 'number' && typeof t === 'number' && v < t
      case 'LTE': return typeof v === 'number' && typeof t === 'number' && v <= t
      case 'IN': return Array.isArray(t) && t.indexOf(v) !== -1
      case 'NOT_IN': return Array.isArray(t) && t.indexOf(v) === -1
      case 'CONTAINS': return typeof v === 'string' && typeof t === 'string' && v.indexOf(t) !== -1
      case 'STARTS_WITH': return typeof v === 'string' && typeof t === 'string' && v.indexOf(t) === 0
      case 'ENDS_WITH': return typeof v === 'string' && typeof t === 'string' && v.lastIndexOf(t) === v.length - t.length
      case 'MATCHES_REGEX':
        if (typeof t !== 'string' || typeof v !== 'string') return false
        try { return new RegExp(t).test(v) } catch (e) { return false }
      case 'VISITED': return Array.isArray(ctx.visited_paths) && typeof t === 'string' && ctx.visited_paths.indexOf(t) !== -1
      case 'NOT_VISITED': return typeof t === 'string' && (!Array.isArray(ctx.visited_paths) || ctx.visited_paths.indexOf(t) === -1)
      case 'EXISTS': return v !== undefined && v !== null && v !== ''
      case 'NOT_EXISTS': return v === undefined || v === null || v === ''
      default: return false
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Deterministic A/B/C split (FNV-1a 32-bit hash of visitor_id + scenario_id)
  // Same (visitor_id, scenario_id) → same variant across sessions/pages.
  // ──────────────────────────────────────────────────────────────────────────
  function _hash(s) {
    var h = 2166136261
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
    }
    return h
  }
  function pickVariant(scenario, visitorId) {
    var variants = scenario.variants || []
    if (variants.length === 0) return null
    if (variants.length === 1) return variants[0]
    var bucket = _hash(visitorId + ':' + scenario.id) % 100
    var cum = 0
    for (var i = 0; i < variants.length; i++) {
      cum += variants[i].traffic_split || 0
      if (bucket < cum) return variants[i]
    }
    return variants[variants.length - 1]
  }

  // ──────────────────────────────────────────────────────────────────────────
  // scenario_match event sender
  // ──────────────────────────────────────────────────────────────────────────
  function sendMatchEvent(scenario, variant, matchType, evalMs) {
    var ctx = buildCtx()
    var payload = {
      tenant_id: TENANT_ID,
      site_id: SITE_ID,
      visitor_id: ctx.visitor_id,
      session_id: ctx.session_id,
      event_type: 'scenario_match',
      url: window.location.href,
      timestamp: new Date().toISOString(),
      device_type: ctx.device_type,
      utm_source: ctx.utm_source,
      utm_medium: ctx.utm_medium,
      utm_campaign: ctx.utm_campaign,
      scenario_id: scenario.id,
      match_type: matchType,
      dispatch_path: scenario.status === 'live' ? 'live' : scenario.status === 'preview' ? 'preview' : 'measure_only',
      ab_variant_id: (variant && variant.id) || '',
      matched_condition_hash: scenario.matched_condition_hash || '',
      evaluation_ms: evalMs || 0,
    }
    try {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      var ok = navigator.sendBeacon && navigator.sendBeacon(TRACK_URL, blob)
      if (!ok) {
        fetch(TRACK_URL, { method: 'POST', body: blob, keepalive: true }).catch(function () {})
      }
    } catch (e) { /* noop */ }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DOM rendering (POP overlay + image / HTML inline)
  // ──────────────────────────────────────────────────────────────────────────
  var _hostId = 'ugk-scenario-host'
  function _ensureHost() {
    var host = document.getElementById(_hostId)
    if (!host) {
      host = document.createElement('div')
      host.id = _hostId
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483640;pointer-events:none;'
      document.body.appendChild(host)
      _injectStyles()
    }
    return host
  }
  function _injectStyles() {
    if (document.getElementById('ugk-scenario-style')) return
    var s = document.createElement('style')
    s.id = 'ugk-scenario-style'
    s.textContent = [
      '.ugk-overlay{position:fixed;inset:0;background:rgba(15,17,23,.55);display:flex;align-items:center;justify-content:center;z-index:1;pointer-events:auto;animation:ugk-fade .2s ease;}',
      '@keyframes ugk-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes ugk-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
      '.ugk-card{background:#fff;border-radius:14px;padding:18px;max-width:90vw;max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(15,17,23,.30),0 4px 14px rgba(15,17,23,.10);position:relative;animation:ugk-rise .25s ease;pointer-events:auto;}',
      '.ugk-corner{position:fixed;max-width:360px;max-height:80vh;overflow:auto;background:#fff;border-radius:12px;padding:14px;box-shadow:0 16px 40px rgba(15,17,23,.25),0 2px 8px rgba(15,17,23,.10);pointer-events:auto;animation:ugk-rise .25s ease;z-index:2;}',
      '.ugk-corner.pos-top-left{top:16px;left:16px}',
      '.ugk-corner.pos-top-right{top:16px;right:16px}',
      '.ugk-corner.pos-bottom-left{bottom:16px;left:16px}',
      '.ugk-corner.pos-bottom-right{bottom:16px;right:16px}',
      '.ugk-corner.pos-top{top:16px;left:50%;transform:translateX(-50%)}',
      '.ugk-corner.pos-bottom{bottom:16px;left:50%;transform:translateX(-50%)}',
      '.ugk-close{position:absolute;top:8px;right:10px;background:transparent;border:0;cursor:pointer;color:#5b6478;font-size:20px;line-height:1;padding:4px 8px;border-radius:4px;}',
      '.ugk-close:hover{background:rgba(15,17,23,.06);color:#0f1117;}',
      '.ugk-img{display:block;max-width:100%;height:auto;border-radius:8px;cursor:pointer;}',
      '.ugk-cta{display:inline-block;margin-top:12px;padding:10px 20px;background:linear-gradient(135deg,#4f6bff 0%,#a855f7 100%);color:#fff;text-decoration:none;border-radius:6px;font-size:13.5px;font-weight:600;cursor:pointer;border:0;box-shadow:0 2px 8px rgba(79,107,255,.25);}',
      '.ugk-cta:hover{filter:brightness(1.06);}',
    ].join('\n')
    document.head.appendChild(s)
  }
  function _closeRendered(scenario, variant) {
    var node = document.querySelector('[data-ugk-scenario="' + scenario.id + '"]')
    if (node && node.parentNode) node.parentNode.removeChild(node)
    var overlay = document.querySelector('.ugk-overlay[data-ugk-scenario="' + scenario.id + '"]')
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    sendMatchEvent(scenario, variant, 'dismiss', 0)
  }
  function _onCtaClick(scenario, variant, ctaUrl, e) {
    e.preventDefault()
    sendMatchEvent(scenario, variant, 'click', 0)
    // Allow event flush (best effort) before navigation
    setTimeout(function () {
      if (ctaUrl) window.location.href = ctaUrl
    }, 50)
  }
  function renderVariant(scenario, variant) {
    var host = _ensureHost()
    var isCenter = !variant.position || variant.position === 'center'
    var isInline = variant.position === 'inline'

    // Build inner content
    var content = document.createElement('div')
    content.setAttribute('data-ugk-scenario', scenario.id)
    content.setAttribute('data-ugk-variant', variant.id)

    var close = document.createElement('button')
    close.className = 'ugk-close'
    close.setAttribute('aria-label', '閉じる')
    close.textContent = '×'
    close.addEventListener('click', function () { _closeRendered(scenario, variant) })
    content.appendChild(close)

    var body = document.createElement('div')
    if (variant.content_type === 'image') {
      var img = document.createElement('img')
      img.className = 'ugk-img'
      img.src = variant.image_url
      img.alt = variant.image_alt || ''
      if (variant.image_width) img.width = variant.image_width
      if (variant.image_height) img.height = variant.image_height
      if (variant.cta_url) {
        img.style.cursor = 'pointer'
        img.addEventListener('click', function (e) { _onCtaClick(scenario, variant, variant.cta_url, e) })
      }
      body.appendChild(img)
    } else if (variant.content_type === 'html') {
      // Phase 1: hard-code Owner-signed HTML. Phase 2 adds DOMPurify before this point.
      body.innerHTML = variant.html || ''
      // Attach CTA on root buttons / links if cta_url provided
      if (variant.cta_url) {
        var cta = document.createElement('a')
        cta.className = 'ugk-cta'
        cta.href = variant.cta_url
        cta.textContent = 'クーポンを使う'
        cta.addEventListener('click', function (e) { _onCtaClick(scenario, variant, variant.cta_url, e) })
        body.appendChild(cta)
      }
    }
    content.appendChild(body)

    if (isCenter) {
      var overlay = document.createElement('div')
      overlay.className = 'ugk-overlay'
      overlay.setAttribute('data-ugk-scenario', scenario.id)
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) _closeRendered(scenario, variant)
      })
      content.className = 'ugk-card'
      overlay.appendChild(content)
      host.appendChild(overlay)
    } else if (isInline) {
      // Inline: append to a sentinel if present, else fallback to top
      var sentinel = document.querySelector('[data-ugk-inline-slot]') || document.body.firstChild
      content.style.cssText = 'background:#fff;border:1px solid #e6e8ef;border-radius:10px;padding:14px;margin:12px 0;'
      sentinel.parentNode.insertBefore(content, sentinel)
    } else {
      content.className = 'ugk-corner pos-' + variant.position
      host.appendChild(content)
    }

    sendMatchEvent(scenario, variant, 'impression', 0)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-session dedup
  // ──────────────────────────────────────────────────────────────────────────
  var _matchedInSession = {}
  function _matchKey(scenarioId, sessionId) { return scenarioId + ':' + sessionId }
  function _wasMatchedInSession(scenarioId, sessionId) {
    if (_matchedInSession[_matchKey(scenarioId, sessionId)]) return true
    try {
      var raw = sessionStorage.getItem('ugk_matched') || '{}'
      var obj = JSON.parse(raw)
      return !!obj[_matchKey(scenarioId, sessionId)]
    } catch (e) { return false }
  }
  function _markMatched(scenarioId, sessionId) {
    _matchedInSession[_matchKey(scenarioId, sessionId)] = true
    try {
      var raw = sessionStorage.getItem('ugk_matched') || '{}'
      var obj = JSON.parse(raw)
      obj[_matchKey(scenarioId, sessionId)] = Date.now()
      sessionStorage.setItem('ugk_matched', JSON.stringify(obj))
    } catch (e) { /* noop */ }
  }

  function evaluateAll(scenarios) {
    var ctx = buildCtx()
    if (!ctx.session_id || !ctx.visitor_id) return
    for (var i = 0; i < scenarios.length; i++) {
      var sc = scenarios[i]
      if (sc.status !== 'live' && sc.status !== 'preview') continue
      if (_wasMatchedInSession(sc.id, ctx.session_id)) continue
      var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      var matched = false
      try { matched = evaluate(sc.condition_ast, ctx) } catch (e) { matched = false }
      var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      if (matched) {
        _markMatched(sc.id, ctx.session_id)
        var variant = pickVariant(sc, ctx.visitor_id)
        sendMatchEvent(sc, variant, 'match', Math.round(t1 - t0))
        if (variant && (sc.status === 'live' || sc.status === 'preview')) {
          renderVariant(sc, variant)
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ──────────────────────────────────────────────────────────────────────────
  var _scenarios = []
  function fetchScenarios() {
    var url = RUNTIME_URL + '?tenant_id=' + encodeURIComponent(TENANT_ID) + '&site_id=' + encodeURIComponent(SITE_ID)
    return fetch(url, { credentials: 'omit', mode: 'cors' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (j && Array.isArray(j.scenarios)) _scenarios = j.scenarios
      })
      .catch(function () { /* noop, retry next page */ })
  }
  function init() {
    _appendVisitedPath()
    fetchScenarios().then(function () {
      evaluateAll(_scenarios)
      var lastScroll = 0
      window.addEventListener('scroll', function () {
        var pct = Math.min(100, Math.round((window.scrollY + window.innerHeight) * 100 / (document.documentElement.scrollHeight || 1)))
        if (pct >= lastScroll + 10) { lastScroll = pct; evaluateAll(_scenarios) }
      }, { passive: true })
      var intervalCount = 0
      var intervalId = setInterval(function () {
        intervalCount++
        evaluateAll(_scenarios)
        if (intervalCount > 360) clearInterval(intervalId)
      }, 10000)
    })
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // Expose minimal API for debugging
  window.UGOKI_SCENARIO_RUNTIME = {
    evaluate: evaluate,
    buildCtx: buildCtx,
    pickVariant: pickVariant,
    _hash: _hash,
    version: '0.2.0+phase1',
  }
})()
