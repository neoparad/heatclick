#!/usr/bin/env node
/**
 * UGOKI LINK v2 — Option B Local Bootstrap Generator for `bihadashop.jp`
 *
 * Generates (locally, NEVER reading `.env*` and NEVER touching production DBs):
 *   1. `bihadashop.jp` SiteKeyRegistration JSON (`SITE_KEYS_JSON` for `ugokilink-collector-jp`)
 *   2. `UGK_SITES_BOOTSTRAP_JSON` entry for Vercel Next.js `/api/v1/**`
 *   3. Random secrets (`UGOKILINK_KEY_PEPPER`, `CONTINUITY_TOKEN_SECRET`, `LAB_MARKER_SECRET`,
 *      `QUARANTINE_ENCRYPTION_MASTER_KEY`)
 *   4. Parallel-run HTML `<script>` snippet (safe `cookieless` default, keeps legacy tag intact!)
 *
 * Usage:
 *   node scripts/link/bootstrap-bihadashop.mjs
 *   node scripts/link/bootstrap-bihadashop.mjs --collector-url https://ugokilink-collector-jp.<your-subdomain>.workers.dev
 */

import crypto from 'node:crypto';

const args = process.argv.slice(2);
let collectorUrl = 'https://ugokilink-collector-jp.<your-subdomain>.workers.dev';
let tenantId = 'ten_own_linkth';
let siteId = 'bihadashop';
let siteHost = 'bihadashop.jp';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--collector-url' && args[i + 1]) collectorUrl = args[++i];
  if (args[i] === '--tenant-id' && args[i + 1]) tenantId = args[++i];
  if (args[i] === '--site-id' && args[i + 1]) siteId = args[++i];
  if (args[i] === '--host' && args[i + 1]) siteHost = args[++i];
}

const randHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const pubKey = `ugk_pub_live_${siteId}_${randHex(12)}`;
const memberHashKey = randHex(32);
const continuitySecret = randHex(32);
const labMarkerSecret = randHex(32);
const keyPepper = randHex(32);
const quarantineMasterKey = randHex(32);

const siteKeyRegistration = [
  {
    publishableKey: pubKey,
    tenantId,
    siteId,
    storageRegion: 'jp',
    tenantMemberHashKey: memberHashKey,
    tenantMemberHashKeyVersion: 'key_v1',
    baseline28dHourVolume: 500,
    surgeMultiplier: 3,
    prefixDailyCap: 500,
  },
];

const sitesBootstrap = [
  {
    siteId,
    tenantId,
    siteName: siteHost,
    consentMode: 'cookieless',
    storageRegion: 'jp',
    processingRegion: 'jp',
    monthlyQuotaPvs: 2_000_000,
  },
];

const parallelSnippetHtml = `<!-- UGOKI LINK v2 Parallel Run Tag (${siteHost} — cookieless default, keeps legacy tracking.js intact) -->
<script>
(function(){
  if (window.__ugkV2Init) return;
  window.__ugkV2Init = true;
  var cfg = {
    key: ${JSON.stringify(pubKey)},
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

console.log('=== UGOKI LINK v2 — Option B Bootstrap Output (DO NOT COMMIT SECRETS) ===\n');
console.log('1) Cloudflare Worker Secrets (ugokilink-collector-jp):');
console.log('   SITE_KEYS_JSON=' + JSON.stringify(siteKeyRegistration));
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
console.log('4) Parallel HTML Snippet to paste into ' + siteHost + ' (keep existing legacy tag intact!):');
console.log(parallelSnippetHtml);
