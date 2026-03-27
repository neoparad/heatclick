/**
 * ClickInsight Pro - Behavior Signals Extension
 * Tracks: text_copy, scroll_reversal, tab_switch, browser_back,
 *         pinch_zoom, cta_hover, hover_intent
 *
 * These signals are critical for emotion inference:
 *   text_copy       → comparison/evaluation intent (strongest signal)
 *   scroll_reversal → confusion/hesitation/re-evaluation
 *   tab_switch      → comparison with other sites
 *   browser_back    → dissatisfaction (strongest negative signal)
 *   pinch_zoom      → strong interest on mobile (image enlargement)
 *   cta_hover       → purchase hesitation (cursor approaches CTA but doesn't click)
 *   hover_intent    → interest level on interactive elements
 */
(function() {
  'use strict';

  function setup(CI) {
    var behaviorTracking = {
    // Scroll reversal state
    _lastScrollY: 0,
    _lastDirection: null,
    _reversalCount: 0,

    // Tab switch state
    _tabHiddenAt: 0,
    _tabSwitchCount: 0,

    // Pinch zoom state
    _initialPinchDistance: 0,
    _pinchZoomCount: 0,

    // CTA hover state
    _ctaHoverStart: 0,
    _ctaHoverEl: null,
    _ctaHovers: [], // [{element_path, hover_duration_ms, clicked, y}]

    init() {
      this._initTextCopy();
      this._initScrollReversal();
      this._initTabSwitch();
      this._initBrowserBack();
      this._initPinchZoom();
      this._initCtaHover();
    },

    // --- 1. Text Selection (Copy) ---
    _initTextCopy() {
      document.addEventListener('copy', () => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';
        if (!text) return;

        const anchorNode = selection.anchorNode;
        const el = anchorNode ? (anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode) : null;
        const sy = window.scrollY || window.pageYOffset;

        CI.track({
          event_type: 'text_copy',
          copied_length: text.length,
          copy_y: el ? Math.round(el.getBoundingClientRect().top + sy) : 0,
          element_path: el ? CI.utils.getElementPath(el) : '',
        });
      });
    },

    // --- 2. Scroll Direction Reversal ---
    _initScrollReversal() {
      this._lastScrollY = window.scrollY || window.pageYOffset;

      const handler = CI.utils.throttle(() => {
        const currentY = window.scrollY || window.pageYOffset;
        const diff = currentY - this._lastScrollY;

        if (Math.abs(diff) < 20) return;

        const direction = diff > 0 ? 'down' : 'up';
        if (this._lastDirection !== null && direction !== this._lastDirection) {
          this._reversalCount++;
        }
        this._lastDirection = direction;
        this._lastScrollY = currentY;
      }, 100);

      window.addEventListener('scroll', handler, { passive: true });
    },

    // --- 3. Tab Switch ---
    _initTabSwitch() {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this._tabHiddenAt = Date.now();
        } else if (this._tabHiddenAt > 0) {
          const awayDuration = Date.now() - this._tabHiddenAt;
          this._tabSwitchCount++;

          CI.track({
            event_type: 'tab_return',
            away_duration_ms: awayDuration,
            tab_switch_count: this._tabSwitchCount,
            return_scroll_y: Math.round(window.scrollY || window.pageYOffset),
          });
          this._tabHiddenAt = 0;
        }
      });
    },

    // --- 4. Browser Back ---
    _initBrowserBack() {
      window.addEventListener('popstate', () => {
        CI.track({
          event_type: 'browser_back',
          from_url: window.location.href,
          scroll_y_at_back: Math.round(window.scrollY || window.pageYOffset),
          scroll_depth_at_back: this._getCurrentScrollDepth(),
        });
      });
    },

    // --- 5. Pinch-to-Zoom (mobile) ---
    _initPinchZoom() {
      let tracking = false;

      document.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          this._initialPinchDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          tracking = true;
        }
      }, { passive: true });

      document.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        // touchend fires when fingers lift — can't get distance from touchend
        // The zoom was already detected in touchmove
      }, { passive: true });

      document.addEventListener('touchmove', CI.utils.throttle((e) => {
        if (!tracking || e.touches.length !== 2) return;

        const currentDistance = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );

        const scale = currentDistance / this._initialPinchDistance;

        // Zoom in detected (fingers spread > 1.3x)
        if (scale > 1.3) {
          this._pinchZoomCount++;
          tracking = false; // Don't fire again until new pinch

          // Find the element at the midpoint of the two touches
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const el = document.elementFromPoint(midX, midY);
          const sy = window.scrollY || window.pageYOffset;

          CI.track({
            event_type: 'pinch_zoom',
            zoom_scale: Math.round(scale * 100) / 100,
            zoom_y: Math.round(midY + sy),
            target_tag: el ? el.tagName.toLowerCase() : '',
            target_src: el && el.tagName === 'IMG' ? el.src : '',
            target_alt: el && el.tagName === 'IMG' ? (el.alt || '').substring(0, 100) : '',
            element_path: el ? CI.utils.getElementPath(el) : '',
            pinch_zoom_count: this._pinchZoomCount,
          });
        }
      }, 200), { passive: true });
    },

    // --- 6. CTA Hover (desktop) ---
    _initCtaHover() {
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobile) return; // mousemove is not meaningful on mobile

      document.addEventListener('mouseover', (e) => {
        const cta = this._findCta(e.target);
        if (!cta) return;

        this._ctaHoverStart = Date.now();
        this._ctaHoverEl = cta;
      }, { passive: true });

      document.addEventListener('mouseout', (e) => {
        if (!this._ctaHoverEl || !this._ctaHoverStart) return;

        const cta = this._findCta(e.target);
        if (cta !== this._ctaHoverEl) return;

        const duration = Date.now() - this._ctaHoverStart;

        // Only track if hovered for at least 300ms (not just passing over)
        if (duration >= 300) {
          const sy = window.scrollY || window.pageYOffset;
          const rect = this._ctaHoverEl.getBoundingClientRect();

          this._ctaHovers.push({
            element_path: CI.utils.getElementPath(this._ctaHoverEl),
            element_text: (this._ctaHoverEl.textContent || '').trim().substring(0, 100),
            hover_duration_ms: duration,
            hover_y: Math.round(rect.top + sy),
            clicked: false, // Updated if click follows
          });
        }

        this._ctaHoverStart = 0;
        this._ctaHoverEl = null;
      }, { passive: true });

      // Track if hover leads to click
      document.addEventListener('click', (e) => {
        if (this._ctaHovers.length === 0) return;
        const cta = this._findCta(e.target);
        if (!cta) return;

        const lastHover = this._ctaHovers[this._ctaHovers.length - 1];
        if (lastHover && CI.utils.getElementPath(cta) === lastHover.element_path) {
          lastHover.clicked = true;
        }
      }, { passive: true });
    },

    _findCta(el) {
      let c = el;
      for (let i = 0; i < 5 && c; i++) {
        if (c.tagName === 'A' || c.tagName === 'BUTTON') {
          // Check if it looks like a CTA
          const text = (c.textContent || '').trim();
          const cls = c.className || '';
          if (c.tagName === 'BUTTON' ||
              /cta|btn|button|cart|buy|purchase/i.test(cls) ||
              /購入|買う|申込|カート|詳細|今すぐ|無料|ダウンロード|登録|sign.?up|add.?to|checkout|subscribe|get.?started|try.?free/i.test(text)) {
            return c;
          }
        }
        c = c.parentElement;
      }
      return null;
    },

    _getCurrentScrollDepth() {
      const sy = window.scrollY || window.pageYOffset;
      const dh = document.documentElement.scrollHeight;
      const ms = dh - window.innerHeight;
      return ms > 0 ? Math.round((sy / ms) * 100) : 0;
    },

    // --- flush: send summaries on page leave ---
    flush() {
      // Scroll reversal summary
      if (this._reversalCount > 0) {
        CI.track({
          event_type: 'scroll_reversal',
          reversal_count: this._reversalCount,
          final_scroll_y: Math.round(window.scrollY || window.pageYOffset),
        });
      }

      // CTA hover summary (hesitation signals)
      for (const hover of this._ctaHovers) {
        CI.track({
          event_type: 'cta_hover',
          element_path: hover.element_path,
          element_text: hover.element_text,
          hover_duration_ms: hover.hover_duration_ms,
          hover_y: hover.hover_y,
          hover_clicked: hover.clicked,
        });
      }
    },
  };

    CI.registerExtension(behaviorTracking);
  } // end setup()

  // Wait for ClickInsight core to be available (GTM may load this before tracking.js)
  var CI = window.ClickInsight;
  if (CI) {
    setup(CI);
  } else {
    var attempts = 0;
    var timer = setInterval(function() {
      attempts++;
      CI = window.ClickInsight;
      if (CI) { clearInterval(timer); setup(CI); }
      else if (attempts >= 50) { clearInterval(timer); } // give up after 5s
    }, 100);
  }
})();
