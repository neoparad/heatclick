/**
 * ClickInsight Pro - Session Recording Script
 * Uses rrweb for lightweight session recording
 * Version: 1.0.0
 */

(function() {
  'use strict';

  // Configuration
  const config = {
    siteId: window.CLICKINSIGHT_SITE_ID || '',
    apiEndpoint: window.CLICKINSIGHT_API_URL || '/api/recordings',
    debug: window.CLICKINSIGHT_DEBUG || false,
    sampleRate: window.CLICKINSIGHT_RECORDING_SAMPLE_RATE || 1.0, // 100% by default
    maxDuration: 30 * 60 * 1000, // 30 minutes max
  };

  // Validate configuration
  if (!config.siteId) {
    if (config.debug) {
      console.warn('ClickInsight Pro: CLICKINSIGHT_SITE_ID is required for recording');
    }
    return;
  }

  // Check if recording is enabled (sample rate)
  if (Math.random() > config.sampleRate) {
    if (config.debug) {
      console.log('ClickInsight Pro: Recording skipped (sample rate)');
    }
    return;
  }

  // Check opt-out
  const checkOptOut = () => {
    return localStorage.getItem('clickinsight_optout') === 'true';
  };

  const checkCookieConsent = () => {
    return localStorage.getItem('clickinsight_cookie_consent') === 'true';
  };

  if (checkOptOut() || !checkCookieConsent()) {
    if (config.debug) {
      console.log('ClickInsight Pro: Recording disabled (opt-out or no consent)');
    }
    return;
  }

  // Load rrweb from CDN (lightweight approach)
  const loadScript = (src) => {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  };

  // Initialize recording
  const initRecording = async () => {
    try {
      // Load rrweb from CDN
      await loadScript('https://cdn.jsdelivr.net/npm/rrweb@latest/dist/rrweb.min.js');
      
      if (typeof rrweb === 'undefined') {
        console.error('ClickInsight Pro: Failed to load rrweb');
        return;
      }

      const sessionId = getSessionId();
      const userId = getUserId();
      let events = [];
      let startTime = Date.now();
      let stopFn = null;

      // Start recording
      stopFn = rrweb.record({
        emit(event) {
          events.push(event);
          
          // Send events in batches to avoid memory issues
          if (events.length >= 100) {
            sendRecordingBatch(events.slice(0, 100));
            events = events.slice(100);
          }
        },
        maskAllInputs: true, // Privacy: mask all input fields
        maskAllText: false, // Keep text for analysis
        blockClass: 'rr-block', // Class to block from recording
        blockSelector: '[data-no-record]', // Selector to block
        ignoreClass: 'rr-ignore',
        maskTextClass: 'rr-mask',
        maskTextSelector: '[data-mask-text]',
        slimDOMOptions: {
          script: false,
          comment: false,
          headFavicon: false,
          headWhitespace: false,
          headMetaDescKeywords: false,
          headMetaSocial: false,
          headMetaRobots: false,
          headMetaHttpEquiv: false,
          headMetaAuthorship: false,
          headMetaVerification: false,
        },
      });

      if (config.debug) {
        console.log('ClickInsight Pro: Recording started', { sessionId, userId });
      }

      // Send final batch on page unload
      window.addEventListener('beforeunload', () => {
        if (events.length > 0) {
          sendRecordingBatch(events, true);
        }
        if (stopFn) {
          stopFn();
        }
      });

      // Send periodic batches
      setInterval(() => {
        if (events.length > 0) {
          sendRecordingBatch(events.slice(0, 100));
          events = events.slice(100);
        }
      }, 10000); // Every 10 seconds

      // Stop recording after max duration
      setTimeout(() => {
        if (stopFn) {
          stopFn();
          if (events.length > 0) {
            sendRecordingBatch(events, true);
          }
          if (config.debug) {
            console.log('ClickInsight Pro: Recording stopped (max duration)');
          }
        }
      }, config.maxDuration);

    } catch (error) {
      console.error('ClickInsight Pro: Recording initialization error', error);
    }
  };

  // Send recording batch
  const sendRecordingBatch = async (events, isFinal = false) => {
    if (events.length === 0) return;

    try {
      const sessionId = getSessionId();
      const userId = getUserId();
      const payload = {
        site_id: config.siteId,
        session_id: sessionId,
        user_id: userId,
        events: events,
        is_final: isFinal,
        timestamp: new Date().toISOString(),
      };

      // Use sendBeacon for better reliability
      if (navigator.sendBeacon && isFinal) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(config.apiEndpoint, blob);
      } else {
        await fetch(config.apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      }

      if (config.debug) {
        console.log('ClickInsight Pro: Recording batch sent', { count: events.length, isFinal });
      }
    } catch (error) {
      console.error('ClickInsight Pro: Failed to send recording batch', error);
    }
  };

  // Session ID management
  const getSessionId = () => {
    let sessionId = sessionStorage.getItem('ci_session_id');
    if (!sessionId) {
      sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      sessionStorage.setItem('ci_session_id', sessionId);
    }
    return sessionId;
  };

  // User ID management
  const getUserId = () => {
    let userId = localStorage.getItem('ci_user_id');
    if (!userId) {
      userId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      localStorage.setItem('ci_user_id', userId);
    }
    return userId;
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRecording);
  } else {
    initRecording();
  }
})();



