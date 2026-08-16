/**
 * ClickInsight Pro - Element Visibility Tracking Extension
 * Tracks: element_visibility (CTA, banner, custom [data-track-visibility] elements)
 *         element_visibility_v2 (h2, price tables, product cards, forms — broad content elements)
 *
 * V1: existing CTA/banner tracking → element_visibility table
 * V2: IntersectionObserver with precise CSS selectors → element_visibility_v2 table
 *     Records visible_start_ms, visible_end_ms, visible_duration_ms, viewport_percent
 *
 * SaaS B-1 (decisions.md L275 続 14): events are queued through core tracking.js,
 * which enforces data-tenant-id at start-up (sendBeacon abort + console.error on absence).
 * This extension itself does not parse data-tenant-id; consumers must wire it on the
 * <script src="tracking.js"> tag (or via ?tenant_id= query) — see tracking.js header.
  */
(function() {
  'use strict';

  function setup(CI) {
    var elementVisibility = {
      observer: null,
      tracked: new Map(),
      // V2: broader content element tracking
      observerV2: null,
      trackedV2: new Map(),

      init: function() {
        if (!('IntersectionObserver' in window)) return;

        // V1 observer — existing behavior
        this.observer = new IntersectionObserver(function(entries) {
          var now = Date.now();
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var data = elementVisibility.tracked.get(entry.target);
            if (!data) continue;
            if (data.y === null) {
              // entry.boundingClientRect comes from the IntersectionObserver's own
              // async geometry pass, unlike el.getBoundingClientRect() called eagerly
              // at scan time — reading it here avoids forcing a synchronous reflow.
              var scrollY = window.scrollY || window.pageYOffset;
              data.y = Math.round(entry.boundingClientRect.top + scrollY);
            }
            if (entry.isIntersecting) {
              data.startTime = now;
              data.maxRatio = Math.max(data.maxRatio, entry.intersectionRatio);
            } else if (data.startTime > 0) {
              data.totalVisible += now - data.startTime;
              data.startTime = 0;
            }
          }
        }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

        // V2 observer — broad content elements with precise timing
        this.observerV2 = new IntersectionObserver(function(entries) {
          var now = Date.now();
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var data = elementVisibility.trackedV2.get(entry.target);
            if (!data) continue;
            if (entry.isIntersecting) {
              if (data.visibleStartMs === 0) data.visibleStartMs = now;
              data.lastSeenMs = now;
              data.maxRatio = Math.max(data.maxRatio, entry.intersectionRatio);
            } else {
              if (data.visibleStartMs > 0) {
                data.totalVisible += now - data.visibleStartMs;
                data.visibleEndMs = now;
                data.visibleStartMs = 0;
              }
            }
          }
        }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

        this.observeElements();
        this.observeContentElements();

        if ('MutationObserver' in window) {
          var mo = new MutationObserver(function() {
            elementVisibility.observeElements();
            elementVisibility.observeContentElements();
          });
          mo.observe(document.body, { childList: true, subtree: true });
        }

        document.addEventListener('click', function(e) {
          var el = e.target;
          while (el && el !== document.body) {
            if (elementVisibility.tracked.has(el)) { elementVisibility.tracked.get(el).clicked = true; break; }
            el = el.parentElement;
          }
        }, { passive: true });
      },

      // V1: CTA/banner elements (existing)
      observeElements: function() {
        var custom = document.querySelectorAll('[data-track-visibility]');
        var ctas = document.querySelectorAll(
          'a.cta, button.cta, .cta a, .cta button, [class*="cta"], [id*="cta"], [class*="banner"], [id*="banner"], [role="banner"]'
          + ', button:not(nav button):not(header button), input[type="submit"], input[type="button"], [role="button"]'
          + ', a[href*="cart"], a[href*="buy"], a[href*="purchase"], a[href*="checkout"], a[href*="order"], a[href*="contact"], a[href*="signup"], a[href*="register"], a[href*="download"]'
          + ', [class*="btn"], [class*="button"], [class*="purchase"], [class*="submit"], [class*="signup"], [class*="download"]'
        );
        var all = new Set([].concat(Array.from(custom), Array.from(ctas)));

        for (var el of all) {
          if (this.tracked.has(el)) continue;
          // y is resolved lazily from entry.boundingClientRect in the observer
          // callback (see init) instead of calling el.getBoundingClientRect()
          // here, which would force a synchronous layout on every new element
          // found in this scan loop.
          this.tracked.set(el, {
            selector: el.getAttribute('data-track-visibility') || (CI.utils.getCssSelector ? CI.utils.getCssSelector(el) : CI.utils.getElementPath(el)),
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().substring(0, 100),
            y: null,
            startTime: 0, totalVisible: 0, maxRatio: 0, clicked: false,
          });
          this.observer.observe(el);
        }
      },

      // V2: Broad content elements (h2, product cards, price tables, forms, sections)
      observeContentElements: function() {
        // Default selectors for content elements — configurable via window.CLICKINSIGHT_VISIBILITY_SELECTORS
        var defaultSelectors = 'h1, h2, h3, [class*="product-card"], [class*="product_card"], [class*="productCard"]'
          + ', [class*="price"], [class*="pricing"], table'
          + ', form, [class*="testimonial"], [class*="review"]'
          + ', [class*="faq"], [class*="feature"], [class*="benefit"]'
          + ', [data-track-visibility-v2]';

        var selectorString = window.CLICKINSIGHT_VISIBILITY_SELECTORS || defaultSelectors;
        var elements;
        try {
          elements = document.querySelectorAll(selectorString);
        } catch (e) {
          elements = document.querySelectorAll(defaultSelectors);
        }

        // Batch the geometry reads instead of interleaving them with the
        // trackedV2.set()/observerV2.observe() writes below: collect the
        // not-yet-tracked candidates first (no reads), then read every
        // candidate's getBoundingClientRect() back-to-back in one tight loop
        // (no writes/mutations between reads), then apply the size filter and
        // do all the writes. This avoids forcing a separate synchronous
        // layout pass per element in this scan loop.
        var candidates = [];
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          if (this.trackedV2.has(el)) continue;
          candidates.push(el);
        }

        var rects = [];
        for (var j = 0; j < candidates.length; j++) {
          rects.push(candidates[j].getBoundingClientRect());
        }

        for (var k = 0; k < candidates.length; k++) {
          var rect = rects[k];
          // Skip tiny or hidden elements
          if (rect.width < 10 || rect.height < 10) continue;

          var candidate = candidates[k];
          var selector = CI.utils.getCssSelector ? CI.utils.getCssSelector(candidate) : CI.utils.getElementPath(candidate);
          this.trackedV2.set(candidate, {
            selector: selector,
            tag: candidate.tagName.toLowerCase(),
            text: (candidate.textContent || '').trim().substring(0, 100),
            visibleStartMs: 0,
            visibleEndMs: 0,
            lastSeenMs: 0,
            totalVisible: 0,
            maxRatio: 0,
          });
          this.observerV2.observe(candidate);
        }
      },

      flush: function() {
        var now = Date.now();

        // V1 flush (existing)
        for (var entry of this.tracked) {
          var el = entry[0], data = entry[1];
          var total = data.totalVisible;
          if (data.startTime > 0) total += now - data.startTime;
          if (total < 100) continue;
          CI.track({
            event_type: 'element_visibility', element_selector: data.selector, element_tag: data.tag,
            element_text: data.text, element_y: data.y === null ? 0 : data.y,
            visible_duration_ms: Math.round(total), max_visible_ratio: Math.round(data.maxRatio * 100) / 100,
            element_clicked: data.clicked ? 1 : 0,
          });
        }

        // V2 flush — element_visibility_v2
        for (var entry2 of this.trackedV2) {
          var el2 = entry2[0], d = entry2[1];
          var totalV2 = d.totalVisible;
          if (d.visibleStartMs > 0) totalV2 += now - d.visibleStartMs;
          if (totalV2 < 200) continue; // minimum 200ms to be meaningful
          CI.track({
            event_type: 'element_visibility_v2',
            element_selector: d.selector,
            element_tag: d.tag,
            element_text: d.text,
            visible_start_ms: d.visibleStartMs > 0 ? d.visibleStartMs : (d.visibleEndMs > 0 ? d.visibleEndMs - totalV2 : 0),
            visible_end_ms: d.visibleStartMs > 0 ? now : d.visibleEndMs,
            visible_duration_ms: Math.round(totalV2),
            viewport_percent: Math.round(d.maxRatio * 100) / 100,
          });
        }
      },
    };

    CI.registerExtension(elementVisibility);
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
