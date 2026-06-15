/**
 * ClickInsight Pro - Active Time Tracking Extension
 * Tracks: active_time (time spent actively on page)
 *
 * SaaS B-1 (decisions.md L275 続 14): events are queued through core tracking.js,
 * which enforces data-tenant-id at start-up (sendBeacon abort + console.error on absence).
 * This extension itself does not parse data-tenant-id; consumers must wire it on the
 * <script src="tracking.js"> tag (or via ?tenant_id= query) — see tracking.js header.
  */
(function() {
  'use strict';
  const CI = window.ClickInsight;
  if (!CI) return;

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
          if (this.isActive && this.activeStart > 0) this.totalActive += now - this.activeStart;
          this.isActive = false;
        } else {
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
        CI.track({ event_type: 'active_time', active_duration_ms: Math.round(this.totalActive) });
      }
    },
  };

  CI.registerExtension(activeTimeTracking);
})();
