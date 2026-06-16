/**
 * ClickInsight Pro - Form Tracking Extension
 * Tracks: form_view, form_field_focus, form_field_blur, form_submit, form_abandon
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

  const formTracking = {
    fieldStates: new Map(),
    formSeen: new Set(),

    init() {
      document.addEventListener('focusin', (e) => this.handleFocusIn(e), { passive: true });
      document.addEventListener('focusout', (e) => this.handleFocusOut(e), { passive: true });
      document.addEventListener('submit', (e) => this.handleSubmit(e), { passive: true });
      this.detectForms();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.detectForms());
        mo.observe(document.body, { childList: true, subtree: true });
      }
    },

    isFormField(el) {
      if (!el || !el.tagName) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    },

    getFieldName(el) { return el.name || el.id || el.getAttribute('placeholder') || el.type || 'unknown'; },

    getFormId(el) {
      const form = el.closest('form');
      if (!form) return 'no-form';
      return form.id || form.name || form.getAttribute('action') || CI.utils.getElementPath(form);
    },

    detectForms() {
      for (const form of document.querySelectorAll('form')) {
        const formId = form.id || form.name || form.getAttribute('action') || CI.utils.getElementPath(form);
        if (!this.formSeen.has(formId)) {
          this.formSeen.add(formId);
          CI.track({ event_type: 'form_view', form_id: formId, form_action: form.getAttribute('action') || '', field_count: form.querySelectorAll('input, textarea, select').length });
        }
      }
    },

    handleFocusIn(e) {
      const el = e.target;
      if (!this.isFormField(el)) return;
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
      const state = { name: this.getFieldName(el), type: el.type || el.tagName.toLowerCase(), focusTime: Date.now(), filled: false, formId: this.getFormId(el) };
      this.fieldStates.set(el, state);
      CI.track({ event_type: 'form_field_focus', form_id: state.formId, field_name: state.name, field_type: state.type });
    },

    handleFocusOut(e) {
      const el = e.target;
      const state = this.fieldStates.get(el);
      if (!state) return;
      const duration = Date.now() - state.focusTime;
      const hasValue = el.value && el.value.trim().length > 0;
      state.filled = hasValue;
      CI.track({ event_type: 'form_field_blur', form_id: state.formId, field_name: state.name, field_type: state.type, field_duration_ms: duration, field_filled: hasValue ? 1 : 0 });
    },

    handleSubmit(e) {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      const formId = form.id || form.name || form.getAttribute('action') || CI.utils.getElementPath(form);
      const fields = form.querySelectorAll('input, textarea, select');
      let filledCount = 0;
      for (const f of fields) {
        if (f.type === 'hidden' || f.type === 'submit' || f.type === 'button') continue;
        if (f.value && f.value.trim().length > 0) filledCount++;
      }
      CI.track({ event_type: 'form_submit', form_id: formId, form_action: form.getAttribute('action') || '', field_count: fields.length, filled_count: filledCount });
    },

    flush() {
      const formsInProgress = new Map();
      for (const [el, state] of this.fieldStates) {
        if (!formsInProgress.has(state.formId)) formsInProgress.set(state.formId, { touched: 0, filled: 0, lastField: '' });
        const f = formsInProgress.get(state.formId);
        f.touched++;
        if (state.filled) f.filled++;
        f.lastField = state.name;
      }
      for (const [formId, info] of formsInProgress) {
        if (info.touched > 0 && info.filled < info.touched) {
          CI.track({ event_type: 'form_abandon', form_id: formId, fields_touched: info.touched, fields_filled: info.filled, last_field: info.lastField });
        }
      }
    },
  };

  CI.registerExtension(formTracking);
})();
