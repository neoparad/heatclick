/**
 * UGOKI MAP — Screenshot Worker (Puppeteer / Browser Rendering)
 *
 * POST /screenshot
 *   Authorization: Bearer <SCREENSHOT_WORKER_TOKEN>
 *   Content-Type: application/json
 *   Body: { url: string, width: number, deviceScaleFactor: number }
 *
 * Returns: image/jpeg (full-page screenshot, autoScroll for lazy-loaded images)
 *
 * Security:
 *   1. Bearer token required — without it the Worker is an open SSRF screenshot proxy.
 *   2. SSRF guard — only public http/https URLs are accepted; private IPs, loopback,
 *      link-local, metadata endpoints, and .localhost/.local hostnames are blocked.
 *
 * Lazy-load strategy:
 *   1. goto(url, { waitUntil: 'networkidle0', timeout: 30s })
 *   2. autoScroll: scroll in 600px steps to bottom, pausing 150ms per step to trigger
 *      IntersectionObserver / native lazy / scroll-event listeners
 *   3. After scroll: evaluate that all <img> are `.complete` (or wait 5s max)
 *   4. Scroll back to top, then take fullPage screenshot
 *
 * Constraints:
 *   - deviceScaleFactor is always 1 (overlay coordinate alignment — DO NOT change)
 *   - Always browser.close() in finally
 *   - Total timeout cap: 55s (Worker CPU limit ~60s)
 */

import puppeteer from '@cloudflare/puppeteer';

// ── Env bindings ───────────────────────────────────────────────────────────────

export interface Env {
  /** Browser Rendering binding (wrangler.toml [browser]) */
  MYBROWSER: Fetcher;
  /** Shared secret — Bearer token the Next.js app must include. Required. */
  SCREENSHOT_WORKER_TOKEN: string;
  /** Self-identification for logs */
  WORKER_NAME?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Maximum total request handling time (ms). Workers CPU hard limit is ~60s. */
const TOTAL_TIMEOUT_MS = 55_000;

/** puppeteer.launch goto timeout (ms). Included within TOTAL_TIMEOUT_MS. */
const GOTO_TIMEOUT_MS = 30_000;

/** Maximum time to wait for images to complete after scrolling (ms). */
const IMAGES_COMPLETE_TIMEOUT_MS = 5_000;

/** autoScroll step in px. Large enough to be fast, small enough to trigger lazy loaders. */
const SCROLL_STEP_PX = 600;

/** Pause between each scroll step (ms). Gives IntersectionObserver / lazy loaders time to fire. */
const SCROLL_STEP_DELAY_MS = 150;

/** JPEG quality (matches the main app SCREENSHOT_QUALITY). */
const JPEG_QUALITY = 75;

// ── SSRF guard ─────────────────────────────────────────────────────────────────

/**
 * Validates that a URL is safe to screenshot:
 *   - Must be http or https
 *   - Must not contain embedded credentials
 *   - Host must not be a private/loopback/link-local/metadata address
 *
 * Returns an error string on failure, null on success.
 */
function validateTargetUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'url is not a valid absolute URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'only http/https are allowed';
  }
  if (parsed.username || parsed.password) {
    return 'embedded credentials are not allowed';
  }

  let host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    return 'url host is empty';
  }

  // Strip IPv6 brackets so isBlockedHost can handle the raw IP string.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // Strip a trailing DNS root dot so "localhost." / "metadata.google.internal." cannot
  // bypass the hostname checks (Codex T1 MEDIUM fix).
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }

  if (isBlockedHost(host)) {
    return `blocked host: ${host}`;
  }

  return null;
}

/**
 * Returns true if the host should be blocked (private IP, loopback, link-local,
 * cloud metadata, restricted hostname).
 *
 * Covers:
 *   IPv4: 10.x, 127.x, 169.254.x, 172.16-31.x, 192.168.x, 100.64-127.x (CGNAT),
 *         0.x, 192.0.x, 198.18-19.x, 198.51.100.x, 203.0.113.x, 224+
 *   IPv6: ::1, ::, fc/fd (ULA), fe80 (link-local), ff (multicast), ::ffff: (mapped IPv4)
 *   Cloud metadata: 169.254.169.254, metadata.google.internal
 *   Hostnames: localhost, *.localhost, *.local, *.internal
 */
function isBlockedHost(host: string): boolean {
  // ── IPv4 dotted-decimal ────────────────────────────────────────────────────
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return isBlockedIPv4(host);
  }

  // ── IPv6 hex ───────────────────────────────────────────────────────────────
  if (host.includes(':')) {
    return isBlockedIPv6(host);
  }

  // ── Hostname patterns ──────────────────────────────────────────────────────
  if (host === 'localhost') return true;
  if (host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;

  return false;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed — block to be safe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;                          // RFC1918 10/8
  if (a === 127) return true;                         // loopback
  if (a === 0) return true;                           // "this network"
  if (a === 169 && b === 254) return true;            // link-local / AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918 172.16-31/12
  if (a === 192 && b === 168) return true;            // RFC1918 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                          // multicast + reserved
  if (a === 192 && b === 0) return true;              // 192.0.0/24, 192.0.2/24 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18-19/15
  if (a === 198 && b === 51) return true;             // TEST-NET-2 198.51.100/24
  if (a === 203 && b === 0) return true;              // TEST-NET-3 203.0.113/24
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80')) return true;                          // link-local
  if (lower.startsWith('ff')) return true;                            // multicast
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped — validate the inner IPv4
    const inner = lower.slice('::ffff:'.length);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(inner)) {
      return isBlockedIPv4(inner);
    }
    return true; // unrecognised mapped form — block
  }
  return false;
}

// ── Request body schema ────────────────────────────────────────────────────────

interface ScreenshotRequestBody {
  url: string;
  width: number;
  deviceScaleFactor: number;
}

function parseRequestBody(raw: unknown): ScreenshotRequestBody | string {
  if (typeof raw !== 'object' || raw === null) {
    return 'request body must be a JSON object';
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.url !== 'string' || obj.url.trim().length === 0) {
    return 'url must be a non-empty string';
  }
  const width = obj.width;
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 320 || width > 3840) {
    return 'width must be a number in [320, 3840]';
  }
  const dsf = obj.deviceScaleFactor;
  if (typeof dsf !== 'number' || !Number.isFinite(dsf) || dsf <= 0 || dsf > 4) {
    return 'deviceScaleFactor must be a positive number ≤ 4';
  }

  return {
    url: obj.url.trim(),
    width: Math.round(width),
    deviceScaleFactor: dsf,
  };
}

// ── JSON error helper ──────────────────────────────────────────────────────────

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ── autoScroll ─────────────────────────────────────────────────────────────────

/**
 * Scrolls the page from top to bottom in SCROLL_STEP_PX steps, pausing
 * SCROLL_STEP_DELAY_MS between each step to give IntersectionObserver / native
 * lazy-load / scroll-event listeners time to fire and fetch images.
 *
 * After reaching the bottom, waits for all <img> to be .complete (max 5s),
 * then scrolls back to the top so fullPage screenshot captures from y=0.
 */
async function autoScroll(page: puppeteer.Page): Promise<void> {
  // Scroll to bottom in steps
  await page.evaluate(
    async (stepPx: number, delayMs: number) => {
      await new Promise<void>((resolve) => {
        let currentY = 0;
        const maxY = document.body.scrollHeight;

        function step() {
          currentY = Math.min(currentY + stepPx, maxY);
          window.scrollTo(0, currentY);

          if (currentY >= maxY) {
            resolve();
            return;
          }
          setTimeout(step, delayMs);
        }

        // Also dispatch a scroll event to wake lazy loaders that listen on window
        window.dispatchEvent(new Event('scroll'));
        setTimeout(step, delayMs);
      });
    },
    SCROLL_STEP_PX,
    SCROLL_STEP_DELAY_MS,
  );

  // Wait for all <img> elements to finish loading (or timeout)
  const imagesCompleteDeadline = Date.now() + IMAGES_COMPLETE_TIMEOUT_MS;
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.every((img) => img.complete);
    },
    { timeout: Math.max(imagesCompleteDeadline - Date.now(), 500) },
  ).catch(() => {
    // Best-effort: if some images still haven't loaded by the timeout, continue anyway.
    console.warn('[screenshot-worker] Some images did not complete within timeout; continuing.');
  });

  // Scroll back to top so fullPage screenshot starts from y=0
  await page.evaluate(() => window.scrollTo(0, 0));
}

// ── Main fetch handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ── Auth check (CRITICAL — without this the Worker is an open proxy) ────
    const authHeader = request.headers.get('authorization') ?? '';
    const token = env.SCREENSHOT_WORKER_TOKEN;

    // Reject if token env is not configured or is empty
    if (!token || token.trim().length === 0) {
      return jsonError(503, 'screenshot worker is not configured (missing SCREENSHOT_WORKER_TOKEN)');
    }

    // Constant-time comparison to prevent timing attacks
    const expected = `Bearer ${token}`;
    if (authHeader.length !== expected.length) {
      return jsonError(401, 'missing or invalid Authorization header');
    }
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) {
      mismatch |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (mismatch !== 0) {
      return jsonError(401, 'missing or invalid Authorization header');
    }

    // ── Route: health check ──────────────────────────────────────────────────
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // ── Route: POST /screenshot ──────────────────────────────────────────────
    if (request.method !== 'POST' || url.pathname !== '/screenshot') {
      return jsonError(404, 'not found — use POST /screenshot');
    }

    // Parse + validate request body
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError(400, 'request body must be valid JSON');
    }

    const parsed = parseRequestBody(rawBody);
    if (typeof parsed === 'string') {
      return jsonError(400, parsed);
    }

    // SSRF guard on the target URL
    const ssrfError = validateTargetUrl(parsed.url);
    if (ssrfError !== null) {
      return jsonError(400, `blocked: ${ssrfError}`);
    }

    // ── Puppeteer capture ────────────────────────────────────────────────────
    let browser: puppeteer.Browser | null = null;

    // Race the whole puppeteer flow against a total deadline
    const capturePromise = (async (): Promise<Response> => {
      browser = await puppeteer.launch(env.MYBROWSER);
      const page = await browser.newPage();

      // SSRF defense-in-depth (Codex T1 HIGH fix): re-validate EVERY request the browser makes
      // — including redirects and sub-resources — and abort any that target a blocked host or a
      // non-http(s) scheme. This catches "public URL -> 302 -> 127.0.0.1 / 169.254.169.254"
      // redirect SSRF that the initial validateTargetUrl() cannot see.
      // Residual: DNS rebinding (a public hostname RESOLVING to a private IP) is not fully
      // mitigated — the Worker runs on Cloudflare's edge, isolated from UGOKI infra, with no
      // cloud-metadata service and no access to the app's private network, so blast radius is
      // low. Full resolve-and-pin is impractical in a Worker.
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        try {
          const reqUrl = new URL(req.url());
          let h = reqUrl.hostname.toLowerCase();
          if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
          if (h.endsWith('.')) h = h.slice(0, -1);
          if ((reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:') || isBlockedHost(h)) {
            void req.abort();
            return;
          }
          void req.continue();
        } catch {
          void req.abort();
        }
      });

      await page.setViewport({
        width: parsed.width,
        height: Math.round(parsed.width * 1.5),
        deviceScaleFactor: parsed.deviceScaleFactor,
      });

      await page.goto(parsed.url, {
        waitUntil: 'networkidle0',
        timeout: GOTO_TIMEOUT_MS,
      });

      // autoScroll to trigger lazy-loaded images
      await autoScroll(page);

      const screenshotBytes = await page.screenshot({
        fullPage: true,
        type: 'jpeg',
        quality: JPEG_QUALITY,
      });

      const bytes =
        screenshotBytes instanceof Uint8Array
          ? screenshotBytes
          : new Uint8Array(screenshotBytes as ArrayBuffer);

      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    })();

    const timeoutPromise = new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(jsonError(504, 'screenshot timed out'));
      }, TOTAL_TIMEOUT_MS);
    });

    try {
      return await Promise.race([capturePromise, timeoutPromise]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[screenshot-worker] capture error:', message);
      return jsonError(500, `screenshot failed: ${message}`);
    } finally {
      if (browser !== null) {
        await (browser as puppeteer.Browser).close().catch(() => {
          // best-effort close — if it fails the Worker instance will be recycled anyway
        });
      }
    }
  },
};
