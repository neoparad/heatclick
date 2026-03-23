/**
 * ClickInsight Pro - Scroll Timeline Extension
 * Records scroll position at ~200ms intervals for reading pattern analysis.
 * Data is batched and sent on page leave via sendBeacon.
 *
 * ClickHouse table: clickinsight.scroll_timeline
 * Fields: site_id, session_id, page_url, timestamp_ms, scroll_y, viewport_height
 */
(function() {
  'use strict';

  function setup(CI) {
    var scrollTimeline = {
      _points: [],       // [{t: timestamp_ms, y: scrollY}]
      _lastY: -1,
      _rafId: null,
      _intervalId: null,

      init() {
        var self = this;
        // Use rAF-throttled interval for minimal main-thread impact
        this._intervalId = setInterval(function() {
          if (self._rafId) return;
          self._rafId = requestAnimationFrame(function() {
            self._rafId = null;
            var y = Math.round(window.scrollY || window.pageYOffset);
            // Only record if position changed
            if (y !== self._lastY) {
              self._points.push({ t: Date.now(), y: y });
              self._lastY = y;
            }
          });
        }, 200);
      },

      flush() {
        if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._points.length === 0) return;

        // Batch send all scroll points as a single event with array payload
        // To keep individual ClickHouse rows, we send each point, but chunk to avoid huge payloads
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var points = this._points;
        this._points = [];

        // Send in chunks of 100 to avoid oversized payloads
        var chunkSize = 100;
        for (var i = 0; i < points.length; i += chunkSize) {
          var chunk = points.slice(i, i + chunkSize);
          CI.track({
            event_type: 'scroll_timeline',
            scroll_points: chunk.map(function(p) { return { timestamp_ms: p.t, scroll_y: p.y }; }),
            viewport_height: vh,
            point_count: chunk.length,
          });
        }
      },
    };

    CI.registerExtension(scrollTimeline);
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
