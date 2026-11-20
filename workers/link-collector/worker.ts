/**
 * UGOKI LINK v2 — Collector Worker Standard Fetch Handler (`workers/link-collector/worker.ts`)
 *
 * Routes:
 * - `POST /v1/collect/events`        — Standard telemetry frames (Bundle 3-A + 3-C)
 * - `POST /v1/compat/batch`          — Segment batch compatibility endpoint (Bundle 3-B)
 * - `POST /v1/compat/:type`          — Segment single call (identify/page/screen/track/group/alias)
 * - `POST /v1/custom-events`         — Customer-defined custom event endpoint (Bundle 3-B)
 * - `POST /v1/optout`                — Durable opt-out acknowledgement endpoint (§4.5)
 */

import { LinkCollectorEngine } from './collector';
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
  const collector = new LinkCollectorEngine(deps);
  const compat = new SegmentCompatIngestEngine({
    sitesByPublishableKey: deps.sitesByPublishableKey,
    labMarkerSecret: deps.labMarkerSecret,
    customEventQueue: deps.customEventQueue,
    r2QuarantineBucket: deps.r2QuarantineBucket,
    r2SpillBucket: deps.r2SpillBucket,
    nowMs: deps.nowMs,
  });

  return {
    collector,
    compat,

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const publishableKey =
        request.headers.get('x-ugk-key') ?? url.searchParams.get('k') ?? '';
      const labMarker = parseLabMarkerHeader(request.headers.get('x-ugk-lab-marker'));

      if (request.method === 'POST' && url.pathname === '/v1/optout') {
        const site = deps.sitesByPublishableKey.get(publishableKey);
        if (!site) return jsonResponse({ error: 'unknown_publishable_key' }, 401);
        return new Response(
          JSON.stringify({ ok: true, opted_out: true, deletion_sla_days: 14 }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'set-cookie': 'ugk_optout=1; Path=/; Max-Age=34128000; HttpOnly; Secure; SameSite=Lax',
            },
          }
        );
      }

      if (request.method === 'POST' && url.pathname === '/v1/collect/events') {
        const contentType = request.headers.get('content-type') ?? '';
        const networkPrefix = request.headers.get('x-ugk-prefix') ?? '0.0.0.0/24';
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
