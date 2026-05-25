/**
 * ClickInsight Pro - Tracking Script (Core)
 * Version: 2.3.0+saas-b1 (B-1 流用 from ugokimap/public/tracking.js、2026-05-17)
 * Target: <15KB minified. Extensions add PII protection, forms, video, image, element tracking.
 *
 * v2.2.0: AXO (Agent Experience Optimization) — AIエージェント検知シグナルを全イベントに付与。
 * v2.3.0: AXO 観察シグナル 5 種追加 (PM Task 2 Layer B v0.2 確定):
 *         1. agent_signals 複合値 JSON 化
 *         2. scroll_anchor_hit (h1-h6 到達順 + 停止時間)
 *         3. text_node_dwell (テキストノード滞在 + コピー/選択)
 *         4. alt_read_signal (画像 alt 参照検知)
 *         5. _detectStealth (webdriver パッチ対策二次シグナル、記録のみ)
 *         PM決定 2026-04-15 / strategy/12_agent_experience_optimization.md v0.2 準拠。
 *
 * v2.4.0+sprint4-w1: Director 続 82 Sprint 4 W1 (bounce/organic/visitor 復活)
 *         1. __ugk_vid first-party cookie (UUID v4、365日 TTL、SameSite=Lax、Secure)
 *         2. is_first_visit flag (visitor_id cookie が新規発行された時 true)
 *         3. session start ts + page_views_in_session counter (sessionStorage 永続化)
 *         4. session_end event (visibilitychange hidden 30s タイマー / beforeunload で発火)
 *            payload: session_duration_sec + page_views_in_session
 *         5. event payload に visitor_id / is_first_visit / session_duration_sec /
 *            page_views_in_session 列を追加 (ClickHouse events table の v2 列に対応)
 *         参照: handoff/2026-05-25-infra-sprint4-w1-tracking-schema-v2.md §2.1
 *
 * SaaS 流用 (B-1、decisions.md L275 続 14 / L162 続 15 §4.4 BR1): multi-tenant 化に伴い
 * data-tenant-id 必須化:
 *   <script src=".../tracking.js" data-site-id="..." data-tenant-id="linkth_internal" defer></script>
 *   data-tenant-id 不在時は console.error + 早期 return (sendBeacon 抑止、silent drop)。
 *   クエリ string 代替: <script src=".../tracking.js?tenant_id=linkth_internal" ...>
 *   全イベント payload に tenant_id を含めて Cloudflare Workers (event-ingest) へ送出、
 *   Workers が `clickinsight.events.tenant_id` 列 (LowCardinality(String) DEFAULT '') に書込。
 *
 * Wave 3-C R7-9 (続 36 §1.2、続 42 統合): client-side observability
 *   §1.2.1 debug mode: ?ugoki_debug=1 で sendBeacon を skip し fetch 経由で response.status 観測
 *   §1.2.2 5% sampling: sendBeacon 成功時の 5% で /api/audit-telemetry に audit beacon 送信
 *   §1.2.3 sendBeacon 失敗時 100% audit beacon: navigator.sendBeacon が false を返す全件で
 *          audit beacon を強制送信 (sampling 対象外)
 *   audit endpoint: window.CLICKINSIGHT_AUDIT_URL or scriptOrigin + '/api/audit-telemetry'
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
    // 4. URL query parameter on script src (e.g. tracking.js?id=CIP_xxx)
    for (let i = all.length - 1; i >= 0; i--) {
      try { const u = new URL(all[i].src); const id = u.searchParams.get('id') || u.searchParams.get('site_id'); if (id) return id; } catch {}
    }
    // 5. Any element with data-site-id
    const any = document.querySelector('script[data-site-id]');
    return any ? any.getAttribute('data-site-id') : '';
  };

  // B-1 (続 14 §3.1 / 続 15 §4.4 BR1): data-tenant-id 必須化、未指定時は呼び出し側で抑止
  const getTenantId = () => {
    // 1. data-tenant-id attribute on current script
    const cs = document.currentScript;
    if (cs) { const t = cs.getAttribute('data-tenant-id'); if (t) return t; }
    // 2. data-tenant-id on any tracking.js script tag
    const all = document.querySelectorAll('script[src*="tracking.js"]');
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i].getAttribute('data-tenant-id');
      if (t) return t;
    }
    // 3. Global variable (set before script load or via GTM)
    if (window.CLICKINSIGHT_TENANT_ID) return window.CLICKINSIGHT_TENANT_ID;
    // 4. URL query parameter on script src (e.g. tracking.js?tenant_id=linkth_internal) — クエリ string 代替
    for (let i = all.length - 1; i >= 0; i--) {
      try { const u = new URL(all[i].src); const t = u.searchParams.get('tenant_id'); if (t) return t; } catch {}
    }
    // 5. Any element with data-tenant-id (fallback for non-script attribute)
    const any = document.querySelector('script[data-tenant-id]');
    return any ? any.getAttribute('data-tenant-id') : '';
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

  // Wave 3-C R7-9 (続 36 §1.2.1): debug mode 検知。URL ?ugoki_debug=1 で fetch 経路 + console.log。
  // SPA history.pushState 後でも window.location.search 経由で再評価可能だが初期化時固定でも要件 OK。
  const _debugMode = (() => {
    try { return new URL(window.location.href).searchParams.get('ugoki_debug') === '1'; }
    catch { return false; }
  })();

  // Wave 3-C R7-9 (続 36 §1.2.2 + §1.2.3): audit telemetry endpoint。
  // 既定は scriptOrigin + '/api/audit-telemetry' (SaaS UI 側 Next.js Route Handler)。
  // 顧客サイト埋込のため Sentry SDK 依存禁止、SaaS 側 route handler で Sentry breadcrumb 化。
  const _auditEndpoint = window.CLICKINSIGHT_AUDIT_URL
    || (scriptOrigin ? scriptOrigin + '/api/audit-telemetry' : '/api/audit-telemetry');

  const config = {
    siteId: getSiteId(),
    tenantId: getTenantId(),
    debug: window.CLICKINSIGHT_DEBUG || _debugMode || false,
    apiEndpoint: window.CLICKINSIGHT_API_URL || 'https://ugokimap-event-ingest.linkth.workers.dev/api/track',
    auditEndpoint: _auditEndpoint,
    debugMode: _debugMode,
    samplingRate: 0.05,
    requireConsent: window.CLICKINSIGHT_REQUIRE_CONSENT === true,
    batchSize: 10, batchInterval: 5000, sessionTimeout: 30 * 60 * 1000,
    extensions: (cs && cs.getAttribute('data-extensions')) || window.CLICKINSIGHT_EXTENSIONS || 'all',
  };

  if (!config.siteId) { console.error('ClickInsight Pro: Site ID is required. Add data-site-id attribute to the script tag or set window.CLICKINSIGHT_SITE_ID before loading.'); return; }
  // B-1: tenant_id 必須化 — multi-tenant 分離のため未指定時は sendBeacon を抑止 (silent drop)。
  // 続 14 R3 / S2.5 audit の「空文字書込検知」を未然防止する。
  if (!config.tenantId) { console.error('ClickInsight Pro: Tenant ID is required. Add data-tenant-id attribute (or ?tenant_id= query parameter) to the tracking.js script tag. See decisions.md L162 BR1.'); return; }

  // Sequence counter for event ordering within a session
  let _seqCounter = 0;

  // Generate unique CSS selector for an element
  const _cssSelector = (el) => {
    if (!el || el === document.body || el === document.documentElement) return '';
    try {
      // ID shortcut
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 5) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + CSS.escape(cur.id) + '>' + seg.split('>').pop()); parts.unshift(''); break; }
        // nth-child for disambiguation
        const parent = cur.parentElement;
        if (parent) {
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

  // Sprint 4 W1 (続 82): local cookie helpers (tracking-ext-utils.js 非依存)
  //   __ugk_vid を最早期に評価するため、extension 読込前でも動作する組込 helper を保持。
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

  // Sprint 4 W1 (続 82): __ugk_vid first-party cookie + is_first_visit
  //   先に_isFirstVisit を確定させてから queueEvent に注入できるよう init より前に評価。
  let _isFirstVisit = false;
  const _getVisitorId = () => {
    let vid = _localGetCookie('__ugk_vid');
    if (!vid) {
      vid = _genId();
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
    if (!sid || !la || now - parseInt(la) > config.sessionTimeout) {
      sid = _genId();
      sessionStorage.setItem('ci_sid', sid);
      // Sprint 4 W1 (続 82): 新規 session 開始時に start ts + page_views counter を reset
      sessionStorage.setItem('ci_sst', String(now));
      sessionStorage.setItem('ci_spv', '0');
      _sessionEndSent = false;  // 新規 session に切替時は session_end 再発火可能に
    }
    sessionStorage.setItem('ci_la', now.toString());
    return sid;
  };

  // Sprint 4 W1 (続 82): session-level helpers
  const _getSessionStartTs = () => parseInt(sessionStorage.getItem('ci_sst') || '0', 10) || Date.now();
  const _getPageViewsInSession = () => parseInt(sessionStorage.getItem('ci_spv') || '0', 10);
  const _incrementPageViewsInSession = () => {
    const next = _getPageViewsInSession() + 1;
    sessionStorage.setItem('ci_spv', String(next));
    return next;
  };
  let _sessionEndSent = false;
  let _hiddenTimer = null;

  // userId: cookie if utils loaded, else localStorage fallback
  const _getUserId = () => {
    if (_utils.getCookie) {
      let uid = _utils.getCookie('ci_user_id');
      if (uid) return uid;
    }
    let uid = localStorage.getItem('ci_user_id');
    if (!uid) { uid = _genId(); localStorage.setItem('ci_user_id', uid); }
    if (_utils.setCookie) _utils.setCookie('ci_user_id', uid, 730);
    return uid;
  };

  const _vp = () => ({ width: window.innerWidth || document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight });

  const _elPath = (el) => {
    if (!el) return '';
    const p = []; let c = el;
    while (c && c !== document.body && p.length < 4) {
      let s = c.tagName.toLowerCase();
      if (c.id) { p.unshift(s+'#'+c.id); break; }
      p.unshift(s); c = c.parentElement;
    }
    return p.join('>');
  };

  const _throttle = (fn, d) => { let last = 0; return function(...a) { const n = Date.now(); if (n - last >= d) { last = n; return fn.apply(this, a); } }; };

  // Extensible utils — extensions can add sanitizePII, sanitizeUrl, getCookie, setCookie
  const _utils = { getElementPath: _elPath, getCssSelector: _cssSelector, throttle: _throttle };

  // GA4 client_id (for BigQuery demographic join)
  const _gaClientId = (document.cookie.match(/_ga=GA\d+\.\d+\.(\d+\.\d+)/)||[])[1] || '';

  // UTM & Device
  const _p = new URLSearchParams(window.location.search);
  const _utm = { utm_source:_p.get('utm_source')||'', utm_medium:_p.get('utm_medium')||'', utm_campaign:_p.get('utm_campaign')||'', utm_term:_p.get('utm_term')||'', utm_content:_p.get('utm_content')||'', gclid:_p.get('gclid')||'', fbclid:_p.get('fbclid')||'' };
  const _devType = () => { const w = _vp().width; return w >= 1024 ? 'desktop' : w >= 768 ? 'tablet' : 'mobile'; };
  const _refType = (r) => { if (!r) return 'direct'; try { const h = new URL(r).hostname; return /google|bing|yahoo/i.test(h)?'organic':/facebook|instagram|twitter/i.test(h)?'social':'referral'; } catch { return 'direct'; } };

  // ── AXO: AI Agent detection (AXO-001) ───────────────────────────────
  // Client-side signals only. Runs once at load. Server-side detection
  // (UA / IP range) is done downstream via SQL on user_agent column.
  // See: docs/fusion/strategy/12_agent_experience_optimization.md
  const _detectAgent = () => {
    const ua = navigator.userAgent || '';
    const botRe = /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|Googlebot|Bingbot|Bytespider|CCBot|Diffbot|Amazonbot|Applebot-Extended|YouBot|cohere-ai|Meta-ExternalAgent|FacebookBot|DuckAssistBot|Mistral-Bot)/i;
    const m = ua.match(botRe);
    // v2.3: 複合値 JSON オブジェクト (Task 3 優先 1)
    const s = {
      webdriver: navigator.webdriver === true,
      plugins_empty: !navigator.plugins || navigator.plugins.length === 0,
      languages_empty: !navigator.languages || navigator.languages.length === 0,
      chrome_missing: /Chrome\//.test(ua) && typeof window.chrome === 'undefined',
      connection_missing: !('connection' in navigator) && /Chrome\//.test(ua),
      ua_bot_match: m ? m[1] : null,
      ua_headless_match: /HeadlessChrome|PhantomJS|Electron|Playwright|Puppeteer/i.test(ua),
    };
    const hit = s.webdriver || s.plugins_empty || s.languages_empty || s.chrome_missing || s.connection_missing || s.ua_bot_match || s.ua_headless_match;
    const is_agent = hit ? 1 : 0;
    let type = '';
    if (s.ua_bot_match) type = s.ua_bot_match;
    else if (s.ua_headless_match) type = 'headless';
    else if (is_agent) type = 'unknown';
    return { is_agent: is_agent, agent_type: type, agent_signals: JSON.stringify(s) };
  };
  const _agent = _detectAgent();

  // v2.3 Task 3 優先 5: Stealth 検知 (webdriver パッチ済み自律エージェント)
  // is_agent フラグには影響させず stealth_score / stealth_signals を独立記録。Phase 2 でしきい値調整。
  const _detectStealth = () => {
    const sig = {};
    let score = 0;
    try {
      // a. performance.now() 精度 mitigation 検知 (通常 0.1ms、Firefox+ strict=1ms)
      const samples = [];
      for (let i = 0; i < 20; i++) samples.push(performance.now());
      const diffs = [];
      for (let i = 1; i < samples.length; i++) {
        const d = samples[i] - samples[i - 1];
        if (d > 0) diffs.push(d);
      }
      const hasSubMs = diffs.some(d => d > 0 && d < 1);
      sig.perf_now_sub_ms = hasSubMs;
      if (!hasSubMs && diffs.length > 0) score += 15;
    } catch { /* ignore */ }
    try {
      // c. CDP 痕跡: cdc_* プロパティ (Selenium/Playwright/Puppeteer マーカー)
      const keys = Object.getOwnPropertyNames(window);
      const cdcMatches = keys.filter(k => /^cdc_/.test(k));
      sig.cdc_markers = cdcMatches.length;
      if (cdcMatches.length > 0) score += 40;
      // Playwright-specific
      sig.playwright_marker = '__playwright__' in window || '__pw_manualMouseTrackingEnabled__' in window;
      if (sig.playwright_marker) score += 30;
      // Puppeteer-specific
      sig.puppeteer_marker = '_puppeteer_' in window || '__puppeteer_evaluation_script__' in window;
      if (sig.puppeteer_marker) score += 30;
    } catch { /* ignore */ }
    try {
      // d. chrome.runtime 存在だが extension 未読込み (headless 典型)
      sig.chrome_runtime_noop = typeof window.chrome !== 'undefined' && !!window.chrome.runtime && typeof window.chrome.runtime.sendMessage !== 'function';
      if (sig.chrome_runtime_noop) score += 10;
    } catch { /* ignore */ }
    try {
      // e. navigator prototype 改変検知 (webdriver プロパティの記述子が null でない = パッチ痕跡)
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
      sig.webdriver_patched = !!(desc && desc.get && desc.get.toString().indexOf('[native code]') === -1);
      if (sig.webdriver_patched) score += 50;
    } catch { /* ignore */ }
    return { stealth_score: Math.min(100, score), stealth_signals: JSON.stringify(sig) };
  };
  const _stealth = _detectStealth();

  // External ID (member/customer ID set by site owner)
  let _externalId = localStorage.getItem('ci_external_id') || null;

  // Event Queue
  const _q = []; let _bt = null;

  const queueEvent = (ev) => {
    _seqCounter++;
    // Sprint 4 W1 (続 82): visitor_id / is_first_visit を全 event に注入
    //   session_end event は別途 session_duration_sec / page_views_in_session を含めて queueEvent 呼出。
    const d = { ...ev, id: _genId(), site_id: config.siteId, tenant_id: config.tenantId, session_id: _getSession(), user_id: _getUserId(), visitor_id: _visitorId, is_first_visit: _isFirstVisit, external_id: _externalId || null, ga_client_id: _gaClientId, timestamp: new Date().toISOString(), url: window.location.href, referrer: document.referrer, user_agent: navigator.userAgent, viewport_width: _vp().width, viewport_height: _vp().height, device_type: _devType(), referrer_type: _refType(document.referrer), sequence_id: _seqCounter, is_agent: _agent.is_agent, agent_type: _agent.agent_type, agent_signals: _agent.agent_signals, stealth_score: _stealth.stealth_score, stealth_signals: _stealth.stealth_signals, ..._utm };
    if (!d.site_id || d.site_id.trim() === '') return;
    // B-1: tenant_id 拾い忘れ防御 — 起動時 check で抑止済だが二重ガード (続 14 R3)
    if (!d.tenant_id || d.tenant_id.trim() === '') return;
    _q.push(d);
    if (_q.length >= config.batchSize) sendBatch(); else if (!_bt) _bt = setTimeout(sendBatch, config.batchInterval);
  };

  // Wave 3-C R7-9 audit beacon (続 36 §1.2.2 + §1.2.3 + §1.2.1):
  //   失敗時 100% / 成功時 5% sampling / debug mode 100% で /api/audit-telemetry に送信。
  //   SaaS UI 側 Next.js Route Handler が ClickHouse audit_telemetry table に書込 + Sentry breadcrumb 化。
  const _auditBeacon = (payload) => {
    if (!config.auditEndpoint) return;
    try {
      const body = JSON.stringify(payload);
      // debug mode 時は sendBeacon を skip して response 観測可能な fetch 経由のみ
      if (navigator.sendBeacon && !config.debugMode) {
        const b = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(config.auditEndpoint, b);
      } else {
        fetch(config.auditEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch { /* ignore audit beacon failure to avoid affecting primary ingest */ }
  };

  const _auditPayload = (status, reason, beaconAttempt, payloadSize) => ({
    tracking_id: config.siteId,
    tenant_id: config.tenantId,
    status,
    reason,
    sampled_at: new Date().toISOString(),
    beacon_attempt: beaconAttempt,
    payload_size: payloadSize,
  });

  const sendBatch = () => {
    if (_q.length === 0) return;
    const evts = _q.splice(0, config.batchSize);
    if (_bt) { clearTimeout(_bt); _bt = null; }
    if (evts.some(e => !e.site_id || !e.tenant_id)) return;
    const data = JSON.stringify({ events: evts });
    const payloadSize = data.length;

    if (config.debugMode) {
      // Wave 3-C §1.2.1: debug mode は fetch 経由で response.status + body 観測
      _fetchDebug(data, payloadSize);
    } else if (navigator.sendBeacon) {
      const b = new Blob([data], { type: 'text/plain' });
      const ok = navigator.sendBeacon(config.apiEndpoint, b);
      if (!ok) {
        // Wave 3-C §1.2.3: sendBeacon 失敗時 100% audit beacon (sampling 対象外)
        _auditBeacon(_auditPayload(0, 'sendBeacon_returned_false', 'sendBeacon_failed', payloadSize));
        _fetch(data);
      } else if (Math.random() < config.samplingRate) {
        // Wave 3-C §1.2.2: 5% sampling telemetry on success
        _auditBeacon(_auditPayload(200, 'sampled_success', 'sendBeacon', payloadSize));
      }
    } else {
      _fetch(data);
    }

    if (_q.length > 0) _bt = setTimeout(sendBatch, config.batchInterval);
  };

  const _fetch = (data) => {
    fetch(config.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      keepalive: true,
    }).catch(() => {});
  };

  // Wave 3-C §1.2.1: debug mode 専用 fetch 経路。response.status + body を console.log + audit beacon。
  const _fetchDebug = (data, payloadSize) => {
    fetch(config.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      keepalive: true,
    })
      .then((r) => r.text().then((t) => ({ status: r.status, text: t })))
      .then(({ status, text }) => {
        let reason = 'ok';
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            if (parsed.reason) reason = String(parsed.reason).slice(0, 64);
            else if (parsed.dropped > 0) reason = 'dropped_' + parsed.dropped;
            else if (parsed.received >= 0) reason = 'received_' + parsed.received;
          }
        } catch { /* response not JSON, keep reason='ok' */ }
        // eslint-disable-next-line no-console -- debug mode 専用、本番では _debugMode=false で発火しない
        console.log('[ClickInsight Debug]', {
          status, reason, payload_size: payloadSize,
          response_head: text.slice(0, 200),
        });
        _auditBeacon(_auditPayload(status, reason, 'fetch', payloadSize));
      })
      .catch((err) => {
        const msg = err && err.message ? String(err.message).slice(0, 64) : 'unknown';
        // eslint-disable-next-line no-console -- debug mode 専用
        console.warn('[ClickInsight Debug] fetch failed', msg);
        _auditBeacon(_auditPayload(0, 'fetch_network_error', 'fetch', payloadSize));
      });
  };

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
      const el = e.target, rect = el.getBoundingClientRect(), sy = window.scrollY||window.pageYOffset;
      const now = Date.now(), cx = Math.round(e.clientX), cy = Math.round(e.clientY + sy);
      rClicks.push({ x: cx, y: cy, t: now });
      rClicks = rClicks.filter(c => now - c.t < 2000);
      const isRage = rClicks.filter(c => Math.abs(c.x-cx)<30 && Math.abs(c.y-cy)<30).length >= 3;
      // Use sanitizePII/sanitizeUrl if utils extension loaded, else simple truncation
      const rawText = el.textContent?.trim().substring(0, 100) || '';
      const rawHref = el.href || el.closest('a')?.href || '';
      queueEvent({
        event_type: isRage ? 'rage_click' : _isDead(el) ? 'dead_click' : 'click',
        element_tag_name: el.tagName.toLowerCase(), element_id: el.id||'', element_class_name: el.className||'',
        element_text: _utils.sanitizePII ? _utils.sanitizePII(rawText) : rawText,
        element_href: _utils.sanitizeUrl ? _utils.sanitizeUrl(rawHref) : rawHref,
        element_path: _elPath(el), element_selector: _cssSelector(el), click_x: cx, click_y: cy,
        element_x: Math.round(rect.left), element_y: Math.round(rect.top + sy),
      });
    },

    scroll: _throttle(() => {
      const sy = window.scrollY||window.pageYOffset, dh = document.documentElement.scrollHeight;
      const ms = dh - window.innerHeight, sp = ms > 0 ? Math.round((sy/ms)*100) : 0;
      if (sp > maxSD) maxSD = sp;
      queueEvent({ event_type: 'scroll', scroll_y: Math.round(sy), scroll_percentage: Math.min(100, Math.max(0, sp)) });
      if (scrollStopT) clearTimeout(scrollStopT);
      if (readStart && readY !== null) {
        const dur = Date.now() - readStart;
        if (dur >= 500) queueEvent({ event_type: 'read_area', read_y: Math.round(sy + (window.innerHeight/2)), read_duration: dur });
        readStart = null; readY = null;
      }
      scrollStopT = setTimeout(() => { if (pageVis) { readY = Math.round(sy + (window.innerHeight/2)); readStart = Date.now(); } }, 500);
    }, 200),

    pageview: () => {
      // Sprint 4 W1 (続 82): session 内 page view 数を increment (session_end で集計)
      _incrementPageViewsInSession();
      queueEvent({ event_type: 'pageview', page_title: document.title });
    },

    pageleave: () => {
      if (maxSD > 0) queueEvent({ event_type: 'scroll_depth', scroll_percentage: maxSD, is_final: true });
      if (readStart && readY !== null) { const d = Date.now()-readStart; if (d>=500) queueEvent({ event_type:'read_area', read_y:readY, read_duration:d }); }
      for (const ext of _exts) { if (ext.flush) ext.flush(); }
      // Sprint 4 W1 (続 82): beforeunload で session_end 発火 (best-effort、sendBeacon)
      _fireSessionEnd('beforeunload');
      sendBatch();
    },
  };

  // Sprint 4 W1 (続 82): session_end event 発火
  //   呼出元: visibilitychange hidden 30s タイマー / beforeunload / 30 分 inactivity (新規 session 切替時は古い session 分は loss)
  //   payload: session_duration_sec (start_ts からの実滞在秒) + page_views_in_session
  //   is_bounce は ClickHouse 側 (sessions_hourly MV) で derive、tracking-js は送らない。
  const _fireSessionEnd = (reason) => {
    if (_sessionEndSent) return;
    _sessionEndSent = true;
    try {
      const now = Date.now();
      const startTs = _getSessionStartTs();
      const durationSec = Math.max(0, Math.round((now - startTs) / 1000));
      const pvCount = _getPageViewsInSession();
      queueEvent({
        event_type: 'session_end',
        session_duration_sec: durationSec,
        page_views_in_session: pvCount,
        session_end_reason: String(reason || 'unknown').slice(0, 32),
      });
    } catch { /* ignore, session_end は best-effort */ }
  };

  // --- Extension System ---
  const _exts = [];
  const registerExtension = (ext) => { _exts.push(ext); if (ext.init) ext.init(); };
  const extendUtils = (additions) => { Object.assign(_utils, additions); };

  const shouldLoad = (name) => { if (config.extensions==='all') return true; if (config.extensions==='none') return false; return config.extensions.split(',').map(s=>s.trim()).includes(name); };

  const loadExtensions = () => {
    // 続 82-completed bug fix (2026-05-25): scriptOrigin (origin only) だと /v2/ 等のサブディレクトリ
    // 配置時に extension URL が `/tracking-ext-*.js` (root) になり 404 → Chrome ORB で全 extension block。
    // 修正: script の directory (origin + path up to last '/') を base にする。
    // 例: scriptSrc = "https://host/v2/tracking.js?id=X" → extBase = "https://host/v2/tracking-ext-"
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

    // ===== v2.3 AXO 観察シグナル =====

    // Task 3 優先 2: scroll_anchor_hit (h1-h6 到達順 + 停止時間)
    try {
      let _anchorSeq = 0;
      const _anchorState = new WeakMap();
      const _anchorObs = new IntersectionObserver((entries) => {
        const now = Date.now();
        entries.forEach(en => {
          const st = _anchorState.get(en.target) || { enterT: 0, seq: 0 };
          if (en.isIntersecting) {
            st.enterT = now;
            _anchorState.set(en.target, st);
          } else if (st.enterT) {
            const dwell = now - st.enterT;
            if (dwell >= 500) {
              _anchorSeq++;
              const el = en.target;
              const rect = el.getBoundingClientRect();
              queueEvent({
                event_type: 'scroll_anchor_hit',
                anchor_tag: el.tagName.toLowerCase(),
                anchor_text: (el.textContent || '').trim().substring(0, 80),
                anchor_y: Math.round(rect.top + (window.scrollY || window.pageYOffset)),
                dwell_ms: dwell,
                seq_in_session: _anchorSeq,
                element_selector: _cssSelector(el),
              });
            }
            st.enterT = 0;
            _anchorState.set(en.target, st);
          }
        });
      }, { threshold: 0.5 });
      document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => _anchorObs.observe(h));
    } catch { /* ignore */ }

    // Task 3 優先 4: alt_read_signal (画像 alt 参照検知 + hover/focus)
    try {
      // v2.3 Reviewer Medium 1 fix: WeakMap + Set で DOM 強参照リーク防止
      const _altState = new WeakMap(); // img -> { src, alt, count, methods }
      const _altElements = new Set();  // iterable tracker (WeakMap 非 iterable 補助)
      const _piiRe = /([\w.+-]+@[\w-]+\.[\w.-]+)|(\d{3,4}-?\d{3,4}-?\d{3,4})|(\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})/g;
      const _redact = (s) => (s || '').replace(_piiRe, 'REDACTED');
      // Pre-capture src+alt at init to avoid getter recursion
      const _recordAltRead = (img, method) => {
        if (!img || !img.tagName || img.tagName !== 'IMG') return;
        const rec = _altState.get(img);
        if (!rec) return; // not hooked (added later via DOM mutation) — skip
        rec.count++;
        rec.methods[method] = (rec.methods[method] || 0) + 1;
      };
      // Hook: JS get of alt property
      document.querySelectorAll('img').forEach(img => {
        try {
          const origAlt = img.getAttribute('alt') || '';
          const origSrc = img.getAttribute('src') || '';
          _altState.set(img, { src: origSrc.substring(0, 500), alt: _redact(origAlt).substring(0, 200), count: 0, methods: {} });
          _altElements.add(img);
          Object.defineProperty(img, 'alt', {
            configurable: true,
            get() { _recordAltRead(img, 'js_get'); return origAlt; },
            set(v) { /* noop, keep original */ },
          });
        } catch { /* property may be non-configurable */ }
      });
      // Hook: hover / focus events
      document.addEventListener('mouseover', (e) => { if (e.target && e.target.tagName === 'IMG') _recordAltRead(e.target, 'hover'); }, { passive: true, capture: true });
      document.addEventListener('focusin', (e) => { if (e.target && e.target.tagName === 'IMG') _recordAltRead(e.target, 'focus'); }, { passive: true });
      // Flush on page leave
      window.addEventListener('beforeunload', () => {
        _altElements.forEach((img) => {
          const rec = _altState.get(img);
          if (!rec || rec.count === 0) return;
          queueEvent({
            event_type: 'alt_read_signal',
            image_src: (rec.src || '').substring(0, 500),
            image_alt: rec.alt,
            read_count: rec.count,
            read_methods: JSON.stringify(rec.methods),
          });
        });
        _altElements.clear();
      });
    } catch { /* ignore */ }

    // Task 3 優先 3: text_node_dwell (テキストノード滞在 + 選択 + コピー)
    try {
      // v2.3 Reviewer Medium 1 fix: WeakMap + Set で DOM 強参照リーク防止
      const _textState = new WeakMap(); // element -> { text, dwell_ms, events }
      const _textElements = new Set();  // iterable tracker
      const _piiRe2 = /([\w.+-]+@[\w-]+\.[\w.-]+)|(\d{3,4}-?\d{3,4}-?\d{3,4})|(\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})/g;
      const _redact2 = (s) => (s || '').replace(_piiRe2, 'REDACTED');
      let _hoverEl = null, _hoverStart = 0;
      const _record = (el, method) => {
        if (!el || !el.tagName) return;
        let rec = _textState.get(el);
        if (!rec) {
          rec = { text: _redact2((el.textContent || '').trim()).substring(0, 100), dwell_ms: 0, events: {} };
          _textState.set(el, rec);
          _textElements.add(el);
        }
        rec.events[method] = (rec.events[method] || 0) + 1;
      };
      document.addEventListener('mouseover', (e) => {
        const el = e.target;
        if (!el || !el.tagName) return;
        if (!/^(P|SPAN|DIV|LI|TD|TH|A|H1|H2|H3|H4|H5|H6|ARTICLE|SECTION|BLOCKQUOTE|FIGCAPTION)$/.test(el.tagName)) return;
        _hoverEl = el; _hoverStart = Date.now();
        _record(el, 'mouseover');
      }, { passive: true, capture: true });
      document.addEventListener('mouseout', () => {
        if (_hoverEl && _hoverStart) {
          const dwell = Date.now() - _hoverStart;
          if (dwell >= 100) {
            const rec = _textState.get(_hoverEl);
            if (rec) rec.dwell_ms += dwell;
          }
          _hoverEl = null; _hoverStart = 0;
        }
      }, { passive: true, capture: true });
      document.addEventListener('selectionchange', () => {
        try {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) return;
          const node = sel.anchorNode && sel.anchorNode.parentElement;
          if (node) _record(node, 'selection');
        } catch { /* ignore */ }
      });
      document.addEventListener('copy', (e) => {
        try {
          const sel = window.getSelection();
          const node = sel && sel.anchorNode && sel.anchorNode.parentElement;
          if (node) _record(node, 'copy');
        } catch { /* ignore */ }
      }, { passive: true });
      // Flush on page leave
      window.addEventListener('beforeunload', () => {
        _textElements.forEach((el) => {
          const rec = _textState.get(el);
          if (!rec) return;
          const hits = Object.values(rec.events).reduce((a, b) => a + b, 0);
          if (hits === 0 && rec.dwell_ms < 100) return;
          queueEvent({
            event_type: 'text_node_dwell',
            text_excerpt: rec.text,
            element_selector: _cssSelector(el),
            dwell_ms: rec.dwell_ms,
            event_count: hits,
            event_breakdown: JSON.stringify(rec.events),
          });
        });
        _textElements.clear();
      });
    } catch { /* ignore */ }

    document.addEventListener('visibilitychange', () => {
      pageVis = !document.hidden;
      if (document.hidden) {
        if (readStart && readY !== null) { const d=Date.now()-readStart; if(d>=500) queueEvent({event_type:'read_area',read_y:readY,read_duration:d}); readStart=null; readY=null; }
        if (scrollStopT) { clearTimeout(scrollStopT); scrollStopT=null; }
        sendBatch();
        // Sprint 4 W1 (続 82): hidden 状態が 30s 続いたら session_end を fire (handoff §2.1)
        //   beforeunload に届かないケース (SPA 内 hash 遷移後の close 等) を救う best-effort path。
        if (_hiddenTimer) clearTimeout(_hiddenTimer);
        _hiddenTimer = setTimeout(() => {
          if (document.hidden) {
            _fireSessionEnd('visibility_hidden_30s');
            sendBatch();
          }
        }, 30000);
      } else {
        // visible に戻った時は pending timer を cancel (session 継続中)
        if (_hiddenTimer) { clearTimeout(_hiddenTimer); _hiddenTimer = null; }
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
