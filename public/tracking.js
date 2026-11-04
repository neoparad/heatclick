/**
 * ClickInsight Pro - Tracking Script (Core)
 * Version: 2.2.0
 * Target: <5KB minified. Extensions add PII protection, forms, video, image, element tracking.
 *
 * v2.2.0: AXO (Agent Experience Optimization) — AIエージェント検知シグナルを全イベントに付与。
 *         PM決定 2026-04-11 / strategy/12_agent_experience_optimization.md 準拠。
 */
(function() {
  'use strict';

  const getSiteId = () => {
    // 1. data-site-id attribute on current script
    const cs = document.currentScript;
    if (cs) { const s = cs.getAttribute('data-site-id'); if (s) return s; }
    // 2. data-site-id on any tracking.js script tag
    const all = document.querySelectorAll('script[src*="tracking.js"]');
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i].getAttribute('data-site-id');
      if (s && !all[i].dataset.ciProcessed) { all[i].dataset.ciProcessed = '1'; return s; }
    }
    // 3. Global variable (set before script load or via GTM)
    if (window.CLICKINSIGHT_SITE_ID) return window.CLICKINSIGHT_SITE_ID;
    if (window.UGOKI_SITE_ID) return window.UGOKI_SITE_ID;
    // 4. URL query parameter on script src (e.g. tracking.js?id=CIP_xxx)
    for (let i = all.length - 1; i >= 0; i--) {
      try { const u = new URL(all[i].src); const id = u.searchParams.get('id') || u.searchParams.get('site_id'); if (id) return id; } catch {}
    }
    // 5. Any element with data-site-id
    const any = document.querySelector('script[data-site-id]');
    return any ? any.getAttribute('data-site-id') : '';
  };

  const getTenantId = () => {
    const cs = document.currentScript;
    if (cs) {
      const t = cs.getAttribute('data-tenant-id') || cs.getAttribute('data-ugoki-tenant-id');
      if (t) return t;
    }
    const all = document.querySelectorAll('script[src*="tracking.js"]');
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i].getAttribute('data-tenant-id') || all[i].getAttribute('data-ugoki-tenant-id');
      if (t) return t;
    }
    if (window.CLICKINSIGHT_TENANT_ID) return window.CLICKINSIGHT_TENANT_ID;
    if (window.UGOKI_TENANT_ID) return window.UGOKI_TENANT_ID;
    for (let i = all.length - 1; i >= 0; i--) {
      try { const u = new URL(all[i].src); const t = u.searchParams.get('tenant_id'); if (t) return t; } catch {}
    }
    const any = document.querySelector('script[data-tenant-id], script[data-ugoki-tenant-id]');
    return any ? (any.getAttribute('data-tenant-id') || any.getAttribute('data-ugoki-tenant-id') || '') : '';
  };

  const getScriptOrigin = () => {
    if (document.currentScript && document.currentScript.src) {
      try { return new URL(document.currentScript.src).origin; } catch {}
    }
    const s = document.querySelectorAll('script[src*="tracking.js"]');
    for (let i = s.length - 1; i >= 0; i--) { try { return new URL(s[i].src).origin; } catch {} }
    return '';
  };

  const scriptOrigin = getScriptOrigin();
  const cs = document.currentScript || document.querySelector('script[src*="tracking.js"]');

  const config = {
    siteId: getSiteId(),
    tenantId: getTenantId(),
    debug: window.CLICKINSIGHT_DEBUG || false,
    apiEndpoint: window.CLICKINSIGHT_API_URL || 'https://ugokimap-event-ingest.linkth.workers.dev/api/track',
    requireConsent: window.CLICKINSIGHT_REQUIRE_CONSENT === true,
    batchSize: 10, batchInterval: 5000, sessionTimeout: 30 * 60 * 1000,
    extensions: (cs && cs.getAttribute('data-extensions')) || window.CLICKINSIGHT_EXTENSIONS || 'all',
  };

  if (!config.siteId) { console.error('ClickInsight Pro: Site ID is required. Add data-site-id attribute to the script tag or set window.CLICKINSIGHT_SITE_ID before loading.'); return; }

  // Sequence counter for event ordering within a session
  let _seqCounter = 0;

  // Normalize event target (handles text nodes, SVG elements, shadow hosts)
  const _resolveEl = (node) => {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el || null;
  };

  const _getClassName = (el) => {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
    return el.getAttribute ? (el.getAttribute('class') || '') : '';
  };

  // Generate unique CSS selector for an element
  const _cssSelector = (rawEl) => {
    const el = _resolveEl(rawEl);
    if (!el || el === document.body || el === document.documentElement) return '';
    try {
      const esc = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
        ? CSS.escape
        : (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
      // ID shortcut
      if (el.id) return '#' + esc(el.id);
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 5) {
        if (!cur.tagName) break;
        let seg = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
        const dataTrack = cur.getAttribute && (cur.getAttribute('data-track-id') || cur.getAttribute('data-testid'));
        if (dataTrack) { seg += '[data-track-id="' + esc(dataTrack) + '"]'; }
        // nth-child for disambiguation
        const parent = cur.parentElement;
        if (parent && parent.children) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
          if (siblings.length > 1) seg += ':nth-child(' + (Array.from(parent.children).indexOf(cur) + 1) + ')';
        }
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join('>').replace(/^>/, '');
    } catch { return _elPath(el); }
  };

  // Minimal core utils (PII/cookie/URL handling in tracking-ext-utils.js)
  const _genId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  const _localGetCookie = (name) => {
    try {
      const m = document.cookie.match(new RegExp(
        '(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/+^])/g, '\\$1') + '=([^;]*)'
      ));
      return m ? decodeURIComponent(m[1]) : '';
    } catch { return ''; }
  };
  const _localSetCookie = (name, value, days) => {
    try {
      const d = new Date(Date.now() + days * 86400000);
      const secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? '; Secure' : '';
      document.cookie = name + '=' + encodeURIComponent(value)
        + '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax' + secure;
    } catch { /* ignore */ }
  };

  let _isFirstVisit = false;
  const _getVisitorId = () => {
    let vid = _localGetCookie('__ugk_vid');
    if (!vid) {
      vid = _localGetCookie('ci_user_id') || localStorage.getItem('ci_user_id') || _genId();
      _localSetCookie('__ugk_vid', vid, 365);
      _isFirstVisit = true;
    }
    return vid;
  };
  const _visitorId = _getVisitorId();

  const _getSession = () => {
    let sid = sessionStorage.getItem('ci_sid');
    const la = sessionStorage.getItem('ci_la');
    const now = Date.now();
    if (!sid || !la || now - parseInt(la, 10) > config.sessionTimeout) {
      sid = _genId(); sessionStorage.setItem('ci_sid', sid);
      sessionStorage.setItem('ci_sst', now.toString());
      sessionStorage.setItem('ci_spv', '0');
      sessionStorage.setItem('ci_scroll_max', '0');
      sessionStorage.setItem('ci_rage_clicks', '0');
      sessionStorage.setItem('ci_dead_clicks', '0');
      sessionStorage.setItem('ci_scroll_reversals', '0');
      sessionStorage.setItem('ci_first_visit', _isFirstVisit ? '1' : '0');
    } else {
      if (!sessionStorage.getItem('ci_sst')) sessionStorage.setItem('ci_sst', la || now.toString());
      if (sessionStorage.getItem('ci_first_visit') === null) sessionStorage.setItem('ci_first_visit', _isFirstVisit ? '1' : '0');
    }
    sessionStorage.setItem('ci_la', now.toString());
    return sid;
  };

  // userId: cookie if utils loaded, else localStorage fallback
  const _getUserId = () => {
    if (_utils.getCookie) {
      let uid = _utils.getCookie('ci_user_id');
      if (uid) return uid;
    }
    let uid = localStorage.getItem('ci_user_id');
    if (!uid) { uid = _visitorId || _genId(); localStorage.setItem('ci_user_id', uid); }
    if (_utils.setCookie) _utils.setCookie('ci_user_id', uid, 730);
    return uid;
  };

  const _vp = () => ({ width: window.innerWidth || document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight });
  const _docHeight = () => Math.max(
    (document.documentElement && document.documentElement.scrollHeight) || 0,
    (document.body && document.body.scrollHeight) || 0,
    _vp().height || 0
  );

  const _nearestSectionSelector = (rawEl) => {
    const el = _resolveEl(rawEl);
    if (!el || typeof el.closest !== 'function') return '';
    try {
      const sec = el.closest('section, article, main, header, footer, nav, aside, [data-section], [id]');
      if (!sec || sec === document.body || sec === document.documentElement) return '';
      return _cssSelector(sec);
    } catch { return ''; }
  };

  const _elPath = (rawEl) => {
    const el = _resolveEl(rawEl);
    if (!el) return '';
    const p = []; let c = el;
    while (c && c !== document.body && c !== document.documentElement && p.length < 4) {
      if (!c.tagName) break;
      let s = c.tagName.toLowerCase();
      if (c.id) { p.unshift(s+'#'+c.id); break; }
      p.unshift(s); c = c.parentElement;
    }
    return p.join('>');
  };

  const _throttle = (fn, d) => { let last = 0; return function(...a) { const n = Date.now(); if (n - last >= d) { last = n; return fn.apply(this, a); } }; };

  // Extensible utils — extensions can add sanitizePII, sanitizeUrl, getCookie, setCookie
  const _utils = { getElementPath: _elPath, getCssSelector: _cssSelector, getNearestSectionSelector: _nearestSectionSelector, getDocumentHeight: _docHeight, throttle: _throttle };

  // GA4 client_id (for BigQuery demographic join)
  const _gaClientId = (document.cookie.match(/_ga=GA\d+\.\d+\.(\d+\.\d+)/)||[])[1] || '';

  // UTM & Device
  const _p = new URLSearchParams(window.location.search);
  const _utm = { utm_source:_p.get('utm_source')||'', utm_medium:_p.get('utm_medium')||'', utm_campaign:_p.get('utm_campaign')||'', utm_term:_p.get('utm_term')||'', utm_content:_p.get('utm_content')||'', gclid:_p.get('gclid')||'', fbclid:_p.get('fbclid')||'' };
  const _devType = () => { const w = _vp().width; return w >= 1024 ? 'desktop' : w >= 768 ? 'tablet' : 'mobile'; };
  const _refType = (r) => { if (!r) return 'direct'; try { const h = new URL(r).hostname; return /google|bing|yahoo/i.test(h)?'organic':/facebook|instagram|twitter/i.test(h)?'social':'referral'; } catch { return 'direct'; } };

  // ── AXO: AI Agent detection (AXO-001 / Multi-Signal Calibrated) ───────
  // High-confidence signals (explicit Bot/AI UA, Headless UA, webdriver/phantom/nightmare)
  // trigger is_agent=1 immediately.
  // Weak environmental signals (languages_empty, chrome_missing, zero_screen, no_webgl)
  // require >= 2 weak signals to trigger is_agent=1.
  // Auxiliary signals (plugins_empty, connection_missing) are recorded in agent_signals
  // for observability, but NEVER trigger is_agent=1 on their own (prevents Mac Safari &
  // non-NetworkInformation browser false positives).
  const _detectAgent = () => {
    const ua = navigator.userAgent || '';
    const botRe = /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|Googlebot|AdsBot-Google|Mediapartners-Google|Bingbot|BingPreview|Slurp|Bytespider|CCBot|Diffbot|Amazonbot|Applebot-Extended|YouBot|cohere-ai|Meta-ExternalAgent|meta-externalads|facebookexternalhit|FacebookBot|DuckAssistBot|Mistral-Bot)/i;
    const genericBotRe = /(bot|crawl|spider|slurp|mediapartners|adsbot|bingpreview|facebookexternalhit)/i;
    const headlessRe = /(HeadlessChrome|PhantomJS|Electron|Playwright|Puppeteer|SlimerJS|Nightmare)/i;
    const m = ua.match(botRe);
    const hm = ua.match(headlessRe);
    const gm = !m && !hm ? ua.match(genericBotRe) : null;
    const mobile_ua = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const phantom_marker = Boolean(window._phantom || window.__nightmare || window.callPhantom || window._selenium || window.__webdriver_evaluate);
    const zero_screen = (window.innerWidth === 0 && window.innerHeight === 0) || (typeof screen !== 'undefined' && screen.width === 0 && screen.height === 0);
    let no_webgl = false;
    try {
      const cv = document.createElement('canvas');
      const gl = cv.getContext && (cv.getContext('webgl') || cv.getContext('experimental-webgl'));
      if (!gl) {
        no_webgl = true;
      } else if (typeof gl.getParameter === 'function') {
        const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
        if (/SwiftShader|llvmpipe|Offscreen/i.test(renderer)) no_webgl = true;
      }
    } catch { no_webgl = true; }

    const s = {
      webdriver: navigator.webdriver === true,
      phantom_marker: phantom_marker,
      plugins_empty: !navigator.plugins || navigator.plugins.length === 0,
      mobile_ua: mobile_ua,
      languages_empty: !navigator.languages || navigator.languages.length === 0,
      chrome_missing: /Chrome\//.test(ua) && !/Edge\/|Edg\/|OPR\//.test(ua) && typeof window.chrome === 'undefined',
      connection_missing: !('connection' in navigator) && /Chrome\//.test(ua),
      zero_screen: zero_screen,
      no_webgl: no_webgl,
      ua_bot_match: m ? m[1] : (gm ? gm[1] : null),
      ua_headless_match: Boolean(hm),
    };

    const strongSignals = [];
    if (s.ua_bot_match) strongSignals.push('ua:' + s.ua_bot_match);
    if (s.ua_headless_match) strongSignals.push('ua:headless');
    if (s.webdriver) strongSignals.push('webdriver');
    if (s.phantom_marker) strongSignals.push('phantom');

    const weakSignals = [];
    if (s.languages_empty) weakSignals.push('no_langs');
    if (s.chrome_missing) weakSignals.push('no_chrome_obj');
    if (s.zero_screen) weakSignals.push('zero_screen');
    if (s.no_webgl) weakSignals.push('no_webgl');

    const is_agent = (strongSignals.length >= 1 || weakSignals.length >= 2) ? 1 : 0;
    let type = '';
    if (s.ua_bot_match) type = s.ua_bot_match;
    else if (s.ua_headless_match) type = 'headless';
    else if (s.webdriver) type = 'webdriver';
    else if (s.phantom_marker) type = 'phantom';
    else if (is_agent) type = 'heuristic_multi';

    return { is_agent: is_agent, agent_type: type, agent_signals: JSON.stringify(s) };
  };
  const _agent = _detectAgent();
  try { window.CLICKINSIGHT_IS_AGENT = _agent.is_agent === 1; } catch {}

  // External ID (member/customer ID set by site owner)
  let _externalId = localStorage.getItem('ci_external_id') || null;

  // Event Queue
  const _q = []; let _bt = null;

  const queueEvent = (ev) => {
    _seqCounter++;
    const d = {
      ...ev,
      id: _genId(),
      site_id: config.siteId,
      tenant_id: config.tenantId || '',
      session_id: _getSession(),
      user_id: _getUserId(),
      visitor_id: _visitorId,
      is_first_visit: _isFirstVisit,
      external_id: _externalId || null,
      ga_client_id: _gaClientId,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      referrer: document.referrer,
      user_agent: navigator.userAgent,
      viewport_width: _vp().width,
      viewport_height: _vp().height,
      document_height: _docHeight(),
      device_type: _devType(),
      referrer_type: _refType(document.referrer),
      sequence_id: _seqCounter,
      is_agent: _agent.is_agent,
      agent_type: _agent.agent_type,
      agent_signals: _agent.agent_signals,
      ..._utm,
    };
    if (!d.site_id || d.site_id.trim() === '') return;
    _q.push(d);
    if (_q.length >= config.batchSize) sendBatch(); else if (!_bt) _bt = setTimeout(sendBatch, config.batchInterval);
  };

  const sendBatch = () => {
    if (_q.length === 0) return;
    const evts = _q.splice(0, config.batchSize);
    if (_bt) { clearTimeout(_bt); _bt = null; }
    if (evts.some(e => !e.site_id)) return;
    const data = JSON.stringify({ events: evts });
    if (navigator.sendBeacon) { const b = new Blob([data], { type: 'text/plain' }); if (!navigator.sendBeacon(config.apiEndpoint, b)) _fetch(data); } else _fetch(data);
    if (_q.length > 0) _bt = setTimeout(sendBatch, config.batchInterval);
  };

  const _fetch = (data) => { fetch(config.apiEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true }).catch(() => {}); };

  // --- Core Trackers ---
  let maxSD = 0, scrollStopT = null, readStart = null, readY = null, pageVis = true, rClicks = [];

  const _isDead = (el) => {
    let c = el;
    for (let i = 0; i < 5 && c; i++) {
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|VIDEO|AUDIO)$/.test(c.tagName)) return false;
      const r = c.getAttribute('role'); if (r==='button'||r==='link') return false;
      if (c.getAttribute('onclick')||c.getAttribute('tabindex')) return false;
      if (c.style?.cursor==='pointer') return false;
      c = c.parentElement;
    }
    return true;
  };

  const trackers = {
    click: (e) => {
      const el = _resolveEl(e.target);
      if (!el) return;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
      const sy = window.scrollY||window.pageYOffset;
      const now = Date.now(), cx = Math.round(e.clientX), cy = Math.round(e.clientY + sy);
      const dh = _docHeight(), secSel = _nearestSectionSelector(el);
      rClicks.push({ x: cx, y: cy, t: now });
      rClicks = rClicks.filter(c => now - c.t < 2000);
      const isRage = rClicks.filter(c => Math.abs(c.x-cx)<30 && Math.abs(c.y-cy)<30).length >= 3;
      const isDead = !isRage && _isDead(el);
      try { if (isRage) sessionStorage.setItem('ci_rage_clicks', String((parseInt(sessionStorage.getItem('ci_rage_clicks')||'0',10)||0)+1)); else if (isDead) sessionStorage.setItem('ci_dead_clicks', String((parseInt(sessionStorage.getItem('ci_dead_clicks')||'0',10)||0)+1)); } catch {}
      // Use sanitizePII/sanitizeUrl if utils extension loaded, else simple truncation
      const rawText = el.textContent?.trim().substring(0, 100) || '';
      const rawHref = el.href || (typeof el.closest === 'function' ? el.closest('a')?.href : '') || '';
      const tagName = el.tagName ? el.tagName.toLowerCase() : '';
      queueEvent({
        event_type: isRage ? 'rage_click' : _isDead(el) ? 'dead_click' : 'click',
        element_tag_name: tagName, element_tag: tagName, element_id: el.id||'', element_class_name: _getClassName(el),
        element_text: _utils.sanitizePII ? _utils.sanitizePII(rawText) : rawText,
        element_href: _utils.sanitizeUrl ? _utils.sanitizeUrl(rawHref) : rawHref,
        element_path: _elPath(el), element_selector: _cssSelector(el), section_selector: secSel,
        click_x: cx, click_y: cy,
        element_x: Math.round(rect.left), element_y: Math.round(rect.top + sy),
        document_height: dh,
      });
    },

    scroll: _throttle(() => {
      const sy = window.scrollY||window.pageYOffset, dh = _docHeight();
      const ms = dh - window.innerHeight, sp = ms > 0 ? Math.round((sy/ms)*100) : 0;
      if (sp > maxSD) maxSD = sp;
      queueEvent({ event_type: 'scroll', scroll_y: Math.round(sy), scroll_percentage: Math.min(100, Math.max(0, sp)), document_height: dh });
      if (scrollStopT) clearTimeout(scrollStopT);
      if (readStart && readY !== null) {
        const dur = Date.now() - readStart;
        if (dur >= 500) queueEvent({ event_type: 'read_area', read_y: Math.round(sy + (window.innerHeight/2)), read_duration: dur, document_height: dh });
        readStart = null; readY = null;
      }
      scrollStopT = setTimeout(() => { if (pageVis) { readY = Math.round(sy + (window.innerHeight/2)); readStart = Date.now(); } }, 500);
    }, 200),

    pageview: () => { _getSession(); try { const pv = (parseInt(sessionStorage.getItem('ci_spv') || '0', 10) || 0) + 1; sessionStorage.setItem('ci_spv', String(pv)); } catch {} queueEvent({ event_type: 'pageview', page_title: document.title, document_height: _docHeight() }); },

    pageleave: () => {
      const dh = _docHeight();
      if (maxSD > 0) queueEvent({ event_type: 'scroll_depth', scroll_percentage: maxSD, is_final: true, document_height: dh });
      if (readStart && readY !== null) { const d = Date.now()-readStart; if (d>=500) queueEvent({ event_type:'read_area', read_y:readY, read_duration:d, document_height: dh }); }
      for (const ext of _exts) { if (ext.flush) ext.flush(); }
      sendBatch();
    },
  };

  // --- Extension System ---
  const _exts = [];
  const registerExtension = (ext) => { _exts.push(ext); if (ext.init) ext.init(); };
  const extendUtils = (additions) => { Object.assign(_utils, additions); };

  const shouldLoad = (name) => { if (config.extensions==='all') return true; if (config.extensions==='none') return false; return config.extensions.split(',').map(s=>s.trim()).includes(name); };

  const loadExtensions = () => {
    let extBase = '/tracking-ext-';
    if (cs && cs.src) {
      try {
        const u = new URL(cs.src);
        const dir = u.pathname.replace(/[^/]+$/, '');
        extBase = u.origin + dir + 'tracking-ext-';
      } catch {}
    } else if (scriptOrigin) {
      extBase = scriptOrigin + '/tracking-ext-';
    }
    const base = extBase;
    // Utils extension loads first (provides PII/cookie/URL handling)
    const names = ['utils', 'form', 'video', 'image', 'element', 'active-time', 'behavior', 'scroll-timeline', 'spa', 'web-vitals'];
    for (const name of names) {
      if (name !== 'utils' && !shouldLoad(name)) continue;
      const s = document.createElement('script'); s.src = base + name + '.js'; s.async = true;
      s.onerror = () => { if (config.debug) console.warn('ClickInsight: ext "'+name+'" not found'); };
      document.head.appendChild(s);
    }
  };

  const init = () => {
    if (localStorage.getItem('clickinsight_optout')==='true') return;
    if (config.requireConsent && localStorage.getItem('clickinsight_cookie_consent')!=='true') return;
    trackers.pageview();
    document.addEventListener('click', trackers.click, { passive: true });
    window.addEventListener('scroll', trackers.scroll, { passive: true });
    window.addEventListener('beforeunload', trackers.pageleave);
    document.addEventListener('visibilitychange', () => {
      pageVis = !document.hidden;
      if (document.hidden) {
        if (readStart && readY !== null) { const d=Date.now()-readStart; if(d>=500) queueEvent({event_type:'read_area',read_y:readY,read_duration:d,document_height:_docHeight()}); readStart=null; readY=null; }
        if (scrollStopT) { clearTimeout(scrollStopT); scrollStopT=null; }
        sendBatch();
      }
    });
    loadExtensions();

    // GA4 dataLayer フック: キーイベント（コンバージョン）を自動キャプチャ
    const ga4KeyEvents = ['purchase','sign_up','generate_lead','begin_checkout','add_to_cart','add_payment_info','subscribe','contact','download','form_submit'];
    if (window.dataLayer && Array.isArray(window.dataLayer)) {
      // 既存のpushを上書きして監視
      const origPush = window.dataLayer.push.bind(window.dataLayer);
      window.dataLayer.push = function() {
        for (let i = 0; i < arguments.length; i++) {
          const item = arguments[i];
          if (item && typeof item === 'object') {
            const evName = item.event || item[0];
            if (evName && ga4KeyEvents.includes(evName)) {
              queueEvent({
                event_type: 'conversion',
                conversion_type: evName,
                conversion_value: item.value || item.ecommerce?.purchase?.revenue || 0,
                event_revenue: item.value || 0,
              });
            }
          }
        }
        return origPush.apply(window.dataLayer, arguments);
      };
    }
    // gtag() 呼び出しもフック
    if (window.gtag) {
      const origGtag = window.gtag;
      window.gtag = function() {
        if (arguments[0] === 'event' && ga4KeyEvents.includes(arguments[1])) {
          const params = arguments[2] || {};
          queueEvent({
            event_type: 'conversion',
            conversion_type: arguments[1],
            conversion_value: params.value || 0,
            event_revenue: params.value || 0,
          });
        }
        return origGtag.apply(this, arguments);
      };
    }
  };

  // identify: link anonymous user to external member/customer ID
  const identify = (externalId, metadata) => {
    if (!externalId || typeof externalId !== 'string') return;
    _externalId = externalId;
    localStorage.setItem('ci_external_id', externalId);
    queueEvent({ event_type: 'identify', external_id: externalId, user_metadata: JSON.stringify(metadata || {}) });
  };

  // trackConversion: fire a conversion event
  const trackConversion = (type, value) => {
    if (!type) return;
    queueEvent({ event_type: 'conversion', conversion_type: type, conversion_value: value || 0 });
  };

  // Public API
  window.ClickInsight = Object.freeze({
    track: queueEvent, flush: sendBatch, getSessionId: _getSession, getUserId: _getUserId,
    identify: identify, trackConversion: trackConversion,
    registerExtension: registerExtension, extendUtils: extendUtils,
    utils: _utils, config: Object.freeze({...config}),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
