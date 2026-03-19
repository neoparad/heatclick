/**
 * ClickInsight Pro - Tracking Script
 * Version: 1.1.0
 * Lightweight performance-optimized tracking script (< 5KB)
 * Supports multiple sites tracking
 */

(function() {
  'use strict';

  // Get site ID from multiple sources (priority order)
  // CRITICAL: For async scripts, document.currentScript is null
  // We need a reliable way to identify which script tag is executing
  const getSiteId = () => {
    // Method 1: Try document.currentScript first (works for non-async/defer scripts)
    // This is the most reliable method when available
    const currentScript = document.currentScript;
    if (currentScript) {
      const siteId = currentScript.getAttribute('data-site-id');
      if (siteId) {
        return siteId;
      }
    }
    
    // Method 2: Find script tag with data-site-id attribute (MOST RELIABLE for async)
    // This works even when async scripts are used
    // We check all tracking.js scripts and find the one that hasn't been processed yet
    const allTrackingScripts = Array.from(document.querySelectorAll('script[src*="tracking.js"]'));
    
    // Check scripts in reverse order (most recently added first)
    // This helps when multiple scripts are on the same page
    for (let i = allTrackingScripts.length - 1; i >= 0; i--) {
      const script = allTrackingScripts[i];
      const siteId = script.getAttribute('data-site-id');
      
      if (siteId) {
        // Mark this script as processed to avoid conflicts
        // Use a timestamp-based check to handle async script execution
        if (!script.dataset.ciProcessed) {
          script.dataset.ciProcessed = Date.now().toString();
          if (window.CLICKINSIGHT_DEBUG) {
            console.log('ClickInsight Pro: Found site ID from data-site-id attribute:', siteId);
          }
          return siteId;
        }
      }
    }
    
    // Method 3: Use window global variable (set in inline script before this)
    // This is the fallback method - works when inline script sets it before async script loads
    // IMPORTANT: This works because inline scripts execute synchronously before async scripts
    if (window.CLICKINSIGHT_SITE_ID) {
      const siteId = window.CLICKINSIGHT_SITE_ID;
      if (window.CLICKINSIGHT_DEBUG) {
        console.log('ClickInsight Pro: Found site ID from window.CLICKINSIGHT_SITE_ID:', siteId);
      }
      return siteId;
    }
    
    // Method 4: Last resort - find any script with data-site-id
    // This is less reliable but better than nothing
    const anyScript = document.querySelector('script[data-site-id]');
    if (anyScript) {
      const siteId = anyScript.getAttribute('data-site-id');
      if (window.CLICKINSIGHT_DEBUG) {
        console.log('ClickInsight Pro: Found site ID from fallback query:', siteId);
      }
      return siteId;
    }
    
    return '';
  };

  // スクリプトの配信元URLを自動検出
  const getScriptOrigin = () => {
    // Method 1: document.currentScript
    if (document.currentScript && document.currentScript.src) {
      try { return new URL(document.currentScript.src).origin; } catch {}
    }
    // Method 2: tracking.jsのscriptタグから取得
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
    batchInterval: 5000, // 5 seconds
    sessionTimeout: 30 * 60 * 1000, // 30 minutes
  };

  // Validate configuration
  if (!config.siteId) {
    console.error('ClickInsight Pro: Site ID is required. Please set CLICKINSIGHT_SITE_ID or add data-site-id attribute to the script tag.');
    console.error('ClickInsight Pro: Available scripts:', document.querySelectorAll('script[src*="tracking.js"]').length);
    return;
  }

  // Debug log for multiple sites
  if (config.debug) {
    console.log('ClickInsight Pro: Initializing for site:', config.siteId);
  }

  // Utilities
  const utils = {
    generateId: () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    },

    getSessionId: () => {
      let sessionId = sessionStorage.getItem('ci_session_id');
      const lastActivity = sessionStorage.getItem('ci_last_activity');
      const now = Date.now();

      // Check if session expired
      if (!sessionId || !lastActivity || now - parseInt(lastActivity) > config.sessionTimeout) {
        sessionId = utils.generateId();
        sessionStorage.setItem('ci_session_id', sessionId);
      }

      sessionStorage.setItem('ci_last_activity', now.toString());
      return sessionId;
    },

    getRootDomain: () => {
      const parts = location.hostname.split('.');
      // IP or localhost
      if (parts.length <= 1 || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return location.hostname;
      // example.com → .example.com, sub.example.co.jp → .example.co.jp
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
      // Migrate from localStorage to cookie if exists
      let userId = utils.getCookie('ci_user_id');
      if (!userId) {
        userId = localStorage.getItem('ci_user_id');
        if (!userId) {
          userId = utils.generateId();
        }
        utils.setCookie('ci_user_id', userId, 730);
      }
      return userId;
    },

    getViewport: () => {
      return {
        width: window.innerWidth || document.documentElement.clientWidth,
        height: window.innerHeight || document.documentElement.clientHeight,
      };
    },

    getElementPath: (element) => {
      if (!element) return '';

      const path = [];
      let current = element;

      while (current && current !== document.body && path.length < 5) {
        let selector = current.tagName.toLowerCase();

        if (current.id) {
          selector += `#${current.id}`;
          path.unshift(selector);
          break;
        }

        if (current.className) {
          const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (classes) selector += `.${classes}`;
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
        if (now - lastCall >= delay) {
          lastCall = now;
          return func.apply(this, args);
        }
      };
    },

    debounce: (func, delay) => {
      let timeoutId;
      return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
      };
    },

    // PII除去: メールアドレス、電話番号、クレジットカード番号をマスク
    sanitizePII: (text) => {
      if (!text) return '';
      return text
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
        .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]')
        .replace(/\b0\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}\b/g, '[PHONE]')
        .replace(/\b\d{3}-\d{4}\b/g, '[ZIP]');
    },

    // URLからPIIパラメータを除去
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

  // UTMパラメータと広告IDの取得
  const getUtmParams = () => {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_term: params.get('utm_term') || '',
      utm_content: params.get('utm_content') || '',
      gclid: params.get('gclid') || '',
      fbclid: params.get('fbclid') || '',
    };
  };

  // デバイスタイプの判定
  const getDeviceType = () => {
    const width = utils.getViewport().width;
    if (width >= 1024) return 'desktop';
    if (width >= 768) return 'tablet';
    return 'mobile';
  };

  // リファラータイプの判定
  const getReferrerType = (referrer) => {
    if (!referrer) return 'direct';
    try {
      const url = new URL(referrer);
      const hostname = url.hostname.toLowerCase();
      if (hostname.includes('google') || hostname.includes('bing') || hostname.includes('yahoo')) {
        return 'organic';
      }
      if (hostname.includes('facebook') || hostname.includes('instagram') || hostname.includes('twitter')) {
        return 'social';
      }
      return 'referral';
    } catch {
      return 'direct';
    }
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

    // Validate site_id before queuing
    if (!eventData.site_id || eventData.site_id.trim() === '') {
      console.error('ClickInsight Pro: Cannot queue event - site_id is missing or empty', {
        event_type: event.event_type,
        config_siteId: config.siteId
      });
      return;
    }

    eventQueue.push(eventData);

    if (config.debug) {
      console.log('ClickInsight Pro: Event queued', {
        event_type: event.event_type,
        site_id: eventData.site_id,
        session_id: eventData.session_id
      });
    }

    // Send batch if queue is full
    if (eventQueue.length >= config.batchSize) {
      sendBatch();
    } else if (!batchTimer) {
      // Start batch timer
      batchTimer = setTimeout(sendBatch, config.batchInterval);
    }
  };

  const sendBatch = () => {
    if (eventQueue.length === 0) return;

    const events = eventQueue.splice(0, config.batchSize);

    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }

    // Validate all events have site_id before sending
    const invalidEvents = events.filter(e => !e.site_id || e.site_id.trim() === '');
    if (invalidEvents.length > 0) {
      console.error('ClickInsight Pro: Some events are missing site_id, skipping batch', {
        invalidCount: invalidEvents.length,
        totalCount: events.length,
        siteId: config.siteId
      });
      return;
    }

    // Use sendBeacon for better performance and reliability
    const data = JSON.stringify({ events });

    if (navigator.sendBeacon) {
      const blob = new Blob([data], { type: 'application/json' });
      const sent = navigator.sendBeacon(config.apiEndpoint, blob);

      if (config.debug) {
        console.log('ClickInsight Pro: Batch sent via sendBeacon', { 
          count: events.length, 
          success: sent,
          site_id: events[0]?.site_id,
          event_types: [...new Set(events.map(e => e.event_type))]
        });
      }

      if (!sent) {
        // Fallback to fetch
        sendViaFetch(data);
      }
    } else {
      sendViaFetch(data);
    }

    // Schedule next batch if queue still has items
    if (eventQueue.length > 0) {
      batchTimer = setTimeout(sendBatch, config.batchInterval);
    }
  };

  const sendViaFetch = (data) => {
    fetch(config.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      keepalive: true,
    }).then(() => {
      if (config.debug) {
        console.log('ClickInsight Pro: Batch sent via fetch');
      }
    }).catch((error) => {
      if (config.debug) {
        console.error('ClickInsight Pro: Failed to send batch', error);
      }
    });
  };

  // スクロール深度トラッキング用の変数
  let lastScrollDepth = 0;
  let maxScrollDepth = 0;

  // 熟読エリアトラッキング用の変数
  let scrollStopTimer = null;
  let readingStartTime = null;
  let readingY = null;
  let isPageVisible = true;

  // デッドクリック判定（インタラクティブでない要素へのクリック）
  const isDeadClick = (element) => {
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'VIDEO', 'AUDIO'];
    const el = element;
    let current = el;
    // 自身または親5階層までにインタラクティブ要素があるかチェック
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

  // デッドクリック連打検出用
  let recentClicks = [];

  // Event Trackers
  const trackers = {
    click: (e) => {
      const element = e.target;
      const rect = element.getBoundingClientRect();
      const scrollY = window.scrollY || window.pageYOffset;
      const isDead = isDeadClick(element);

      // デッドクリック連打検出（同じ付近を2秒以内に3回以上クリック = レイジクリック）
      const now = Date.now();
      const clickX = Math.round(e.clientX);
      const clickY = Math.round(e.clientY + scrollY);
      recentClicks.push({ x: clickX, y: clickY, t: now });
      recentClicks = recentClicks.filter(c => now - c.t < 2000);
      const nearbyClicks = recentClicks.filter(c => Math.abs(c.x - clickX) < 30 && Math.abs(c.y - clickY) < 30);
      const isRageClick = nearbyClicks.length >= 3;

      const eventType = isRageClick ? 'rage_click' : isDead ? 'dead_click' : 'click';

      queueEvent({
        event_type: eventType,
        element_tag_name: element.tagName.toLowerCase(),
        element_id: element.id || '',
        element_class_name: element.className || '',
        element_text: utils.sanitizePII(element.textContent?.trim().substring(0, 100) || ''),
        element_href: utils.sanitizeUrl(element.href || element.closest('a')?.href || ''),
        element_path: utils.getElementPath(element),
        click_x: Math.round(e.clientX),
        click_y: Math.round(e.clientY + scrollY), // ページ全体に対する絶対位置
        element_x: Math.round(rect.left),
        element_y: Math.round(rect.top + scrollY),
      });
    },

    scroll: utils.throttle(() => {
      const scrollY = window.scrollY || window.pageYOffset;
      const documentHeight = document.documentElement.scrollHeight;
      const maxScroll = documentHeight - window.innerHeight;
      const scrollPercentage = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0;

      // 最深到達地点を更新
      if (scrollPercentage > maxScrollDepth) {
        maxScrollDepth = scrollPercentage;
      }
      lastScrollDepth = scrollPercentage;

      queueEvent({
        event_type: 'scroll',
        scroll_y: Math.round(scrollY),
        scroll_percentage: Math.min(100, Math.max(0, scrollPercentage)),
      });

      // 熟読エリアのトラッキング: スクロール停止を検出
      if (scrollStopTimer) {
        clearTimeout(scrollStopTimer);
      }

      // 既存の熟読セッションを終了
      if (readingStartTime && readingY !== null) {
        const readingDuration = Date.now() - readingStartTime;
        if (readingDuration >= 500) {
          // 500ms以上滞在していた場合のみ送信
          const viewportCenter = scrollY + (window.innerHeight / 2);
          const readingAreaY = Math.round(viewportCenter);

          queueEvent({
            event_type: 'read_area',
            read_y: readingAreaY,
            read_duration: readingDuration,
          });
        }
        readingStartTime = null;
        readingY = null;
      }

      // 新しいスクロール停止タイマーを設定
      scrollStopTimer = setTimeout(() => {
        if (isPageVisible) {
          const viewportCenter = scrollY + (window.innerHeight / 2);
          readingY = Math.round(viewportCenter);
          readingStartTime = Date.now();
        }
      }, 500); // 500ms停止で熟読判定
    }, 200), // 200ms間隔でスクロール深度を取得

    pageview: () => {
      queueEvent({
        event_type: 'pageview',
        page_title: document.title,
      });
    },

    pageleave: () => {
      // ページ離脱時に最終深度を送信
      if (maxScrollDepth > 0) {
        queueEvent({
          event_type: 'scroll_depth',
          scroll_percentage: maxScrollDepth,
          is_final: true,
        });
      }

      // 熟読エリアの最終送信
      if (readingStartTime && readingY !== null) {
        const readingDuration = Date.now() - readingStartTime;
        if (readingDuration >= 500) {
          queueEvent({
            event_type: 'read_area',
            read_y: readingY,
            read_duration: readingDuration,
          });
        }
      }

      // 画像視認データを送信
      imageVisibility.flush();

      // フォーム放棄データを送信
      formTracking.flush();

      // アクティブ時間を送信
      activeTimeTracking.flush();

      // 動画視聴データを送信
      videoTracking.flush();

      // 要素可視性データを送信
      elementVisibility.flush();

      // Send remaining events before page unload
      sendBatch();
    },
  };

  // オプトアウトチェック
  const checkOptOut = () => {
    return localStorage.getItem('clickinsight_optout') === 'true';
  };

  // Cookie同意チェック
  const checkCookieConsent = () => {
    return localStorage.getItem('clickinsight_cookie_consent') === 'true';
  };

  // Initialize tracking
  const init = () => {
    // オプトアウトチェック
    if (checkOptOut()) {
      if (config.debug) {
        console.log('ClickInsight Pro: Tracking disabled (user opted out)');
      }
      return;
    }

    // Cookie同意が必要な場合のみチェック
    if (config.requireConsent && !checkCookieConsent()) {
      if (config.debug) {
        console.log('ClickInsight Pro: Tracking disabled (consent required but not given)');
      }
      return;
    }

    if (config.debug) {
      console.log('ClickInsight Pro: Initializing tracking script', {
        siteId: config.siteId,
        sessionId: utils.getSessionId(),
        userId: utils.getUserId(),
      });
    }

    // Track pageview
    trackers.pageview();

    // Add event listeners
    document.addEventListener('click', trackers.click, { passive: true });
    window.addEventListener('scroll', trackers.scroll, { passive: true });
    window.addEventListener('beforeunload', trackers.pageleave);

    // 画像視認トラッキングを初期化
    imageVisibility.init();

    // フォームトラッキングを初期化
    formTracking.init();

    // アクティブ時間トラッキングを初期化
    activeTimeTracking.init();

    // 動画トラッキングを初期化
    videoTracking.init();

    // 要素可視性トラッキングを初期化
    elementVisibility.init();

    // Send batch on visibility change (tab switch)
    document.addEventListener('visibilitychange', () => {
      isPageVisible = !document.hidden;
      
      if (document.hidden) {
        // タブが非アクティブになった場合、熟読計測を停止
        if (readingStartTime && readingY !== null) {
          const readingDuration = Date.now() - readingStartTime;
          if (readingDuration >= 500) {
            queueEvent({
              event_type: 'read_area',
              read_y: readingY,
              read_duration: readingDuration,
            });
          }
          readingStartTime = null;
          readingY = null;
        }
        if (scrollStopTimer) {
          clearTimeout(scrollStopTimer);
          scrollStopTimer = null;
        }
        sendBatch();
      }
    });

    if (config.debug) {
      console.log('ClickInsight Pro: Tracking initialized successfully');
    }
  };

  // --- フォームトラッキング ---
  const formTracking = {
    fieldStates: new Map(), // field element → { name, type, focusTime, filled, formId }
    formSeen: new Set(), // 表示されたフォームのID/path

    init() {
      document.addEventListener('focusin', (e) => this.handleFocusIn(e), { passive: true });
      document.addEventListener('focusout', (e) => this.handleFocusOut(e), { passive: true });
      document.addEventListener('submit', (e) => this.handleSubmit(e), { passive: true });
      // フォーム検出
      this.detectForms();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.detectForms());
        mo.observe(document.body, { childList: true, subtree: true });
      }
    },

    isFormField(el) {
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    },

    getFieldName(el) {
      return el.name || el.id || el.getAttribute('placeholder') || el.type || 'unknown';
    },

    getFormId(el) {
      const form = el.closest('form');
      if (!form) return 'no-form';
      return form.id || form.name || form.getAttribute('action') || utils.getElementPath(form);
    },

    detectForms() {
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        const formId = form.id || form.name || form.getAttribute('action') || utils.getElementPath(form);
        if (!this.formSeen.has(formId)) {
          this.formSeen.add(formId);
          const fields = form.querySelectorAll('input, textarea, select');
          queueEvent({
            event_type: 'form_view',
            form_id: formId,
            form_action: form.getAttribute('action') || '',
            field_count: fields.length,
          });
        }
      }
    },

    handleFocusIn(e) {
      const el = e.target;
      if (!this.isFormField(el)) return;
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;

      const state = {
        name: this.getFieldName(el),
        type: el.type || el.tagName.toLowerCase(),
        focusTime: Date.now(),
        filled: false,
        formId: this.getFormId(el),
      };
      this.fieldStates.set(el, state);

      queueEvent({
        event_type: 'form_field_focus',
        form_id: state.formId,
        field_name: state.name,
        field_type: state.type,
      });
    },

    handleFocusOut(e) {
      const el = e.target;
      const state = this.fieldStates.get(el);
      if (!state) return;

      const duration = Date.now() - state.focusTime;
      const hasValue = el.value && el.value.trim().length > 0;
      state.filled = hasValue;

      queueEvent({
        event_type: 'form_field_blur',
        form_id: state.formId,
        field_name: state.name,
        field_type: state.type,
        field_duration_ms: duration,
        field_filled: hasValue ? 1 : 0,
      });
    },

    handleSubmit(e) {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      const formId = form.id || form.name || form.getAttribute('action') || utils.getElementPath(form);
      const fields = form.querySelectorAll('input, textarea, select');
      let filledCount = 0;
      for (const f of fields) {
        if (f.type === 'hidden' || f.type === 'submit' || f.type === 'button') continue;
        if (f.value && f.value.trim().length > 0) filledCount++;
      }

      queueEvent({
        event_type: 'form_submit',
        form_id: formId,
        form_action: form.getAttribute('action') || '',
        field_count: fields.length,
        filled_count: filledCount,
      });
    },

    flush() {
      // ページ離脱時、入力途中のフォームをform_abandonとして送信
      const formsInProgress = new Map(); // formId → { fields touched, fields filled }
      for (const [el, state] of this.fieldStates) {
        if (!formsInProgress.has(state.formId)) {
          formsInProgress.set(state.formId, { touched: 0, filled: 0, lastField: '' });
        }
        const f = formsInProgress.get(state.formId);
        f.touched++;
        if (state.filled) f.filled++;
        f.lastField = state.name;
      }

      for (const [formId, info] of formsInProgress) {
        if (info.touched > 0 && info.filled < info.touched) {
          queueEvent({
            event_type: 'form_abandon',
            form_id: formId,
            fields_touched: info.touched,
            fields_filled: info.filled,
            last_field: info.lastField,
          });
        }
      }
    },
  };

  // --- アクティブ時間トラッキング ---
  const activeTimeTracking = {
    activeStart: 0,
    totalActive: 0,
    isActive: true,

    init() {
      this.activeStart = Date.now();
      this.isActive = true;

      document.addEventListener('visibilitychange', () => {
        const now = Date.now();
        if (document.hidden) {
          // 非アクティブに
          if (this.isActive && this.activeStart > 0) {
            this.totalActive += now - this.activeStart;
          }
          this.isActive = false;
        } else {
          // アクティブに復帰
          this.activeStart = now;
          this.isActive = true;
        }
      });
    },

    flush() {
      const now = Date.now();
      if (this.isActive && this.activeStart > 0) {
        this.totalActive += now - this.activeStart;
        this.activeStart = now;
      }
      if (this.totalActive >= 500) {
        queueEvent({
          event_type: 'active_time',
          active_duration_ms: Math.round(this.totalActive),
        });
      }
    },
  };

  // --- 動画トラッキング ---
  const videoTracking = {
    tracked: new Map(), // video element → { src, startTime, totalPlayed, maxProgress, interactions, duration }

    init() {
      this.observeVideos();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.observeVideos());
        mo.observe(document.body, { childList: true, subtree: true });
      }
    },

    observeVideos() {
      const videos = document.querySelectorAll('video');
      for (const video of videos) {
        if (this.tracked.has(video)) continue;
        const data = {
          src: (video.src || video.querySelector('source')?.src || '').substring(0, 500),
          path: utils.getElementPath(video),
          startTime: 0,
          totalPlayed: 0,
          maxProgress: 0,
          interactions: { play: 0, pause: 0, seek: 0, volumechange: 0 },
          duration: 0,
          completed: false,
        };
        this.tracked.set(video, data);

        video.addEventListener('play', () => {
          data.interactions.play++;
          data.startTime = Date.now();
          data.duration = video.duration || 0;
          queueEvent({ event_type: 'video_play', video_src: data.src, element_path: data.path, video_current_time: Math.round(video.currentTime) });
        });
        video.addEventListener('pause', () => {
          data.interactions.pause++;
          if (data.startTime > 0) { data.totalPlayed += Date.now() - data.startTime; data.startTime = 0; }
          if (video.duration > 0) data.maxProgress = Math.max(data.maxProgress, Math.round((video.currentTime / video.duration) * 100));
          queueEvent({ event_type: 'video_pause', video_src: data.src, element_path: data.path, video_current_time: Math.round(video.currentTime), video_progress: data.maxProgress });
        });
        video.addEventListener('ended', () => {
          data.completed = true;
          data.maxProgress = 100;
          if (data.startTime > 0) { data.totalPlayed += Date.now() - data.startTime; data.startTime = 0; }
          queueEvent({ event_type: 'video_complete', video_src: data.src, element_path: data.path, video_duration: Math.round(video.duration || 0) });
        });
        video.addEventListener('seeked', () => { data.interactions.seek++; });
        video.addEventListener('volumechange', () => { data.interactions.volumechange++; });
        // マイルストーン（25%, 50%, 75%）
        const milestones = new Set();
        video.addEventListener('timeupdate', utils.throttle(() => {
          if (!video.duration) return;
          const pct = Math.round((video.currentTime / video.duration) * 100);
          data.maxProgress = Math.max(data.maxProgress, pct);
          for (const m of [25, 50, 75]) {
            if (pct >= m && !milestones.has(m)) {
              milestones.add(m);
              queueEvent({ event_type: 'video_milestone', video_src: data.src, element_path: data.path, video_milestone: m });
            }
          }
        }, 1000));
      }
    },

    flush() {
      for (const [video, data] of this.tracked) {
        let total = data.totalPlayed;
        if (data.startTime > 0) { total += Date.now() - data.startTime; }
        if (total < 500 && data.maxProgress === 0) continue;
        queueEvent({
          event_type: 'video_summary',
          video_src: data.src,
          element_path: data.path,
          video_played_ms: Math.round(total),
          video_progress: data.maxProgress,
          video_duration: Math.round(data.duration),
          video_completed: data.completed ? 1 : 0,
          video_interactions: data.interactions.play + data.interactions.pause + data.interactions.seek + data.interactions.volumechange,
        });
      }
    },
  };

  // --- 要素可視性トラッキング（CTA・バナー・セクション等） ---
  const elementVisibility = {
    observer: null,
    tracked: new Map(), // element → { selector, startTime, totalVisible, maxRatio, clicked }

    init() {
      if (!('IntersectionObserver' in window)) return;

      this.observer = new IntersectionObserver((entries) => {
        const now = Date.now();
        for (const entry of entries) {
          const data = this.tracked.get(entry.target);
          if (!data) continue;
          if (entry.isIntersecting) {
            data.startTime = now;
            data.maxRatio = Math.max(data.maxRatio, entry.intersectionRatio);
          } else if (data.startTime > 0) {
            data.totalVisible += now - data.startTime;
            data.startTime = 0;
          }
        }
      }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

      this.observeElements();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.observeElements());
        mo.observe(document.body, { childList: true, subtree: true });
      }

      // CTA クリック検出
      document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-track-visibility]') || e.target.closest('a.cta, button.cta, .cta a, .cta button, [class*="cta"], [id*="cta"]');
        if (el && this.tracked.has(el)) {
          this.tracked.get(el).clicked = true;
        }
      }, { passive: true });
    },

    observeElements() {
      // data-track-visibility属性を持つ要素
      const custom = document.querySelectorAll('[data-track-visibility]');
      // CTA系の要素を自動検出
      const ctas = document.querySelectorAll('a.cta, button.cta, .cta a, .cta button, [class*="cta"], [id*="cta"], [class*="banner"], [id*="banner"], [role="banner"]');
      const all = new Set([...custom, ...ctas]);

      for (const el of all) {
        if (this.tracked.has(el)) continue;
        const rect = el.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;
        this.tracked.set(el, {
          selector: el.getAttribute('data-track-visibility') || utils.getElementPath(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().substring(0, 100),
          y: Math.round(rect.top + scrollY),
          startTime: 0,
          totalVisible: 0,
          maxRatio: 0,
          clicked: false,
        });
        this.observer.observe(el);
      }
    },

    flush() {
      const now = Date.now();
      for (const [el, data] of this.tracked) {
        let total = data.totalVisible;
        if (data.startTime > 0) { total += now - data.startTime; }
        if (total < 100) continue;
        queueEvent({
          event_type: 'element_visibility',
          element_selector: data.selector,
          element_tag: data.tag,
          element_text: data.text,
          element_y: data.y,
          visible_duration_ms: Math.round(total),
          max_visible_ratio: Math.round(data.maxRatio * 100) / 100,
          element_clicked: data.clicked ? 1 : 0,
        });
      }
    },
  };

  // --- 画像視認トラッキング（Intersection Observer） ---
  const imageVisibility = {
    observer: null,
    tracked: new Map(), // img element → { src, alt, path, y, startTime, totalVisible, maxRatio }

    init() {
      if (!('IntersectionObserver' in window)) return;

      this.observer = new IntersectionObserver((entries) => {
        const now = Date.now();
        for (const entry of entries) {
          const img = entry.target;
          let data = this.tracked.get(img);

          if (!data) continue;

          if (entry.isIntersecting) {
            // ビューポートに入った
            data.startTime = now;
            data.maxRatio = Math.max(data.maxRatio, entry.intersectionRatio);
          } else if (data.startTime > 0) {
            // ビューポートから出た → 表示時間を加算
            data.totalVisible += now - data.startTime;
            data.startTime = 0;
          }
        }
      }, {
        threshold: [0, 0.25, 0.5, 0.75, 1.0],
      });

      this.observeImages();

      // DOM変更を監視して動的画像も追跡
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.observeImages());
        mo.observe(document.body, { childList: true, subtree: true });
      }
    },

    observeImages() {
      const images = document.querySelectorAll('img');
      for (const img of images) {
        if (this.tracked.has(img)) continue;
        // 小さすぎる画像（アイコン等）は除外
        if (img.naturalWidth > 0 && img.naturalWidth < 30 && img.naturalHeight < 30) continue;
        // data URI / SVGインラインは除外
        if (img.src && (img.src.startsWith('data:') || img.src.endsWith('.svg'))) continue;

        const rect = img.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;

        this.tracked.set(img, {
          src: img.src || '',
          alt: img.alt || '',
          path: utils.getElementPath(img),
          y: Math.round(rect.top + scrollY),
          width: img.naturalWidth || Math.round(rect.width),
          height: img.naturalHeight || Math.round(rect.height),
          startTime: 0,
          totalVisible: 0,
          maxRatio: 0,
        });

        this.observer.observe(img);
      }
    },

    flush() {
      const now = Date.now();
      const events = [];

      for (const [img, data] of this.tracked) {
        // 現在表示中なら時間を加算
        let total = data.totalVisible;
        if (data.startTime > 0) {
          total += now - data.startTime;
          data.startTime = now; // リセット
          data.totalVisible = total;
        }

        // 100ms未満は無視
        if (total < 100) continue;

        events.push({
          event_type: 'image_visibility',
          image_src: data.src.substring(0, 500),
          image_alt: data.alt.substring(0, 200),
          element_path: data.path,
          image_y: data.y,
          image_width: data.width,
          image_height: data.height,
          visible_duration_ms: Math.round(total),
          max_visible_ratio: Math.round(data.maxRatio * 100) / 100,
        });
      }

      // 上位30画像のみ送信（バッチサイズ制限）
      events.sort((a, b) => b.visible_duration_ms - a.visible_duration_ms);
      for (const ev of events.slice(0, 30)) {
        queueEvent(ev);
      }
    },
  };

  // Expose public API
  window.ClickInsight = {
    track: queueEvent,
    flush: sendBatch,
    getSessionId: utils.getSessionId,
    getUserId: utils.getUserId,
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already loaded, initialize immediately
    init();
  }
})();
