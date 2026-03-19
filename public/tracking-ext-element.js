/**
 * ClickInsight Pro - Element Visibility Tracking Extension
 * Tracks: element_visibility (CTA, banner, custom [data-track-visibility] elements)
 */
(function() {
  'use strict';
  const CI = window.ClickInsight;
  if (!CI) return;

  const elementVisibility = {
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

      this.observeElements();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.observeElements());
        mo.observe(document.body, { childList: true, subtree: true });
      }

      document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-track-visibility]') || e.target.closest('a.cta, button.cta, .cta a, .cta button, [class*="cta"], [id*="cta"]');
        if (el && this.tracked.has(el)) this.tracked.get(el).clicked = true;
      }, { passive: true });
    },

    observeElements() {
      const custom = document.querySelectorAll('[data-track-visibility]');
      const ctas = document.querySelectorAll('a.cta, button.cta, .cta a, .cta button, [class*="cta"], [id*="cta"], [class*="banner"], [id*="banner"], [role="banner"]');
      const all = new Set([...custom, ...ctas]);

      for (const el of all) {
        if (this.tracked.has(el)) continue;
        const rect = el.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;
        this.tracked.set(el, {
          selector: el.getAttribute('data-track-visibility') || CI.utils.getElementPath(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().substring(0, 100),
          y: Math.round(rect.top + scrollY),
          startTime: 0, totalVisible: 0, maxRatio: 0, clicked: false,
        });
        this.observer.observe(el);
      }
    },

    flush() {
      const now = Date.now();
      for (const [el, data] of this.tracked) {
        let total = data.totalVisible;
        if (data.startTime > 0) total += now - data.startTime;
        if (total < 100) continue;
        CI.track({
          event_type: 'element_visibility', element_selector: data.selector, element_tag: data.tag,
          element_text: data.text, element_y: data.y,
          visible_duration_ms: Math.round(total), max_visible_ratio: Math.round(data.maxRatio * 100) / 100,
          element_clicked: data.clicked ? 1 : 0,
        });
      }
    },
  };

  CI.registerExtension(elementVisibility);
})();
