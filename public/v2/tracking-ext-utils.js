/**
 * ClickInsight Pro - Utils Extension
 * Adds: PII sanitization, URL sanitization, cookie handling, debounce
 * Auto-loaded by core before other extensions
 *
 * SaaS B-1 (decisions.md L275 続 14): events are queued through core tracking.js,
 * which enforces data-tenant-id at start-up (sendBeacon abort + console.error on absence).
 * This extension itself does not parse data-tenant-id; consumers must wire it on the
 * <script src="tracking.js"> tag (or via ?tenant_id= query) — see tracking.js header.
  */
(function() {
  'use strict';
  const CI = window.ClickInsight;
  if (!CI || !CI.extendUtils) return;

  const getRootDomain = () => {
    const parts = location.hostname.split('.');
    if (parts.length <= 1 || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return location.hostname;
    const twoPartTlds = ['co.jp','or.jp','ne.jp','ac.jp','go.jp','com.au','co.uk','org.uk','co.kr'];
    const last2 = parts.slice(-2).join('.');
    if (twoPartTlds.includes(last2) && parts.length >= 3) return '.' + parts.slice(-3).join('.');
    return '.' + parts.slice(-2).join('.');
  };

  CI.extendUtils({
    sanitizePII: (text) => {
      if (!text) return '';
      return text
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
        .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]')
        .replace(/\b0\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}\b/g, '[PHONE]')
        .replace(/\b\d{3}-\d{4}\b/g, '[ZIP]');
    },

    sanitizeUrl: (url) => {
      if (!url) return '';
      try {
        const u = new URL(url);
        const sensitive = ['email','mail','token','password','pwd','secret','key','ssn','card'];
        for (const p of sensitive) { if (u.searchParams.has(p)) u.searchParams.set(p, '[REDACTED]'); }
        return u.toString();
      } catch { return url; }
    },

    setCookie: (name, value, maxAgeDays) => {
      const domain = getRootDomain();
      document.cookie = name + '=' + value + '; domain=' + domain + '; path=/; max-age=' + (maxAgeDays * 86400) + '; SameSite=Lax';
    },

    getCookie: (name) => {
      const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? match[1] : null;
    },

    debounce: (fn, delay) => {
      let tid;
      return function(...args) { clearTimeout(tid); tid = setTimeout(() => fn.apply(this, args), delay); };
    },
  });
})();
