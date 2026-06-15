# Stage 2 Banner Delivery — Owner Handoff

## What Changed (engineering summary)

| What | Why |
|---|---|
| `middleware.ts`: `/api/scenarios/runtime` added to `API_PUBLIC_PATHS` | Anonymous visitors (no JWT) can now fetch live scenario config |
| `middleware.classify.test.ts` | Unit test that runtime is public and all other `/api/scenarios/*` routes stay tenant-guarded |
| `scripts/operator/bihadashop-dogfood-banner.json` | Dogfood scenario definition (see Step 2 below) |
| This file | Owner action guide |

---

## Step 1 — Paste the snippet on bihadashop (GTM)

Place the following tag in GTM **after** the existing ClickInsight tracking snippet (or as a new Custom HTML tag that fires on All Pages, sequenced after the tracker):

```html
<!-- ClickInsight Scenario Runtime — bihadashop -->
<script
  src="https://ugokimap.com/scenario-runtime.js"
  data-site-id="CIP_EcwUTHEZdIOAUqum"
  data-tenant-id="linkth_internal"
  data-runtime-url="https://ugokimap.com/api/scenarios/runtime"
  defer
></script>
```

**Important:**
- Use `defer` so the script does not block page render.
- `data-runtime-url` is optional if the script is served from ugokimap.com (it auto-derives the origin). Include it explicitly for clarity.
- The script respects the same `clickinsight_optout` / `clickinsight_cookie_consent` flags that the tracking script uses.

---

## Step 2 — Create and activate the dogfood scenario

### 2a. Get a JWT

Log in to the UGOKI MAP dashboard and copy your session token from DevTools (Application > Cookies > `ugokimap_saas_token`) or from the Authorization header of any dashboard API call.

### 2b. Create the scenario (starts as `draft`)

```bash
curl -X POST https://ugokimap.com/api/scenarios \
  -H "Authorization: Bearer <YOUR_JWT>" \
  -H "Content-Type: application/json" \
  -d @scripts/operator/bihadashop-dogfood-banner.json
```

Or copy the `body` object from `scripts/operator/bihadashop-dogfood-banner.json` and POST it via any REST client.

The response will contain the new scenario `id` (UUID). Note it down.

### 2c. Verify the scenario is NOT yet delivered (status=draft)

```bash
curl "https://ugokimap.com/api/scenarios/runtime?tenant_id=linkth_internal&site_id=CIP_EcwUTHEZdIOAUqum"
```

Expected: `{"error":"no_scenarios"}` with HTTP 404 — because the scenario is still `draft` and is not included in the public payload.

### 2d. Activate delivery (change status to `live`)

```bash
curl -X PATCH https://ugokimap.com/api/scenarios/<SCENARIO_ID> \
  -H "Authorization: Bearer <YOUR_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"status": "live"}'
```

### 2e. Verify delivery is now active

```bash
curl "https://ugokimap.com/api/scenarios/runtime?tenant_id=linkth_internal&site_id=CIP_EcwUTHEZdIOAUqum"
```

Expected: HTTP 200 with `{"scenarios":[...]}` containing the dogfood banner.

Open bihadashop.jp in an incognito window. The orange coupon bar (「期間限定 10% OFF FIRST10」) should appear.

---

## Kill-Switch — emergency stop

Set Vercel environment variables to disable delivery without a code deploy:

| Env var | Value | Effect |
|---|---|---|
| `SCENARIO_DELIVERY_DISABLED` | `1` | Globally disable ALL scenario delivery for ALL tenants |
| `SCENARIO_DELIVERY_DISABLED_TENANTS` | `linkth_internal` | Disable delivery for linkth_internal only |
| `SCENARIO_DELIVERY_DISABLED_IDS` | `<scenario UUID>` | Disable delivery of one specific scenario |

Changes take effect on the **next request** (the runtime route is `Cache-Control: no-store`, so there is no CDN TTL to wait for).

To re-enable: remove or change the env var and redeploy (or use Vercel dashboard instant env var update).

---

## Consent gating behaviour

The on-page script (`scenario-runtime.js`) is fail-closed on consent:

| Condition | Behaviour |
|---|---|
| `localStorage.clickinsight_optout === 'true'` | No fetch, no render, no tracking |
| `window.CLICKINSIGHT_REQUIRE_CONSENT === true` AND `clickinsight_cookie_consent` is not `'true'` | No fetch, no render, no tracking |
| Default (no opt-out, consent not required) | Scenarios fetched and rendered normally |

The same opt-out flags used by the tracking script are honoured. No additional configuration is needed.

---

## POC scenario (already live in code)

A hard-coded PoC scenario (`lib/scenarios/poc-scenario.ts`) already exists with `status=live` for:
- Condition: `utm_medium=organic AND session_duration >= 60s AND page_views >= 3 AND NOT VISITED /cart AND is_first_visit=true`
- Variants: A (image popup), B (HTML popup), C (image sidebar)
- CTA URL: `https://bihadashop.jp/products?promo=FIRST10`

This PoC scenario activates automatically when the runtime snippet is placed on bihadashop — no database write needed. The dogfood scenario in Step 2 is a **separate** simpler scenario for delivery validation (no complex conditions) and starts as `draft`.

---

## Security properties of the delivery path

| Control | Where enforced |
|---|---|
| Only `live` scenarios in public payload | `mergeForRuntime()` in runtime route + `evaluateAll()` in scenario-runtime.js |
| No `preview`/`draft` in public payload | Server-side gate in `mergeForRuntime()` (never reaches client) |
| HTML sanitized at write boundary | `sanitizeHtmlVariant()` in repository.ts (sanitize-html allowlist) |
| Client-side re-sanitize before DOM insert | DOMParser allowlist in scenario-runtime.js (defense-in-depth) |
| https-only URLs on CTA/image | SafeHttpsUrlSchema (Zod) at write + `_isSafeHttpsUrl()` at render |
| No public CDN caching of executable config | `Cache-Control: no-store` on runtime route |
| Kill-switch takes effect immediately | `no-store` + env-var gate on every request |
| Consent gate (opt-out / GDPR) | `_consentAllowsRender()` in scenario-runtime.js (fail-closed) |
| Cross-tenant isolation | Runtime route validates `tenant_id`+`site_id` pair; only returns rows matching both |
| Other `/api/scenarios/*` routes (CRUD) | Middleware still requires JWT (`api-tenant`) — unchanged |
