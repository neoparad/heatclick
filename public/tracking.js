/**
 * ClickInsight Pro - Tracking Script
 * Version: 1.0.0
 * Lightweight performance-optimized tracking script (< 5KB)
 */

(function() {
  'use strict';

  // Configuration
  const config = {
    siteId: window.CLICKINSIGHT_SITE_ID || '',
    debug: window.CLICKINSIGHT_DEBUG || false,
    apiEndpoint: window.CLICKINSIGHT_API_URL || '/api/track',
    batchSize: 10,
    batchInterval: 5000, // 5 seconds
    sessionTimeout: 30 * 60 * 1000, // 30 minutes
  };

  // Validate configuration
  if (!config.siteId) {
    console.error('ClickInsight Pro: CLICKINSIGHT_SITE_ID is required');
    return;
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

  // Event Queue
  const eventQueue = [];
  let batchTimer = null;

  const queueEvent = (event) => {
    eventQueue.push({
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
    });

    if (config.debug) {
      console.log('ClickInsight Pro: Event queued', event);
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

    // Use sendBeacon for better performance and reliability
    const data = JSON.stringify({ events });

    if (navigator.sendBeacon) {
      const blob = new Blob([data], { type: 'application/json' });
      const sent = navigator.sendBeacon(config.apiEndpoint, blob);

      if (config.debug) {
        console.log('ClickInsight Pro: Batch sent via sendBeacon', { count: events.length, success: sent });
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

  // Event Trackers
  const trackers = {
    click: (e) => {
      const element = e.target;
      const rect = element.getBoundingClientRect();

      queueEvent({
        event_type: 'click',
        element_tag_name: element.tagName.toLowerCase(),
        element_id: element.id || '',
        element_class_name: element.className || '',
        element_text: element.textContent?.trim().substring(0, 100) || '',
        element_href: element.href || element.closest('a')?.href || '',
        element_path: utils.getElementPath(element),
        click_x: Math.round(e.clientX),
        click_y: Math.round(e.clientY + window.scrollY),
        element_x: Math.round(rect.left),
        element_y: Math.round(rect.top + window.scrollY),
      });
    },

    scroll: utils.throttle(() => {
      const scrollY = window.scrollY || window.pageYOffset;
      const documentHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPercentage = Math.round((scrollY / documentHeight) * 100);

      queueEvent({
        event_type: 'scroll',
        scroll_y: Math.round(scrollY),
        scroll_percentage: Math.min(100, Math.max(0, scrollPercentage)),
      });
    }, 1000),

    pageview: () => {
      queueEvent({
        event_type: 'pageview',
        page_title: document.title,
      });
    },

    pageleave: () => {
      // Send remaining events before page unload
      sendBatch();
    },
  };

  // Initialize tracking
  const init = () => {
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
      if (document.hidden) {
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
