/**
 * ClickInsight Pro - Tracking Script (Core)
 * Version: 2.1.0
 * Target: <5KB minified. Extensions add PII protection, forms, video, image, element tracking.
 */
(function() {
  'use strict';

  const getSiteId = () => {
    const cs = document.currentScript;
    if (cs) { const s = cs.getAttribute('data-site-id'); if (s) return s; }
    const all = document.querySelectorAll('script[src*="tracking.js"]');
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i].getAttribute('data-site-id');
      if (s && !all[i].dataset.ciProcessed) { all[i].dataset.ciProcessed = '1'; return s; }
    }
    if (window.CLICKINSIGHT_SITE_ID) return window.CLICKINSIGHT_SITE_ID;
    const any = document.querySelector('script[data-site-id]');
    return any ? any.getAttribute('data-site-id') : '';
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
    debug: window.CLICKINSIGHT_DEBUG || false,
    apiEndpoint: window.CLICKINSIGHT_API_URL || (scriptOrigin ? scriptOrigin + '/api/track' : '/api/track'),
    requireConsent: window.CLICKINSIGHT_REQUIRE_CONSENT === true,
    batchSize: 10, batchInterval: 5000, sessionTimeout: 30 * 60 * 1000,
    extensions: (cs && cs.getAttribute('data-extensions')) || window.CLICKINSIGHT_EXTENSIONS || 'all',
  };

  if (!config.siteId) { console.error('ClickInsight Pro: Site ID is required.'); return; }

  // Minimal core utils (PII/cookie/URL handling in tracking-ext-utils.js)
  const _genId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  const _getSession = () => {
    let sid = sessionStorage.getItem('ci_sid');
    const la = sessionStorage.getItem('ci_la');
    const now = Date.now();
    if (!sid || !la || now - parseInt(la) > config.sessionTimeout) {
      sid = _genId(); sessionStorage.setItem('ci_sid', sid);
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
  const _utils = { getElementPath: _elPath, throttle: _throttle };

  // GA4 client_id (for BigQuery demographic join)
  const _gaClientId = (document.cookie.match(/_ga=GA\d+\.\d+\.(\d+\.\d+)/)||[])[1] || '';

  // UTM & Device
  const _p = new URLSearchParams(window.location.search);
  const _utm = { utm_source:_p.get('utm_source')||'', utm_medium:_p.get('utm_medium')||'', utm_campaign:_p.get('utm_campaign')||'', utm_term:_p.get('utm_term')||'', utm_content:_p.get('utm_content')||'', gclid:_p.get('gclid')||'', fbclid:_p.get('fbclid')||'' };
  const _devType = () => { const w = _vp().width; return w >= 1024 ? 'desktop' : w >= 768 ? 'tablet' : 'mobile'; };
  const _refType = (r) => { if (!r) return 'direct'; try { const h = new URL(r).hostname; return /google|bing|yahoo/i.test(h)?'organic':/facebook|instagram|twitter/i.test(h)?'social':'referral'; } catch { return 'direct'; } };

  // External ID (member/customer ID set by site owner)
  let _externalId = localStorage.getItem('ci_external_id') || null;

  // Event Queue
  const _q = []; let _bt = null;

  const queueEvent = (ev) => {
    const d = { ...ev, id: _genId(), site_id: config.siteId, session_id: _getSession(), user_id: _getUserId(), external_id: _externalId || null, ga_client_id: _gaClientId, timestamp: new Date().toISOString(), url: window.location.href, referrer: document.referrer, user_agent: navigator.userAgent, viewport_width: _vp().width, viewport_height: _vp().height, device_type: _devType(), referrer_type: _refType(document.referrer), ..._utm };
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
    if (navigator.sendBeacon) { const b = new Blob([data], { type: 'application/json' }); if (!navigator.sendBeacon(config.apiEndpoint, b)) _fetch(data); } else _fetch(data);
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
        element_path: _elPath(el), click_x: cx, click_y: cy,
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

    pageview: () => { queueEvent({ event_type: 'pageview', page_title: document.title }); },

    pageleave: () => {
      if (maxSD > 0) queueEvent({ event_type: 'scroll_depth', scroll_percentage: maxSD, is_final: true });
      if (readStart && readY !== null) { const d = Date.now()-readStart; if (d>=500) queueEvent({ event_type:'read_area', read_y:readY, read_duration:d }); }
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
    const base = scriptOrigin ? scriptOrigin + '/tracking-ext-' : '/tracking-ext-';
    // Utils extension loads first (provides PII/cookie/URL handling)
    const names = ['utils', 'form', 'video', 'image', 'element', 'active-time'];
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
        if (readStart && readY !== null) { const d=Date.now()-readStart; if(d>=500) queueEvent({event_type:'read_area',read_y:readY,read_duration:d}); readStart=null; readY=null; }
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
