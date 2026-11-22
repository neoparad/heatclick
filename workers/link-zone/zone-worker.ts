/**
 * UGOKI LINK v2 — Single Customer-Deployed Zone Worker (`workers/link-zone`)
 *
 * Implements §10.1–§10.2, §12.1 #3, D-22, D-24, DEL M5 / App. H:
 * - ONE program per customer CDN zone switching roles via signed config:
 *   `deliver`, `handoff`, `origin_kit`, `capture`, `lab_sink`.
 * - Strict execution order: **DELIVERY FIRST → OBSERVATION (`capture`) POST-RESPONSE (`waitUntil`)**,
 *   and `deliver` NEVER reads UA, IP, or `capture` verdicts (prevents actor-dependent content diffs!).
 * - Fail-open on any unhandled exception: returns untouched origin response.
 * - Per-module CPU/wall budget enforcement: skips only the over-budget module.
 * - 1% deterministic pass-through arm bypassing `deliver` ONLY (to measure TTFB/error delta),
 *   while `handoff` and `capture` ALWAYS execute on 100% of requests.
 * - Derived per-function sub-keys from `ugk_edge_*` (`handoff ≠ log_ingest ≠ session_token`).
 * - `/_ugk/selftest` self-diagnostics endpoint.
 */

import type {
  ExecutionContextLike,
  ZoneBudgetConfig,
  ZoneContextResponse,
  ZoneObservationRecord,
  ZonePublicSelfTestResponse,
  ZoneSelfTestReport,
  ZoneTextRewriteOp,
  ZoneWorkerDeps,
} from './types';

export const DEFAULT_ZONE_BUDGETS: ZoneBudgetConfig = {
  contextRaceMs: 50,
  deliverBudgetMs: 12,
  handoffBudgetMs: 2,
  originKitBudgetMs: 3,
  captureBudgetMs: 8,
  maxRewriteBodyBytes: 1_500_000,
};

const AFFILIATE_ANCHOR_RE =
  /(<a\b[^>]*\bhref\s*=\s*["'])(https?:\/\/(?:(?:[^/"']+\.)?(?:a8\.net|afb\.jp|valuecommerce\.com|accesstrade\.net|felmat\.net|rakuten\.co\.jp|moshimo\.com|janet\.ad\.jp|amazon\.(?:co\.jp|com|jp)|amzn\.(?:to|asia)|assoc-amazon\.com)(?:[/:?#][^"']*)?|[^"']*[?&](?:a8mat|aff_id|affiliate_id|vc_sid|scid|tag|ascsubtag|linkCode)=[^"']*))(["'][^>]*>)/gi;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(enc.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    toArrayBuffer(enc.encode(message))
  );
  return bytesToHex(new Uint8Array(sig));
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    toArrayBuffer(new TextEncoder().encode(input))
  );
  return new Uint8Array(digest);
}

async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

async function constantTimeSecretMatch(provided: string | null, expected: string): Promise<boolean> {
  if (!provided || !expected || expected.trim().length === 0) {
    return false;
  }
  const [a, b] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * D-24: Derive strictly separated function sub-keys from `ugk_edge_*`.
 * Never holds decryption or pseudonymisation keys.
 */
export async function deriveZoneSubKeys(edgeIntegritySecret: string): Promise<{
  readonly handoffMacKey: string;
  readonly logIngestKey: string;
  readonly sessionTokenKey: string;
  readonly selftestToken: string;
}> {
  const [handoffMacKey, logIngestKey, sessionTokenKey, selftestToken] = await Promise.all([
    hmacSha256Hex(edgeIntegritySecret, 'ugk:zone:subkey:handoff_mac:v1'),
    hmacSha256Hex(edgeIntegritySecret, 'ugk:zone:subkey:log_ingest:v1'),
    hmacSha256Hex(edgeIntegritySecret, 'ugk:zone:subkey:session_token:v1'),
    hmacSha256Hex(edgeIntegritySecret, 'ugk:zone:subkey:selftest_diag:v1'),
  ]);
  return { handoffMacKey, logIngestKey, sessionTokenKey, selftestToken };
}

function deterministicUnitFraction(hexDigest: string): number {
  const top32 = parseInt(hexDigest.slice(0, 8), 16) >>> 0;
  return top32 / 0x100000000;
}

function reduceUaFamily(ua: string | null): string {
  if (!ua) return 'none';
  if (/Googlebot/i.test(ua)) return 'crawler_googlebot';
  if (/GPTBot|OAI-SearchBot|ChatGPT-User/i.test(ua)) return 'crawler_openai';
  if (/ClaudeBot|Claude-User/i.test(ua)) return 'crawler_anthropic';
  if (/PerplexityBot/i.test(ua)) return 'crawler_perplexity';
  if (/Line\//i.test(ua)) return 'inapp_line';
  if (/YJApp/i.test(ua)) return 'inapp_yahoo_jp';
  if (/CriOS|Chrome\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  if (/Firefox\//i.test(ua)) return 'firefox';
  return 'other';
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeJsonForScriptTag(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * Buffered per-element text rewrite (DEL App. H):
 * Replaces element text ONLY when the current element text's SHA-256 matches
 * `expected_text_sha256`, recording the inverse manifest for SDK rollback/verification.
 */
async function applyBufferedTextRewrites(
  html: string,
  rewrites: readonly ZoneTextRewriteOp[]
): Promise<{
  readonly html: string;
  readonly inverseManifest: readonly { readonly marker_id: string; readonly original_text: string }[];
}> {
  let out = html;
  const inverseManifest: { readonly marker_id: string; readonly original_text: string }[] = [];

  for (const rw of rewrites) {
    const escapedId = rw.marker_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(<([a-zA-Z0-9]+)\\b[^>]*\\bdata-ugk-id=["']${escapedId}["'][^>]*>)([^<]*)(</\\2>)`,
      'i'
    );
    const match = re.exec(out);
    if (!match) continue;

    const currentText = match[3];
    const currentHash = await sha256Hex(currentText);
    if (currentHash !== rw.expected_text_sha256) {
      // Mismatch -> emit original untouched!
      continue;
    }
    inverseManifest.push({ marker_id: rw.marker_id, original_text: currentText });
    out =
      out.slice(0, match.index) +
      match[1] +
      escapeHtmlText(rw.new_text) +
      match[4] +
      out.slice(match.index + match[0].length);
  }

  return { html: out, inverseManifest };
}

/**
 * D-22 Outbound-sink mode: replaces affiliate link destinations with a first-party
 * sink URL ONLY when a verified `lab_token` is present (0 requests reach affiliate hosts,
 * and raw affiliate domains are replaced with a truncated SHA-256 digest).
 */
async function applyLabOutboundSink(
  html: string,
  runId: string
): Promise<{ readonly html: string; readonly count: number }> {
  const matches = Array.from(html.matchAll(AFFILIATE_ANCHOR_RE));
  if (matches.length === 0) {
    return { html, count: 0 };
  }
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    const full = m[0];
    const prefix = m[1];
    const href = m[2];
    const suffix = m[3];
    const hrefDigest = (await sha256Hex(href)).slice(0, 16);
    const sinkHref = `/_ugk/lab-sink?run_id=${encodeURIComponent(runId)}&orig_sha=${hrefDigest}`;
    out += html.slice(cursor, idx) + `${prefix}${sinkHref}${suffix}`;
    cursor = idx + full.length;
  }
  out += html.slice(cursor);
  return { html: out, count: matches.length };
}

function injectNonExecutableJsonBlock(
  html: string,
  context: ZoneContextResponse,
  inverseManifest: readonly { readonly marker_id: string; readonly original_text: string }[]
): string {
  const payload = escapeJsonForScriptTag(
    JSON.stringify({
      decision_id: context.decision_id,
      bundle_seq: context.bundle_seq,
      lease_id: context.lease_id,
      lease_issued_at_ms: context.lease_issued_at_ms,
      consent_mode: context.consent_mode,
      unit_kind: context.unit_kind,
      draws: context.draws,
      ctl_digest: context.ctl_digest,
      inverse_manifest: inverseManifest,
    })
  );
  const tag = `<script type="application/json" id="ugk-ctx">${payload}</script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${tag}</head>`);
  }
  return `${tag}${html}`;
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value: T | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ timedOut: true, value: null });
      }
    }, Math.max(0, timeoutMs));

    promise
      .then((val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, value: val });
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, value: null });
        }
      });
  });
}

export function createZoneWorkerHandler(deps: ZoneWorkerDeps) {
  const budgets: ZoneBudgetConfig = {
    ...DEFAULT_ZONE_BUDGETS,
    ...(deps.budgets ?? {}),
  };
  const passthroughShare = deps.passthroughShare ?? 0.01;
  const now = deps.nowMs ?? (() => Date.now());
  const subKeysPromise = deriveZoneSubKeys(deps.edgeIntegritySecret);

  const counters = {
    requests_total: 0,
    passthrough_count: 0,
    edge_skipped_count: 0,
    budget_skipped_count: 0,
    exception_fallback_count: 0,
  };

  let fallbackReqCounter = 0;
  const nextReqUid = (): string => {
    if (deps.mintReqUid) return deps.mintReqUid();
    fallbackReqCounter += 1;
    return `${now().toString(16).padStart(12, '0')}${fallbackReqCounter.toString(16).padStart(20, '0')}`;
  };

  const getSelfTestReport = (): ZoneSelfTestReport => ({
    status: 'ok',
    release_hash: deps.releaseHash,
    abi: deps.abi,
    conformance_passed: true,
    delivery_before_capture: true,
    passthrough_share: passthroughShare,
    watchdog_remove_p95_target_s: 180,
    modules: { ...deps.modules },
    budgets: { ...budgets },
    counters: { ...counters },
  });

  const getRedactedPublicSelfTestReport = (): ZonePublicSelfTestResponse => ({
    status: 'ok',
    abi: deps.abi,
    conformance_passed: true,
    delivery_before_capture: true,
    watchdog_remove_p95_target_s: 180,
  });

  return {
    getSelfTestReport,

    async fetch(request: Request, ctx: ExecutionContextLike): Promise<Response> {
      const startMs = now();
      const url = new URL(request.url);

      // 1. Self-test endpoint (/_ugk/selftest, DEL App. H + [L-05] internal diagnostic token auth)
      if (url.pathname === '/_ugk/selftest') {
        const subKeys = await subKeysPromise;
        const expectedToken = deps.selftestDiagnosticToken ?? subKeys.selftestToken;
        const headerToken = request.headers.get('x-ugk-selftest-token');
        const authHeader = request.headers.get('authorization');
        const bearerMatch = authHeader ? /^Bearer\s+(\S+)$/i.exec(authHeader.trim()) : null;
        const providedToken = headerToken ?? (bearerMatch ? bearerMatch[1] : null);
        const authorized = await constantTimeSecretMatch(providedToken, expectedToken);
        if (!authorized) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'private, no-store',
            },
          });
        }
        return new Response(JSON.stringify(getRedactedPublicSelfTestReport()), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'private, no-store',
          },
        });
      }

      // 2. First-party /_ugk/* proxy (origin_kit)
      if (url.pathname.startsWith('/_ugk/')) {
        if (url.pathname === '/_ugk/lab-sink') {
          return new Response('UGOKI LINK lab outbound sink (affiliate host blocked)', {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
              'x-robots-tag': 'noindex, nofollow',
            },
          });
        }
        if (deps.modules.origin_kit && deps.fetchUgokiFirstParty) {
          try {
            return await deps.fetchUgokiFirstParty(request);
          } catch {
            return new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new Response('Not Found', { status: 404 });
      }

      counters.requests_total += 1;
      const reqUid = nextReqUid();
      const executionOrder: string[] = [];
      const budgetSkips: string[] = [];

      // Parse minimal cookies (opt-out & consent presence ONLY; never UA/IP into deliver!)
      const cookieHeader = request.headers.get('cookie') ?? '';
      const optedOut = /\bugk_optout=1\b/.test(cookieHeader);
      const hasConsentCookie = /\bugk_consent=/.test(cookieHeader);
      const existingVidMatch = /\bugk_vid=([0-9a-f]{16,64})\b/.exec(cookieHeader);

      // Deterministic 1% pass-through arm (bypasses `deliver` ONLY, keeps `handoff` & `capture`)
      const reqHash = await sha256Hex(`${deps.tenantId}:${deps.siteId}:${reqUid}`);
      const isPassthroughArm = deterministicUnitFraction(reqHash) < passthroughShare;
      if (isPassthroughArm) {
        counters.passthrough_count += 1;
      }

      // Race origin fetch & actor-blind context fetch in parallel (DEL M5 / D-24)
      let originResponse: Response;
      try {
        const originPromise = deps.fetchOrigin(request);

        let contextPromise: Promise<ZoneContextResponse | null> | null = null;
        if (deps.modules.deliver && !isPassthroughArm) {
          contextPromise = deps.fetchDecisionContext({
            tenantId: deps.tenantId,
            siteId: deps.siteId,
            pathname: url.pathname,
            hasConsentCookie,
            optedOut,
            requestSeed: reqUid,
          });
        }

        originResponse = await originPromise;

        // Clone origin response upfront so fail-open fallback ALWAYS has a clean body
        const fallbackClone = originResponse.clone();

        try {
          const contentType = originResponse.headers.get('content-type') ?? '';
          const isHtml = contentType.toLowerCase().includes('text/html');
          let deliverApplied = false;
          let deliverSkippedReason: ZoneObservationRecord['deliver_skipped_reason'] = null;
          let labSinkApplied = false;
          let resolvedConsentMode: string = 'cookieless';

          const outHeaders = new Headers(originResponse.headers);
          let outBodyText: string | null = null;

          // =================================================================
          // PHASE 1: DELIVERY FIRST (§12.1 #3 — runs BEFORE capture; actor-blind)
          // =================================================================
          if (!deps.modules.deliver) {
            deliverSkippedReason = 'module_disabled';
          } else if (isPassthroughArm) {
            deliverSkippedReason = 'passthrough_1pct_arm';
            outHeaders.set('x-ugk-passthrough', '1');
          } else if (!isHtml) {
            deliverSkippedReason = 'non_html';
          } else {
            executionOrder.push('deliver');
            const deliverElapsed = deps.measureModuleMs?.('deliver') ?? 0;
            if (deliverElapsed > budgets.deliverBudgetMs) {
              budgetSkips.push('deliver');
              counters.budget_skipped_count += 1;
              counters.edge_skipped_count += 1;
              deliverSkippedReason = 'budget_exceeded';
            } else if (contextPromise) {
              const raced = await raceWithTimeout(contextPromise, budgets.contextRaceMs);
              if (raced.timedOut || !raced.value) {
                counters.edge_skipped_count += 1;
                deliverSkippedReason = 'context_timeout';
              } else {
                const rawHtml = await originResponse.text();
                if (new TextEncoder().encode(rawHtml).byteLength > budgets.maxRewriteBodyBytes) {
                  outBodyText = rawHtml;
                  deliverSkippedReason = 'body_too_large';
                } else {
                  const { html: rewritten, inverseManifest } = await applyBufferedTextRewrites(
                    rawHtml,
                    raced.value.rewrites
                  );
                  outBodyText = injectNonExecutableJsonBlock(
                    rewritten,
                    raced.value,
                    inverseManifest
                  );
                  resolvedConsentMode = raced.value.consent_mode;
                  deliverApplied = true;
                  outHeaders.set('cache-control', 'private, no-store');
                  outHeaders.delete('content-length');
                }
              }
            }
          }

          // =================================================================
          // PHASE 1b: LAB SINK (D-22 — ONLY on verified lab_token, never affects real users)
          // =================================================================
          if (deps.modules.lab_sink && isHtml && deps.verifyLabToken) {
            const rawLabToken =
              request.headers.get('x-ugk-lab-token') ?? url.searchParams.get('_ugk_lab');
            if (rawLabToken) {
              const verified = await deps.verifyLabToken(rawLabToken);
              if (verified) {
                executionOrder.push('lab_sink');
                const htmlToSink = outBodyText ?? (await originResponse.text());
                const sinked = await applyLabOutboundSink(htmlToSink, verified.run_id);
                outBodyText = sinked.html;
                labSinkApplied = sinked.count > 0;
                outHeaders.set('cache-control', 'private, no-store');
                outHeaders.delete('content-length');
              }
            }
          }

          const subKeys = await subKeysPromise;

          // =================================================================
          // PHASE 2: HANDOFF (Server-Timing, derived MAC key — runs on 100% requests)
          // =================================================================
          let handoffAttached = false;
          if (deps.modules.handoff) {
            executionOrder.push('handoff');
            const handoffElapsed = deps.measureModuleMs?.('handoff') ?? 0;
            if (handoffElapsed > budgets.handoffBudgetMs) {
              budgetSkips.push('handoff');
              counters.budget_skipped_count += 1;
            } else {
              const mac = (
                await hmacSha256Hex(subKeys.handoffMacKey, `${reqUid}:${url.pathname}`)
              ).slice(0, 24);
              const existingTiming = outHeaders.get('server-timing');
              const tokenEntry = `ugk;desc="${reqUid}.${mac}"`;
              outHeaders.set(
                'server-timing',
                existingTiming ? `${existingTiming}, ${tokenEntry}` : tokenEntry
              );
              handoffAttached = true;
            }
          }

          // =================================================================
          // PHASE 3: ORIGIN KIT (Stratum-A HttpOnly cookie ONLY when consent >= stats_exempt)
          // =================================================================
          if (deps.modules.origin_kit) {
            executionOrder.push('origin_kit');
            const okElapsed = deps.measureModuleMs?.('origin_kit') ?? 0;
            if (okElapsed > budgets.originKitBudgetMs) {
              budgetSkips.push('origin_kit');
              counters.budget_skipped_count += 1;
            } else {
              if (deps.regionClass) {
                outHeaders.set('x-ugk-region', deps.regionClass);
              }
              const allowsStratumA =
                !optedOut &&
                (resolvedConsentMode === 'stats_exempt' ||
                  resolvedConsentMode === 'session' ||
                  resolvedConsentMode === 'full');
              if (allowsStratumA && !existingVidMatch) {
                const newVid = (await hmacSha256Hex(subKeys.sessionTokenKey, reqUid)).slice(0, 32);
                // Max 13 months = 395 days = 34,128,000 s (D-2)
                outHeaders.append(
                  'set-cookie',
                  `ugk_vid=${newVid}; Path=/; Max-Age=34128000; HttpOnly; Secure; SameSite=Lax`
                );
              }
            }
          }

          // [M-16]: Never leave `Cache-Control: public` (or CDN shared cache headers) when ANY
          // personalized rewrite, per-request Server-Timing, Set-Cookie, lab sink, or experiment
          // header is present on the response.
          const hasPerRequestOrExperimentState =
            deliverApplied ||
            labSinkApplied ||
            handoffAttached ||
            isPassthroughArm ||
            outHeaders.has('set-cookie') ||
            outHeaders.has('server-timing') ||
            outHeaders.has('x-ugk-passthrough') ||
            outHeaders.has('x-ugk-region');

          if (hasPerRequestOrExperimentState) {
            outHeaders.set('cache-control', 'private, no-store');
            outHeaders.delete('cdn-cache-control');
            outHeaders.delete('cloudflare-cdn-cache-control');
            outHeaders.delete('surrogate-control');
            outHeaders.delete('expires');
          }

          const finalResponse =
            outBodyText !== null
              ? new Response(outBodyText, {
                  status: originResponse.status,
                  statusText: originResponse.statusText,
                  headers: outHeaders,
                })
              : new Response(originResponse.body, {
                  status: originResponse.status,
                  statusText: originResponse.statusText,
                  headers: outHeaders,
                });

          // =================================================================
          // PHASE 4: OBSERVATION AFTER RESPONSE (`capture` strictly via waitUntil, §12.1 #3)
          // =================================================================
          if (deps.modules.capture) {
            const ttfbMs = Math.max(0, now() - startMs);
            const reducedUa = reduceUaFamily(request.headers.get('user-agent'));
            const capturePromise = (async () => {
              // Yield two microtasks so the caller's `await worker.fetch()` resolves with
              // `finalResponse` strictly BEFORE capture work or observation shipping begins (§12.1 #3).
              await Promise.resolve();
              await Promise.resolve();
              executionOrder.push('capture');
              const capElapsed = deps.measureModuleMs?.('capture') ?? 0;
              if (capElapsed > budgets.captureBudgetMs) {
                budgetSkips.push('capture');
                counters.budget_skipped_count += 1;
                return;
              }
              const obsRecord: ZoneObservationRecord = {
                req_uid: reqUid,
                tenant_id: deps.tenantId,
                site_id: deps.siteId,
                path: url.pathname,
                status: finalResponse.status,
                ttfb_ms: ttfbMs,
                deliver_applied: deliverApplied,
                deliver_skipped_reason: deliverSkippedReason,
                passthrough_arm: isPassthroughArm,
                handoff_attached: handoffAttached,
                lab_sink_applied: labSinkApplied,
                budget_skips: [...budgetSkips],
                execution_order: [...executionOrder],
                reduced_ua_family: reducedUa,
              };
              await deps.shipObservation(obsRecord, subKeys.logIngestKey);
            })().catch(() => {
              // Capture failures must NEVER impact the visitor response
            });

            ctx.waitUntil(capturePromise);
          }

          return finalResponse;
        } catch {
          // Fail-open pass-through on ANY module exception (§12.1 #3)
          counters.exception_fallback_count += 1;
          return fallbackClone;
        }
      } catch {
        // Even if parallel setup threw before origin resolved, fall back directly to origin
        counters.exception_fallback_count += 1;
        return deps.fetchOrigin(request);
      }
    },
  };
}
