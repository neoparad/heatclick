/**
 * ClickInsight Pro - Image Visibility Tracking Extension
 * Tracks: image_visibility (duration, max visible ratio per image)
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

  const imageVisibility = {
    observer: null,
    tracked: new Map(),

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

      this.observeImages();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.observeImages());
        mo.observe(document.body, { childList: true, subtree: true });
      }
    },

    observeImages() {
      for (const img of document.querySelectorAll('img')) {
        if (this.tracked.has(img)) continue;
        if (img.naturalWidth > 0 && img.naturalWidth < 30 && img.naturalHeight < 30) continue;
        if (img.src && (img.src.startsWith('data:') || img.src.endsWith('.svg'))) continue;

        const rect = img.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;

        this.tracked.set(img, {
          src: img.src || '', alt: img.alt || '', path: CI.utils.getElementPath(img),
          y: Math.round(rect.top + scrollY),
          width: img.naturalWidth || Math.round(rect.width),
          height: img.naturalHeight || Math.round(rect.height),
          startTime: 0, totalVisible: 0, maxRatio: 0,
        });
        this.observer.observe(img);
      }
    },

    flush() {
      const now = Date.now();
      const events = [];
      for (const [img, data] of this.tracked) {
        let total = data.totalVisible;
        if (data.startTime > 0) { total += now - data.startTime; data.startTime = now; data.totalVisible = total; }
        if (total < 100) continue;
        events.push({
          event_type: 'image_visibility', image_src: data.src.substring(0, 500), image_alt: data.alt.substring(0, 200),
          element_path: data.path, image_y: data.y, image_width: data.width, image_height: data.height,
          visible_duration_ms: Math.round(total), max_visible_ratio: Math.round(data.maxRatio * 100) / 100,
        });
      }
      events.sort((a, b) => b.visible_duration_ms - a.visible_duration_ms);
      for (const ev of events.slice(0, 30)) CI.track(ev);
    },
  };

  CI.registerExtension(imageVisibility);
})();
