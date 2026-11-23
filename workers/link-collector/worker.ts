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

import { computeCanonicalSubjectHmac, sha256Hex } from '../../packages/contract/schema';
import { LinkCollectorEngine, deriveServerNetworkPrefix } from './collector';
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
} from './types';

export interface CollectorWorkerDeps extends CollectorDeps {
  readonly customEventQueue: QueueLike<CustomEventPersistedRecord>;
}

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

        const cookieVid = extractCookieValue(request.headers.get('cookie'), 'ugk_vid');
        const rawVisitorId =
          typeof bodyObj.visitor_id === 'string' && bodyObj.visitor_id.length > 0
            ? bodyObj.visitor_id
            : cookieVid;
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

        const subjectHmac = rawSubject
          ? computeCanonicalSubjectHmac({
              tenantId: site.tenantId,
              subjectKind,
              subjectValue: rawSubject,
              secretKey: site.tenantMemberHashKey,
            })
          : null;
        const generatedReceiptId = `del_${sha256Hex(
          `${site.tenantId}:${site.siteId}:${subjectKind}:${subjectHmac ?? 'anon'}:${now}`
        ).slice(0, 24)}`;

        const deletionReq: SubjectDeletionRequest = {
          receiptId: generatedReceiptId,
          tenantId: site.tenantId,
          siteId: site.siteId,
          subjectKind,
          subjectHmac,
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
        headers.append('set-cookie', 'ugk_vid=; Path=/; Max-Age=0; Secure; SameSite=Lax');
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
