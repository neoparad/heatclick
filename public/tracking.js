/**
 * ClickInsight Pro - Tracking Script (Core)
 * Version: 2.0.0
 * Lightweight core (~5KB) with async extension loading
 * Supports: pageview, click, scroll, read_area, dead_click, rage_click
 * Extensions loaded on demand: form, video, image, element-visibility, active-time
 */

(function() {
  'use strict';

  // Get site ID from multiple sources (priority order)
  const getSiteId = () => {
    const currentScript = document.currentScript;
    if (currentScript) {
      const siteId = currentScript.getAttribute('data-site-id');
      if (siteId) return siteId;
    }

    const allTrackingScripts = Array.from(document.querySelectorAll('script[src*="tracking.js"]'));
    for (let i = allTrackingScripts.length - 1; i >= 0; i--) {
      const script = allTrackingScripts[i];
      const siteId = script.getAttribute('data-site-id');
      if (siteId && !script.dataset.ciProcessed) {
        script.dataset.ciProcessed = Date.now().toString();
        return siteId;
      }
    }

    if (window.CLICKINSIGHT_SITE_ID) return window.CLICKINSIGHT_SITE_ID;

    const anyScript = document.querySelector('script[data-site-id]');
    if (anyScript) return anyScript.getAttribute('data-site-id');

    return '';
  };

  const getScriptOrigin = () => {
    if (document.currentScript && document.currentScript.src) {
      try { return new URL(document.currentScript.src).origin; } catch {}
    }
    const scripts = document.querySelectorAll('script[src*="tracking.js"]');
    for (let i = scripts.length - 1; i >= 0; i--) {
      try { return new URL(scripts[i].src).origin; } catch {}
    }
    return '';
  };

  const scriptOrigin = getScriptOrigin();

  // Configuration
  const config = {
    siteId: getSiteId(),
    debug: window.CLICKINSIGHT_DEBUG || false,
    apiEndpoint: window.CLICKINSIGHT_API_URL || (scriptOrigin ? scriptOrigin + '/api/track' : '/api/track'),
    requireConsent: window.CLICKINSIGHT_REQUIRE_CONSENT === true,
    batchSize: 10,
    batchInterval: 5000,
    sessionTimeout: 30 * 60 * 1000,
    // Extensions to load (configurable via data attribute or global)
    extensions: window.CLICKINSIGHT_EXTENSIONS || 'all',
  };

  // Read extensions config from script tag
  const currentScript = document.currentScript || document.querySelector('script[src*="tracking.js"]');
  if (currentScript && currentScript.getAttribute('data-extensions')) {
    config.extensions = currentScript.getAttribute('data-extensions');
  }

  if (!config.siteId) {
    console.error('ClickInsight Pro: Site ID is required.');
    return;
  }

  // Utilities
  const utils = {
    generateId: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }),

    getSessionId: () => {
      let sessionId = sessionStorage.getItem('ci_session_id');
      const lastActivity = sessionStorage.getItem('ci_last_activity');
      const now = Date.now();
      if (!sessionId || !lastActivity || now - parseInt(lastActivity) > config.sessionTimeout) {
        sessionId = utils.generateId();
        sessionStorage.setItem('ci_session_id', sessionId);
      }
      sessionStorage.setItem('ci_last_activity', now.toString());
      return sessionId;
    },

    getRootDomain: () => {
      const parts = location.hostname.split('.');
      if (parts.length <= 1 || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return location.hostname;
      const twoPartTlds = ['co.jp','or.jp','ne.jp','ac.jp','go.jp','com.au','co.uk','org.uk','co.kr'];
      const last2 = parts.slice(-2).join('.');
      if (twoPartTlds.includes(last2) && parts.length >= 3) return '.' + parts.slice(-3).join('.');
      return '.' + parts.slice(-2).join('.');
    },

    setCookie: (name, value, maxAgeDays) => {
      const domain = utils.getRootDomain();
      document.cookie = `${name}=${value}; domain=${domain}; path=/; max-age=${maxAgeDays * 86400}; SameSite=Lax`;
    },

    getCookie: (name) => {
      const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? match[1] : null;
    },

    getUserId: () => {
      let userId = utils.getCookie('ci_user_id');
      if (!userId) {
        userId = localStorage.getItem('ci_user_id');
        if (!userId) userId = utils.generateId();
        utils.setCookie('ci_user_id', userId, 730);
      }
      return userId;
    },

    getViewport: () => ({
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    }),

    getElementPath: (element) => {
      if (!element) return '';
      const path = [];
      let current = element;
      while (current && current !== document.body && path.length < 5) {
        let selector = current.tagName.toLowerCase();
        if (current.id) { path.unshift(selector + '#' + current.id); break; }
        if (current.className) {
          const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (classes) selector += '.' + classes;
        }
        path.unshift(selector);
        current = current.parentElement;
      }
      return path.join(' > ');
    },

    throttle: (func, delay) => {
      let lastCall = 0;
      return function(...args) {
        const now = Date.now();
        if (now - lastCall >= delay) { lastCall = now; return func.apply(this, args); }
      };
    },

    debounce: (func, delay) => {
      let timeoutId;
      return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
      };
    },

    sanitizePII: (text) => {
      if (!text) return '';
      return text
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
        .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]')
        .replace(/\b0\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}\b/g, '[PHONE]')
        .replace(/\b\d{3}-\d{4}\b/g, '[ZIP]');
    },

    sanitizeUrl: (url) => {
      if (!url) return '';
      try {
        const u = new URL(url);
        const sensitiveParams = ['email', 'mail', 'token', 'password', 'pwd', 'secret', 'key', 'ssn', 'card'];
        for (const param of sensitiveParams) {
          if (u.searchParams.has(param)) u.searchParams.set(param, '[REDACTED]');
        }
        return u.toString();
      } catch { return url; }
    },
  };

  // UTM & Device detection
  const getUtmParams = () => {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get('utm_source') || '', utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '', utm_term: params.get('utm_term') || '',
      utm_content: params.get('utm_content') || '', gclid: params.get('gclid') || '', fbclid: params.get('fbclid') || '',
    };
  };

  const getDeviceType = () => {
    const width = utils.getViewport().width;
    if (width >= 1024) return 'desktop';
    if (width >= 768) return 'tablet';
    return 'mobile';
  };

  const getReferrerType = (referrer) => {
    if (!referrer) return 'direct';
    try {
      const hostname = new URL(referrer).hostname.toLowerCase();
      if (hostname.includes('google') || hostname.includes('bing') || hostname.includes('yahoo')) return 'organic';
      if (hostname.includes('facebook') || hostname.includes('instagram') || hostname.includes('twitter')) return 'social';
      return 'referral';
    } catch { return 'direct'; }
  };

  // Event Queue
  const eventQueue = [];
  let batchTimer = null;
  const utmParams = getUtmParams();

  const queueEvent = (event) => {
    const eventData = {
      ...event,
      id: utils.generateId(),
      site_id: config.siteId,
      session_id: utils.getSessionId(),
      user_id: utils.getUserId(),
      timestamp: new Date().toISOString(),
      url: window.location.href,
      referrer: document.referrer,
      user_agent: navigator.userAgent,
      viewport_width: utils.getViewport().width,
      viewport_height: utils.getViewport().height,
      device_type: getDeviceType(),
      referrer_type: getReferrerType(document.referrer),
      ...utmParams,
    };

    if (!eventData.site_id || eventData.site_id.trim() === '') return;

    eventQueue.push(eventData);

    if (eventQueue.length >= config.batchSize) {
      sendBatch();
    } else if (!batchTimer) {
      batchTimer = setTimeout(sendBatch, config.batchInterval);
    }
  };

  const sendBatch = () => {
    if (eventQueue.length === 0) return;
    const events = eventQueue.splice(0, config.batchSize);
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }

    const invalidEvents = events.filter(e => !e.site_id || e.site_id.trim() === '');
    if (invalidEvents.length > 0) return;

    const data = JSON.stringify({ events });

    if (navigator.sendBeacon) {
      const blob = new Blob([data], { type: 'application/json' });
      if (!navigator.sendBeacon(config.apiEndpoint, blob)) sendViaFetch(data);
    } else {
      sendViaFetch(data);
    }

    if (eventQueue.length > 0) batchTimer = setTimeout(sendBatch, config.batchInterval);
  };

  const sendViaFetch = (data) => {
    fetch(config.apiEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: data, keepalive: true,
    }).catch(() => {});
  };

  // --- Core Trackers ---
  let lastScrollDepth = 0;
  let maxScrollDepth = 0;
  let scrollStopTimer = null;
  let readingStartTime = null;
  let readingY = null;
  let isPageVisible = true;
  let recentClicks = [];

  const isDeadClick = (element) => {
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'VIDEO', 'AUDIO'];
    let current = element;
    for (let i = 0; i < 5 && current; i++) {
      if (interactiveTags.includes(current.tagName)) return false;
      if (current.getAttribute('role') === 'button' || current.getAttribute('role') === 'link') return false;
      if (current.getAttribute('onclick') || current.getAttribute('tabindex')) return false;
      if (current.style && current.style.cursor === 'pointer') return false;
      if (current.classList && (current.classList.contains('btn') || current.classList.contains('button'))) return false;
      current = current.parentElement;
    }
    return true;
  };

  const trackers = {
    click: (e) => {
      const element = e.target;
      const rect = element.getBoundingClientRect();
      const scrollY = window.scrollY || window.pageYOffset;
      const isDead = isDeadClick(element);

      const now = Date.now();
      const clickX = Math.round(e.clientX);
      const clickY = Math.round(e.clientY + scrollY);
      recentClicks.push({ x: clickX, y: clickY, t: now });
      recentClicks = recentClicks.filter(c => now - c.t < 2000);
      const nearbyClicks = recentClicks.filter(c => Math.abs(c.x - clickX) < 30 && Math.abs(c.y - clickY) < 30);
      const isRageClick = nearbyClicks.length >= 3;

      queueEvent({
        event_type: isRageClick ? 'rage_click' : isDead ? 'dead_click' : 'click',
        element_tag_name: element.tagName.toLowerCase(),
        element_id: element.id || '',
        element_class_name: element.className || '',
        element_text: utils.sanitizePII(element.textContent?.trim().substring(0, 100) || ''),
        element_href: utils.sanitizeUrl(element.href || element.closest('a')?.href || ''),
        element_path: utils.getElementPath(element),
        click_x: Math.round(e.clientX),
        click_y: Math.round(e.clientY + scrollY),
        element_x: Math.round(rect.left),
        element_y: Math.round(rect.top + scrollY),
      });
    },

    scroll: utils.throttle(() => {
      const scrollY = window.scrollY || window.pageYOffset;
      const documentHeight = document.documentElement.scrollHeight;
      const maxScroll = documentHeight - window.innerHeight;
      const scrollPercentage = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0;

      if (scrollPercentage > maxScrollDepth) maxScrollDepth = scrollPercentage;
      lastScrollDepth = scrollPercentage;

      queueEvent({
        event_type: 'scroll',
        scroll_y: Math.round(scrollY),
        scroll_percentage: Math.min(100, Math.max(0, scrollPercentage)),
      });

      if (scrollStopTimer) clearTimeout(scrollStopTimer);

      if (readingStartTime && readingY !== null) {
        const readingDuration = Date.now() - readingStartTime;
        if (readingDuration >= 500) {
          queueEvent({ event_type: 'read_area', read_y: Math.round(scrollY + (window.innerHeight / 2)), read_duration: readingDuration });
        }
        readingStartTime = null;
        readingY = null;
      }

      scrollStopTimer = setTimeout(() => {
        if (isPageVisible) {
          readingY = Math.round(scrollY + (window.innerHeight / 2));
          readingStartTime = Date.now();
        }
      }, 500);
    }, 200),

    pageview: () => { queueEvent({ event_type: 'pageview', page_title: document.title }); },

    pageleave: () => {
      if (maxScrollDepth > 0) {
        queueEvent({ event_type: 'scroll_depth', scroll_percentage: maxScrollDepth, is_final: true });
      }
      if (readingStartTime && readingY !== null) {
        const readingDuration = Date.now() - readingStartTime;
        if (readingDuration >= 500) {
          queueEvent({ event_type: 'read_area', read_y: readingY, read_duration: readingDuration });
        }
      }
      // Flush extensions
      for (const ext of _extensions) {
        if (ext.flush) ext.flush();
      }
      sendBatch();
    },
  };

  // --- Extension System ---
  const _extensions = [];

  const registerExtension = (ext) => {
    _extensions.push(ext);
    if (ext.init) ext.init();
  };

  // Check if extension should load
  const shouldLoadExtension = (name) => {
    if (config.extensions === 'all') return true;
    if (config.extensions === 'none') return false;
    const list = config.extensions.split(',').map(s => s.trim());
    return list.includes(name);
  };

  // Load extension scripts asynchronously
  const loadExtensions = () => {
    const extBase = scriptOrigin ? scriptOrigin + '/tracking-ext-' : '/tracking-ext-';
    const extensionNames = ['form', 'video', 'image', 'element', 'active-time'];

    for (const name of extensionNames) {
      if (!shouldLoadExtension(name)) continue;

      const script = document.createElement('script');
      script.src = extBase + name + '.js';
      script.async = true;
      script.onerror = () => {
        if (config.debug) console.warn('ClickInsight Pro: Extension "' + name + '" not found, skipping');
      };
      document.head.appendChild(script);
    }
  };

  // Opt-out / Consent
  const checkOptOut = () => localStorage.getItem('clickinsight_optout') === 'true';
  const checkCookieConsent = () => localStorage.getItem('clickinsight_cookie_consent') === 'true';

  // Initialize
  const init = () => {
    if (checkOptOut()) return;
    if (config.requireConsent && !checkCookieConsent()) return;

    trackers.pageview();
    document.addEventListener('click', trackers.click, { passive: true });
    window.addEventListener('scroll', trackers.scroll, { passive: true });
    window.addEventListener('beforeunload', trackers.pageleave);

    document.addEventListener('visibilitychange', () => {
      isPageVisible = !document.hidden;
      if (document.hidden) {
        if (readingStartTime && readingY !== null) {
          const readingDuration = Date.now() - readingStartTime;
          if (readingDuration >= 500) {
            queueEvent({ event_type: 'read_area', read_y: readingY, read_duration: readingDuration });
          }
          readingStartTime = null;
          readingY = null;
        }
        if (scrollStopTimer) { clearTimeout(scrollStopTimer); scrollStopTimer = null; }
        sendBatch();
      }
    });

    // Load extensions asynchronously after core is ready
    loadExtensions();
  };

  // Public API (shared with extensions)
  window.ClickInsight = {
    track: queueEvent,
    flush: sendBatch,
    getSessionId: utils.getSessionId,
    getUserId: utils.getUserId,
    registerExtension: registerExtension,
    utils: utils,
    config: config,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
