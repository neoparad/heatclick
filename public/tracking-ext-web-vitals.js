/**
 * ClickInsight Pro - Web Vitals Extension
 * Captures Core Web Vitals (LCP, CLS, INP) + TTFB + FCP via PerformanceObserver.
 * Sends a single web_vitals event per page load on visibilitychange or beforeunload.
 * Also captures connection info (effectiveType, downlink, rtt) when available.
 *
 * ClickHouse table: clickinsight.web_vitals
 */
(function() {
  'use strict';

  function setup(CI) {
    var vitals = {
      _metrics: {},
      _sent: false,

      init: function() {
        var self = this;

        // TTFB + FCP from Navigation/Paint Timing
        try {
          var nav = performance.getEntriesByType('navigation')[0];
          if (nav) self._metrics.ttfb = Math.round(nav.responseStart);
        } catch (e) {}

        try {
          var paints = performance.getEntriesByType('paint');
          for (var i = 0; i < paints.length; i++) {
            if (paints[i].name === 'first-contentful-paint') {
              self._metrics.fcp = Math.round(paints[i].startTime);
            }
          }
        } catch (e) {}

        // LCP via PerformanceObserver
        if ('PerformanceObserver' in window) {
          try {
            var lcpObs = new PerformanceObserver(function(list) {
              var entries = list.getEntries();
              if (entries.length > 0) {
                var last = entries[entries.length - 1];
                self._metrics.lcp = Math.round(last.startTime);
                self._metrics.lcp_element = self._getSelector(last.element);
              }
            });
            lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
          } catch (e) {}

          // CLS via PerformanceObserver (session window approach)
          try {
            var clsValue = 0;
            var clsEntries = [];
            var sessionValue = 0;
            var sessionEntries = [];

            var clsObs = new PerformanceObserver(function(list) {
              var entries = list.getEntries();
              for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (!entry.hadRecentInput) {
                  // Session window: gap < 1s, max 5s
                  if (sessionEntries.length > 0 &&
                      entry.startTime - sessionEntries[sessionEntries.length - 1].startTime > 1000) {
                    // New session window
                    if (sessionValue > clsValue) {
                      clsValue = sessionValue;
                      clsEntries = sessionEntries.slice();
                    }
                    sessionValue = 0;
                    sessionEntries = [];
                  }
                  if (sessionEntries.length === 0 ||
                      entry.startTime - sessionEntries[0].startTime < 5000) {
                    sessionValue += entry.value;
                    sessionEntries.push(entry);
                  }
                }
              }
              // Check current session
              var finalCls = Math.max(clsValue, sessionValue);
              self._metrics.cls = Math.round(finalCls * 10000) / 10000; // 4 decimal places
            });
            clsObs.observe({ type: 'layout-shift', buffered: true });
          } catch (e) {}

          // INP via PerformanceObserver (Interaction to Next Paint)
          try {
            var interactions = [];

            var inpObs = new PerformanceObserver(function(list) {
              var entries = list.getEntries();
              for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (entry.interactionId) {
                  interactions.push({
                    duration: entry.duration,
                    interactionId: entry.interactionId,
                  });
                }
              }
              // INP = p98 of all interactions (or worst if < 50)
              if (interactions.length > 0) {
                // Deduplicate by interactionId, keep worst duration per interaction
                var byId = {};
                for (var j = 0; j < interactions.length; j++) {
                  var id = interactions[j].interactionId;
                  if (!byId[id] || interactions[j].duration > byId[id]) {
                    byId[id] = interactions[j].duration;
                  }
                }
                var durations = Object.values(byId).sort(function(a, b) { return a - b; });
                var idx = Math.min(durations.length - 1, Math.floor(durations.length * 0.98));
                self._metrics.inp = Math.round(durations[idx]);
              }
            });
            inpObs.observe({ type: 'event', buffered: true, durationThreshold: 16 });
          } catch (e) {}
        }

        // Connection info
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
          self._metrics.connection_type = conn.effectiveType || '';
          self._metrics.downlink = conn.downlink || 0;
          self._metrics.rtt = conn.rtt || 0;
        }
      },

      _getSelector: function(el) {
        if (!el) return '';
        if (CI.utils.getCssSelector) return CI.utils.getCssSelector(el);
        if (CI.utils.getElementPath) return CI.utils.getElementPath(el);
        return el.tagName ? el.tagName.toLowerCase() : '';
      },

      flush: function() {
        if (this._sent) return;
        this._sent = true;

        var m = this._metrics;
        // Only send if we have at least one meaningful metric
        if (m.lcp === undefined && m.cls === undefined && m.inp === undefined && m.ttfb === undefined) return;

        CI.track({
          event_type: 'web_vitals',
          lcp_ms: m.lcp || 0,
          lcp_element: m.lcp_element || '',
          cls_score: m.cls || 0,
          inp_ms: m.inp || 0,
          ttfb_ms: m.ttfb || 0,
          fcp_ms: m.fcp || 0,
          connection_type: m.connection_type || '',
          downlink_mbps: m.downlink || 0,
          rtt_ms: m.rtt || 0,
        });
      },
    };

    CI.registerExtension(vitals);
  }

  var CI = window.ClickInsight;
  if (CI) {
    setup(CI);
  } else {
    var attempts = 0;
    var timer = setInterval(function() {
      attempts++;
      CI = window.ClickInsight;
      if (CI) { clearInterval(timer); setup(CI); }
      else if (attempts >= 50) { clearInterval(timer); }
    }, 100);
  }
})();
