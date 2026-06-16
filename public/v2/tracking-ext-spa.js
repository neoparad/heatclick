/**
 * ClickInsight Pro - SPA Navigation Detection Extension
 * Detects client-side navigations via History API (pushState/replaceState) and popstate.
 * Sends virtual_pageview events with previous/current URL and navigation trigger.
 *
 * Anti-false-positive: ignores hash-only changes, modal open/close (same pathname),
 * and debounces rapid URL changes within 50ms.
 *
 * SaaS B-1 (decisions.md L275 続 14): events are queued through core tracking.js,
 * which enforces data-tenant-id at start-up (sendBeacon abort + console.error on absence).
 * This extension itself does not parse data-tenant-id; consumers must wire it on the
 * <script src="tracking.js"> tag (or via ?tenant_id= query) — see tracking.js header.
  */
(function() {
  'use strict';

  function setup(CI) {
    var spa = {
      _lastUrl: '',
      _lastPathname: '',
      _debounceTimer: null,
      _navCount: 0,

      init: function() {
        var self = this;
        this._lastUrl = window.location.href;
        this._lastPathname = window.location.pathname;

        // Monkey-patch pushState/replaceState
        var origPush = history.pushState;
        var origReplace = history.replaceState;

        history.pushState = function() {
          origPush.apply(this, arguments);
          self._onUrlChange('pushState');
        };

        history.replaceState = function() {
          origReplace.apply(this, arguments);
          self._onUrlChange('replaceState');
        };

        // popstate (browser back/forward)
        window.addEventListener('popstate', function() {
          self._onUrlChange('popstate');
        });
      },

      _onUrlChange: function(trigger) {
        var self = this;
        // Debounce: frameworks may fire multiple pushState calls in quick succession
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(function() {
          self._debounceTimer = null;
          self._checkNavigation(trigger);
        }, 50);
      },

      _checkNavigation: function(trigger) {
        var newUrl = window.location.href;
        var newPathname = window.location.pathname;

        // Skip if URL hasn't changed
        if (newUrl === this._lastUrl) return;

        // Skip hash-only changes (same page anchors)
        if (newPathname === this._lastPathname &&
            window.location.search === new URL(this._lastUrl).search) {
          this._lastUrl = newUrl;
          return;
        }

        // Skip replaceState with same pathname (common in modal/tab patterns)
        if (trigger === 'replaceState' && newPathname === this._lastPathname) {
          this._lastUrl = newUrl;
          return;
        }

        var prevUrl = this._lastUrl;
        this._lastUrl = newUrl;
        this._lastPathname = newPathname;
        this._navCount++;

        CI.track({
          event_type: 'virtual_pageview',
          page_title: document.title,
          previous_url: prevUrl,
          navigation_trigger: trigger,
          navigation_index: this._navCount,
        });
      },

      flush: function() {
        // No buffered data to flush
      },
    };

    CI.registerExtension(spa);
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
