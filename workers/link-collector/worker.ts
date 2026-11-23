/**
 * UGOKI LINK v2 — Collector Worker Standard Fetch Handler (`workers/link-collector/worker.ts`)
 *
 * Routes:
 * - `POST /v1/collect/events`        — Standard telemetry frames (Bundle 3-A + 3-C)
 * - `POST /v1/compat/batch`          — Segment batch compatibility endpoint (Bundle 3-B)
 * - `POST /v1/compat/:type`          — Segment single call (identify/page/screen/track/group/alias)
 * - `POST /v1/custom-events`         — Customer-defined custom event endpoint (Bundle 3-B)
 * - `POST /v1/optout`                — Durable opt-out + 14-day deletion queue endpoint (§4.5 / [H-11])
 */

import {
  computeCanonicalSubjectHmac,
  computeSubjectHmacLookupCandidates,
  hmacSha256Hex,
  sha256Hex,
} from '../../packages/contract/schema';
import {
  LinkCollectorEngine,
  constantTimeHexEqual,
  deriveServerNetworkPrefix,
} from './collector';
import {
  SEGMENT_CALL_TYPES,
  SegmentCompatIngestEngine,
  type SegmentCallType,
  type SegmentIncomingCall,
} from './segment-compat';
import type {
  CollectorDeps,
  CustomEventPersistedRecord,
  LabMarkerToken,
  QueueLike,
  SubjectDeletionRequest,
  SubjectHmacVersionedCandidate,
} from './types';

export interface CollectorWorkerDeps extends CollectorDeps {
  readonly customEventQueue: QueueLike<CustomEventPersistedRecord>;
}

export type CollectorWorkerDependencies = CollectorWorkerDeps;

function parseLabMarkerHeader(headerVal: string | null): LabMarkerToken | null {
  if (!headerVal) return null;
  try {
    return JSON.parse(headerVal) as LabMarkerToken;
  } catch {
    return null;
  }
}

function extractCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const raw of parts) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const k = raw.slice(0, eq).trim();
    if (k === name) {
      const v = raw.slice(eq + 1).trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

const DELETION_RETRY_COOKIE_NAME = 'ugk_del_retry';
const DELETION_RETRY_COOKIE_TTL_SEC = 86_400; // 24 hours short-lived retry handle

function base64UrlEncodeUtf8(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecodeUtf8(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function signDeletionRetryHandle(args: {
  readonly tenantId: string;
  readonly siteId: string;
  readonly visitorId: string;
  readonly expiresAtMs: number;
  readonly signingSecret: string;
}): string {
  const payloadB64 = base64UrlEncodeUtf8(
    JSON.stringify({
      t: args.tenantId,
      s: args.siteId,
      v: args.visitorId,
      exp: args.expiresAtMs,
    })
  );
  const sig = hmacSha256Hex(args.signingSecret, `ugk_del_retry:v1:${payloadB64}`);
  return `${payloadB64}.${sig}`;
}

function verifyDeletionRetryHandle(args: {
  readonly token: string;
  readonly expectedTenantId: string;
  readonly expectedSiteId: string;
  readonly signingSecrets: readonly string[];
  readonly nowMs: number;
}): string | null {
  const dot = args.token.indexOf('.');
  if (dot <= 0 || dot !== args.token.lastIndexOf('.')) return null;
  const payloadB64 = args.token.slice(0, dot);
  const providedSig = args.token.slice(dot + 1);
  if (payloadB64.length === 0 || providedSig.length === 0) return null;

  let signatureValid = false;
  for (const secret of args.signingSecrets) {
    if (!secret) continue;
    const expectedSig = hmacSha256Hex(secret, `ugk_del_retry:v1:${payloadB64}`);
    if (constantTimeHexEqual(providedSig, expectedSig)) {
      signatureValid = true;
      break;
    }
  }
  if (!signatureValid) return null;

  const decoded = base64UrlDecodeUtf8(payloadB64);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as {
      readonly t?: unknown;
      readonly s?: unknown;
      readonly v?: unknown;
      readonly exp?: unknown;
    };
    if (
      parsed.t !== args.expectedTenantId ||
      parsed.s !== args.expectedSiteId ||
      typeof parsed.v !== 'string' ||
      parsed.v.length === 0 ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp) ||
      parsed.exp <= args.nowMs
    ) {
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function createCollectorWorker(deps: CollectorWorkerDeps) {
  const nowFn = deps.nowMs ?? (() => Date.now());
  const collector = new LinkCollectorEngine(deps);
  const compat = new SegmentCompatIngestEngine({
    sitesByPublishableKey: deps.sitesByPublishableKey,
    labMarkerSecret: deps.labMarkerSecret,
    customEventQueue: deps.customEventQueue,
    r2QuarantineBucket: deps.r2QuarantineBucket,
    r2SpillBucket: deps.r2SpillBucket,
    nowMs: deps.nowMs,
  });
  const deletionFallbackQueue: SubjectDeletionRequest[] = [];

  return {
    collector,
    compat,
    deletionFallbackQueue,

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const publishableKey =
        request.headers.get('x-ugk-key') ?? url.searchParams.get('k') ?? '';
      const labMarker = parseLabMarkerHeader(request.headers.get('x-ugk-lab-marker'));

      if (request.method === 'POST' && url.pathname === '/v1/optout') {
        const site = deps.sitesByPublishableKey.get(publishableKey);
        if (!site) return jsonResponse({ error: 'unknown_publishable_key' }, 401);

        const now = nowFn();
        let bodyObj: Record<string, unknown> = {};
        try {
          const text = await request.text();
          if (text.trim().length > 0) {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              bodyObj = parsed as Record<string, unknown>;
            }
          }
        } catch {
          return jsonResponse({ error: 'invalid_json_body' }, 400);
        }

        const cookieHeader = request.headers.get('cookie');
        const cookieVid = extractCookieValue(cookieHeader, 'ugk_vid');
        const retrySigningSecret = `${deps.continuityTokenSecret}:${site.tenantMemberHashKey}`;
        // Codex R3 #8: Verify ugk_del_retry across current + rotated continuity secrets
        // (and current + rotated tenant member-hash keys) so secret rotation never strands retries.
        const continuitySecretsForRetry = [
          deps.continuityTokenSecret,
          ...(deps.rotatedContinuityTokenSecrets ?? []),
        ];
        const memberKeysForRetry = [
          site.tenantMemberHashKey,
          ...(site.rotatedMemberHashKeyVersions?.map((k) => k.secretKey) ?? []),
          ...(site.rotatedMemberHashKeys ?? []),
        ];
        const retryVerificationSecrets: string[] = [];
        for (const cs of continuitySecretsForRetry) {
          for (const mk of memberKeysForRetry) {
            const combined = `${cs}:${mk}`;
            if (!retryVerificationSecrets.includes(combined)) {
              retryVerificationSecrets.push(combined);
            }
          }
        }
        const rawDelRetryCookie = extractCookieValue(cookieHeader, DELETION_RETRY_COOKIE_NAME);
        const verifiedRetryVid = rawDelRetryCookie
          ? verifyDeletionRetryHandle({
              token: rawDelRetryCookie,
              expectedTenantId: site.tenantId,
              expectedSiteId: site.siteId,
              signingSecrets: retryVerificationSecrets,
              nowMs: now,
            })
          : null;
        const bodyVisitorId =
          typeof bodyObj.visitor_id === 'string' && bodyObj.visitor_id.length > 0
            ? bodyObj.visitor_id
            : null;
        const rawVisitorId = bodyVisitorId ?? cookieVid ?? verifiedRetryVid;
        const rawMemberHash =
          typeof bodyObj.member_hash === 'string' && bodyObj.member_hash.length > 0
            ? bodyObj.member_hash
            : null;
        const rawExternalId =
          typeof bodyObj.external_id === 'string' && bodyObj.external_id.length > 0
            ? bodyObj.external_id
            : null;
        const rawGaClientId =
          typeof bodyObj.ga_client_id === 'string' && bodyObj.ga_client_id.length > 0
            ? bodyObj.ga_client_id
            : null;

        let subjectKind: SubjectDeletionRequest['subjectKind'] = 'optout_cookie';
        let rawSubject: string | null = null;
        if (rawMemberHash) {
          subjectKind = 'member_hash';
          rawSubject = rawMemberHash;
        } else if (rawExternalId) {
          subjectKind = 'external_id';
          rawSubject = rawExternalId;
        } else if (rawGaClientId) {
          subjectKind = 'ga_client_id';
          rawSubject = rawGaClientId;
        } else if (rawVisitorId) {
          subjectKind = 'visitor_id';
          rawSubject = rawVisitorId;
        }

        const identifiedViaVisitorCookie =
          subjectKind === 'visitor_id' &&
          bodyVisitorId === null &&
          Boolean(cookieVid ?? verifiedRetryVid);

        const subjectHmac = rawSubject
          ? computeCanonicalSubjectHmac({
              tenantId: site.tenantId,
              subjectKind,
              subjectValue: rawSubject,
              secretKey: site.tenantMemberHashKey,
            })
          : null;
        // Codex R2 #9 & R3 #9: Precompute canonical + legacy HMAC lookup candidates across
        // current + rotated tenant keys at intake time, preserving exact per-key-version
        // pairing so downstream deletion matches (key_version, hmac_hex) with ZERO plaintext!
        const versionedKeysForCandidates: Array<{
          readonly keyVersion: string;
          readonly secretKey: string;
        }> = [
          {
            keyVersion: String(site.tenantMemberHashKeyVersion ?? 1),
            secretKey: site.tenantMemberHashKey,
          },
        ];
        const seenSecretKeys = new Set<string>([site.tenantMemberHashKey]);
        for (const entry of site.rotatedMemberHashKeyVersions ?? []) {
          if (entry.secretKey && !seenSecretKeys.has(entry.secretKey)) {
            seenSecretKeys.add(entry.secretKey);
            versionedKeysForCandidates.push({
              keyVersion: String(entry.keyVersion),
              secretKey: entry.secretKey,
            });
          }
        }
        let fallbackRotatedIdx = 0;
        for (const rotatedKey of site.rotatedMemberHashKeys ?? []) {
          if (rotatedKey && !seenSecretKeys.has(rotatedKey)) {
            seenSecretKeys.add(rotatedKey);
            fallbackRotatedIdx += 1;
            versionedKeysForCandidates.push({
              keyVersion: `rotated_${fallbackRotatedIdx}`,
              secretKey: rotatedKey,
            });
          }
        }

        const secretKeysForCandidates = versionedKeysForCandidates.map((k) => k.secretKey);
        const subjectHmacCandidates =
          rawSubject && subjectKind !== 'optout_cookie'
            ? computeSubjectHmacLookupCandidates({
                tenantId: site.tenantId,
                subjectKind,
                subjectValue: rawSubject,
                secretKeys: secretKeysForCandidates,
              })
            : [];
        const subjectHmacVersionedCandidates: SubjectHmacVersionedCandidate[] = [];
        if (rawSubject && subjectKind !== 'optout_cookie') {
          for (const { keyVersion, secretKey } of versionedKeysForCandidates) {
            subjectHmacVersionedCandidates.push(
              {
                key_version: keyVersion,
                format: 'canonical_v1',
                hmac_hex: computeCanonicalSubjectHmac({
                  tenantId: site.tenantId,
                  subjectKind,
                  subjectValue: rawSubject,
                  secretKey,
                }),
              },
              {
                key_version: keyVersion,
                format: 'legacy_value',
                hmac_hex: hmacSha256Hex(secretKey, rawSubject),
              },
              {
                key_version: keyVersion,
                format: 'legacy_kind_value',
                hmac_hex: hmacSha256Hex(secretKey, `${subjectKind}:${rawSubject}`),
              },
              {
                key_version: keyVersion,
                format: 'legacy_tenant_kind_value',
                hmac_hex: hmacSha256Hex(
                  secretKey,
                  `${site.tenantId}:${subjectKind}:${rawSubject}`
                ),
              }
            );
          }
        }
        const generatedReceiptId = `del_${sha256Hex(
          `${site.tenantId}:${site.siteId}:${subjectKind}:${subjectHmac ?? 'anon'}:${now}`
        ).slice(0, 24)}`;

        const deletionReq: SubjectDeletionRequest = {
          receiptId: generatedReceiptId,
          tenantId: site.tenantId,
          siteId: site.siteId,
          subjectKind,
          subjectHmac,
          subject_hmac_candidates: subjectHmacCandidates,
          subjectHmacCandidates,
          subject_hmac_versioned_candidates: subjectHmacVersionedCandidates,
          subjectHmacVersionedCandidates,
          requestedAtMs: now,
          slaDays: 14,
        };

        const headers = new Headers({
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        headers.append(
          'set-cookie',
          'ugk_optout=1; Path=/; Max-Age=34128000; HttpOnly; Secure; SameSite=Lax'
        );
        headers.append('set-cookie', 'ugk_sid=; Path=/; Max-Age=0; Secure; SameSite=Lax');

        // Codex #8: Separate setting the opt-out cookie from durable subject-deletion queuing.
        // NEVER return `deletion_queued: true` unless a configured `deletionSink` durably succeeds!
        let receiptId = generatedReceiptId;
        let queuedViaSink = false;
        if (deps.deletionSink) {
          try {
            const sinkRes = await deps.deletionSink.enqueueSubjectDeletion(deletionReq);
            if (sinkRes && typeof sinkRes.receiptId === 'string' && sinkRes.receiptId.length > 0) {
              receiptId = sinkRes.receiptId;
            }
            queuedViaSink = true;
          } catch {
            queuedViaSink = false;
          }
        }

        if (!queuedViaSink) {
          // Codex R2 #8: Preserve a short-lived HttpOnly signed deletion-retry cookie
          // BEFORE clearing `ugk_vid` so cookie-only visitors can still retry erasure!
          if (identifiedViaVisitorCookie && rawVisitorId) {
            const retryHandle = signDeletionRetryHandle({
              tenantId: site.tenantId,
              siteId: site.siteId,
              visitorId: rawVisitorId,
              expiresAtMs: now + DELETION_RETRY_COOKIE_TTL_SEC * 1000,
              signingSecret: retrySigningSecret,
            });
            headers.append(
              'set-cookie',
              `${DELETION_RETRY_COOKIE_NAME}=${retryHandle}; Path=/; Max-Age=${DELETION_RETRY_COOKIE_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`
            );
          }
          headers.append('set-cookie', 'ugk_vid=; Path=/; Max-Age=0; Secure; SameSite=Lax');

          return new Response(
            JSON.stringify({
              ok: false,
              opted_out: true,
              optout_cookie_set: true,
              receipt_id: null,
              deletion_queued: false,
              error: 'deletion_sink_unavailable',
            }),
            { status: 503, headers }
          );
        }

        headers.append('set-cookie', 'ugk_vid=; Path=/; Max-Age=0; Secure; SameSite=Lax');
        headers.append(
          'set-cookie',
          `${DELETION_RETRY_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
        );

        return new Response(
          JSON.stringify({
            ok: true,
            opted_out: true,
            optout_cookie_set: true,
            receipt_id: receiptId,
            deletion_queued: true,
            deletion_sla_days: 14,
          }),
          { status: 200, headers }
        );
      }

      if (request.method === 'POST' && url.pathname === '/v1/collect/events') {
        const contentType = request.headers.get('content-type') ?? '';
        // [C-04]: NEVER trust client-supplied `x-ugk-prefix`! Derive strictly from CF-Connecting-IP!
        const networkPrefix = deriveServerNetworkPrefix(request.headers.get('CF-Connecting-IP'));
        const handoffHeader = request.headers.get('x-ugk-handoff');
        const originAttestToken = request.headers.get('x-ugk-origin-attest');

        let body: Uint8Array | Record<string, unknown>;
        if (contentType.includes('application/octet-stream') || contentType.includes('ugk-bin')) {
          body = new Uint8Array(await request.arrayBuffer());
        } else {
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
            return jsonResponse({ error: 'invalid_json_body' }, 400);
          }
        }

        const res = await collector.handleTelemetryFrame({
          publishableKey,
          body,
          networkPrefix,
          handoffHeader,
          originAttestToken,
          labMarker,
        });
        return jsonResponse(res.ack ?? { ok: false, error: res.error }, res.status);
      }

      if (request.method === 'POST' && url.pathname === '/v1/compat/batch') {
        let parsed: { readonly batch?: readonly SegmentIncomingCall[] };
        try {
          parsed = (await request.json()) as { readonly batch?: readonly SegmentIncomingCall[] };
        } catch {
          return jsonResponse({ error: 'invalid_json_body' }, 400);
        }
        const batch = Array.isArray(parsed.batch) ? parsed.batch : [];
        const res = await compat.handleBatch(publishableKey, batch);
        return jsonResponse(res, res.status);
      }

      if (request.method === 'POST' && url.pathname.startsWith('/v1/compat/')) {
        const segType = url.pathname.slice('/v1/compat/'.length) as SegmentCallType;
        if (!(SEGMENT_CALL_TYPES as readonly string[]).includes(segType)) {
          return jsonResponse({ error: 'unsupported_segment_type' }, 404);
        }
        let body: Omit<SegmentIncomingCall, 'type'>;
        try {
          body = (await request.json()) as Omit<SegmentIncomingCall, 'type'>;
        } catch {
          return jsonResponse({ error: 'invalid_json_body' }, 400);
        }
        const res = await compat.handleSingleCall(publishableKey, {
          ...body,
          type: segType,
          lab_marker: body.lab_marker ?? labMarker,
        });
        return jsonResponse(res, res.status);
      }

      if (request.method === 'POST' && url.pathname === '/v1/custom-events') {
        let body: Omit<SegmentIncomingCall, 'type'>;
        try {
          body = (await request.json()) as Omit<SegmentIncomingCall, 'type'>;
        } catch {
          return jsonResponse({ error: 'invalid_json_body' }, 400);
        }
        const res = await compat.handleSingleCall(publishableKey, {
          ...body,
          type: 'track',
          lab_marker: body.lab_marker ?? labMarker,
        });
        return jsonResponse(res, res.status);
      }

      return jsonResponse({ error: 'not_found' }, 404);
    },
  };
}
