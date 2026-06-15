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

  // ──────────────────────────────────────────────────────────────────────────
  // REQ-SEC-013: Consent gate (fail-closed). Mirrors public/v2/tracking.js init():
  //   - localStorage 'clickinsight_optout' === 'true'  → user opted out → no render
  //   - when consent is required, localStorage 'clickinsight_cookie_consent' must be 'true'
  // We also honor cookie-form values of the same names (some integrations set cookies
  // rather than localStorage). Consent required-ness is taken from the same global flag
  // tracking.js uses (window.CLICKINSIGHT_REQUIRE_CONSENT). Any read error fails closed.
  // ──────────────────────────────────────────────────────────────────────────
  function _lsGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null } catch (e) { return null }
  }
  function _lsSet(key, val) {
    try { if (window.localStorage) window.localStorage.setItem(key, val) } catch (e) { /* noop */ }
  }
  // ── 訪問回数 (= セッション数) カウンタ — condition field `session_count` 用 ───────────
  // 「N回目の訪問」で出し分けるため、訪問者ごとに累計セッション数を localStorage (ugk_ namespace,
  // tracking.js の ci_* とは別) で数える。30 分以上アクセスが空いたら新セッションとして +1 (GA 風)。
  // 1 ページ表示につき最大 1 回だけ評価 (_sessionCountMemo)。localStorage 不可なら 1 に degrade。
  var SESSION_GAP_MS = 30 * 60 * 1000
  var _sessionCountMemo = null
  function _resolveSessionCount() {
    if (_sessionCountMemo !== null) return _sessionCountMemo
    var stored = parseInt(_lsGet('ugk_session_count') || '0', 10) || 0
    var lastActive = parseInt(_lsGet('ugk_last_active_ms') || '0', 10) || 0
    var now = Date.now()
    var isNewSession = !lastActive || (now - lastActive) > SESSION_GAP_MS
    var count = isNewSession ? stored + 1 : (stored > 0 ? stored : 1)
    _lsSet('ugk_session_count', String(count))
    _lsSet('ugk_last_active_ms', String(now))
    _sessionCountMemo = count
    return count
  }
  function _consentAllowsRender() {
    try {
      // Opt-out wins regardless of consent mode (localStorage OR cookie).
      if (_lsGet('clickinsight_optout') === 'true') return false
      if (_cookie('clickinsight_optout') === 'true') return false
      var requireConsent = window.CLICKINSIGHT_REQUIRE_CONSENT === true
      if (requireConsent) {
        var lsConsent = _lsGet('clickinsight_cookie_consent') === 'true'
        var ckConsent = _cookie('clickinsight_cookie_consent') === 'true'
        if (!lsConsent && !ckConsent) return false
      }
      return true
    } catch (e) {
      // Fail-closed: if we cannot determine consent, do not render.
      return false
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REQ-SEC-003: URL scheme allowlist. Variant cta_url / image_url are assigned to
  // href / location / img.src; only absolute https:// URLs (no credentials) are allowed.
  // javascript:/data:/blob:/relative are rejected. Mirrors lib/scenarios/safe-url.ts.
  // ──────────────────────────────────────────────────────────────────────────
  function _isSafeHttpsUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false
    try {
      var u = new URL(rawUrl, window.location.href)
      if (u.protocol !== 'https:') return false
      if (u.username || u.password) return false
      if (!u.hostname) return false
      // Reject relative inputs that resolved against the page origin: require the raw
      // string to itself start with a scheme so "/path" or "javascript:..." don't slip in.
      if (!/^https:\/\//i.test(rawUrl)) return false
      return true
    } catch (e) {
      return false
    }
  }
  if (!RUNTIME_URL) {
    var origin = (function () {
      if (_cs && _cs.src) {
        try { return new URL(_cs.src).origin } catch (e) { /* noop */ }
      }
      // defer スクリプトでは document.currentScript が null になるため querySelectorAll でフォールバック。
      var els = document.querySelectorAll('script[src*="scenario-runtime.js"]')
      for (var i = els.length - 1; i >= 0; i--) {
        try { return new URL(els[i].src).origin } catch (e) { /* noop */ }
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
      session_count: _resolveSessionCount(),
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

  // Phase 2/3 フィールドは buildCtx() 未実装。条件が設定されても常に false を返す。
  // 「NEQ/NOT_EXISTS が undefined と比較して意図せず true になる」リスクを防ぐ (Codex 指摘)。
  var _UNIMPLEMENTED_FIELDS = { cart_value: 1, persona_label: 1, predicted_intent: 1 }

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
    if (_UNIMPLEMENTED_FIELDS[n.field]) {
      console.warn('[scenario-runtime] field "' + n.field + '" は未実装です (Phase 2/3 予定)。条件をスキップします。')
      return false
    }
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
        if (t.length > 200) { console.warn('[scenario-runtime] MATCHES_REGEX パターンが長すぎます (200文字超)。ReDoS防止のためスキップします。'); return false }
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
      // CORS: cross-origin の event-ingest worker は ACAO:* を返すため、credentialed な
      // sendBeacon で 'application/json' (non-simple) を送ると preflight が走り blocked になる。
      // tracking.js (public/v2/tracking.js) と同じく 'text/plain' (CORS simple request、
      // preflight 無し) で送る。worker は body を JSON parse するので content-type 非依存。
      var blob = new Blob([JSON.stringify(payload)], { type: 'text/plain' })
      var ok = navigator.sendBeacon && navigator.sendBeacon(TRACK_URL, blob)
      if (!ok) {
        // fallback も text/plain blob のため simple request (preflight 無し)。
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
      '.ugk-footerbar{position:fixed;left:0;right:0;bottom:0;background:#fff;box-shadow:0 -8px 30px rgba(15,17,23,.18);padding:12px 44px 12px 16px;padding-bottom:calc(12px + env(safe-area-inset-bottom,0px));pointer-events:auto;animation:ugk-rise .25s ease;z-index:2;}',
      '.ugk-footerbar > div{max-width:680px;margin:0 auto;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;}',
      '@media (max-width:600px){.ugk-corner{max-width:calc(100vw - 24px)}}',
    ].join('\n')
    document.head.appendChild(s)
  }
  function _closeRendered(scenario, variant) {
    var node = document.querySelector('[data-ugk-scenario="' + scenario.id + '"]')
    if (node && node.parentNode) node.parentNode.removeChild(node)
    var overlay = document.querySelector('.ugk-overlay[data-ugk-scenario="' + scenario.id + '"]')
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    if (_activeRenders > 0) _activeRenders--
    sendMatchEvent(scenario, variant, 'dismiss', 0)
  }
  function _onCtaClick(scenario, variant, ctaUrl, e) {
    e.preventDefault()
    sendMatchEvent(scenario, variant, 'click', 0)
    // Allow event flush (best effort) before navigation
    setTimeout(function () {
      // REQ-SEC-003: re-validate before navigation — never location = untrusted scheme.
      if (_isSafeHttpsUrl(ctaUrl)) window.location.href = ctaUrl
    }, 50)
  }
  // ──────────────────────────────────────────────────────────────────────────
  // REQ-SEC-001/002: client-side HTML sanitizer (defense-in-depth on top of the
  // server-side sanitize at the write boundary). Bundling DOMPurify into this
  // standalone served script is impractical (size/build), so this is a strict
  // allowlist sanitizer built on the browser's own parser (DOMParser): it walks the
  // parsed tree and rebuilds an output containing ONLY allowlisted elements,
  // attributes and https: URLs. Everything else (script/iframe/object/embed/form/
  // on*=/javascript:/data:/style-url) is dropped. Result is inserted via a
  // DocumentFragment — never `innerHTML = rawConfig`.
  // ──────────────────────────────────────────────────────────────────────────
  var _SAFE_TAGS = {
    A: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, SMALL: 1, SUB: 1, SUP: 1,
    BR: 1, HR: 1, P: 1, DIV: 1, SPAN: 1, SECTION: 1, HEADER: 1, FOOTER: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, UL: 1, OL: 1, LI: 1,
    BLOCKQUOTE: 1, FIGURE: 1, FIGCAPTION: 1, IMG: 1, PICTURE: 1, SOURCE: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1,
  }
  // Allowed attributes per tag. 'style' is allowed but filtered for url()/expression/scheme.
  var _SAFE_ATTRS = {
    A: { href: 1, title: 1, target: 1, rel: 1, style: 1 },
    IMG: { src: 1, alt: 1, width: 1, height: 1, style: 1 },
    SOURCE: { srcset: 1, media: 1, type: 1 },
    TD: { colspan: 1, rowspan: 1, style: 1 },
    TH: { colspan: 1, rowspan: 1, scope: 1, style: 1 },
  }
  function _safeStyle(value) {
    if (typeof value !== 'string') return ''
    // Drop any style that tries to load a URL or run an expression.
    if (/url\s*\(|expression\s*\(|javascript:|vbscript:|@import|<|>/i.test(value)) return ''
    return value
  }
  function _attrAllowed(tag, name) {
    if (/^on/i.test(name)) return false // never allow on* event handlers
    var generic = name === 'style' || name === 'title'
    var perTag = _SAFE_ATTRS[tag] && _SAFE_ATTRS[tag][name]
    return !!perTag || generic
  }
  // Rebuild a sanitized clone of `srcEl` into the document `doc`. Returns a Node or null.
  function _sanitizeNode(srcEl, doc) {
    if (srcEl.nodeType === 3) return doc.createTextNode(srcEl.nodeValue) // text
    if (srcEl.nodeType !== 1) return null // drop comments / others
    var tag = srcEl.tagName ? srcEl.tagName.toUpperCase() : ''
    if (!_SAFE_TAGS[tag]) return null // disallowed element → drop (incl. children)
    var out = doc.createElement(tag.toLowerCase())
    var attrs = srcEl.attributes || []
    for (var a = 0; a < attrs.length; a++) {
      var name = attrs[a].name
      var value = attrs[a].value
      var lname = name.toLowerCase()
      if (!_attrAllowed(tag, lname)) continue
      if (lname === 'href' || lname === 'src') {
        if (!_isSafeHttpsUrl(value)) continue // only https: URLs on links/images
      } else if (lname === 'srcset') {
        continue // srcset can carry multiple URLs; skip for simplicity/safety
      } else if (lname === 'style') {
        value = _safeStyle(value)
        if (!value) continue
      }
      try { out.setAttribute(lname, value) } catch (e) { /* skip bad attr */ }
    }
    var kids = srcEl.childNodes || []
    for (var k = 0; k < kids.length; k++) {
      var child = _sanitizeNode(kids[k], doc)
      if (child) out.appendChild(child)
    }
    return out
  }
  // Parse untrusted HTML and return a sanitized DocumentFragment for safe insertion.
  function _sanitizeToFragment(rawHtml) {
    var frag = document.createDocumentFragment()
    if (typeof rawHtml !== 'string' || rawHtml.length === 0) return frag
    var doc
    try {
      doc = new DOMParser().parseFromString('<div id="__ugk_root">' + rawHtml + '</div>', 'text/html')
    } catch (e) {
      return frag // parse failure → render nothing (fail-closed)
    }
    var root = doc.getElementById('__ugk_root')
    if (!root) return frag
    var nodes = root.childNodes || []
    for (var i = 0; i < nodes.length; i++) {
      var clean = _sanitizeNode(nodes[i], document)
      if (clean) frag.appendChild(clean)
    }
    return frag
  }

  // 表示位置のレスポンシブ解決: SP (<=768px) で position_mobile が設定されていればそれを使う。
  function _resolvePosition(variant, isMobile) {
    if (isMobile && variant && variant.position_mobile) return variant.position_mobile
    return (variant && variant.position) || 'center'
  }
  function _isMobileViewport() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches) } catch (e) { return false }
  }
  function _effectivePosition(variant) {
    return _resolvePosition(variant, _isMobileViewport())
  }

  function renderVariant(scenario, variant) {
    if (_activeRenders >= MAX_CONCURRENT_BANNERS) return false
    _activeRenders++
    var host = _ensureHost()
    var pos = _effectivePosition(variant)
    var isCenter = !pos || pos === 'center'
    var isInline = pos === 'inline'
    var isFooter = pos === 'footer'
    var offset = (typeof variant.position_offset === 'number' && variant.position_offset > 0) ? variant.position_offset : 0

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

    // REQ-SEC-003: only assign cta_url when it is a safe https: URL.
    var safeCtaUrl = _isSafeHttpsUrl(variant.cta_url) ? variant.cta_url : ''

    var body = document.createElement('div')
    if (variant.content_type === 'image') {
      var img = document.createElement('img')
      img.className = 'ugk-img'
      // REQ-SEC-003: reject non-https image_url (javascript:/data:/blob:/relative).
      if (_isSafeHttpsUrl(variant.image_url)) {
        img.src = variant.image_url
      }
      img.alt = variant.image_alt || ''
      if (variant.image_width) img.width = variant.image_width
      if (variant.image_height) img.height = variant.image_height
      if (safeCtaUrl) {
        img.style.cursor = 'pointer'
        img.addEventListener('click', function (e) { _onCtaClick(scenario, variant, safeCtaUrl, e) })
      }
      body.appendChild(img)
    } else if (variant.content_type === 'html') {
      // REQ-SEC-001/002: sanitize untrusted inline HTML and insert a fragment.
      // NEVER `innerHTML = rawConfig` (that ran in the customer's first-party origin = XSS).
      body.appendChild(_sanitizeToFragment(variant.html || ''))
      // Attach CTA on root buttons / links if a SAFE cta_url provided
      if (safeCtaUrl) {
        var cta = document.createElement('a')
        cta.className = 'ugk-cta'
        cta.href = safeCtaUrl
        cta.textContent = 'クーポンを使う'
        cta.addEventListener('click', function (e) { _onCtaClick(scenario, variant, safeCtaUrl, e) })
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
    } else if (isFooter) {
      // 全幅フッターバー。offset(px) でサイト独自の固定フッターを避けられる。
      content.className = 'ugk-footerbar'
      if (offset) content.style.bottom = offset + 'px'
      host.appendChild(content)
    } else {
      content.className = 'ugk-corner pos-' + pos
      if (offset) {
        if (pos.indexOf('bottom') === 0) content.style.bottom = 16 + offset + 'px'
        else if (pos.indexOf('top') === 0) content.style.top = 16 + offset + 'px'
      }
      host.appendChild(content)
    }

    sendMatchEvent(scenario, variant, 'impression', 0)
    return true
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 同時バナー表示上限 (center overlay 1 + corner/footer 合計 2 まで)
  // ──────────────────────────────────────────────────────────────────────────
  var _activeRenders = 0
  var MAX_CONCURRENT_BANNERS = (typeof window.UGOKI_MAX_BANNERS === 'number' && window.UGOKI_MAX_BANNERS >= 1)
    ? window.UGOKI_MAX_BANNERS : 2

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

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2.1: Frequency cap (per_period: 'session' | 'day' | 'week') + Schedule
  // ──────────────────────────────────────────────────────────────────────────
  //
  // 設計:
  //   - server が schedule で期間外 scenario を payload から除外する (authoritative)
  //   - browser 側は ±5min clock skew tolerance で再チェック (端末時計ずれ吸収)
  //   - frequency cap カウントは localStorage に「scenario_id × period bucket」で保存
  //   - render 前に「cap 超過していないか」を確認、render 後に count++
  //   - JSON parse 失敗時は fail-closed (render しない) を選択 (cap 超過誤判定を避けるため)
  //
  // clock skew tolerance: 5 分。あまり広げると「期間前/後」が緩くなりすぎる。
  var SCHEDULE_SKEW_MS = 5 * 60 * 1000

  function _isScenarioInSchedule(sc, nowMs) {
    if (!sc || !sc.schedule) return true
    if (sc.schedule.start_at) {
      var t0 = Date.parse(sc.schedule.start_at)
      if (!isFinite(t0)) return false
      if (nowMs + SCHEDULE_SKEW_MS < t0) return false
    }
    if (sc.schedule.end_at) {
      var t1 = Date.parse(sc.schedule.end_at)
      if (!isFinite(t1)) return false
      if (nowMs - SCHEDULE_SKEW_MS >= t1) return false
    }
    return true
  }

  function _isoWeekKey(d) {
    // ISO 8601 week (Mon 始まり)。test されやすいよう UTC 基準。
    var date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    var dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    date.setUTCDate(date.getUTCDate() + 4 - dayNum)
    var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
    var weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
    return date.getUTCFullYear() + '-W' + (weekNum < 10 ? '0' : '') + weekNum
  }

  function _periodBucket(period, nowMs) {
    var d = new Date(nowMs)
    if (period === 'day') {
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
    }
    if (period === 'week') return _isoWeekKey(d)
    // 'session' は sessionStorage 側で扱うので別経路 (_wasMatchedInSession を流用)
    return 'session'
  }

  function _capStorageKey(scenarioId, period, bucket) {
    return 'ugk_cap:' + scenarioId + ':' + period + ':' + bucket
  }

  // session max>=2 のときは既存 per-session dedup (_wasMatchedInSession) を **使わない**:
  // dedup は max=1 と等価の挙動なので、2 回目以降の表示に到達できないため。
  // この helper は evaluateAll で session-dedup ガードを通すかどうかの判定に使う。
  function _usesSessionDedup(sc) {
    var cap = sc && sc.frequency_cap
    if (!cap) return true
    if (cap.per_period !== 'session') return true
    return ((cap.max_impressions | 0) < 2)
  }

  function _isFrequencyCapExceeded(sc, nowMs) {
    var cap = sc && sc.frequency_cap
    if (!cap) return false
    var period = cap.per_period
    var max = cap.max_impressions | 0
    if (max <= 0) return true // 0 cap = 配信しない
    if (period === 'session') {
      // session 単位 cap: 既存の per-session dedup で max=1 と等価のため
      // max>=2 のときだけ追加ストレージで count する。
      if (max >= 2) {
        try {
          var rawS = sessionStorage.getItem('ugk_cap_s:' + sc.id) || '0'
          var nS = parseInt(rawS, 10) || 0
          return nS >= max
        } catch (e) { return true }
      }
      // max=1 のときは _wasMatchedInSession が後段で弾く (二重 dedup OK)
      return false
    }
    var bucket = _periodBucket(period, nowMs)
    try {
      var key = _capStorageKey(sc.id, period, bucket)
      var raw = localStorage.getItem(key) || '0'
      var n = parseInt(raw, 10) || 0
      return n >= max
    } catch (e) {
      // localStorage 不可 → fail-closed (cap 越え誤判定を避ける)
      return true
    }
  }

  function _bumpFrequencyCap(sc, nowMs) {
    var cap = sc && sc.frequency_cap
    if (!cap) return
    var period = cap.per_period
    if (period === 'session') {
      try {
        var rawS = sessionStorage.getItem('ugk_cap_s:' + sc.id) || '0'
        var nS = (parseInt(rawS, 10) || 0) + 1
        sessionStorage.setItem('ugk_cap_s:' + sc.id, String(nS))
      } catch (e) { /* noop */ }
      return
    }
    var bucket = _periodBucket(period, nowMs)
    try {
      var key = _capStorageKey(sc.id, period, bucket)
      var raw = localStorage.getItem(key) || '0'
      var n = (parseInt(raw, 10) || 0) + 1
      localStorage.setItem(key, String(n))
    } catch (e) { /* noop */ }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Dispatch decision (§1.7.1 Path 区分): status → { measure, render }
  //   live         : 計測 + 描画
  //   measure_only : 計測のみ (描画しない = variant execution しない。§1.7.1 準拠の
  //                  「実行せず計測」パス)。従来 client が status!=='live' で measure_only を
  //                  素通りしていたため計測ゼロだったバグを修正 (match イベントは送る)。
  //   その他        : 何もしない (draft / paused / archived、及び万一届いた preview)。
  //                  preview は server が public payload から除外済 (REQ-SEC-006)。
  // ──────────────────────────────────────────────────────────────────────────
  function _dispatchDecision(status) {
    if (status === 'live') return { measure: true, render: true }
    if (status === 'measure_only') return { measure: true, render: false }
    return { measure: false, render: false }
  }

  function evaluateAll(scenarios) {
    // REQ-SEC-013: fail-closed consent gate — no consent → no evaluation, no render, no events.
    if (!_consentAllowsRender()) return
    var ctx = buildCtx()
    if (!ctx.session_id || !ctx.visitor_id) return
    var nowMs = Date.now()
    for (var i = 0; i < scenarios.length; i++) {
      var sc = scenarios[i]
      // §1.7.1: live=計測+描画 / measure_only=計測のみ / その他=無視。
      var disp = _dispatchDecision(sc.status)
      if (!disp.measure) continue
      // Phase 2.1: schedule (clock skew tolerance ±5min)。server-side でも除外済だが
      // payload を改ざんされたりキャッシュ差分があった場合の defense-in-depth。
      if (!_isScenarioInSchedule(sc, nowMs)) continue
      // session-dedup は session cap max>=2 のときだけ skip (Codex T2 fix: 既存 dedup が
      // max>=2 の 2 回目以降の表示を握り潰すバグを解消)
      if (_usesSessionDedup(sc) && _wasMatchedInSession(sc.id, ctx.session_id)) continue
      // Phase 2.1: frequency cap (day/week は localStorage、session は sessionStorage)
      if (_isFrequencyCapExceeded(sc, nowMs)) continue
      var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      var matched = false
      try { matched = evaluate(sc.condition_ast, ctx) } catch (e) { matched = false }
      var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      if (matched) {
        var variant = pickVariant(sc, ctx.visitor_id)
        sendMatchEvent(sc, variant, 'match', Math.round(t1 - t0))
        // measure_only は disp.render=false: match イベントだけ送り DOM 描画はしない。
        // live の場合は実描画成功時のみ cap/dedup を更新する (Codex 指摘: 上限スキップ時に
        // cap 消費してしまい再試行不能になるバグを修正)。measure_only は描画しないが計測済扱い。
        var didRender = false
        if (disp.render && variant) {
          didRender = renderVariant(sc, variant)
        }
        if (!disp.render || didRender) {
          if (_usesSessionDedup(sc)) _markMatched(sc.id, ctx.session_id)
          _bumpFrequencyCap(sc, nowMs)
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
    // REQ-SEC-013: fail-closed consent gate at entry — without consent, never fetch or render
    // scenario config at all. evaluateAll() re-checks consent before each render as well.
    if (!_consentAllowsRender()) return
    _appendVisitedPath()
    _resolveSessionCount() // 訪問回数を 1 ページ表示につき 1 回数える (consent 後)
    fetchScenarios().then(function () {
      evaluateAll(_scenarios)
      var lastScroll = 0
      window.addEventListener('scroll', function () {
        var pct = Math.min(100, Math.round((window.scrollY + window.innerHeight) * 100 / (document.documentElement.scrollHeight || 1)))
        if (pct >= lastScroll + 10) { lastScroll = pct; evaluateAll(_scenarios) }
      }, { passive: true })
      // M-2: Page Visibility API — タブが非表示のときはポーリングをスキップして無駄な評価を防ぐ。
      var intervalCount = 0
      var intervalId = setInterval(function () {
        if (document.visibilityState === 'hidden') return
        intervalCount++
        evaluateAll(_scenarios)
        if (intervalCount > 360) clearInterval(intervalId)
      }, 10000)
      // M-1: SPA 対応 — pushState / popstate をフックして URL 変更時に再評価する。
      // React Router / Next.js App Router の クライアントナビゲーションに対応。
      function _onSpaNav() {
        _appendVisitedPath()
        evaluateAll(_scenarios)
      }
      window.addEventListener('popstate', _onSpaNav)
      try {
        var _origPushState = history.pushState
        history.pushState = function () {
          _origPushState.apply(history, arguments)
          setTimeout(_onSpaNav, 0) // マイクロタスク後に URL 確定してから評価
        }
        var _origReplaceState = history.replaceState
        history.replaceState = function () {
          _origReplaceState.apply(history, arguments)
          setTimeout(_onSpaNav, 0) // Next.js の query 更新等に対応
        }
      } catch (e) { /* history API が封鎖されている環境では無視 */ }
    })
  }
  // window.UGOKI_SCENARIO_DISABLE_AUTOINIT=true で自動 init を抑止できる (unit test 用に
  // 実ファイルを副作用なしでロードして内部関数を検証するためのフック)。
  if (!window.UGOKI_SCENARIO_DISABLE_AUTOINIT) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init)
    } else {
      init()
    }
  }

  // Expose minimal API for debugging / unit tests
  window.UGOKI_SCENARIO_RUNTIME = {
    evaluate: evaluate,
    evaluateAll: evaluateAll,
    buildCtx: buildCtx,
    pickVariant: pickVariant,
    _dispatch: _dispatchDecision,
    _hash: _hash,
    _sessionCount: _resolveSessionCount,
    _resolvePosition: _resolvePosition,
    version: '0.6.0+runtime-guards',
  }
})()
