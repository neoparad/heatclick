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

  // Configuration
  const config = {
    siteId: getSiteId(),
    debug: window.CLICKINSIGHT_DEBUG || false,
    apiEndpoint: window.CLICKINSIGHT_API_URL || '/api/track',
    requireConsent: window.CLICKINSIGHT_REQUIRE_CONSENT === true, // デフォルト: false（同意不要）
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

    getUserId: () => {
      let userId = localStorage.getItem('ci_user_id');
      if (!userId) {
        userId = utils.generateId();
        localStorage.setItem('ci_user_id', userId);
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

  // Event Trackers
  const trackers = {
    click: (e) => {
      const element = e.target;
      const rect = element.getBoundingClientRect();
      const scrollY = window.scrollY || window.pageYOffset;

      queueEvent({
        event_type: 'click',
        element_tag_name: element.tagName.toLowerCase(),
        element_id: element.id || '',
        element_class_name: element.className || '',
        element_text: element.textContent?.trim().substring(0, 100) || '',
        element_href: element.href || element.closest('a')?.href || '',
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
