#!/usr/bin/env node
/**
 * UGOKI LINK v2 — Option B Local Bootstrap Generator (`bihadashop.jp` & `link-th.co.jp`)
 *
 * Generates (locally, NEVER reading `.env*` and NEVER touching production DBs):
 *   1. Unified `SITE_KEYS_JSON` for `ugokilink-collector-jp` (bihadashop.jp + link-th.co.jp)
 *   2. Unified `UGK_SITES_BOOTSTRAP_JSON` for Vercel Next.js `/api/v1/**`
 *   3. Random secrets (`UGOKILINK_KEY_PEPPER`, `CONTINUITY_TOKEN_SECRET`, `LAB_MARKER_SECRET`,
 *      `QUARANTINE_ENCRYPTION_MASTER_KEY`)
 *   4. Per-site parallel-run HTML `<script>` snippets (safe `cookieless` default, keeps legacy tags intact!)
 *
 * Usage:
 *   node scripts/link/bootstrap-bihadashop.mjs
 *   node scripts/link/bootstrap-bihadashop.mjs --collector-url https://ugokilink-collector-jp.<your-subdomain>.workers.dev
 *   node scripts/link/bootstrap-bihadashop.mjs --sites bihadashop:bihadashop.jp,link-th:link-th.co.jp
 */

import crypto from 'node:crypto';

const args = process.argv.slice(2);
let collectorUrl = 'https://ugokilink-collector-jp.<your-subdomain>.workers.dev';
let tenantId = 'ten_own_linkth';
let sitesArg = 'bihadashop:bihadashop.jp,link-th:link-th.co.jp';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--collector-url' && args[i + 1]) collectorUrl = args[++i];
  if (args[i] === '--tenant-id' && args[i + 1]) tenantId = args[++i];
  if (args[i] === '--sites' && args[i + 1]) sitesArg = args[++i];
}

const sites = sitesArg
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [rawId, rawHost] = entry.split(':');
    const siteId = (rawId ?? '').trim();
    const host = (rawHost ?? rawId ?? '').trim();
    return { siteId, host };
  })
  .filter((s) => s.siteId.length > 0);

const randHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const continuitySecret = randHex(32);
const labMarkerSecret = randHex(32);
const keyPepper = randHex(32);
const quarantineMasterKey = randHex(32);

const siteKeyRegistrations = sites.map((s) => ({
  publishableKey: `ugk_pub_live_${s.siteId.replace(/[^a-zA-Z0-9_]/g, '_')}_${randHex(12)}`,
  tenantId,
  siteId: s.siteId,
  storageRegion: 'jp',
  tenantMemberHashKey: randHex(32),
  tenantMemberHashKeyVersion: 'key_v1',
  baseline28dHourVolume: 500,
  surgeMultiplier: 3,
  prefixDailyCap: 500,
}));

const sitesBootstrap = sites.map((s) => ({
  siteId: s.siteId,
  tenantId,
  siteName: s.host,
  consentMode: 'cookieless',
  storageRegion: 'jp',
  processingRegion: 'jp',
  monthlyQuotaPvs: 2_000_000,
}));

function buildParallelSnippetHtml({ host, siteId, publishableKey }) {
  return `<!-- UGOKI LINK v2 Parallel Run Tag (${host} — cookieless default, keeps legacy tracking.js intact) -->
<script>
(function(){
  if (window.__ugkV2Init) return;
  window.__ugkV2Init = true;
  var cfg = {
    key: ${JSON.stringify(publishableKey)},
    endpoint: ${JSON.stringify(`${collectorUrl.replace(/\/+$/, '')}/v1/collect/events`)},
    siteId: ${JSON.stringify(siteId)},
    consent: "cookieless",
    region: "JP"
  };
  window.__ugkV2Config = cfg;
  try {
    var payload = {
      v: 1,
      pv_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
      seq: 0,
      url: location.origin + location.pathname,
      consent_mode: cfg.consent,
      ts_ms: Date.now()
    };
    navigator.sendBeacon && navigator.sendBeacon(
      cfg.endpoint + "?k=" + encodeURIComponent(cfg.key),
      new Blob([JSON.stringify(payload)], { type: "application/json" })
    );
  } catch (e) {}
})();
</script>`;
}

console.log('=== UGOKI LINK v2 — Option B Bootstrap Output (DO NOT COMMIT SECRETS) ===\n');
console.log('Target sites: ' + sites.map((s) => `${s.siteId} (${s.host})`).join(', ') + '\n');
console.log('1) Cloudflare Worker Secrets (ugokilink-collector-jp):');
console.log('   SITE_KEYS_JSON=' + JSON.stringify(siteKeyRegistrations));
console.log('   CONTINUITY_TOKEN_SECRET=' + continuitySecret);
console.log('   LAB_MARKER_SECRET=' + labMarkerSecret);
console.log('');
console.log('2) Cloudflare Worker Secret (ugokilink-wal-jp):');
console.log('   QUARANTINE_ENCRYPTION_MASTER_KEY=' + quarantineMasterKey);
console.log('');
console.log('3) Vercel Environment Variables (ugokimap-saas):');
console.log('   UGK_ENABLE_V2_PROD_WIRING=true');
console.log('   UGK_CLICKHOUSE_V2_DB=ugoki_link_v2');
console.log('   UGOKILINK_KEY_PEPPER=' + keyPepper);
console.log('   UGK_SITES_BOOTSTRAP_JSON=' + JSON.stringify(sitesBootstrap));
console.log('');
console.log('4) Parallel HTML Snippets (paste into each site while keeping existing legacy tags intact!):');
for (let idx = 0; idx < sites.length; idx++) {
  const s = sites[idx];
  const reg = siteKeyRegistrations[idx];
  console.log(`\n--- [${idx + 1}/${sites.length}] ${s.host} (site_id: ${s.siteId}) ---`);
  console.log(
    buildParallelSnippetHtml({
      host: s.host,
      siteId: s.siteId,
      publishableKey: reg.publishableKey,
    })
  );
}
